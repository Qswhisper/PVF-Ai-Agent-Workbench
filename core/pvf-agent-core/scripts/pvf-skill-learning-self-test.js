"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), cp = require("child_process");
const { runtimePath } = require("../lib/runtime-state");
const { sha256 } = require("../lib/pvf-evidence-export");
const { buildIdentityGraph } = require("../lib/pvf-skill-identity");
const { buildLearningEvidence, observeFields, auditLearning } = require("../lib/pvf-skill-learning");
const { script, pack } = require("./pvf-skill-identity-self-test");

function fixture(options = {}) {
  const strings = [], files = new Map();
  const str = (s) => { if (!strings.includes(s)) strings.push(s); return strings.indexOf(s); };
  const tag = (s) => [5, str(s)], text = (s) => [7, str(s)], num = (n) => [2, n];
  const registry = (rows) => script(rows.flatMap(([id, p]) => [num(id), text(p)]));
  files.set("character/character.lst", registry([[0, "a.chr"], [1, "b.chr"]]));
  files.set("skill/skilllist.lst", registry([[0, "a.lst"], [1, "b.lst"]]));
  for (const name of ["a", "b"]) {
    const chr = [tag("[job]"), text(`[fixture ${name}]`), tag("[growtype name]"), text("虛構"), text("fixture branch"),
      tag("[skill]"), num(17), num(1), tag("[/skill]"), tag("[growtype 9]"), tag("[awakening 4]"),
      tag("[awakening skill]"), ...(options.emptyAwakening ? [] : [num(options.missingReference ? 999 : 17), num(2)]), tag("[/awakening skill]")];
    files.set(`character/${name}.chr`, script(chr));
    files.set(`skill/${name}.lst`, registry([[17, `${name}.skl`]]));
    const values = [tag("[type]"), text("[active]"), tag("[maximum level]"), num(80),
      tag("[growtype maximum level]"), num(2), num(3), tag("[skill fitness growtype]"), num(0), num(7), tag("[/skill fitness growtype]"),
      tag("[pre required skill]"), num(17), ...(options.oddPairs ? [] : [num(1)]), tag("[/pre required skill]"),
      tag("[feature skill index]"), num(options.missingFeature ? 999 : 17), tag("[explain]"), text("[maximum level] 999")];
    if (options.repeatedMaximum) values.push(tag("[maximum level]"), num(1));
    if (options.nonfinite) values.push(tag("[required level]"), [4, 0x7f800000]);
    if (options.nonAsciiTag) values.push(tag("[虚构字段]"), num(1));
    if (options.unclosedReference) values[values.findIndex((t) => t[0] === 5 && strings[t[1]] === "[/pre required skill]")] = tag("[fixture next]");
    files.set(`skill/${name}.skl`, script(values));
  }
  const parts = strings.map((s) => Buffer.from(s, "utf8")), header = 4 + 4 * (parts.length + 1);
  const table = Buffer.alloc(header + parts.reduce((s, b) => s + b.length, 0)); table.writeInt32LE(parts.length);
  let cursor = header;
  parts.forEach((b, i) => { table.writeInt32LE(cursor - 4, 4 + i * 4); b.copy(table, cursor); cursor += b.length; });
  table.writeInt32LE(cursor - 4, 4 + parts.length * 4); files.set("stringtable.bin", table);
  return files;
}

async function runSelfTest(root) {
  const parent = runtimePath(root, "self-tests", "skill-learning"); fs.mkdirSync(parent, { recursive: true });
  const run = fs.mkdtempSync(path.join(parent, "run-")), checks = [], source = { sourcePvfSha256: "a".repeat(64) };
  const test = async (id, fn) => { try { await fn(); checks.push({ id, ok: true }); } catch (e) { checks.push({ id, ok: false, error: e.message }); } };
  const inspect = async (files = fixture()) => {
    const read = async (p) => { if (!files.has(p)) throw Error("Missing synthetic file"); return files.get(p); };
    const graph = await buildIdentityGraph({ read, sourceFingerprint: source }); return buildLearningEvidence(graph, read);
  };
  const base = await inspect(), obs = base.branches[0].skills[0].observation;
  await test("complete-current-chain-observed", () => { assert.equal(base.ok, true); assert.equal(base.summary.observedSkillRows, 2); assert.equal(base.summary.referenceCount, 8); });
  await test("same-number-retains-own-registry", () => { assert.equal(base.branches[0].skills[0].references[0].pvfPath, "skill/a.skl"); assert.equal(base.branches[1].skills[0].references[0].pvfPath, "skill/b.skl"); });
  await test("literal-description-does-not-create-field", () => assert.equal(obs.fields.filter((f) => f.tag === "[maximum level]").length, 1));
  await test("absent-field-not-zero", () => { assert.ok(obs.absentFields.includes("[required level]")); assert.ok(!obs.fields.some((f) => f.tag === "[required level]")); });
  await test("declared-maximum-is-not-playable-maximum", () => { assert.equal(obs.fields.find((f) => f.tag === "[maximum level]").values[0].integer, 80); assert.equal(base.actualLearnableMaximum, "unresolved"); });
  await test("growth-column-position-not-runtime-id", () => { assert.equal(base.growtypeColumnMapping, "unresolved"); assert.deepEqual(obs.fields.find((f) => f.tag === "[skill fitness growtype]").values.map((v) => v.integer), [0, 7]); });
  await test("lexical-parent-markers-preserved-without-enum-claim", () => { const f = base.branches[0].character.fields.find((f) => f.tag === "[awakening skill]"); assert.equal(f.lexicalContext.precedingGrowMarker.tag, "[growtype 9]"); assert.equal(f.lexicalContext.precedingAwakeningMarker.tag, "[awakening 4]"); assert.equal(f.lexicalContext.runtimeMappingConfirmed, false); });
  await test("non-ascii-name-kept-as-byte-evidence-not-guessed", () => { const f = base.branches[0].character.fields[0]; assert.equal(f.values[0].ascii, null); assert.equal(f.values[0].stringRawSha256.length, 64); });
  await test("duplicates-retain-both-values", async () => { const o = (await inspect(fixture({ repeatedMaximum: true }))).branches[0].skills[0].observation; assert.ok(o.repeatedFields.includes("[maximum level]")); assert.deepEqual(o.fields.filter((f) => f.tag === "[maximum level]").map((f) => f.values[0].integer), [80, 1]); });
  await test("empty-awakening-does-not-grant-skill", async () => { const r = await inspect(fixture({ emptyAwakening: true })); assert.equal(r.summary.referenceCount, 6); assert.equal(r.runtimeValidation, "not-run"); });
  await test("missing-reference-remains-visible-and-blocks", async () => { const r = await inspect(fixture({ missingReference: true })); assert.equal(r.ok, false); assert.equal(r.observationComplete, true); assert.equal(r.summary.unresolvedReferences, 2); });
  await test("missing-target-id-not-overwritten-by-owner-id", async () => { const r = await inspect(fixture({ missingFeature: true })); const issue = r.issues.find((i) => i.tag === "[feature skill index]"); assert.equal(issue.skillId, 999); assert.equal(issue.ownerSkillId, 17); });
  await test("odd-reference-list-not-partially-resolved", async () => { const r = await inspect(fixture({ oddPairs: true })); assert.equal(r.ok, false); assert.ok(r.issues.some((i) => i.code === "LEARNING_REFERENCE_SHAPE_UNRESOLVED")); });
  await test("missing-reference-close-not-silently-accepted", async () => assert.equal((await inspect(fixture({ unclosedReference: true }))).ok, false));
  await test("nonfinite-number-retains-bits-not-json-zero", async () => { const o = (await inspect(fixture({ nonfinite: true }))).branches[0].skills[0].observation; const v = o.fields.find((f) => f.tag === "[required level]").values[0]; assert.equal(v.float, null); assert.equal(v.rawUInt32, 0x7f800000); });
  await test("partial-token-stops-observation", () => { const f = fixture(); assert.throws(() => observeFields(Buffer.concat([f.get("skill/a.skl"), Buffer.from([1])]), f.get("stringtable.bin"), "skill")); });
  await test("unresolved-tag-retains-exact-file-and-byte-evidence", async () => {
    const f = fixture({ nonAsciiTag: true }), r = await inspect(f);
    const issue = r.issues.find((i) => i.code === "LEARNING_TAG_UNRESOLVED");
    assert.equal(r.observationComplete, false);
    assert.equal(issue.pvfPath, "skill/a.skl");
    assert.equal(issue.skillId, 17);
    assert.equal(issue.byteOffset, f.get("skill/a.skl").length - 10);
    assert.equal(issue.stringRawSha256, sha256(Buffer.from("[虚构字段]")));
    assert.equal(issue.stringByteCount, Buffer.byteLength("[虚构字段]"));
  });
  await test("character-observation-error-retains-exact-path", async () => {
    const f = fixture(), read = async (p) => f.get(p);
    const graph = await buildIdentityGraph({ read, sourceFingerprint: source });
    f.set("character/a.chr", script([[2, 7]]));
    const r = await buildLearningEvidence(graph, read);
    assert.equal(r.issues.find((i) => i.code === "LEARNING_EVIDENCE_DRIFT").pvfPath, "character/a.chr");
  });
  await test("same-session-evidence-drift-blocked", async () => { const f = fixture(); const graph = await buildIdentityGraph({ read: async (p) => f.get(p), sourceFingerprint: source }); f.set("skill/a.skl", script([[2, 77]])); const r = await buildLearningEvidence(graph, async (p) => f.get(p)); assert.equal(r.ok, false); assert.ok(r.issues.some((i) => i.code === "LEARNING_EVIDENCE_DRIFT")); });
  await test("no-semantic-or-generation-approval", () => { assert.equal(base.semanticContractReady, false); assert.equal(base.authorizesPvfGeneration, false); assert.equal(base.skillTreeValidation, "not-run"); });
  const input = path.join(run, "input"); fs.mkdirSync(input); const pvf = path.join(input, "fixture.pvf"); pack(pvf, fixture());
  const hash = sha256(fs.readFileSync(pvf));
  const fp = () => ({ sourcePvf: pvf, sourcePvfSha256: hash, sourceSize: fs.statSync(pvf).size, sourceMtimeMs: fs.statSync(pvf).mtimeMs, stableDuringFingerprint: true });
  await test("independent-live-synthetic-read", async () => assert.equal((await auditLearning(pvf, fp)).ok, true));
  await test("source-change-through-learning-lane-blocked", async () => { let n = 0; await assert.rejects(() => auditLearning(pvf, () => ({ ...fp(), sourcePvfSha256: ++n === 1 ? hash : "f".repeat(64) })), (e) => e.code === "IDENTITY_SOURCE_CHANGED"); });
  const cli = (p, out) => cp.spawnSync(process.execPath, [path.join(root, "core/pvf-agent-core/cli/pvf-readonly.js"), "skill-learning-audit", "--pvf", p, "--out", out], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  await test("public-cli-writes-independent-report", () => { const out = path.join(run, "learning.json"), r = cli(pvf, out); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(fs.readFileSync(out)).semanticContractReady, false); });
  await test("public-cli-unresolved-report-and-nonzero", () => { const bad = path.join(input, "missing.pvf"); pack(bad, fixture({ missingReference: true })); const out = path.join(run, "blocked.json"), r = cli(bad, out); assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(fs.readFileSync(out)).summary.unresolvedReferences, 2); });
  await test("public-cli-existing-report-protected", () => assert.notEqual(cli(pvf, path.join(run, "learning.json")).status, 0));
  await test("synthetic-source-unchanged", () => assert.equal(sha256(fs.readFileSync(pvf)), hash));
  const result = { ok: checks.every((c) => c.ok), phase: "skill-learning-self-test", realUserPvfOrClientTouched: false,
    summary: { checkCount: checks.length, failedChecks: checks.filter((c) => !c.ok).length }, checks };
  const reportPath = path.join(run, "SELF-TEST.json"); fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  return { ...result, reportPath };
}
module.exports = { runSelfTest };
