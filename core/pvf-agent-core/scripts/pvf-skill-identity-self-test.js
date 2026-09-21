"use strict";
const assert = require("assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { sha256 } = require("../lib/pvf-evidence-export");
const { buildIdentityGraph, checkIdentityClaims, auditSkillIdentity } = require("../lib/pvf-skill-identity");
const { createChecksum, encrypt } = require("../../../tools/pvf-bridge/fallback/codec.ts");

function script(tokens) {
  const b = Buffer.alloc(2 + tokens.length * 5); b[0] = 0xb0; b[1] = 0xd0;
  tokens.forEach(([type, value], i) => { b[2 + 5 * i] = type; b.writeUInt32LE(value >>> 0, 3 + 5 * i); }); return b;
}
function fixture(options = {}) {
  const strings = [], files = new Map(), index = (s) => { if (!strings.includes(s)) strings.push(s); return strings.indexOf(s); };
  const registry = (rows) => script(rows.flatMap(([id, p]) => [[2, id], [7, index(p)]]));
  files.set("character/character.lst", registry([[0, options.characterPath || "a.chr"], [1, "b.chr"]]));
  files.set("skill/skilllist.lst", registry(options.missingRoot ? [[0, "a.lst"]] : [[0, "a.lst"], [1, "b.lst"]]));
  for (const [id, name] of [[0, "a"], [1, "b"]]) {
    const job = options.duplicateJob ? "[fixture a]" : `[fixture ${name}]`;
    const jobTokens = [[5, index("[job]")], [7, index(job)], [5, index("[fixture next]")], [2, 1]];
    if (options.duplicateJobField && id === 0) jobTokens.push([5, index("[job]")], [7, index(job)]);
    files.set(`character/${name}.chr`, script(jobTokens));
    const rows = [[17, `${name}.skl`]];
    if (options.duplicateId && id === 0) rows.push([17, `${name}.skl`]);
    if (options.alias && id === 0) rows.push([18, `${name}.skl`]);
    files.set(`skill/${name}.lst`, registry(rows));
    files.set(`skill/${name}.skl`, script([[5, index("[fixture data]")], [2, id + 1]]));
  }
  const parts = strings.map((s) => Buffer.from(s)), header = 4 + (parts.length + 1) * 4;
  const table = Buffer.alloc(header + parts.reduce((sum, b) => sum + b.length, 0));
  table.writeInt32LE(parts.length); let cursor = header;
  parts.forEach((b, i) => { table.writeInt32LE(cursor - 4, 4 + i * 4); b.copy(table, cursor); cursor += b.length; });
  table.writeInt32LE(cursor - 4, 4 + parts.length * 4); files.set("stringtable.bin", table);
  if (options.missingSkill) files.delete("skill/a.skl");
  if (options.partialSkill) files.set("skill/a.skl", Buffer.concat([files.get("skill/a.skl"), Buffer.from([2])]));
  return files;
}
function pack(file, files) {
  const entries = [...files].map(([name, data]) => {
    const nameBytes = Buffer.from(name); let nameHash = 0x1505;
    for (const b of nameBytes) nameHash = (Math.imul(nameHash, 33) + b) >>> 0;
    nameHash = Math.imul(nameHash, 33) >>> 0;
    const padded = Buffer.alloc((data.length + 3) & ~3); data.copy(padded);
    return { nameBytes, nameHash, data, padded, checksum: createChecksum(padded, padded.length, nameHash) };
  }).sort((a, b) => a.nameHash - b.nameHash);
  const tree = Buffer.alloc((entries.reduce((sum, e) => sum + 20 + e.nameBytes.length, 0) + 3) & ~3);
  let p = 0, offset = 0;
  for (const e of entries) {
    tree.writeUInt32LE(e.nameHash, p); p += 4; tree.writeUInt32LE(e.nameBytes.length, p); p += 4;
    e.nameBytes.copy(tree, p); p += e.nameBytes.length; tree.writeInt32LE(e.data.length, p); p += 4;
    tree.writeUInt32LE(e.checksum, p); p += 4; tree.writeInt32LE(offset, p); p += 4; offset += e.padded.length;
  }
  const checksum = createChecksum(tree, tree.length, entries.length), guid = Buffer.from("SYNTHETIC-IDENTITY-TEST");
  const header = Buffer.alloc(4 + guid.length + 16); header.writeInt32LE(guid.length); guid.copy(header, 4); p = 4 + guid.length;
  for (const value of [2, tree.length, checksum, entries.length]) { header.writeUInt32LE(value >>> 0, p); p += 4; }
  fs.writeFileSync(file, Buffer.concat([header, encrypt(tree, checksum), ...entries.map((e) => encrypt(e.padded, e.checksum))]), { flag: "wx" });
}

async function runSelfTest(workbenchRoot) {
  const parent = runtimePath(workbenchRoot, "self-tests", "skill-identity"); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  const mockSource = { sourcePvfSha256: "a".repeat(64) }, checks = [];
  const graph = async (files = fixture()) => buildIdentityGraph({ sourceFingerprint: mockSource, read: async (p) => {
    if (!files.has(p)) { const e = new Error(`Missing fixture: ${p}`); e.code = "FIXTURE_MISSING"; throw e; } return files.get(p);
  } });
  const claim = (overrides = {}) => ({ characterId: 0, jobToken: "[fixture a]", skillRegistry: "skill/a.lst", skillId: 17, expectedPvfPath: "skill/a.skl", ...overrides });
  const claims = (rows = [claim()], sourceHash = mockSource.sourcePvfSha256) => ({ format: "pvf-skill-identity-claims-v1", sourcePvfSha256: sourceHash, claims: rows });
  const base = await graph();
  const test = async (id, run) => { try { await run(); checks.push({ id, ok: true }); } catch (e) { checks.push({ id, ok: false, error: e.message }); } };
  await test("fresh-root-character-registry-skill-chain", () => { assert.equal(base.complete, true); assert.equal(base.summary.confirmedSkillRows, 2); assert.equal(base.summary.evidenceFileCount, 9); });
  await test("same-skill-id-in-different-branches-is-not-global", () => {
    const r = checkIdentityClaims(base, claims([claim(), claim({ characterId: 1, jobToken: "[fixture b]", skillRegistry: "skill/b.lst", expectedPvfPath: "skill/b.skl" })])); assert.equal(r.ok, true);
  });
  for (const [name, patch, code] of [
    ["wrong-job-token", { jobToken: "[fixture b]" }, "IDENTITY_JOB_MISMATCH"],
    ["wrong-registry", { skillRegistry: "skill/b.lst" }, "IDENTITY_REGISTRY_MISMATCH"],
    ["same-id-wrong-file", { expectedPvfPath: "skill/b.skl" }, "IDENTITY_PATH_MISMATCH"],
    ["missing-skill", { skillId: 999 }, "IDENTITY_SKILL_UNRESOLVED"],
    ["missing-character", { characterId: 999 }, "IDENTITY_CHARACTER_UNRESOLVED"],
    ["space-folding-not-an-identity-proof", { jobToken: "[fixturea]" }, "IDENTITY_JOB_MISMATCH"],
  ]) await test(name, () => { const r = checkIdentityClaims(base, claims([claim(patch)])); assert.equal(r.ok, false); assert.ok(r.results[0].errors.includes(code)); });
  await test("duplicate-claim-blocked", () => assert.equal(checkIdentityClaims(base, claims([claim(), claim()])).ok, false));
  await test("source-hash-drift-blocks-all-claims", () => { const r = checkIdentityClaims(base, claims([claim()], "b".repeat(64))); assert.equal(r.ok, false); assert.equal(r.results[0].ok, false); });
  await test("unknown-parameter-field-not-silently-accepted", () => assert.throws(() => checkIdentityClaims(base, claims([claim({ parameterColumn: 1 })])), (e) => e.code === "IDENTITY_CLAIMS_FORMAT_INVALID"));
  await test("empty-claims-blocked", () => assert.throws(() => checkIdentityClaims(base, claims([])), (e) => e.code === "IDENTITY_CLAIMS_FORMAT_INVALID"));
  await test("path-traversal-blocked", () => assert.throws(() => checkIdentityClaims(base, claims([claim({ expectedPvfPath: "../a.skl" })])), (e) => e.code === "EVIDENCE_PATH_INVALID"));
  await test("duplicate-registry-id-kept-unresolved", async () => { const g = await graph(fixture({ duplicateId: true })); assert.equal(g.complete, false); assert.ok(g.issues.some((i) => i.code === "IDENTITY_DUPLICATE_ID")); });
  await test("aliases-retain-both-ids-without-semantic-merging", async () => { const g = await graph(fixture({ alias: true })); assert.equal(g.complete, true); assert.deepEqual(g.branches[0].pathAliases[0].skillIds, [17, 18]); });
  await test("duplicate-job-token-blocks-global-graph", async () => { const g = await graph(fixture({ duplicateJob: true })); assert.equal(g.complete, false); assert.equal(checkIdentityClaims(g, claims()).ok, false); });
  await test("duplicate-job-field-not-first-match-wins", async () => { const g = await graph(fixture({ duplicateJobField: true })); assert.equal(g.complete, false); assert.ok(g.issues.some((i) => i.code === "IDENTITY_JOB_AMBIGUOUS")); });
  await test("missing-root-counterpart-is-unresolved", async () => assert.equal((await graph(fixture({ missingRoot: true }))).complete, false));
  await test("missing-skill-file-not-silently-dropped", async () => { const g = await graph(fixture({ missingSkill: true })); assert.equal(g.summary.registeredSkillRows, 2); assert.equal(g.summary.confirmedSkillRows, 1); assert.equal(g.branches[0].skills[0].status, "unresolved"); });
  await test("partial-binary-skill-blocked", async () => assert.equal((await graph(fixture({ partialSkill: true }))).complete, false));
  await test("invalid-type10-string-reference-blocked", async () => { const f = fixture(); f.set("skill/a.skl", script([[10, 0xffffffff]])); assert.equal((await graph(f)).complete, false); });
  await test("empty-root-has-explicit-blocker", async () => { const f = fixture(); f.set("character/character.lst", script([])); const g = await graph(f); assert.equal(g.complete, false); assert.ok(g.issues.some((i) => i.code === "IDENTITY_ROOT_EMPTY")); });
  await test("empty-skill-registry-not-vacuous-success", async () => { const f = fixture(); f.set("skill/a.lst", script([])); const g = await graph(f); assert.equal(g.complete, false); assert.ok(g.issues.some((i) => i.code === "IDENTITY_SKILL_REGISTRY_EMPTY")); });
  await test("root-registry-path-escape-blocked", async () => assert.rejects(() => graph(fixture({ characterPath: "../a.chr" })), (e) => e.code === "EVIDENCE_PATH_INVALID"));
  await test("odd-registry-token-not-skipped", async () => { const f = fixture(); f.set("skill/a.lst", Buffer.concat([f.get("skill/a.lst"), script([[2, 18]]).subarray(2)])); const g = await graph(f); assert.equal(g.complete, false); });
  await test("identity-not-playability-or-parameter-approval", () => { const r = checkIdentityClaims(base, claims()); assert.equal(r.ok, true); assert.equal(r.equipmentSlotValidation, "not-run"); assert.equal(r.parameterSemanticsValidation, "not-run"); assert.equal(r.authorizesPvfGeneration, false); });

  const input = path.join(root, "input"); fs.mkdirSync(input); const source = path.join(input, "source.pvf"); pack(source, fixture());
  const sourceHash = sha256(fs.readFileSync(source));
  const fingerprint = () => ({ sourcePvf: source, sourcePvfSha256: sourceHash, sourceSize: fs.statSync(source).size, sourceMtimeMs: fs.statSync(source).mtimeMs, stableDuringFingerprint: true });
  await test("independent-raw-reader-live-synthetic-pvf", async () => assert.equal((await auditSkillIdentity(source, fingerprint)).complete, true));
  await test("source-drift-during-live-audit-blocked", async () => {
    let n = 0; await assert.rejects(() => auditSkillIdentity(source, () => ({ ...fingerprint(), sourcePvfSha256: ++n === 1 ? sourceHash : "f".repeat(64) })), (e) => e.code === "IDENTITY_SOURCE_CHANGED");
  });
  const runCli = (args) => childProcess.spawnSync(process.execPath, [path.join(workbenchRoot, "core/pvf-agent-core/cli/pvf-readonly.js"), ...args], { cwd: workbenchRoot, encoding: "utf8", windowsHide: true, timeout: 30000 });
  await test("public-cli-audit", () => { const r = runCli(["skill-identity-audit", "--pvf", source, "--out", path.join(root, "audit.json")]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).summary.confirmedSkillRows, 2); });
  await test("public-cli-correct-identity-check", () => {
    const file = path.join(root, "claims.json"); fs.writeFileSync(file, JSON.stringify(claims([claim()], sourceHash)));
    const r = runCli(["skill-identity-check", "--pvf", source, "--claims", file, "--out", path.join(root, "check.json")]); assert.equal(r.status, 0, r.stderr);
  });
  await test("public-cli-wrong-branch-nonzero-and-report", () => {
    const file = path.join(root, "wrong.json"); fs.writeFileSync(file, JSON.stringify(claims([claim({ jobToken: "[fixture b]" })], sourceHash)));
    const r = runCli(["skill-identity-check", "--pvf", source, "--claims", file, "--out", path.join(root, "blocked.json")]); assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).results[0].ok, false);
  });
  await test("synthetic-source-unchanged", () => assert.equal(sha256(fs.readFileSync(source)), sourceHash));
  const result = { ok: checks.every((c) => c.ok), phase: "skill-identity-self-test", realUserPvfOrClientTouched: false,
    syntheticPvfCliIntegration: true, summary: { checkCount: checks.length, failedChecks: checks.filter((c) => !c.ok).length }, checks };
  const reportPath = path.join(root, "SELF-TEST.json"); fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  return { ...result, reportPath };
}
module.exports = { runSelfTest, script, pack };
