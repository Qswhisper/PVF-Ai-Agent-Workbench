"use strict";

const fs = require("fs");
const path = require("path");
const { loadPvfBackend } = require("./native-backend");
const {
  isPathInside,
  resolvePvfPathInside,
  validatePvfEntryPath,
} = require("./fallback/path-safety.ts");

const native = loadPvfBackend().api;

const ROOTS = [
  "aicharacter",
  "appendage",
  "character",
  "common",
  "creature",
  "dungeon",
  "equipment",
  "etc",
  "map",
  "monster",
  "n_quest",
  "npc",
  "passiveobject",
  "pvp_mission",
  "skill",
  "stackable",
  "title",
  "town",
  "worldmap",
];

const TEXT_EXTS = new Set([
  ".aic",
  ".ai",
  ".apd",
  ".atk",
  ".act",
  ".dgn",
  ".equ",
  ".etc",
  ".key",
  ".lay",
  ".lst",
  ".map",
  ".mob",
  ".obj",
  ".ptl",
  ".qst",
  ".skl",
  ".stk",
  ".til",
]);

const FILE_REF_EXTS = new Set([
  ".aic",
  ".ai",
  ".ani",
  ".apd",
  ".atk",
  ".act",
  ".dgn",
  ".equ",
  ".etc",
  ".img",
  ".key",
  ".lay",
  ".map",
  ".mob",
  ".obj",
  ".ptl",
  ".qst",
  ".skl",
  ".stk",
  ".til",
]);

const REGISTRY_PATHS = {
  appendage: "appendage/appendage.lst",
  aicharacter: "aicharacter/aicharacter.lst",
  dungeon: "dungeon/dungeon.lst",
  equipment: "equipment/equipment.lst",
  map: "map/map.lst",
  monster: "monster/monster.lst",
  npc: "npc/npc.lst",
  passiveobject: "passiveobject/passiveobject.lst",
  stackable: "stackable/stackable.lst",
};

const EXT_ROOT_HINTS = {
  ".aic": "aicharacter",
  ".apd": "appendage",
  ".dgn": "dungeon",
  ".equ": "equipment",
  ".map": "map",
  ".mob": "monster",
  ".npc": "npc",
  ".obj": "passiveobject",
  ".qst": "n_quest",
  ".skl": "skill",
  ".stk": "stackable",
};

const SKILL_REGISTRIES = [
  "skill/swordmanskill.lst",
  "skill/fighterskill.lst",
  "skill/gunnerskill.lst",
  "skill/mageskill.lst",
  "skill/priestskill.lst",
  "skill/atgunnerskill.lst",
  "skill/thiefskill.lst",
  "skill/atfighterskill.lst",
  "skill/atmageskill.lst",
  "skill/demonicswordman.lst",
  "skill/creatormage.lst",
];

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printUsage() {
  console.log(`Usage:
  node tools/pvf-bridge/extract-dungeon.js --pvf=Script.pvf --out=extract-dir --dungeon-id=323
  node tools/pvf-bridge/extract-dungeon.js --pvf=Script.pvf --out=extract-dir --dungeon-path=dungeon/Act2/DraconianTower.dgn

Rules:
  --pvf, --out, and one of --dungeon-id, --dungeon-name, or --dungeon-path are required.
  Output must be inside the current workspace and the output directory must not already exist.
`);
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizeKey(value) {
  return normalizePvfPath(value).toLowerCase();
}

function ensureOutputRoot(outputRoot) {
  const resolved = path.resolve(outputRoot);
  const cwd = process.cwd();
  if (!isPathInside(cwd, resolved)) {
    throw new Error(`Refusing to extract outside workspace: ${resolved}`);
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`Output directory already exists: ${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function parseLst(content, lstPath) {
  const baseDir = path.posix.dirname(normalizePvfPath(lstPath));
  const entries = [];
  const byId = new Map();
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+`([^`]+)`/);
    if (!match) {
      continue;
    }
    const id = Number(match[1]);
    const rawPath = normalizePvfPath(match[2]);
    const resolvedPath = normalizePvfPath(
      rawPath.toLowerCase().startsWith(`${baseDir.toLowerCase()}/`) ? rawPath : `${baseDir}/${rawPath}`
    );
    const entry = { id, rawPath, pvfPath: resolvedPath };
    entries.push(entry);
    byId.set(id, entry);
  }
  return { entries, byId };
}

function tagBlocks(content, tag) {
  const blocks = [];
  const open = `[${tag}]`;
  const close = `[/${tag}]`;
  let index = 0;
  for (;;) {
    const start = content.indexOf(open, index);
    if (start < 0) {
      break;
    }
    const contentStart = start + open.length;
    const end = content.indexOf(close, contentStart);
    if (end >= 0) {
      blocks.push(content.slice(contentStart, end));
      index = end + close.length;
      continue;
    }
    const next = content.slice(contentStart).search(/\r?\n\[[^\]]+\]/);
    const contentEnd = next >= 0 ? contentStart + next : content.length;
    blocks.push(content.slice(contentStart, contentEnd));
    index = contentEnd;
  }
  return blocks;
}

function firstTagBlock(content, tag) {
  return tagBlocks(content, tag)[0] || "";
}

function numbers(value) {
  return Array.from(String(value || "").matchAll(/-?\d+/g)).map((match) => Number(match[0]));
}

function tokens(value) {
  return Array.from(String(value || "").matchAll(/`[^`]*`|-?\d+/g)).map((match) => match[0]);
}

function backtickValues(value) {
  return Array.from(String(value || "").matchAll(/`([\s\S]*?)`/g)).map((match) => match[1]);
}

function firstBacktick(content, tag) {
  const values = backtickValues(firstTagBlock(content, tag));
  return values.length ? values[0].replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim() : "";
}

function classifyPath(pvfPath) {
  const parts = normalizePvfPath(pvfPath).split("/");
  return parts[0] || "other";
}

function localPath(outputRoot, pvfPath) {
  return resolvePvfPathInside(outputRoot, pvfPath, "Extracted PVF entry path");
}

function commonReadOptions() {
  return {
    decompileScript: true,
    decompileBinaryAni: true,
    autoConvertStringLink: true,
    useCompatibleDecompiler: true,
    convertToSimplifiedChinese: true,
  };
}

async function readText(sessionId, pvfPath) {
  const file = await native.readFile(sessionId, pvfPath, commonReadOptions());
  if (typeof file.textContent !== "string") {
    return { file, text: undefined };
  }
  return { file, text: file.textContent };
}

async function writeExtractedFile(sessionId, outputRoot, pvfPath) {
  const normalized = validatePvfEntryPath(pvfPath, "Extracted PVF entry path");
  const result = await native.readFile(sessionId, normalized, commonReadOptions());
  const target = localPath(outputRoot, normalized);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realRoot = fs.realpathSync.native(outputRoot);
  const realParent = fs.realpathSync.native(path.dirname(target));
  if (!isPathInside(realRoot, realParent)) {
    const error = new Error(`Refusing to follow an extraction directory link outside the output root: ${realParent}`);
    error.code = "UNSAFE_EXTRACTION_TARGET";
    throw error;
  }
  const finalTarget = path.join(realParent, path.basename(target));
  if (fs.existsSync(finalTarget)) {
    throw new Error(`Refusing to overwrite an existing extracted file: ${finalTarget}`);
  }
  if (typeof result.textContent === "string") {
    fs.writeFileSync(finalTarget, result.textContent, { encoding: "utf8", flag: "wx" });
    return { pvfPath: normalized, type: "text", bytes: Buffer.byteLength(result.textContent, "utf8") };
  }
  if (result.base64Content) {
    const bytes = Buffer.from(result.base64Content, "base64");
    fs.writeFileSync(finalTarget, bytes, { flag: "wx" });
    return { pvfPath: normalized, type: "binary", bytes: bytes.length };
  }
  throw new Error(`Cannot extract unreadable file: ${normalized}`);
}

function parseAiCharacterRows(content) {
  const out = [];
  for (const block of tagBlocks(content, "ai character")) {
    const rawTokens = tokens(block);
    for (let i = 0; i + 7 < rawTokens.length; ) {
      if (rawTokens[i].startsWith("`")) {
        i += 1;
        continue;
      }
      const id = Number(rawTokens[i]);
      const side = String(rawTokens[i + 4] || "").replace(/^`|`$/g, "");
      if (Number.isFinite(id) && side.startsWith("[")) {
        out.push(id);
        i += 8;
      } else {
        i += 1;
      }
    }
  }
  return out;
}

function firstOfFixedGroups(content, tag, groupSize) {
  const out = [];
  for (const block of tagBlocks(content, tag)) {
    const values = numbers(block);
    for (let i = 0; i < values.length; i += groupSize) {
      if (values[i] > 0) {
        out.push(values[i]);
      }
    }
  }
  return out;
}

function pairFirsts(content, tag) {
  return firstOfFixedGroups(content, tag, 2);
}

function tripleFirsts(content, tag) {
  return firstOfFixedGroups(content, tag, 3);
}

function resolveSkillRegistryCandidates(pvfPath) {
  const lower = normalizeKey(pvfPath);
  if (lower.includes("/priest/")) return ["skill/priestskill.lst"];
  if (lower.includes("/swordman/")) return ["skill/swordmanskill.lst"];
  if (lower.includes("/fighter/")) return ["skill/fighterskill.lst"];
  if (lower.includes("/gunner/")) return ["skill/gunnerskill.lst"];
  if (lower.includes("/magician/") || lower.includes("/mage/")) return ["skill/mageskill.lst"];
  if (lower.includes("/atgunner/")) return ["skill/atgunnerskill.lst"];
  if (lower.includes("/atfighter/")) return ["skill/atfighterskill.lst"];
  if (lower.includes("/atmagician/") || lower.includes("/atmage/")) return ["skill/atmageskill.lst"];
  if (lower.includes("/thief/")) return ["skill/thiefskill.lst"];
  if (lower.includes("/demonicswordman/")) return ["skill/demonicswordman.lst"];
  if (lower.includes("/creatormage/")) return ["skill/creatormage.lst"];
  return SKILL_REGISTRIES;
}

class Extractor {
  constructor(sessionId, outputRoot, fileSet, registries) {
    this.sessionId = sessionId;
    this.outputRoot = outputRoot;
    this.fileSet = fileSet;
    this.registries = registries;
    this.queue = [];
    this.queued = new Set();
    this.extracted = [];
    this.registryRefs = new Map();
    this.externalRefs = new Set();
    this.missingRefs = new Map();
    this.readErrors = new Map();
  }

  hasFile(pvfPath) {
    return this.fileSet.has(normalizeKey(pvfPath));
  }

  canonical(pvfPath) {
    const key = normalizeKey(pvfPath);
    return this.fileSet.get(key) || normalizePvfPath(pvfPath);
  }

  add(pvfPath, reason) {
    if (!pvfPath) return false;
    const normalized = normalizePvfPath(pvfPath);
    const key = normalizeKey(normalized);
    if (!this.fileSet.has(key)) {
      if (reason) this.missingRefs.set(`${reason} -> ${normalized}`, normalized);
      return false;
    }
    const canonical = this.fileSet.get(key);
    const canonicalKey = normalizeKey(canonical);
    if (this.queued.has(canonicalKey)) return false;
    this.queued.add(canonicalKey);
    this.queue.push(canonical);
    return true;
  }

  addExternal(value, reason) {
    this.externalRefs.add(`${reason} -> ${value}`);
  }

  addRegistryRef(registryName, id) {
    const registry = this.registries[registryName];
    if (!registry) return false;
    const entry = registry.byId.get(Number(id));
    if (!entry) return false;
    if (!this.registryRefs.has(registryName)) this.registryRefs.set(registryName, new Map());
    this.registryRefs.get(registryName).set(Number(id), entry);
    return this.add(entry.pvfPath, `${registryName}:${id}`);
  }

  addItemId(id) {
    return this.addRegistryRef("stackable", id) || this.addRegistryRef("equipment", id);
  }

  tryResolvePath(currentPath, rawValue) {
    const value = normalizePvfPath(String(rawValue || "").replace(/^`|`$/g, ""));
    if (!value || value.includes("\n")) return undefined;
    const ext = path.posix.extname(value).toLowerCase();
    if (!FILE_REF_EXTS.has(ext)) return undefined;

    const currentDir = path.posix.dirname(normalizePvfPath(currentPath));
    const candidates = [];
    candidates.push(value);
    candidates.push(path.posix.normalize(`${currentDir}/${value}`));

    const currentRoot = classifyPath(currentPath);
    if (!ROOTS.includes(value.split("/")[0].toLowerCase())) {
      candidates.push(path.posix.normalize(`${currentRoot}/${value}`));
    }

    const hintedRoot = EXT_ROOT_HINTS[ext];
    if (hintedRoot) {
      candidates.push(path.posix.normalize(`${hintedRoot}/${value}`));
    }

    if (currentPath.toLowerCase().endsWith(".aic")) {
      if (ext === ".ai") candidates.push(path.posix.normalize(`${currentDir}/ai/${value}`));
      if (ext === ".key") candidates.push(path.posix.normalize(`${currentDir}/key/${value}`));
    }

    for (const candidate of candidates) {
      const normalized = normalizePvfPath(candidate);
      if (this.hasFile(normalized)) {
        return this.canonical(normalized);
      }
    }

    if (ext === ".img") {
      this.addExternal(value, currentPath);
    } else {
      this.missingRefs.set(`${currentPath} -> ${value}`, value);
    }
    return undefined;
  }

  addFileReferences(currentPath, content) {
    for (const value of backtickValues(content)) {
      const resolved = this.tryResolvePath(currentPath, value);
      if (resolved) this.add(resolved, `${currentPath}:file-ref`);
    }
  }

  addNumericReferences(currentPath, content) {
    const lower = normalizeKey(currentPath);

    for (const block of tagBlocks(content, "map specification")) {
      const values = numbers(block);
      if (values.length >= 3) this.addRegistryRef("map", values[2]);
    }
    for (const block of tagBlocks(content, "boss map specification")) {
      const values = numbers(block);
      if (values.length >= 3) this.addRegistryRef("map", values[2]);
    }

    for (const id of parseAiCharacterRows(content)) this.addRegistryRef("aicharacter", id);
    for (const id of firstOfFixedGroups(content, "monster", 4)) this.addRegistryRef("monster", id);
    for (const id of firstOfFixedGroups(content, "passive object", 4)) this.addRegistryRef("passiveobject", id);
    for (const block of tagBlocks(content, "special passive object")) {
      for (const id of numbers(block)) this.addRegistryRef("passiveobject", id);
    }
    for (const id of firstOfFixedGroups(content, "NPC", 5)) this.addRegistryRef("npc", id);
    for (const id of numbers(firstTagBlock(content, "pathgate object"))) this.addRegistryRef("passiveobject", id);

    for (const id of tripleFirsts(content, "equipment")) this.addRegistryRef("equipment", id);
    for (const id of pairFirsts(content, "quick item")) this.addItemId(id);
    for (const id of pairFirsts(content, "required item")) this.addItemId(id);
    for (const id of pairFirsts(content, "need material")) this.addItemId(id);
    for (const id of pairFirsts(content, "drop item")) this.addItemId(id);
    for (const id of pairFirsts(content, "reward item")) this.addItemId(id);
    for (const id of numbers(firstTagBlock(content, "bead item"))) this.addItemId(id);

    for (const id of numbers(firstTagBlock(content, "summon monster"))) this.addRegistryRef("monster", id);
    for (const block of tagBlocks(content, "CREATE PASSIVEOBJECT")) {
      const indexValues = numbers(firstTagBlock(block, "INDEX"));
      for (const id of indexValues) this.addRegistryRef("passiveobject", id);
    }

    if (lower.startsWith("aicharacter/") || lower.startsWith("monster/")) {
      const skillRegistries = resolveSkillRegistryCandidates(currentPath);
      for (const id of pairFirsts(content, "skill").concat(pairFirsts(content, "quick skill"))) {
        for (const registryPath of skillRegistries) {
          const registry = this.registries[registryPath];
          if (registry && registry.byId.has(id)) {
            if (!this.registryRefs.has(registryPath)) this.registryRefs.set(registryPath, new Map());
            const entry = registry.byId.get(id);
            this.registryRefs.get(registryPath).set(id, entry);
            this.add(entry.pvfPath, `${registryPath}:${id}`);
            break;
          }
        }
      }
    }

    for (const id of numbers(firstTagBlock(content, "appendage"))) this.addRegistryRef("appendage", id);
  }

  async run() {
    for (let cursor = 0; cursor < this.queue.length; cursor += 1) {
      const pvfPath = this.queue[cursor];
      try {
        const extracted = await writeExtractedFile(this.sessionId, this.outputRoot, pvfPath);
        this.extracted.push(extracted);
        const { text } = await readText(this.sessionId, pvfPath);
        if (typeof text === "string") {
          this.addFileReferences(pvfPath, text);
          this.addNumericReferences(pvfPath, text);
        }
      } catch (err) {
        this.readErrors.set(pvfPath, err && err.message ? err.message : String(err));
      }
    }
  }
}

async function loadRegistries(sessionId) {
  const out = {};
  for (const [name, registryPath] of Object.entries(REGISTRY_PATHS)) {
    const { text } = await readText(sessionId, registryPath);
    out[name] = parseLst(text, registryPath);
  }
  for (const registryPath of SKILL_REGISTRIES) {
    const { text } = await readText(sessionId, registryPath);
    out[registryPath] = parseLst(text, registryPath);
  }
  return out;
}

async function findDungeon(sessionId, registries, targetName, targetPath, targetId) {
  if (targetPath) {
    return { id: targetId || null, pvfPath: normalizePvfPath(targetPath), name: targetName || "" };
  }
  if (targetId !== undefined && targetId !== null) {
    const entry = registries.dungeon.byId.get(Number(targetId));
    if (!entry) throw new Error(`Dungeon id was not found: ${targetId}`);
    const { text } = await readText(sessionId, entry.pvfPath);
    return { id: Number(targetId), pvfPath: entry.pvfPath, name: firstBacktick(text, "name") };
  }
  if (!targetName) throw new Error("Provide --dungeon-name, --dungeon-id, or --dungeon-path.");
  const hits = [];
  for (const entry of registries.dungeon.entries) {
    const { text } = await readText(sessionId, entry.pvfPath);
    const name = firstBacktick(text, "name");
    if (name === targetName || name.includes(targetName) || targetName.includes(name)) {
      hits.push({ id: entry.id, pvfPath: entry.pvfPath, name });
    }
  }
  if (!hits.length) throw new Error(`No dungeon matched name: ${targetName}`);
  if (hits.length > 1) throw new Error(`Ambiguous dungeon name: ${targetName}; hits=${JSON.stringify(hits)}`);
  return hits[0];
}

function writeRegistryLists(outputRoot, extractor) {
  let listText = "";
  const registryNames = Array.from(extractor.registryRefs.keys()).sort();
  for (const registryName of registryNames) {
    const entries = Array.from(extractor.registryRefs.get(registryName).values()).sort((a, b) => a.id - b.id);
    listText += `${registryName} needs list\n`;
    for (const entry of entries) {
      listText += `${entry.id}\t\`${entry.rawPath}\`\n`;
    }
    listText += "\n\n";
  }
  fs.writeFileSync(path.join(outputRoot, "list.txt"), listText, "utf8");
}

function writeManifest(outputRoot, dungeon, extractor) {
  const byRoot = {};
  for (const item of extractor.extracted) {
    const root = classifyPath(item.pvfPath);
    byRoot[root] = (byRoot[root] || 0) + 1;
  }
  const manifest = {
    dungeon,
    extractedFileCount: extractor.extracted.length,
    byRoot,
    externalReferenceCount: extractor.externalRefs.size,
    missingReferenceCount: extractor.missingRefs.size,
    readErrorCount: extractor.readErrors.size,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(outputRoot, "extracted-files.txt"), extractor.extracted.map((item) => item.pvfPath).sort().join("\n"), "utf8");
  fs.writeFileSync(path.join(outputRoot, "external_refs.txt"), Array.from(extractor.externalRefs).sort().join("\n"), "utf8");
  fs.writeFileSync(path.join(outputRoot, "missing_refs.txt"), Array.from(extractor.missingRefs.keys()).sort().join("\n"), "utf8");
  fs.writeFileSync(
    path.join(outputRoot, "read_errors.json"),
    JSON.stringify(Object.fromEntries(extractor.readErrors.entries()), null, 2),
    "utf8"
  );
  return manifest;
}

async function main() {
  if (hasFlag("help") || hasFlag("?")) {
    printUsage();
    return;
  }
  const rawPvf = argValue("pvf", "");
  const rawOut = argValue("out", "");
  const dungeonName = argValue("dungeon-name", "");
  const dungeonPath = argValue("dungeon-path", "");
  const dungeonIdRaw = argValue("dungeon-id", "");
  if (!rawPvf) {
    throw new Error("Use --pvf=Script.pvf. Refusing to infer a source PVF from the current directory.");
  }
  if (!rawOut) {
    throw new Error("Use --out=DIR. Refusing to create an implicit extraction directory.");
  }
  if (!dungeonName && !dungeonPath && dungeonIdRaw === "") {
    throw new Error("Use one of --dungeon-id, --dungeon-name, or --dungeon-path.");
  }
  const pvfPath = path.resolve(rawPvf);
  const outputRoot = ensureOutputRoot(rawOut);
  const dungeonId = dungeonIdRaw === "" ? undefined : Number(dungeonIdRaw);

  const session = await native.openSession(pvfPath, "Tw");
  try {
    const files = await native.listFiles(session.sessionId);
    const fileSet = new Map();
    for (const file of files) {
      const safePath = validatePvfEntryPath(file.fileName, "PVF file-tree entry");
      const key = normalizeKey(safePath);
      if (fileSet.has(key)) {
        throw new Error(`PVF file tree contains a duplicate normalized path: ${safePath}`);
      }
      fileSet.set(key, safePath);
    }
    const registries = await loadRegistries(session.sessionId);
    const dungeon = await findDungeon(session.sessionId, registries, dungeonName, dungeonPath, dungeonId);
    const extractor = new Extractor(session.sessionId, outputRoot, fileSet, registries);
    extractor.addRegistryRef("dungeon", dungeon.id);
    extractor.add(dungeon.pvfPath, "target-dungeon");
    await extractor.run();
    writeRegistryLists(outputRoot, extractor);
    const manifest = writeManifest(outputRoot, dungeon, extractor);
    console.log(JSON.stringify({ ok: true, outputRoot, manifest }, null, 2));
  } finally {
    await native.closeSession(session.sessionId);
  }
}

main().catch((err) => {
  const code = err?.code ? `[${err.code}] ` : "";
  console.error(`ERROR ${code}${err?.message || String(err)}`);
  if (process.argv.includes("--debug") && err?.stack) console.error(err.stack);
  process.exit(1);
});
