"use strict";

const assert = require("assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { sha256 } = require("../lib/pvf-evidence-export");
const { inspectScope, compareScope, compareStringTableAppendOnly, runScopeAudit, writeScopeReport } = require("../lib/pvf-scope-audit");
const { createChecksum, encrypt } = require("../../../tools/pvf-bridge/fallback/codec.ts");

const SECTION = "[fixture region]";
const STRINGS = ["[header]", "description [fixture region] [/fixture region]", SECTION,
  "[/fixture region]", "inside-only fictional text", "[tail]", "protected fictional text"];
const TOKENS = [[5, 0], [7, 1], [5, 2], [2, 7], [7, 4], [5, 3], [5, 5], [2, 99], [7, 6]];

function makeTable(strings) {
  const data = strings.map((value) => Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
  const header = 4 + (data.length + 1) * 4;
  const bytes = Buffer.alloc(header + data.reduce((sum, item) => sum + item.length, 0));
  bytes.writeInt32LE(data.length, 0);
  let cursor = header;
  data.forEach((item, i) => { bytes.writeInt32LE(cursor - 4, 4 + i * 4); item.copy(bytes, cursor); cursor += item.length; });
  bytes.writeInt32LE(cursor - 4, 4 + data.length * 4);
  return bytes;
}

function makeScript(tokens) {
  const bytes = Buffer.alloc(2 + tokens.length * 5);
  bytes[0] = 0xb0; bytes[1] = 0xd0;
  tokens.forEach(([type, value], i) => { bytes[2 + i * 5] = type; bytes.writeUInt32LE(value >>> 0, 3 + i * 5); });
  return bytes;
}

function fixture({ tokens = TOKENS, strings = STRINGS } = {}) { return { script: makeScript(tokens), table: makeTable(strings) }; }

// Minimal synthetic PVF packing, with no real profession, skill, parameter or
// pool dataset. It exists only to exercise the public CLI and independent reader.
function packFixture(file, data, extraFiles = [{ name: "unrelated/fixture.bin", data: Buffer.from("preserved bytes") }]) {
  const files = [{ name: "stackable/scope_fixture.stk", data: data.script }, { name: "stringtable.bin", data: data.table }, ...extraFiles].map((item) => {
    const name = Buffer.from(item.name, "ascii");
    let nameHash = 0x1505;
    for (const byte of name) nameHash = (Math.imul(nameHash, 0x21) + byte) >>> 0;
    nameHash = Math.imul(nameHash, 0x21) >>> 0;
    const padded = Buffer.alloc((item.data.length + 3) & ~3);
    item.data.copy(padded);
    return { ...item, name, nameHash, padded, checksum: createChecksum(padded, padded.length, nameHash) };
  }).sort((a, b) => a.nameHash - b.nameHash);
  const tree = Buffer.alloc((files.reduce((sum, item) => sum + 20 + item.name.length, 0) + 3) & ~3);
  let cursor = 0; let offset = 0;
  for (const item of files) {
    tree.writeUInt32LE(item.nameHash, cursor); cursor += 4;
    tree.writeUInt32LE(item.name.length, cursor); cursor += 4;
    item.name.copy(tree, cursor); cursor += item.name.length;
    tree.writeInt32LE(item.data.length, cursor); cursor += 4;
    tree.writeUInt32LE(item.checksum, cursor); cursor += 4;
    tree.writeInt32LE(offset, cursor); cursor += 4;
    offset += item.padded.length;
  }
  const checksum = createChecksum(tree, tree.length, files.length);
  const guid = Buffer.from("SYNTHETIC-SCOPE-TEST");
  const header = Buffer.alloc(4 + guid.length + 16);
  header.writeInt32LE(guid.length); guid.copy(header, 4);
  let h = 4 + guid.length;
  for (const value of [2, tree.length, checksum, files.length]) { header.writeUInt32LE(value >>> 0, h); h += 4; }
  fs.writeFileSync(file, Buffer.concat([header, encrypt(tree, checksum), ...files.map((item) => encrypt(item.padded, item.checksum))]), { flag: "wx" });
}

async function runSelfTest(workbenchRoot) {
  const parent = runtimePath(workbenchRoot, "self-tests", "scope");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  const input = path.join(root, "input"); fs.mkdirSync(input);
  const checks = [];
  const test = async (id, run) => {
    try { await run(); checks.push({ id, ok: true }); }
    catch (error) { checks.push({ id, ok: false, error: error.message }); }
  };
  const base = fixture();
  const inspect = (value = base, section = SECTION) => inspectScope(value.script, value.table, section);
  const rejects = (run, code) => assert.throws(run, (error) => error.code === code);
  await test("literal-section-text-is-not-a-marker", () => assert.equal(inspect().proof.scopeCount, 1));
  await test("all-bytes-consumed-and-delimiters-protected", () => {
    const proof = inspect().proof;
    assert.equal(proof.bodyByteRange.start, 17); assert.equal(proof.bodyByteRange.endExclusive, 27);
    assert.equal(proof.protectedPrefixByteCount + proof.protectedSuffixByteCount + 10, base.script.length);
  });
  await test("unchanged-file-compares-without-semantic-approval", () => {
    const result = compareScope(base, fixture(), SECTION);
    assert.equal(result.scopeOutsidePreserved, true); assert.equal(result.domainSemanticValidation, "not-run");
    assert.equal(result.authorizesPvfGeneration, false); assert.equal(result.fullPackageCoverage, false);
  });
  const grown = fixture({ tokens: [...TOKENS.slice(0, 5), [2, 11], [2, 12], ...TOKENS.slice(5)] });
  await test("body-growth-preserves-independent-suffix-offset", () => assert.equal(compareScope(base, grown, SECTION).ok, true));
  await test("body-removal-keeps-delimiters", () => assert.equal(compareScope(base, fixture({ tokens: [...TOKENS.slice(0, 3), ...TOKENS.slice(5)] }), SECTION).ok, true));
  await test("inside-only-string-edit-does-not-change-outside", () => {
    const strings = [...STRINGS]; strings[4] = "new inside-only text";
    const result = compareScope(base, fixture({ strings }), SECTION);
    assert.equal(result.ok, true); assert.equal(result.rawBodyChanged, false);
  });
  await test("outside-string-table-edit-detected-with-identical-script-bytes", () => {
    const strings = [...STRINGS]; strings[6] = "altered protected meaning";
    const other = fixture({ strings }); assert.equal(base.script.equals(other.script), true);
    const result = compareScope(base, other, SECTION); assert.equal(result.ok, false); assert.equal(result.protectedReferencedStringsIdentical, false);
  });
  await test("shared-string-entry-edit-cannot-hide-inside", () => {
    const tokens = TOKENS.map((item) => [...item]); tokens[4] = [7, 6];
    const strings = [...STRINGS]; strings[6] = "changed shared entry";
    assert.equal(compareScope(fixture({ tokens }), fixture({ tokens, strings }), SECTION).ok, false);
  });
  await test("prefix-byte-change-detected", () => {
    const tokens = TOKENS.map((item) => [...item]); tokens[1][0] = 6;
    assert.equal(compareScope(base, fixture({ tokens }), SECTION).protectedPrefixIdentical, false);
  });
  await test("suffix-byte-change-detected", () => {
    const tokens = TOKENS.map((item) => [...item]); tokens[7][1]++;
    assert.equal(compareScope(base, fixture({ tokens }), SECTION).protectedSuffixIdentical, false);
  });
  await test("float-bit-drift-outside-detected", () => {
    const tokens = TOKENS.map((item) => [...item]); tokens[7] = [4, 0x3dcccccd];
    const other = tokens.map((item) => [...item]); other[7][1]++;
    assert.equal(compareScope(fixture({ tokens }), fixture({ tokens: other }), SECTION).ok, false);
  });
  await test("same-meaning-string-reindex-remains-conservatively-blocked", () => {
    const strings = [...STRINGS, STRINGS[6]];
    const tokens = TOKENS.map((item) => [...item]); tokens[8][1] = 7;
    assert.equal(compareScope(base, fixture({ tokens, strings }), SECTION).ok, false);
  });
  await test("unreferenced-string-append-allowed-for-selected-file-only", () => assert.equal(compareScope(base, fixture({ strings: [...STRINGS, "unrelated"] }), SECTION).ok, true));
  await test("partial-final-token-blocked", () => rejects(() => inspect({ ...base, script: Buffer.concat([base.script, Buffer.from([2])]) }), "SCOPE_SCRIPT_INVALID"));
  await test("non-script-blocked", () => rejects(() => inspect({ ...base, script: Buffer.from("not script") }), "SCOPE_SCRIPT_INVALID"));
  await test("unknown-token-blocked", () => rejects(() => inspect(fixture({ tokens: [...TOKENS, [255, 0]] })), "SCOPE_TOKEN_UNSUPPORTED"));
  await test("invalid-string-index-blocked", () => rejects(() => inspect(fixture({ tokens: [...TOKENS, [7, 999999]] })), "SCOPE_STRING_REFERENCE_INVALID"));
  await test("invalid-string-offset-blocked", () => {
    const broken = fixture(); broken.table.writeInt32LE(0, 4);
    rejects(() => inspect(broken), "SCOPE_STRING_REFERENCE_INVALID");
  });
  await test("missing-end-marker-blocked", () => rejects(() => inspect(fixture({ tokens: TOKENS.filter((_, i) => i !== 5) })), "SCOPE_MARKERS_AMBIGUOUS"));
  await test("repeated-region-blocked", () => rejects(() => inspect(fixture({ tokens: [...TOKENS, [5, 2], [5, 3]] })), "SCOPE_MARKERS_AMBIGUOUS"));
  await test("nested-region-blocked", () => rejects(() => inspect(fixture({ tokens: [...TOKENS.slice(0, 3), [5, 2], [5, 3], ...TOKENS.slice(3)] })), "SCOPE_MARKERS_AMBIGUOUS"));
  await test("reverse-markers-blocked", () => {
    const tokens = TOKENS.map((item) => [...item]); tokens[2][1] = 3; tokens[5][1] = 2;
    rejects(() => inspect(fixture({ tokens })), "SCOPE_MARKERS_AMBIGUOUS");
  });
  await test("unknown-selected-section-blocked", () => rejects(() => inspect(base, "[absent]"), "SCOPE_MARKERS_AMBIGUOUS"));
  await test("non-ascii-or-partial-selector-blocked", () => rejects(() => inspect(base, "[invalid\nsection]"), "SCOPE_SECTION_INVALID"));
  await test("outside-stringlink-remains-unresolved", () => rejects(() => inspect(fixture({ tokens: [...TOKENS, [9, 0], [10, 6]] })), "SCOPE_EXTERNAL_TEXT_UNRESOLVED"));
  await test("incomplete-stringlink-blocked", () => rejects(() => inspect(fixture({ tokens: [...TOKENS, [9, 0]] })), "SCOPE_STRINGLINK_INVALID"));
  await test("type10-outside-string-table-drift-cannot-pass", () => {
    const tokens = [...TOKENS, [10, 7]], originalStrings = [...STRINGS, "indirect protected value"];
    const strings = [...STRINGS, "changed indirect protected value"];
    const result = compareScope(fixture({ tokens, strings: originalStrings }), fixture({ tokens, strings }), SECTION);
    assert.equal(result.ok, false);
    assert.equal(result.protectedReferencedStringsIdentical, false);
  });
  await test("type10-invalid-reference-cannot-pass", () => rejects(() =>
    inspect(fixture({ tokens: [...TOKENS, [10, 999999]] })), "SCOPE_STRING_REFERENCE_INVALID"));
  await test("complete-stringlink-inside-does-not-expand-outside-scope", () => {
    const tokens = [...TOKENS.slice(0, 5), [9, 13], [10, 4], ...TOKENS.slice(5)];
    assert.equal(compareScope(fixture({ tokens }), fixture({ tokens }), SECTION).ok, true);
  });

  const source = path.join(input, "source.pvf"), candidate = path.join(input, "candidate.pvf"), corrupt = path.join(input, "outside-changed.pvf");
  packFixture(source, base); packFixture(candidate, grown);
  const changedStrings = [...STRINGS]; changedStrings[6] = "wrong outside text";
  packFixture(corrupt, fixture({ strings: changedStrings }));
  const beforeHashes = [source, candidate, corrupt].map((file) => sha256(fs.readFileSync(file)));
  const fingerprint = (file) => ({ sourcePvf: file, sourcePvfSha256: sha256(fs.readFileSync(file)),
    sourceSize: fs.statSync(file).size, sourceMtimeMs: fs.statSync(file).mtimeMs, stableDuringFingerprint: true });
  await test("independent-reader-opens-synthetic-pvf-and-compares", async () => {
    const result = await runScopeAudit({ sourcePvf: source, candidatePvf: candidate, pvfPath: "stackable/scope_fixture.stk", section: SECTION, fingerprint });
    assert.equal(result.scopeOutsidePreserved, true);
  });
  await test("source-drift-blocked", async () => {
    let calls = 0;
    await assert.rejects(() => runScopeAudit({ sourcePvf: source, pvfPath: "stackable/scope_fixture.stk", section: SECTION,
      read: async () => base, fingerprint: () => ({ ...fingerprint(source), sourcePvfSha256: ++calls === 1 ? beforeHashes[0] : "f".repeat(64) }) }),
    (error) => error.code === "SCOPE_SOURCE_CHANGED");
  });
  const cli = (args) => childProcess.spawnSync(process.execPath, [path.join(workbenchRoot, "core/pvf-agent-core/cli/pvf-readonly.js"), ...args],
    { cwd: workbenchRoot, encoding: "utf8", timeout: 30000, windowsHide: true });
  await test("public-cli-audit-and-report", () => {
    const result = cli(["scope-audit", "--pvf", source, "--path", "stackable/scope_fixture.stk", "--section", SECTION, "--out", path.join(root, "audit.json")]);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.inspection.scopeCount, 1);
  });
  await test("public-cli-valid-comparison", () => {
    const result = cli(["scope-compare", "--pvf", source, "--candidate-pvf", candidate, "--path", "stackable/scope_fixture.stk", "--section", SECTION, "--out", path.join(root, "compare.json")]);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.scopeOutsidePreserved, true);
  });
  await test("public-cli-outside-drift-returns-nonzero-with-failure-report", () => {
    const result = cli(["scope-compare", "--pvf", source, "--candidate-pvf", corrupt, "--path", "stackable/scope_fixture.stk", "--section", SECTION, "--out", path.join(root, "blocked.json")]);
    assert.equal(result.status, 1, result.stderr); assert.equal(JSON.parse(result.stdout).result.code, "SCOPE_OUTSIDE_CHANGED");
  });
  const packageCli = (target, name) => cli(["package-compare", "--pvf", source, "--candidate-pvf", target,
    "--path", "stackable/scope_fixture.stk", "--section", SECTION, "--out", path.join(root, name)]);
  await test("public-cli-whole-package-all-entry-readback", () => {
    const result = packageCli(candidate, "package-valid.json");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout).result;
    assert.equal(report.packageOutsideDeclaredBodyPreserved, true); assert.equal(report.fullPackageCoverage, true);
    assert.equal(report.package.comparedCount, 3); assert.equal(report.authorizesPvfGeneration, false);
  });
  await test("whole-package-rejects-unrelated-file-byte-change", () => {
    const file = path.join(input, "unrelated-changed.pvf");
    packFixture(file, grown, [{ name: "unrelated/fixture.bin", data: Buffer.from("altered bytes") }]);
    const result = packageCli(file, "package-unrelated.json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).result.package.unexpectedChangedCount, 1);
  });
  await test("whole-package-rejects-file-removal", () => {
    const file = path.join(input, "removed.pvf"); packFixture(file, grown, []);
    const result = packageCli(file, "package-removed.json");
    assert.equal(result.status, 1, result.stderr); assert.equal(JSON.parse(result.stdout).result.package.removedCount, 1);
  });
  await test("whole-package-rejects-file-addition", () => {
    const file = path.join(input, "added.pvf"); packFixture(file, grown, [
      { name: "unrelated/fixture.bin", data: Buffer.from("preserved bytes") }, { name: "extra/file.bin", data: Buffer.from("new") }]);
    const result = packageCli(file, "package-added.json");
    assert.equal(result.status, 1, result.stderr); assert.equal(JSON.parse(result.stdout).result.package.addedCount, 1);
  });
  await test("whole-package-rejects-old-string-rewrite-even-inside-allowed-body", () => {
    const strings = [...STRINGS]; strings[4] = "modified existing string";
    const file = path.join(input, "old-string-rewritten.pvf"); packFixture(file, fixture({ strings }));
    const result = packageCli(file, "package-old-string.json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).result.package.stringTable.changedOrMissingOriginalEntries, 1);
  });
  await test("whole-package-allows-appended-strings-with-body-reference", () => {
    const strings = [...STRINGS, "new body-only string"];
    const tokens = TOKENS.map((item) => [...item]); tokens[4][1] = 7;
    const file = path.join(input, "appended-string.pvf"); packFixture(file, fixture({ strings, tokens }));
    const result = packageCli(file, "package-append.json");
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.package.stringTable.appendedEntryCount, 1);
  });
  await test("stringtable-unaccounted-trailing-bytes-blocked", () => rejects(() =>
    compareStringTableAppendOnly(base.table, Buffer.concat([base.table, Buffer.from([0])])), "PACKAGE_STRING_TABLE_LAYOUT_UNRESOLVED"));
  await test("stringtable-entry-removal-blocked", () => assert.equal(compareStringTableAppendOnly(base.table, makeTable(STRINGS.slice(0, -1))).ok, false));
  await test("report-input-directory-protection", () => rejects(() => writeScopeReport(workbenchRoot, [source], path.join(input, "never.json"), {}), "EVIDENCE_OUTPUT_PROTECTED"));
  await test("existing-report-never-overwritten", () => assert.throws(() => writeScopeReport(workbenchRoot, [source], path.join(root, "audit.json"), {}), (error) => error.code === "EEXIST"));
  await test("synthetic-pvfs-unchanged", () => assert.deepEqual([source, candidate, corrupt].map((file) => sha256(fs.readFileSync(file))), beforeHashes));
  const report = { ok: checks.every((item) => item.ok), phase: "binary-script-scope-self-test", realUserPvfOrClientTouched: false,
    syntheticPvfCliIntegration: true, summary: { checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length }, checks };
  const reportPath = path.join(root, "SELF-TEST.json"); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}

module.exports = { runSelfTest };
