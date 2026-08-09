"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 && rawArgs[rootIndex + 1]
  ? path.resolve(rawArgs[rootIndex + 1])
  : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function flag(name) {
  return args.includes(name);
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableUnique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function writeJson(file, value) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return { bytes: buffer.length, sha256: sha256(buffer) };
}

function compactParameter(parameter) {
  if (!parameter || typeof parameter !== "object") return parameter;
  return Object.fromEntries(Object.entries(parameter).filter(([key, value]) =>
    ["name", "type", "optional", "defaultValue", "variadic"].includes(key) && value !== undefined && value !== null && value !== ""));
}

function compactReturn(value) {
  if (!value || typeof value !== "object") return value || null;
  const compact = Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    ["name", "type", "optional"].includes(key) && item !== undefined && item !== null && item !== ""));
  return Object.keys(compact).length ? compact : null;
}

function compactVersion(value) {
  return value ? String(value).replace(/\s+https?:\/\/\S+/gi, "").trim() : null;
}

function comparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^\[|\]$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function authorMembers(value) {
  return String(value || "")
    .split(/[|｜]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function compactCommunityComment(item, blockedAuthors = []) {
  const raw = String(item.comment ?? item.normalizedComment ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!raw) return "";
  const section = comparableText(item.section || item.normalizedSection);
  const authors = [...blockedAuthors].map(comparableText).filter(Boolean);
  const disclosure = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[a-z]:[\\/]|\\\\[^\\\s]+\\|(?:qq|微信|群号|群聊|邮箱|e-?mail)\s*[:：]?\s*\d|(?:作者|署名|来源|转载|版权|制作|整理|汉化|翻译|维护者)(?:\s*[:：]|\s+)|最后编辑时间|mkjung\s+\d{6}|^(?:by|from)\s+\S+)/i;
  const irrelevant = /歌词|\blyrics?\b|never\s+gonna/i;
  const cleanLine = (value) => String(value || "")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  const usable = (value) => {
    const line = cleanLine(value);
    if (!line || line.length > 160 || disclosure.test(line) || irrelevant.test(line)) return false;
    const normalizedLine = comparableText(line);
    if (authors.some((author) => normalizedLine.includes(author))) return false;
    if (/^[\p{P}\p{S}\s\d]+$/u.test(line)) return false;
    return true;
  };
  const scoreLine = (line) => {
    let score = 0;
    if (/[\u3400-\u9fff]/u.test(line)) score += 20;
    if (/(?:表示|代表|用于|使用|控制|几率|概率|奖励|权重|第一|左边|右边|无视|显示|增加|减少|消耗|属性|伤害|等级|时间|位置|数量|范围|效果|判定|出售|商店|列表|索引|帧|职业|材料|交易|绑定|状态|异常|防御|攻击|容量)/.test(line)) score += 20;
    score += Math.min(line.length, 40) / 4;
    if ((line.match(/、/g) || []).length >= 3) score -= 10;
    if (/\s{3,}|[（(][^）)]*$/.test(line)) score -= 20;
    if (!/[\u3400-\u9fff]/u.test(line)) score -= 10;
    return score;
  };

  const lines = raw.split("\n");
  const titleIndex = lines.findIndex((line) => /^\s*标题\s*[:：]/.test(line));
  const candidates = [];
  if (titleIndex >= 0) {
    const title = cleanLine(lines[titleIndex].replace(/^\s*标题\s*[:：]\s*/, ""));
    if (usable(title) && comparableText(title) !== section) return title;
    if (!title) {
      for (let index = titleIndex + 1; index < lines.length; index += 1) {
        const rawLine = lines[index];
        if (!rawLine.trim()) {
          if (candidates.length > 0) break;
          continue;
        }
        if (!/^\s*[-*]\s+/.test(rawLine)) break;
        const line = cleanLine(rawLine);
        if (!usable(line) || comparableText(line) === section || /^#+\d*$/.test(line)) continue;
        candidates.push({ line, score: scoreLine(line) + 10, index });
      }
    }
  }

  let inFence = false;
  for (let index = titleIndex >= 0 ? titleIndex + 1 : 0; index < lines.length; index += 1) {
    const rawLine = lines[index].trim();
    if (/^```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{2,}\s*/.test(rawLine)) break;
    if (/^(?:\/\/|\/\*|\*\/)/.test(rawLine)) continue;
    if (/^[—–_=/\\]{3,}$/.test(rawLine)) continue;
    const line = cleanLine(rawLine);
    if (!usable(line)) continue;
    if (/^\[\/?[^\]]+\]$/.test(line)) continue;
    if (comparableText(line) === section) continue;
    if (/^(?:[-+]?\d+(?:\.\d+)?\s*)+$/.test(line)) continue;
    candidates.push({ line, score: scoreLine(line), index });
  }
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  if (candidates.length > 0) return candidates[0].line;
  const fallback = cleanLine(item.normalizedComment);
  return usable(fallback) && comparableText(fallback) !== section ? fallback : "";
}

function buildNutCatalog(source) {
  if (!Array.isArray(source.declarations)) throw new Error("NUT catalog has no declarations array.");
  const conflictNames = new Set();
  for (const conflict of source.conflicts || []) {
    for (const value of [conflict.name, conflict.qualifiedName, conflict.symbol]) if (value) conflictNames.add(String(value).toLowerCase());
    if (conflict.key) conflictNames.add(String(conflict.key).replace(/^[^:]+:/, "").toLowerCase());
  }
  const declarations = source.declarations.map((item) => {
    const row = {
      kind: item.kind,
      name: item.name,
      qualifiedName: item.qualifiedName || item.name,
      className: item.className || null,
      extends: item.extends || null,
      signature: item.signature || null,
      parameters: (item.parameters || []).map(compactParameter),
      returns: compactReturn(item.returns),
      value: item.value === undefined ? null : item.value,
      package: item.package || null,
      version: compactVersion(item.version),
      group: item.group || "unknown",
    };
    if (conflictNames.has(String(row.name || "").toLowerCase()) || conflictNames.has(String(row.qualifiedName || "").toLowerCase())) row.conflict = true;
    return row;
  });
  return {
    schemaVersion: "1.0",
    phase: "builtin-nut-api-facts",
    declaredRuntimeVersion: source.source?.declaredRuntimeVersion || "3.0.7",
    summary: {
      declarationCount: declarations.length,
      functionCount: declarations.filter((item) => item.kind === "function").length,
      constantCount: declarations.filter((item) => item.kind === "constant").length,
      classCount: declarations.filter((item) => item.kind === "class").length,
      dnfFunctionCount: declarations.filter((item) => item.kind === "function" && item.group === "dnf").length,
      dnfConstantCount: declarations.filter((item) => item.kind === "constant" && item.group === "dnf").length,
      conflictMarkedCount: declarations.filter((item) => item.conflict).length,
    },
    declarations,
  };
}

function buildTagCatalog(source, allowedCommunityAuthors = []) {
  const corruptText = (value) => /\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(String(value || ""));
  const communitySource = source.community || source.xiti || {};
  const sourceRows = communitySource.newRows || communitySource.rows || [];
  const normalizedAuthors = new Set(allowedCommunityAuthors.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const sourceHasAuthors = sourceRows.some((item) => item.authors !== undefined && item.authors !== null && String(item.authors).trim());
  if (sourceHasAuthors && normalizedAuthors.size === 0) {
    throw new Error("A tag catalog with author metadata requires at least one explicit --community-author value.");
  }
  const selectedRows = sourceHasAuthors
    ? sourceRows.filter((item) => authorMembers(item.authors).some((author) => normalizedAuthors.has(author)))
    : sourceRows;
  const rowKeys = new Set();
  const newRows = [];
  for (const item of selectedRows) {
    if (!item.normalizedSection) continue;
    if ([item.section, item.normalizedSection, item.comment, item.normalizedComment].some(corruptText)) continue;
    const comment = compactCommunityComment(item, normalizedAuthors);
    if (!comment) continue;
    const row = {
      section: item.section || item.normalizedSection,
      normalizedSection: item.normalizedSection,
      comment,
      normalizedComment: comment,
      fileType: item.fileType ?? null,
    };
    const key = JSON.stringify(row);
    if (!rowKeys.has(key)) {
      rowKeys.add(key);
      newRows.push(row);
    }
  }
  const layeredSource = source.layeredTags?.tags || source.korean?.tags || [];
  const layeredTags = layeredSource.map((item) => ({
    normalizedTag: item.normalizedTag,
    displayTag: item.displayTag,
    officialOriginalOccurrences: (item.officialOriginalOccurrences || item.officialOccurrences || []).length
      ? [{ layer: "official-original", occurrenceCount: (item.officialOriginalOccurrences || item.officialOccurrences).length }]
      : [],
    toolExtensionOccurrences: (item.toolExtensionOccurrences || item.bytoolOccurrences || []).length
      ? [{ layer: "tool-extension", occurrenceCount: (item.toolExtensionOccurrences || item.bytoolOccurrences).length }]
      : [],
  }));
  const registrySource = source.registryHints || source.hoverConfig || {};
  const registryEntries = (registrySource.entries || []).map((item) => ({
    nodeType: item.nodeType || null,
    fileName: item.fileName || null,
    SectionName: item.SectionName || null,
    ParentSectionName: item.ParentSectionName || null,
    LstFileName: item.LstFileName || null,
    Description: item.Description || null,
    registryStatus: "unverified-source-hint",
  }));
  const spellingCandidates = (registrySource.suspiciousRegistryCandidates || []).map((item) => ({
    observed: item.observed,
    candidate: item.candidate,
    status: "spelling-candidate-not-registry-fact",
    context: item.context ? {
      fileName: item.context.fileName || null,
      SectionName: item.context.SectionName || null,
      LstFileName: item.context.LstFileName || null,
    } : null,
  }));
  return {
    schemaVersion: "1.0",
    phase: "builtin-pvf-tag-facts",
    safety: {
      targetPvfReadbackRequired: true,
      zeroMatchesProveTagUnavailable: false,
      officialOriginalAndToolExtensionSeparated: true,
      translationsSeparated: true,
      registryHintsAreFacts: false,
    },
    summary: {
      communityEntryCount: newRows.length,
      layeredTagCount: layeredTags.length,
      registryHintCount: registryEntries.length,
      suspiciousRegistryCandidateCount: spellingCandidates.length,
    },
    community: { kind: "compiled-community-facts", rows: newRows },
    layeredTags: { kind: "compiled-trust-layer-facts", tags: layeredTags },
    registryHints: { kind: "compiled-registry-hints", entries: registryEntries, suspiciousRegistryCandidates: spellingCandidates },
  };
}

function buildBookmarkCatalog(source) {
  const byPath = new Map();
  let rawEntryCount = 0;
  for (const folder of source.folders || []) {
    for (const item of folder.items || []) {
      rawEntryCount += 1;
      const normalizedPath = String(item.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalizedPath) continue;
      const key = normalizedPath.toLowerCase();
      if (!byPath.has(key)) byPath.set(key, { path: normalizedPath, labels: [], groups: [] });
      const row = byPath.get(key);
      row.labels.push(String(item.label || "").trim());
      row.groups.push(String(folder.name || "").trim());
    }
  }
  const bookmarks = [...byPath.values()].map((item) => {
    return {
      path: item.path,
      labels: stableUnique(item.labels),
      groups: stableUnique(item.groups),
    };
  }).sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    schemaVersion: "1.0",
    phase: "builtin-pvf-task-bookmarks",
    safety: {
      navigationCandidatesOnly: true,
      targetPvfExistenceCheckRequired: true,
      targetPvfReadbackRequiredForMeaning: true,
      originalSpellingPreserved: true,
    },
    summary: {
      uniquePathCount: bookmarks.length,
    },
    bookmarks,
  };
}

function updateKnowledgeManifest(outputs) {
  const manifestPath = path.join(workbenchRoot, "knowledge-pack", "MANIFEST.json");
  const manifest = readJson(manifestPath);
  const outputByDest = new Map(outputs.map((item) => [item.dest, item]));
  manifest.entries = (manifest.entries || []).filter((item) => !outputByDest.has(item.dest));
  for (const item of outputs) {
    manifest.entries.push({
      dest: item.dest,
      bytes: item.bytes,
      sha256: item.sha256,
    });
  }
  const additionalCleanFiles = ["dictionaries/pvf-task-bookmarks-boundary-quick.zh-CN.md"];
  for (const dest of additionalCleanFiles) {
    if (!manifest.entries.some((item) => item.dest === dest)) {
      manifest.entries.push({
        dest,
        bytes: 0,
        sha256: "",
      });
    }
  }
  for (const entry of manifest.entries) {
    const file = path.join(workbenchRoot, "knowledge-pack", entry.dest);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Knowledge manifest entry is missing: ${entry.dest}`);
    const buffer = fs.readFileSync(file);
    entry.bytes = buffer.length;
    entry.sha256 = sha256(buffer);
  }
  manifest.schemaVersion = "2.0";
  manifest.purpose = "Integrity-only manifest for the portable clean knowledge pack.";
  manifest.entries = manifest.entries
    .map(({ dest, bytes, sha256: digest }) => ({ dest, bytes, sha256: digest }))
    .sort((left, right) => left.dest.localeCompare(right.dest, "en"));
  manifest.summary = {
    entryCount: manifest.entries.length,
    totalBytes: manifest.entries.reduce((sum, item) => sum + Number(item.bytes || 0), 0),
  };
  for (const key of ["phase", "generatedAt", "sourceVariables", "pathReferences", "externalSourcePolicy"]) delete manifest[key];
  writeJson(manifestPath, manifest);
}

function main() {
  const only = String(option("--only", "all")).toLowerCase();
  if (!["all", "nut", "tag", "bookmark"].includes(only)) throw new Error("--only must be all, nut, tag, or bookmark.");
  const outputDir = path.join(workbenchRoot, "knowledge-pack", "indexes");
  const products = [];
  if (only === "all" || only === "nut") {
    products.push({ dest: "indexes/nut-api-facts.compact.json", value: buildNutCatalog(readJson(required("--nut-catalog"))) });
  }
  if (only === "all" || only === "tag") {
    products.push({
      dest: "indexes/pvf-tag-facts.compact.json",
      value: buildTagCatalog(readJson(required("--tag-catalog")), options("--community-author")),
    });
  }
  if (only === "all" || only === "bookmark") {
    products.push({ dest: "indexes/pvf-task-bookmarks.compact.json", value: buildBookmarkCatalog(readJson(required("--bookmarks"))) });
  }
  if (flag("--dry-run")) {
    process.stdout.write(`${JSON.stringify({ ok: true, command: "build-clean-builtin-knowledge", dryRun: true, summaries: Object.fromEntries(products.map((item) => [item.dest, item.value.summary])) }, null, 2)}\n`);
    return;
  }
  const outputs = products.map((product) => ({
    dest: product.dest,
    ...writeJson(path.join(outputDir, path.basename(product.dest)), product.value),
  }));
  updateKnowledgeManifest(outputs);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "build-clean-builtin-knowledge", outputs, summaries: Object.fromEntries(products.map((item) => [item.dest, item.value.summary])) }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
