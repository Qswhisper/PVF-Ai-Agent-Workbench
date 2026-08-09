"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { loadPvfBackend } = require("../../../tools/pvf-bridge/native-backend");
const {
  appendClaims,
  assertExternalOutput,
  pathInside,
  readJson,
  safeId,
  sha256,
  sha256File,
  timestamp,
  writeJsonAtomic,
} = require("../lib/research-store");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = String(args[0] || "help").toLowerCase();

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) if (args[index] === name) values.push(args[index + 1]);
  return values;
}

function flag(name) {
  return args.includes(name);
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function numberOption(name, fallback, maximum = 1000) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}

function usage() {
  return `Usage:
  workbench.bat tag-knowledge build --community-old <comments.db> --community-new <comments.db> --official-original <directory> [--tool-extension <directory>] [--registry-hints <file>] [--claim-store <CLAIM-STORE.json>] [--replace-claims] [--out <external-dir>] [--force]
  workbench.bat tag-knowledge query --tag <section> [--layer community|official-original|tool-extension] [--observation <PVF-TAG-OBSERVATIONS.json|observe-output-dir>]... [--exact] [--limit 20]
  workbench.bat tag-knowledge query-observation --report <PVF-TAG-OBSERVATIONS.json|observe-output-dir> [--tag <section>] [--exact] [--limit 20]
  workbench.bat tag-knowledge search --keyword <text> [--limit 20]
  workbench.bat tag-knowledge stats
  workbench.bat tag-knowledge observe-pvf --pvf <Script.pvf> --tag <section> [--tag <section>]... [--samples 3] [--encoding Cn] [--out <external-dir>] [--force]
  workbench.bat tag-knowledge self-test

Queries use Workbench-bundled compact tag facts by default. --catalog remains a maintenance-only override. Target observations and machine paths stay outside the clean knowledge pack.
`;
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeEncoding(value) {
  const raw = String(value || "Cn").toLowerCase();
  return ({ tw: "Tw", cn: "Cn", kr: "Kr", jp: "Jp", utf8: "Utf8", unicode: "Unicode" })[raw] || value;
}

function normalizeTag(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function displayTag(value) {
  const normalized = normalizeTag(value);
  return normalized ? `[${normalized}]` : "";
}

function normalizeCommentForDiff(value) {
  const normalized = String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const title = normalized.match(/^标题\s*[:：]\s*([^\n]*)/);
  if (title) return title[1].trim();
  return (normalized.split("\n").find((line) => line.trim()) || "").trim();
}

function listFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) results.push(full);
    }
  }
  return results.sort((a, b) => toPosix(a).localeCompare(toPosix(b), "zh-Hans-CN"));
}

function sqliteRows(file) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = database.prepare("select name, sql from sqlite_master where type=? order by name").all("table");
    const tables = new Set(schema.map((item) => item.name));
    if (!tables.has("pvf_comment")) throw new Error(`SQLite does not contain pvf_comment: ${file}`);
    const rows = database.prepare('select Id, PvfCommentType, FileType, Section, Comment, Authors, "Create" as "Create", UpdateTime from pvf_comment order by Id').all();
    return { schema, rows };
  } finally {
    database.close();
  }
}

function communityRecord(row) {
  return {
    id: Number(row.Id),
    pvfCommentType: row.PvfCommentType === null ? null : Number(row.PvfCommentType),
    fileType: row.FileType === null ? null : Number(row.FileType),
    section: String(row.Section || ""),
    normalizedSection: normalizeTag(row.Section),
    comment: row.Comment === null ? null : String(row.Comment),
    normalizedComment: normalizeCommentForDiff(row.Comment),
    authors: row.Authors === null ? null : String(row.Authors),
    create: String(row.Create || ""),
    updateTime: String(row.UpdateTime || ""),
  };
}

function buildCommunity(oldFile, newFile) {
  const oldDb = sqliteRows(oldFile);
  const newDb = sqliteRows(newFile);
  const oldRows = oldDb.rows.map(communityRecord);
  const newRows = newDb.rows.map(communityRecord);
  const oldById = new Map(oldRows.map((item) => [item.id, item]));
  const newById = new Map(newRows.map((item) => [item.id, item]));
  const added = newRows.filter((item) => !oldById.has(item.id)).map((item) => item.id);
  const removed = oldRows.filter((item) => !newById.has(item.id)).map((item) => item.id);
  const changed = [];
  for (const current of newRows) {
    const previous = oldById.get(current.id);
    if (!previous || previous.comment === current.comment) continue;
    const substantive = previous.normalizedComment !== current.normalizedComment;
    changed.push({
      id: current.id,
      sectionBefore: previous.section,
      sectionAfter: current.section,
      rawChanged: true,
      classification: substantive ? "substantive" : "format-only",
      normalizedBeforeSha256: sha256(previous.normalizedComment),
      normalizedAfterSha256: sha256(current.normalizedComment),
    });
  }
  return {
    sources: {
      old: { path: oldFile, sha256: sha256File(oldFile), schema: oldDb.schema, rowCount: oldRows.length },
      new: { path: newFile, sha256: sha256File(newFile), schema: newDb.schema, rowCount: newRows.length },
    },
    summary: {
      oldRowCount: oldRows.length,
      newRowCount: newRows.length,
      commonIdCount: newRows.length - added.length,
      addedIdCount: added.length,
      removedIdCount: removed.length,
      rawChangedCount: changed.length,
      formatOnlyChangedCount: changed.filter((item) => item.classification === "format-only").length,
      substantiveChangedCount: changed.filter((item) => item.classification === "substantive").length,
      uniqueNewSectionCount: new Set(newRows.map((item) => item.section.trim().replace(/\s+/g, " ").toLowerCase())).size,
      uniqueRawNewSectionCount: new Set(newRows.map((item) => item.section)).size,
      uniqueNormalizedNewSectionCount: new Set(newRows.map((item) => item.normalizedSection)).size,
    },
    oldRows,
    newRows,
    diff: { addedIds: added, removedIds: removed, changed },
  };
}

function decodeText(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return { encoding: "ole-binary", binary: true, text: "" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: "utf-16le", binary: false, text: new TextDecoder("utf-16le").decode(buffer) };
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: "utf-16be", binary: false, text: new TextDecoder("utf-16be").decode(buffer) };
  try {
    return { encoding: "utf-8", binary: false, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { encoding: "cp949/euc-kr", binary: false, text: new TextDecoder("euc-kr").decode(buffer) };
  }
}

function extractTagOccurrences(text, relativePath, layer) {
  const results = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\[/.test(lines[index])) continue;
    for (const match of lines[index].matchAll(/\[([^\]\r\n]{1,160})\]/g)) {
      const normalizedTag = normalizeTag(match[1]);
      if (!normalizedTag || /^[0-9, .:+-]+$/.test(normalizedTag)) continue;
      results.push({
        tag: `[${match[1].trim()}]`,
        normalizedTag,
        layer,
        relativePath,
        line: index + 1,
        originalLine: lines[index].trim().slice(0, 1200),
        translation: null,
        translationMethod: null,
      });
    }
  }
  return results;
}

function buildLayeredTags(officialRoot, toolRoot) {
  const sources = [
    { root: officialRoot, layer: "official-original" },
    ...(toolRoot ? [{ root: toolRoot, layer: "tool-extension" }] : []),
  ];
  const fileRecords = [];
  const tagMap = new Map();
  for (const source of sources) {
    for (const file of listFiles(source.root)) {
      const relativePath = toPosix(path.relative(source.root, file));
      const buffer = fs.readFileSync(file);
      const decoded = decodeText(buffer);
      const occurrences = decoded.binary ? [] : extractTagOccurrences(decoded.text, relativePath, source.layer);
      fileRecords.push({ relativePath, sha256: sha256(buffer), bytes: buffer.length, encoding: decoded.encoding, layer: source.layer, tagOccurrenceCount: occurrences.length });
      for (const occurrence of occurrences) {
        if (!tagMap.has(occurrence.normalizedTag)) tagMap.set(occurrence.normalizedTag, { normalizedTag: occurrence.normalizedTag, displayTag: displayTag(occurrence.normalizedTag), officialOriginalOccurrences: [], toolExtensionOccurrences: [] });
        const row = tagMap.get(occurrence.normalizedTag);
        const target = source.layer === "tool-extension" ? row.toolExtensionOccurrences : row.officialOriginalOccurrences;
        if (target.length < 80) target.push(occurrence);
      }
    }
  }
  const tags = [...tagMap.values()].sort((a, b) => a.normalizedTag.localeCompare(b.normalizedTag));
  const official = tags.filter((item) => item.officialOriginalOccurrences.length > 0);
  const tool = tags.filter((item) => item.toolExtensionOccurrences.length > 0);
  return {
    sources: Object.fromEntries(sources.map((source) => {
      const records = fileRecords.filter((item) => item.layer === source.layer);
      return [source.layer, { root: source.root, fileCount: records.length, sourceFingerprint: sha256(records.map((item) => `${item.relativePath}\t${item.sha256}`).join("\n")) }];
    })),
    summary: {
      fileCount: fileRecords.length,
      binarySkippedFileCount: fileRecords.filter((item) => item.encoding === "binary" || item.encoding === "ole-binary").length,
      officialOriginalTagCount: official.length,
      toolExtensionTagCount: tool.length,
      officialOriginalOnlyTagCount: official.filter((item) => item.toolExtensionOccurrences.length === 0).length,
      toolExtensionOnlyTagCount: tool.filter((item) => item.officialOriginalOccurrences.length === 0).length,
      sharedTagCount: tags.filter((item) => item.officialOriginalOccurrences.length > 0 && item.toolExtensionOccurrences.length > 0).length,
    },
    files: fileRecords,
    tags,
  };
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of String(source || "").matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

function buildRegistryHints(file) {
  if (!file) return { source: null, entries: [], suspiciousRegistryCandidates: [] };
  const resolved = path.resolve(file);
  const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  const entries = [];
  let currentFile = null;
  for (const line of text.split(/\r?\n/)) {
    const fileOpen = line.match(/<File\s+([^>]+)>/i);
    if (fileOpen) currentFile = parseAttributes(fileOpen[1]).FileName || null;
    if (/<\/File>/i.test(line)) currentFile = null;
    const section = line.match(/<(Section|SectionRange|SectionGroup|Index)\b([^>]*)>/i);
    if (!section) continue;
    const attributes = parseAttributes(section[2]);
    if (!attributes.LstFileName) continue;
    entries.push({ nodeType: section[1], fileName: currentFile, ...attributes, registryStatus: "unverified-source-hint" });
  }
  const suspicious = [];
  for (const entry of entries) {
    for (const registry of String(entry.LstFileName || "").split(",").map((item) => item.trim().toLowerCase())) {
      if (registry === "tackable") suspicious.push({ observed: registry, candidate: "stackable", status: "spelling-candidate-not-registry-fact", context: entry });
      if (registry === "wown") suspicious.push({ observed: registry, candidate: "town", status: "spelling-candidate-not-registry-fact", context: entry });
    }
  }
  return { source: { path: resolved, sha256: sha256File(resolved) }, entries, suspiciousRegistryCandidates: suspicious };
}

function buildClaims(catalog) {
  const claims = catalog.community.newRows.filter((item) => item.normalizedSection).map((item) => ({
    claimId: `community.tag.${item.id}.${sha256(`${item.section}:${item.comment || ""}`).slice(0, 16)}`,
    domain: "pvf-tag",
    subjectType: "section-comment",
    subject: item.normalizedSection,
    statement: item.normalizedComment || item.section,
    status: "candidate",
    sourceConfidence: "anchor",
    versionApplicability: "unknown",
    distributionStatus: "local-research-only",
    sourceRefs: [{ sourceId: "community-new", relativePath: "comments.db", locator: `row:${item.id}`, sourceFileSha256: catalog.community.sources.new.sha256 }],
  }));
  for (const item of catalog.layeredTags.tags) {
    if (!item.officialOriginalOccurrences.length) continue;
    const first = item.officialOriginalOccurrences[0];
    claims.push({
      claimId: `official-original.tag.${sha256(item.normalizedTag).slice(0, 20)}`,
      domain: "pvf-tag",
      subjectType: "official-tag-original",
      subject: item.normalizedTag,
      statement: first.originalLine || item.displayTag,
      status: "candidate",
      sourceConfidence: "anchor",
      versionApplicability: "unknown",
      distributionStatus: "local-research-only",
      sourceRefs: [{ sourceId: "official-original", relativePath: first.relativePath, locator: `line:${first.line}` }],
    });
  }
  return claims;
}

function catalogFromSources(oldFile, newFile, officialRoot, toolRoot, registryHintsFile) {
  const community = buildCommunity(oldFile, newFile);
  const layeredTags = buildLayeredTags(officialRoot, toolRoot);
  const registryHints = buildRegistryHints(registryHintsFile);
  return {
    schemaVersion: "1.0",
    phase: "external-pvf-tag-catalog",
    generatedAt: new Date().toISOString(),
    parser: { id: "workbench-pvf-tag-parser", version: "1.0.0", sourceInstructionsExecuted: false, sourceContentCopiedToWorkbench: false },
    safety: {
      localResearchOnly: true,
      unknownLicense: true,
      officialOriginalPreserved: true,
      translationNeverOverwritesOriginal: true,
      toolExtensionSeparatedFromOfficialOriginal: true,
      normalizedSpellingIsNotRegistryFact: true,
      generatedIndexIsNotFinalEvidence: true,
    },
    summary: { ...community.summary, ...layeredTags.summary, suspiciousRegistryCandidateCount: registryHints.suspiciousRegistryCandidates.length },
    community,
    layeredTags,
    registryHints,
  };
}

function build() {
  const oldFile = path.resolve(required("--community-old"));
  const newFile = path.resolve(required("--community-new"));
  const officialRoot = path.resolve(required("--official-original"));
  const toolRoot = option("--tool-extension") ? path.resolve(option("--tool-extension")) : null;
  for (const file of [oldFile, newFile]) if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Community comment database does not exist: ${file}`);
  for (const directory of [officialRoot, toolRoot].filter(Boolean)) if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error(`Tag layer directory does not exist: ${directory}`);
  const outRoot = assertExternalOutput(workbenchRoot, option("--out", runtimePath(workbenchRoot, "tag-knowledge-catalogs", timestamp())));
  for (const source of [oldFile, newFile, officialRoot, toolRoot].filter(Boolean)) if (pathInside(source, outRoot) || pathInside(outRoot, source)) throw new Error("Tag catalog output and source must not overlap.");
  const catalogPath = path.join(outRoot, "PVF-TAG-CATALOG.json");
  if (fs.existsSync(catalogPath) && !flag("--force")) throw new Error(`Tag catalog already exists: ${catalogPath}`);
  const catalog = catalogFromSources(oldFile, newFile, officialRoot, toolRoot, option("--registry-hints"));
  writeJsonAtomic(catalogPath, catalog);
  let claimsAdded = 0;
  if (option("--claim-store")) {
    const storePath = assertExternalOutput(workbenchRoot, option("--claim-store"));
    const store = readJson(storePath);
    if (flag("--replace-claims")) store.claims = (store.claims || []).filter((item) => !/^community\.|^official-original\./.test(String(item.claimId || "")));
    const claims = buildClaims(catalog);
    appendClaims(store, claims);
    writeJsonAtomic(storePath, store);
    claimsAdded = claims.length;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, command: "build", catalogPath, catalogSha256: sha256File(catalogPath), claimsAdded, summary: catalog.summary }, null, 2)}\n`);
}

function loadCatalog() {
  const configured = option("--catalog", process.env.PVF_TAG_KNOWLEDGE_CATALOG || path.join(workbenchRoot, "knowledge-pack", "indexes", "pvf-tag-facts.compact.json"));
  const file = path.resolve(configured);
  if (!fs.existsSync(file)) throw new Error(`Tag catalog does not exist: ${file}`);
  const catalog = readJson(file);
  if (!["external-pvf-tag-catalog", "builtin-pvf-tag-facts"].includes(catalog.phase)) throw new Error(`Not a supported tag catalog: ${file}`);
  return { file, catalog };
}

function publicCatalogPath(file) {
  const relative = path.relative(workbenchRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? `builtin:${relative.replace(/\\/g, "/")}`
    : file;
}

function resolveObservationFile(value) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`Tag observation does not exist: ${resolved}`);
  if (fs.statSync(resolved).isDirectory()) {
    const nested = path.join(resolved, "PVF-TAG-OBSERVATIONS.json");
    if (!fs.existsSync(nested) || !fs.statSync(nested).isFile()) throw new Error(`Tag observation directory is missing PVF-TAG-OBSERVATIONS.json: ${resolved}`);
    return nested;
  }
  if (!fs.statSync(resolved).isFile()) throw new Error(`Tag observation is not a file: ${resolved}`);
  return resolved;
}

function observationQueryResult(value, requestedTag = "", exact = false, limit = 20) {
  const observationFile = resolveObservationFile(value);
  const observation = readJson(observationFile);
  if (observation.phase !== "pvf-tag-observation" || !Array.isArray(observation.tags)) {
    throw new Error(`Not a PVF tag observation report: ${observationFile}`);
  }
  const needle = normalizeTag(requestedTag);
  const allMatches = observation.tags.filter((item) => {
    if (!needle) return true;
    const candidate = normalizeTag(item.normalizedTag || item.displayTag);
    return exact ? candidate === needle : candidate.includes(needle);
  });
  const matches = allMatches.slice(0, limit);
  return {
    ok: true,
    command: "query-observation",
    observation: {
      path: observationFile,
      sha256: sha256File(observationFile),
      pvf: observation.pvf || null,
      reportSummary: observation.summary || null,
      reportSafety: observation.safety || null,
    },
    query: { tag: needle || null, exact: Boolean(exact), limit },
    summary: { matchCount: allMatches.length, returnedCount: matches.length, truncated: allMatches.length > matches.length },
    matches,
    boundaries: {
      readOnly: true,
      generatedIndexIsFinalEvidence: false,
      zeroMatchesProveTagUnavailable: false,
      targetSampleReadbackRequired: true,
      directWriteAllowed: false,
    },
    agentHandoff: {
      observationQueryComplete: true,
      additionalObservationQueryRequired: false,
      nextReadOnlyStep: "read returned sample paths with workbench.bat pvf-read read-batch",
      helpProbeRequired: false,
    },
  };
}

function queryObservation() {
  const report = option("--report", option("--observation"));
  if (!report) throw new Error("query-observation requires --report <PVF-TAG-OBSERVATIONS.json|observe-output-dir>.");
  const result = observationQueryResult(report, option("--tag", ""), flag("--exact"), numberOption("--limit", 20, 200));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function query() {
  const { file, catalog } = loadCatalog();
  const needle = normalizeTag(required("--tag"));
  const exact = flag("--exact");
  const layer = option("--layer");
  const limit = numberOption("--limit", 20, 200);
  const match = (value) => exact ? value === needle : value.includes(needle);
  const communityRows = catalog.community.rows || catalog.community.newRows;
  const layeredTags = catalog.layeredTags.tags.filter((item) => match(item.normalizedTag));
  const result = {
    community: layer && layer !== "community" ? [] : communityRows.filter((item) => match(item.normalizedSection)).slice(0, limit),
    officialOriginal: layer && layer !== "official-original" ? [] : layeredTags.filter((item) => item.officialOriginalOccurrences.length).slice(0, limit).map((item) => ({ normalizedTag: item.normalizedTag, displayTag: item.displayTag, occurrences: item.officialOriginalOccurrences })),
    toolExtension: layer && layer !== "tool-extension" ? [] : layeredTags.filter((item) => item.toolExtensionOccurrences.length).slice(0, limit).map((item) => ({ normalizedTag: item.normalizedTag, displayTag: item.displayTag, occurrences: item.toolExtensionOccurrences })),
    registryHints: (catalog.registryHints.entries || []).filter((item) => match(normalizeTag(item.SectionName || item.ParentSectionName || ""))).slice(0, limit),
    spellingCandidates: (catalog.registryHints.suspiciousRegistryCandidates || []).filter((item) => match(normalizeTag(item.context?.SectionName || "")) || match(item.observed)).slice(0, limit),
  };
  const observationMatches = options("--observation").map((value) => {
    const observationFile = resolveObservationFile(value);
    const observation = readJson(observationFile);
    return { observationFile, pvf: observation.pvf, matches: (observation.tags || []).filter((item) => match(item.normalizedTag)) };
  });
  const matchCount = Object.values(result).reduce((sum, value) => sum + value.length, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "query", catalog: publicCatalogPath(file), catalogKind: catalog.phase, catalogSha256: sha256File(file), query: { tag: needle, exact, layer: layer || "all" }, generatedIndexIsFinalEvidence: false, notFoundProvesTagUnavailable: false, translationStatus: "separate-and-unset-unless-explicit", matchCount, result, observationMatches }, null, 2)}\n`);
}

function search() {
  const { file, catalog } = loadCatalog();
  const keyword = required("--keyword").toLowerCase();
  const limit = numberOption("--limit", 20, 200);
  const community = (catalog.community.rows || catalog.community.newRows).filter((item) => [item.section, item.comment, item.authors].filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword))).slice(0, limit);
  const layeredTags = catalog.layeredTags.tags.filter((item) => item.normalizedTag.includes(keyword) || [...item.officialOriginalOccurrences, ...item.toolExtensionOccurrences].some((occurrence) => String(occurrence.originalLine || item.displayTag || "").toLowerCase().includes(keyword))).slice(0, limit);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "search", catalog: publicCatalogPath(file), catalogKind: catalog.phase, generatedIndexIsFinalEvidence: false, matchCount: community.length + layeredTags.length, matches: { community, layeredTags } }, null, 2)}\n`);
}

function stats() {
  const { file, catalog } = loadCatalog();
  process.stdout.write(`${JSON.stringify({ ok: true, command: "stats", catalog: publicCatalogPath(file), catalogKind: catalog.phase, catalogSha256: sha256File(file), summary: catalog.summary, safety: catalog.safety }, null, 2)}\n`);
}

function exactTagRegex(normalizedTag) {
  const escaped = normalizedTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i");
}

async function observePvf() {
  const { file: catalogFile } = loadCatalog();
  const pvfPath = path.resolve(required("--pvf"));
  if (!fs.existsSync(pvfPath) || !fs.statSync(pvfPath).isFile()) throw new Error(`PVF does not exist: ${pvfPath}`);
  const tags = [...new Set(options("--tag").map(normalizeTag).filter(Boolean))];
  if (!tags.length) throw new Error("observe-pvf requires at least one --tag.");
  const samplesPerTag = numberOption("--samples", 3, 20);
  const label = option("--label", path.basename(path.dirname(pvfPath)) || path.basename(pvfPath));
  const outRoot = assertExternalOutput(workbenchRoot, option("--out", runtimePath(workbenchRoot, "tag-observations", safeId(label), timestamp())));
  const reportPath = path.join(outRoot, "PVF-TAG-OBSERVATIONS.json");
  if (fs.existsSync(reportPath) && !flag("--force")) throw new Error(`Tag observation already exists: ${reportPath}`);
  const pvfSha256 = sha256File(pvfPath);
  const native = loadPvfBackend().api;
  const session = await native.openSession(pvfPath, normalizeEncoding(option("--encoding", "Cn")));
  const sessionId = session.sessionId || session;
  const observedTags = [];
  try {
    for (const normalizedTag of tags) {
      const search = await native.searchFiles(sessionId, {
        keyword: `[${normalizedTag}]`,
        searchPath: "",
        isStartMatch: false,
        isUseLikeSearchPath: false,
        searchType: "SearchStrings",
        matchMode: "Like",
        convertToSimplifiedChinese: false,
      });
      const candidates = [...new Set((search.items || []).map((item) => toPosix(item.fileName)).filter(Boolean))];
      const samples = [];
      for (const pvfFile of candidates) {
        if (samples.length >= samplesPerTag) break;
        try {
          const read = await native.readFile(sessionId, pvfFile, {
            pvfEncoding: normalizeEncoding(option("--encoding", "Cn")),
            decompileScript: true,
            decompileBinaryAni: false,
            autoConvertStringLink: false,
            useCompatibleDecompiler: true,
            convertToSimplifiedChinese: false,
          });
          if (typeof read.textContent !== "string") continue;
          const lines = read.textContent.split(/\r?\n/);
          const lineIndex = lines.findIndex((line) => exactTagRegex(normalizedTag).test(line));
          if (lineIndex < 0) continue;
          samples.push({ pvfPath: pvfFile, line: lineIndex + 1, snippet: lines.slice(Math.max(0, lineIndex - 1), Math.min(lines.length, lineIndex + 3)).join("\n").slice(0, 2400) });
        } catch (error) {
          samples.push({ pvfPath: pvfFile, error: error.message });
        }
      }
      observedTags.push({ normalizedTag, displayTag: displayTag(normalizedTag), searchMatchedCount: Number(search.matchedCount || candidates.length), candidateFileCount: candidates.length, samples });
    }
  } finally {
    await native.closeSession(sessionId);
  }
  if (sha256File(pvfPath) !== pvfSha256) throw new Error("PVF changed during read-only tag observation.");
  const report = {
    schemaVersion: "1.0",
    phase: "pvf-tag-observation",
    generatedAt: new Date().toISOString(),
    catalog: catalogFile,
    catalogSha256: sha256File(catalogFile),
    pvf: { label, path: pvfPath, sha256: pvfSha256, encoding: normalizeEncoding(option("--encoding", "Cn")) },
    safety: { readOnly: true, pvfModified: false, generatedIndexIsFinalEvidence: false, zeroMatchProvesUnavailable: false },
    summary: { requestedTagCount: tags.length, observedTagCount: observedTags.filter((item) => item.samples.length > 0).length, totalSampleCount: observedTags.reduce((sum, item) => sum + item.samples.length, 0) },
    tags: observedTags,
  };
  writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "observe-pvf", reportPath, reportSha256: sha256File(reportPath), pvf: report.pvf, summary: report.summary }, null, 2)}\n`);
}

function createFixtureDatabase(file, rows) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(file);
  database.exec('create table pvf_comment (Id integer primary key, PvfCommentType integer, FileType integer, Section text not null, Comment text, Authors text, "Create" text, UpdateTime text)');
  const insert = database.prepare('insert into pvf_comment (Id,PvfCommentType,FileType,Section,Comment,Authors,"Create",UpdateTime) values (?,?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(row.id, 0, null, row.section, row.comment, "fixture", "1900", "1900");
  database.close();
}

function selfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-tag-knowledge-"));
  const checks = [];
  try {
    const builtin = readJson(path.join(workbenchRoot, "knowledge-pack", "indexes", "pvf-tag-facts.compact.json"));
    const builtinRows = builtin.community?.rows || [];
    const privateKeys = new Set(["id", "authors", "author", "create", "updateTime", "source", "sourcePath", "sourceId", "channel"]);
    checks.push({ id: "builtin-catalog", ok: builtin.phase === "builtin-pvf-tag-facts" && builtinRows.length >= 300 && builtinRows.length < 1000 && builtin.layeredTags.tags.length >= 2000 });
    checks.push({ id: "builtin-community-useful-summaries", ok:
      builtinRows.some((item) => item.normalizedSection === "no element" && /无元素/.test(item.comment)) &&
      builtinRows.some((item) => item.normalizedSection === "ignore defense" && /无视防御/.test(item.comment)) });
    checks.push({ id: "builtin-community-source-private", ok: builtinRows.every((item) =>
      Object.keys(item).every((key) => !privateKeys.has(key)) &&
      !/(?:mkjung\s+\d{6}|歌词|never\s+gonna|https?:\/\/|www\.|(?:qq|微信|群号|邮箱)\s*[:：]?\s*\d)/i.test(`${item.section || ""}\n${item.comment || ""}`)) });
    const oldFile = path.join(tempRoot, "old.db");
    const newFile = path.join(tempRoot, "new.db");
    const officialRoot = path.join(tempRoot, "official-original");
    const toolRoot = path.join(tempRoot, "tool-extension");
    fs.mkdirSync(officialRoot);
    fs.mkdirSync(toolRoot);
    createFixtureDatabase(oldFile, [{ id: 1, section: "alpha", comment: "A" }, { id: 2, section: "beta", comment: "B" }]);
    createFixtureDatabase(newFile, [{ id: 1, section: "alpha", comment: "标题：A" }, { id: 2, section: "beta", comment: "标题：Changed\n\nB extra" }, { id: 3, section: "gamma", comment: "C" }]);
    fs.writeFileSync(path.join(officialRoot, "sample.skl"), "[alpha] // official\n", "utf8");
    fs.writeFileSync(path.join(toolRoot, "sample.skl"), "[alpha]\n[beta]\n", "utf8");
    const observationDir = path.join(tempRoot, "observation");
    fs.mkdirSync(observationDir);
    const observationFile = path.join(observationDir, "PVF-TAG-OBSERVATIONS.json");
    fs.writeFileSync(observationFile, JSON.stringify({
      phase: "pvf-tag-observation",
      pvf: { sha256: "a".repeat(64) },
      safety: { readOnly: true, generatedIndexIsFinalEvidence: false },
      summary: { requestedTagCount: 1, observedTagCount: 1, totalSampleCount: 1 },
      tags: [{ normalizedTag: "cool time", displayTag: "[cool time]", searchMatchedCount: 1, samples: [{ pvfPath: "equipment/fixture.equ", line: 1 }] }],
    }) + "\n", "utf8");
    checks.push({ id: "observation-directory-resolves", ok: resolveObservationFile(observationDir) === observationFile });
    const observationQuery = observationQueryResult(observationDir, "cool time", true, 20);
    checks.push({
      id: "query-observation-report-alias",
      ok:
        observationQuery.summary.matchCount === 1 &&
        observationQuery.matches[0]?.samples?.[0]?.pvfPath === "equipment/fixture.equ" &&
        observationQuery.boundaries.generatedIndexIsFinalEvidence === false &&
        observationQuery.agentHandoff.additionalObservationQueryRequired === false,
    });
    const catalog = catalogFromSources(oldFile, newFile, officialRoot, toolRoot, null);
    checks.push({ id: "community-added", ok: catalog.summary.addedIdCount === 1 && catalog.community.diff.addedIds[0] === 3 });
    checks.push({ id: "community-format-only", ok: catalog.summary.formatOnlyChangedCount === 1 });
    checks.push({ id: "community-substantive", ok: catalog.summary.substantiveChangedCount === 1 });
    checks.push({ id: "official-original", ok: catalog.summary.officialOriginalTagCount === 1 });
    checks.push({ id: "tool-extension-separated", ok: catalog.summary.toolExtensionOnlyTagCount === 1 && catalog.safety.toolExtensionSeparatedFromOfficialOriginal === true });
    checks.push({ id: "translation-separated", ok: catalog.layeredTags.tags.every((item) => [...item.officialOriginalOccurrences, ...item.toolExtensionOccurrences].every((occurrence) => occurrence.translation === null)) });
  } finally {
    if (!pathInside(os.tmpdir(), tempRoot)) throw new Error(`Unsafe tag self-test path: ${tempRoot}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  const report = { schemaVersion: "1.0", phase: "tag-knowledge-self-test", summary: { ok: checks.every((item) => item.ok), checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length }, checks };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

async function main() {
  if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else if (command === "build") build();
  else if (command === "query") query();
  else if (command === "query-observation") queryObservation();
  else if (command === "search") search();
  else if (command === "stats") stats();
  else if (command === "observe-pvf") await observePvf();
  else if (command === "self-test") selfTest();
  else throw new Error(`Unknown tag-knowledge command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`ERROR ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
