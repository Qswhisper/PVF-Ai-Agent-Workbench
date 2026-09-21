"use strict";

const fs = require("fs");
const path = require("path");
const fallback = require("../../../tools/pvf-bridge/fallback/pvf-readonly-backend.ts");
const { sha256, validatePaths, assertExternal } = require("./pvf-evidence-export");

const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TABLE_BYTES = 128 * 1024 * 1024;
// Type 10 also indexes the string table. Even without a preceding namespace
// token, never certify preservation while ignoring its referenced bytes.
const STRING_TYPES = new Set([5, 6, 7, 8, 10]);
const KNOWN_TYPES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function rawStringReader(table) {
  if (!Buffer.isBuffer(table) || table.length < 8 || table.length > MAX_TABLE_BYTES) {
    fail("SCOPE_STRING_TABLE_INVALID", "Invalid or oversized string table.");
  }
  const count = table.readInt32LE(0);
  const headerEnd = 4 + (count + 1) * 4;
  if (count < 0 || count > 5000000 || headerEnd > table.length) fail("SCOPE_STRING_TABLE_INVALID", "Invalid string table header.");
  return (index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) fail("SCOPE_STRING_REFERENCE_INVALID", "Unresolved string table index.");
    const start = table.readInt32LE(4 + index * 4) + 4;
    const end = table.readInt32LE(8 + index * 4) + 4;
    if (start < headerEnd || end < start || end > table.length) fail("SCOPE_STRING_REFERENCE_INVALID", "Invalid referenced string byte range.");
    return table.subarray(start, end);
  };
}

function sectionBytes(section) {
  if (typeof section !== "string" || !/^\[[A-Za-z0-9][A-Za-z0-9 _-]{0,119}\]$/u.test(section)) {
    fail("SCOPE_SECTION_INVALID", "Supply one exact ASCII opening section tag.");
  }
  return { opening: Buffer.from(section, "ascii"), closing: Buffer.from(`[/${section.slice(1)}`, "ascii") };
}

// Read raw five-byte tokens, not a regex over decompiled text. A type-7
// description containing '[section]' is never a type-5 section marker.
function inspectScope(script, table, section) {
  const { opening, closing } = sectionBytes(section);
  if (!Buffer.isBuffer(script) || script.length < 2 || script.length > MAX_SCRIPT_BYTES ||
      script[0] !== 0xb0 || script[1] !== 0xd0 || (script.length - 2) % 5 !== 0) {
    fail("SCOPE_SCRIPT_INVALID", "Expected one complete binary script with no trailing partial token.");
  }
  const stringAt = rawStringReader(table);
  const tokens = [];
  const markers = [];
  for (let offset = 2; offset < script.length; offset += 5) {
    const type = script[offset];
    const value = script.readUInt32LE(offset + 1);
    if (!KNOWN_TYPES.has(type)) fail("SCOPE_TOKEN_UNSUPPORTED", "Unknown token type; scope completeness is unresolved.");
    const token = { type, value, offset };
    tokens.push(token);
    if (STRING_TYPES.has(type)) {
      const bytes = stringAt(value);
      if (type === 5 && (bytes.equals(opening) || bytes.equals(closing))) {
        markers.push({ ...token, opening: bytes.equals(opening) });
      }
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type === 9) {
      if (tokens[i + 1]?.type !== 10) fail("SCOPE_STRINGLINK_INVALID", "Incomplete StringLink token pair.");
      stringAt(tokens[i + 1].value);
    }
  }
  if (markers.length !== 2 || !markers[0].opening || markers[1].opening) {
    fail("SCOPE_MARKERS_AMBIGUOUS", "Exactly one opening tag followed by one closing tag is required; absent, repeated, reversed or nested markers remain blocked.");
  }
  const bodyStart = markers[0].offset + 5;
  const bodyEnd = markers[1].offset;
  const refs = new Map();
  for (const token of tokens) {
    if (token.offset >= bodyStart && token.offset < bodyEnd) continue;
    if (token.type === 9) {
      fail("SCOPE_EXTERNAL_TEXT_UNRESOLVED", "StringLink outside the selected body requires an additional external-text audit.");
    }
    if (STRING_TYPES.has(token.type)) {
      const bytes = stringAt(token.value);
      refs.set(token.value, { index: token.value, byteCount: bytes.length, sha256: sha256(bytes) });
    }
  }
  const references = [...refs.values()].sort((a, b) => a.index - b.index);
  const proof = {
    format: "pvf-script-scope-v1", section, closingSection: closing.toString("ascii"),
    scopeCount: 1, tokenCount: tokens.length, rawByteCount: script.length,
    rawFileSha256: sha256(script),
    bodyByteRange: { start: bodyStart, endExclusive: bodyEnd },
    openingTokenByteRange: { start: bodyStart - 5, endExclusive: bodyStart },
    closingTokenByteRange: { start: bodyEnd, endExclusive: bodyEnd + 5 },
    protectedPrefixByteCount: bodyStart, protectedPrefixSha256: sha256(script.subarray(0, bodyStart)),
    protectedSuffixByteCount: script.length - bodyEnd, protectedSuffixSha256: sha256(script.subarray(bodyEnd)),
    protectedStringEntryCount: references.length, protectedStringEntriesSha256: sha256(JSON.stringify(references)),
    boundarySelectionSemantics: "caller-selected-exact-section-body-only",
    fullPackageCoverage: false, domainSemanticValidation: "not-run", runtimeValidation: "not-run",
    authorizesPvfGeneration: false,
  };
  return { proof, bodyStart, bodyEnd, references };
}

function compareScope(source, candidate, section) {
  const left = inspectScope(source.script, source.table, section);
  const right = inspectScope(candidate.script, candidate.table, section);
  const prefixEqual = source.script.subarray(0, left.bodyStart).equals(candidate.script.subarray(0, right.bodyStart));
  const suffixEqual = source.script.subarray(left.bodyEnd).equals(candidate.script.subarray(right.bodyEnd));
  const stringsEqual = JSON.stringify(left.references) === JSON.stringify(right.references);
  const ok = prefixEqual && suffixEqual && stringsEqual;
  return { ok, comparison: "selected-file-outside-section-body", source: left.proof, candidate: right.proof,
    protectedPrefixIdentical: prefixEqual, protectedSuffixIdentical: suffixEqual, protectedReferencedStringsIdentical: stringsEqual,
    rawBodyChanged: !source.script.subarray(left.bodyStart, left.bodyEnd).equals(candidate.script.subarray(right.bodyStart, right.bodyEnd)),
    scopeOutsidePreserved: ok, fullPackageCoverage: false, domainSemanticValidation: "not-run", runtimeValidation: "not-run",
    authorizesPvfGeneration: false,
    ...(ok ? {} : { code: "SCOPE_OUTSIDE_CHANGED" }) };
}

async function readSnapshot(sourcePvf, pvfPath) {
  validatePaths([pvfPath]);
  if (!/\.(stk|equ|skl|etc|dgn|qst)$/iu.test(pvfPath)) fail("SCOPE_FILE_TYPE_UNSUPPORTED", "This scope audit supports ordinary binary script files only.");
  const opened = await fallback.openSession(sourcePvf, "Tw");
  const id = opened.sessionId;
  try {
    const read = async (name, limit) => {
      const metadata = await fallback.getFileMetadata(id, name);
      if (metadata.dataLength > limit) fail("SCOPE_RESOURCE_LIMIT", "Selected evidence exceeds the bounded read budget.");
      const result = await fallback.readFile(id, name, { rawContent: true });
      if (typeof result.base64Content !== "string") fail("SCOPE_RAW_READ_UNAVAILABLE", "Raw file content is unavailable.");
      const bytes = Buffer.from(result.base64Content, "base64");
      if (bytes.length !== metadata.dataLength) fail("SCOPE_RAW_READ_INCOMPLETE", "Raw file byte count differs from metadata.");
      return bytes;
    };
    return { script: await read(pvfPath, MAX_SCRIPT_BYTES), table: await read("stringtable.bin", MAX_TABLE_BYTES) };
  } finally { await fallback.closeSession(id); }
}

// All original string entries must retain their raw bytes. An appended table
// can move its offset array, so comparing the stringtable.bin prefix is wrong.
function compareStringTableAppendOnly(source, candidate) {
  const sourceAt = rawStringReader(source), candidateAt = rawStringReader(candidate);
  const beforeCount = source.readInt32LE(0), afterCount = candidate.readInt32LE(0);
  for (const table of [source, candidate]) {
    const count = table.readInt32LE(0), headerEnd = 4 + (count + 1) * 4;
    if (table.readInt32LE(4) + 4 !== headerEnd || table.readInt32LE(4 + count * 4) + 4 !== table.length) {
      fail("PACKAGE_STRING_TABLE_LAYOUT_UNRESOLVED", "Unaccounted string table bytes; append-only preservation cannot be proved.");
    }
  }
  let changedCount = 0;
  for (let i = 0; i < afterCount; i += 1) candidateAt(i);
  for (let i = 0; i < beforeCount; i += 1) {
    const previous = sourceAt(i);
    if (i >= afterCount || !previous.equals(candidateAt(i))) changedCount += 1;
  }
  return { ok: afterCount >= beforeCount && changedCount === 0, originalEntryCount: beforeCount,
    candidateEntryCount: afterCount, changedOrMissingOriginalEntries: changedCount,
    appendedEntryCount: Math.max(0, afterCount - beforeCount) };
}

async function comparePackage(sourcePvf, candidatePvf, allowedScript) {
  const left = await fallback.openSession(sourcePvf, "Tw");
  let right;
  try {
    right = await fallback.openSession(candidatePvf, "Tw");
    const leftFiles = await fallback.listFiles(left.sessionId), rightFiles = await fallback.listFiles(right.sessionId);
    const leftNames = new Set(leftFiles.map((item) => item.fileName)), rightNames = new Set(rightFiles.map((item) => item.fileName));
    const added = [], removed = [], unexpectedChanges = [];
    let addedCount = 0, removedCount = 0, changedCount = 0, unchangedCount = 0, comparedCount = 0;
    let allowedScriptChanged = false, stringTable;
    const leftDigest = require("crypto").createHash("sha256"), rightDigest = require("crypto").createHash("sha256");
    const read = async (id, name) => {
      const file = await fallback.readFile(id, name, { rawContent: true });
      if (typeof file.base64Content !== "string") fail("SCOPE_RAW_READ_UNAVAILABLE", `Raw package entry unavailable: ${name}`);
      const bytes = Buffer.from(file.base64Content, "base64");
      if (bytes.length !== file.dataLength) fail("SCOPE_RAW_READ_INCOMPLETE", `Incomplete package entry: ${name}`);
      return bytes;
    };
    for (const name of [...new Set([...leftNames, ...rightNames])].sort()) {
      const source = leftNames.has(name) ? await read(left.sessionId, name) : null;
      const candidate = rightNames.has(name) ? await read(right.sessionId, name) : null;
      if (source) leftDigest.update(JSON.stringify([name, source.length, sha256(source)]) + "\n");
      if (candidate) rightDigest.update(JSON.stringify([name, candidate.length, sha256(candidate)]) + "\n");
      if (!source) { addedCount += 1; if (added.length < 100) added.push(name); continue; }
      if (!candidate) { removedCount += 1; if (removed.length < 100) removed.push(name); continue; }
      comparedCount += 1;
      if (name === "stringtable.bin") {
        stringTable = compareStringTableAppendOnly(source, candidate);
      } else if (name === allowedScript.toLowerCase()) {
        allowedScriptChanged = !source.equals(candidate);
      } else if (!source.equals(candidate)) {
        changedCount += 1; if (unexpectedChanges.length < 100) unexpectedChanges.push(name);
      } else { unchangedCount += 1; }
    }
    const ok = addedCount === 0 && removedCount === 0 && changedCount === 0 && stringTable?.ok === true;
    return { ok, complete: true, sourceFileCount: leftNames.size, candidateFileCount: rightNames.size, comparedCount,
      unchangedOutsideScriptAndStringTableCount: unchangedCount,
      addedCount, removedCount, unexpectedChangedCount: changedCount, added, removed, unexpectedChanges,
      diagnosticListsTruncated: addedCount > added.length || removedCount > removed.length || changedCount > unexpectedChanges.length,
      allowedScriptChanged, stringTable, allOriginalStringEntriesPreserved: stringTable?.ok === true,
      sourceEntryInventorySha256: leftDigest.digest("hex"), candidateEntryInventorySha256: rightDigest.digest("hex"),
      inventoryDefinition: "sorted UTF-8 JSON lines [path, raw-byte-length, raw-SHA256] for every package entry",
      allowedRawChangePaths: [allowedScript, "stringtable.bin"],
      ...(ok ? {} : { code: "PACKAGE_OUTSIDE_CHANGED" }) };
  } finally {
    if (right) await fallback.closeSession(right.sessionId);
    await fallback.closeSession(left.sessionId);
  }
}

function stable(before, after) {
  if (!before || !after || !/^[a-f0-9]{64}$/u.test(before.sourcePvfSha256) ||
      before.stableDuringFingerprint !== true || after.stableDuringFingerprint !== true ||
      before.sourcePvfSha256 !== after.sourcePvfSha256 || before.sourceSize !== after.sourceSize || before.sourceMtimeMs !== after.sourceMtimeMs) {
    fail("SCOPE_SOURCE_CHANGED", "PVF identity changed during scope inspection.");
  }
}

async function runScopeAudit({ sourcePvf, candidatePvf, pvfPath, section, fingerprint, read = readSnapshot, wholePackage = false }) {
  sectionBytes(section);
  validatePaths([pvfPath]);
  const sources = candidatePvf ? [sourcePvf, candidatePvf] : [sourcePvf];
  const before = sources.map(fingerprint);
  const left = await read(sourcePvf, pvfPath);
  const result = candidatePvf
    ? compareScope(left, await read(candidatePvf, pvfPath), section)
    : { ok: true, inspection: inspectScope(left.script, left.table, section).proof, scopeOutsidePreserved: "not-compared",
      fullPackageCoverage: false, domainSemanticValidation: "not-run", runtimeValidation: "not-run", authorizesPvfGeneration: false };
  if (wholePackage) {
    if (!candidatePvf) fail("PACKAGE_CANDIDATE_REQUIRED", "Whole-package comparison requires an explicit candidate PVF.");
    result.package = await comparePackage(sourcePvf, candidatePvf, pvfPath);
    result.ok = result.ok && result.package.ok;
    result.fullPackageCoverage = result.package.complete;
    result.packageOutsideDeclaredBodyPreserved = result.ok;
    if (!result.package.ok) result.code = result.package.code;
  }
  const after = sources.map(fingerprint);
  before.forEach((item, i) => stable(item, after[i]));
  return { ...result, pvfPath, sourceFingerprints: before, finalFingerprints: after, backend: "typescript-readonly-fallback",
    boundaryOnly: true, instruction: "Scope selection is not proof of domain meaning. Never reuse historical profession, skill, parameter or pool answers." };
}

function writeScopeReport(workbenchRoot, sources, outputPath, report) {
  for (const source of sources) assertExternal(workbenchRoot, source, outputPath);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(outputPath, bytes, { flag: "wx" });
  if (!fs.readFileSync(outputPath).equals(bytes)) fail("SCOPE_REPORT_READBACK_FAILED", "Scope report readback differs.");
  return { reportPath: path.resolve(outputPath), reportSha256: sha256(bytes) };
}

module.exports = { inspectScope, compareScope, compareStringTableAppendOnly, runScopeAudit, readSnapshot, writeScopeReport, rawStringReader };
