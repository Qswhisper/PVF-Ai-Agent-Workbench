"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { exportEvidence, verifyEvidence, sha256 } = require("../lib/pvf-evidence-export");

async function runSelfTest(workbenchRoot) {
  const parent = runtimePath(workbenchRoot, "self-tests", "evidence");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  const sourceDir = path.join(root, "input");
  fs.mkdirSync(sourceDir);
  const sourcePvf = path.join(sourceDir, "synthetic-source.dat");
  fs.writeFileSync(sourcePvf, "synthetic source, not a PVF");
  const sourceHash = sha256(fs.readFileSync(sourcePvf));
  const source = { sourcePvf, sourcePvfSha256: sourceHash, sourceSize: fs.statSync(sourcePvf).size,
    sourceMtimeMs: fs.statSync(sourcePvf).mtimeMs, stableDuringFingerprint: true };
  const canonical = "[fixture]\r\n`多行\r\n测试`\r\n" + "[fixture value]\r\n1\r\n".repeat(5000);
  const fullRead = (pvfPath, text = canonical) => ({ ok: true, pvfPath, textContent: text,
    truncated: false, hasMore: false, sourceCharCount: text.length, returnedCharCount: text.length,
    remainingCharCount: 0, returnedRange: { startChar: 0, endCharExclusive: text.length } });
  const read = async (pvfPath) => ({ file: fullRead(pvfPath), selectedEncoding: "Tw" });
  const common = { workbenchRoot, sourcePvf, fingerprint: () => ({ ...source }), read };
  let serial = 0;
  const outputDir = () => path.join(root, `batch-${++serial}`);
  const make = (overrides = {}) => exportEvidence({ ...common, paths: ["stackable/fictional.stk"], outputDir: outputDir(), purpose: "boundary-only", ...overrides });
  const check = (evidence, overrides = {}) => verifyEvidence({ ...common, manifestPath: evidence.manifestPath,
    manifestSha256: evidence.manifestSha256, ...overrides });
  const checks = [];
  async function test(id, action) {
    try { await action(); checks.push({ id, ok: true }); }
    catch (error) { checks.push({ id, ok: false, error: error.message }); }
  }
  const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code);
  const rewrite = (evidence, mutate) => {
    const manifest = JSON.parse(fs.readFileSync(evidence.manifestPath, "utf8"));
    mutate(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(evidence.manifestPath, bytes);
    return { ...evidence, manifestSha256: sha256(bytes) };
  };
  await test("complete-large-multiline-export-and-live-readback", async () => {
    const result = await make();
    assert.equal(result.items[0].sourceCharCount, canonical.length);
    assert.equal(fs.readFileSync(path.join(path.dirname(result.manifestPath), result.items[0].textFile), "utf8"), canonical);
    assert.equal((await check(result)).freshCanonicalReadback, true);
  });
  await test("multiple-files-complete", async () => {
    const result = await make({ paths: ["a/one.stk", "b/two.stk"] });
    assert.equal((await check(result)).fileCount, 2);
  });
  await test("empty-canonical-file-is-valid", async () => {
    const empty = async (p) => ({ file: fullRead(p, ""), selectedEncoding: "Cn" });
    assert.equal((await check(await make({ read: empty }), { read: empty })).totalBytes, 0);
  });
  await test("truncated-read-has-no-success-manifest", async () => {
    const out = outputDir();
    await rejects(() => make({ outputDir: out, read: async (p) => ({ file: { ...fullRead(p), truncated: true }, selectedEncoding: "Tw" }) }), "EVIDENCE_INCOMPLETE");
    assert.equal(fs.existsSync(path.join(out, "EVIDENCE.json")), false);
    assert.equal(fs.existsSync(path.join(out, "INCOMPLETE.json")), true);
  });
  await test("missing-completeness-metadata-blocked", async () => {
    await rejects(() => make({ read: async (p) => ({ file: { ...fullRead(p), returnedRange: undefined }, selectedEncoding: "Tw" }) }), "EVIDENCE_INCOMPLETE");
  });
  await test("wrong-returned-path-blocked", async () => {
    await rejects(() => make({ read: async () => ({ file: fullRead("wrong.stk"), selectedEncoding: "Tw" }) }), "EVIDENCE_READ_INVALID");
  });
  await test("unknown-encoding-blocked", async () => {
    await rejects(() => make({ read: async (p) => ({ file: fullRead(p), selectedEncoding: "unknown" }) }), "EVIDENCE_ENCODING_INVALID");
  });
  await test("lossy-utf8-artifact-blocked", async () => {
    await rejects(() => make({ read: async (p) => ({ file: fullRead(p, "\ud800"), selectedEncoding: "Tw" }) }), "EVIDENCE_TEXT_UNREPRESENTABLE");
  });
  await test("duplicate-paths-blocked", () => rejects(() => make({ paths: ["a.stk", "A.stk"] }), "EVIDENCE_SCOPE_DUPLICATE"));
  await test("path-traversal-blocked", () => rejects(() => make({ paths: ["../a.stk"] }), "EVIDENCE_PATH_INVALID"));
  await test("empty-scope-blocked", () => rejects(() => make({ paths: [] }), "EVIDENCE_SCOPE_INVALID"));
  await test("unlimited-read-budget-blocked", () => rejects(() => make({ maxChars: 0 }), "EVIDENCE_LIMIT_INVALID"));
  await test("purpose-must-be-explicit", () => rejects(() => make({ purpose: undefined }), "EVIDENCE_PURPOSE_REQUIRED"));
  await test("workbench-output-blocked", () => rejects(() => make({ outputDir: path.join(workbenchRoot, "evidence-never-create") }), "EVIDENCE_OUTPUT_PROTECTED"));
  await test("input-directory-output-blocked", () => rejects(() => make({ outputDir: path.join(sourceDir, "evidence-never-create") }), "EVIDENCE_OUTPUT_PROTECTED"));
  await test("junction-output-to-workbench-blocked", async () => {
    const link = path.join(root, "alias");
    fs.symlinkSync(workbenchRoot, link, process.platform === "win32" ? "junction" : "dir");
    await rejects(() => make({ outputDir: path.join(link, "evidence-never-create") }), "EVIDENCE_OUTPUT_PROTECTED");
    fs.unlinkSync(link);
  });
  await test("existing-output-not-overwritten", async () => {
    const out = outputDir();
    const result = await make({ outputDir: out });
    await assert.rejects(() => make({ outputDir: out }), (error) => error.code === "EEXIST");
    assert.equal(sha256(fs.readFileSync(result.manifestPath)), result.manifestSha256);
  });
  await test("source-drift-during-export-blocked", async () => {
    let calls = 0;
    await rejects(() => make({ fingerprint: () => ({ ...source, sourcePvfSha256: ++calls === 1 ? sourceHash : "f".repeat(64) }) }), "EVIDENCE_SOURCE_CHANGED");
  });
  await test("manifest-tamper-blocked", async () => {
    const result = await make();
    fs.appendFileSync(result.manifestPath, " ");
    await rejects(() => check(result), "EVIDENCE_MANIFEST_CHANGED");
  });
  await test("artifact-tamper-blocked", async () => {
    const result = await make();
    fs.appendFileSync(path.join(path.dirname(result.manifestPath), result.items[0].textFile), "changed");
    await rejects(() => check(result), "EVIDENCE_ARTIFACT_CHANGED");
  });
  await test("artifact-and-hashes-forged-still-fail-live-readback", async () => {
    const result = await make();
    const forged = canonical.replace("[fixture value]", "[different field]");
    fs.writeFileSync(path.join(path.dirname(result.manifestPath), result.items[0].textFile), forged);
    const updated = rewrite(result, (m) => {
      m.items[0].canonicalTextSha256 = sha256(forged);
      m.items[0].utf8ByteCount = Buffer.byteLength(forged);
      m.items[0].sourceCharCount = forged.length;
      m.totalBytes = Buffer.byteLength(forged);
    });
    await rejects(() => check(updated), "EVIDENCE_LIVE_READBACK_MISMATCH");
  });
  await test("artifact-path-injection-blocked", async () => {
    const result = rewrite(await make(), (m) => { m.items[0].textFile = "../input/synthetic-source.dat"; });
    await rejects(() => check(result), "EVIDENCE_ITEM_INVALID");
  });
  await test("different-source-cannot-reuse-evidence", async () => {
    const result = await make();
    await rejects(() => check(result, { fingerprint: () => ({ ...source, sourcePvfSha256: "e".repeat(64) }) }), "EVIDENCE_SOURCE_MISMATCH");
  });
  await test("incomplete-marker-blocks-verification", async () => {
    const result = await make();
    fs.writeFileSync(path.join(path.dirname(result.manifestPath), "INCOMPLETE.json"), "{}");
    await rejects(() => check(result), "EVIDENCE_INCOMPLETE");
  });
  await test("truncated-live-readback-blocked", async () => {
    const result = await make();
    await rejects(() => check(result, { read: async (p) => ({ file: { ...fullRead(p), hasMore: true }, selectedEncoding: "Tw" }) }), "EVIDENCE_INCOMPLETE");
  });
  await test("source-drift-during-verification-blocked", async () => {
    const result = await make();
    let calls = 0;
    await rejects(() => check(result, { fingerprint: () => ({ ...source, sourcePvfSha256: ++calls === 1 ? sourceHash : "d".repeat(64) }) }), "EVIDENCE_SOURCE_CHANGED");
  });
  await test("integrity-never-implies-semantic-or-write-approval", async () => {
    const result = await check(await make());
    assert.equal(result.semanticValidation, "not-run");
    assert.equal(result.runtimeValidation, "not-run");
    assert.equal(result.authorizesPvfGeneration, false);
    assert.equal(result.purpose, "boundary-only");
  });
  await test("synthetic-source-unchanged", async () => assert.equal(sha256(fs.readFileSync(sourcePvf)), sourceHash));
  const report = { ok: checks.every((item) => item.ok), phase: "canonical-evidence-self-test",
    scope: "Synthetic injected canonical reader; real-PVF CLI integration must be checked separately.",
    realPvfOrClientTouched: false, summary: { checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length }, checks };
  const reportPath = path.join(root, "SELF-TEST.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}

module.exports = { runSelfTest };
