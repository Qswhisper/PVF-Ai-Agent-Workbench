"use strict";

const fs = require("fs");
const path = require("path");
const { isPathInside, resolvePvfPathInside } = require("./fallback/path-safety.ts");

const REGISTRY_PATHS = {
  aicharacter: "aicharacter/aicharacter.lst",
  appendage: "appendage/appendage.lst",
  dungeon: "dungeon/dungeon.lst",
  equipment: "equipment/equipment.lst",
  map: "map/map.lst",
  monster: "monster/monster.lst",
  npc: "npc/npc.lst",
  passiveobject: "passiveobject/passiveobject.lst",
  stackable: "stackable/stackable.lst",
};

const TAGS_OF_INTEREST = [
  "minimum info",
  "additional character status",
  "character status rate",
  "attack damage rate",
  "add equipment status from level",
  "armor subtype",
  "quick skill",
  "skill",
  "skill data up",
  "quick item",
  "equipment",
  "think term",
  "destination change term",
  "keep distance with target",
  "warlike",
  "vision",
  "targeting bonus",
  "ai pattern",
  "key stream",
  "key cooltime",
  "no cooltime",
  "speech on situation",
  "move action",
  "waiting action",
  "sit action",
  "proc action",
  "etc action",
];

const BEHAVIOR_TAGS = new Set([
  "BEHAVIOR",
  "TRIGGER",
  "RANDOM SELECT",
  "CREATE PASSIVEOBJECT",
  "SUMMON MONSTER",
  "SUMMON MARK",
  "DO BEHAVIOR",
  "DO PROC BEHAVIOR",
  "CHECKUP OBJECT",
  "FOLLOWING TARGET",
  "HOLD POSITION",
  "SET SPEED",
  "SET ACTION",
  "SET FRAME",
  "SAY SPEECH",
  "FLASH SCREEN",
  "WARNING MARK",
  "CUSTOM",
  "MOTION",
  "OBJECT",
]);

const MINIMUM_INFO_FIELDS = [
  { key: "baseJob" },
  { key: "firstGrowType" },
  { key: "secondGrowType" },
  { key: "isVisibleGrowTypeAvatar" },
  { key: "level" },
  { key: "userState" },
  { key: "userType" },
  { key: "pvpRank" },
  { key: "guild" },
  { key: "donkey" },
  { key: "creatureIndex" },
  { key: "isCreatureEnervated" },
  { key: "isPremiumPCRoom" },
  { key: "blackListDegree" },
];

const TARGETING_BONUS_DOCUMENTED_BASE_NUMERIC_COUNT = 21;
const APC_EVIDENCE_REGISTRY_RELATIVE = path.join("pvf-evidence-registry", "apc", "apc-field-evidence.registry.json");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printUsage() {
  console.log(`Usage:
  node tools/pvf-bridge/analyze-apc.js --extract-dir=DIR [--out=apc-analysis.json] [--md-out=apc-analysis.md]

Rules:
  --extract-dir is required and must point to a local dungeon/APC extract inside the current workspace.
`);
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

function normalizeKey(value) {
  return normalizePvfPath(value).toLowerCase();
}

function normalizeSectionName(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveInsideWorkspace(targetPath, label) {
  const resolved = path.resolve(targetPath || "");
  const cwd = process.cwd();
  if (!targetPath || !isPathInside(cwd, resolved)) {
    throw new Error(`Refusing ${label || "path"} outside workspace: ${resolved}`);
  }
  return resolved;
}

function registryPathForSection(section) {
  const normalized = normalizePvfPath(section);
  if (/\.lst$/i.test(normalized)) {
    return normalized;
  }
  const hit = REGISTRY_PATHS[normalized.toLowerCase()];
  if (!hit) {
    return normalized;
  }
  return hit;
}

function registryBaseDir(registryPath) {
  return path.posix.dirname(normalizePvfPath(registryPath));
}

function resolveRegisteredPath(registryPath, rawPath) {
  const raw = normalizePvfPath(rawPath);
  const baseDir = registryBaseDir(registryPath);
  if (!baseDir || baseDir === ".") {
    return raw;
  }
  return normalizeKey(raw).startsWith(`${normalizeKey(baseDir)}/`) ? raw : normalizePvfPath(`${baseDir}/${raw}`);
}

function localPath(extractDir, pvfPath) {
  return resolvePvfPathInside(extractDir, pvfPath, "Extracted PVF entry path");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function stripPvfHeader(text) {
  return String(text || "").replace(/^#PVF_File\s*/i, "");
}

function firstNameFromText(text) {
  const match = String(text || "").match(/\[name\]\s*`([^`]*)`/i);
  return match ? match[1] : "";
}

function firstNonEmptyLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function previewText(text, limit = 140) {
  const line = firstNonEmptyLine(text);
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

function findExistingFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return "";
}

function classifyEvidenceVisibility(source, trustPolicy) {
  if (!source) {
    return "hidden";
  }
  const trustTier = String(source.trustTier || "");
  if (!trustTier) {
    return "hidden";
  }
  if ((trustPolicy.defaultVisibleTrustTiers || []).includes(trustTier)) {
    return "visible";
  }
  if ((trustPolicy.optionalTrustTiers || []).includes(trustTier)) {
    return "optional";
  }
  return "hidden";
}

function summarizeEvidenceSource(source, trustPolicy) {
  return {
    kind: source.kind || "",
    label: source.label || "",
    trustTier: source.trustTier || null,
    authorsRaw: source.authorsRaw || null,
    updatedAt: source.updatedAt || null,
    preview: previewText(source.commentText || source.label || ""),
    visibility: classifyEvidenceVisibility(source, trustPolicy),
  };
}

function loadApcEvidenceRegistry() {
  const explicit = argValue("evidence-registry", "");
  const candidates = explicit
    ? [explicit]
    : [
        path.join(process.cwd(), APC_EVIDENCE_REGISTRY_RELATIVE),
        path.join(__dirname, "..", "..", APC_EVIDENCE_REGISTRY_RELATIVE),
      ];
  const registryPath = findExistingFile(candidates);
  if (!registryPath) {
    return {
      loaded: false,
      registryPath: "",
      registryId: "",
      schemaVersion: "",
      trustPolicy: {
        defaultVisibleTrustTiers: [],
        optionalTrustTiers: [],
        defaultHiddenTrustTiers: [],
        trustedAuthorAliases: [],
      },
      entryCount: 0,
      visibleEntryCount: 0,
      optionalEntryCount: 0,
      hiddenEntryCount: 0,
      byId: {},
      bySection: {},
      byAnalyzerPath: {},
    };
  }

  const raw = JSON.parse(readText(registryPath));
  const trustPolicy = raw.trustPolicy || {
    defaultVisibleTrustTiers: [],
    optionalTrustTiers: [],
    defaultHiddenTrustTiers: [],
    trustedAuthorAliases: [],
  };
  const byId = {};
  const bySection = {};
  const byAnalyzerPath = {};
  let visibleEntryCount = 0;
  let optionalEntryCount = 0;
  let hiddenEntryCount = 0;

  for (const entry of raw.entries || []) {
    const visibleSources = [];
    const optionalSources = [];
    const hiddenSources = [];
    for (const source of entry.evidence || []) {
      const summary = summarizeEvidenceSource(source, trustPolicy);
      if (summary.visibility === "visible") {
        visibleSources.push(summary);
      } else if (summary.visibility === "optional") {
        optionalSources.push(summary);
      } else {
        hiddenSources.push(summary);
      }
    }
    const summary = {
      id: entry.id,
      section: entry.subject && entry.subject.pvfSection ? entry.subject.pvfSection : "",
      canonicalField: entry.subject && entry.subject.canonicalField ? entry.subject.canonicalField : null,
      analyzerPaths: entry.subject && Array.isArray(entry.subject.analyzerPaths) ? entry.subject.analyzerPaths : [],
      status: entry.status || "",
      evidenceTier: entry.evidenceTier || "",
      claimKind: entry.claim && entry.claim.kind ? entry.claim.kind : "",
      notes: Array.isArray(entry.notes) ? entry.notes : [],
      visibleSources,
      optionalSources,
      hiddenSourceCount: hiddenSources.length,
    };
    byId[summary.id] = summary;
    bySection[normalizeSectionName(summary.section)] = summary;
    for (const analyzerPath of summary.analyzerPaths) {
      byAnalyzerPath[analyzerPath] = summary.id;
    }
    if (visibleSources.length) {
      visibleEntryCount += 1;
    }
    if (optionalSources.length) {
      optionalEntryCount += 1;
    }
    if (hiddenSources.length) {
      hiddenEntryCount += 1;
    }
  }

  return {
    loaded: true,
    registryPath,
    registryId: raw.registryId || "",
    schemaVersion: raw.schemaVersion || "",
    trustPolicy,
    entryCount: Object.keys(byId).length,
    visibleEntryCount,
    optionalEntryCount,
    hiddenEntryCount,
    byId,
    bySection,
    byAnalyzerPath,
  };
}

function buildApcEvidenceRefs(apc, evidenceRegistry) {
  if (!evidenceRegistry || !evidenceRegistry.loaded) {
    return {
      bySection: {},
      byAnalyzerPath: {},
    };
  }
  const bySection = {};
  const byAnalyzerPath = {};

  for (const [sectionKey, summary] of Object.entries(evidenceRegistry.bySection)) {
    const sectionName = summary.section;
    const tagPresent = apc.tagsPresent.includes(sectionName);
    const derivedSection =
      sectionName === "overhead gauge type" ||
      sectionName === "minimum info" ||
      sectionName === "attack damage rate" ||
      sectionName === "add equipment status from level" ||
      sectionName === "think term" ||
      sectionName === "destination change term" ||
      sectionName === "keep distance with target" ||
      sectionName === "warlike" ||
      sectionName === "vision" ||
      sectionName === "targeting bonus" ||
      sectionName === "no cooltime";
    if (tagPresent || derivedSection) {
      bySection[sectionName] = summary.id;
    }
  }

  for (const analyzerPath of Object.keys(evidenceRegistry.byAnalyzerPath)) {
    byAnalyzerPath[analyzerPath] = evidenceRegistry.byAnalyzerPath[analyzerPath];
  }

  return {
    bySection,
    byAnalyzerPath,
  };
}

function compactVisibleSourceSummary(source) {
  const authorPart = source.authorsRaw ? `[${source.authorsRaw}]` : "";
  const trustPart = source.trustTier ? `:${source.trustTier}` : "";
  return {
    kind: source.kind || "",
    label: source.label || "",
    trustTier: source.trustTier || null,
    authorsRaw: source.authorsRaw || null,
    updatedAt: source.updatedAt || null,
    preview: source.preview || "",
    summaryLabel: `${source.kind || "source"}${authorPart}${trustPart}`,
  };
}

function buildFieldEvidenceVisibleSummary(evidenceRegistry) {
  if (!evidenceRegistry || !evidenceRegistry.loaded) {
    return [];
  }
  return Object.values(evidenceRegistry.byId)
    .map((entry) => {
      const visibleSources = (entry.visibleSources || []).map(compactVisibleSourceSummary);
      const preferredPreview =
        visibleSources.find((source) => source.kind === "pvfutility_comment" && source.preview)?.preview ||
        visibleSources.find((source) => source.preview)?.preview ||
        firstNonEmptyLine((entry.notes || [])[0] || "");
      return {
        id: entry.id,
        section: entry.section,
        canonicalField: entry.canonicalField,
        analyzerPaths: entry.analyzerPaths || [],
        status: entry.status,
        evidenceTier: entry.evidenceTier,
        claimKind: entry.claimKind,
        visibleSources,
        optionalSourceCount: (entry.optionalSources || []).length,
        hiddenSourceCount: entry.hiddenSourceCount || 0,
        preview: preferredPreview || "",
      };
    })
    .sort((a, b) => {
      const sectionCompare = String(a.section || "").localeCompare(String(b.section || ""));
      if (sectionCompare) {
        return sectionCompare;
      }
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
}

function tokenize(text) {
  const tokens = [];
  const re = /`([^`]*)`|[-+]?(?:\d+\.\d+|\d+|\.\d+)(?:e[-+]?\d+)?/gi;
  let match;
  while ((match = re.exec(String(text || "")))) {
    if (match[1] !== undefined) {
      tokens.push({ type: "string", value: match[1] });
    } else {
      tokens.push({ type: "number", value: Number(match[0]) });
    }
  }
  return tokens;
}

function numbers(text) {
  return tokenize(text)
    .filter((item) => item.type === "number")
    .map((item) => item.value);
}

function strings(text) {
  return tokenize(text)
    .filter((item) => item.type === "string")
    .map((item) => item.value);
}

function parseTaggedBlocks(text) {
  const blocks = new Map();
  let current = null;
  for (const line of stripPvfHeader(text).split(/\r?\n/)) {
    const tag = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (tag) {
      const name = tag[1].trim();
      if (name.startsWith("/")) {
        current = null;
        continue;
      }
      current = name;
      const key = name.toLowerCase();
      if (!blocks.has(key)) {
        blocks.set(key, []);
      }
      blocks.get(key).push([]);
      continue;
    }
    if (current) {
      const key = current.toLowerCase();
      const list = blocks.get(key);
      list[list.length - 1].push(line);
    }
  }
  return blocks;
}

function blockText(blocks, tag) {
  const list = blocks.get(tag.toLowerCase());
  return list && list[0] ? list[0].join("\n").trim() : "";
}

function blockTexts(blocks, tag) {
  const list = blocks.get(tag.toLowerCase()) || [];
  return list.map((lines) => lines.join("\n").trim()).filter(Boolean);
}

function parseImportList(extractDir) {
  const listPath = fs.existsSync(path.join(extractDir, "list.codex.txt"))
    ? path.join(extractDir, "list.codex.txt")
    : path.join(extractDir, "list.txt");
  const registries = new Map();
  if (!fs.existsSync(listPath)) {
    return registries;
  }

  let current = null;
  for (const line of readText(listPath).split(/\r?\n/)) {
    const header = line.match(/^\s*(.+?)\s*(?:needs list|\u9700\u8981\u6dfb\u52a0\u7684list)\s*$/i);
    if (header) {
      current = registryPathForSection(header[1].trim());
      if (!registries.has(current)) {
        registries.set(current, []);
      }
      continue;
    }
    const entry = line.match(/^\s*(\d+)\s+`([^`]+)`/);
    if (!entry || !current) {
      continue;
    }
    const rawPath = normalizePvfPath(entry[2]);
    registries.get(current).push({
      id: Number(entry[1]),
      rawPath,
      pvfPath: resolveRegisteredPath(current, rawPath),
    });
  }
  return registries;
}

function addNameMetadata(extractDir, entry) {
  const filePath = localPath(extractDir, entry.pvfPath);
  if (!fs.existsSync(filePath)) {
    return { ...entry, name: "", exists: false };
  }
  return { ...entry, name: firstNameFromText(readText(filePath)), exists: true };
}

function buildIndex(extractDir, registries) {
  const byRegistryAndId = new Map();
  const byId = new Map();

  for (const [registryPath, entries] of registries.entries()) {
    const registryMap = new Map();
    for (const entry of entries) {
      const enriched = addNameMetadata(extractDir, entry);
      registryMap.set(entry.id, enriched);
      if (!byId.has(entry.id)) {
        byId.set(entry.id, []);
      }
      byId.get(entry.id).push({ registryPath, ...enriched });
    }
    byRegistryAndId.set(registryPath, registryMap);
  }

  return { byRegistryAndId, byId };
}

function resolveId(index, preferredRegistries, id) {
  for (const registryPath of preferredRegistries) {
    const hit = index.byRegistryAndId.get(registryPath)?.get(id);
    if (hit) {
      return { registryPath, ...hit };
    }
  }
  const fallback = index.byId.get(id);
  return fallback && fallback.length ? fallback[0] : { id, registryPath: "", rawPath: "", pvfPath: "", name: "", exists: false };
}

function resolveSkill(index, id) {
  const preferred = [
    "skill/swordmanskill.lst",
    "skill/fighterskill.lst",
    "skill/gunnerskill.lst",
    "skill/mageskill.lst",
    "skill/priestskill.lst",
    "skill/atgunnerskill.lst",
    "skill/thiefskill.lst",
    "skill/atmageskill.lst",
  ];
  return resolveId(index, preferred, id);
}

function pairNumbers(values) {
  const out = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    out.push([values[i], values[i + 1]]);
  }
  return out;
}

function tripleNumbers(values) {
  const out = [];
  for (let i = 0; i + 2 < values.length; i += 3) {
    out.push([values[i], values[i + 1], values[i + 2]]);
  }
  return out;
}

function parseKeyStreams(text) {
  const values = strings(text);
  const out = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    out.push({ action: values[i], file: values[i + 1] });
  }
  return out;
}

function parseKeyCooltimes(text) {
  const values = tokenize(text);
  const out = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    if (values[i].type === "string" && values[i + 1].type === "number") {
      out.push({ action: values[i].value, cooltimeMs: values[i + 1].value });
    }
  }
  return out;
}

function parseMinimumInfo(text) {
  const rawTokens = tokenize(text);
  const rawStrings = rawTokens.filter((item) => item.type === "string").map((item) => item.value);
  const rawNumbers = rawTokens.filter((item) => item.type === "number").map((item) => item.value);
  const fields = {};
  for (let i = 0; i < MINIMUM_INFO_FIELDS.length; i += 1) {
    fields[MINIMUM_INFO_FIELDS[i].key] = rawNumbers[i] ?? null;
  }
  return {
    rawTokens: rawTokens.map((item) => item.value),
    rawStrings,
    rawNumbers,
    fieldOrder: MINIMUM_INFO_FIELDS.map((field) => field.key),
    fields,
    name: rawStrings[0] || "",
    creatureName: rawStrings[1] || "",
  };
}

function normalizeBracketTag(tag) {
  return String(tag || "").replace(/^\[|\]$/g, "").trim();
}

function parseTargetingBonus(text) {
  const rawTokens = tokenize(text);
  const firstTaggedIndex = rawTokens.findIndex((item) => item.type === "string");
  const baseTokens = firstTaggedIndex === -1 ? rawTokens : rawTokens.slice(0, firstTaggedIndex);
  const taggedTokens = firstTaggedIndex === -1 ? [] : rawTokens.slice(firstTaggedIndex);
  const baseValues = baseTokens.filter((item) => item.type === "number").map((item) => item.value);
  const taggedEntries = [];
  const orphanValues = [];
  let current = null;

  for (const token of taggedTokens) {
    if (token.type === "string") {
      current = {
        rawTag: token.value,
        tag: normalizeBracketTag(token.value),
        values: [],
      };
      taggedEntries.push(current);
      continue;
    }
    if (current) {
      current.values.push(token.value);
      continue;
    }
    orphanValues.push(token.value);
  }

  return {
    rawTokens: rawTokens.map((item) => item.value),
    baseValues,
    baseNumericCount: baseValues.length,
    documentedBaseNumericCount: TARGETING_BONUS_DOCUMENTED_BASE_NUMERIC_COUNT,
    matchesDocumentedBaseCount: baseValues.length === TARGETING_BONUS_DOCUMENTED_BASE_NUMERIC_COUNT,
    shape: taggedEntries.length ? "numeric-prefix-plus-tagged-values" : "flat-numeric-array",
    taggedEntries,
    tagSequence: taggedEntries.map((entry) => entry.tag),
    orphanValues,
  };
}

function collectBehavior(text, blocks) {
  const counts = {};
  const tagRe = /^\s*\[([^\]]+)\]\s*$/gm;
  let match;
  while ((match = tagRe.exec(text))) {
    const tag = match[1].trim();
    if (BEHAVIOR_TAGS.has(tag.toUpperCase())) {
      counts[tag.toUpperCase()] = (counts[tag.toUpperCase()] || 0) + 1;
    }
  }

  const behaviorBlocks = {};
  for (const tag of BEHAVIOR_TAGS) {
    const texts = blockTexts(blocks, tag);
    if (texts.length) {
      behaviorBlocks[tag] = texts.map((value) => ({
        strings: strings(value),
        numbers: numbers(value).slice(0, 40),
        rawLineCount: value.split(/\r?\n/).filter(Boolean).length,
      }));
    }
  }

  return { counts, blocks: behaviorBlocks };
}

function collectFileRefs(text) {
  const refs = strings(text)
    .filter((value) => /\.(ai|key|act|ani|atk|ptl|obj|mob|aic|skl|equ|apd|nut)$/i.test(value))
    .map(normalizePvfPath);
  return Array.from(new Set(refs)).sort((a, b) => a.localeCompare(b));
}

function analyzeAiFile(filePath) {
  const text = readText(filePath);
  const blocks = parseTaggedBlocks(text);
  return {
    file: normalizePvfPath(path.basename(filePath)),
    bytes: fs.statSync(filePath).size,
    tagCounts: Object.fromEntries(
      Array.from(blocks.keys())
        .sort((a, b) => a.localeCompare(b))
        .map((tag) => [tag, blocks.get(tag).length])
    ),
    returns: strings(blockTexts(blocks, "return str").join("\n")),
    checkKeyCooltime: strings(blockTexts(blocks, "check key cooltime").join("\n")),
    imports: strings(blockTexts(blocks, "import ai").join("\n")),
    voidCalls: strings(blockTexts(blocks, "void").join("\n")),
  };
}

function analyzeKeyFile(filePath) {
  const text = readText(filePath);
  const blocks = parseTaggedBlocks(text);
  const inputBlocks = blockTexts(blocks, "input");
  const inputs = inputBlocks.map((value) => tokenize(value).map((item) => item.value));
  const skillCommands = [];
  for (const input of inputs) {
    for (const value of input) {
      if (typeof value === "string" && /^skill:/i.test(value)) {
        skillCommands.push(value);
      }
    }
  }
  return {
    file: normalizePvfPath(path.basename(filePath)),
    bytes: fs.statSync(filePath).size,
    inputCount: inputBlocks.length,
    skillCommands,
    inputs,
  };
}

function analyzeLocalAiAndKeyFiles(apcFilePath) {
  const baseDir = path.dirname(apcFilePath);
  const aiDir = path.join(baseDir, "ai");
  const keyDir = path.join(baseDir, "key");
  const aiFiles = [];
  const keyFiles = [];

  if (fs.existsSync(aiDir)) {
    for (const entry of fs.readdirSync(aiDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.ai$/i.test(entry.name)) {
        aiFiles.push(analyzeAiFile(path.join(aiDir, entry.name)));
      }
    }
  }

  if (fs.existsSync(keyDir)) {
    for (const entry of fs.readdirSync(keyDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.key$/i.test(entry.name)) {
        keyFiles.push(analyzeKeyFile(path.join(keyDir, entry.name)));
      }
    }
  }

  aiFiles.sort((a, b) => a.file.localeCompare(b.file));
  keyFiles.sort((a, b) => a.file.localeCompare(b.file));
  return { aiFiles, keyFiles };
}

function analyzeApcFile(extractDir, index, filePath) {
  const rel = normalizePvfPath(path.relative(extractDir, filePath));
  const text = readText(filePath);
  const blocks = parseTaggedBlocks(text);
  const minimum = blockText(blocks, "minimum info");
  const minimumInfo = parseMinimumInfo(minimum);
  const minimumStrings = minimumInfo.rawStrings;
  const minimumNumbers = minimumInfo.rawNumbers;
  const targetingBonusStructured = parseTargetingBonus(blockText(blocks, "targeting bonus"));
  const overheadGaugeType = numbers(blockText(blocks, "overhead gauge type"))[0] ?? null;

  const skillValues = numbers(blockText(blocks, "skill"));
  const quickSkillValues = numbers(blockText(blocks, "quick skill"));
  const equipmentValues = numbers(blockText(blocks, "equipment"));
  const quickItemValues = numbers(blockText(blocks, "quick item"));

  const skills = pairNumbers(skillValues).map(([id, level]) => ({
    id,
    level,
    ...resolveSkill(index, id),
  }));
  const quickSkills = pairNumbers(quickSkillValues).map(([id, level]) => ({
    id,
    level,
    ...resolveSkill(index, id),
  }));
  const equipment = tripleNumbers(equipmentValues).map(([id, equipParam, optionParam]) => ({
    id,
    equipParam,
    optionParam,
    ...resolveId(index, ["equipment/equipment.lst"], id),
  }));
  const quickItems = pairNumbers(quickItemValues).map(([id, slotValue]) => ({
    id,
    slotValue,
    ...resolveId(index, ["stackable/stackable.lst"], id),
  }));

  const actionTags = ["move action", "waiting action", "sit action", "proc action", "etc action"];
  const actions = {};
  for (const tag of actionTags) {
    const refs = strings(blockTexts(blocks, tag).join("\n")).map(normalizePvfPath);
    if (refs.length) {
      actions[tag] = refs;
    }
  }

  const behavior = collectBehavior(text, blocks);
  const tagsPresent = Array.from(blocks.keys()).sort((a, b) => a.localeCompare(b));
  const fileRefs = collectFileRefs(text);
  const aiAndKeyFiles = analyzeLocalAiAndKeyFiles(filePath);

  return {
    pvfPath: rel,
    name: minimumInfo.name || firstNameFromText(text),
    minimumInfoNumbers: minimumNumbers,
    minimumInfoStrings: minimumStrings,
    minimumInfo,
    base: {
      level: minimumInfo.fields.level,
      baseJob: minimumInfo.fields.baseJob,
      firstGrowType: minimumInfo.fields.firstGrowType,
      secondGrowType: minimumInfo.fields.secondGrowType,
      levelLike: minimumNumbers[0] ?? null,
      jobLike: minimumNumbers[1] ?? null,
      levelCapLike: minimumNumbers[4] ?? null,
      creature: minimumInfo.creatureName || "",
    },
    presentation: {
      overheadGaugeType,
      overheadGaugeEnabled: overheadGaugeType === 1,
    },
    status: {
      additionalCharacterStatus: numbers(blockText(blocks, "additional character status")),
      characterStatusRate: numbers(blockText(blocks, "character status rate")),
      attackDamageRate: numbers(blockText(blocks, "attack damage rate"))[0] ?? null,
      addEquipmentStatusFromLevel: numbers(blockText(blocks, "add equipment status from level"))[0] ?? null,
      armorSubtype: numbers(blockText(blocks, "armor subtype"))[0] ?? null,
    },
    combatTuning: {
      thinkTermMs: numbers(blockText(blocks, "think term"))[0] ?? null,
      destinationChangeTermMs: numbers(blockText(blocks, "destination change term"))[0] ?? null,
      keepDistanceWithTarget: numbers(blockText(blocks, "keep distance with target"))[0] ?? null,
      warlike: numbers(blockText(blocks, "warlike"))[0] ?? null,
      vision: numbers(blockText(blocks, "vision"))[0] ?? null,
      targetingBonus: targetingBonusStructured.rawTokens,
      targetingBonusStructured,
    },
    skills,
    quickSkills,
    skillDataUp: blockTexts(blocks, "skill data up").map((value) => tokenize(value).map((item) => item.value)),
    equipment,
    quickItems,
    aiPattern: strings(blockText(blocks, "ai pattern")),
    keyStream: parseKeyStreams(blockText(blocks, "key stream")),
    keyCooltime: parseKeyCooltimes(blockText(blocks, "key cooltime")),
    noCooltimeRaw: blockText(blocks, "no cooltime"),
    actions,
    aiFiles: aiAndKeyFiles.aiFiles,
    keyFiles: aiAndKeyFiles.keyFiles,
    behavior,
    fileRefs,
    tagsPresent,
  };
}

function findApcFiles(extractDir) {
  const root = path.join(extractDir, "aicharacter");
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.aic$/i.test(entry.name)) {
        out.push(fullPath);
      }
    }
  }
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function summarize(all) {
  const uniqueSkillIds = new Set();
  const uniqueEquipmentIds = new Set();
  const uniqueQuickItems = new Set();
  const aiPatterns = new Map();
  const behaviorCounts = {};
  const tagCounts = {};
  const aiReturnUsage = new Map();
  const aiImportUsage = new Map();
  const aiVoidCallUsage = new Map();
  const keySkillCommandUsage = new Map();

  for (const apc of all) {
    for (const item of apc.skills) uniqueSkillIds.add(item.id);
    for (const item of apc.quickSkills) uniqueSkillIds.add(item.id);
    for (const item of apc.equipment) uniqueEquipmentIds.add(item.id);
    for (const item of apc.quickItems) uniqueQuickItems.add(item.id);
    for (const item of apc.aiPattern) aiPatterns.set(item, (aiPatterns.get(item) || 0) + 1);
    for (const [tag, count] of Object.entries(apc.behavior.counts)) {
      behaviorCounts[tag] = (behaviorCounts[tag] || 0) + count;
    }
    for (const tag of apc.tagsPresent) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    for (const aiFile of apc.aiFiles) {
      for (const value of aiFile.returns) aiReturnUsage.set(value, (aiReturnUsage.get(value) || 0) + 1);
      for (const value of aiFile.imports) aiImportUsage.set(value, (aiImportUsage.get(value) || 0) + 1);
      for (const value of aiFile.voidCalls) aiVoidCallUsage.set(value, (aiVoidCallUsage.get(value) || 0) + 1);
    }
    for (const keyFile of apc.keyFiles) {
      for (const value of keyFile.skillCommands) keySkillCommandUsage.set(value, (keySkillCommandUsage.get(value) || 0) + 1);
    }
  }

  return {
    apcCount: all.length,
    uniqueSkillIdCount: uniqueSkillIds.size,
    uniqueEquipmentIdCount: uniqueEquipmentIds.size,
    uniqueQuickItemIdCount: uniqueQuickItems.size,
    aiFileCount: all.reduce((sum, item) => sum + item.aiFiles.length, 0),
    keyFileCount: all.reduce((sum, item) => sum + item.keyFiles.length, 0),
    aiPatternUsage: Object.fromEntries([...aiPatterns].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    aiReturnUsage: Object.fromEntries([...aiReturnUsage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    aiImportUsage: Object.fromEntries([...aiImportUsage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    aiVoidCallUsage: Object.fromEntries([...aiVoidCallUsage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    keySkillCommandUsage: Object.fromEntries([...keySkillCommandUsage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    behaviorTagCounts: Object.fromEntries(Object.entries(behaviorCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    tagCounts: Object.fromEntries(Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

function escMd(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function writeMarkdown(report, outPath) {
  const lines = [];
  lines.push("# APC Analysis");
  lines.push("");
  lines.push(`Extract: \`${report.extractDir}\``);
  lines.push(`APC count: ${report.summary.apcCount}`);
  lines.push(`Unique skills: ${report.summary.uniqueSkillIdCount}`);
  lines.push(`Unique equipment: ${report.summary.uniqueEquipmentIdCount}`);
  lines.push(`Unique quick items: ${report.summary.uniqueQuickItemIdCount}`);
  lines.push(`AI files: ${report.summary.aiFileCount}`);
  lines.push(`Key files: ${report.summary.keyFileCount}`);
  lines.push("");
  lines.push("## Evidence Registry");
  lines.push("");
  if (!report.fieldEvidenceRegistry || !report.fieldEvidenceRegistry.loaded) {
    lines.push("- No APC evidence registry loaded.");
  } else {
    lines.push(`- Registry: \`${report.fieldEvidenceRegistry.registryId}\``);
    lines.push(`- Schema version: \`${report.fieldEvidenceRegistry.schemaVersion}\``);
    lines.push(`- Registry path: \`${escMd(report.fieldEvidenceRegistry.registryPathRelative || report.fieldEvidenceRegistry.registryPath)}\``);
    lines.push(`- Entry count: ${report.fieldEvidenceRegistry.entryCount}`);
    lines.push(
      `- Default visible trust tiers: ${escMd((report.fieldEvidenceRegistry.trustPolicy.defaultVisibleTrustTiers || []).join(", ")) || "(none)"}`
    );
    lines.push(
      `- Optional trust tiers: ${escMd((report.fieldEvidenceRegistry.trustPolicy.optionalTrustTiers || []).join(", ")) || "(none)"}`
    );
    lines.push(
      `- Hidden trust tiers: ${escMd((report.fieldEvidenceRegistry.trustPolicy.defaultHiddenTrustTiers || []).join(", ")) || "(none)"}`
    );
    const unresolved = Object.values(report.fieldEvidenceRegistry.byId).filter(
      (item) => item.status === "unresolved" || item.status === "partial"
    );
    if (unresolved.length) {
      lines.push("- Partial or unresolved sections:");
      for (const item of unresolved) {
        lines.push(`  - \`${item.section}\`: ${item.status} / ${item.evidenceTier}`);
      }
    }
  }
  lines.push("");
  lines.push("## Visible Field Evidence");
  lines.push("");
  if (!report.fieldEvidenceVisibleSummary || !report.fieldEvidenceVisibleSummary.length) {
    lines.push("- No visible evidence summary available.");
  } else {
    lines.push("| Section | Field | Status | Tier | Visible Sources | Preview |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const entry of report.fieldEvidenceVisibleSummary) {
      const sourceLabels = entry.visibleSources.map((source) => source.summaryLabel).join(", ");
      lines.push(
        `| ${escMd(entry.section)} | ${escMd(entry.canonicalField || "")} | ${escMd(entry.status)} | ${escMd(
          entry.evidenceTier
        )} | ${escMd(sourceLabels)} | ${escMd(entry.preview)} |`
      );
    }
  }
  lines.push("");
  lines.push("## APC Overview");
  lines.push("");
  lines.push("| APC | Level | AttackRate | Warlike | Vision | TargetingBase | TargetingTags | Skills | Equipment | AI Files | Key Files | AI Returns | Key Actions | Behavior Tags |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
  for (const apc of report.apcs) {
    const behaviorTags = Object.entries(apc.behavior.counts)
      .map(([tag, count]) => `${tag}:${count}`)
      .join(", ");
    const aiReturns = Array.from(new Set(apc.aiFiles.flatMap((item) => item.returns))).join(", ");
    const targetingTags = apc.combatTuning.targetingBonusStructured.tagSequence.join(", ");
    lines.push(
      `| ${escMd(apc.name || apc.pvfPath)} | ${apc.minimumInfo.fields.level ?? ""} | ${apc.status.attackDamageRate ?? ""} | ${
        apc.combatTuning.warlike ?? ""
      } | ${apc.combatTuning.vision ?? ""} | ${apc.combatTuning.targetingBonusStructured.baseNumericCount} | ${escMd(
        targetingTags
      )} | ${apc.skills.length} | ${apc.equipment.length} | ${escMd(
        apc.aiFiles.length
      )} | ${escMd(apc.keyFiles.length)} | ${escMd(aiReturns)} | ${escMd(apc.keyStream.map((item) => item.action).join(", "))} | ${escMd(
        behaviorTags
      )} |`
    );
  }
  lines.push("");
  lines.push("## Editing Map");
  lines.push("");
  lines.push("- Identity and coarse role: `[minimum info]`; JSON now includes named slots such as `baseJob`, `firstGrowType`, `secondGrowType`, `level`, `userState`, `pvpRank`, and creature metadata.");
  lines.push("- Stats and scaling: `[additional character status]`, `[character status rate]`, `[attack damage rate]`, `[armor subtype]`.");
  lines.push("- Active kit: `[skill]`, `[quick skill]`, `[skill data up]`, `[key stream]`, `[key cooltime]`, `[no cooltime]`.");
  lines.push("- Build and visuals: `[equipment]`, `[overhead gauge type]`; JSON exposes `overheadGaugeType`, and `overheadGaugeEnabled` becomes `true` when the value is `1`.");
  lines.push("- Targeting and aggression: `[think term]`, `[destination change term]`, `[keep distance with target]`, `[warlike]`, `[vision]`, `[targeting bonus]`; targeting bonus is now emitted both as raw tokens and as a structured `baseValues + taggedEntries` model.");
  lines.push("- AI behavior: `[ai pattern]`, action `.ai` files, key `.key` files, and embedded behavior tags such as `[TRIGGER]`, `[CREATE PASSIVEOBJECT]`, `[SUMMON MONSTER]`.");
  lines.push("- AI decision files: `ai/*.ai`, especially `[return str]`, `[check key cooltime]`, `[import ai]`, and `[void]` calls.");
  lines.push("- Key scripts: `key/*.key`, especially `[input]` blocks and `skill:id` commands.");
  lines.push("");
  lines.push("## AI Pattern Usage");
  lines.push("");
  for (const [name, count] of Object.entries(report.summary.aiPatternUsage)) {
    lines.push(`- \`${name}\`: ${count}`);
  }
  lines.push("");
  lines.push("## AI Return Usage");
  lines.push("");
  for (const [name, count] of Object.entries(report.summary.aiReturnUsage)) {
    lines.push(`- \`${name}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Key Skill Commands");
  lines.push("");
  for (const [name, count] of Object.entries(report.summary.keySkillCommandUsage)) {
    lines.push(`- \`${name}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Behavior Tag Counts");
  lines.push("");
  const behaviorEntries = Object.entries(report.summary.behaviorTagCounts);
  if (!behaviorEntries.length) {
    lines.push("- No embedded advanced behavior tags found in these `.aic` files.");
  } else {
    for (const [name, count] of behaviorEntries) {
      lines.push(`- \`${name}\`: ${count}`);
    }
  }
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  if (hasFlag("help") || hasFlag("-help") || hasFlag("?")) {
    printUsage();
    return;
  }
  const rawExtractDir = argValue("extract-dir", "");
  if (!rawExtractDir) {
    throw new Error("Use --extract-dir=DIR. Refusing to analyze the current workspace root implicitly.");
  }
  const extractDir = resolveInsideWorkspace(rawExtractDir, "extract-dir");
  const out = argValue("out", path.join(extractDir, "_meta", "apc-analysis.json"));
  const mdOut = argValue("md-out", path.join(extractDir, "_meta", "apc-analysis.md"));
  const resolvedOut = resolveInsideWorkspace(out, "out");
  const resolvedMdOut = resolveInsideWorkspace(mdOut, "md-out");

  const registries = parseImportList(extractDir);
  const index = buildIndex(extractDir, registries);
  const evidenceRegistry = loadApcEvidenceRegistry();
  const apcFiles = findApcFiles(extractDir);
  const apcs = apcFiles
    .map((filePath) => analyzeApcFile(extractDir, index, filePath))
    .map((apc) => ({
      ...apc,
      fieldEvidenceRefs: buildApcEvidenceRefs(apc, evidenceRegistry),
    }));
  const report = {
    ok: true,
    extractDir,
    generatedAt: new Date().toISOString(),
    fieldEvidenceRegistry: {
      ...evidenceRegistry,
      registryPathRelative: evidenceRegistry.registryPath
        ? normalizePvfPath(path.relative(process.cwd(), evidenceRegistry.registryPath))
        : "",
    },
    fieldEvidenceVisibleSummary: buildFieldEvidenceVisibleSummary(evidenceRegistry),
    summary: summarize(apcs),
    apcs,
  };

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, JSON.stringify(report, null, 2), "utf8");
  fs.mkdirSync(path.dirname(resolvedMdOut), { recursive: true });
  writeMarkdown(report, resolvedMdOut);

  console.log(
    JSON.stringify(
      {
        ok: true,
        apcCount: report.summary.apcCount,
        uniqueSkillIdCount: report.summary.uniqueSkillIdCount,
        uniqueEquipmentIdCount: report.summary.uniqueEquipmentIdCount,
        uniqueQuickItemIdCount: report.summary.uniqueQuickItemIdCount,
        aiFileCount: report.summary.aiFileCount,
        keyFileCount: report.summary.keyFileCount,
        out: resolvedOut,
        mdOut: resolvedMdOut,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}
