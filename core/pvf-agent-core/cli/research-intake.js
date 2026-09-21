"use strict";

const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");
const { runtimePath } = require("../lib/runtime-state");
const {
  appendClaims,
  assertExternalOutput,
  newClaimStore,
  pathInside,
  readJson,
  safeId,
  sha256,
  sha256File,
  sourceFingerprint,
  timestamp,
  writeJsonAtomic,
} = require("../lib/research-store");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = String(args[0] || "help").toLowerCase();

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".csv", ".tsv",
  ".js", ".ts", ".cs", ".cpp", ".c", ".h", ".hpp", ".java", ".py", ".bat", ".ps1",
  ".nut", ".sqr", ".lst", ".skl", ".stk", ".equ", ".qst", ".dgn", ".map", ".aic", ".ai",
]);
const PVF_ASSET_EXTENSIONS = new Set([".ani", ".act", ".atk", ".key", ".ptl", ".als", ".obj", ".apd"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".7z", ".rar", ".gz", ".tar"]);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function numberOption(name, fallback) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function required(name) {
  const value = option(name);
  if (!value) {
    const error = new Error(`${name} is required.`);
    error.code = "REQUIRED_OPTION_MISSING";
    error.optionName = name;
    throw error;
  }
  return value;
}

function commandArgument(value) {
  const text = String(value || "");
  if (!text || /[\x00-\x1f\x7f%!?^&|<>"]/u.test(text)) return null;
  return `"${text}"`;
}

function errorAgentHandoff(error) {
  if (command !== "inventory" || error?.code !== "REQUIRED_OPTION_MISSING") {
    return { nextCommandOnly: null, helpProbeRequired: false };
  }
  const source = error.optionName === "--source"
    ? '"REPLACE_WITH_EXTERNAL_SOURCE_DIRECTORY"'
    : commandArgument(option("--source"));
  if (!source) return { nextCommandOnly: null, helpProbeRequired: false };
  const sourceId = error.optionName === "--source-id"
    ? "REPLACE_WITH_ASCII_SOURCE_ID"
    : commandArgument(option("--source-id"));
  if (!sourceId) return { nextCommandOnly: null, helpProbeRequired: false };
  const out = commandArgument(option("--out")) || '"REPLACE_WITH_EXTERNAL_OUTPUT_DIRECTORY"';
  return {
    nextCommandOnly: `workbench.bat research inventory --source ${source} --source-id ${sourceId} --out ${out}`,
    helpProbeRequired: false,
    sourceContentsExecuted: false,
    instruction: "替换命令中的唯一占位符后原样执行；研究输入只作不受信任资料清点，输出必须留在工作台外。",
  };
}

function usage() {
  return `Usage:
  workbench.bat research inventory --source <directory> --source-id <ascii-id> [--title <text>] [--out <external-dir>] [--license-status unknown] [--trust-role candidate] [--max-text-bytes 5242880] [--force]
  workbench.bat research verify --manifest <SOURCE-MANIFEST.json> [--rehash]
  workbench.bat research claims-import --store <CLAIM-STORE.json> --file <claims.json>
  workbench.bat research status --dir <research-run-dir>

All research outputs must stay outside the clean Workbench. Input files are treated as untrusted data; this command never executes embedded instructions or copies source content.
`;
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function listFiles(root, warnings) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link: ${toPosix(path.relative(root, full))}`);
      } else if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files.sort((a, b) => toPosix(path.relative(root, a)).localeCompare(toPosix(path.relative(root, b)), "zh-Hans-CN"));
}

function sampleFile(file, limit = 262144) {
  const size = fs.statSync(file).size;
  const count = Math.min(size, limit);
  const buffer = Buffer.alloc(count);
  if (count === 0) return buffer;
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, count, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

function replacementRatio(text) {
  if (!text.length) return 0;
  return (text.match(/\uFFFD/g) || []).length / text.length;
}

function detectEncoding(sample, relativePath, extension) {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return "utf-8-bom";
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return "utf-16le";
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return "utf-16be";
  if (!TEXT_EXTENSIONS.has(extension)) return "binary-or-unknown";
  if (sample.includes(0)) return "binary-or-unknown";
  const utf8 = sample.toString("utf8");
  if (replacementRatio(utf8) === 0) return "utf-8";
  if (/official[-_ ]?(comment|tag)|官方注释/i.test(relativePath)) {
    try {
      const cp949 = new TextDecoder("euc-kr", { fatal: false }).decode(sample);
      if (replacementRatio(cp949) < replacementRatio(utf8)) return "cp949-candidate";
    } catch {
      // Keep the conservative legacy classification.
    }
  }
  return "legacy-multibyte-or-binary";
}

function detectKind(sample, extension) {
  const ascii = sample.subarray(0, 32).toString("latin1");
  if (ascii.startsWith("SQLite format 3\u0000")) return "sqlite-database";
  if (sample.length >= 2 && sample[0] === 0x4d && sample[1] === 0x5a) return "pe-binary";
  if (sample.length >= 4 && sample[0] === 0x50 && sample[1] === 0x4b) return "zip-container";
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "compound-document";
  if (TEXT_EXTENSIONS.has(extension)) return "text-or-source";
  if (PVF_ASSET_EXTENSIONS.has(extension)) return "pvf-related-asset";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if ([".dll", ".exe", ".node", ".obj", ".pdb"].includes(extension)) return "compiled-artifact";
  return "binary-or-unknown";
}

function topicFor(relativePath, extension) {
  const value = relativePath.toLowerCase();
  if (/nut[-_ ]?(api|guide)|nut攻略/.test(value)) return "nut-api-anchor";
  if (/pvftabcomments|tag[-_ ]?comments|标签注释/.test(value)) return "community-tag-comments-anchor";
  if (/official[-_ ]?(comment|tag)|官方注释/.test(value)) return "official-original-comments-anchor";
  if (/(?:extract(?:or|ion)?[-_ ]?tool|提取工具)/i.test(value)) return "tool-reference";
  if (value.includes("pvfcourse")) return "pvf-course-material";
  if ([".nut", ".sqr"].includes(extension)) return "nut-squirrel";
  if ([".lst", ".skl", ".stk", ".equ", ".qst", ".dgn", ".map"].includes(extension)) return "pvf-structure";
  if ([".cs", ".cpp", ".c", ".h", ".hpp", ".js", ".ts", ".py", ".java"].includes(extension)) return "tool-source-code";
  return "unclassified-candidate";
}

function decodedText(buffer, encoding) {
  if (encoding === "utf-8" || encoding === "utf-8-bom") return buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (encoding === "utf-16le") return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  if (encoding === "cp949-candidate") return new TextDecoder("euc-kr", { fatal: false }).decode(buffer);
  return null;
}

function normalizedTextSha256(file, encoding, maxBytes) {
  const size = fs.statSync(file).size;
  if (size > maxBytes) return null;
  const text = decodedText(fs.readFileSync(file), encoding);
  if (text === null) return null;
  const normalized = text.normalize("NFKC").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return sha256(normalized);
}

function countBy(items, selector) {
  const result = {};
  for (const item of items) {
    const key = selector(item) || "<none>";
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function inventory() {
  const sourceRoot = path.resolve(required("--source"));
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new Error(`Source directory does not exist: ${sourceRoot}`);
  const sourceId = safeId(required("--source-id"));
  const outRoot = assertExternalOutput(
    workbenchRoot,
    option("--out", runtimePath(workbenchRoot, "research-runs", sourceId, timestamp())),
  );
  if (pathInside(sourceRoot, outRoot) || pathInside(outRoot, sourceRoot)) throw new Error("Research output and source directory must not overlap.");
  const manifestPath = path.join(outRoot, "SOURCE-MANIFEST.json");
  const claimStorePath = path.join(outRoot, "CLAIM-STORE.json");
  if (!flag("--force") && (fs.existsSync(manifestPath) || fs.existsSync(claimStorePath))) throw new Error(`Research output already exists: ${outRoot}`);

  const warnings = [];
  const sourceFiles = listFiles(sourceRoot, warnings);
  const maxTextBytes = numberOption("--max-text-bytes", 5 * 1024 * 1024);
  const files = [];
  for (const [index, file] of sourceFiles.entries()) {
    const before = fs.statSync(file);
    const relativePath = toPosix(path.relative(sourceRoot, file));
    const extension = path.extname(file).toLowerCase();
    const sample = sampleFile(file);
    const encoding = detectEncoding(sample, relativePath, extension);
    const record = {
      relativePath,
      bytes: before.size,
      modifiedAt: before.mtime.toISOString(),
      extension: extension || "<none>",
      kind: detectKind(sample, extension),
      encoding,
      topic: topicFor(relativePath, extension),
      sha256: sha256File(file),
      normalizedTextSha256: normalizedTextSha256(file, encoding, maxTextBytes),
    };
    const after = fs.statSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) warnings.push(`File changed during inventory: ${relativePath}`);
    files.push(record);
    if ((index + 1) % 1000 === 0) process.stderr.write(`inventory ${index + 1}/${sourceFiles.length}\n`);
  }

  const exactGroups = new Map();
  for (const file of files) {
    if (!exactGroups.has(file.sha256)) exactGroups.set(file.sha256, []);
    exactGroups.get(file.sha256).push(file.relativePath);
  }
  const duplicateGroups = [...exactGroups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([contentSha256, members], index) => ({ groupId: `exact-${String(index + 1).padStart(5, "0")}`, contentSha256, members }))
    .sort((a, b) => b.members.length - a.members.length || a.groupId.localeCompare(b.groupId));
  const groupByHash = new Map(duplicateGroups.map((group) => [group.contentSha256, group.groupId]));
  for (const file of files) {
    if (groupByHash.has(file.sha256)) file.exactDuplicateGroup = groupByHash.get(file.sha256);
  }

  const manifest = {
    schemaVersion: "1.0",
    phase: "external-research-source-inventory",
    generatedAt: new Date().toISOString(),
    source: {
      sourceId,
      title: option("--title", sourceId),
      root: sourceRoot,
      provenanceStatus: option("--provenance-status", "community-publication-untraceable"),
      licenseStatus: option("--license-status", "unknown"),
      trustRole: option("--trust-role", "mixed-candidate"),
      distributionDefault: option("--distribution-status", "local-research-only"),
    },
    parser: {
      id: "workbench-research-intake",
      version: "1.0.0",
      maxNormalizedTextBytes: maxTextBytes,
      sourceContentCopied: false,
      embeddedInstructionsExecuted: false,
    },
    summary: {
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      sourceFingerprint: sourceFingerprint(files),
      exactDuplicateGroupCount: duplicateGroups.length,
      exactDuplicateFileCount: duplicateGroups.reduce((sum, group) => sum + group.members.length, 0),
      byTopDirectory: countBy(files, (file) => {
        const parts = file.relativePath.split("/");
        return parts.length > 1 ? parts[0] : "<root>";
      }),
      byExtension: countBy(files, (file) => file.extension),
      byKind: countBy(files, (file) => file.kind),
      byEncoding: countBy(files, (file) => file.encoding),
      byTopic: countBy(files, (file) => file.topic),
      warningCount: warnings.length,
    },
    duplicateGroups,
    files,
    warnings,
  };
  writeJsonAtomic(manifestPath, manifest);
  const manifestSha256 = sha256File(manifestPath);
  const claimStore = newClaimStore(manifestPath, manifestSha256, sourceId);
  writeJsonAtomic(claimStorePath, claimStore);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "inventory",
    outRoot,
    manifestPath,
    manifestSha256,
    claimStorePath,
    summary: manifest.summary,
  }, null, 2)}\n`);
}

function verify() {
  const manifestPath = path.resolve(required("--manifest"));
  const manifest = readJson(manifestPath);
  const errors = [];
  if (manifest.schemaVersion !== "1.0" || manifest.phase !== "external-research-source-inventory") errors.push("Unexpected source manifest schema or phase.");
  if (!Array.isArray(manifest.files)) errors.push("Source manifest files must be an array.");
  if (Array.isArray(manifest.files) && sourceFingerprint(manifest.files) !== manifest.summary?.sourceFingerprint) errors.push("Stored source fingerprint does not match file records.");
  let rehashed = 0;
  if (flag("--rehash") && Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      const absolute = path.join(manifest.source.root, file.relativePath);
      if (!pathInside(manifest.source.root, absolute) || !fs.existsSync(absolute)) {
        errors.push(`Source file missing or unsafe: ${file.relativePath}`);
        continue;
      }
      if (sha256File(absolute) !== file.sha256) errors.push(`Source file hash changed: ${file.relativePath}`);
      rehashed += 1;
    }
  }
  const report = { ok: errors.length === 0, command: "verify", manifestPath, manifestSha256: sha256File(manifestPath), rehashed, errors };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function claimsImport() {
  const storePath = assertExternalOutput(workbenchRoot, required("--store"));
  const claimsFile = path.resolve(required("--file"));
  const store = readJson(storePath);
  const value = readJson(claimsFile);
  const claims = Array.isArray(value) ? value : value.claims;
  if (!Array.isArray(claims)) throw new Error("Claims import file must be an array or contain a claims array.");
  appendClaims(store, claims);
  writeJsonAtomic(storePath, store);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "claims-import", storePath, added: claims.length, total: store.claims.length }, null, 2)}\n`);
}

function status() {
  const runDir = path.resolve(required("--dir"));
  const manifestPath = path.join(runDir, "SOURCE-MANIFEST.json");
  const storePath = path.join(runDir, "CLAIM-STORE.json");
  const manifest = readJson(manifestPath);
  const store = readJson(storePath);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "status",
    runDir,
    sourceId: manifest.source?.sourceId,
    sourceFingerprint: manifest.summary?.sourceFingerprint,
    fileCount: manifest.summary?.fileCount,
    claimCount: store.claims?.length || 0,
    claimsByStatus: countBy(store.claims || [], (claim) => claim.status),
    manifestSha256: sha256File(manifestPath),
    storeSha256: sha256File(storePath),
  }, null, 2)}\n`);
}

try {
  if (command === "help" || command === "--help" || command === "-h") process.stdout.write(usage());
  else if (command === "inventory") inventory();
  else if (command === "verify") verify();
  else if (command === "claims-import") claimsImport();
  else if (command === "status") status();
  else throw new Error(`Unknown research command: ${command}\n\n${usage()}`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    command,
    code: error.code || "RESEARCH_COMMAND_FAILED",
    error: error.message,
    missingOption: error.optionName || null,
    agentHandoff: errorAgentHandoff(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
}
