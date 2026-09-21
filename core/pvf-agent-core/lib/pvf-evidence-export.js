"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FORMAT = "pvf-canonical-evidence-v1";
const DEFAULT_MAX_CHARS = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Resolve existing ancestors as well as the final path, so junctions cannot
// redirect an apparently external output back into the clean Workbench.
function physicalPath(target) {
  const absolute = path.resolve(target);
  try { return fs.realpathSync(absolute); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(physicalPath(parent), path.basename(absolute));
  }
}

function assertExternal(workbenchRoot, sourcePvf, output) {
  const resolved = physicalPath(output);
  if (inside(physicalPath(workbenchRoot), resolved) || inside(physicalPath(path.dirname(sourcePvf)), resolved)) {
    fail("EVIDENCE_OUTPUT_PROTECTED", "Evidence must be outside the Workbench and the input PVF directory.");
  }
  return resolved;
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 256) {
    fail("EVIDENCE_SCOPE_INVALID", "Supply 1 to 256 explicit PVF paths.");
  }
  const seen = new Set();
  for (const value of paths) {
    if (typeof value !== "string" || value !== value.trim() || /[\\\x00-\x1f:]/u.test(value) ||
        value.split("/").some((part) => !part || part === "." || part === "..")) {
      fail("EVIDENCE_PATH_INVALID", "Use an exact relative PVF path with forward slashes.");
    }
    const key = value.toLowerCase();
    if (seen.has(key)) fail("EVIDENCE_SCOPE_DUPLICATE", `Duplicate PVF path: ${value}`);
    seen.add(key);
  }
  return paths;
}

function validateLimit(value = DEFAULT_MAX_CHARS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_CHARS) {
    fail("EVIDENCE_LIMIT_INVALID", `maxChars must be an integer from 1 to ${DEFAULT_MAX_CHARS}.`);
  }
  return value;
}

function completeText(result, pvfPath, maxChars) {
  if (!result || result.ok !== true || result.pvfPath !== pvfPath || typeof result.textContent !== "string") {
    fail("EVIDENCE_READ_INVALID", `Canonical reader did not return the requested path: ${pvfPath}`);
  }
  const text = result.textContent;
  if (result.truncated !== false || result.hasMore !== false || result.sourceCharCount !== text.length ||
      result.returnedCharCount !== text.length || result.remainingCharCount !== 0 ||
      result.returnedRange?.startChar !== 0 || result.returnedRange?.endCharExclusive !== text.length ||
      text.length > maxChars) {
    fail("EVIDENCE_INCOMPLETE", `A complete read is required; no successful manifest will be written: ${pvfPath}`);
  }
  // UTF-8 artifacts must be lossless even for a malformed decoder result.
  if (Buffer.from(text, "utf8").toString("utf8") !== text) {
    fail("EVIDENCE_TEXT_UNREPRESENTABLE", `Unpaired surrogate in canonical text: ${pvfPath}`);
  }
  return text;
}

function assertFingerprint(value) {
  if (!value || !/^[a-f0-9]{64}$/u.test(value.sourcePvfSha256) || value.stableDuringFingerprint !== true ||
      !Number.isSafeInteger(value.sourceSize) || value.sourceSize < 0) {
    fail("EVIDENCE_FINGERPRINT_INVALID", "A stable full-source fingerprint is required.");
  }
}

function assertUnchanged(before, after) {
  assertFingerprint(before);
  assertFingerprint(after);
  if (before.sourcePvfSha256 !== after.sourcePvfSha256 || before.sourceSize !== after.sourceSize ||
      before.sourceMtimeMs !== after.sourceMtimeMs) {
    fail("EVIDENCE_SOURCE_CHANGED", "Source changed during evidence collection or verification.");
  }
}

function artifactName(pvfPath) { return `${sha256(pvfPath)}.raw.txt`; }

function readRegularFile(file, maxBytes) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    fail("EVIDENCE_ARTIFACT_INVALID", "Evidence artifacts must be bounded regular files, not links.");
  }
  return fs.readFileSync(file);
}

async function exportEvidence({ workbenchRoot, sourcePvf, paths, outputDir, purpose, maxChars, fingerprint, read }) {
  validatePaths(paths);
  maxChars = validateLimit(maxChars);
  if (!["boundary-only", "rebuild-evidence"].includes(purpose)) {
    fail("EVIDENCE_PURPOSE_REQUIRED", "Choose boundary-only or rebuild-evidence explicitly.");
  }
  const output = assertExternal(workbenchRoot, sourcePvf, outputDir);
  const before = await fingerprint();
  assertFingerprint(before);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output); // Exclusive: never merge, overwrite, or silently reuse.
  const marker = path.join(output, "INCOMPLETE.json");
  fs.writeFileSync(marker, JSON.stringify({ format: FORMAT, complete: false, sourcePvfSha256: before.sourcePvfSha256 }), { flag: "wx" });
  const items = [];
  let totalBytes = 0;
  for (const pvfPath of paths) {
    const { file, selectedEncoding, encodingEvidence = null } = await read(pvfPath, undefined, maxChars);
    if (!["Cn", "Tw"].includes(selectedEncoding)) fail("EVIDENCE_ENCODING_INVALID", "Only target-selected Cn/Tw canonical text is supported.");
    const text = completeText(file, pvfPath, maxChars);
    const bytes = Buffer.from(text, "utf8");
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail("EVIDENCE_BUDGET_EXCEEDED", "Split the explicit scope into smaller batches; this batch is incomplete.");
    const textFile = artifactName(pvfPath);
    fs.writeFileSync(path.join(output, textFile), bytes, { flag: "wx" });
    if (!readRegularFile(path.join(output, textFile), MAX_TOTAL_BYTES).equals(bytes)) {
      fail("EVIDENCE_ARTIFACT_READBACK_FAILED", `Artifact readback differs: ${pvfPath}`);
    }
    items.push({ pvfPath, selectedEncoding, encodingEvidence, textFile, complete: true,
      sourceCharCount: text.length, utf8ByteCount: bytes.length, canonicalTextSha256: sha256(bytes) });
  }
  const after = await fingerprint();
  assertUnchanged(before, after);
  const manifest = { format: FORMAT, complete: true, purpose, source: before, sourceAfter: after,
    canonicalTokenLayout: true, simplifiedChineseConversion: false, stringLinkExpansion: false,
    fullPackageCoverage: false, registryIdentityVerified: false, semanticValidation: "not-run",
    runtimeValidation: "not-run", authorizesPvfGeneration: false,
    requestedCount: paths.length, completedCount: items.length, maxChars, totalBytes, items };
  const manifestPath = path.join(output, "EVIDENCE.json");
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(manifestPath, bytes, { flag: "wx" });
  if (!readRegularFile(manifestPath, 2 * 1024 * 1024).equals(bytes)) fail("EVIDENCE_MANIFEST_READBACK_FAILED", "Manifest readback differs.");
  fs.unlinkSync(marker); // Only this run's known marker; never recursive cleanup.
  return { manifestPath, manifestSha256: sha256(bytes), sourcePvfSha256: before.sourcePvfSha256,
    purpose, complete: true, fileCount: items.length, totalBytes, items,
    semanticValidation: "not-run", runtimeValidation: "not-run", authorizesPvfGeneration: false };
}

async function verifyEvidence({ sourcePvf, manifestPath, manifestSha256, fingerprint, read }) {
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256 || "")) fail("EVIDENCE_MANIFEST_HASH_REQUIRED", "Supply the separately recorded manifest SHA256.");
  const bytes = readRegularFile(manifestPath, 2 * 1024 * 1024);
  if (sha256(bytes) !== manifestSha256) fail("EVIDENCE_MANIFEST_CHANGED", "Manifest hash differs.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.format !== FORMAT || manifest.complete !== true || !Array.isArray(manifest.items) ||
      manifest.requestedCount !== manifest.items.length || manifest.completedCount !== manifest.items.length ||
      manifest.canonicalTokenLayout !== true || manifest.simplifiedChineseConversion !== false || manifest.stringLinkExpansion !== false ||
      !["boundary-only", "rebuild-evidence"].includes(manifest.purpose)) {
    fail("EVIDENCE_MANIFEST_INVALID", "Incomplete or unsupported evidence manifest.");
  }
  validatePaths(manifest.items.map((item) => item.pvfPath));
  const maxChars = validateLimit(manifest.maxChars);
  const before = await fingerprint();
  assertFingerprint(before);
  assertFingerprint(manifest.source);
  if (before.sourcePvfSha256 !== manifest.source.sourcePvfSha256 || before.sourceSize !== manifest.source.sourceSize) {
    fail("EVIDENCE_SOURCE_MISMATCH", "Evidence belongs to a different PVF; do not reuse it.");
  }
  const root = path.dirname(path.resolve(manifestPath));
  if (fs.existsSync(path.join(root, "INCOMPLETE.json"))) fail("EVIDENCE_INCOMPLETE", "Export did not finish.");
  let totalBytes = 0;
  for (const item of manifest.items) {
    if (item.complete !== true || item.textFile !== artifactName(item.pvfPath) || !["Cn", "Tw"].includes(item.selectedEncoding)) {
      fail("EVIDENCE_ITEM_INVALID", "Invalid evidence item or artifact path.");
    }
    const artifact = readRegularFile(path.join(root, item.textFile), MAX_TOTAL_BYTES);
    totalBytes += artifact.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail("EVIDENCE_BUDGET_EXCEEDED", "Evidence exceeds the supported batch budget.");
    if (artifact.length !== item.utf8ByteCount || sha256(artifact) !== item.canonicalTextSha256) {
      fail("EVIDENCE_ARTIFACT_CHANGED", `Evidence artifact changed: ${item.pvfPath}`);
    }
    // The manifest never supplies the PVF location to open. The caller opens
    // its explicit --pvf, then reads every path again with the canonical reader.
    const { file, selectedEncoding } = await read(item.pvfPath, item.selectedEncoding, maxChars);
    const text = completeText(file, item.pvfPath, maxChars);
    if (selectedEncoding !== item.selectedEncoding || text.length !== item.sourceCharCount ||
        !Buffer.from(text, "utf8").equals(artifact)) {
      fail("EVIDENCE_LIVE_READBACK_MISMATCH", `Fresh PVF read differs from the artifact: ${item.pvfPath}`);
    }
  }
  if (totalBytes !== manifest.totalBytes) fail("EVIDENCE_MANIFEST_INVALID", "Byte totals differ.");
  assertUnchanged(before, await fingerprint());
  return { verified: true, complete: true, sourcePvf: path.resolve(sourcePvf), sourcePvfSha256: before.sourcePvfSha256,
    manifestPath: path.resolve(manifestPath), manifestSha256, purpose: manifest.purpose, fileCount: manifest.items.length,
    totalBytes, freshCanonicalReadback: true, semanticValidation: "not-run", runtimeValidation: "not-run", authorizesPvfGeneration: false };
}

module.exports = { exportEvidence, verifyEvidence, completeText, validatePaths, assertExternal, sha256, DEFAULT_MAX_CHARS };
