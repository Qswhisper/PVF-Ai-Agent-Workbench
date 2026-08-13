"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadPvfBackend, loadTypescriptReadonlyBackend } = require("./native-backend");
const { validatePvfEntryPath } = require("./fallback/path-safety.ts");
const {
  directReadReason,
  directSearchReason,
  guardDetails,
  chooseSemanticReadCandidate,
  isVerifiedInlineTextMode,
  retryReadReason,
  retrySearchReason,
  semanticWriteSafety,
} = require("../../core/pvf-agent-core/lib/semantic-read-guard");
const {
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  buildVerifiedInlineTextPatch,
  buildVerifiedInlineTextBatchPatch,
  buildRawAsciiScriptPatch,
} = require("./verified-inline-cn-text");
const {
  analyzeContextAnchoredReplacement,
  applyContextAnchoredReplacement,
  occurrenceMismatch,
} = require("./context-anchored-replace");

const SERVER_MODE_ENV = "PVF_WORKBENCH_SERVER_MODE";
const CONTROLLED_WRITE_MODE = "controlled-write";
const serverMode = String(process.env[SERVER_MODE_ENV] || "read-only").trim().toLowerCase();
if (!new Set(["read-only", CONTROLLED_WRITE_MODE]).has(serverMode)) {
  throw new Error(`${SERVER_MODE_ENV} must be read-only or ${CONTROLLED_WRITE_MODE}.`);
}
if (serverMode === CONTROLLED_WRITE_MODE && String(process.env.PVF_XPILOT_NATIVE || "").trim()) {
  throw new Error("Controlled write mode refuses PVF_XPILOT_NATIVE; use the pinned bundled native backend.");
}

const selectedBackend = loadPvfBackend();
const native = selectedBackend.api;
const effectiveReadOnly = selectedBackend.readOnly || serverMode !== CONTROLLED_WRITE_MODE;
const semanticFallback = !selectedBackend.readOnly
  ? loadTypescriptReadonlyBackend()
  : null;

const sessions = new Map();
const semanticFallbackSessions = new Map();
const sessionTextOverlays = new Map();
const sessionRawOverlays = new Map();
let currentSessionId;
const READ_ONLY_TOOL_NAMES = new Set([
  "pvf_open",
  "pvf_session_info",
  "pvf_close",
  "pvf_list_files",
  "pvf_list_files_page",
  "pvf_search",
  "pvf_list_registries",
  "pvf_resolve_lst_id",
  "pvf_resolve_id",
  "pvf_resolve_path",
  "pvf_summarize_npc_shop",
  "pvf_read_file",
  "pvf_read_files",
]);
const CONTROLLED_WRITE_DEPRECATED_TOOL_NAMES = new Set(["pvf_backup"]);

function assertWritableBackend(operation) {
  if (selectedBackend.readOnly) {
    const error = new Error(
      `The active PVF backend is the TypeScript read-only fallback; ${operation} is blocked. ` +
      "Install the Microsoft Visual C++ v14 x64 runtime and rerun workbench.bat check before preparing or applying PVF writes.",
    );
    error.code = "READ_ONLY_FALLBACK";
    throw error;
  }
  if (serverMode !== CONTROLLED_WRITE_MODE) {
    const error = new Error(
      `${operation} is available only inside workbench.bat pvf-change apply. ` +
      `The ordinary backend server starts in read-only mode by default.`,
    );
    error.code = "CONTROLLED_WRITE_CAPABILITY_REQUIRED";
    throw error;
  }
  return;
}

function assertToolAllowedForSelectedBackend(name, args) {
  if (READ_ONLY_TOOL_NAMES.has(name)) return;
  if (name === "pvf_replace_text" && args?.dryRun === true) return;
  if (name === "pvf_apply_text_plan" && args?.dryRun === true) return;
  assertWritableBackend(`tool ${name}`);
  if (CONTROLLED_WRITE_DEPRECATED_TOOL_NAMES.has(name)) {
    const error = new Error("The standalone PVF backup tool is retired from controlled writes; pvf-change creates and verifies its content-addressed source backup directly.");
    error.code = "BACKUP_TOOL_DEPRECATED";
    throw error;
  }
}

const REGISTRY_CATALOG = [
  { path: "town/town.lst", label: "town", description: "城镇" },
  { path: "region/region.lst", label: "region", description: "区域" },
  { path: "worldmap/worldmap.lst", label: "worldmap", description: "副本接口" },
  { path: "appendage/appendage.lst", label: "appendage", description: "状态/APD" },
  { path: "character/character.lst", label: "character", description: "角色" },
  { path: "equipment/equipment.lst", label: "equipment", description: "装备" },
  { path: "stackable/stackable.lst", label: "stackable", description: "消耗品" },
  { path: "aicharacter/aicharacter.lst", label: "aicharacter", description: "APC/人偶" },
  { path: "dungeon/dungeon.lst", label: "dungeon", description: "副本" },
  { path: "monster/monster.lst", label: "monster", description: "怪物" },
  { path: "creature/creature.lst", label: "creature", description: "宠物" },
  { path: "cashshop/cashshop.lst", label: "cashshop", description: "商城" },
  { path: "map/map.lst", label: "map", description: "地图" },
  { path: "npc/npc.lst", label: "npc", description: "NPC" },
  { path: "itemshop/itemshop.lst", label: "itemshop", description: "NPC商店" },
  { path: "passiveobject/passiveobject.lst", label: "passiveobject", description: "被动对象" },
  { path: "n_quest/quest.lst", label: "quest", description: "任务" },
  { path: "pvp_mission/mission.lst", label: "pvp_mission", description: "PVP任务" },
  { path: "etc/independentdrop.lst", label: "independentdrop", description: "独立掉落" },
  { path: "skill/swordmanskill.lst", label: "swordman_skill", description: "鬼剑士技能" },
  { path: "skill/fighterskill.lst", label: "fighter_skill", description: "格斗家技能" },
  { path: "skill/gunnerskill.lst", label: "gunner_skill", description: "神枪手技能" },
  { path: "skill/mageskill.lst", label: "mage_skill", description: "魔法师技能" },
  { path: "skill/priestskill.lst", label: "priest_skill", description: "圣职者技能" },
  { path: "skill/atgunnerskill.lst", label: "atgunner_skill", description: "女枪手技能" },
  { path: "skill/thiefskill.lst", label: "thief_skill", description: "暗夜使者技能" },
  { path: "skill/atfighterskill.lst", label: "atfighter_skill", description: "男格斗技能" },
  { path: "skill/atmageskill.lst", label: "atmage_skill", description: "男法师技能" },
  { path: "skill/demonicswordman.lst", label: "demonicswordman_skill", description: "黑暗武士技能" },
  { path: "skill/creatormage.lst", label: "creatormage_skill", description: "缔造者技能" },
  { path: "chatemoticon/chatemoticon.lst", label: "chatemoticon", description: "表情", secondary: true },
  { path: "stagemap/stagemap.lst", label: "stagemap", description: "阶段图", secondary: true },
  { path: "aura/aura.lst", label: "aura", description: "光环", secondary: true },
  { path: "pet/pet.lst", label: "pet", description: "宠物/废弃", secondary: true },
];

const ITEM_REGISTRY_PATHS = ["stackable/stackable.lst", "equipment/equipment.lst"];

function getSessionState(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) {
    throw new Error(`Unknown PVF session: ${sessionId}`);
  }
  if (!state.registryCache) {
    state.registryCache = new Map();
  }
  return state;
}

async function ensureSemanticFallbackSession(sessionId) {
  if (!semanticFallback) return null;
  let pending = semanticFallbackSessions.get(sessionId);
  if (!pending) {
    const state = getSessionState(sessionId);
    pending = semanticFallback.openSession(state.sourcePath, state.encoding)
      .then((opened) => {
        const fallbackSessionId = opened && (opened.sessionId || opened.session?.sessionId);
        if (!fallbackSessionId) throw new Error("TypeScript fallback did not return a sessionId.");
        return fallbackSessionId;
      })
      .catch((error) => {
        semanticFallbackSessions.delete(sessionId);
        const wrapped = new Error(
          `Automatic Chinese text safety fallback could not open the PVF: ${error && error.message ? error.message : String(error)}`,
        );
        wrapped.code = "SEMANTIC_READ_GUARD_FAILED";
        throw wrapped;
      });
    semanticFallbackSessions.set(sessionId, pending);
  }
  return pending;
}

async function closeSemanticFallbackSession(sessionId) {
  const pending = semanticFallbackSessions.get(sessionId);
  semanticFallbackSessions.delete(sessionId);
  if (!pending || !semanticFallback) return;
  const fallbackSessionId = await pending;
  await semanticFallback.closeSession(fallbackSessionId);
}

function getTextOverlay(sessionId, pvfPath) {
  return sessionTextOverlays.get(sessionId)?.get(pvfPath) || null;
}

function setTextOverlay(sessionId, pvfPath, file, textContent) {
  let overlays = sessionTextOverlays.get(sessionId);
  if (!overlays) {
    overlays = new Map();
    sessionTextOverlays.set(sessionId, overlays);
  }
  overlays.set(pvfPath, {
    ...file,
    fileName: file?.fileName || pvfPath,
    textContent,
    base64Content: undefined,
  });
}

function getRawOverlay(sessionId, pvfPath) {
  return sessionRawOverlays.get(sessionId)?.get(normalizePvfPath(pvfPath)) || null;
}

function setRawOverlay(sessionId, pvfPath, bytes) {
  let overlays = sessionRawOverlays.get(sessionId);
  if (!overlays) {
    overlays = new Map();
    sessionRawOverlays.set(sessionId, overlays);
  }
  overlays.set(normalizePvfPath(pvfPath), Buffer.from(bytes));
}

function text(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message, data) {
  return {
    content: [{ type: "text", text: data === undefined ? String(message) : JSON.stringify({ error: String(message), data }, null, 2) }],
    isError: true,
  };
}

function normalizePvfPath(value) {
  if (!value || typeof value !== "string") {
    throw new Error("pvfPath is required.");
  }
  return validatePvfEntryPath(value, "PVF path");
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function realPathKey(value) {
  const resolved = fs.realpathSync.native(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameExistingFile(left, right) {
  if (pathKey(left) === pathKey(right)) return true;
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  if (realPathKey(left) === realPathKey(right)) return true;
  const leftStat = fs.statSync(left, { bigint: true });
  const rightStat = fs.statSync(right, { bigint: true });
  return leftStat.ino !== 0n && rightStat.ino !== 0n && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function canonicalCandidatePath(value) {
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const parent = fs.realpathSync.native(path.dirname(resolved));
  return path.join(parent, path.basename(resolved));
}

function assertDistinctFilesystemTarget(sourcePath, targetPath, operation) {
  if (sameExistingFile(sourcePath, targetPath)) {
    const error = new Error(`Refusing ${operation} because its target is the source PVF: ${targetPath}`);
    error.code = "SOURCE_PVF_OVERWRITE_BLOCKED";
    throw error;
  }
  if (pathKey(canonicalCandidatePath(sourcePath)) === pathKey(canonicalCandidatePath(targetPath))) {
    const error = new Error(`Refusing ${operation} because its canonical target is the source PVF: ${targetPath}`);
    error.code = "SOURCE_PVF_OVERWRITE_BLOCKED";
    throw error;
  }
}

function normalizeEncoding(value) {
  const raw = String(value || "Tw").trim();
  const map = new Map([
    ["tw", "Tw"],
    ["cn", "Cn"],
    ["kr", "Kr"],
    ["jp", "Jp"],
    ["utf8", "Utf8"],
    ["utf-8", "Utf8"],
    ["unicode", "Unicode"],
  ]);
  return map.get(raw.toLowerCase()) || raw;
}

function resolveSessionId(args) {
  const sessionId = args && args.sessionId ? String(args.sessionId) : currentSessionId;
  if (!sessionId) {
    throw new Error("No PVF session is open. Call pvf_open first.");
  }
  return sessionId;
}

function getSessionInfo(sessionId) {
  const local = sessions.get(sessionId) || {};
  return { sessionId, ...local };
}

function limitText(value, maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 30000;
  if (!limit || value.length <= limit) {
    return { textContent: value, truncated: false };
  }
  return {
    textContent: value.slice(0, limit),
    truncated: true,
    originalCharCount: value.length,
    returnedCharCount: limit,
  };
}

function sliceLines(value, startLine, endLine) {
  if (!startLine && !endLine) {
    return value;
  }
  const lines = value.split(/\r?\n/);
  const start = Math.max(1, Number(startLine || 1)) - 1;
  const end = endLine ? Math.max(start + 1, Number(endLine)) : lines.length;
  return lines.slice(start, end).join("\n");
}

function makeSearchQuery(args) {
  return {
    keyword: String(args.keyword || ""),
    searchPath: String(args.searchPath || ""),
    isStartMatch: Boolean(args.isStartMatch),
    isUseLikeSearchPath: Boolean(args.isUseLikeSearchPath),
    searchType: args.searchType || "SearchName",
    matchMode: args.matchMode || "Like",
    pvfEncoding: args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : undefined,
    convertToSimplifiedChinese: args.convertToSimplifiedChinese !== false,
    sourceFiles: Array.isArray(args.sourceFiles) ? args.sourceFiles : undefined,
  };
}

function commonReadOptions(args = {}) {
  return {
    pvfEncoding: args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : undefined,
    decompileScript: args.decompileScript !== false,
    decompileBinaryAni: args.decompileBinaryAni !== false,
    autoConvertStringLink: Boolean(args.autoConvertStringLink),
    useCompatibleDecompiler: args.useCompatibleDecompiler !== false,
    convertToSimplifiedChinese: args.convertToSimplifiedChinese !== false,
    semanticVerificationRead: args.semanticVerificationRead === true,
  };
}

async function readPvfFileWithSemanticGuard(sessionId, pvfPath, args = {}) {
  const normalizedPath = normalizePvfPath(pvfPath);
  const options = commonReadOptions(args);
  const session = getSessionState(sessionId);
  const overlay = getTextOverlay(sessionId, normalizedPath);
  if (overlay) {
    return {
      file: overlay,
      semanticReadGuard: {
        applied: true,
        reason: "controlled-write-overlay",
        backend: "native-session-overlay",
        automatic: true,
      },
    };
  }
  const directReason = semanticFallback
    ? directReadReason(normalizedPath, options, session.encoding)
    : null;
  if (directReason) {
    const fallbackSessionId = await ensureSemanticFallbackSession(sessionId);
    const selectedEncoding = options.pvfEncoding || session.encoding;
    return {
      file: await semanticFallback.readFile(fallbackSessionId, normalizedPath, options),
      semanticReadGuard: guardDetails(directReason, {
        requestedEncoding: selectedEncoding,
        selectedEncoding,
      }),
    };
  }

  const file = await native.readFile(sessionId, normalizedPath, options);
  const retryReason = semanticFallback
    ? retryReadReason(file, options, session.encoding)
    : null;
  if (!retryReason) return { file, semanticReadGuard: null };

  const fallbackSessionId = await ensureSemanticFallbackSession(sessionId);
  const fallbackFile = await semanticFallback.readFile(fallbackSessionId, normalizedPath, options);
  return chooseSemanticReadCandidate(file, fallbackFile, options, session.encoding, retryReason);
}

async function searchPvfWithSemanticGuard(sessionId, args = {}) {
  const query = makeSearchQuery(args);
  const session = getSessionState(sessionId);
  const reason = semanticFallback ? directSearchReason(query, session.encoding) : null;
  if (reason) {
    const fallbackSessionId = await ensureSemanticFallbackSession(sessionId);
    return {
      result: await semanticFallback.searchFiles(fallbackSessionId, query),
      semanticReadGuard: guardDetails(reason),
    };
  }
  const result = await native.searchFiles(sessionId, query);
  const retryReason = semanticFallback ? retrySearchReason(result, query, session.encoding) : null;
  if (!retryReason) return { result, semanticReadGuard: null };
  const fallbackSessionId = await ensureSemanticFallbackSession(sessionId);
  return {
    result: await semanticFallback.searchFiles(fallbackSessionId, query),
    semanticReadGuard: guardDetails(retryReason),
  };
}

async function readPvfText(sessionId, pvfPath, args = {}) {
  const { file } = await readPvfFileWithSemanticGuard(sessionId, pvfPath, args);
  if (typeof file.textContent !== "string") {
    throw new Error(`PVF file is not text-readable: ${pvfPath}`);
  }
  return file;
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagBlock(content, tag) {
  const open = `[${tag}]`;
  const close = `[/${tag}]`;
  const start = content.indexOf(open);
  if (start < 0) {
    return "";
  }
  const blockStart = start + open.length;
  const end = content.indexOf(close, blockStart);
  if (end >= 0) {
    return content.slice(blockStart, end);
  }
  const next = content.slice(blockStart).search(/\r?\n\[[^\]]+\]/);
  return next >= 0 ? content.slice(blockStart, blockStart + next) : content.slice(blockStart);
}

function extractBacktickValues(value) {
  return Array.from(String(value || "").matchAll(/`([\s\S]*?)`/g)).map((match) => normalizeWhitespace(match[1]));
}

function extractFirstBacktickAfterTag(content, tag) {
  const values = extractBacktickValues(extractTagBlock(content, tag));
  return values.length ? values[0] : "";
}

function extractFirstNumberAfterTag(content, tag) {
  const block = extractTagBlock(content, tag);
  const match = block.match(/-?\d+/);
  return match ? Number(match[0]) : undefined;
}

function parseLstEntries(content, lstPath) {
  const entries = [];
  const baseDir = path.posix.dirname(normalizePvfPath(lstPath));
  const basePrefix = baseDir === "." ? "" : `${baseDir}/`;
  const lines = String(content || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*(\d+)\s+`([^`]+)`/);
    if (!match) {
      continue;
    }
    const id = Number(match[1]);
    const rawPath = match[2].replace(/\\/g, "/");
    if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
      validatePvfEntryPath(rawPath, `Registry ${lstPath} line ${index + 1}`);
    }
    const candidate = !basePrefix || rawPath.toLowerCase().startsWith(basePrefix.toLowerCase())
      ? rawPath
      : path.posix.join(baseDir, rawPath);
    const resolvedPath = normalizePvfPath(candidate);
    entries.push({
      id,
      rawPath,
      pvfPath: resolvedPath,
      line: index + 1,
    });
  }
  return entries;
}

function registryInfo(lstPath) {
  const normalized = normalizePvfPath(lstPath).toLowerCase();
  return REGISTRY_CATALOG.find((item) => item.path.toLowerCase() === normalized) || {
    path: normalizePvfPath(lstPath),
    label: path.posix.basename(lstPath, ".lst"),
    description: "",
    custom: true,
  };
}

async function getRegistry(sessionId, lstPath, args = {}) {
  const normalized = normalizePvfPath(lstPath).toLowerCase();
  const state = getSessionState(sessionId);
  if (state.registryCache.has(normalized)) {
    return state.registryCache.get(normalized);
  }
  const info = registryInfo(lstPath);
  const file = await readPvfText(sessionId, info.path, args);
  const entries = parseLstEntries(file.textContent, info.path);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const registry = {
    ...info,
    path: info.path,
    metadata: {
      fileName: file.fileName,
      dataLength: file.dataLength,
      isScriptFile: file.isScriptFile,
    },
    entryCount: entries.length,
    entries,
    byId,
  };
  state.registryCache.set(normalized, registry);
  return registry;
}

async function resolveLstId(sessionId, lstPath, id, args = {}) {
  const registry = await getRegistry(sessionId, lstPath, args);
  const numericId = Number(id);
  const entry = registry.byId.get(numericId);
  if (!entry) {
    return {
      found: false,
      id: numericId,
      registry: {
        path: registry.path,
        label: registry.label,
        description: registry.description,
        entryCount: registry.entryCount,
      },
    };
  }
  return {
    found: true,
    id: numericId,
    registry: {
      path: registry.path,
      label: registry.label,
      description: registry.description,
      entryCount: registry.entryCount,
    },
    entry,
  };
}

function summarizeDefinitionText(content) {
  return {
    name: extractFirstBacktickAfterTag(content, "name"),
    name2: extractFirstBacktickAfterTag(content, "name2"),
    explain: extractFirstBacktickAfterTag(content, "explain"),
    type:
      extractFirstBacktickAfterTag(content, "stackable type") ||
      extractFirstBacktickAfterTag(content, "equipment type") ||
      extractFirstBacktickAfterTag(content, "type"),
    subType: extractFirstBacktickAfterTag(content, "sub type"),
    minimumLevel: extractFirstNumberAfterTag(content, "minimum level"),
    rarity: extractFirstNumberAfterTag(content, "rarity"),
    grade: extractFirstNumberAfterTag(content, "grade"),
  };
}

async function summarizeDefinitionFile(sessionId, pvfPath, args = {}) {
  const file = await readPvfText(sessionId, pvfPath, args);
  const summary = summarizeDefinitionText(file.textContent);
  return {
    pvfPath: normalizePvfPath(pvfPath),
    metadata: {
      fileName: file.fileName,
      dataLength: file.dataLength,
      isScriptFile: file.isScriptFile,
    },
    ...summary,
  };
}

async function resolveIdAcrossRegistries(sessionId, id, registryPaths, args = {}) {
  const matches = [];
  for (const registryPath of registryPaths) {
    try {
      const resolved = await resolveLstId(sessionId, registryPath, id, args);
      if (!resolved.found) {
        continue;
      }
      if (args.includeFileSummary === true) {
        try {
          resolved.fileSummary = await summarizeDefinitionFile(sessionId, resolved.entry.pvfPath, args);
        } catch (err) {
          resolved.fileSummaryError = err && err.message ? err.message : String(err);
        }
      }
      matches.push(resolved);
    } catch (err) {
      if (args.includeErrors === true) {
        matches.push({
          found: false,
          id: Number(id),
          registry: { path: normalizePvfPath(registryPath) },
          error: err && err.message ? err.message : String(err),
        });
      }
    }
  }
  return matches;
}

function parseNumericTagList(content, tag) {
  return Array.from(extractTagBlock(content, tag).matchAll(/-?\d+/g)).map((match) => Number(match[0]));
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) {
    const key = getKey(value) || "(unknown)";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function changedPreview(before, after) {
  if (before === after) {
    return { changed: false };
  }
  const prefixLimit = Math.min(before.length, after.length);
  let start = 0;
  while (start < prefixLimit && before[start] === after[start]) {
    start += 1;
  }
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const context = 240;
  return {
    changed: true,
    beforeSnippet: before.slice(Math.max(0, start - context), Math.min(before.length, beforeEnd + 1 + context)),
    afterSnippet: after.slice(Math.max(0, start - context), Math.min(after.length, afterEnd + 1 + context)),
  };
}

async function toolOpen(args) {
  const sourcePath = path.resolve(String(args.path || ""));
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`PVF file does not exist: ${sourcePath}`);
  }
  const encoding = normalizeEncoding(args.encoding);
  const session = await native.openSession(sourcePath, encoding);
  const sessionId = session.sessionId;
  currentSessionId = sessionId;
  sessions.set(sessionId, {
    sourcePath,
    encoding: session.encoding || encoding,
    fileCount: session.fileCount,
    openedAt: new Date().toISOString(),
    backend: selectedBackend.source,
    readOnly: effectiveReadOnly,
    capabilityMode: serverMode,
    semanticReadGuard: {
      enabled: true,
      automatic: true,
      cnFallbackAvailable: selectedBackend.readOnly || Boolean(semanticFallback),
    },
  });
  return text({
    ok: true,
    session: getSessionInfo(sessionId),
  });
}

async function toolSessionInfo(args) {
  const sessionId = args && args.sessionId ? String(args.sessionId) : currentSessionId;
  if (!sessionId) {
    return text({ ok: true, currentSessionId: null, openSessions: [] });
  }
  let nativeInfo;
  try {
    nativeInfo = await native.getSession(sessionId);
  } catch (err) {
    nativeInfo = { nativeError: err && err.message ? err.message : String(err) };
  }
  return text({
    ok: true,
    currentSessionId,
    session: getSessionInfo(sessionId),
    nativeSession: nativeInfo,
    openSessions: Array.from(sessions.keys()),
  });
}

async function toolClose(args) {
  const sessionId = resolveSessionId(args);
  try {
    await closeSemanticFallbackSession(sessionId);
  } finally {
    await native.closeSession(sessionId);
    sessions.delete(sessionId);
    sessionTextOverlays.delete(sessionId);
    sessionRawOverlays.delete(sessionId);
    if (currentSessionId === sessionId) {
      currentSessionId = sessions.keys().next().value;
    }
  }
  return text({ ok: true, closedSessionId: sessionId, currentSessionId: currentSessionId || null });
}

async function toolListFiles(args) {
  const sessionId = resolveSessionId(args);
  const files = await native.listFiles(sessionId);
  const prefix = args.prefix ? String(args.prefix).replace(/\\/g, "/").toLowerCase() : "";
  const contains = args.contains ? String(args.contains).toLowerCase() : "";
  const limit = Math.max(1, Math.min(Number(args.limit || 200), 2000));
  const filtered = files.filter((file) => {
    const name = String(file.fileName || "").toLowerCase();
    return (!prefix || name.startsWith(prefix)) && (!contains || name.includes(contains));
  });
  return text({
    ok: true,
    sessionId,
    totalFileCount: files.length,
    matchedCount: filtered.length,
    returnedCount: Math.min(limit, filtered.length),
    items: filtered.slice(0, limit),
  });
}

async function toolListFilesPage(args) {
  const sessionId = resolveSessionId(args);
  const files = await native.listFiles(sessionId);
  const prefix = args.prefix ? String(args.prefix).replace(/\\/g, "/").toLowerCase() : "";
  const contains = args.contains ? String(args.contains).toLowerCase() : "";
  const offset = Math.max(0, Number(args.offset || 0));
  const limit = Math.max(1, Math.min(Number(args.limit || 2000), 2000));
  const filtered = files.filter((file) => {
    const name = String(file.fileName || "").toLowerCase();
    return (!prefix || name.startsWith(prefix)) && (!contains || name.includes(contains));
  });
  const pageItems = filtered.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return text({
    ok: true,
    sessionId,
    totalFileCount: files.length,
    matchedCount: filtered.length,
    offset,
    limit,
    returnedCount: pageItems.length,
    nextOffset: nextOffset < filtered.length ? nextOffset : null,
    hasMore: nextOffset < filtered.length,
    items: pageItems,
  });
}

async function toolSearch(args) {
  const sessionId = resolveSessionId(args);
  if (!args.keyword) {
    throw new Error("keyword is required.");
  }
  const { result, semanticReadGuard } = await searchPvfWithSemanticGuard(sessionId, args);
  const items = Array.isArray(result.items) ? result.items : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const limit = Math.max(1, Math.min(Number(args.limit || 50), 500));
  const returnedCount = Math.min(limit, items.length);
  return text({
    ok: true,
    sessionId,
    matchedCount: result.matchedCount,
    searchedCount: result.searchedCount,
    returnedCount,
    truncated: Boolean(result.truncated) || items.length > returnedCount,
    errorCount: Number(result.errorCount || 0),
    errorsTruncated: Boolean(result.errorsTruncated),
    errors,
    items: items.slice(0, returnedCount),
    semanticReadGuard: semanticReadGuard || undefined,
  });
}

async function toolReadFile(args) {
  const sessionId = resolveSessionId(args);
  const pvfPath = normalizePvfPath(args.pvfPath);
  const readOptions = {
    pvfEncoding: args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : undefined,
    decompileScript: args.decompileScript !== false,
    decompileBinaryAni: args.decompileBinaryAni !== false,
    autoConvertStringLink: Boolean(args.autoConvertStringLink),
    useCompatibleDecompiler: args.useCompatibleDecompiler !== false,
    convertToSimplifiedChinese: args.convertToSimplifiedChinese !== false,
    semanticVerificationRead: args.semanticVerificationRead === true,
  };
  const { file, semanticReadGuard } = await readPvfFileWithSemanticGuard(sessionId, pvfPath, readOptions);
  const content = typeof file.textContent === "string" ? sliceLines(file.textContent, args.startLine, args.endLine) : undefined;
  const limited = content === undefined ? {} : limitText(content, Number(args.maxChars ?? 30000));
  return text({
    ok: true,
    sessionId,
    pvfPath,
    metadata: {
      fileName: file.fileName,
      dataLength: file.dataLength,
      isScriptFile: file.isScriptFile,
      isBinaryAniFile: file.isBinaryAniFile,
    },
    ...limited,
    base64Content: content === undefined && file.base64Content ? file.base64Content : undefined,
    semanticReadGuard: semanticReadGuard || undefined,
  });
}

async function toolReadFiles(args) {
  const sessionId = resolveSessionId(args);
  const pvfPaths = Array.isArray(args.pvfPaths) ? args.pvfPaths.map(normalizePvfPath) : [];
  if (!pvfPaths.length) throw new Error("pvfPaths must contain at least one path.");
  if (pvfPaths.length > 100) throw new Error("pvfPaths may contain at most 100 paths.");
  const maxCharsPerFile = Math.max(1, Math.min(Number(args.maxCharsPerFile ?? 30000), 1000000));
  const maxTotalChars = Math.max(1, Math.min(Number(args.maxTotalChars ?? 300000), 5000000));
  const items = [];
  const semanticGuardReasons = new Set();
  let returnedCharCount = 0;
  let truncatedByTotalLimit = false;
  for (const pvfPath of pvfPaths) {
    if (returnedCharCount >= maxTotalChars) {
      truncatedByTotalLimit = true;
      items.push({ pvfPath, skipped: true, reason: "maxTotalChars reached" });
      continue;
    }
    try {
      const { file, semanticReadGuard } = await readPvfFileWithSemanticGuard(sessionId, pvfPath, args);
      const content = typeof file.textContent === "string" ? sliceLines(file.textContent, args.startLine, args.endLine) : undefined;
      const remaining = Math.max(0, maxTotalChars - returnedCharCount);
      const limited = content === undefined ? {} : limitText(content, Math.min(maxCharsPerFile, remaining));
      returnedCharCount += String(limited.textContent || "").length;
      items.push({
        ok: true,
        pvfPath,
        metadata: { fileName: file.fileName, dataLength: file.dataLength, isScriptFile: file.isScriptFile, isBinaryAniFile: file.isBinaryAniFile },
        ...limited,
        base64Content: content === undefined && file.base64Content ? file.base64Content : undefined,
        semanticReadGuard: semanticReadGuard || undefined,
      });
      if (semanticReadGuard?.reason) semanticGuardReasons.add(semanticReadGuard.reason);
      if (remaining === 0 || (limited.truncated && remaining <= maxCharsPerFile)) truncatedByTotalLimit = true;
    } catch (error) {
      items.push({ ok: false, pvfPath, error: error && error.message ? error.message : String(error) });
    }
  }
  return text({
    ok: true,
    sessionId,
    requestedCount: pvfPaths.length,
    readCount: items.filter((item) => item.ok).length,
    errorCount: items.filter((item) => item.ok === false).length,
    returnedCharCount,
    truncatedByTotalLimit,
    items,
    semanticReadGuard: semanticGuardReasons.size
      ? {
        applied: true,
        fallbackReadCount: items.filter((item) => item.semanticReadGuard?.applied).length,
        reasons: [...semanticGuardReasons],
        automatic: true,
      }
      : undefined,
  });
}

async function writeText(sessionId, pvfPath, textContent, args) {
  const options = {
    pvfEncoding: args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : undefined,
    compileScript: args.compileScript !== false,
    compileBinaryAni: args.compileBinaryAni !== false,
    convertToTraditionalChinese: Boolean(args.convertToTraditionalChinese),
  };
  return native.upsertTextFileRaw(sessionId, pvfPath, Buffer.from(textContent, "utf8"), options);
}

async function readRawPvfBytes(sessionId, pvfPath) {
  const overlay = getRawOverlay(sessionId, pvfPath);
  if (overlay) return Buffer.from(overlay);
  const file = await native.readFile(sessionId, pvfPath, {
    decompileScript: false,
    decompileBinaryAni: false,
  });
  if (typeof file?.base64Content !== "string") {
    const error = new Error(`PVF file did not return raw Base64 content: ${pvfPath}`);
    error.code = "CN_TEXT_RAW_READ_FAILED";
    throw error;
  }
  return Buffer.from(file.base64Content, "base64");
}

async function writeVerifiedInlineText(sessionId, pvfPath, sourceText, args) {
  const [stringTableBytes, scriptBytes] = await Promise.all([
    readRawPvfBytes(sessionId, "stringtable.bin"),
    readRawPvfBytes(sessionId, pvfPath),
  ]);
  const patch = buildVerifiedInlineTextPatch({
    textWriteMode: args.textWriteMode,
    pvfPath,
    pvfEncoding: args.pvfEncoding,
    fallbackEncoding: getSessionState(sessionId).encoding,
    sourceText,
    previousText: args.previousText,
    newText: args.newText,
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    replaceAll: args.replaceAll === true,
    expectedOccurrences: args.expectedOccurrences,
    prevalidatedEncodingProof: args.prevalidatedEncodingProof,
    stringTableBytes,
    scriptBytes,
  });
  if (patch.noOp) {
    return { ok: true, skipped: true, reason: "no-op verified inline text replacement", proof: patch.proof };
  }
  const stringTableResult = await native.upsertFile(sessionId, "stringtable.bin", {
    base64Content: patch.stringTableBytes.toString("base64"),
  });
  const scriptResult = await native.upsertFile(sessionId, pvfPath, {
    base64Content: patch.scriptBytes.toString("base64"),
  });
  setRawOverlay(sessionId, "stringtable.bin", patch.stringTableBytes);
  setRawOverlay(sessionId, pvfPath, patch.scriptBytes);
  return {
    ok: true,
    mode: patch.analysis.mode,
    encoding: patch.analysis.encoding,
    stringTableResult,
    scriptResult,
    proof: patch.proof,
  };
}

async function writeVerifiedInlineTextBatch(sessionId, pvfPath, sourceText, args) {
  const [stringTableBytes, scriptBytes] = await Promise.all([
    readRawPvfBytes(sessionId, "stringtable.bin"),
    readRawPvfBytes(sessionId, pvfPath),
  ]);
  const patch = buildVerifiedInlineTextBatchPatch({
    pvfPath,
    pvfEncoding: args.pvfEncoding,
    fallbackEncoding: getSessionState(sessionId).encoding,
    sourceText,
    changes: args.changes,
    stringTableBytes,
    scriptBytes,
  });
  if (patch.noOp) {
    return { ok: true, skipped: true, reason: "no-op verified inline text batch", proof: patch.proof, proofs: patch.proofs };
  }
  const stringTableResult = await native.upsertFile(sessionId, "stringtable.bin", {
    base64Content: patch.stringTableBytes.toString("base64"),
  });
  const scriptResult = await native.upsertFile(sessionId, pvfPath, {
    base64Content: patch.scriptBytes.toString("base64"),
  });
  setRawOverlay(sessionId, "stringtable.bin", patch.stringTableBytes);
  setRawOverlay(sessionId, pvfPath, patch.scriptBytes);
  setTextOverlay(sessionId, pvfPath, {
    fileName: pvfPath,
    dataLength: patch.scriptBytes.length,
    isScriptFile: true,
    isBinaryAniFile: false,
  }, patch.sourceText);
  return {
    ok: true,
    mode: patch.mode,
    encoding: patch.encoding,
    changeCount: patch.changeCount,
    stringTableResult,
    scriptResult,
    proof: patch.proof,
    proofs: patch.proofs,
  };
}

async function writeRawAsciiScriptChange(sessionId, pvfPath, sourceText, args) {
  const [stringTableBytes, scriptBytes] = await Promise.all([
    readRawPvfBytes(sessionId, "stringtable.bin"),
    readRawPvfBytes(sessionId, pvfPath),
  ]);
  const patch = buildRawAsciiScriptPatch({
    pvfPath,
    pvfEncoding: args.pvfEncoding,
    fallbackEncoding: getSessionState(sessionId).encoding,
    sourceText,
    previousText: args.previousText,
    newText: args.newText,
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    replaceAll: args.replaceAll === true,
    expectedOccurrences: args.expectedOccurrences,
    stringTableBytes,
    scriptBytes,
  });
  if (patch.noOp) return { ok: true, skipped: true, reason: "no-op raw ASCII script replacement", proof: patch.proof };
  let stringTableResult = null;
  if (patch.stringTableBytes && patch.proof?.stringTableUntouched !== true) {
    stringTableResult = await native.upsertFile(sessionId, "stringtable.bin", {
      base64Content: patch.stringTableBytes.toString("base64"),
    });
    setRawOverlay(sessionId, "stringtable.bin", patch.stringTableBytes);
  }
  const scriptResult = await native.upsertFile(sessionId, pvfPath, {
    base64Content: patch.scriptBytes.toString("base64"),
  });
  setRawOverlay(sessionId, pvfPath, patch.scriptBytes);
  return { ok: true, mode: "raw-ascii-script-token", stringTableResult, scriptResult, proof: patch.proof };
}

async function toolApplyTextPlan(args) {
  if (args.dryRun !== true) assertWritableBackend("PVF same-file text plan");
  const sessionId = resolveSessionId(args);
  const pvfPath = normalizePvfPath(args.pvfPath);
  const changes = Array.isArray(args.changes) ? args.changes : [];
  if (changes.length === 0) throw new Error("changes must contain at least one replacement.");
  const readOptions = {
    pvfEncoding: args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : undefined,
    decompileScript: true,
    decompileBinaryAni: true,
    autoConvertStringLink: false,
    useCompatibleDecompiler: true,
    convertToSimplifiedChinese: false,
    // Every controlled token plan must use the independent canonical
    // decompiler, including an ordinary ASCII-only parameter stage.  The
    // native display decompiler can place numeric and string tokens on
    // different tab/newline boundaries; switching layouts here would make a
    // plan that matched during change-set analysis fail again during proof.
    semanticVerificationRead: true,
  };
  const guardedRead = await readPvfFileWithSemanticGuard(sessionId, pvfPath, readOptions);
  if (typeof guardedRead.file.textContent !== "string") throw new Error("Target file is not text-readable.");
  let plannedText = guardedRead.file.textContent;
  const analyses = [];
  for (const change of changes) {
    if (typeof change.previousText !== "string" || typeof change.newText !== "string") {
      throw new Error("Each plan change requires previousText and newText strings.");
    }
    const changeSourceText = plannedText;
    const anchored = analyzeContextAnchoredReplacement({
      sourceText: changeSourceText,
      previousText: change.previousText,
      newText: change.newText,
      contextBefore: change.contextBefore,
      contextAfter: change.contextAfter,
      occurrenceIndex: change.occurrenceIndex,
      replaceAll: change.replaceAll === true,
      expectedOccurrences: change.expectedOccurrences,
    });
    const mismatch = occurrenceMismatch(anchored);
    if (mismatch) throw mismatch;
    const hits = anchored.occurrenceCount;
    const replaceAll = anchored.replaceAll;
    const expectedOccurrences = anchored.expectedOccurrences;
    const safety = semanticWriteSafety({
      kind: "replace-text", pvfPath,
      pvfEncoding: readOptions.pvfEncoding,
      fallbackEncoding: getSessionState(sessionId).encoding,
      previousText: change.previousText, newText: change.newText,
      contextBefore: change.contextBefore, contextAfter: change.contextAfter,
      replaceAll, expectedOccurrences,
      textWriteMode: change.textWriteMode, sourceText: changeSourceText,
    });
    if (!safety.allowed) {
      const error = new Error(`Controlled PVF write blocked: ${safety.reason}`);
      error.code = safety.code;
      error.details = safety.details || undefined;
      throw error;
    }
    analyses.push({ change, hits, expectedOccurrences, safety, sourceText: changeSourceText, anchored });
    plannedText = applyContextAnchoredReplacement({
      sourceText: plannedText,
      previousText: change.previousText,
      newText: change.newText,
    }, anchored);
  }

  const verifiedAnalyses = analyses.filter((item) => isVerifiedInlineTextMode(item.change.textWriteMode));
  if (verifiedAnalyses.length > 0) {
    const error = new Error("pvf_apply_text_plan only handles ordinary structure changes; verified text uses the coordinated same-file write path.");
    error.code = "TEXT_PLAN_VERIFIED_STAGE_REQUIRED";
    throw error;
  }
  let rawScriptBytes = await readRawPvfBytes(sessionId, pvfPath);
  let stringTableBytes = await readRawPvfBytes(sessionId, "stringtable.bin");
  let rawSourceText = guardedRead.file.textContent;
  const proofs = [];
  for (const item of analyses) {
    if (item.change.previousText === item.change.newText) continue;
    const patch = buildRawAsciiScriptPatch({
      pvfPath,
      pvfEncoding: readOptions.pvfEncoding,
      fallbackEncoding: getSessionState(sessionId).encoding,
      sourceText: rawSourceText,
      previousText: item.change.previousText,
      newText: item.change.newText,
      contextBefore: item.change.contextBefore,
      contextAfter: item.change.contextAfter,
      replaceAll: item.change.replaceAll === true,
      expectedOccurrences: item.expectedOccurrences,
      stringTableBytes,
      scriptBytes: rawScriptBytes,
    });
    stringTableBytes = patch.stringTableBytes || stringTableBytes;
    rawScriptBytes = patch.scriptBytes;
    rawSourceText = patch.expectedText;
    proofs.push({ id: item.change.id || null, ...patch.proof });
  }
  if (rawSourceText !== plannedText) {
    const error = new Error("Raw ASCII token plan did not produce the planned final text.");
    error.code = "RAW_ASCII_TOKEN_READBACK_FAILED";
    throw error;
  }
  if (proofs.length > 0) {
    if (args.dryRun !== true) {
      if (proofs.some((proof) => proof.stringTableUntouched !== true)) {
        await native.upsertFile(sessionId, "stringtable.bin", { base64Content: stringTableBytes.toString("base64") });
        setRawOverlay(sessionId, "stringtable.bin", stringTableBytes);
      }
      await native.upsertFile(sessionId, pvfPath, { base64Content: rawScriptBytes.toString("base64") });
      setRawOverlay(sessionId, pvfPath, rawScriptBytes);
      setTextOverlay(sessionId, pvfPath, guardedRead.file, plannedText);
    }
  }
  return text({
    ok: true,
    sessionId,
    pvfPath,
    changeCount: changes.length,
    dryRun: args.dryRun === true,
    finalTextSha256: crypto.createHash("sha256").update(plannedText).digest("hex"),
    results: proofs,
    semanticReadGuard: guardedRead.semanticReadGuard || undefined,
  });
}

async function toolApplyVerifiedTextPlan(args) {
  assertWritableBackend("PVF verified text batch plan");
  const sessionId = resolveSessionId(args);
  const pvfPath = normalizePvfPath(args.pvfPath);
  const changes = Array.isArray(args.changes) ? args.changes : [];
  if (changes.length === 0) throw new Error("changes must contain at least one verified text replacement.");
  if (changes.some((change) => !isVerifiedInlineTextMode(change.textWriteMode))) {
    const error = new Error("pvf_apply_verified_text_plan accepts verified-inline-text changes only.");
    error.code = "CN_TEXT_BATCH_MODE_REQUIRED";
    throw error;
  }
  const encoding = args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : getSessionState(sessionId).encoding;
  if (changes.some((change) => normalizeEncoding(change.pvfEncoding || encoding) !== encoding)) {
    const error = new Error("One verified text batch cannot mix PVF encodings.");
    error.code = "CN_TEXT_BATCH_ENCODING_MISMATCH";
    throw error;
  }
  const guardedRead = await readPvfFileWithSemanticGuard(sessionId, pvfPath, {
    pvfEncoding: encoding,
    decompileScript: true,
    decompileBinaryAni: true,
    autoConvertStringLink: false,
    useCompatibleDecompiler: true,
    convertToSimplifiedChinese: false,
    semanticVerificationRead: true,
  });
  if (typeof guardedRead.file.textContent !== "string") throw new Error("Target file is not text-readable.");
  const writeResult = await writeVerifiedInlineTextBatch(sessionId, pvfPath, guardedRead.file.textContent, {
    pvfEncoding: encoding,
    changes,
  });
  return text({
    ok: true,
    dryRun: false,
    sessionId,
    pvfPath,
    changeCount: changes.length,
    writeResult,
    semanticReadGuard: guardedRead.semanticReadGuard || undefined,
  });
}

async function toolReplaceText(args) {
  if (args.dryRun !== true) assertWritableBackend("PVF text replacement");
  const sessionId = resolveSessionId(args);
  const pvfPath = normalizePvfPath(args.pvfPath);
  if (typeof args.previousText !== "string" || typeof args.newText !== "string") {
    throw new Error("previousText and newText are required strings.");
  }
  const readOptions = {
    pvfEncoding: args.pvfEncoding ? normalizeEncoding(args.pvfEncoding) : undefined,
    decompileScript: true,
    decompileBinaryAni: true,
    autoConvertStringLink: Boolean(args.autoConvertStringLink),
    useCompatibleDecompiler: args.useCompatibleDecompiler !== false,
    convertToSimplifiedChinese: args.convertToSimplifiedChinese !== false,
    // Controlled script writes always bind to the independent decompiler so
    // raw token patches and final readback use one exact source text.
    semanticVerificationRead: true,
  };
  const guardedRead = await readPvfFileWithSemanticGuard(sessionId, pvfPath, readOptions);
  const { file, semanticReadGuard } = guardedRead;
  if (typeof file.textContent !== "string") {
    throw new Error("Target file is not text-readable.");
  }
  const before = file.textContent;
  const anchored = analyzeContextAnchoredReplacement({
    sourceText: before,
    previousText: args.previousText,
    newText: args.newText,
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    occurrenceIndex: args.occurrenceIndex,
    replaceAll: args.replaceAll === true,
    expectedOccurrences: args.expectedOccurrences,
  });
  const mismatch = occurrenceMismatch(anchored);
  if (mismatch) throw mismatch;
  const hits = anchored.occurrenceCount;
  const replaceAll = anchored.replaceAll;
  const expectedOccurrences = anchored.expectedOccurrences;
  const after = applyContextAnchoredReplacement({
    sourceText: before,
    previousText: args.previousText,
    newText: args.newText,
  }, anchored);
  const preview = changedPreview(before, after);
  const writeSafety = semanticWriteSafety({
    kind: "replace-text",
    pvfPath,
    pvfEncoding: readOptions.pvfEncoding,
    fallbackEncoding: getSessionState(sessionId).encoding,
    previousText: args.previousText,
    newText: args.newText,
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    replaceAll,
    expectedOccurrences,
    textWriteMode: args.textWriteMode,
    sourceText: before,
  });
  if (args.dryRun === true) {
    return text({
      ok: true,
      dryRun: true,
      sessionId,
      pvfPath,
      occurrences: hits,
      totalOccurrences: anchored.totalOccurrenceCount,
      contextAnchor: anchored.evidence,
      ...preview,
      semanticReadGuard: semanticReadGuard || undefined,
      semanticWriteSafety: writeSafety,
    });
  }
  if (!preview.changed) {
    return text({
      ok: true,
      dryRun: false,
      skipped: true,
      reason: "no-op replacement",
      sessionId,
      pvfPath,
      occurrences: hits,
      totalOccurrences: anchored.totalOccurrenceCount,
      contextAnchor: anchored.evidence,
      ...preview,
      semanticReadGuard: semanticReadGuard || undefined,
      semanticWriteSafety: writeSafety,
    });
  }
  if (!writeSafety.allowed) {
    const error = new Error(`Controlled PVF write blocked: ${writeSafety.reason}`);
    error.code = writeSafety.code;
    throw error;
  }
  let writeResult;
  if (isVerifiedInlineTextMode(args.textWriteMode)) {
    writeResult = await writeVerifiedInlineText(sessionId, pvfPath, before, args);
  } else if (file.isScriptFile === true) {
    writeResult = await writeRawAsciiScriptChange(sessionId, pvfPath, before, args);
  } else {
    writeResult = await writeText(sessionId, pvfPath, after, args);
  }
  setTextOverlay(sessionId, pvfPath, file, after);
  return text({
    ok: true,
    dryRun: false,
    sessionId,
    pvfPath,
    occurrences: hits,
    totalOccurrences: anchored.totalOccurrenceCount,
    contextAnchor: anchored.evidence,
    writeResult,
    ...preview,
    semanticReadGuard: semanticReadGuard || undefined,
    semanticWriteSafety: writeSafety,
  });
}

async function toolWriteFile(args) {
  assertWritableBackend("PVF file creation");
  const sessionId = resolveSessionId(args);
  const pvfPath = normalizePvfPath(args.pvfPath);
  if (typeof args.textContent !== "string") {
    throw new Error("textContent is required.");
  }
  const writeSafety = semanticWriteSafety({
    kind: "write-file",
    pvfPath,
    pvfEncoding: args.pvfEncoding,
    fallbackEncoding: getSessionState(sessionId).encoding,
    textContent: args.textContent,
  });
  if (!writeSafety.allowed) {
    const error = new Error(`Controlled PVF write blocked: ${writeSafety.reason}`);
    error.code = writeSafety.code;
    throw error;
  }
  const writeResult = await writeText(sessionId, pvfPath, args.textContent, args);
  setTextOverlay(sessionId, pvfPath, {
    fileName: pvfPath,
    dataLength: Buffer.byteLength(args.textContent, "utf8"),
    isScriptFile: args.compileScript !== false,
    isBinaryAniFile: false,
  }, args.textContent);
  return text({ ok: true, sessionId, pvfPath, writeResult, semanticWriteSafety: writeSafety });
}

async function toolSave(args) {
  assertWritableBackend("PVF save");
  const sessionId = resolveSessionId(args);
  const session = getSessionState(sessionId);
  if (!args.targetPath) {
    throw new Error("targetPath is required. Saving over the source PVF is never allowed.");
  }
  if (args.allowOverwriteSource === true) {
    const error = new Error("allowOverwriteSource is not supported; source PVF overwrite is always blocked.");
    error.code = "SOURCE_PVF_OVERWRITE_BLOCKED";
    throw error;
  }
  const targetPath = path.resolve(String(args.targetPath));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  assertDistinctFilesystemTarget(session.sourcePath, targetPath, "PVF save");
  if (fs.existsSync(targetPath)) {
    const error = new Error(`Refusing to overwrite an existing output PVF: ${targetPath}`);
    error.code = "OUTPUT_PVF_ALREADY_EXISTS";
    throw error;
  }

  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let saveResult;
  try {
    saveResult = await native.saveSession(sessionId, tempPath);
    if (fs.existsSync(targetPath)) {
      const error = new Error(`Output PVF appeared while saving; refusing to overwrite it: ${targetPath}`);
      error.code = "OUTPUT_PVF_ALREADY_EXISTS";
      throw error;
    }
    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  return text({ ok: true, sessionId, targetPath, saveResult });
}

async function toolBackup(args) {
  assertWritableBackend("PVF backup for a write run");
  const sourcePath = path.resolve(String(args.path || (currentSessionId && sessions.get(currentSessionId)?.sourcePath) || ""));
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`PVF file does not exist: ${sourcePath}`);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const targetPath = args.targetPath
    ? path.resolve(String(args.targetPath))
    : path.join(path.dirname(sourcePath), `${path.basename(sourcePath)}.${stamp}.bak`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  assertDistinctFilesystemTarget(sourcePath, targetPath, "PVF backup");
  if (fs.existsSync(targetPath)) {
    const error = new Error(`Refusing to overwrite an existing PVF backup: ${targetPath}`);
    error.code = "BACKUP_ALREADY_EXISTS";
    throw error;
  }
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  return text({ ok: true, sourcePath, targetPath });
}

async function toolListRegistries(args) {
  const sessionId = resolveSessionId(args);
  const includeSecondary = args.includeSecondary !== false;
  const includeCounts = args.includeCounts === true;
  const catalog = REGISTRY_CATALOG.filter((item) => includeSecondary || !item.secondary);
  const items = [];
  for (const item of catalog) {
    const row = { ...item };
    if (includeCounts) {
      try {
        const registry = await getRegistry(sessionId, item.path, args);
        row.entryCount = registry.entryCount;
        row.dataLength = registry.metadata.dataLength;
      } catch (err) {
        row.error = err && err.message ? err.message : String(err);
      }
    }
    items.push(row);
  }
  return text({
    ok: true,
    sessionId,
    totalCount: items.length,
    primaryCount: items.filter((item) => !item.secondary).length,
    secondaryCount: items.filter((item) => item.secondary).length,
    items,
  });
}

async function toolResolveLstId(args) {
  const sessionId = resolveSessionId(args);
  if (!args.lstPath) {
    throw new Error("lstPath is required.");
  }
  if (args.id === undefined || args.id === null) {
    throw new Error("id is required.");
  }
  const resolved = await resolveLstId(sessionId, args.lstPath, args.id, args);
  if (resolved.found && args.includeFileSummary !== false) {
    try {
      resolved.fileSummary = await summarizeDefinitionFile(sessionId, resolved.entry.pvfPath, args);
    } catch (err) {
      resolved.fileSummaryError = err && err.message ? err.message : String(err);
    }
  }
  return text({ ok: true, sessionId, ...resolved });
}

async function toolResolveId(args) {
  const sessionId = resolveSessionId(args);
  if (args.id === undefined || args.id === null) {
    throw new Error("id is required.");
  }
  const includeSecondary = args.includeSecondary === true;
  const registryPaths = Array.isArray(args.registryPaths)
    ? args.registryPaths
    : REGISTRY_CATALOG.filter((item) => includeSecondary || !item.secondary).map((item) => item.path);
  const matches = await resolveIdAcrossRegistries(sessionId, args.id, registryPaths, {
    ...args,
    includeFileSummary: args.includeFileSummary === true,
  });
  return text({
    ok: true,
    sessionId,
    id: Number(args.id),
    searchedRegistryCount: registryPaths.length,
    matchedCount: matches.length,
    matches,
  });
}

async function toolResolvePvfPath(args) {
  const sessionId = resolveSessionId(args);
  const pvfPath = normalizePvfPath(args.pvfPath);
  const target = pvfPath.toLowerCase();
  const includeSecondary = args.includeSecondary === true;
  const registryPaths = Array.isArray(args.registryPaths) && args.registryPaths.length
    ? args.registryPaths.map(normalizePvfPath)
    : REGISTRY_CATALOG.filter((item) => includeSecondary || !item.secondary).map((item) => item.path);
  const matches = [];
  const errors = [];
  for (const registryPath of registryPaths) {
    try {
      const registry = await getRegistry(sessionId, registryPath, args);
      for (const entry of registry.entries) {
        if (String(entry.pvfPath || "").toLowerCase() === target) {
          matches.push({ registry: { path: registry.path, label: registry.label, description: registry.description, secondary: Boolean(registry.secondary) }, entry });
        }
      }
    } catch (error) {
      if (args.includeErrors === true) errors.push({ registryPath, error: error && error.message ? error.message : String(error) });
    }
  }
  return text({ ok: true, sessionId, pvfPath, searchedRegistryCount: registryPaths.length, matchedCount: matches.length, matches, errors });
}

async function resolveNpcSource(sessionId, args) {
  if (args.npcPath) {
    return { found: true, pvfPath: normalizePvfPath(args.npcPath), source: "npcPath" };
  }
  if (args.npcId !== undefined && args.npcId !== null) {
    const resolved = await resolveLstId(sessionId, "npc/npc.lst", args.npcId, args);
    return resolved.found
      ? { found: true, pvfPath: resolved.entry.pvfPath, source: "npcId", npcId: Number(args.npcId), registryEntry: resolved.entry }
      : { found: false, reason: "npcId was not found in npc/npc.lst", npcId: Number(args.npcId) };
  }
  if (!args.npcName) {
    return { found: false, reason: "Provide npcName, npcId, or npcPath." };
  }
  const keyword = String(args.npcName);
  const result = await native.searchFiles(sessionId, {
    keyword,
    searchPath: "",
    isStartMatch: false,
    isUseLikeSearchPath: false,
    searchType: "SearchStrings",
    matchMode: "Like",
    convertToSimplifiedChinese: args.convertToSimplifiedChinese !== false,
  });
  const candidates = (Array.isArray(result.items) ? result.items : [])
    .map((item) => String(item.fileName || "").replace(/\\/g, "/"))
    .filter((fileName) => /^npc\/.+\.npc$/i.test(fileName));
  const uniqueCandidates = Array.from(new Set(candidates));
  if (!uniqueCandidates.length) {
    return { found: false, reason: "No NPC file matched npcName.", npcName: keyword };
  }
  const inspected = [];
  for (const candidate of uniqueCandidates.slice(0, 30)) {
    try {
      const file = await readPvfText(sessionId, candidate, args);
      const name = extractFirstBacktickAfterTag(file.textContent, "name");
      const fieldName = extractFirstBacktickAfterTag(file.textContent, "field name");
      inspected.push({ pvfPath: candidate, name, fieldName });
      if (name === keyword || fieldName === keyword) {
        return { found: true, pvfPath: candidate, source: "npcName", npcName: keyword, name, fieldName };
      }
    } catch (err) {
      inspected.push({ pvfPath: candidate, error: err && err.message ? err.message : String(err) });
    }
  }
  if (uniqueCandidates.length === 1) {
    return { found: true, pvfPath: uniqueCandidates[0], source: "npcName", npcName: keyword, inspected };
  }
  return {
    found: false,
    ambiguous: true,
    reason: "Multiple NPC files matched npcName; provide npcPath or npcId.",
    npcName: keyword,
    candidates: inspected,
  };
}

async function toolSummarizeNpcShop(args) {
  const sessionId = resolveSessionId(args);
  const npcSource = await resolveNpcSource(sessionId, args);
  if (!npcSource.found) {
    return text({ ok: true, sessionId, ...npcSource });
  }
  const npcFile = await readPvfText(sessionId, npcSource.pvfPath, args);
  const npcText = npcFile.textContent;
  const itemShopId = extractFirstNumberAfterTag(npcText, "item shop");
  const npcSummary = {
    pvfPath: npcSource.pvfPath,
    source: npcSource.source,
    npcId: npcSource.npcId,
    name: extractFirstBacktickAfterTag(npcText, "name"),
    fieldName: extractFirstBacktickAfterTag(npcText, "field name"),
    itemShopId,
  };
  if (itemShopId === undefined) {
    return text({ ok: true, sessionId, npc: npcSummary, hasItemShop: false });
  }

  const shopResolved = await resolveLstId(sessionId, "itemshop/itemshop.lst", itemShopId, args);
  if (!shopResolved.found) {
    return text({ ok: true, sessionId, npc: npcSummary, hasItemShop: true, shop: shopResolved });
  }
  const shopFile = await readPvfText(sessionId, shopResolved.entry.pvfPath, args);
  const shopText = shopFile.textContent;
  const sellNumbers = parseNumericTagList(shopText, "sell item");
  const segments = [];
  let current = [];
  for (const value of sellNumbers) {
    if (value === -2) {
      segments.push(current);
      current = [];
    } else if (value > 0) {
      current.push(value);
    }
  }
  if (current.length || !segments.length) {
    segments.push(current);
  }
  const tabNames = extractBacktickValues(extractTagBlock(shopText, "tab name"));
  const itemRegistryPaths = Array.isArray(args.itemRegistryPaths) ? args.itemRegistryPaths : ITEM_REGISTRY_PATHS;
  const allIds = segments.flat();
  const maxItems = Math.max(0, Math.min(Number(args.maxItems || 300), 1000));
  const uniqueIds = Array.from(new Set(allIds.slice(0, maxItems)));
  const resolvedById = new Map();
  for (const id of uniqueIds) {
    const matches = await resolveIdAcrossRegistries(sessionId, id, itemRegistryPaths, {
      ...args,
      includeFileSummary: true,
    });
    resolvedById.set(id, {
      id,
      found: matches.length > 0,
      matches,
      primaryMatch: matches[0],
    });
  }
  const segmentSummaries = segments.map((ids, index) => {
    const resolvedItems = ids.slice(0, maxItems).map((id) => resolvedById.get(id) || { id, found: false, matches: [] });
    return {
      index,
      tabName: tabNames[index] || "",
      itemCount: ids.length,
      resolvedCount: resolvedItems.filter((item) => item.found).length,
      unresolvedIds: resolvedItems.filter((item) => !item.found).map((item) => item.id),
      countsByRegistry: countBy(resolvedItems.filter((item) => item.primaryMatch), (item) => item.primaryMatch.registry.path),
      countsByType: countBy(
        resolvedItems.filter((item) => item.primaryMatch && item.primaryMatch.fileSummary),
        (item) => item.primaryMatch.fileSummary.type
      ),
      samples: resolvedItems
        .filter((item) => item.primaryMatch)
        .slice(0, Number(args.sampleLimit || 12))
        .map((item) => ({
          id: item.id,
          registry: item.primaryMatch.registry.path,
          pvfPath: item.primaryMatch.entry.pvfPath,
          name: item.primaryMatch.fileSummary && item.primaryMatch.fileSummary.name,
          type: item.primaryMatch.fileSummary && item.primaryMatch.fileSummary.type,
          explain: item.primaryMatch.fileSummary && item.primaryMatch.fileSummary.explain,
        })),
    };
  });
  const allResolved = Array.from(resolvedById.values());
  return text({
    ok: true,
    sessionId,
    npc: npcSummary,
    shop: {
      id: itemShopId,
      registryPath: "itemshop/itemshop.lst",
      pvfPath: shopResolved.entry.pvfPath,
      npcField: extractFirstNumberAfterTag(shopText, "NPC"),
      type: extractFirstBacktickAfterTag(shopText, "type"),
      message: extractFirstBacktickAfterTag(shopText, "message"),
      tabNames,
    },
    sellItemCount: allIds.length,
    uniqueSellItemCount: new Set(allIds).size,
    resolvedUniqueItemCount: allResolved.filter((item) => item.found).length,
    unresolvedUniqueIds: allResolved.filter((item) => !item.found).map((item) => item.id),
    truncated: allIds.length > maxItems,
    segments: segmentSummaries,
  });
}

const tools = [
  {
    name: "pvf_open",
    title: "Open PVF",
    description: "Open a PVF archive and create a session for subsequent search/read/write tools.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["Tw", "Cn", "Kr", "Jp", "Utf8", "Unicode"] },
      },
      required: ["path"],
    },
  },
  {
    name: "pvf_session_info",
    title: "PVF Session Info",
    description: "Show the current PVF session and open sessions in this bridge process.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
    },
  },
  {
    name: "pvf_close",
    title: "Close PVF",
    description: "Close an open PVF session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
    },
  },
  {
    name: "pvf_backup",
    title: "Backup PVF",
    description: "Copy a PVF archive to an explicit non-overwriting backup path. The controlled change runner uses its own SHA256-verified content-addressed backup lifecycle.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        targetPath: { type: "string" },
      },
    },
  },
  {
    name: "pvf_list_files",
    title: "List PVF Files",
    description: "List files in the current PVF session, optionally filtered by prefix or substring.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        prefix: { type: "string" },
        contains: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
    },
  },
  {
    name: "pvf_list_files_page",
    title: "List PVF Files Page",
    description: "List a paged slice of files in the current PVF session. Read-only; use offset/limit to export large file indexes safely.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        prefix: { type: "string" },
        contains: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
    },
  },
  {
    name: "pvf_search",
    title: "Search PVF",
    description: "Search file names, names, scripts, strings, numbers, code, or nut text in the current PVF session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        keyword: { type: "string" },
        searchPath: { type: "string" },
        isStartMatch: { type: "boolean" },
        isUseLikeSearchPath: { type: "boolean" },
        searchType: {
          type: "string",
          enum: ["SearchNum", "SearchStrings", "SearchFileName", "SearchScript", "SearchName", "SearchCode", "SearchNutText"],
        },
        matchMode: { type: "string", enum: ["None", "Like", "Regex"] },
        pvfEncoding: { type: "string" },
        dryRun: { type: "boolean" },
        convertToSimplifiedChinese: { type: "boolean" },
        sourceFiles: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["keyword"],
    },
  },
  {
    name: "pvf_list_registries",
    title: "List PVF Registries",
    description: "List known primary .lst registries and optional secondary registries. Use includeCounts=true to parse entry counts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        includeSecondary: { type: "boolean" },
        includeCounts: { type: "boolean" },
        pvfEncoding: { type: "string" },
        convertToSimplifiedChinese: { type: "boolean" },
      },
    },
  },
  {
    name: "pvf_resolve_lst_id",
    title: "Resolve LST ID",
    description: "Resolve an ID through a specific .lst registry, returning the registered PVF path and an optional file summary.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        lstPath: { type: "string" },
        id: { type: "integer" },
        includeFileSummary: { type: "boolean" },
        pvfEncoding: { type: "string" },
        convertToSimplifiedChinese: { type: "boolean" },
      },
      required: ["lstPath", "id"],
    },
  },
  {
    name: "pvf_resolve_id",
    title: "Resolve ID Across Registries",
    description: "Resolve an ID against known .lst registries, or against an explicit registryPaths list.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        id: { type: "integer" },
        registryPaths: { type: "array", items: { type: "string" } },
        includeSecondary: { type: "boolean" },
        includeFileSummary: { type: "boolean" },
        includeErrors: { type: "boolean" },
        pvfEncoding: { type: "string" },
        convertToSimplifiedChinese: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "pvf_resolve_path",
    title: "Resolve PVF Path Across Registries",
    description: "Find the numeric ID and .lst registry entries that register an exact PVF path.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPath: { type: "string" },
        registryPaths: { type: "array", items: { type: "string" } },
        includeSecondary: { type: "boolean" },
        includeErrors: { type: "boolean" },
        pvfEncoding: { type: "string" },
        convertToSimplifiedChinese: { type: "boolean" },
      },
      required: ["pvfPath"],
    },
  },
  {
    name: "pvf_summarize_npc_shop",
    title: "Summarize NPC Shop",
    description:
      "Resolve an NPC's [item shop] through itemshop/itemshop.lst, then summarize shop tabs and sell items through item registries.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        npcName: { type: "string" },
        npcId: { type: "integer" },
        npcPath: { type: "string" },
        itemRegistryPaths: { type: "array", items: { type: "string" } },
        maxItems: { type: "integer", minimum: 0, maximum: 1000 },
        sampleLimit: { type: "integer", minimum: 0, maximum: 50 },
        pvfEncoding: { type: "string" },
        convertToSimplifiedChinese: { type: "boolean" },
      },
    },
  },
  {
    name: "pvf_read_file",
    title: "Read PVF File",
    description: "Read and decompile a text/script file from the current PVF session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPath: { type: "string" },
        pvfEncoding: { type: "string" },
        decompileScript: { type: "boolean" },
        decompileBinaryAni: { type: "boolean" },
        autoConvertStringLink: { type: "boolean" },
        useCompatibleDecompiler: { type: "boolean" },
        convertToSimplifiedChinese: { type: "boolean" },
        semanticVerificationRead: { type: "boolean" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        maxChars: { type: "integer", minimum: 0 },
      },
      required: ["pvfPath"],
    },
  },
  {
    name: "pvf_read_files",
    title: "Read Multiple PVF Files",
    description: "Read and decompile up to 100 explicitly named files in one read-only session with per-file and total output limits.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPaths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        pvfEncoding: { type: "string" },
        decompileScript: { type: "boolean" },
        decompileBinaryAni: { type: "boolean" },
        autoConvertStringLink: { type: "boolean" },
        useCompatibleDecompiler: { type: "boolean" },
        convertToSimplifiedChinese: { type: "boolean" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        maxCharsPerFile: { type: "integer", minimum: 1 },
        maxTotalChars: { type: "integer", minimum: 1 },
      },
      required: ["pvfPaths"],
    },
  },
  {
    name: "pvf_replace_text",
    title: "Replace PVF Text",
    description: "Replace exact PVF text inside the controlled write runner. Optional exact adjacent context can select one target among duplicate text without weakening verified inline Cn/Tw token, encoding, .str, or StringLink protections.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPath: { type: "string" },
        previousText: { type: "string" },
        newText: { type: "string" },
        contextBefore: { type: "string", minLength: 1 },
        contextAfter: { type: "string", minLength: 1 },
        replaceAll: { type: "boolean" },
        expectedOccurrences: { type: "integer", minimum: 1 },
        dryRun: { type: "boolean" },
        pvfEncoding: { type: "string" },
        autoConvertStringLink: { type: "boolean" },
        useCompatibleDecompiler: { type: "boolean" },
        convertToSimplifiedChinese: { type: "boolean" },
        compileScript: { type: "boolean" },
        compileBinaryAni: { type: "boolean" },
        convertToTraditionalChinese: { type: "boolean" },
        textWriteMode: { type: "string", enum: [VERIFIED_INLINE_TEXT_MODE, VERIFIED_INLINE_CN_TEXT_MODE] },
      },
      required: ["pvfPath", "previousText", "newText"],
    },
  },
  {
    name: "pvf_apply_text_plan",
    title: "Apply Same-File Text Plan",
    description: "Atomically apply an ordered set of ordinary replacements to one PVF file, including exact adjacent-context selectors.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPath: { type: "string" },
        pvfEncoding: { type: "string" },
        dryRun: { type: "boolean" },
        compileScript: { type: "boolean" },
        compileBinaryAni: { type: "boolean" },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              previousText: { type: "string" },
              newText: { type: "string" },
              contextBefore: { type: "string", minLength: 1 },
              contextAfter: { type: "string", minLength: 1 },
              replaceAll: { type: "boolean" },
              expectedOccurrences: { type: "integer", minimum: 1 },
              textWriteMode: { type: "string", enum: [VERIFIED_INLINE_TEXT_MODE, VERIFIED_INLINE_CN_TEXT_MODE] },
            },
            required: ["previousText", "newText"],
          },
        },
      },
      required: ["pvfPath", "changes"],
    },
  },
  {
    name: "pvf_apply_verified_text_plan",
    title: "Apply Verified Same-File Text Batch",
    description: "Apply an ordered verified-inline-text batch to one script while rebuilding its string table and raw script only once at the end of the batch.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPath: { type: "string" },
        pvfEncoding: { type: "string" },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              previousText: { type: "string" },
              newText: { type: "string" },
              contextBefore: { type: "string", minLength: 1 },
              contextAfter: { type: "string", minLength: 1 },
              replaceAll: { type: "boolean" },
              expectedOccurrences: { type: "integer", minimum: 1 },
              pvfEncoding: { type: "string" },
              textWriteMode: { type: "string", enum: [VERIFIED_INLINE_TEXT_MODE, VERIFIED_INLINE_CN_TEXT_MODE] },
            },
            required: ["previousText", "newText", "textWriteMode"],
          },
        },
      },
      required: ["pvfPath", "changes"],
    },
  },
  {
    name: "pvf_write_file",
    title: "Write PVF File",
    description: "Write full text content to a file in the open PVF session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pvfPath: { type: "string" },
        textContent: { type: "string" },
        pvfEncoding: { type: "string" },
        compileScript: { type: "boolean" },
        compileBinaryAni: { type: "boolean" },
        convertToTraditionalChinese: { type: "boolean" },
      },
      required: ["pvfPath", "textContent"],
    },
  },
  {
    name: "pvf_save",
    title: "Save PVF",
    description: "Save the open PVF session to a new, non-existing targetPath. Source and existing-output overwrite are always blocked.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        targetPath: { type: "string" },
      },
      required: ["targetPath"],
    },
  },
];

const handlers = {
  pvf_open: toolOpen,
  pvf_session_info: toolSessionInfo,
  pvf_close: toolClose,
  pvf_backup: toolBackup,
  pvf_list_files: toolListFiles,
  pvf_list_files_page: toolListFilesPage,
  pvf_search: toolSearch,
  pvf_list_registries: toolListRegistries,
  pvf_resolve_lst_id: toolResolveLstId,
  pvf_resolve_id: toolResolveId,
  pvf_resolve_path: toolResolvePvfPath,
  pvf_summarize_npc_shop: toolSummarizeNpcShop,
  pvf_read_file: toolReadFile,
  pvf_read_files: toolReadFiles,
  pvf_replace_text: toolReplaceText,
  pvf_apply_text_plan: toolApplyTextPlan,
  pvf_apply_verified_text_plan: toolApplyVerifiedTextPlan,
  pvf_write_file: toolWriteFile,
  pvf_save: toolSave,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  const id = message.id;
  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "pvf-workbench-bundled-backend",
            version: "2.2.2",
            backend: selectedBackend.source,
            readOnly: effectiveReadOnly,
            capabilityMode: serverMode,
            semanticReadGuard: {
              enabled: true,
              automatic: true,
              cnFallbackAvailable: selectedBackend.readOnly || Boolean(semanticFallback),
            },
          },
          instructions:
            selectedBackend.readOnly
              ? "The native backend could not be loaded, so this process is using the read-only TypeScript fallback. Inspection is available; every PVF write is blocked with READ_ONLY_FALLBACK."
              : effectiveReadOnly
                ? "This ordinary backend process is read-only even though the native backend is available. Use workbench.bat pvf-change for controlled writes."
                : "Controlled write capability is active for workbench.bat pvf-change apply. Source and existing-output overwrite remain blocked.",
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      const advertisedTools = effectiveReadOnly
        ? tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name))
        : tools.filter((tool) => !CONTROLLED_WRITE_DEPRECATED_TOOL_NAMES.has(tool.name));
      send({ jsonrpc: "2.0", id, result: { tools: advertisedTools } });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      const fn = handlers[name];
      if (!fn) {
        send({ jsonrpc: "2.0", id, result: errorResult(`Unknown tool: ${name}`) });
        return;
      }
      try {
        assertToolAllowedForSelectedBackend(name, args);
        const result = await fn(args);
        send({ jsonrpc: "2.0", id, result });
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id,
          result: errorResult(
            err && err.message ? err.message : String(err),
            err && err.code ? { code: err.code, ...(err.details ? { details: err.details } : {}) } : undefined,
          ),
        });
      }
      return;
    }
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: err && err.message ? err.message : String(err) } });
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) {
      break;
    }
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) {
      continue;
    }
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      send({ jsonrpc: "2.0", error: { code: -32700, message: err && err.message ? err.message : String(err) } });
    }
  }
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
