"use strict";

const crypto = require("crypto");
const path = require("path");

const ROOT_PATH_SEGMENTS = new Set([
  "aicharacter", "appendage", "character", "creature", "dungeon", "equipment",
  "etc", "itemshop", "map", "monster", "npc", "passiveobject", "skill",
  "sqr", "stackable", "town", "ui", "worldmap",
]);

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizedReference(value) {
  const normalized = normalizePvfPath(value);
  if (!normalized || normalized.includes("\n") || normalized.includes("\r")) return "";
  return normalizePvfPath(path.posix.normalize(normalized));
}

function referenceExtension(value) {
  return path.posix.extname(normalizedReference(value)).toLowerCase();
}

function extractBacktickFileReferences(text, extension) {
  const expected = String(extension || "").toLowerCase();
  const refs = [];
  const regex = /`([^`\r\n]+)`/gu;
  let match;
  while ((match = regex.exec(String(text || ""))) !== null) {
    const raw = normalizedReference(match[1]);
    if (raw && referenceExtension(raw) === expected) refs.push(raw);
  }
  return refs;
}

function relativeReferenceCandidates(ownerPath, rawReference) {
  const owner = normalizePvfPath(ownerPath);
  const raw = normalizedReference(rawReference);
  if (!owner || !raw) return [];
  const firstSegment = raw.split("/")[0].toLowerCase();
  const rootQualified = ROOT_PATH_SEGMENTS.has(firstSegment);
  const values = rootQualified
    ? [raw]
    : [path.posix.join(path.posix.dirname(owner), raw), raw];
  return [...new Set(values.map((value) => normalizePvfPath(path.posix.normalize(value))))];
}

function extractTagBodies(text, tag) {
  const escaped = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\[${escaped}\\]([\\s\\S]*?)(?:\\[\\/${escaped}\\]|(?=\\r?\\n[ \\t]*\\[[^/][^\\]]*\\])|$)`,
    "giu",
  );
  const values = [];
  let match;
  while ((match = regex.exec(String(text || ""))) !== null) {
    values.push(String(match[1] || "").trim().replace(/[ \t]+/gu, "\t").replace(/\r?\n/gu, "\\n"));
  }
  return values;
}

function summarizeTilText(text) {
  const normalized = String(text || "");
  return {
    textSha256: sha256Text(normalized),
    imgReferences: extractBacktickFileReferences(normalized, ".img"),
    imgPos: extractTagBodies(normalized, "img pos"),
  };
}

function arraysEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

async function resolveReference(ownerPath, rawReference, pathExists) {
  const candidates = relativeReferenceCandidates(ownerPath, rawReference);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return { resolved: true, pvfPath: candidate, candidates };
  }
  return { resolved: false, pvfPath: null, candidates };
}

async function auditMapRelativeResourceRebind(input = {}) {
  const sourceMapPath = normalizePvfPath(input.sourceMapPath);
  const targetMapPath = normalizePvfPath(input.targetMapPath || sourceMapPath);
  const sourceMapText = String(input.sourceMapText || "");
  const targetMapText = String(input.targetMapText || sourceMapText);
  const pathExists = input.pathExists;
  const readTil = input.readTil;
  if (typeof pathExists !== "function" || typeof readTil !== "function") {
    throw new Error("map relative-resource audit requires pathExists and readTil callbacks");
  }

  const sourceRefs = extractBacktickFileReferences(sourceMapText, ".til");
  const targetRefs = extractBacktickFileReferences(targetMapText, ".til");
  const referenceCount = Math.max(sourceRefs.length, targetRefs.length);
  const references = [];
  const errors = [];
  const warnings = [];
  for (let index = 0; index < referenceCount; index += 1) {
    const sourceRaw = sourceRefs[index] || null;
    const targetRaw = targetRefs[index] || null;
    const sourceResolution = sourceRaw
      ? await resolveReference(sourceMapPath, sourceRaw, pathExists)
      : { resolved: false, pvfPath: null, candidates: [] };
    const targetResolution = targetRaw
      ? await resolveReference(targetMapPath, targetRaw, pathExists)
      : { resolved: false, pvfPath: null, candidates: [] };
    const sourceSnapshot = sourceResolution.resolved ? await readTil(sourceResolution.pvfPath) : null;
    const targetSnapshot = targetResolution.resolved ? await readTil(targetResolution.pvfPath) : null;
    const sourceSummary = sourceSnapshot
      ? { ...summarizeTilText(sourceSnapshot.text), ...sourceSnapshot }
      : null;
    const targetSummary = targetSnapshot
      ? { ...summarizeTilText(targetSnapshot.text), ...targetSnapshot }
      : null;
    const sameRawReference = Boolean(sourceRaw && targetRaw) && sourceRaw.toLowerCase() === targetRaw.toLowerCase();
    const mapDirectoryChanged = sourceMapPath.toLowerCase() !== targetMapPath.toLowerCase();
    const bindingChanged = sourceResolution.pvfPath?.toLowerCase() !== targetResolution.pvfPath?.toLowerCase();
    const sourceContentSha256 = sourceSummary?.contentSha256 || sourceSummary?.rawContentSha256 || sourceSummary?.textSha256 || null;
    const targetContentSha256 = targetSummary?.contentSha256 || targetSummary?.rawContentSha256 || targetSummary?.textSha256 || null;
    const contentChanged = Boolean(sourceContentSha256 && targetContentSha256) && sourceContentSha256 !== targetContentSha256;
    const imgReferencesChanged = !arraysEqual(sourceSummary?.imgReferences, targetSummary?.imgReferences);
    const imgPosChanged = !arraysEqual(sourceSummary?.imgPos, targetSummary?.imgPos);
    const silentDirectoryRebind = sameRawReference && mapDirectoryChanged && bindingChanged;
    const highRisk = !targetResolution.resolved || (
      silentDirectoryRebind && (contentChanged || imgReferencesChanged || imgPosChanged)
    );
    const risk = highRisk ? "high" : silentDirectoryRebind ? "review" : "none";
    const evidence = {
      index,
      sourceRaw,
      targetRaw,
      sameRawReference,
      mapDirectoryChanged,
      source: { ...sourceResolution, snapshot: sourceSummary },
      target: { ...targetResolution, snapshot: targetSummary },
      bindingChanged,
      contentChanged,
      imgReferencesChanged,
      imgPosChanged,
      silentDirectoryRebind,
      risk,
    };
    references.push(evidence);
    if (!targetResolution.resolved) {
      errors.push(`目标地图 ${targetMapPath} 的 TIL 引用无法解析：${targetRaw || "<missing>"}`);
    } else if (highRisk) {
      errors.push(
        `相对 TIL 引用 ${targetRaw} 在目标目录改绑到不同内容：${sourceResolution.pvfPath || "<unresolved>"} -> ${targetResolution.pvfPath}`,
      );
    } else if (silentDirectoryRebind) {
      warnings.push(
        `相对 TIL 引用 ${targetRaw} 的实际路径发生变化，但已核对内容一致：${sourceResolution.pvfPath} -> ${targetResolution.pvfPath}`,
      );
    }
  }

  return {
    mode: "map-relative-resource-rebind",
    sourceMapPath,
    targetMapPath,
    sourceMapTextSha256: sha256Text(sourceMapText),
    targetMapTextSha256: sha256Text(targetMapText),
    checkedChain: [".map", ".til", ".img"],
    referenceCount,
    references,
    errors,
    warnings,
    highRisk: references.some((item) => item.risk === "high"),
    ok: errors.length === 0,
    clientAssetsWritten: false,
    inGameValidationRequired: referenceCount > 0,
  };
}

async function mapRelativeResourceAuditSelfTest() {
  const files = new Map([
    ["map/towerofsighs/tile/prisontile1.til", "#PVF_File\r\n[image]\r\n`Map/prison.img`\r\n[img pos]\r\n80\r\n"],
    ["map/illusiontower/tile/prisontile1.til", "#PVF_File\r\n[image]\r\n`Map/prison.img`\r\n"],
  ]);
  const sourceMapText = "#PVF_File\r\n[tile]\r\n`Tile/prisontile1.til`\r\n";
  const callbacks = {
    pathExists: async (pvfPath) => files.has(pvfPath.toLowerCase()),
    readTil: async (pvfPath) => {
      const text = files.get(pvfPath.toLowerCase());
      return { text, contentSha256: sha256Text(text), sha256Kind: "fixture-text" };
    },
  };
  const divergent = await auditMapRelativeResourceRebind({
    sourceMapPath: "map/towerofsighs/floor.map",
    targetMapPath: "map/illusiontower/floor.map",
    sourceMapText,
    targetMapText: sourceMapText,
    ...callbacks,
  });
  files.set(
    "map/illusiontower/tile/prisontile1.til",
    files.get("map/towerofsighs/tile/prisontile1.til"),
  );
  const identical = await auditMapRelativeResourceRebind({
    sourceMapPath: "map/towerofsighs/floor.map",
    targetMapPath: "map/illusiontower/floor.map",
    sourceMapText,
    targetMapText: sourceMapText,
    ...callbacks,
  });
  return [
    {
      id: "map-relative-til-rebind-with-img-pos-difference-is-high-risk",
      ok:
        divergent.ok === false && divergent.highRisk === true &&
        divergent.references[0]?.source?.pvfPath === "map/towerofsighs/Tile/prisontile1.til" &&
        divergent.references[0]?.target?.pvfPath === "map/illusiontower/Tile/prisontile1.til" &&
        divergent.references[0]?.imgPosChanged === true,
    },
    {
      id: "map-relative-til-rebind-with-identical-final-content-is-allowed",
      ok:
        identical.ok === true && identical.highRisk === false &&
        identical.references[0]?.bindingChanged === true &&
        identical.references[0]?.contentChanged === false,
    },
  ];
}

module.exports = {
  auditMapRelativeResourceRebind,
  extractBacktickFileReferences,
  mapRelativeResourceAuditSelfTest,
  relativeReferenceCandidates,
  summarizeTilText,
};
