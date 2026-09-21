"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), cp = require("child_process");
const { runtimePath } = require("../lib/runtime-state");
const { sha256 } = require("../lib/pvf-evidence-export");
const { buildIdentityGraph } = require("../lib/pvf-skill-identity");
const { inspectEquipment, scanEquipment, auditEquipment } = require("../lib/pvf-equipment-eligibility");
const { script, pack } = require("./pvf-skill-identity-self-test");

function fixture(options = {}) {
  const strings = [], files = new Map(), str = (s) => { if (!strings.includes(s)) strings.push(s); return strings.indexOf(s); };
  const tag = (s) => [5, str(s)], text = (s) => [7, str(s)], num = (n) => [2, n];
  const registry = (rows) => script(rows.flatMap(([id, p]) => [num(id), text(p)]));
  files.set("character/character.lst", registry([[4, "a.chr"], [5, "b.chr"]]));
  files.set("skill/skilllist.lst", registry([[4, "a.lst"], [5, "b.lst"]]));
  for (const name of ["a", "b"]) {
    files.set(`character/${name}.chr`, script([tag("[job]"), text(`[fixture ${name}]`)]));
    files.set(`skill/${name}.lst`, registry([[17, `${name}.skl`]]));
    files.set(`skill/${name}.skl`, script([tag("[fixture]"), num(1)]));
  }
  const secondPath = options.unusualSuffix ? "second.equ(copy)" : "second.equ";
  const rows = options.emptyRegistry ? [] : [[100, "misleading/b.equ"], [101, options.alias ? "misleading/b.equ" : secondPath]];
  if (options.duplicateId) rows.push([100, "second.equ"]);
  files.set("equipment/equipment.lst", registry(rows));
  for (const name of ["misleading/b.equ", secondPath]) {
    const equ = [];
    if (!options.noType) equ.push(tag("[equipment type]"), text("[fixture type]"), num(name.startsWith("misleading") ? 3 : 99));
    equ.push(tag("[sub type]"), num(7));
    if (!options.noJobs) equ.push(tag("[usable job]"), ...(options.emptyJobs ? [] : [text(options.all ? "[all]" : options.wrongJob ? "[fixturea]" : "[fixture a]")]),
      ...(options.mixedAll ? [text("[fixture b]")] : []), tag(options.unclosedJobs ? "[next]" : "[/usable job]"));
    if (options.requiredJobs) equ.push(tag("[required job skill]"), text("[fixture a]"), num(options.missingSkill ? 999 : 17), text("[fixture b]"), num(17), tag("[/required job skill]"));
    if (options.requiredBare) equ.push(tag("[required skill]"), num(17), tag("[/required skill]"));
    if (options.characterCheck) equ.push(tag("[character item check]"), num(7));
    if (options.duplicateType) equ.push(tag("[equipment type]"), text("[fixture other]"), num(2));
    equ.push(tag("[explain]"), text("[usable job] [all]"));
    files.set(`equipment/${name}`, script(equ));
  }
  const parts = strings.map((s) => Buffer.from(s)), header = 4 + 4 * (parts.length + 1), table = Buffer.alloc(header + parts.reduce((n, b) => n + b.length, 0));
  table.writeInt32LE(parts.length); let cursor = header;
  parts.forEach((b, i) => { table.writeInt32LE(cursor - 4, 4 + i * 4); b.copy(table, cursor); cursor += b.length; });
  table.writeInt32LE(cursor - 4, 4 + parts.length * 4); files.set("stringtable.bin", table);
  if (options.missingFile) files.delete("equipment/second.equ");
  if (options.partialFile) files.set("equipment/second.equ", Buffer.concat([files.get("equipment/second.equ"), Buffer.from([1])]));
  return files;
}

async function runSelfTest(root) {
  const parent = runtimePath(root, "self-tests", "equipment-eligibility"); fs.mkdirSync(parent, { recursive: true });
  const run = fs.mkdtempSync(path.join(parent, "run-")), checks = [], mockSource = { sourcePvfSha256: "a".repeat(64) };
  const test = async (id, fn) => { try { await fn(); checks.push({ id, ok: true }); } catch (e) { checks.push({ id, ok: false, error: e.message }); } };
  const inspect = async (options = {}) => {
    const files = fixture(options), read = async (p) => { if (!files.has(p)) throw Error("Missing fixture"); return files.get(p); };
    const graph = await buildIdentityGraph({ read, sourceFingerprint: mockSource }), records = [];
    const report = await scanEquipment(graph, read, async (r) => records.push(r)); return { report, records, graph, files };
  };
  const base = await inspect(), first = base.records[1];
  await test("full-registry-every-row-emitted", () => { assert.equal(base.report.ok, true); assert.equal(base.records.length, 3); assert.equal(base.report.summary.observedRows, 2); });
  await test("directory-name-does-not-select-job", () => assert.deepEqual(first.jobEvidence, [{ jobToken: "[fixture a]", status: "exact-current-job", characterId: 4 }]));
  await test("type-trailing-number-not-promoted-to-slot", () => { assert.equal(base.report.physicalSlotMapping, "unresolved"); assert.equal(base.report.equipmentTypeGroups.length, 1); assert.deepEqual(base.records.slice(1).map((r) => r.fields.find((f) => f[0] === "[equipment type]")[5][1][1]), [3, 99]); });
  await test("subtype-kept-separate-from-type", () => { assert.equal(first.subType, 7); assert.equal(first.equipmentType, "[fixture type]"); });
  await test("literal-description-not-a-job-field", () => assert.equal(first.fields.filter((f) => f[0] === "[usable job]").length, 1));
  await test("all-is-literal-not-expanded-to-branches", async () => { const r = await inspect({ all: true }); assert.deepEqual(r.records[1].jobEvidence, [{ jobToken: "[all]", status: "literal-all-not-expanded" }]); });
  await test("mixed-all-and-specific-job-unresolved", async () => assert.equal((await inspect({ all: true, mixedAll: true })).report.ok, false));
  await test("job-spelling-never-normalized", async () => { const r = await inspect({ wrongJob: true }); assert.equal(r.report.ok, false); assert.ok(r.report.issueGroups.some((g) => g.key === "EQUIPMENT_JOB_TOKEN_UNRESOLVED")); });
  await test("empty-jobs-not-universal", async () => assert.equal((await inspect({ emptyJobs: true })).report.ok, false));
  await test("missing-jobs-not-universal", async () => assert.equal((await inspect({ noJobs: true })).report.ok, false));
  await test("missing-job-close-blocks", async () => assert.equal((await inspect({ unclosedJobs: true })).report.ok, false));
  await test("missing-type-not-guessed-from-directory", async () => { const r = await inspect({ noType: true }); assert.equal(r.report.ok, false); assert.equal(r.records[1].equipmentType, null); });
  await test("duplicate-type-retained-and-not-last-wins", async () => { const r = await inspect({ duplicateType: true }); assert.equal(r.report.ok, false); assert.equal(r.records[1].fields.filter((f) => f[0] === "[equipment type]").length, 2); });
  await test("required-skills-use-each-explicit-job-registry", async () => { const r = await inspect({ requiredJobs: true }); assert.equal(r.report.ok, true); assert.deepEqual(r.records[1].requiredSkills.map((s) => s.pvfPath), ["skill/a.skl", "skill/b.skl"]); });
  await test("missing-required-skill-visible", async () => { const r = await inspect({ requiredJobs: true, missingSkill: true }); assert.equal(r.report.ok, false); assert.equal(r.records[1].requiredSkills[0].skillId, 999); });
  await test("bare-required-skill-not-assigned-by-usable-job", async () => { const r = await inspect({ requiredBare: true }); assert.equal(r.report.ok, false); assert.equal(r.records[1].requiredSkills.length, 0); });
  await test("character-item-check-not-gas-approval", async () => assert.equal((await inspect({ characterCheck: true })).report.ok, false));
  await test("missing-file-counted-not-dropped", async () => { const r = await inspect({ missingFile: true }); assert.equal(r.report.summary.processedRows, 2); assert.equal(r.report.summary.readOrParseFailures, 1); assert.equal(r.report.observationComplete, false); });
  await test("partial-file-counted-not-accepted", async () => assert.equal((await inspect({ partialFile: true })).report.observationComplete, false));
  await test("aliases-retain-all-registry-rows", async () => { const r = await inspect({ alias: true }); assert.equal(r.report.summary.registeredRows, 2); assert.equal(r.report.summary.uniquePaths, 1); assert.equal(r.report.summary.aliasRows, 1); });
  await test("unusual-registered-suffix-read-without-normalizing-or-approving", async () => { const r = await inspect({ unusualSuffix: true }); assert.equal(r.report.observationComplete, true); assert.equal(r.report.ok, false); assert.equal(r.records[2].pvfPath, "equipment/second.equ(copy)"); assert.equal(r.records[2].rawSha256.length, 64); assert.ok(r.records[2].issues.some((i) => i.code === "EQUIPMENT_EXTENSION_UNREVIEWED")); });
  await test("duplicate-registry-id-blocks", async () => assert.rejects(() => inspect({ duplicateId: true }), (e) => e.code === "IDENTITY_DUPLICATE_ID"));
  await test("empty-registry-not-vacuous-pass", async () => assert.rejects(() => inspect({ emptyRegistry: true }), (e) => e.code === "EQUIPMENT_REGISTRY_LIMIT"));
  await test("incomplete-job-graph-cannot-approve-token", () => { const r = inspectEquipment(base.files.get("equipment/second.equ"), base.files.get("stringtable.bin"), { ...base.graph, complete: false }); assert.ok(r.issues.some((i) => i.code === "EQUIPMENT_JOB_TOKEN_UNRESOLVED")); });
  await test("stringtable-drift-stops", async () => { const changed = Buffer.from(base.files.get("stringtable.bin")); changed[changed.length - 1] ^= 1; await assert.rejects(() => scanEquipment(base.graph, async (p) => p === "stringtable.bin" ? changed : base.files.get(p), async () => {}), (e) => e.code === "EQUIPMENT_STRINGTABLE_DRIFT"); });
  await test("no-root-wearability-or-pool-approval", () => { assert.equal(first.rootScopeConfirmed, false); assert.equal(base.report.semanticContractReady, false); assert.equal(base.report.authorizesPvfGeneration, false); assert.equal(base.report.runtimeWearability, "not-run"); });
  const input = path.join(run, "input"); fs.mkdirSync(input); const pvf = path.join(input, "fixture.pvf"); pack(pvf, fixture());
  const hash = sha256(fs.readFileSync(pvf)), fp = () => ({ sourcePvf: pvf, sourcePvfSha256: hash, sourceSize: fs.statSync(pvf).size, sourceMtimeMs: fs.statSync(pvf).mtimeMs, stableDuringFingerprint: true });
  await test("independent-live-read-and-full-record-readback", async () => { const r = await auditEquipment(root, pvf, path.join(run, "audit"), fp); assert.equal(r.ok, true); assert.equal(r.records.fullOutputReadback, true); assert.equal(sha256(fs.readFileSync(r.records.path)), r.records.sha256); assert.equal(r.records.recordCount, 3); });
  await test("source-drift-leaves-no-success-report", async () => { let n = 0; const out = path.join(run, "drift"); await assert.rejects(() => auditEquipment(root, pvf, out, () => ({ ...fp(), sourcePvfSha256: ++n === 1 ? hash : "b".repeat(64) })), (e) => e.code === "IDENTITY_SOURCE_CHANGED"); assert.equal(fs.existsSync(path.join(out, "AUDIT.json")), false); });
  await test("existing-directory-never-overwritten", async () => assert.rejects(() => auditEquipment(root, pvf, path.join(run, "audit"), fp)));
  await test("input-directory-protected", async () => assert.rejects(() => auditEquipment(root, pvf, path.join(input, "audit"), fp), (e) => e.code === "EVIDENCE_OUTPUT_PROTECTED"));
  const cli = (source, out) => cp.spawnSync(process.execPath, [path.join(root, "core/pvf-agent-core/cli/pvf-readonly.js"), "equipment-eligibility-audit", "--pvf", source, "--out", out], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  await test("public-cli-complete-audit", () => assert.equal(cli(pvf, path.join(run, "cli")).status, 0));
  await test("public-cli-failure-report-nonzero", () => { const bad = path.join(input, "bad.pvf"), out = path.join(run, "blocked"); pack(bad, fixture({ missingSkill: true, requiredJobs: true })); assert.equal(cli(bad, out).status, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(out, "AUDIT.json"))).ok, false); });
  await test("synthetic-input-unchanged", () => assert.equal(sha256(fs.readFileSync(pvf)), hash));
  const result = { ok: checks.every((c) => c.ok), phase: "equipment-eligibility-self-test", realUserPvfOrClientTouched: false,
    summary: { checkCount: checks.length, failedChecks: checks.filter((c) => !c.ok).length }, checks };
  const reportPath = path.join(run, "SELF-TEST.json"); fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  return { ...result, reportPath };
}
module.exports = { runSelfTest };
