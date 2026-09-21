"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { registryRows, auditIdentityWithEvidence } = require("./pvf-skill-identity");
const { rawStringReader } = require("./pvf-scope-audit");
const { observeFields } = require("./pvf-skill-learning");
const { sha256, assertExternal } = require("./pvf-evidence-export");
const FIELDS = ["[equipment type]", "[sub type]", "[usable job]", "[required skill]", "[required job skill]", "[character item check]",
  "[minimum level]", "[grade]", "[rarity]"];
function fail(code, message) { const e = new Error(`${code}: ${message}`); e.code = code; throw e; }

function inspectEquipment(bytes, table, graph) {
  const observation = observeFields(bytes, table, "equipment", FIELDS), issues = [], jobEvidence = [], requiredSkills = [];
  const byJob = new Map(graph.branches.map((b) => [b.jobToken, b]));
  const all = (tag) => observation.fields.filter((f) => f.tag === tag);
  const equipment = all("[equipment type]"), subtype = all("[sub type]"), jobs = all("[usable job]");
  let equipmentType = null, subType = null;
  if (equipment.length === 1 && equipment[0].values[0]?.type === 7 && equipment[0].values[0].ascii &&
      equipment[0].values.length >= 1 && equipment[0].values.slice(1).every((v) => Number.isInteger(v.integer))) equipmentType = equipment[0].values[0].ascii;
  else issues.push({ code: "EQUIPMENT_TYPE_UNRESOLVED" });
  if (subtype.length === 1 && subtype[0].values.length === 1 && Number.isInteger(subtype[0].values[0].integer)) subType = subtype[0].values[0].integer;
  else if (subtype.length > 1 || (subtype.length === 1 && subType === null)) issues.push({ code: "EQUIPMENT_SUBTYPE_UNRESOLVED" });
  if (jobs.length !== 1 || !jobs[0].immediatelyClosed || jobs[0].values.length === 0 || jobs[0].values.some((v) => v.type !== 7 || v.ascii === null)) {
    issues.push({ code: "EQUIPMENT_USABLE_JOB_UNRESOLVED" });
  } else {
    const seen = new Set();
    for (const value of jobs[0].values) {
      const token = value.ascii, branch = byJob.get(token);
      const status = token === "[all]" ? "literal-all-not-expanded" : branch && graph.complete ? "exact-current-job" : "unresolved";
      jobEvidence.push({ jobToken: token, status, ...(status === "exact-current-job" ? { characterId: branch.characterId } : {}) });
      if (status === "unresolved") issues.push({ code: "EQUIPMENT_JOB_TOKEN_UNRESOLVED", jobToken: token });
      if (seen.has(token)) issues.push({ code: "EQUIPMENT_JOB_TOKEN_DUPLICATE", jobToken: token });
      seen.add(token);
    }
    if (seen.has("[all]") && seen.size > 1) issues.push({ code: "EQUIPMENT_ALL_MIXED_WITH_JOB" });
  }
  for (const f of all("[required job skill]")) {
    if (!f.immediatelyClosed || f.values.length === 0 || f.values.length % 2 !== 0 || f.values.some((v, i) => i % 2 ? !Number.isInteger(v.integer) : v.type !== 7 || v.ascii === null)) {
      issues.push({ code: "EQUIPMENT_REQUIRED_JOB_SKILL_SHAPE", byteOffset: f.byteOffset }); continue;
    }
    for (let i = 0; i < f.values.length; i += 2) {
      const jobToken = f.values[i].ascii, skillId = f.values[i + 1].integer, branch = byJob.get(jobToken);
      const skill = branch?.skills.find((s) => s.skillId === skillId && s.status === "registered-script-read");
      const resolved = graph.complete && !!skill;
      requiredSkills.push({ jobToken, skillId, byteOffset: f.values[i].byteOffset, status: resolved ? "same-registry-resolved" : "unresolved",
        ...(resolved ? { skillRegistry: branch.skillRegistry, pvfPath: skill.pvfPath, rawSha256: skill.rawSha256 } : {}) });
      if (!resolved) issues.push({ code: "EQUIPMENT_REQUIRED_SKILL_UNRESOLVED", jobToken, skillId, byteOffset: f.values[i].byteOffset });
    }
  }
  if (all("[required skill]").length) issues.push({ code: "EQUIPMENT_UNQUALIFIED_REQUIRED_SKILL", instruction: "Preserved without inferring a job or skill registry." });
  if (all("[character item check]").length) issues.push({ code: "EQUIPMENT_CHARACTER_ITEM_CHECK_UNINTERPRETED" });
  return { rawSha256: observation.rawSha256, byteCount: observation.byteCount, equipmentType, subType, jobEvidence, requiredSkills, issues,
    absentFields: observation.absentFields, repeatedFields: observation.repeatedFields,
    fields: observation.fields.map((f) => [f.tag, f.byteOffset, f.endByteExclusive, f.nextTag, f.immediatelyClosed,
      f.values.map((v) => [v.type, v.rawUInt32, Object.hasOwn(v, "ascii") ? v.ascii : null])]),
    rootScopeConfirmed: false, runtimeWearability: "not-run", gasPoolAssignment: "not-run" };
}

async function scanEquipment(graph, read, emit) {
  const table = await read("stringtable.bin");
  if (sha256(table) !== graph.evidence.find((e) => e.pvfPath === "stringtable.bin")?.rawSha256) fail("EQUIPMENT_STRINGTABLE_DRIFT", "Identity and equipment string tables differ.");
  const registryPath = "equipment/equipment.lst", registry = await read(registryPath);
  const rows = registryRows(registry, rawStringReader(table), registryPath);
  if (rows.length < 1 || rows.length > 200000) fail("EQUIPMENT_REGISTRY_LIMIT", "Expected 1 to 200000 equipment registry rows.");
  const summary = { registeredRows: rows.length, processedRows: 0, observedRows: 0, readOrParseFailures: 0, rowsWithIssues: 0,
    issueCount: 0, rowsWithAbsentFields: 0, rowsWithRepeatedFields: 0, requiredJobSkillReferences: 0, uniquePaths: 0, aliasRows: 0 };
  const typeGroups = new Map(), jobGroups = new Map(), issueGroups = new Map(), seenPaths = new Set();
  const increment = (map, key, sample) => {
    if (!map.has(key)) map.set(key, { key, count: 0, samples: [] });
    const group = map.get(key); group.count += 1; if (group.samples.length < 3) group.samples.push(sample);
  };
  await emit({ kind: "header", format: "pvf-equipment-observations-v1", source: graph.source,
    registry: { pvfPath: registryPath, rawSha256: sha256(registry), byteCount: registry.length },
    stringTableRawSha256: sha256(table), registryRows: rows.length });
  for (const row of rows) {
    const record = { kind: "equipment", equipmentId: row.id, pvfPath: row.pvfPath, registryRowByteOffset: row.registryRowByteOffset };
    const sample = { equipmentId: row.id, pvfPath: row.pvfPath };
    if (seenPaths.has(row.pvfPath)) summary.aliasRows += 1; seenPaths.add(row.pvfPath);
    try {
      Object.assign(record, inspectEquipment(await read(row.pvfPath), table, graph)); summary.observedRows += 1;
      if (!row.pvfPath.endsWith(".equ")) record.issues.push({ code: "EQUIPMENT_EXTENSION_UNREVIEWED", instruction: "Raw script observed through its exact registry path; suffix is not normalized and runtime loading is unproven." });
      if (record.absentFields.length) summary.rowsWithAbsentFields += 1;
      if (record.repeatedFields.length) summary.rowsWithRepeatedFields += 1;
      summary.requiredJobSkillReferences += record.requiredSkills.length;
      increment(typeGroups, record.equipmentType || "<unresolved>", sample);
      for (const job of record.jobEvidence) increment(jobGroups, `${job.status}:${job.jobToken}`, sample);
    } catch (error) {
      summary.readOrParseFailures += 1;
      record.issues = [{ code: error.code || "EQUIPMENT_READ_FAILED", message: error.message }];
    }
    if (record.issues.length) summary.rowsWithIssues += 1;
    summary.issueCount += record.issues.length;
    for (const issue of record.issues) increment(issueGroups, issue.code, { ...sample, issue });
    await emit(record); summary.processedRows += 1;
  }
  summary.uniquePaths = seenPaths.size;
  const observationComplete = graph.complete && summary.processedRows === rows.length && summary.readOrParseFailures === 0;
  return { format: "pvf-equipment-eligibility-audit-v1", ok: observationComplete && summary.issueCount === 0, source: graph.source,
    observationComplete, identitySummary: graph.summary, identityIssues: graph.issues, identityEvidence: graph.evidence,
    registry: { pvfPath: registryPath, rawSha256: sha256(registry), byteCount: registry.length }, summary,
    equipmentTypeGroups: [...typeGroups.values()], usableJobGroups: [...jobGroups.values()], issueGroups: [...issueGroups.values()],
    groupSamplesAreCoverageProof: false, rootScopeValidation: "not-run", physicalSlotMapping: "unresolved", runtimeWearability: "not-run",
    semanticContractReady: false, gasPoolAssignment: "not-run", authorizesPvfGeneration: false };
}

async function auditEquipment(workbenchRoot, source, outputDir, fingerprint) {
  const destination = assertExternal(workbenchRoot, source, outputDir);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.mkdirSync(destination);
  const rowsPath = path.join(destination, "EQUIPMENT.ndjson"), fd = fs.openSync(rowsPath, "wx"), hash = crypto.createHash("sha256");
  let byteCount = 0, recordCount = 0, report;
  try {
    report = await auditIdentityWithEvidence(source, fingerprint, (graph, read) => scanEquipment(graph, read, async (record) => {
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      if (bytes.length > 4 * 1024 * 1024 || byteCount + bytes.length > 1024 * 1024 * 1024) fail("EQUIPMENT_OUTPUT_LIMIT", "Bounded evidence output exceeded.");
      let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset); if (!written) fail("EQUIPMENT_OUTPUT_WRITE", "No write progress."); offset += written; }
      hash.update(bytes); byteCount += bytes.length; recordCount += 1;
    }));
  } finally { fs.closeSync(fd); }
  const expectedHash = hash.digest("hex"), rereadHash = crypto.createHash("sha256"); let rereadBytes = 0;
  for await (const bytes of fs.createReadStream(rowsPath)) { rereadHash.update(bytes); rereadBytes += bytes.length; }
  if (rereadBytes !== byteCount || rereadHash.digest("hex") !== expectedHash || recordCount !== report.summary.registeredRows + 1) fail("EQUIPMENT_OUTPUT_READBACK", "Evidence output differs or row count is incomplete.");
  report.records = { path: rowsPath, sha256: expectedHash, byteCount, recordCount, fullOutputReadback: true };
  const reportPath = path.join(destination, "AUDIT.json"), reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(reportPath, reportBytes, { flag: "wx" });
  if (!fs.readFileSync(reportPath).equals(reportBytes)) fail("EQUIPMENT_OUTPUT_READBACK", "Audit report readback differs.");
  return { ...report, reportPath, reportSha256: sha256(reportBytes) };
}
module.exports = { FIELDS, inspectEquipment, scanEquipment, auditEquipment };
