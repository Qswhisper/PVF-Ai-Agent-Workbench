"use strict";

const crypto = require("crypto");
const path = require("path");

// These are deliberately narrow modes.  A caller cannot turn a protected
// extension into a generic write by merely setting a boolean; the controlled
// runner still performs the target-PVF checks in pvf-change-set.js.
const HIGH_RISK_NEW_FILE_MODES = Object.freeze({
  ".wdm": "worldmap-lifecycle",
  ".lst": "registry-lifecycle",
  ".co": "script-new-file",
  ".nut": "script-new-file",
  ".sqr": "script-new-file",
  ".str": "localization-new-file",
});

const PROTECTED_EXISTING_FILE_EXTENSIONS = new Set([
  ".co", ".lst", ".nut", ".sqr", ".str",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function extensionOf(pvfPath) {
  return path.posix.extname(normalizePvfPath(pvfPath).toLowerCase());
}

function resolveRegistryEntryPath(lstPath, rawPath) {
  const registry = normalizePvfPath(lstPath);
  const raw = normalizePvfPath(rawPath);
  const directory = path.posix.dirname(registry);
  if (!directory || directory === "." || raw.toLowerCase().startsWith(`${directory.toLowerCase()}/`)) return raw;
  return normalizePvfPath(`${directory}/${raw}`);
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sectionBody(text, tag) {
  const escaped = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = String(text || "");
  const closed = new RegExp(`\\[${escaped}\\][\\t ]*(?:\\r?\\n)?([\\s\\S]*?)\\[\\/${escaped}\\]`, "iu").exec(source);
  if (closed) return closed[1];
  // Scalar PVF tags such as [map image], [ui path] and [name] are commonly
  // left unclosed.  Bound their value by the next section marker instead of
  // treating the whole tail of the file as the value.
  const scalar = new RegExp(`\\[${escaped}\\][\\t ]*(?:\\r?\\n)?([\\s\\S]*?)(?=\\r?\\n\\s*\\[[^\\r\\n]+\\]|$)`, "iu").exec(source);
  return scalar ? scalar[1] : null;
}

function firstBacktick(value) {
  return String(value || "").match(/`([^`]*)`/u)?.[1] || null;
}

function allNumbers(value) {
  return (String(value || "").match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
}

/**
 * Parse a registry while retaining malformed lines.  This is intentionally
 * less permissive than a generic text search: an authorised registry change
 * must prove that every non-comment row has an unambiguous numeric key and a
 * complete backtick path.
 */
function parseRegistryRows(text) {
  const rows = [];
  const malformed = [];
  const lines = normalizeText(text).split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "#PVF_File" || trimmed.startsWith("#") || trimmed.startsWith("//")) return;
    const match = /^\s*(-?\d+)[\t ]+`([^`]+)`[\t ]*$/u.exec(line);
    if (!match) {
      malformed.push({ line: index + 1, text: line });
      return;
    }
    rows.push({
      id: Number(match[1]),
      pvfPath: normalizePvfPath(match[2]),
      rawPath: match[2],
      line: index + 1,
      text: line,
    });
  });
  const byId = new Map();
  const byPath = new Map();
  const duplicateIds = [];
  const duplicatePaths = [];
  for (const row of rows) {
    if (byId.has(row.id)) duplicateIds.push({ id: row.id, first: byId.get(row.id), second: row });
    else byId.set(row.id, row);
    const key = row.pvfPath.toLowerCase();
    if (byPath.has(key)) duplicatePaths.push({ pvfPath: row.pvfPath, first: byPath.get(key), second: row });
    else byPath.set(key, row);
  }
  return {
    rows,
    malformed,
    duplicateIds,
    duplicatePaths,
    byId,
    byPath,
    headerPresent: /^#PVF_File(?:\r?\n|$)/u.test(String(text || "")),
  };
}

function parseWorldmapText(text) {
  const dungeonBody = sectionBody(text, "dungeon");
  const dungeonTokens = allNumbers(dungeonBody || "");
  // Worldmap dungeon records are observed as ID/condition pairs.  Preserve
  // the complete token list, but expose only the ID positions for closure.
  const dungeonIds = [];
  for (let index = 0; index < dungeonTokens.length; index += 2) dungeonIds.push(dungeonTokens[index]);
  return {
    mapImage: firstBacktick(sectionBody(text, "map image")),
    uiPath: firstBacktick(sectionBody(text, "ui path")),
    dungeonIds: dungeonIds.filter((id) => Number.isInteger(id) && id >= 0),
    dungeonTokens,
    name: firstBacktick(sectionBody(text, "name")),
    hasDungeonSection: dungeonBody !== null,
  };
}

function parseWorldmapUiButtons(text) {
  const blocks = normalizeText(text).match(/\[ui controls\][\s\S]*?\[\/ui controls\]/giu) || [];
  const buttons = [];
  for (const block of blocks) {
    if (!/\[balloon\]/iu.test(block)) continue;
    const control = /`(IDC_WORLDMAP_BUTTON[^`]*)`[\t ]+([^\r\n]+)/iu.exec(block);
    if (!control) continue;
    const image = /`[^`]+\.img`[\t ]+([^\r\n]+)/iu.exec(block);
    const numbers = allNumbers(image?.[1] || "");
    const dungeonId = numbers.length ? numbers[numbers.length - 1] : null;
    buttons.push({
      controlId: control[1],
      controlParameters: control[2].trim(),
      dungeonId: Number.isInteger(dungeonId) ? dungeonId : null,
      hasImageBinding: Boolean(image),
    });
  }
  return buttons;
}

function parseTownWorldmapGates(text) {
  const values = [];
  const source = normalizeText(text);
  const re = /`?\[dungeon gate\]`?[\t ]*(?:\n[\t ]*)?([-+]?\d+)/giu;
  let match;
  while ((match = re.exec(source))) values.push(Number(match[1]));
  return values.filter(Number.isInteger);
}

function parseRegionTownIds(text) {
  return allNumbers(sectionBody(text, "towns") || "").filter(Number.isInteger);
}

function scanBalancedScript(text, options = {}) {
  const source = String(text || "");
  const errors = [];
  if (!source.trim()) errors.push("empty-source");
  if (source.includes("\0")) errors.push("nul-byte");
  if (options.requireHeader !== false && !/^#PVF_File(?:\r?\n|$)/u.test(source)) errors.push("missing-pvf-header");
  let quote = false;
  let escaped = false;
  const stack = [];
  const pairs = new Map([["}", "{"], ["]", "["], [")", "("]]);
  const openers = new Set(["{", "[", "("]);
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "`") quote = false;
      continue;
    }
    if (ch === "`") { quote = true; continue; }
    if (openers.has(ch)) stack.push({ ch, index });
    else if (pairs.has(ch)) {
      const top = stack.pop();
      if (!top || top.ch !== pairs.get(ch)) errors.push(`unbalanced-${ch}@${index}`);
    }
  }
  if (quote) errors.push("unclosed-backtick");
  if (stack.length) errors.push("unclosed-delimiter");
  return { ok: errors.length === 0, errors };
}

function validateNewFileText(pvfPath, text, proof = {}) {
  const ext = extensionOf(pvfPath);
  const errors = [];
  const source = String(text || "");
  if (source.includes("\0")) errors.push("NUL byte is not allowed");
  if (proof.sourceTextSha256 && proof.sourceTextSha256.toLowerCase() !== sha256(Buffer.from(source, "utf8")).toLowerCase()) {
    errors.push("writeProof.sourceTextSha256 does not match source text");
  }
  if (ext === ".lst") {
    const registry = parseRegistryRows(source);
    if (!registry.headerPresent) errors.push("registry must begin with #PVF_File");
    if (!registry.rows.length) errors.push("registry must contain at least one ID/path row");
    if (registry.malformed.length) errors.push(`registry has ${registry.malformed.length} malformed row(s)`);
    if (registry.duplicateIds.length) errors.push("registry contains duplicate IDs");
    if (registry.duplicatePaths.length) errors.push("registry contains duplicate paths");
  } else if (ext === ".str") {
    if (!source.trim()) errors.push("localization source must not be empty");
    if (/\uFFFD/u.test(source)) errors.push("replacement character is not allowed");
    if (proof.encodingRoundTripRequired !== true) errors.push("localization write requires encodingRoundTripRequired=true");
  } else {
    const balanced = scanBalancedScript(source, { requireHeader: ![".nut", ".sqr"].includes(ext) });
    errors.push(...balanced.errors);
    if (ext === ".wdm") {
      const worldmap = parseWorldmapText(source);
      if (!worldmap.mapImage) errors.push("worldmap is missing [map image]");
      if (!worldmap.uiPath) errors.push("worldmap is missing [ui path]");
      if (!worldmap.hasDungeonSection || !worldmap.dungeonIds.length) errors.push("worldmap must contain at least one [dungeon] ID");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    extension: ext,
    sourceSha256: sha256(Buffer.from(source, "utf8")),
    normalizedTextSha256: sha256(normalizeText(source)),
  };
}

function expectedNewFileMode(pvfPath) {
  return HIGH_RISK_NEW_FILE_MODES[extensionOf(pvfPath)] || null;
}

function isProtectedExistingExtension(pvfPath) {
  return PROTECTED_EXISTING_FILE_EXTENSIONS.has(extensionOf(pvfPath));
}

function validateWriteProofShape(pvfPath, proof) {
  const expected = expectedNewFileMode(pvfPath);
  if (!expected) return { ok: true, expectedMode: null, errors: [] };
  const errors = [];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    return { ok: false, expectedMode: expected, errors: [`${extensionOf(pvfPath)} requires writeProof.mode=${expected}`] };
  }
  if (proof.mode !== expected) errors.push(`writeProof.mode must be ${expected}`);
  if (expected === "worldmap-lifecycle") {
    if (!proof.registry || typeof proof.registry !== "object") errors.push("worldmap proof requires registry");
    const registry = proof.registry || {};
    if (normalizePvfPath(registry.lstPath).toLowerCase() !== "worldmap/worldmap.lst") errors.push("worldmap proof registry.lstPath must be worldmap/worldmap.lst");
    if (!Number.isSafeInteger(Number(registry.id)) || Number(registry.id) < 0) errors.push("worldmap proof registry.id must be a non-negative integer");
    if (normalizePvfPath(registry.expectedPvfPath).toLowerCase() !== normalizePvfPath(pvfPath).toLowerCase()) errors.push("worldmap proof registry.expectedPvfPath must match the new .wdm path");
    if (registry.action !== "add") errors.push("new worldmap registry action must be add");
    if (!Array.isArray(proof.pairedEntries) || proof.pairedEntries.length === 0) errors.push("worldmap proof requires pairedEntries");
    const paired = Array.isArray(proof.pairedEntries) ? proof.pairedEntries : [];
    if (!paired.some((entry) => entry?.kind === "ui")) errors.push("worldmap proof requires a ui pairedEntry");
    if (!paired.some((entry) => entry?.kind === "town-gate")) errors.push("worldmap proof requires a town-gate pairedEntry");
    if (!paired.some((entry) => entry?.kind === "region-town")) errors.push("worldmap proof requires a region-town pairedEntry");
  } else if (expected === "registry-lifecycle") {
    if (!proof.registry || typeof proof.registry !== "object") errors.push("registry proof requires registry");
  } else if (expected === "script-new-file") {
    if (proof.compileRequired !== true) errors.push("script proof requires compileRequired=true");
    if (!Array.isArray(proof.referencePaths) || proof.referencePaths.length === 0) errors.push("script proof requires at least one same-extension referencePaths sample");
  } else if (expected === "localization-new-file") {
    if (!new Set(["Cn", "Tw"]).has(String(proof.pvfEncoding || ""))) errors.push("localization proof requires pvfEncoding Cn or Tw");
    if (proof.encodingRoundTripRequired !== true) errors.push("localization proof requires encodingRoundTripRequired=true");
    if (!Array.isArray(proof.referencePaths) || proof.referencePaths.length === 0) errors.push("localization proof requires at least one .str referencePaths sample");
  }
  return { ok: errors.length === 0, expectedMode: expected, errors };
}

function validateRegistryRowProof(proof, registryText, pendingPath = null) {
  const errors = [];
  const registry = parseRegistryRows(registryText);
  if (!registry.headerPresent) errors.push("target registry is missing #PVF_File");
  if (registry.malformed.length) errors.push("target registry contains malformed rows");
  if (registry.duplicateIds.length || registry.duplicatePaths.length) errors.push("target registry already contains duplicate IDs or paths");
  const row = proof?.registry || {};
  const id = Number(row.id);
  const registryPath = normalizePvfPath(row.lstPath || proof?.registry?.lstPath || "");
  const expectedPath = normalizePvfPath(row.expectedPvfPath || row.pvfPath);
  if (!Number.isSafeInteger(id) || id < 0) errors.push("registry.id must be a non-negative integer");
  if (!expectedPath) errors.push("registry.expectedPvfPath is required");
  const existingById = registry.byId.get(id);
  const existingByPath = registry.rows.find((candidate) =>
    resolveRegistryEntryPath(registryPath, candidate.pvfPath).toLowerCase() === expectedPath.toLowerCase()) || null;
  if (existingById && resolveRegistryEntryPath(registryPath, existingById.pvfPath).toLowerCase() !== expectedPath.toLowerCase()) errors.push("registry ID conflict");
  if (existingByPath && existingByPath.id !== id) errors.push("registry path conflict");
  if (pendingPath && expectedPath.toLowerCase() !== normalizePvfPath(pendingPath).toLowerCase()) errors.push("registry row does not point at the new file");
  return { ok: errors.length === 0, errors, id, expectedPvfPath: expectedPath, existingById, existingByPath, registry, registryPath };
}

/**
 * Prove that an existing registry changed only by adding the rows named in
 * the lifecycle proofs. Presence-only checks are insufficient: without this
 * transition audit a replacement could silently rewrite an old ID/path while
 * also adding one otherwise valid row.
 */
function validateRegistryLifecycleTransition(beforeText, afterText, proofs, pvfPath) {
  const errors = [];
  const registryPath = normalizePvfPath(pvfPath);
  const before = parseRegistryRows(beforeText);
  const after = parseRegistryRows(afterText);
  const proofList = Array.isArray(proofs) ? proofs : [];

  if (!before.headerPresent || !after.headerPresent) errors.push("registry header must remain #PVF_File");
  if (before.malformed.length || after.malformed.length) errors.push("registry lifecycle cannot contain malformed rows");
  if (before.duplicateIds.length || before.duplicatePaths.length || after.duplicateIds.length || after.duplicatePaths.length) {
    errors.push("registry lifecycle cannot contain duplicate IDs or paths");
  }
  if (!proofList.length) errors.push("registry lifecycle requires at least one explicit row-add proof");

  const additions = [];
  const proofIds = new Set();
  const proofPaths = new Set();
  for (const proof of proofList) {
    const row = proof?.registry || {};
    const id = Number(row.id);
    const expectedPvfPath = normalizePvfPath(row.expectedPvfPath || row.pvfPath);
    const declaredRegistry = normalizePvfPath(row.lstPath || "");
    if (proof?.mode !== "registry-lifecycle" || proof?.allowExistingRegistryEdit !== true) {
      errors.push("existing registry changes require registry-lifecycle with allowExistingRegistryEdit=true");
    }
    if (row.action !== "add") errors.push("existing registry lifecycle supports action=add only");
    if (!declaredRegistry || declaredRegistry.toLowerCase() !== registryPath.toLowerCase()) {
      errors.push("registry proof lstPath must match the edited .lst path");
    }
    if (!Number.isSafeInteger(id) || id < 0 || !expectedPvfPath) {
      errors.push("registry row proof requires a non-negative id and expectedPvfPath");
      continue;
    }
    const pathKey = expectedPvfPath.toLowerCase();
    if (proofIds.has(id)) errors.push(`duplicate row-add proof id: ${id}`);
    if (proofPaths.has(pathKey)) errors.push(`duplicate row-add proof path: ${expectedPvfPath}`);
    proofIds.add(id);
    proofPaths.add(pathKey);
    additions.push({ id, expectedPvfPath });
    if (before.byId.has(id)) errors.push(`row-add proof id already exists: ${id}`);
    if (before.rows.some((candidate) =>
      resolveRegistryEntryPath(registryPath, candidate.pvfPath).toLowerCase() === pathKey)) {
      errors.push(`row-add proof path already exists: ${expectedPvfPath}`);
    }
  }

  for (const row of before.rows) {
    const finalRow = after.byId.get(row.id);
    if (!finalRow || finalRow.rawPath !== row.rawPath) {
      errors.push(`existing registry row changed or disappeared: ${row.id} -> ${row.rawPath}`);
    }
  }
  const finalExistingOrder = after.rows
    .filter((row) => before.byId.has(row.id))
    .map((row) => `${row.id}\u0000${row.rawPath}`);
  const originalOrder = before.rows.map((row) => `${row.id}\u0000${row.rawPath}`);
  if (JSON.stringify(finalExistingOrder) !== JSON.stringify(originalOrder)) errors.push("existing registry row order changed");

  const extraRows = after.rows.filter((row) => !before.byId.has(row.id));
  if (extraRows.length !== additions.length) {
    errors.push(`registry lifecycle expected ${additions.length} added row(s), found ${extraRows.length}`);
  }
  for (const addition of additions) {
    const row = after.byId.get(addition.id);
    if (!row || resolveRegistryEntryPath(registryPath, row.pvfPath).toLowerCase() !== addition.expectedPvfPath.toLowerCase()) {
      errors.push(`proved registry row missing from final text: ${addition.id} -> ${addition.expectedPvfPath}`);
    }
  }
  for (const row of extraRows) {
    const resolved = resolveRegistryEntryPath(registryPath, row.pvfPath).toLowerCase();
    if (!additions.some((addition) => addition.id === row.id && addition.expectedPvfPath.toLowerCase() === resolved)) {
      errors.push(`unproved registry row added: ${row.id} -> ${row.rawPath}`);
    }
  }

  const additionKeys = new Set(additions.map((addition) => `${addition.id}\u0000${addition.expectedPvfPath.toLowerCase()}`));
  const strippedAfter = normalizeText(afterText).split("\n").filter((line) => {
    const match = /^\s*(-?\d+)[\t ]+`([^`]+)`[\t ]*$/u.exec(line);
    if (!match) return true;
    const key = `${Number(match[1])}\u0000${resolveRegistryEntryPath(registryPath, match[2]).toLowerCase()}`;
    return !additionKeys.has(key);
  }).join("\n");
  if (strippedAfter !== normalizeText(beforeText)) {
    errors.push("registry lifecycle changed content other than the proved new row(s)");
  }

  return {
    ok: errors.length === 0,
    errors,
    registryPath,
    originalRowCount: before.rows.length,
    finalRowCount: after.rows.length,
    addedRows: additions,
    originalTextSha256: sha256(normalizeText(beforeText)),
    finalTextSha256: sha256(normalizeText(afterText)),
  };
}

module.exports = {
  HIGH_RISK_NEW_FILE_MODES,
  PROTECTED_EXISTING_FILE_EXTENSIONS,
  extensionOf,
  expectedNewFileMode,
  isProtectedExistingExtension,
  normalizePvfPath,
  resolveRegistryEntryPath,
  normalizeText,
  parseRegistryRows,
  parseRegionTownIds,
  parseTownWorldmapGates,
  parseWorldmapUiButtons,
  parseWorldmapText,
  scanBalancedScript,
  sha256,
  validateNewFileText,
  validateRegistryLifecycleTransition,
  validateRegistryRowProof,
  validateWriteProofShape,
};
