"use strict";

const fs = require("fs");
const path = require("path");
const {
  backtickValues,
  commonReadOptions,
  loadPvfBackend,
  firstBacktick,
  normalizeEncoding,
  normalizeKey,
  normalizePvfPath,
  numbers,
  parseAiCharacterRows,
  parseLstContent,
  tagBlocks,
} = require("./pvf_graph_common");
const { runtimePath } = require("../../core/pvf-agent-core/lib/runtime-state");

const WORKBENCH_ROOT = process.env.DNFPVF_WORKSPACE || path.resolve(__dirname, "..", "..");
const DEFAULT_OUT_DIR = runtimePath(WORKBENCH_ROOT, "planner-runs", "scope");
const DATE_TAG = new Date().toISOString().slice(0, 10);

const REGISTRY_SPECS = [
  { kind: "aicharacter", path: "aicharacter/aicharacter.lst" },
  { kind: "appendage", path: "appendage/appendage.lst" },
  { kind: "character", path: "character/character.lst" },
  { kind: "creature", path: "creature/creature.lst" },
  { kind: "dungeon", path: "dungeon/dungeon.lst" },
  { kind: "equipment", path: "equipment/equipment.lst" },
  { kind: "itemshop", path: "itemshop/itemshop.lst" },
  { kind: "map", path: "map/map.lst" },
  { kind: "monster", path: "monster/monster.lst" },
  { kind: "npc", path: "npc/npc.lst" },
  { kind: "passiveobject", path: "passiveobject/passiveobject.lst" },
  { kind: "quest", path: "n_quest/quest.lst" },
  { kind: "stackable", path: "stackable/stackable.lst" },
  { kind: "town", path: "town/town.lst" },
];

const AREA_ALIAS_SEEDS = [
  { expand: "dungeon", aliases: ["洛兰", "lorien", "act1"], prefixes: ["dungeon/act1/"] },
  { expand: "dungeon", aliases: ["天空之城", "天空城", "sky tower", "act2"], prefixes: ["dungeon/act2/"] },
  { expand: "dungeon", aliases: ["天帷巨兽", "天帷", "巨兽", "behemoth", "act3"], prefixes: ["dungeon/act3/"] },
  { expand: "dungeon", aliases: ["暗黑城", "underfoot", "act4"], prefixes: ["dungeon/act4/"] },
  { expand: "dungeon", aliases: ["万年雪山", "雪山", "snow", "act5"], prefixes: ["dungeon/act5/"] },
  { expand: "dungeon", aliases: ["诺斯玛尔", "northmyre", "act6"], prefixes: ["dungeon/act6/"] },
  { expand: "dungeon", aliases: ["天界", "根特", "gent", "act7"], prefixes: ["dungeon/act7/"] },
];

const KNOWN_EXTENSIONS = new Set([
  "act",
  "ai",
  "ani",
  "apd",
  "atk",
  "cre",
  "dgn",
  "equ",
  "etc",
  "evt",
  "img",
  "lst",
  "map",
  "mob",
  "npc",
  "nut",
  "obj",
  "ptl",
  "qst",
  "shp",
  "skl",
  "stk",
  "str",
  "twn",
  "ui",
]);

const EXPAND_VALUES = new Set(["auto", "dungeon", "map", "town", "npc_shop", "equipment", "monster", "passiveobject", "quest", "skill", "attack", "action_script", "file"]);
const SELECTOR_MODES = new Set(["query", "exact-path", "registry-id"]);
const REGISTRY_KINDS = new Set(REGISTRY_SPECS.map((item) => item.kind));
const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };
const ATTACK_PAYLOAD_TAG_GROUPS = {
  damage_amount: ["damage bonus", "damage", "absolute damage", "weapon damage apply"],
  targeting: ["attack enemy", "attack friend"],
  attack_type_element: ["attack type", "physic", "physical", "magic", "magical", "ignore defense", "elemental property", "no element", "no elemental", "none element", "fire element", "water element", "ice element", "light element", "dark element"],
  reaction_control: ["damage reaction", "down", "push aside", "lift up", "knuck back", "attack direction", "hit down", "hit horizon"],
  hit_feedback: ["hit wav", "hit info", "cut", "blow", "blood", "no blood"],
  duration_status: ["duration", "active status"],
};

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const raw = arg.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex !== -1) {
      parsed[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      index += 1;
    } else {
      parsed[raw] = "true";
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node tools/pvf-bridge/pvf-scope-planner.js --pvf=Script.pvf --query="item or skill name" [--selector-mode=query|exact-path|registry-id] [--selector-registry=monster] [--expand=auto] [--out-dir=EXTERNAL_DIR]

Rules:
  --pvf and --query are required. exact-path and registry-id selectors bypass fuzzy filename/content discovery.
  registry-id also requires --selector-registry. This is a read-only planner and writes preview reports only.
  pvfCourse matching is disabled by default; use --include-pvfcourse --pvfcourse-index=FILE only with an explicit local index.
`);
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  return !/^(0|false|no)$/i.test(String(value).trim());
}

function numberArg(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function slugify(value) {
  const raw = String(value || "scope")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (raw || "scope").slice(0, 80);
}

function emitTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, "w");
  try {
    fs.writeSync(handle, content, undefined, "utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function loadJsonIfExists(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function extensionOf(value) {
  const match = normalizeKey(value).match(/\.([a-z0-9_]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

function hasKnownExtension(value) {
  return KNOWN_EXTENSIONS.has(extensionOf(value));
}

function firstNumberPerLine(value) {
  const out = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(-?\d+)/);
    if (match) out.push(Number(match[1]));
  }
  return out;
}

function firstColumnIdsFromTag(text, tag) {
  return tagBlocks(text, tag).flatMap(firstNumberPerLine).filter((id) => id > 0);
}

function firstOfGroups(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    if (values[index] > 0) out.push(values[index]);
  }
  return out;
}

function indexedActionIds(text, tag) {
  const out = [];
  for (const block of tagBlocks(text, tag)) {
    const random = block.match(/\[INDEX\][\s\S]*?\[RANDOM SELECT\]([\s\S]*?)\[\/RANDOM SELECT\]/i);
    if (random) {
      out.push(...numbers(random[1]).filter((id) => id > 0));
      continue;
    }
    const direct = block.match(/\[INDEX\]\s*(?:\r?\n)+\s*(\d+)\b/i);
    if (direct) out.push(Number(direct[1]));
  }
  return out;
}

function secretShopLevelItemIds(block) {
  const values = numbers(block).filter((value) => value >= 0);
  const out = [];
  for (let index = 1; index + 5 < values.length; index += 6) {
    const itemId = values[index + 1];
    if (itemId > 0) out.push(itemId);
  }
  return out;
}

function exactShortTagBlock(content, tag) {
  const lines = String(content || "").split(/\r?\n/);
  const open = `[${tag}]`;
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().toLowerCase() !== open.toLowerCase()) continue;
    const block = [];
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const trimmed = lines[inner].trim();
      if (/^\[[^\]]+\]$/.test(trimmed)) break;
      block.push(lines[inner]);
    }
    out.push(block.join("\n"));
  }
  return out;
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null && value !== "")));
}

function compactFileName(pvfPath) {
  const normalized = normalizePvfPath(pvfPath);
  const parts = normalized.split("/");
  return parts.slice(Math.max(0, parts.length - 3)).join("/");
}

function inferEntityKind(pvfPath) {
  const normalized = normalizeKey(pvfPath);
  const ext = extensionOf(normalized);
  if (normalized === "etc/secretshop.etc") return "secretshop";
  if (normalized.startsWith("dungeon/") && ext === "dgn") return "dungeon";
  if (normalized.startsWith("map/") && ext === "map") return "map";
  if (normalized.startsWith("monster/") && ext === "mob") return "monster";
  if (normalized.startsWith("aicharacter/") && ext === "aic") return "aicharacter";
  if (normalized.startsWith("npc/") && ext === "npc") return "npc";
  if (normalized.startsWith("itemshop/") && ext === "shp") return "itemshop";
  if (normalized.startsWith("equipment/") && ext === "equ") return "equipment";
  if (normalized.startsWith("passiveobject/") && ext === "obj") return "passiveobject";
  if (normalized.startsWith("skill/") && ext === "skl") return "skill";
  if (normalized.startsWith("n_quest/") && ext === "qst") return "quest";
  if (normalized.startsWith("appendage/") && ext === "apd") return "appendage";
  if (normalized.startsWith("stackable/") && ext === "stk") return "stackable";
  if (normalized.startsWith("creature/") && ext === "cre") return "creature";
  if (normalized.startsWith("ui/") && ext === "ui") return "ui";
  return ext || "file";
}

function confidenceMax(left, right) {
  return CONFIDENCE_RANK[right] > CONFIDENCE_RANK[left] ? right : left;
}

function typePriorityForExpand(expand, type) {
  const priorities = {
    dungeon: ["dungeon", "map", "monster", "aicharacter", "passiveobject", "npc"],
    map: ["map", "dungeon", "monster", "aicharacter", "passiveobject", "npc"],
    npc_shop: ["npc", "secretshop", "itemshop", "stackable", "equipment"],
    equipment: ["equipment", "appendage", "passiveobject", "monster", "aicharacter", "atk", "act", "ani"],
    monster: ["monster", "aicharacter", "passiveobject", "atk", "act", "ai", "ani"],
    passiveobject: ["passiveobject", "atk", "act", "ani", "monster", "aicharacter"],
    attack: ["atk", "monster", "passiveobject", "act", "ani"],
    quest: ["quest"],
    skill: ["skill"],
  };
  const list = priorities[expand] || [];
  const index = list.indexOf(type);
  return index === -1 ? 100 : index;
}

function compareCandidatesForExpand(expand, a, b) {
  const typeDelta = typePriorityForExpand(expand, a.type) - typePriorityForExpand(expand, b.type);
  if (typeDelta) return typeDelta;
  const confidenceDelta = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  if (confidenceDelta) return confidenceDelta;
  return String(a.pvfPath).localeCompare(String(b.pvfPath));
}

async function openPvf(native, pvfPath, encoding) {
  const session = await native.openSession(pvfPath, normalizeEncoding(encoding));
  const sessionId = session.sessionId;
  const allFiles = (await native.listFiles(sessionId)).map((item) => normalizeKey(item.fileName));
  const fileSet = new Set(allFiles);
  const readText = async (pvfPathToRead) => {
    const result = await native.readFile(sessionId, normalizePvfPath(pvfPathToRead), commonReadOptions());
    return typeof result.textContent === "string" ? result.textContent : "";
  };
  const search = async ({ keyword, searchPath = "", searchType = "SearchScript", limit = 80 }) => {
    const result = await native.searchFiles(sessionId, {
      keyword,
      searchPath,
      isStartMatch: false,
      isUseLikeSearchPath: false,
      searchType,
      matchMode: "Like",
      convertToSimplifiedChinese: true,
      limit,
    });
    return {
      searchType,
      searchPath,
      matchedCount: result.matchedCount || 0,
      searchedCount: result.searchedCount || 0,
      items: (Array.isArray(result.items) ? result.items : []).slice(0, limit),
    };
  };
  return { sessionId, allFiles, fileSet, readText, search };
}

async function loadRegistries(ctx) {
  for (const spec of REGISTRY_SPECS) {
    if (!ctx.pvf.fileSet.has(normalizeKey(spec.path))) continue;
    try {
      const parsed = parseLstContent(await ctx.pvf.readText(spec.path), spec.path);
      const registry = { ...spec, entries: parsed.entries, byId: parsed.byId };
      ctx.registries.set(spec.kind, registry);
      for (const entry of parsed.entries) {
        ctx.registryByPath.set(normalizeKey(entry.pvfPath), { kind: spec.kind, id: entry.id, registryPath: spec.path, entry });
      }
    } catch (error) {
      ctx.readErrors.push({ pvfPath: spec.path, error: error.message });
    }
  }
}

function resolveRegistry(ctx, kind, id) {
  const registry = ctx.registries.get(kind);
  const entry = registry?.byId?.get(Number(id));
  if (!entry) return { kind, id: Number(id), resolved: false, pvfPath: "" };
  return { kind, id: Number(id), resolved: ctx.pvf.fileSet.has(normalizeKey(entry.pvfPath)), pvfPath: normalizeKey(entry.pvfPath) };
}

function resolveAnyRegistry(ctx, kinds, id) {
  for (const kind of kinds) {
    const hit = resolveRegistry(ctx, kind, id);
    if (hit.resolved) return hit;
  }
  return { kind: kinds.join("|"), id: Number(id), resolved: false, pvfPath: "" };
}

function entityFromPath(ctx, rawPath, baseConfidence, reason, sourceKind, options = {}) {
  const pvfPath = normalizeKey(rawPath);
  const registryHit = ctx.registryByPath.get(pvfPath);
  const kind = registryHit?.kind || inferEntityKind(pvfPath);
  return {
    key: registryHit ? `${registryHit.kind}:${registryHit.id}` : `path:${pvfPath}`,
    type: kind,
    id: registryHit?.id ?? null,
    pvfPath,
    confidence: registryHit && !options.noRegistryPromote ? confidenceMax(baseConfidence, "high") : baseConfidence,
    reasons: [reason],
    sources: [{ kind: sourceKind, detail: reason }],
    registryPath: registryHit?.registryPath || null,
    exists: ctx.pvf.fileSet.has(pvfPath),
  };
}

function addCandidate(ctx, candidate) {
  if (!candidate || !candidate.pvfPath) return null;
  const existing = ctx.candidateMap.get(candidate.key);
  if (!existing) {
    const normalized = {
      ...candidate,
      reasons: unique(candidate.reasons || []),
      sources: candidate.sources || [],
      sampleName: "",
    };
    ctx.candidateMap.set(candidate.key, normalized);
    return normalized;
  }
  existing.confidence = confidenceMax(existing.confidence, candidate.confidence || "low");
  existing.reasons = unique([...(existing.reasons || []), ...(candidate.reasons || [])]);
  existing.sources.push(...(candidate.sources || []));
  return existing;
}

function addRelation(ctx, relation) {
  ctx.relations.push({
    confidence: relation.resolved ? "high" : "medium",
    ...relation,
  });
  if (!relation.resolved) {
    ctx.unresolvedReferences.push(relation);
  }
}

function expansionKey(mode, candidate) {
  return `${mode}:${candidate.key || normalizeKey(candidate.pvfPath)}`;
}

async function guardedExpand(ctx, mode, candidate, remainingDepth, expandFn) {
  if (!candidate || remainingDepth < 1) {
    ctx.expansionStats.depthLimitSkipCount += 1;
    return false;
  }
  const key = expansionKey(mode, candidate);
  if (ctx.expandedNodes.has(key)) {
    ctx.expansionStats.guardSkipCount += 1;
    return false;
  }
  ctx.expandedNodes.add(key);
  ctx.expansionStats.expandedNodeCount += 1;
  await expandFn(ctx, candidate, remainingDepth);
  return true;
}

function canFollowChildExpansion(_ctx, remainingDepth) {
  return remainingDepth > 1;
}

function canFollowActionScript(ctx, remainingDepth) {
  return ctx.args.depth > 1 && remainingDepth > 1;
}

function canExpandActionScriptTargets(ctx, remainingDepth) {
  return ctx.args.depth >= 3 && remainingDepth > 1;
}

async function readCandidateName(ctx, candidate) {
  if (candidate.sampleName || !ctx.pvf.fileSet.has(candidate.pvfPath)) return;
  try {
    const text = await ctx.pvf.readText(candidate.pvfPath);
    candidate.sampleName = firstBacktick(text, "name") || firstBacktick(text, "name2") || "";
  } catch (error) {
    ctx.readErrors.push({ pvfPath: candidate.pvfPath, error: error.message });
  }
}

function resolveFileRef(ctx, raw, sourcePath) {
  const normalized = normalizeKey(raw);
  if (!normalized || !hasKnownExtension(normalized)) return null;
  const ext = extensionOf(normalized);
  if (ext === "img") {
    return { raw, source: sourcePath, kind: "external_img", resolved: false, targetPath: "", confidence: "low" };
  }
  const sourceDir = path.posix.dirname(normalizeKey(sourcePath || ""));
  const candidates = [];
  const push = (value) => {
    const cleaned = normalizeKey(path.posix.normalize(value));
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  };
  push(normalized);
  push(normalized.replace(/^(\.\.\/)+/, ""));
  if (sourceDir && sourceDir !== ".") push(path.posix.join(sourceDir, normalized));
  for (const root of ["dungeon/", "map/", "monster/", "aicharacter/", "npc/", "itemshop/", "equipment/", "passiveobject/", "skill/", "appendage/", "stackable/", "ui/", "etc/", "sqr/", "character/"]) {
    const index = normalized.indexOf(root);
    if (index > 0) push(normalized.slice(index));
  }
  if (ext === "obj" && !normalized.startsWith("passiveobject/")) push(path.posix.join("passiveobject", normalized));
  if (ext === "skl" && !normalized.startsWith("skill/")) push(path.posix.join("skill", normalized));
  if (ext === "nut" && !normalized.startsWith("sqr/")) push(path.posix.join("sqr", normalized));
  if (["act", "ani", "atk", "ptl"].includes(ext) && sourceDir && sourceDir !== ".") {
    const base = path.posix.basename(normalized);
    push(path.posix.join(sourceDir, "action", base));
    push(path.posix.join(sourceDir, "animation", base));
    push(path.posix.join(sourceDir, "attackinfo", base));
    push(path.posix.join(sourceDir, "particle", base));
  }
  const targetPath = candidates.find((item) => ctx.pvf.fileSet.has(item)) || "";
  return { raw, source: sourcePath, kind: "pvf_file", resolved: Boolean(targetPath), targetPath, candidates: candidates.slice(0, 8) };
}

function hasScriptTag(text, tag) {
  const escaped = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[${escaped}\\]`, "i").test(String(text || ""));
}

function matchingTags(text, tags) {
  return tags.filter((tag) => hasScriptTag(text, tag)).map((tag) => `[${tag}]`);
}

function summarizeAttackPayload(text) {
  const groups = {};
  for (const [group, tags] of Object.entries(ATTACK_PAYLOAD_TAG_GROUPS)) {
    const hits = matchingTags(text, tags);
    if (hits.length) groups[group] = hits;
  }
  return {
    groups,
    groupCount: Object.keys(groups).length,
  };
}

async function addTaggedFileRelations(ctx, sourceCandidate, text, tag, relationKind, expectedExtensions = [], remainingDepth = ctx.args.depth) {
  const expected = new Set(expectedExtensions.map((item) => String(item).replace(/^\./, "").toLowerCase()));
  const rawRefs = unique(tagBlocks(text, tag).flatMap(backtickValues));
  for (const raw of rawRefs.slice(0, ctx.args.limit * 4)) {
    const ext = extensionOf(raw);
    if (expected.size && !expected.has(ext)) continue;
    const ref = resolveFileRef(ctx, raw, sourceCandidate.pvfPath);
    if (!ref) continue;
    addRelation(ctx, {
      relationKind,
      source: { type: sourceCandidate.type, id: sourceCandidate.id, pvfPath: sourceCandidate.pvfPath },
      target: { type: ref.kind === "external_img" ? "external_img" : inferEntityKind(ref.targetPath || ref.raw), id: null, pvfPath: ref.targetPath || ref.raw },
      resolved: Boolean(ref.resolved),
      evidence: `[${tag}] ${ref.raw}`,
      confidence: ref.resolved ? "high" : "low",
    });
    if (!ref.resolved) continue;
    const child = addCandidate(ctx, entityFromPath(ctx, ref.targetPath, "high", `${relationKind} resolved`, "relation", { noRegistryPromote: true }));
    if (child && extensionOf(ref.targetPath) === "atk") {
      await expandAttackPayload(ctx, child);
    }
    if (child && canFollowActionScript(ctx, remainingDepth) && ["act", "key"].includes(extensionOf(ref.targetPath))) {
      await guardedExpand(ctx, "action_script", child, remainingDepth - 1, expandActionScript);
    }
  }
}

async function discoverCandidates(ctx) {
  const query = ctx.args.query.trim();
  const queryKey = normalizeKey(query);
  const limit = ctx.args.limit;

  if (ctx.args.selectorMode === "registry-id") {
    const id = Number(query);
    const registry = ctx.registries.get(ctx.args.selectorRegistry);
    const hit = registry?.byId?.get(id);
    if (!registry) {
      ctx.warnings.push(`Selector registry is unavailable: ${ctx.args.selectorRegistry}`);
    } else if (!hit) {
      ctx.warnings.push(`${registry.path} does not contain id=${id}.`);
    } else {
      const candidate = entityFromPath(ctx, hit.pvfPath, "high", `${registry.kind}.lst id=${id}`, "registry_id");
      candidate.root = true;
      addCandidate(ctx, candidate);
      if (!candidate.exists) ctx.warnings.push(`${registry.path} id=${id} points to a missing PVF path: ${hit.pvfPath}`);
    }
    for (const candidate of Array.from(ctx.candidateMap.values()).slice(0, limit)) await readCandidateName(ctx, candidate);
    return;
  }

  if (ctx.args.selectorMode === "exact-path") {
    if (queryKey && ctx.pvf.fileSet.has(queryKey)) {
      const candidate = entityFromPath(ctx, queryKey, "high", "exact PVF path exists", "exact_path");
      candidate.root = true;
      addCandidate(ctx, candidate);
    } else {
      ctx.warnings.push(`Exact selector path is missing from the target PVF: ${query}`);
    }
    for (const candidate of Array.from(ctx.candidateMap.values()).slice(0, limit)) await readCandidateName(ctx, candidate);
    return;
  }

  if (hasKnownExtension(queryKey) && ctx.pvf.fileSet.has(queryKey)) {
    addCandidate(ctx, entityFromPath(ctx, queryKey, "high", "exact PVF path exists", "exact_path"));
  }

  if (/^\d+$/.test(query)) {
    const id = Number(query);
    for (const registry of ctx.registries.values()) {
      const hit = registry.byId.get(id);
      if (hit) {
        addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `${registry.kind}.lst id=${id}`, "registry_id"));
      }
    }
  }

  if (queryKey) {
    for (const fileName of ctx.pvf.allFiles.filter((item) => item.includes(queryKey)).slice(0, limit)) {
      addCandidate(ctx, entityFromPath(ctx, fileName, "medium", "file name contains query", "file_name"));
    }
  }

  addAliasSeedCandidates(ctx);
  await addStructuralSeedCandidates(ctx);

  const searchPath = searchPathForExpand(ctx.args.expand);
  for (const searchType of ["SearchName", "SearchStrings", "SearchScript"]) {
    try {
      const result = await ctx.pvf.search({ keyword: query, searchPath, searchType, limit });
      ctx.searches.push({
        searchType,
        searchPath,
        matchedCount: result.matchedCount,
        returned: result.items.length,
      });
      for (const item of result.items) {
        const fileName = normalizeKey(item.fileName);
        if (!fileName || !ctx.pvf.fileSet.has(fileName)) continue;
        const sourceKind = searchType === "SearchName" ? "pvf_name_search" : "pvf_text_search";
        const confidence = ctx.registryByPath.has(fileName) && searchType === "SearchName" ? "high" : "medium";
        addCandidate(ctx, entityFromPath(ctx, fileName, confidence, `${searchType} matched query`, sourceKind));
      }
    } catch (error) {
      ctx.warnings.push(`PVF search failed: ${searchType} ${error.message}`);
    }
  }

  if (ctx.args.includePvfCourse) {
    addPvfCourseEvidence(ctx);
  }

  for (const candidate of Array.from(ctx.candidateMap.values()).slice(0, limit)) {
    await readCandidateName(ctx, candidate);
  }
}

function addAliasSeedCandidates(ctx) {
  const queryKey = normalizeKey(ctx.args.query);
  const allowedExpand = ctx.args.expand === "auto" ? "dungeon" : ctx.args.expand;
  for (const seed of AREA_ALIAS_SEEDS) {
    if (seed.expand !== allowedExpand) continue;
    if (!seed.aliases.some((alias) => queryKey.includes(normalizeKey(alias)))) continue;
    let added = 0;
    for (const registry of ctx.registries.values()) {
      if (registry.kind !== "dungeon") continue;
      for (const entry of registry.entries) {
        const pvfPath = normalizeKey(entry.pvfPath);
        if (!seed.prefixes.some((prefix) => pvfPath.startsWith(prefix))) continue;
        if (!ctx.pvf.fileSet.has(pvfPath)) continue;
        addCandidate(ctx, entityFromPath(ctx, pvfPath, "medium", `area alias matched ${seed.aliases[0]}`, "builtin_area_alias"));
        added += 1;
        if (added >= ctx.args.limit) break;
      }
    }
    ctx.warnings.push(`区域别名 '${seed.aliases[0]}' 命中 ${added} 个 dungeon 注册文件；候选文件本身可闭合，但区域边界仍需人工确认。`);
  }
}

async function addStructuralSeedCandidates(ctx) {
  const queryKey = normalizeKey(ctx.args.query);
  const expand = ctx.args.expand === "auto" ? "" : ctx.args.expand;
  const seeds = [];
  if (expand === "equipment" && queryKey.includes("appendage")) {
    seeds.push({ searchPath: "equipment/", keyword: "[appendage]", reason: "equipment contains [appendage] tag" });
    seeds.push({ searchPath: "equipment/", keyword: "[my appendage]", reason: "equipment contains [my appendage] tag" });
  }
  if (expand === "equipment" && (queryKey.includes("passiveobject") || queryKey.includes("passive object"))) {
    seeds.push({ searchPath: "equipment/", keyword: "[passive object]", reason: "equipment contains [passive object] tag" });
  }
  if (expand === "equipment" && queryKey.includes("summon monster")) {
    seeds.push({ searchPath: "equipment/", keyword: "[summon monster]", reason: "equipment contains [summon monster] tag" });
  }
  if (expand === "equipment" && queryKey.includes("summon apc")) {
    seeds.push({ searchPath: "equipment/", keyword: "[summon apc]", reason: "equipment contains [summon apc] tag" });
  }
  for (const seed of seeds) {
    try {
      const result = await ctx.pvf.search({
        keyword: seed.keyword,
        searchPath: seed.searchPath,
        searchType: "SearchScript",
        limit: ctx.args.limit,
      });
      ctx.searches.push({
        searchType: "SearchScript",
        searchPath: seed.searchPath,
        matchedCount: result.matchedCount,
        returned: result.items.length,
        structuralSeed: seed.keyword,
      });
      for (const item of result.items) {
        const fileName = normalizeKey(item.fileName);
        if (fileName && ctx.pvf.fileSet.has(fileName)) {
          addCandidate(ctx, entityFromPath(ctx, fileName, "medium", seed.reason, "structural_tag_search"));
        }
      }
    } catch (error) {
      ctx.warnings.push(`Structural tag search failed: ${seed.keyword} ${error.message}`);
    }
  }
}

function searchPathForExpand(expand) {
  if (expand === "dungeon") return "";
  if (expand === "map") return "map/";
  if (expand === "npc_shop") return "";
  if (expand === "equipment") return "equipment/";
  if (expand === "monster") return "monster/";
  if (expand === "passiveobject") return "passiveobject/";
  if (expand === "quest") return "n_quest/";
  if (expand === "skill") return "skill/";
  if (expand === "attack") return "";
  return "";
}

function addPvfCourseEvidence(ctx) {
  if (!ctx.pvfCourseIndex?.articles) return;
  const tokens = normalizeKey(ctx.args.query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return;
  const matches = [];
  for (const article of ctx.pvfCourseIndex.articles) {
    const haystack = [
      article.relPath,
      article.title,
      article.domain,
      article.status,
      ...(article.claimSnippets || []),
      ...(article.pvfPaths || []).map((item) => item.pvfPath),
      ...(article.tags || []).map((item) => item.tag),
    ]
      .join("\n")
      .toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;
    let score = 1;
    if (String(article.title || "").toLowerCase().includes(tokens[0])) score += 5;
    if (article.status === "verified") score += 3;
    if (article.status === "candidate") score += 1;
    matches.push({
      score,
      relPath: article.relPath,
      title: article.title,
      domain: article.domain,
      status: article.status,
      pvfPaths: (article.pvfPaths || []).slice(0, 6).map((item) => item.pvfPath),
      tags: (article.tags || []).slice(0, 8).map((item) => item.tag),
    });
    for (const pvfPathInfo of article.pvfPaths || []) {
      const pvfPath = normalizeKey(pvfPathInfo.pvfPath);
      if (ctx.pvf.fileSet.has(pvfPath)) {
        addCandidate(ctx, entityFromPath(ctx, pvfPath, "medium", `pvfCourse article: ${article.title}`, "pvfcourse_path", { noRegistryPromote: true }));
      }
    }
  }
  matches.sort((a, b) => b.score - a.score || String(a.relPath).localeCompare(String(b.relPath), "zh-Hans-CN"));
  ctx.pvfCourseMatches.push(...matches.slice(0, ctx.args.limit));
}

async function expandCandidates(ctx) {
  const candidates = Array.from(ctx.candidateMap.values())
    .sort((a, b) => compareCandidatesForExpand(ctx.args.expand, a, b))
    .slice(0, ctx.args.limit);

  for (const candidate of candidates) {
    const mode = ctx.args.expand === "auto" ? defaultExpandFor(candidate.type) : ctx.args.expand;
    if (mode === "dungeon") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandDungeonLike);
    else if (mode === "map") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandMap);
    else if (mode === "town") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandTown);
    else if (mode === "npc_shop") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandNpcShop);
    else if (mode === "equipment") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandEquipment);
    else if (mode === "monster") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandMonster);
    else if (mode === "passiveobject") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandPassiveObject);
    else if (mode === "action_script") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandActionScript);
    else if (mode === "attack") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandAttackPayload);
    else if (mode === "quest") await guardedExpand(ctx, mode, candidate, ctx.args.depth, expandQuest);
    else if (mode === "skill") await guardedExpand(ctx, mode, candidate, ctx.args.depth, (innerCtx, innerCandidate) => expandDirectFile(innerCtx, innerCandidate, mode));
    else if (mode === "file") await guardedExpand(ctx, mode, candidate, ctx.args.depth, (innerCtx, innerCandidate) => expandDirectFile(innerCtx, innerCandidate, null));
  }
}

function defaultExpandFor(type) {
  if (type === "dungeon" || type === "map") return "dungeon";
  if (type === "town") return "town";
  if (type === "npc" || type === "itemshop" || type === "secretshop") return "npc_shop";
  if (type === "equipment") return "equipment";
  if (type === "passiveobject") return "passiveobject";
  if (type === "act" || type === "key") return "action_script";
  if (type === "monster" || type === "aicharacter") return "monster";
  if (type === "atk") return "attack";
  if (type === "quest") return "quest";
  if (type === "skill") return "skill";
  return "skill";
}

async function expandDungeonLike(ctx, candidate, remainingDepth = ctx.args.depth) {
  if (candidate.type === "dungeon") {
    await expandDungeon(ctx, candidate, remainingDepth);
    return;
  }
  if (candidate.type === "map") {
    await expandMap(ctx, candidate, remainingDepth);
    return;
  }
  if (candidate.type !== "file") return;
}

async function expandDungeon(ctx, candidate, remainingDepth = ctx.args.depth) {
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  const mapIds = [];
  for (const block of tagBlocks(text, "map specification")) {
    const values = numbers(block).filter((id) => id > 0);
    if (values.length) mapIds.push(values[values.length - 1]);
  }
  for (const id of unique(mapIds).slice(0, ctx.args.limit * 3)) {
    const hit = resolveRegistry(ctx, "map", id);
    addResolvedRelation(ctx, candidate, "dungeon.mapSpecification", hit, "map", id);
    if (hit.resolved && canFollowChildExpansion(ctx, remainingDepth)) {
      const child = addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `map ${id} referenced by dungeon`, "relation"));
      if (child) await guardedExpand(ctx, "map", child, remainingDepth, expandMap);
    }
  }
  for (const id of unique(firstOfGroups(numbers(tagBlocks(text, "pathgate object").join("\n")), 1)).slice(0, ctx.args.limit)) {
    const hit = resolveRegistry(ctx, "passiveobject", id);
    addResolvedRelation(ctx, candidate, "dungeon.pathgateObject", hit, "passiveobject", id);
  }
  for (const id of unique(numbers(tagBlocks(text, "seal door map index").join("\n")).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    const hit = resolveRegistry(ctx, "map", id);
    addResolvedRelation(ctx, candidate, "dungeon.sealDoorMap", hit, "map", id);
    if (hit.resolved && canFollowChildExpansion(ctx, remainingDepth)) {
      const child = addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `seal door map ${id} referenced by dungeon`, "relation"));
      if (child) await guardedExpand(ctx, "map", child, remainingDepth, expandMap);
    }
  }
}

async function expandMap(ctx, candidate, _remainingDepth = ctx.args.depth) {
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  for (const id of unique(numbers(tagBlocks(text, "dungeon").join("\n")).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    addResolvedRelation(ctx, candidate, "map.dungeon", resolveRegistry(ctx, "dungeon", id), "dungeon", id);
  }
  for (const id of unique(tagBlocks(text, "monster").flatMap(firstNumberPerLine).filter((value) => value > 0)).slice(0, ctx.args.limit * 3)) {
    addResolvedRelation(ctx, candidate, "map.monster", resolveRegistry(ctx, "monster", id), "monster", id);
  }
  for (const id of unique(tagBlocks(text, "passive object").flatMap((block) => firstOfGroups(numbers(block), 4))).slice(0, ctx.args.limit * 3)) {
    addResolvedRelation(ctx, candidate, "map.passiveObject", resolveRegistry(ctx, "passiveobject", id), "passiveobject", id);
  }
  for (const id of unique(tagBlocks(text, "special passive object").flatMap(firstNumberPerLine).filter((value) => value > 0)).slice(0, ctx.args.limit * 3)) {
    addResolvedRelation(ctx, candidate, "map.specialPassiveObject", resolveRegistry(ctx, "passiveobject", id), "passiveobject", id);
  }
  for (const id of unique(tagBlocks(text, "npc").flatMap(firstNumberPerLine).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    addResolvedRelation(ctx, candidate, "map.npc", resolveRegistry(ctx, "npc", id), "npc", id);
  }
  for (const id of unique(parseAiCharacterRows(text)).slice(0, ctx.args.limit)) {
    addResolvedRelation(ctx, candidate, "map.aicharacter", resolveRegistry(ctx, "aicharacter", id), "aicharacter", id);
  }
}

async function expandTown(ctx, candidate, _remainingDepth = ctx.args.depth) {
  if (candidate.type !== "town" && extensionOf(candidate.pvfPath) !== "twn") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  addFileRelations(ctx, candidate, text, "town.fileRef");
  for (const id of unique(numbers(tagBlocks(text, "dungeon").join("\n")).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    addResolvedRelation(ctx, candidate, "town.dungeon", resolveRegistry(ctx, "dungeon", id), "dungeon", id);
  }
}

async function expandNpcShop(ctx, candidate, remainingDepth = ctx.args.depth) {
  if (candidate.type === "secretshop" || candidate.pvfPath === "etc/secretshop.etc") {
    await expandSecretShop(ctx, candidate, remainingDepth);
    return;
  }
  if (candidate.type === "itemshop") {
    await expandShopFile(ctx, candidate, remainingDepth);
    return;
  }
  if (candidate.type !== "npc") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  const shopIds = unique(numbers(tagBlocks(text, "item shop").join("\n")).filter((id) => id > 0));
  for (const id of shopIds.slice(0, ctx.args.limit)) {
    const hit = resolveRegistry(ctx, "itemshop", id);
    addResolvedRelation(ctx, candidate, "npc.itemShop", hit, "itemshop", id);
    if (hit.resolved && canFollowChildExpansion(ctx, remainingDepth)) {
      const child = addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `itemshop ${id} referenced by NPC`, "relation"));
      if (child) await guardedExpand(ctx, "itemshop", child, remainingDepth, expandShopFile);
    }
  }
  const roleText = tagBlocks(text, "role").join("\n").toLowerCase();
  if (roleText.includes("secret shop") && ctx.pvf.fileSet.has("etc/secretshop.etc")) {
    addRelation(ctx, {
      relationKind: "npc.secretShop",
      source: { type: candidate.type, id: candidate.id, pvfPath: candidate.pvfPath },
      target: { type: "secretshop", id: null, pvfPath: "etc/secretshop.etc" },
      resolved: true,
      evidence: "NPC [role] contains [secret shop]",
      confidence: "high",
    });
    const child = addCandidate(ctx, entityFromPath(ctx, "etc/secretshop.etc", "high", "NPC [role] contains [secret shop]", "relation"));
    if (child && canFollowChildExpansion(ctx, remainingDepth)) await guardedExpand(ctx, "secretshop", child, remainingDepth, expandSecretShop);
  }
}

async function expandShopFile(ctx, candidate, _remainingDepth = ctx.args.depth) {
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  const itemIds = unique(
    ["sell item", "item", "stackable", "equipment"].flatMap((tag) => tagBlocks(text, tag).flatMap(firstNumberPerLine)),
  ).filter((id) => id > 0);
  for (const id of itemIds.slice(0, ctx.args.limit * 3)) {
    const hit = resolveAnyRegistry(ctx, ["stackable", "equipment"], id);
    addResolvedRelation(ctx, candidate, "itemshop.sellItem", hit, hit.kind, id);
  }
}

async function expandSecretShop(ctx, candidate, _remainingDepth = ctx.args.depth) {
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  for (const id of unique(numbers(exactShortTagBlock(text, "npc").join("\n")).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    const hit = resolveRegistry(ctx, "npc", id);
    addResolvedRelation(ctx, candidate, "secretshop.npc", hit, "npc", id);
  }
  const itemIds = unique([
    ...tagBlocks(text, "level").flatMap(secretShopLevelItemIds),
    ...tagBlocks(text, "event item").flatMap(secretShopLevelItemIds),
  ]);
  for (const id of itemIds.slice(0, ctx.args.limit * 4)) {
    const hit = resolveAnyRegistry(ctx, ["stackable", "equipment"], id);
    addResolvedRelation(ctx, candidate, "secretshop.sellItem", hit, hit.kind, id);
  }
  ctx.warnings.push("加百利在当前 PVF 中主要通过 etc/secretshop.etc 表达；这是特殊商店链，不是普通 npc -> itemshop.lst 链。");
}

async function expandEquipment(ctx, candidate, remainingDepth = ctx.args.depth) {
  if (candidate.type !== "equipment") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  for (const id of unique(numbers([tagBlocks(text, "appendage").join("\n"), tagBlocks(text, "my appendage").join("\n")].join("\n")).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    addResolvedRelation(ctx, candidate, "equipment.appendage", resolveRegistry(ctx, "appendage", id), "appendage", id);
  }
  for (const id of unique(tagBlocks(text, "passive object").flatMap(firstNumberPerLine).filter((value) => value > 0)).slice(0, ctx.args.limit)) {
    const hit = resolveRegistry(ctx, "passiveobject", id);
    addResolvedRelation(ctx, candidate, "equipment.passiveObject", hit, "passiveobject", id);
    if (hit.resolved && canFollowChildExpansion(ctx, remainingDepth)) {
      const child = addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `equipment.passiveObject ${id} resolved`, "relation"));
      if (child) await guardedExpand(ctx, "passiveobject", child, remainingDepth, expandPassiveObject);
    }
  }
  for (const id of unique(firstColumnIdsFromTag(text, "summon monster")).slice(0, ctx.args.limit * 3)) {
    const hit = resolveRegistry(ctx, "monster", id);
    addResolvedRelation(ctx, candidate, "equipment.summonMonster", hit, "monster", id);
    if (hit.resolved && canFollowChildExpansion(ctx, remainingDepth)) {
      const child = addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `equipment.summonMonster ${id} resolved`, "relation"));
      if (child) await guardedExpand(ctx, "monster", child, remainingDepth, expandMonster);
    }
  }
  for (const id of unique(firstColumnIdsFromTag(text, "summon apc")).slice(0, ctx.args.limit * 3)) {
    const hit = resolveRegistry(ctx, "aicharacter", id);
    addResolvedRelation(ctx, candidate, "equipment.summonApc", hit, "aicharacter", id);
    if (hit.resolved && canFollowChildExpansion(ctx, remainingDepth)) {
      const child = addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `equipment.summonApc ${id} resolved`, "relation"));
      if (child) await guardedExpand(ctx, "monster", child, remainingDepth, expandMonster);
    }
  }
  addFileRelations(ctx, candidate, text, "equipment.fileRef");
}

async function expandMonster(ctx, candidate, remainingDepth = ctx.args.depth) {
  if (candidate.type === "aicharacter") {
    const text = await safeRead(ctx, candidate.pvfPath);
    if (text) addFileRelations(ctx, candidate, text, "aicharacter.fileRef");
    return;
  }
  if (candidate.type !== "monster") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  candidate.sectionInventory = {
    abilityCategory: hasScriptTag(text, "ability category"),
    attackInfo: hasScriptTag(text, "attack info"),
    attackAction: hasScriptTag(text, "attack action"),
    aiPattern: hasScriptTag(text, "ai pattern"),
    independentDrop: hasScriptTag(text, "independent drop"),
  };
  await addTaggedFileRelations(ctx, candidate, text, "attack info", "monster.attackInfo", ["atk"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "attack action", "monster.attackAction", ["act", "ani"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "attack motion", "monster.attackMotion", ["act", "ani"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "ai pattern", "monster.aiPattern", ["ai"], remainingDepth);
}

async function expandPassiveObject(ctx, candidate, remainingDepth = ctx.args.depth) {
  if (candidate.type !== "passiveobject") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  candidate.sectionInventory = {
    passType: hasScriptTag(text, "pass type"),
    layer: hasScriptTag(text, "layer"),
    piercingPower: hasScriptTag(text, "piercing power"),
    basicAction: hasScriptTag(text, "basic action"),
    etcMotion: hasScriptTag(text, "etc motion"),
    attackInfo: hasScriptTag(text, "attack info"),
    etcAttackInfo: hasScriptTag(text, "etc attack info"),
    objectDestroyCondition: hasScriptTag(text, "object destroy condition"),
  };
  await addTaggedFileRelations(ctx, candidate, text, "basic action", "passiveobject.basicAction", ["act", "ani"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "etc action", "passiveobject.etcAction", ["act", "ani"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "etc motion", "passiveobject.etcMotion", ["act", "ani"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "attack info", "passiveobject.attackInfo", ["atk"], remainingDepth);
  await addTaggedFileRelations(ctx, candidate, text, "etc attack info", "passiveobject.etcAttackInfo", ["atk"], remainingDepth);
}

async function expandActionScriptTarget(ctx, targetKind, child, remainingDepth) {
  if (!canExpandActionScriptTargets(ctx, remainingDepth)) return;
  let expanded = false;
  if (targetKind === "passiveobject") {
    expanded = await guardedExpand(ctx, "passiveobject", child, remainingDepth - 1, expandPassiveObject);
  } else if (targetKind === "monster" || targetKind === "aicharacter") {
    expanded = await guardedExpand(ctx, "monster", child, remainingDepth - 1, expandMonster);
  }
  if (expanded) ctx.expansionStats.actionScriptTargetExpansionCount += 1;
}

async function expandActionScript(ctx, candidate, remainingDepth = ctx.args.depth) {
  if (candidate.type !== "act" && candidate.type !== "key" && !["act", "key"].includes(extensionOf(candidate.pvfPath))) return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  for (const id of unique([
    ...indexedActionIds(text, "CREATE PASSIVEOBJECT"),
    ...indexedActionIds(text, "CREATE PASSIVEOBJECT CIRCLE"),
  ]).slice(0, ctx.args.limit * 3)) {
    const hit = resolveRegistry(ctx, "passiveobject", id);
    const child = addResolvedRelation(ctx, candidate, "actionScript.createPassiveObject", hit, "passiveobject", id);
    if (child) await expandActionScriptTarget(ctx, "passiveobject", child, remainingDepth);
  }
  for (const id of unique(indexedActionIds(text, "SUMMON MONSTER")).slice(0, ctx.args.limit * 3)) {
    const hit = resolveRegistry(ctx, "monster", id);
    const child = addResolvedRelation(ctx, candidate, "actionScript.summonMonster", hit, "monster", id);
    if (child) await expandActionScriptTarget(ctx, "monster", child, remainingDepth);
  }
  for (const id of unique(indexedActionIds(text, "SUMMON APC")).slice(0, ctx.args.limit * 3)) {
    const hit = resolveRegistry(ctx, "aicharacter", id);
    const child = addResolvedRelation(ctx, candidate, "actionScript.summonApc", hit, "aicharacter", id);
    if (child) await expandActionScriptTarget(ctx, "aicharacter", child, remainingDepth);
  }
}

async function expandAttackPayload(ctx, candidate, _remainingDepth = ctx.args.depth) {
  if (candidate.type !== "atk" && extensionOf(candidate.pvfPath) !== "atk") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  candidate.attackPayload = summarizeAttackPayload(text);
}

async function expandDirectFile(ctx, candidate, expectedType, _remainingDepth = ctx.args.depth) {
  if (expectedType === "skill" && candidate.type !== "skill") return;
  if (expectedType === "quest" && candidate.type !== "quest") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  addFileRelations(ctx, candidate, text, `${candidate.type}.fileRef`);
}

function groupedIds(block, groupSize, column) {
  const values = numbers(block);
  const result = [];
  for (let index = column; index < values.length; index += groupSize) if (values[index] > 0) result.push(values[index]);
  return unique(result);
}

async function expandQuest(ctx, candidate, _remainingDepth = ctx.args.depth) {
  if (candidate.type !== "quest" && extensionOf(candidate.pvfPath) !== "qst") return;
  const text = await safeRead(ctx, candidate.pvfPath);
  if (!text) return;
  addFileRelations(ctx, candidate, text, "quest.fileRef");
  const addIds = (relationKind, registryKinds, ids) => {
    for (const id of unique(ids).slice(0, ctx.args.limit * 4)) {
      const hit = registryKinds.length === 1 ? resolveRegistry(ctx, registryKinds[0], id) : resolveAnyRegistry(ctx, registryKinds, id);
      addResolvedRelation(ctx, candidate, relationKind, hit, hit.kind || registryKinds.join("|"), id);
    }
  };
  addIds("quest.preRequiredQuest", ["quest"], tagBlocks(text, "pre required quest").flatMap(firstNumberPerLine));
  addIds("quest.limitDungeon", ["dungeon"], [
    ...tagBlocks(text, "limit dungeon index").flatMap(firstNumberPerLine),
    ...tagBlocks(text, "dungeon info").flatMap(firstNumberPerLine),
  ]);
  addIds("quest.appearMapDungeon", ["dungeon"], tagBlocks(text, "appear map").flatMap((block) => groupedIds(block, 2, 0)));
  addIds("quest.monsterRewardMonster", ["monster"], tagBlocks(text, "monster reward item").flatMap((block) => groupedIds(block, 4, 0)));
  addIds("quest.monsterRewardDungeon", ["dungeon"], tagBlocks(text, "monster reward item").flatMap((block) => groupedIds(block, 4, 1)));
  addIds("quest.monsterRewardItem", ["stackable", "equipment"], tagBlocks(text, "monster reward item").flatMap((block) => groupedIds(block, 4, 3)));
  addIds("quest.clearRewardDungeon", ["dungeon"], tagBlocks(text, "clear reward item").flatMap((block) => groupedIds(block, 3, 0)));
  addIds("quest.clearRewardItem", ["stackable", "equipment"], tagBlocks(text, "clear reward item").flatMap((block) => groupedIds(block, 3, 2)));
  addIds("quest.rewardItem", ["stackable", "equipment"], [
    ...tagBlocks(text, "reward int data").flatMap(firstNumberPerLine),
    ...tagBlocks(text, "depend give item").flatMap(firstNumberPerLine),
  ]);
}

function addResolvedRelation(ctx, sourceCandidate, relationKind, hit, targetKind, id) {
  addRelation(ctx, {
    relationKind,
    source: { type: sourceCandidate.type, id: sourceCandidate.id, pvfPath: sourceCandidate.pvfPath },
    target: { type: targetKind, id, pvfPath: hit.pvfPath || "" },
    resolved: Boolean(hit.resolved),
    evidence: hit.resolved ? `${targetKind}.lst id=${id}` : `${targetKind}.lst id=${id} unresolved`,
  });
  if (hit.resolved) return addCandidate(ctx, entityFromPath(ctx, hit.pvfPath, "high", `${relationKind} resolved`, "relation"));
  return null;
}

function addFileRelations(ctx, sourceCandidate, text, relationKind) {
  const refs = backtickValues(text)
    .map((value) => resolveFileRef(ctx, value, sourceCandidate.pvfPath))
    .filter(Boolean);
  for (const ref of refs.slice(0, ctx.args.limit * 8)) {
    addRelation(ctx, {
      relationKind,
      source: { type: sourceCandidate.type, id: sourceCandidate.id, pvfPath: sourceCandidate.pvfPath },
      target: { type: ref.kind === "external_img" ? "external_img" : inferEntityKind(ref.targetPath || ref.raw), id: null, pvfPath: ref.targetPath || ref.raw },
      resolved: Boolean(ref.resolved),
      evidence: ref.kind === "external_img" ? "external IMG/NPK asset, not Script.pvf closure" : ref.raw,
      confidence: ref.resolved ? "high" : "low",
    });
  }
}

async function safeRead(ctx, pvfPath) {
  if (!ctx.pvf.fileSet.has(normalizeKey(pvfPath))) return "";
  try {
    return await ctx.pvf.readText(pvfPath);
  } catch (error) {
    ctx.readErrors.push({ pvfPath: normalizeKey(pvfPath), error: error.message });
    return "";
  }
}

function finalizeArtifact(ctx) {
  const candidates = Array.from(ctx.candidateMap.values())
    .sort((a, b) => compareCandidatesForExpand(ctx.args.expand, a, b))
    .slice(0, ctx.args.limit * 4);
  const high = candidates.filter((item) => item.confidence === "high").length;
  const medium = candidates.filter((item) => item.confidence === "medium").length;
  const low = candidates.filter((item) => item.confidence === "low").length;
  const attackPayloads = candidates
    .filter((item) => item.attackPayload && item.attackPayload.groupCount > 0)
    .map((item) => ({ pvfPath: item.pvfPath, payload: item.attackPayload }));
  return {
    artifactId: ctx.artifactId,
    generatedAt: new Date().toISOString(),
    readonly: true,
    inputs: {
      query: ctx.args.query,
      selectorMode: ctx.args.selectorMode,
      selectorRegistry: ctx.args.selectorRegistry || "",
      pvf: ctx.args.pvf,
      expand: ctx.args.expand,
      depth: ctx.args.depth,
      limit: ctx.args.limit,
      includePvfCourse: ctx.args.includePvfCourse,
    },
    summary: {
      candidateCount: candidates.length,
      highConfidence: high,
      mediumConfidence: medium,
      lowConfidence: low,
      relationCount: ctx.relations.length,
      unresolvedReferenceCount: ctx.unresolvedReferences.length,
      pvfCourseMatches: ctx.pvfCourseMatches.length,
      attackPayloadCount: attackPayloads.length,
      readErrors: ctx.readErrors.length,
      warnings: ctx.warnings.length,
      expandedNodeCount: ctx.expansionStats.expandedNodeCount,
      expansionGuardSkips: ctx.expansionStats.guardSkipCount,
      expansionDepthLimitSkips: ctx.expansionStats.depthLimitSkipCount,
      actionScriptTargetExpansions: ctx.expansionStats.actionScriptTargetExpansionCount,
    },
    searches: ctx.searches,
    candidates,
    relations: ctx.relations.slice(0, ctx.args.limit * 12),
    unresolvedReferences: ctx.unresolvedReferences.slice(0, ctx.args.limit * 6),
    attackPayloads,
    pvfCourseMatches: ctx.pvfCourseMatches,
    warnings: ctx.warnings,
    readErrors: ctx.readErrors,
  };
}

function renderMarkdown(artifact) {
  const lines = [];
  lines.push(`# ${artifact.artifactId}`);
  lines.push("");
  lines.push("本报告由只读 `pvf-scope-planner` 生成，用于定位 PVF 候选范围、引用链和不确定项；不会修改 PVF。");
  lines.push("");
  lines.push("## 输入");
  lines.push("");
  lines.push(`- query: \`${artifact.inputs.query}\``);
  lines.push(`- expand: \`${artifact.inputs.expand}\`, depth=${artifact.inputs.depth}, limit=${artifact.inputs.limit}`);
  lines.push(`- pvf: \`${artifact.inputs.pvf}\``);
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("| --- | ---: |");
  for (const [key, value] of Object.entries(artifact.summary)) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push("");
  lines.push("## 高置信候选");
  lines.push("");
  lines.push("| 置信度 | 类型 | ID | PVF路径 | 名称/理由 |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const item of artifact.candidates.filter((candidate) => candidate.confidence === "high").slice(0, 40)) {
    lines.push(`| ${item.confidence} | ${item.type} | ${item.id ?? ""} | \`${item.pvfPath}\` | ${escapeMd(item.sampleName || item.reasons.slice(0, 2).join("; "))} |`);
  }
  if (!artifact.candidates.some((candidate) => candidate.confidence === "high")) {
    lines.push("| - | - | - | - | 无高置信候选，需要人工缩小关键词或改用 ID/路径。 |");
  }
  lines.push("");
  lines.push("## 其他候选线索");
  lines.push("");
  const secondaryCandidates = artifact.candidates.filter((candidate) => candidate.confidence !== "high").slice(0, 40);
  if (secondaryCandidates.length) {
    lines.push("| 置信度 | 类型 | ID | PVF路径 | 理由 |");
    lines.push("| --- | --- | ---: | --- | --- |");
    for (const item of secondaryCandidates) {
      lines.push(`| ${item.confidence} | ${item.type} | ${item.id ?? ""} | \`${item.pvfPath}\` | ${escapeMd(item.reasons.slice(0, 2).join("; "))} |`);
    }
  } else {
    lines.push("- 没有 medium/low 候选线索。");
  }
  lines.push("");
  lines.push("## 引用链摘要");
  lines.push("");
  lines.push("| 关系 | 来源 | 目标 | 状态 | 证据 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const relation of artifact.relations.slice(0, 80)) {
    lines.push(`| ${relation.relationKind} | \`${compactFileName(relation.source.pvfPath)}\` | \`${relation.target.pvfPath || `${relation.target.type}:${relation.target.id}`}\` | ${relation.resolved ? "closed" : "open"} | ${escapeMd(relation.evidence || "")} |`);
  }
  if (!artifact.relations.length) {
    lines.push("| - | - | - | - | 未展开到确定性引用链。 |");
  }
  lines.push("");
  lines.push("## 结构标签摘要");
  lines.push("");
  const sectionCandidates = artifact.candidates.filter((candidate) => candidate.sectionInventory).slice(0, 30);
  if (sectionCandidates.length) {
    lines.push("| 类型 | PVF路径 | 命中标签 |");
    lines.push("| --- | --- | --- |");
    for (const item of sectionCandidates) {
      const tags = Object.entries(item.sectionInventory)
        .filter(([, value]) => Boolean(value))
        .map(([key]) => key)
        .join("<br>");
      lines.push(`| ${item.type} | \`${item.pvfPath}\` | ${tags || "-"} |`);
    }
  } else {
    lines.push("- 当前展开范围内没有生成 monster/passiveobject 结构标签摘要。");
  }
  lines.push("");
  lines.push("## Attack Payload 摘要");
  lines.push("");
  if (artifact.attackPayloads.length) {
    lines.push("| ATK | 字段分组 |");
    lines.push("| --- | --- |");
    for (const item of artifact.attackPayloads.slice(0, 30)) {
      const groups = Object.entries(item.payload.groups)
        .map(([group, tags]) => `${group}: ${tags.join(", ")}`)
        .join("<br>");
      lines.push(`| \`${item.pvfPath}\` | ${escapeMd(groups)} |`);
    }
  } else {
    lines.push("- 当前展开范围内没有 `.atk` 字段分组摘要。");
  }
  lines.push("");
  lines.push("## 需要人工确认");
  lines.push("");
  if (artifact.unresolvedReferences.length) {
    for (const relation of artifact.unresolvedReferences.slice(0, 20)) {
      lines.push(`- ${relation.relationKind}: \`${relation.source.pvfPath}\` -> \`${relation.target.pvfPath || relation.target.id || ""}\` (${escapeMd(relation.evidence || "unresolved")})`);
    }
  } else {
    lines.push("- 当前展开范围内没有未闭合引用。");
  }
  lines.push("");
  lines.push("## pvfCourse 参考");
  lines.push("");
  if (artifact.pvfCourseMatches.length) {
    lines.push("| 状态 | 主题 | 标题 | 路径/标签样本 |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of artifact.pvfCourseMatches.slice(0, 20)) {
      const sample = [...(item.pvfPaths || []).slice(0, 2), ...(item.tags || []).slice(0, 2).map((tag) => `[${tag}]`)].join("<br>");
      lines.push(`| ${item.status} | ${item.domain} | ${escapeMd(item.title)} | ${sample || ""} |`);
    }
  } else {
    lines.push("- 没有匹配到 pvfCourse 参考；这不影响 PVF 直接证据。");
  }
  lines.push("");
  lines.push("## 下一步建议");
  lines.push("");
  lines.push("- 若高置信候选覆盖范围正确，可进入具体字段检查或 dry-run patch 计划。");
  lines.push("- 若候选过多，改用更精确关键词、ID 或 PVF 路径重新运行。");
  lines.push("- `medium/low` 和 pvfCourse 结果只作为线索，不能单独作为修改范围。");
  return `${lines.join("\n")}\n`;
}

function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function validateArgs(args) {
  if (!args.query) throw new Error("--query is required.");
  if (!args.pvf) throw new Error("--pvf=Script.pvf is required. Refusing to read an implicit default PVF.");
  if (!EXPAND_VALUES.has(args.expand)) throw new Error(`--expand must be one of: ${Array.from(EXPAND_VALUES).join(", ")}`);
  if (!SELECTOR_MODES.has(args.selectorMode)) throw new Error(`--selector-mode must be one of: ${Array.from(SELECTOR_MODES).join(", ")}`);
  if (args.selectorMode === "registry-id" && !/^\d+$/.test(args.query)) throw new Error("registry-id selector requires a numeric --query.");
  if (args.selectorMode === "registry-id" && !REGISTRY_KINDS.has(args.selectorRegistry)) throw new Error("registry-id selector requires a supported --selector-registry.");
  if (!fs.existsSync(args.pvf)) throw new Error(`PVF not found: ${args.pvf}`);
  if (args.includePvfCourse && !args.pvfCourseIndex) throw new Error("--pvfcourse-index=FILE is required when --include-pvfcourse is enabled.");
  if (args.pvfCourseIndex && !fs.existsSync(args.pvfCourseIndex)) throw new Error(`pvfCourse index not found: ${args.pvfCourseIndex}`);
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help || rawArgs["?"]) {
    printUsage();
    return;
  }
  const query = String(rawArgs.query || rawArgs.q || "").trim();
  const slug = slugify(query);
  const outDir = rawArgs["out-dir"] ? path.resolve(rawArgs["out-dir"]) : DEFAULT_OUT_DIR;
  const defaultJsonOut = path.join(outDir, `pvf-scope-plan-${slug}-${DATE_TAG}.json`);
  const defaultMdOut = path.join(outDir, `pvf-scope-plan-${slug}-${DATE_TAG}.zh-CN.md`);
  const args = {
    query,
    pvf: rawArgs.pvf ? path.resolve(rawArgs.pvf) : "",
    out: rawArgs.out ? path.resolve(rawArgs.out) : defaultJsonOut,
    mdOut: rawArgs["md-out"] ? path.resolve(rawArgs["md-out"]) : defaultMdOut,
    limit: numberArg(rawArgs.limit, 30, 1, 300),
    depth: numberArg(rawArgs.depth, 2, 1, 4),
    expand: String(rawArgs.expand || "auto").toLowerCase(),
    selectorMode: String(rawArgs["selector-mode"] || "query").toLowerCase(),
    selectorRegistry: String(rawArgs["selector-registry"] || "").toLowerCase(),
    includePvfCourse: boolArg(rawArgs["include-pvfcourse"], false),
    pvfCourseIndex: rawArgs["pvfcourse-index"] ? path.resolve(rawArgs["pvfcourse-index"]) : "",
    encoding: rawArgs.encoding || "Tw",
  };
  validateArgs(args);

  const native = loadPvfBackend().api;
  const pvf = await openPvf(native, args.pvf, args.encoding);
  const ctx = {
    args,
    pvf,
    artifactId: `pvf-scope-plan-${slug}-${DATE_TAG}`,
    registries: new Map(),
    registryByPath: new Map(),
    candidateMap: new Map(),
    expandedNodes: new Set(),
    expansionStats: {
      expandedNodeCount: 0,
      guardSkipCount: 0,
      depthLimitSkipCount: 0,
      actionScriptTargetExpansionCount: 0,
    },
    relations: [],
    unresolvedReferences: [],
    searches: [],
    pvfCourseMatches: [],
    warnings: [],
    readErrors: [],
    pvfCourseIndex: args.includePvfCourse ? loadJsonIfExists(args.pvfCourseIndex, null) : null,
  };

  try {
    await loadRegistries(ctx);
    await discoverCandidates(ctx);
    await expandCandidates(ctx);
    const artifact = finalizeArtifact(ctx);
    emitTextFile(args.out, `${JSON.stringify(artifact, null, 2)}\n`);
    emitTextFile(args.mdOut, renderMarkdown(artifact));
    console.log(JSON.stringify({ ok: true, out: args.out, mdOut: args.mdOut, summary: artifact.summary }, null, 2));
  } finally {
    await native.closeSession(pvf.sessionId);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
