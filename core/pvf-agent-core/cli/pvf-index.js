"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { BackendStdioClient, parseBackendTextResult } = require("../lib/backend-stdio-client");
const { resolveSourcePvf } = require("../lib/workspace-profiles");
const indexStore = require("../lib/pvf-index-store");
const { runtimePath } = require("../lib/runtime-state");
const {
  assertReadOnlyAdapter,
  loadAdapterConfig,
  resolveWorkbenchRoot,
  upstreamLaunchOptions,
} = require("../lib/adapter-config");

const rawArgs = process.argv.slice(2);
const workbenchRoot = resolveWorkbenchRoot(rawArgs, path.resolve(__dirname, "../../.."));
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0];

function usage() {
  return `Usage:
  workbench.bat pvf-index build [--profile <name> | --pvf <Script.pvf>] [--out <dir>] [--prefix itemshop] [--contains shp] [--limit 1000000] [--no-lst-index] [--allow-truncated-path-index]
  workbench.bat pvf-index build [--profile <name> | --pvf <Script.pvf>] --scope itemshop --prefix itemshop [--limit 1000]
  workbench.bat pvf-index catalog [--profile <name> | --pvf <Script.pvf>]
  workbench.bat pvf-index summary [--profile <name> | --index-dir <dir>] [--scope itemshop]
  workbench.bat pvf-index status [--profile <name> | --pvf <Script.pvf> | --index-dir <dir>] [--scope itemshop] [--skip-sample-hash] [--verify-full-sha] [--details]
  workbench.bat pvf-index path [--profile <name> | --index-dir <dir>] [--scope itemshop] [--prefix itemshop] [--contains birken] [--ext .shp] [--limit 20]
  workbench.bat pvf-index resolve-lst [--profile <name> | --index-dir <dir>] [--scope itemshop] --lst <registry.lst> --id <number> [--limit 20]
`;
}

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function numberOption(name, fallback) {
  const value = option(name);
  if (value === undefined) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function requireOption(name) {
  const value = option(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || "pvf")
    .replace(/^[A-Za-z]:[\\/]/, "")
    .replace(/[\\/:\s]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "pvf";
}

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sourceSampleHash(file) {
  const stat = fs.statSync(file);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const sampleSize = 1024 * 1024;
  try {
    for (const offset of [0, Math.max(0, Math.floor(stat.size / 2) - sampleSize / 2), Math.max(0, stat.size - sampleSize)]) {
      const length = Math.min(sampleSize, Math.max(0, stat.size - offset));
      if (length <= 0) {
        continue;
      }
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, offset);
      hash.update(buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file, items) {
  const stream = fs.createWriteStream(file, { encoding: "utf8" });
  for (const item of items) {
    stream.write(`${JSON.stringify(item)}\n`);
  }
  return new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
}

async function callAndParse(client, name, toolArgs) {
  const result = await client.callTool(name, toolArgs);
  if (result && result.isError) {
    const parsed = parseBackendTextResult(result);
    throw new Error(parsed.error || parsed.text || JSON.stringify(parsed));
  }
  return parseBackendTextResult(result);
}

async function withOpenSession(config, client, resolved, action) {
  const pvfPath = resolved.sourcePvf;
  if (!fs.existsSync(pvfPath)) {
    throw new Error(`PVF file does not exist: ${pvfPath}`);
  }
  const opened = await callAndParse(client, "pvf_open", {
    path: pvfPath,
    encoding: option("--encoding", resolved.profile?.pvfEncoding?.open || config.defaults.pvfOpenEncoding),
  });
  const sessionId = opened.session?.sessionId;
  if (!sessionId) {
    throw new Error("pvf_open did not return a sessionId.");
  }
  try {
    return await action(sessionId, opened);
  } finally {
    try {
      await callAndParse(client, "pvf_close", { sessionId });
    } catch {
      // Best-effort close; the process exits after the command.
    }
  }
}

function pathSummary(items) {
  const topLevels = new Map();
  const extensions = new Map();
  let scriptFileCount = 0;
  let binaryAniFileCount = 0;
  let totalDataLength = 0;

  for (const item of items) {
    const fileName = toPosix(item.fileName || "");
    const top = fileName.includes("/") ? fileName.slice(0, fileName.indexOf("/")) : "(root)";
    const ext = path.posix.extname(fileName).toLowerCase() || "(none)";
    topLevels.set(top, (topLevels.get(top) || 0) + 1);
    extensions.set(ext, (extensions.get(ext) || 0) + 1);
    if (item.isScriptFile) {
      scriptFileCount += 1;
    }
    if (item.isBinaryAniFile) {
      binaryAniFileCount += 1;
    }
    if (Number.isFinite(Number(item.dataLength))) {
      totalDataLength += Number(item.dataLength);
    }
  }

  const mapToSorted = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    returnedCount: items.length,
    scriptFileCount,
    binaryAniFileCount,
    totalDataLength,
    topLevels: mapToSorted(topLevels),
    extensions: mapToSorted(extensions),
  };
}

function resolveLstEntryPvfPath(registryPath, rawPath) {
  const normalizedRaw = toPosix(rawPath).replace(/^\/+/, "").replace(/\/+/g, "/");
  const baseDir = path.posix.dirname(toPosix(registryPath));
  if (!normalizedRaw || baseDir === ".") {
    return normalizedRaw;
  }
  const normalizedBase = `${baseDir.replace(/\/+$/, "")}/`;
  if (normalizedRaw.toLowerCase().startsWith(normalizedBase.toLowerCase())) {
    return normalizedRaw;
  }
  return `${normalizedBase}${normalizedRaw}`;
}

function parseLstEntries(registryPath, textContent) {
  const entries = [];
  const warnings = [];
  const lines = String(textContent || "").split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const match = trimmed.match(/^(-?\d+)\s+`([^`]+)`/);
    if (!match) {
      warnings.push({ line: index + 1, text: trimmed.slice(0, 160) });
      return;
    }
    const id = Number(match[1]);
    const rawPath = toPosix(match[2]);
    const pvfPath = resolveLstEntryPvfPath(registryPath, rawPath);
    entries.push({
      registryPath: toPosix(registryPath),
      id,
      rawPath,
      pvfPath: pvfPath.toLowerCase(),
      line: index + 1,
    });
  });

  return { entries, warnings };
}

async function buildLstIndex(client, sessionId, registries, config) {
  const entries = [];
  const parseWarnings = [];
  const registrySummaries = [];

  for (const registry of registries) {
    const registryPath = registry.path;
    const estimatedMaxChars = Math.max(
      30000,
      Number(registry.dataLength || 0) * 8 + 2000,
      Number(registry.entryCount || 0) * 180 + 2000
    );
    const read = await callAndParse(client, "pvf_read_file", {
      sessionId,
      pvfPath: registryPath,
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      decompileScript: true,
      decompileBinaryAni: false,
      autoConvertStringLink: false,
      useCompatibleDecompiler: true,
      convertToSimplifiedChinese: false,
      maxChars: estimatedMaxChars,
    });
    const parsed = parseLstEntries(registryPath, read.textContent || "");
    for (const entry of parsed.entries) {
      entries.push({
        registryLabel: registry.label,
        registryDescription: registry.description,
        ...entry,
      });
    }
    for (const warning of parsed.warnings) {
      parseWarnings.push({ registryPath, ...warning });
    }
    registrySummaries.push({
      path: registryPath,
      label: registry.label,
      description: registry.description,
      declaredEntryCount: registry.entryCount,
      parsedEntryCount: parsed.entries.length,
      parseWarningCount: parsed.warnings.length,
    });
  }

  return {
    entries,
    parseWarnings,
    registrySummaries,
  };
}

function artifact(dir, name) {
  const file = path.join(dir, name);
  const stat = fs.statSync(file);
  return {
    name,
    path: file,
    bytes: stat.size,
    sha256: sha256File(file),
  };
}

async function listFilesForIndex(client, sessionId, { prefix, contains, limit }) {
  const pageLimit = 2000;
  const items = [];
  let offset = 0;
  let firstPage = null;
  while (items.length < limit) {
    const page = await callAndParse(client, "pvf_list_files_page", {
      sessionId,
      prefix: prefix || undefined,
      contains: contains || undefined,
      offset,
      limit: Math.min(pageLimit, limit - items.length),
    });
    if (!firstPage) {
      firstPage = page;
    }
    const pageItems = Array.isArray(page.items) ? page.items : [];
    items.push(...pageItems);
    if (!page.hasMore || pageItems.length === 0 || page.nextOffset === null || page.nextOffset === undefined) {
      break;
    }
    offset = Number(page.nextOffset);
  }
  return {
    ok: true,
    sessionId,
    totalFileCount: Number(firstPage?.totalFileCount || 0),
    matchedCount: Number(firstPage?.matchedCount || items.length),
    returnedCount: items.length,
    items,
  };
}

async function summarizeIndex() {
  output(indexStore.summarizeIndex(workbenchRoot, {
    profile: option("--profile"),
    pvf: option("--pvf"),
    indexDir: option("--index-dir"),
    scope: option("--scope"),
  }));
}

async function statusIndex() {
  const result = indexStore.indexStatus(workbenchRoot, {
    profile: option("--profile"),
    pvf: option("--pvf"),
    indexDir: option("--index-dir"),
    scope: option("--scope"),
    skipSampleHash: flag("--skip-sample-hash"),
    verifyFullSha: flag("--verify-full-sha"),
  });
  output(flag("--details") ? result : {
    ok: result.ok,
    command: "status",
    indexDir: result.indexDir,
    manifestPath: result.manifestPath,
    sourcePvf: result.sourcePvf,
    exists: result.exists,
    fresh: result.fresh,
    verification: result.verification,
    checks: result.checks,
    scope: result.manifest?.scope,
    warnings: result.manifest?.summary?.warnings || [],
  });
}

async function queryPathIndex() {
  output(await indexStore.queryPathIndex(workbenchRoot, {
    profile: option("--profile"),
    pvf: option("--pvf"),
    indexDir: option("--index-dir"),
    scope: option("--scope"),
    prefix: option("--prefix"),
    contains: option("--contains"),
    ext: option("--ext"),
    limit: numberOption("--limit", 20),
  }));
}

async function resolveLstIndex() {
  output(await indexStore.resolveLstIndex(workbenchRoot, {
    profile: option("--profile"),
    pvf: option("--pvf"),
    indexDir: option("--index-dir"),
    scope: option("--scope"),
    lstPath: requireOption("--lst"),
    id: numberOption("--id"),
    limit: numberOption("--limit", 20),
  }));
}

async function catalogIndex() {
  output(indexStore.loadIndexCatalog(workbenchRoot, {
    profile: option("--profile"),
    pvf: option("--pvf"),
    catalogPath: option("--catalog"),
  }));
}

async function buildIndex() {
  const config = loadAdapterConfig(workbenchRoot);
  assertReadOnlyAdapter(config);
  const resolved = resolveSourcePvf(workbenchRoot, option("--profile"), option("--pvf"));
  const sourceStat = fs.statSync(resolved.sourcePvf);
  const profileName = resolved.profile?.name || null;
  const indexName = profileName ? safeName(profileName) : indexStore.sourceIndexName(resolved.sourcePvf);
  const sourceSha256 = sha256File(resolved.sourcePvf);
  const sourceSha256Sample = sourceSampleHash(resolved.sourcePvf);
  const postHashStat = fs.statSync(resolved.sourcePvf);
  if (postHashStat.size !== sourceStat.size || Math.abs(postHashStat.mtimeMs - sourceStat.mtimeMs) >= 2) {
    throw new Error("Source PVF changed while its index identity was being calculated; run the build again.");
  }
  const scopeName = option("--scope");
  const outputDir = path.resolve(
    option(
      "--out",
      scopeName
        ? runtimePath(workbenchRoot, "indexes", indexName, "scopes", safeName(scopeName))
        : runtimePath(workbenchRoot, "indexes", indexName, "latest")
    )
  );
  ensureDir(outputDir);

  const client = new BackendStdioClient(upstreamLaunchOptions(config));
  try {
    const result = await withOpenSession(config, client, resolved, async (sessionId) => {
      const limit = numberOption("--limit", config.defaults.indexLimit || 1000000);
      const prefix = option("--prefix", null);
      const contains = option("--contains", null);
      const files = await listFilesForIndex(client, sessionId, {
        sessionId,
        prefix,
        contains,
        limit,
      });
      const pathItems = Array.isArray(files.items) ? files.items : [];
      const matchedCount = Number(files.matchedCount || pathItems.length);
      const returnedCount = Number(files.returnedCount || pathItems.length);
      const truncatedPathIndex = returnedCount < matchedCount;
      if (truncatedPathIndex && !flag("--allow-truncated-path-index")) {
        throw new Error(
          `Path index would be truncated: returnedCount=${returnedCount}, matchedCount=${matchedCount}. ` +
            "Add a narrower --prefix/--contains scope, or pass --allow-truncated-path-index to write a partial path index."
        );
      }
      const registries = await callAndParse(client, "pvf_list_registries", {
        sessionId,
        includeCounts: true,
        includeSecondary: flag("--include-secondary"),
        pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
        convertToSimplifiedChinese: true,
      });
      const registryItems = Array.isArray(registries.items) ? registries.items : [];
      const lstIndex = flag("--no-lst-index")
        ? { entries: [], parseWarnings: [], registrySummaries: [] }
        : await buildLstIndex(client, sessionId, registryItems, config);

      const pathsFile = path.join(outputDir, "paths.jsonl");
      const pathSummaryFile = path.join(outputDir, "path-summary.json");
      const registriesFile = path.join(outputDir, "registries.json");
      const lstIndexFile = path.join(outputDir, "lst-index.jsonl");
      const lstWarningsFile = path.join(outputDir, "lst-parse-warnings.json");

      await writeJsonl(pathsFile, pathItems.map((item) => ({
        fileName: toPosix(item.fileName || ""),
        dataLength: Number(item.dataLength || 0),
        isScriptFile: Boolean(item.isScriptFile),
        isBinaryAniFile: Boolean(item.isBinaryAniFile),
      })));
      const pathStats = pathSummary(pathItems);
      writeJson(pathSummaryFile, {
        ...pathStats,
        totalFileCount: Number(files.totalFileCount || 0),
        matchedCount,
        returnedCount,
      });
      writeJson(registriesFile, {
        totalCount: Number(registries.totalCount || registryItems.length),
        primaryCount: Number(registries.primaryCount || registryItems.length),
        secondaryCount: Number(registries.secondaryCount || 0),
        items: registryItems,
        parsed: lstIndex.registrySummaries,
      });
      await writeJsonl(lstIndexFile, lstIndex.entries);
      writeJson(lstWarningsFile, lstIndex.parseWarnings);

      const warnings = [];
      const scopedPathIndex = Boolean(prefix || contains);
      const completePathIndex = !scopedPathIndex && !truncatedPathIndex && returnedCount >= Number(files.totalFileCount || matchedCount);
      if (scopedPathIndex) {
        warnings.push("Path index is scoped; do not treat paths.jsonl as a complete PVF file list.");
      }
      if (truncatedPathIndex) {
        warnings.push("Path index is truncated; do not treat paths.jsonl as a complete PVF file list.");
      }
      if (!completePathIndex) {
        warnings.push("Use target PVF read/list calls for paths outside this index scope.");
      }
      if (lstIndex.parseWarnings.length > 0) {
        warnings.push(`${lstIndex.parseWarnings.length} .lst line(s) did not match the standard id-backtick-path format.`);
      }

      const manifestPath = path.join(outputDir, "INDEX-MANIFEST.json");
      const finalSourceStat = fs.statSync(resolved.sourcePvf);
      if (finalSourceStat.size !== sourceStat.size || Math.abs(finalSourceStat.mtimeMs - sourceStat.mtimeMs) >= 2) {
        throw new Error("Source PVF changed during index build; no trustworthy index manifest was written.");
      }
      const manifest = {
        schemaVersion: "1.0",
        phase: "phase-4-readonly-session-index",
        generatedAt: new Date().toISOString(),
        mode: "read-only-index",
        source: {
          profile: profileName,
          profileSource: resolved.profile?.profileSource || null,
          sourcePvf: resolved.sourcePvf,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          sourceSha256,
          sourceSha256Sample,
          pvfEncoding: resolved.profile?.pvfEncoding || null,
        },
        scope: {
          scopeName: scopeName || "latest",
          scopeKey: safeName(scopeName || "latest"),
          prefix,
          contains,
          limit,
          includeLstIndex: !flag("--no-lst-index"),
          completePathIndex,
        },
        artifacts: [],
        summary: {
          pathIndex: {
            totalFileCount: Number(files.totalFileCount || 0),
            matchedCount,
            returnedCount,
            scriptFileCount: pathStats.scriptFileCount,
            binaryAniFileCount: pathStats.binaryAniFileCount,
            totalDataLength: pathStats.totalDataLength,
          },
          registries: {
            totalCount: Number(registries.totalCount || registryItems.length),
            primaryCount: Number(registries.primaryCount || registryItems.length),
            secondaryCount: Number(registries.secondaryCount || 0),
          },
          lstIndex: {
            registryCount: registryItems.length,
            entryCount: lstIndex.entries.length,
            parseWarningCount: lstIndex.parseWarnings.length,
          },
          warnings,
        },
        safety: {
          readOnly: true,
          sourceOverwritten: false,
          clientResourceWrite: false,
          fullSourceSha256Bound: true,
        },
      };
      writeJson(manifestPath, manifest);
      manifest.artifacts = [
        artifact(outputDir, "paths.jsonl"),
        artifact(outputDir, "path-summary.json"),
        artifact(outputDir, "registries.json"),
        artifact(outputDir, "lst-index.jsonl"),
        artifact(outputDir, "lst-parse-warnings.json"),
      ];
      writeJson(manifestPath, manifest);
      indexStore.updateIndexCatalog(workbenchRoot, {
        profile: profileName,
        pvf: profileName ? undefined : resolved.sourcePvf,
        scope: scopeName || "latest",
        manifestPath,
      });

      return { manifestPath, manifest };
    });

    output({
      ok: true,
      command: "build",
      manifestPath: result.manifestPath,
      summary: result.manifest.summary,
      safety: result.manifest.safety,
    });
  } finally {
    client.stop();
  }
}

async function main() {
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "build") {
    await buildIndex();
    return;
  }
  if (command === "catalog") {
    await catalogIndex();
    return;
  }
  if (command === "summary") {
    await summarizeIndex();
    return;
  }
  if (command === "status") {
    await statusIndex();
    return;
  }
  if (command === "path") {
    await queryPathIndex();
    return;
  }
  if (command === "resolve-lst") {
    await resolveLstIndex();
    return;
  }
  {
    throw new Error(`Unsupported command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
});
