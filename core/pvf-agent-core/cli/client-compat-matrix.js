"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { assertExternalOutput, pathInside, readJson, safeId, sha256, sha256File, timestamp, writeJsonAtomic } = require("../lib/research-store");
const { loadPvfBackend } = require("../../../tools/pvf-bridge/native-backend");
const { backtickValues, normalizeEncoding, normalizeKey, normalizePvfPath, parseLstContent } = require("../../../tools/pvf-bridge/pvf_graph_common");

const STATUS_VALUES = ["present", "missing", "divergent", "custom-only", "unknown"];
const ROLE_VALUES = new Set(["functional-baseline", "sha-research-baseline", "compatibility-upper-bound"]);
const RESOURCE_MODES = new Set(["metadata", "scoped", "complete"]);
const NPK_HEADER = "NeoplePack_Bill";
const NAME_KEY_PHRASE = "puchikon@neople dungeon and fighter ";
const KNOWN_EXTENSIONS = new Set(["act", "ai", "als", "ani", "apd", "atk", "cre", "dgn", "equ", "etc", "evt", "img", "key", "lst", "map", "mob", "npc", "nut", "obj", "ptl", "qst", "shp", "skl", "sqr", "stk", "str", "til", "twn", "ui"]);

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = String(args[0] || "help").toLowerCase();
let stopRequested = false;

process.on("SIGINT", () => {
  stopRequested = true;
});

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function numberOption(name, fallback, max) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return value;
}

function usage() {
  return `Usage:
  workbench.bat client-matrix build --profile <PRIVATE-CLIENT-MATRIX-PROFILE.json> [--out <external-dir>] [--reuse-cache] [--force]
  workbench.bat client-matrix query --matrix <CLIENT-COMPATIBILITY-MATRIX.json> [--id <probe-id>] [--status <${STATUS_VALUES.join("|")}>] [--target <target-id>] [--limit 50]
  workbench.bat client-matrix verify --matrix <CLIENT-COMPATIBILITY-MATRIX.json> [--rehash-pvfs] [--rehash-anchors] [--refresh-client-metadata]
  workbench.bat client-matrix stats --matrix <CLIENT-COMPATIBILITY-MATRIX.json>
  workbench.bat client-matrix self-test

The matrix is read-only. Full client content is never hashed or copied by default. Resource mode defaults to metadata; scoped or complete NPK index reads require explicit profile settings. NPK/IMG writes are not implemented.
`;
}

function makeNameKey() {
  const key = Buffer.alloc(256);
  const phrase = Buffer.from(NAME_KEY_PHRASE, "utf8");
  const dnf = Buffer.from("DNF", "utf8");
  phrase.copy(key);
  for (let index = phrase.length; index < 255; index += 1) key[index] = dnf[index % 3];
  return key;
}

const NAME_KEY = makeNameKey();

function decodeNpkName(buffer) {
  const plain = Buffer.alloc(256);
  let end = 0;
  for (let index = 0; index < 256; index += 1) {
    plain[index] = buffer[index] ^ NAME_KEY[index];
    if (plain[index] === 0 && end === 0) end = index;
  }
  return normalizePvfPath(plain.subarray(0, end || 256).toString("utf8"));
}

function readExact(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (!count) throw new Error(`Unexpected EOF at offset ${offset + read}`);
    read += count;
  }
  return buffer;
}

function normalizeClientPath(value) {
  return normalizePvfPath(value).toLowerCase();
}

function assetVariants(value) {
  const normalized = normalizeClientPath(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.startsWith("sprite/") ? [normalized, normalized.slice(7)] : [normalized, `sprite/${normalized}`]));
}

function isExactAssetPath(value) {
  return !/[%*?{}\[\]#]/.test(String(value || ""));
}

function extensionOf(value) {
  const base = path.posix.basename(normalizeClientPath(value));
  const index = base.lastIndexOf(".");
  return index === -1 ? "" : base.slice(index + 1).toLowerCase();
}

function hasKnownExtension(value) {
  return KNOWN_EXTENSIONS.has(extensionOf(value));
}

function globRegex(pattern) {
  const escaped = String(pattern || "*")
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(value, patterns) {
  return (patterns || []).some((pattern) => globRegex(pattern).test(String(value || "").replace(/\\/g, "/")));
}

function readOptions(encoding) {
  return {
    pvfEncoding: encoding,
    decompileScript: true,
    decompileBinaryAni: true,
    autoConvertStringLink: false,
    useCompatibleDecompiler: true,
    convertToSimplifiedChinese: false,
  };
}

async function openSession(native, pvf, encoding) {
  const opened = await native.openSession(pvf, encoding);
  return opened.sessionId || opened;
}

async function readPvfText(native, sessionId, pvfPath, encoding) {
  const result = await native.readFile(sessionId, pvfPath, readOptions(encoding));
  if (typeof result.textContent !== "string") throw new Error("PVF backend did not return raw textContent.");
  return result.textContent;
}

function resolveFileRef(fileSet, raw, sourcePath) {
  const normalized = normalizeKey(raw);
  if (!normalized || !hasKnownExtension(normalized)) return null;
  if (extensionOf(normalized) === "img") return { raw, kind: "client-asset", resolved: false, targetPath: normalizePvfPath(raw) };
  const sourceDir = path.posix.dirname(normalizeKey(sourcePath || ""));
  const candidates = [];
  const push = (value) => {
    const candidate = normalizeKey(path.posix.normalize(value));
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  push(normalized);
  push(normalized.replace(/^(\.\.\/)+/, ""));
  if (sourceDir && sourceDir !== ".") push(path.posix.join(sourceDir, normalized));
  for (const root of ["dungeon/", "map/", "monster/", "aicharacter/", "npc/", "equipment/", "passiveobject/", "skill/", "appendage/", "stackable/", "ui/", "etc/", "sqr/", "character/"]) {
    const index = normalized.indexOf(root);
    if (index > 0) push(normalized.slice(index));
  }
  const targetPath = candidates.find((candidate) => fileSet.has(candidate)) || "";
  return { raw, kind: "pvf-file", resolved: Boolean(targetPath), targetPath, candidates: candidates.slice(0, 8) };
}

function detectTextEncoding(file) {
  const fd = fs.openSync(file, "r");
  try {
    const length = Math.min(fs.fstatSync(fd).size, 128 * 1024);
    const sample = readExact(fd, 0, length);
    if (sample.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return "utf-8-bom";
    if (sample.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return "utf-16le-bom";
    if (sample.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return "utf-16be-bom";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return "utf-8-valid-sample";
    } catch {
      return "legacy-or-binary-unknown";
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateProfile(profile) {
  if (profile?.phase !== "private-client-compatibility-profile") throw new Error("Profile phase must be private-client-compatibility-profile.");
  if (!Array.isArray(profile.targets) || profile.targets.length < 3) throw new Error("Profile requires at least three targets.");
  if (!Array.isArray(profile.probes) || profile.probes.length === 0) throw new Error("Profile probes must not be empty.");
  const ids = new Set();
  const roles = new Set();
  for (const target of profile.targets) {
    if (!/^[a-z0-9._-]+$/.test(String(target.id || ""))) throw new Error(`Invalid target id: ${target.id}`);
    if (ids.has(target.id)) throw new Error(`Duplicate target id: ${target.id}`);
    ids.add(target.id);
    if (!ROLE_VALUES.has(target.role)) throw new Error(`Invalid target role: ${target.role}`);
    roles.add(target.role);
    if (!/^[a-f0-9]{64}$/i.test(String(target.pvfSha256 || ""))) throw new Error(`Target ${target.id} must lock a full pvfSha256.`);
    if (!target.pvf || !target.clientRoot) throw new Error(`Target ${target.id} requires pvf and clientRoot.`);
    if (target.role === "functional-baseline" && target.byteExactOfficialOriginalProven !== false) throw new Error("The functional baseline must not claim byte-exact official provenance.");
    if (target.role === "compatibility-upper-bound" && target.officialFieldAuthority !== false) throw new Error("The compatibility upper bound must not claim official field authority.");
  }
  for (const role of ROLE_VALUES) if (!roles.has(role)) throw new Error(`Profile is missing required role: ${role}`);
  const mode = profile.resourceScan?.mode || "metadata";
  if (!RESOURCE_MODES.has(mode)) throw new Error(`Invalid resourceScan.mode: ${mode}`);
  if (mode === "complete" && profile.resourceScan?.explicitCompleteIndexScan !== true) throw new Error("Complete NPK index scan requires explicitCompleteIndexScan=true.");
}

function walkResourceMetadata(root) {
  const pending = [root];
  const records = [];
  while (pending.length) {
    const dir = pending.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && /\.(npk|img)$/i.test(entry.name)) {
        const stats = fs.statSync(full);
        records.push({ relativePath: normalizePvfPath(path.relative(root, full)), bytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs), fullPath: full, extension: path.extname(entry.name).toLowerCase() });
      }
    }
    if (stopRequested) break;
  }
  records.sort((left, right) => normalizeClientPath(left.relativePath).localeCompare(normalizeClientPath(right.relativePath)));
  return records;
}

function metadataFingerprint(records) {
  return sha256(records.map((item) => `${normalizeClientPath(item.relativePath)}\0${item.bytes}\0${item.mtimeMs}`).join("\n"));
}

function readNpkIndexMatches(record, desiredLookup, maxSingleIndexBytes) {
  const fd = fs.openSync(record.fullPath, "r");
  try {
    const headerBytes = readExact(fd, 0, 48);
    const zero = headerBytes.indexOf(0);
    const header = headerBytes.subarray(0, zero >= 0 ? zero : headerBytes.length).toString("utf8");
    if (header !== NPK_HEADER) return { recognized: false, entryCount: 0, indexBytes: 0, indexSha256: null, matches: [] };
    const nextOffset = zero >= 0 ? zero + 1 : headerBytes.length;
    const count = readExact(fd, nextOffset, 4).readInt32LE(0);
    if (count < 0 || count > 500000) throw new Error(`Suspicious NPK entry count ${count}`);
    const indexBytes = count * 264;
    if (indexBytes > maxSingleIndexBytes) throw new Error(`NPK index exceeds maxSingleIndexBytes: ${indexBytes}`);
    const table = readExact(fd, nextOffset + 4, indexBytes);
    const digest = crypto.createHash("sha256");
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const base = index * 264;
      const offset = table.readInt32LE(base);
      const length = table.readInt32LE(base + 4);
      const imgPath = decodeNpkName(table.subarray(base + 8, base + 264));
      const key = normalizeClientPath(imgPath);
      digest.update(`${key}\0${offset}\0${length}\n`);
      const desiredIds = new Set();
      for (const variant of assetVariants(key)) for (const id of desiredLookup.get(variant) || []) desiredIds.add(id);
      if (desiredIds.size) matches.push({ imgPath, offset, length, desiredIds: [...desiredIds].sort() });
    }
    return { recognized: true, entryCount: count, indexBytes, indexSha256: digest.digest("hex"), matches };
  } finally {
    fs.closeSync(fd);
  }
}

function directImgMatches(record, desiredLookup) {
  const desiredIds = new Set();
  for (const variant of assetVariants(record.relativePath)) for (const id of desiredLookup.get(variant) || []) desiredIds.add(id);
  return { recognized: true, entryCount: 1, indexBytes: 0, indexSha256: sha256(`${normalizeClientPath(record.relativePath)}\0${record.bytes}`), matches: desiredIds.size ? [{ imgPath: record.relativePath, offset: 0, length: record.bytes, desiredIds: [...desiredIds].sort() }] : [] };
}

function resourceCacheKey(record, desiredFingerprint) {
  return sha256(`${normalizeClientPath(record.relativePath)}\0${record.bytes}\0${record.mtimeMs}\0${desiredFingerprint}`);
}

function saveResourceCheckpoint(checkpointPath, value) {
  writeJsonAtomic(checkpointPath, { schemaVersion: "1.0", phase: "client-resource-index-checkpoint", generatedAt: new Date().toISOString(), ...value });
}

function scanResources(target, desiredAssets, resourceConfig, targetOut, reuseCache) {
  const imagePacksRoot = path.join(path.resolve(target.clientRoot), resourceConfig.root || "ImagePacks2");
  if (!fs.existsSync(imagePacksRoot) || !fs.statSync(imagePacksRoot).isDirectory()) throw new Error(`ImagePacks2 root does not exist: ${imagePacksRoot}`);
  const records = walkResourceMetadata(imagePacksRoot);
  const fingerprint = metadataFingerprint(records);
  const mode = resourceConfig.mode || "metadata";
  const maxContainers = Number(resourceConfig.maxContainers || 500);
  const maxIndexBytes = Number(resourceConfig.maxIndexBytes || 512 * 1024 * 1024);
  const maxSingleIndexBytes = Number(resourceConfig.maxSingleIndexBytes || 256 * 1024 * 1024);
  const include = resourceConfig.includeContainers || [];
  const selectedAll = mode === "complete" ? records : mode === "scoped" ? records.filter((item) => matchesAny(item.relativePath, include)) : [];
  const selected = selectedAll.slice(0, maxContainers);
  const desiredLookup = new Map();
  for (const asset of desiredAssets) {
    if (!isExactAssetPath(asset.path)) continue;
    for (const variant of assetVariants(asset.path)) {
      if (!desiredLookup.has(variant)) desiredLookup.set(variant, []);
      desiredLookup.get(variant).push(asset.id);
    }
  }
  const desiredFingerprint = sha256(desiredAssets.map((item) => `${item.id}\0${normalizeClientPath(item.path)}`).sort().join("\n"));
  const cachePath = path.join(targetOut, "NPK-INDEX-CACHE.json");
  const checkpointPath = path.join(targetOut, "CLIENT-RESOURCE-CHECKPOINT.json");
  const previous = reuseCache && fs.existsSync(cachePath) ? readJson(cachePath) : { containers: {} };
  const nextCache = { schemaVersion: "1.0", phase: "client-npk-index-cache", targetId: target.id, imagePacksRoot, desiredFingerprint, containers: {} };
  const errors = [];
  const containerResults = [];
  let representedIndexBytes = 0;
  let readIndexBytes = 0;
  let reusedContainerCount = 0;
  let indexLimitHit = selectedAll.length > selected.length;
  for (const [index, record] of selected.entries()) {
    const key = resourceCacheKey(record, desiredFingerprint);
    let result = previous.containers?.[normalizeClientPath(record.relativePath)];
    if (reuseCache && result?.cacheKey === key) {
      reusedContainerCount += 1;
    } else {
      try {
        if (representedIndexBytes >= maxIndexBytes) {
          indexLimitHit = true;
          break;
        }
        result = record.extension === ".npk" ? readNpkIndexMatches(record, desiredLookup, maxSingleIndexBytes) : directImgMatches(record, desiredLookup);
        readIndexBytes += result.indexBytes || 0;
      } catch (error) {
        errors.push({ relativePath: record.relativePath, error: error.message });
        result = { recognized: false, entryCount: 0, indexBytes: 0, indexSha256: null, matches: [], error: error.message };
      }
    }
    representedIndexBytes += result.indexBytes || 0;
    if (representedIndexBytes > maxIndexBytes) {
      indexLimitHit = true;
      break;
    }
    const stored = { ...result, cacheKey: key, relativePath: record.relativePath, bytes: record.bytes, mtimeMs: record.mtimeMs };
    nextCache.containers[normalizeClientPath(record.relativePath)] = stored;
    containerResults.push(stored);
    if ((index + 1) % 250 === 0) process.stderr.write(`${target.id} NPK index ${index + 1}/${selected.length}\n`);
    if (stopRequested) {
      writeJsonAtomic(cachePath, nextCache);
      saveResourceCheckpoint(checkpointPath, { targetId: target.id, stopped: true, completedContainerCount: containerResults.length, selectedContainerCount: selected.length, metadataFingerprint: fingerprint });
      throw new Error("Client resource scan interrupted; checkpoint and cache were saved.");
    }
  }
  writeJsonAtomic(cachePath, nextCache);
  const completeCoverage = mode === "complete" && !indexLimitHit && errors.length === 0 && containerResults.length === records.length;
  const matchesById = new Map(desiredAssets.map((item) => [item.id, []]));
  for (const container of containerResults) {
    for (const match of container.matches || []) {
      for (const id of match.desiredIds || []) matchesById.get(id)?.push({ containerPath: container.relativePath, containerIndexSha256: container.indexSha256, imgPath: match.imgPath, offset: match.offset, length: match.length });
    }
  }
  const assets = desiredAssets.map((asset) => {
    if (!isExactAssetPath(asset.path)) return { id: asset.id, path: asset.path, source: asset.source, exactPath: false, state: "unknown", matches: [], coverage: "dynamic-pattern-not-exact" };
    const matches = matchesById.get(asset.id) || [];
    return { id: asset.id, path: asset.path, source: asset.source, exactPath: true, state: matches.length ? "present" : completeCoverage ? "missing" : "unknown", matches, coverage: completeCoverage ? "complete-index" : mode === "metadata" ? "metadata-only" : "scoped-index" };
  });
  const indexFingerprint = sha256(containerResults.map((item) => `${normalizeClientPath(item.relativePath)}\0${item.indexSha256 || "error"}\0${item.entryCount}`).sort().join("\n"));
  if (fs.existsSync(checkpointPath)) fs.rmSync(checkpointPath, { force: true });
  return {
    imagePacksRoot,
    mode,
    explicitCompleteIndexScan: resourceConfig.explicitCompleteIndexScan === true,
    metadata: { fileCount: records.length, totalBytes: records.reduce((sum, item) => sum + item.bytes, 0), fingerprint, contentHashed: false },
    index: { selectedContainerCount: selected.length, processedContainerCount: containerResults.length, reusedContainerCount, representedIndexBytes, readIndexBytes, indexFingerprint, completeCoverage, indexLimitHit, errorCount: errors.length, errors },
    assets,
    cache: { path: cachePath, sha256: sha256File(cachePath), validation: "relative-path + size + mtimeMs + desired-asset fingerprint" },
  };
}

async function scanPvf(native, target, profile) {
  const pvf = path.resolve(target.pvf);
  const encoding = normalizeEncoding(target.encoding || profile.encoding || "Cn");
  if (!fs.existsSync(pvf) || !fs.statSync(pvf).isFile()) throw new Error(`PVF does not exist: ${pvf}`);
  const beforeSha256 = sha256File(pvf);
  if (beforeSha256.toLowerCase() !== target.pvfSha256.toLowerCase()) throw new Error(`Target ${target.id} PVF SHA mismatch: ${beforeSha256}`);
  const sessionId = await openSession(native, pvf, encoding);
  const readErrors = [];
  try {
    const files = await native.listFiles(sessionId);
    const fileMap = new Map(files.map((item) => [normalizeKey(item.fileName), normalizePvfPath(item.fileName)]));
    const fileSet = new Set(fileMap.keys());
    const registries = [];
    const registryByPath = new Map();
    for (const spec of profile.registries || []) {
      const key = normalizeKey(spec.path);
      if (!fileMap.has(key)) {
        registries.push({ id: spec.id, path: spec.path, state: "missing", entryCount: 0, fingerprint: null });
        continue;
      }
      try {
        const text = await readPvfText(native, sessionId, fileMap.get(key), encoding);
        const parsed = parseLstContent(text, spec.path);
        const fingerprint = sha256(parsed.entries.map((item) => `${item.id}\0${normalizeKey(item.pvfPath)}`).join("\n"));
        registries.push({ id: spec.id, path: spec.path, state: "present", textSha256: sha256(text), entryCount: parsed.entries.length, fingerprint });
        for (const entry of parsed.entries) {
          const entryKey = normalizeKey(entry.pvfPath);
          if (!registryByPath.has(entryKey)) registryByPath.set(entryKey, []);
          registryByPath.get(entryKey).push({ registryId: spec.id, registryPath: spec.path, id: entry.id, pvfPath: entry.pvfPath, targetExists: fileSet.has(entryKey) });
        }
      } catch (error) {
        readErrors.push({ kind: "registry", path: spec.path, error: error.message });
        registries.push({ id: spec.id, path: spec.path, state: "unknown", entryCount: 0, fingerprint: null, error: error.message });
      }
    }
    const probes = [];
    const derivedAssets = new Map();
    for (const probe of profile.probes) {
      const key = normalizeKey(probe.path);
      if (!fileMap.has(key)) {
        probes.push({ id: probe.id, kind: probe.kind || "pvf-file", path: probe.path, state: "missing", registryEvidence: registryByPath.get(key) || [], dependencies: [] });
        continue;
      }
      try {
        const actualPath = fileMap.get(key);
        const text = await readPvfText(native, sessionId, actualPath, encoding);
        const dependencies = [];
        const seen = new Set();
        for (const raw of backtickValues(text)) {
          const ref = resolveFileRef(fileSet, raw, actualPath);
          if (!ref) continue;
          const refKey = `${ref.kind}:${normalizeKey(ref.targetPath || raw)}`;
          if (seen.has(refKey)) continue;
          seen.add(refKey);
          dependencies.push(ref);
          if (ref.kind === "client-asset") {
            const assetPath = normalizePvfPath(ref.targetPath || raw);
            const assetId = `derived-${sha256(assetPath.toLowerCase()).slice(0, 16)}`;
            derivedAssets.set(assetId, { id: assetId, path: assetPath, source: { kind: "pvf-probe", probeId: probe.id, pvfPath: actualPath } });
          }
        }
        probes.push({ id: probe.id, kind: probe.kind || "pvf-file", path: actualPath, state: "present", textSha256: sha256(text), textBytes: Buffer.byteLength(text, "utf8"), registryEvidence: registryByPath.get(key) || [], dependencies });
      } catch (error) {
        readErrors.push({ kind: "probe", path: probe.path, error: error.message });
        probes.push({ id: probe.id, kind: probe.kind || "pvf-file", path: probe.path, state: "unknown", registryEvidence: registryByPath.get(key) || [], dependencies: [], error: error.message });
      }
    }
    const afterSha256 = sha256File(pvf);
    if (beforeSha256 !== afterSha256) throw new Error(`PVF changed during read-only matrix scan: ${pvf}`);
    return { pvf: { path: pvf, sha256: beforeSha256, bytes: fs.statSync(pvf).size, encoding, fileCount: files.length }, registries, probes, derivedAssets: [...derivedAssets.values()], readErrors };
  } finally {
    await native.closeSession(sessionId);
  }
}

function scanClientAnchors(target, profile) {
  const root = path.resolve(target.clientRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Client root does not exist: ${root}`);
  const anchors = [];
  for (const item of profile.clientAnchors || []) {
    const relativePath = typeof item === "string" ? item : item.path;
    const file = path.resolve(root, relativePath);
    if (!pathInside(root, file)) throw new Error(`Client anchor escapes root: ${relativePath}`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      anchors.push({ id: typeof item === "string" ? normalizeClientPath(item) : item.id, relativePath, state: "missing" });
      continue;
    }
    const extension = path.extname(file).toLowerCase();
    anchors.push({ id: typeof item === "string" ? normalizeClientPath(item) : item.id, relativePath, state: "present", bytes: fs.statSync(file).size, sha256: sha256File(file), encodingCandidate: [".txt", ".xml", ".ini", ".cfg", ".toml", ".lua"].includes(extension) ? detectTextEncoding(file) : "binary" });
  }
  let companionPvf = null;
  if (target.clientCompanionPvf) {
    const file = path.resolve(target.clientCompanionPvf);
    companionPvf = fs.existsSync(file) && fs.statSync(file).isFile()
      ? { path: file, state: "present", bytes: fs.statSync(file).size, sha256: sha256File(file), matchesMatrixPvf: sha256File(file) === target.pvfSha256 }
      : { path: file, state: "missing", matchesMatrixPvf: false };
  }
  return { root, anchors, companionPvf };
}

function valueState(value) {
  return value?.state || "unknown";
}

function classifyCells(targetIds, values, signatureFor) {
  const cells = {};
  const present = targetIds.filter((id) => valueState(values[id]) === "present");
  const unknown = new Set(targetIds.filter((id) => valueState(values[id]) === "unknown"));
  const missing = new Set(targetIds.filter((id) => valueState(values[id]) === "missing"));
  const signatures = new Set(present.map((id) => signatureFor(values[id])).filter((value) => value !== null && value !== undefined));
  const loneIsCustomOnly = present.length === 1 && unknown.size === 0 && missing.size === targetIds.length - 1;
  for (const id of targetIds) {
    if (unknown.has(id)) cells[id] = { status: "unknown", evidence: values[id] };
    else if (missing.has(id)) cells[id] = { status: "missing", evidence: values[id] };
    else if (loneIsCustomOnly) cells[id] = { status: "custom-only", evidence: values[id], matrixRelativeOnly: true };
    else if (present.length > 1 && signatures.size > 1) cells[id] = { status: "divergent", evidence: values[id] };
    else cells[id] = { status: "present", evidence: values[id] };
  }
  return cells;
}

function buildMatrix(profile, snapshots) {
  const targetIds = snapshots.map((item) => item.target.id);
  const byTarget = new Map(snapshots.map((item) => [item.target.id, item]));
  const rows = [];
  for (const probe of profile.probes) {
    const values = Object.fromEntries(targetIds.map((id) => [id, byTarget.get(id).pvf.probes.find((item) => item.id === probe.id) || { state: "unknown" }]));
    rows.push({ id: `pvf-file:${probe.id}`, type: "pvf-file", subject: probe.path, cells: classifyCells(targetIds, values, (value) => value.textSha256 || null) });
  }
  for (const registry of profile.registries || []) {
    const values = Object.fromEntries(targetIds.map((id) => [id, byTarget.get(id).pvf.registries.find((item) => item.id === registry.id) || { state: "unknown" }]));
    rows.push({ id: `registry:${registry.id}`, type: "registry", subject: registry.path, cells: classifyCells(targetIds, values, (value) => value.fingerprint || null) });
  }
  for (const anchor of profile.clientAnchors || []) {
    const anchorId = typeof anchor === "string" ? normalizeClientPath(anchor) : anchor.id;
    const relativePath = typeof anchor === "string" ? anchor : anchor.path;
    const values = Object.fromEntries(targetIds.map((id) => [id, byTarget.get(id).client.anchors.find((item) => item.id === anchorId) || { state: "unknown" }]));
    rows.push({ id: `client-anchor:${anchorId}`, type: "client-anchor", subject: relativePath, cells: classifyCells(targetIds, values, (value) => value.sha256 || null) });
  }
  const allAssetIds = new Set(snapshots.flatMap((item) => item.resources.assets.map((asset) => asset.id)));
  for (const assetId of [...allAssetIds].sort()) {
    const values = Object.fromEntries(targetIds.map((id) => [id, byTarget.get(id).resources.assets.find((item) => item.id === assetId) || { state: "unknown" }]));
    const subject = Object.values(values).find((item) => item.path)?.path || assetId;
    rows.push({ id: `client-asset:${assetId}`, type: "client-asset", subject, contentHashUnavailable: true, cells: classifyCells(targetIds, values, (value) => value.matches?.[0]?.length ?? null) });
  }
  const statusCounts = Object.fromEntries(STATUS_VALUES.map((status) => [status, rows.reduce((sum, row) => sum + Object.values(row.cells).filter((cell) => cell.status === status).length, 0)]));
  return { targetIds, rowCount: rows.length, statusCounts, rows };
}

async function build() {
  const profilePath = path.resolve(required("--profile"));
  const profile = readJson(profilePath);
  validateProfile(profile);
  const outRoot = assertExternalOutput(workbenchRoot, option("--out", runtimePath(workbenchRoot, "client-matrix", safeId(profile.profileId || "matrix"), timestamp())));
  const matrixPath = path.join(outRoot, "CLIENT-COMPATIBILITY-MATRIX.json");
  if (fs.existsSync(matrixPath) && !flag("--force")) throw new Error(`Matrix already exists: ${matrixPath}`);
  fs.mkdirSync(outRoot, { recursive: true });
  const native = loadPvfBackend().api;
  const preliminary = [];
  for (const [index, target] of profile.targets.entries()) {
    process.stderr.write(`client matrix PVF ${index + 1}/${profile.targets.length}: ${target.id}\n`);
    const targetOut = path.join(outRoot, "cache", safeId(target.id));
    fs.mkdirSync(targetOut, { recursive: true });
    const pvf = await scanPvf(native, target, profile);
    const client = scanClientAnchors(target, profile);
    preliminary.push({ target, targetOut, pvf, client });
  }
  const explicitAssets = (profile.assetProbes || []).map((item) => ({ id: item.id, path: item.path, source: { kind: "profile" } }));
  const allAssets = new Map([...explicitAssets, ...preliminary.flatMap((item) => item.pvf.derivedAssets)].map((item) => [item.id, item]));
  const snapshots = [];
  for (const [index, item] of preliminary.entries()) {
    const { target, targetOut, pvf, client } = item;
    process.stderr.write(`client matrix resources ${index + 1}/${preliminary.length}: ${target.id}\n`);
    const resources = scanResources(target, [...allAssets.values()], profile.resourceScan || { mode: "metadata" }, targetOut, flag("--reuse-cache"));
    const snapshotFingerprint = sha256(JSON.stringify({ pvfSha256: pvf.pvf.sha256, anchors: client.anchors.map((item) => [item.id, item.sha256 || item.state]), clientCompanionPvf: client.companionPvf?.sha256 || client.companionPvf?.state || null, resourceMetadata: resources.metadata.fingerprint, resourceIndex: resources.index.indexFingerprint }));
    snapshots.push({
      target: {
        id: target.id,
        label: target.label,
        role: target.role,
        byteExactOfficialOriginalProven: target.byteExactOfficialOriginalProven === true,
        officialFieldAuthority: target.officialFieldAuthority === true,
        resourceTemporalAlignment: target.resourceTemporalAlignment || "unknown",
      },
      pvf,
      client,
      resources,
      snapshotFingerprint,
      safety: { readOnly: true, pvfWritten: false, clientWritten: false, npkWritten: false, fullClientContentHashed: false, outputExternalOnly: true },
    });
  }
  const matrix = buildMatrix(profile, snapshots);
  const report = {
    schemaVersion: "1.0",
    phase: "client-pvf-compatibility-matrix",
    generatedAt: new Date().toISOString(),
    profile: { path: profilePath, sha256: sha256File(profilePath), profileId: profile.profileId },
    safety: { readOnly: true, sourcePvfsModified: false, clientWritten: false, npkImgWritten: false, outputExternalOnly: true, largeClientDefault: "metadata-only unless profile explicitly requests scoped/complete NPK indexes" },
    statusValues: STATUS_VALUES,
    roleBoundaries: {
      functionalBaseline: "Stable functional reference only; not proven byte-exact official original.",
      shaResearchBaseline: "Research PVF facts are SHA-bound; companion client resources may have separate temporal alignment.",
      compatibilityUpperBound: "Compatibility pressure and extra-content reference only; custom-only content is not official field authority.",
    },
    snapshots,
    matrix,
    summary: {
      ok: snapshots.length === profile.targets.length && snapshots.every((item) => item.pvf.readErrors.length === 0 && item.resources.index.errorCount === 0 && (item.resources.mode !== "complete" || item.resources.index.completeCoverage)),
      targetCount: snapshots.length,
      matrixRowCount: matrix.rowCount,
      pvfReadErrorCount: snapshots.reduce((sum, item) => sum + item.pvf.readErrors.length, 0),
      resourceIndexErrorCount: snapshots.reduce((sum, item) => sum + item.resources.index.errorCount, 0),
      completeResourceCoverageTargetCount: snapshots.filter((item) => item.resources.index.completeCoverage).length,
      statusCounts: matrix.statusCounts,
    },
  };
  writeJsonAtomic(matrixPath, report);
  process.stdout.write(`${JSON.stringify({ ok: report.summary.ok, command: "build", matrixPath, matrixSha256: sha256File(matrixPath), summary: report.summary, snapshots: snapshots.map((item) => ({ id: item.target.id, pvfSha256: item.pvf.pvf.sha256, snapshotFingerprint: item.snapshotFingerprint, resourceSummary: item.resources.index })) }, null, 2)}\n`);
}

function query() {
  const file = path.resolve(required("--matrix"));
  const report = readJson(file);
  const id = option("--id", "").toLowerCase();
  const status = option("--status", "").toLowerCase();
  const target = option("--target", "");
  const limit = numberOption("--limit", 50, 1000);
  if (status && !STATUS_VALUES.includes(status)) throw new Error(`Invalid status: ${status}`);
  let rows = report.matrix?.rows || [];
  if (id) rows = rows.filter((row) => row.id.toLowerCase().includes(id) || String(row.subject || "").toLowerCase().includes(id));
  if (status) rows = rows.filter((row) => Object.values(row.cells || {}).some((cell) => cell.status === status));
  if (target) rows = rows.filter((row) => row.cells?.[target] && (!status || row.cells[target].status === status));
  rows = rows.slice(0, limit);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "query", matrix: file, matrixSha256: sha256File(file), generatedMatrixIsFinalRuntimeEvidence: false, customOnlyMeansOfficial: false, matchCount: rows.length, rows }, null, 2)}\n`);
}

function currentResourceMetadata(snapshot) {
  const records = walkResourceMetadata(snapshot.resources.imagePacksRoot);
  return { fileCount: records.length, totalBytes: records.reduce((sum, item) => sum + item.bytes, 0), fingerprint: metadataFingerprint(records) };
}

function verify() {
  const file = path.resolve(required("--matrix"));
  const report = readJson(file);
  const errors = [];
  const checks = [];
  if (report.safety?.readOnly !== true || report.safety?.clientWritten !== false || report.safety?.npkImgWritten !== false) errors.push("Matrix safety boundary is invalid.");
  if (!fs.existsSync(report.profile?.path || "")) errors.push("Matrix profile is missing.");
  else {
    const actualProfileSha256 = sha256File(report.profile.path);
    checks.push({ id: "profile", expected: report.profile.sha256, actual: actualProfileSha256, ok: actualProfileSha256 === report.profile.sha256 });
    if (actualProfileSha256 !== report.profile.sha256) errors.push("Matrix profile SHA changed.");
  }
  for (const snapshot of report.snapshots || []) {
    if (flag("--rehash-pvfs")) {
      const actual = sha256File(snapshot.pvf.pvf.path);
      checks.push({ id: `${snapshot.target.id}.pvf`, expected: snapshot.pvf.pvf.sha256, actual, ok: actual === snapshot.pvf.pvf.sha256 });
      if (actual !== snapshot.pvf.pvf.sha256) errors.push(`${snapshot.target.id} PVF SHA changed.`);
      if (snapshot.client.companionPvf?.state === "present") {
        const companionActual = sha256File(snapshot.client.companionPvf.path);
        checks.push({ id: `${snapshot.target.id}.client-companion-pvf`, expected: snapshot.client.companionPvf.sha256, actual: companionActual, ok: companionActual === snapshot.client.companionPvf.sha256, matchesMatrixPvf: companionActual === snapshot.pvf.pvf.sha256 });
        if (companionActual !== snapshot.client.companionPvf.sha256) errors.push(`${snapshot.target.id} client companion PVF changed.`);
      }
    }
    if (flag("--rehash-anchors")) {
      for (const anchor of snapshot.client.anchors || []) {
        if (anchor.state !== "present") continue;
        const actual = sha256File(path.join(snapshot.client.root, anchor.relativePath));
        checks.push({ id: `${snapshot.target.id}.anchor.${anchor.id}`, expected: anchor.sha256, actual, ok: actual === anchor.sha256 });
        if (actual !== anchor.sha256) errors.push(`${snapshot.target.id} anchor changed: ${anchor.relativePath}`);
      }
    }
    if (flag("--refresh-client-metadata")) {
      const actual = currentResourceMetadata(snapshot);
      checks.push({ id: `${snapshot.target.id}.resource-metadata`, expected: snapshot.resources.metadata.fingerprint, actual: actual.fingerprint, ok: actual.fingerprint === snapshot.resources.metadata.fingerprint });
      if (actual.fingerprint !== snapshot.resources.metadata.fingerprint) errors.push(`${snapshot.target.id} resource metadata changed.`);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, command: "verify", matrix: file, matrixSha256: sha256File(file), checks, errors }, null, 2)}\n`);
  if (errors.length) process.exitCode = 1;
}

function stats() {
  const file = path.resolve(required("--matrix"));
  const report = readJson(file);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "stats", matrix: file, matrixSha256: sha256File(file), summary: report.summary, targets: (report.snapshots || []).map((item) => ({ id: item.target.id, role: item.target.role, pvfSha256: item.pvf.pvf.sha256, snapshotFingerprint: item.snapshotFingerprint, resourceMetadata: item.resources.metadata, resourceIndex: item.resources.index })) }, null, 2)}\n`);
}

function selfTest() {
  const targets = ["baseline", "action", "upper"];
  const checks = [];
  checks.push({ id: "neutral-role-contract", ok:
    ROLE_VALUES.has("functional-baseline") &&
    ROLE_VALUES.has("sha-research-baseline") &&
    ROLE_VALUES.has("compatibility-upper-bound") &&
    ROLE_VALUES.size === 3 });
  const present = classifyCells(targets, { baseline: { state: "present", sig: "a" }, action: { state: "present", sig: "a" }, upper: { state: "present", sig: "a" } }, (value) => value.sig);
  checks.push({ id: "present", ok: Object.values(present).every((cell) => cell.status === "present") });
  const divergent = classifyCells(targets, { baseline: { state: "present", sig: "a" }, action: { state: "present", sig: "b" }, upper: { state: "present", sig: "c" } }, (value) => value.sig);
  checks.push({ id: "divergent", ok: Object.values(divergent).every((cell) => cell.status === "divergent") });
  const custom = classifyCells(targets, { baseline: { state: "missing" }, action: { state: "missing" }, upper: { state: "present", sig: "x" } }, (value) => value.sig);
  checks.push({ id: "custom-only-matrix-relative", ok: custom.upper.status === "custom-only" && custom.upper.matrixRelativeOnly === true && custom.baseline.status === "missing" });
  const unknown = classifyCells(targets, { baseline: { state: "unknown" }, action: { state: "present", sig: "x" }, upper: { state: "missing" } }, (value) => value.sig);
  checks.push({ id: "unknown-preserved", ok: unknown.baseline.status === "unknown" && unknown.action.status === "present" });
  checks.push({ id: "scope-glob", ok: matchesAny("sprite/character/swordman.npk", ["**/swordman*.npk"]) && !matchesAny("sprite/character/gunner.npk", ["**/swordman*.npk"]) });
  checks.push({ id: "cache-binding", ok: resourceCacheKey({ relativePath: "a.npk", bytes: 10, mtimeMs: 1 }, "a") !== resourceCacheKey({ relativePath: "a.npk", bytes: 10, mtimeMs: 1 }, "b") });
  checks.push({ id: "dynamic-asset-not-exact", ok: !isExactAssetPath("sprite/body%04d.img") && isExactAssetPath("sprite/body0001.img") });
  const report = { schemaVersion: "1.0", phase: "client-compatibility-matrix-self-test", summary: { ok: checks.every((item) => item.ok), checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length, statusValueCount: STATUS_VALUES.length }, checks };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

async function main() {
  if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else if (command === "build") await build();
  else if (command === "query") query();
  else if (command === "verify") verify();
  else if (command === "stats") stats();
  else if (command === "self-test") selfTest();
  else throw new Error(`Unknown client-matrix command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`ERROR ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
