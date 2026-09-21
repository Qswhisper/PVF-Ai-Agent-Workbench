"use strict";
const { tokensOf, auditIdentityWithEvidence } = require("./pvf-skill-identity");
const { rawStringReader } = require("./pvf-scope-audit");
const { sha256 } = require("./pvf-evidence-export");

const SKILL_FIELDS = ["[type]", "[skill class]", "[required level]", "[required level range]", "[purchase cost]",
  "[special purchase cost]", "[maximum level]", "[growtype maximum level]", "[skill fitness growtype]",
  "[pre required skill]", "[feature skill index]"];
const CHARACTER_FIELDS = ["[growtype name]", "[awakening name]", "[skill]", "[awakening skill]"];
function fail(code, message, details = {}) { const e = new Error(`${code}: ${message}`); e.code = code; e.details = details; throw e; }
function asciiOrNull(bytes) { return bytes.every((b) => b >= 32 && b <= 126) ? bytes.toString("ascii") : null; }

// Observations preserve raw type, position and bits. No decoded name or array
// position is promoted to a runtime job/growtype/level mapping.
function observeFields(bytes, table, kind, selectedFields) {
  const stringAt = rawStringReader(table), tokens = tokensOf(bytes, stringAt);
  const tags = tokens.flatMap((t, index) => t.type === 5 ? [{ ...t, index, tag: asciiOrNull(stringAt(t.value)) }] : []);
  const unresolvedTag = tags.find((t) => t.tag === null);
  if (unresolvedTag) {
    const raw = stringAt(unresolvedTag.value);
    fail("LEARNING_TAG_UNRESOLVED", "Non-ASCII tag cannot be interpreted as a field boundary.", {
      byteOffset: unresolvedTag.offset, stringIndex: unresolvedTag.value,
      stringRawSha256: sha256(raw), stringByteCount: raw.length,
    });
  }
  const selected = selectedFields || (kind === "character" ? CHARACTER_FIELDS : SKILL_FIELDS);
  const fields = [], markers = [];
  let growMarker = null, awakeningMarker = null;
  for (let n = 0; n < tags.length; n += 1) {
    const t = tags[n], next = tags[n + 1];
    if (kind === "character" && /^\[growtype \d+\]$/u.test(t.tag)) {
      growMarker = { tag: t.tag, byteOffset: t.offset }; awakeningMarker = null; markers.push(growMarker);
    } else if (kind === "character" && /^\[awakening \d+\]$/u.test(t.tag)) {
      awakeningMarker = { tag: t.tag, byteOffset: t.offset }; markers.push({ ...awakeningMarker, precedingGrowMarker: growMarker });
    }
    if (!selected.includes(t.tag)) continue;
    const values = tokens.slice(t.index + 1, next?.index ?? tokens.length).map((token) => {
      const item = { type: token.type, byteOffset: token.offset, rawUInt32: token.value };
      if ([2, 3].includes(token.type)) item.integer = token.value | 0;
      else if (token.type === 4) { const b = Buffer.alloc(4); b.writeUInt32LE(token.value); const v = b.readFloatLE(); item.float = Number.isFinite(v) ? v : null; }
      else if ([6, 7, 8, 10].includes(token.type)) {
        const value = stringAt(token.value); item.ascii = asciiOrNull(value); item.stringRawSha256 = sha256(value); item.stringByteCount = value.length;
      }
      return item;
    });
    fields.push({ tag: t.tag, byteOffset: t.offset, endByteExclusive: next?.offset ?? bytes.length,
      nextTag: next?.tag ?? null, immediatelyClosed: next?.tag === `[/${t.tag.slice(1)}`,
      ...(kind === "character" ? { lexicalContext: { precedingGrowMarker: growMarker, precedingAwakeningMarker: awakeningMarker,
        runtimeMappingConfirmed: false } } : {}), values });
  }
  return { rawSha256: sha256(bytes), byteCount: bytes.length, fields, markers,
    absentFields: selected.filter((tag) => !fields.some((f) => f.tag === tag)),
    repeatedFields: selected.filter((tag) => fields.filter((f) => f.tag === tag).length > 1),
    modeAndRuntimeScopeInterpretation: "not-performed" };
}

function resolveReferences(observation, branch, kind) {
  const references = [], issues = [], byId = new Map(branch.skills.map((s) => [s.skillId, s]));
  const tags = kind === "character" ? ["[skill]", "[awakening skill]"] : ["[pre required skill]", "[feature skill index]"];
  for (const f of observation.fields.filter((item) => tags.includes(item.tag))) {
    const feature = f.tag === "[feature skill index]", width = feature ? 1 : 2;
    if ((!feature && !f.immediatelyClosed) || (feature && f.values.length !== 1) || f.values.length % width || f.values.some((v) => !Number.isInteger(v.integer))) {
      issues.push({ code: "LEARNING_REFERENCE_SHAPE_UNRESOLVED", tag: f.tag, byteOffset: f.byteOffset }); continue;
    }
    for (let i = 0; i < f.values.length; i += width) {
      const id = f.values[i].integer, target = byId.get(id);
      const ref = { tag: f.tag, fieldByteOffset: f.byteOffset, tokenByteOffset: f.values[i].byteOffset, skillId: id,
        ...(feature ? {} : { declaredLevel: f.values[i + 1].integer }),
        ...(f.lexicalContext ? { lexicalContext: f.lexicalContext } : {}),
        status: target?.status === "registered-script-read" ? "same-registry-resolved" : "unresolved",
        ...(target?.status === "registered-script-read" ? { pvfPath: target.pvfPath, rawSha256: target.rawSha256 } : {}) };
      references.push(ref);
      if (ref.status === "unresolved") issues.push({ code: "LEARNING_REFERENCE_UNRESOLVED", tag: f.tag, byteOffset: ref.tokenByteOffset, skillId: id });
    }
  }
  return { references, issues };
}

async function buildLearningEvidence(graph, read) {
  const table = await read("stringtable.bin"), evidence = new Map(graph.evidence.map((e) => [e.pvfPath, e]));
  if (sha256(table) !== evidence.get("stringtable.bin")?.rawSha256) fail("LEARNING_EVIDENCE_DRIFT", "String table changed between identity and observation reads.");
  const boundRead = async (name) => {
    const bytes = await read(name);
    if (sha256(bytes) !== evidence.get(name)?.rawSha256) fail("LEARNING_EVIDENCE_DRIFT", `Identity and observation bytes differ: ${name}`);
    return bytes;
  };
  const branches = [], issues = [...graph.issues], cache = new Map();
  for (const branch of graph.branches) {
    const item = { characterId: branch.characterId, jobToken: branch.jobToken, characterPath: branch.characterPath,
      skillRegistry: branch.skillRegistry, skills: [] }; branches.push(item);
    try {
      item.character = observeFields(await boundRead(branch.characterPath), table, "character");
      Object.assign(item.character, resolveReferences(item.character, branch, "character"));
      issues.push(...item.character.issues.map((i) => ({ ...i, characterId: branch.characterId, pvfPath: branch.characterPath })));
    } catch (error) { item.characterError = { code: error.code || "LEARNING_CHARACTER_FAILED", message: error.message, ...error.details }; issues.push({ ...item.characterError, characterId: branch.characterId, pvfPath: branch.characterPath }); }
    for (const skill of branch.skills) {
      const row = { skillId: skill.skillId, pvfPath: skill.pvfPath }; item.skills.push(row);
      try {
        if (skill.status !== "registered-script-read") fail("LEARNING_IDENTITY_UNRESOLVED", "Skill identity is unresolved.");
        if (!cache.has(skill.pvfPath)) cache.set(skill.pvfPath, observeFields(await boundRead(skill.pvfPath), table, "skill"));
        row.observation = cache.get(skill.pvfPath);
        Object.assign(row, resolveReferences(row.observation, branch, "skill"));
        issues.push(...row.issues.map((i) => ({ ...i, characterId: branch.characterId, ownerSkillId: skill.skillId, pvfPath: skill.pvfPath })));
      } catch (error) { row.error = { code: error.code || "LEARNING_SKILL_FAILED", message: error.message, ...error.details }; issues.push({ ...row.error, characterId: branch.characterId, skillId: skill.skillId, pvfPath: skill.pvfPath }); }
    }
  }
  const skills = branches.flatMap((b) => b.skills), refs = branches.flatMap((b) => [...(b.character?.references || []), ...b.skills.flatMap((s) => s.references || [])]);
  const observationComplete = graph.complete && branches.every((b) => b.character && b.skills.every((s) => s.observation));
  return { format: "pvf-skill-learning-evidence-v1", ok: observationComplete && issues.length === 0, source: graph.source,
    observationComplete, identitySummary: graph.summary, branches, issues, evidence: graph.evidence,
    summary: { branchCount: branches.length, observedCharacters: branches.filter((b) => b.character).length,
      registeredSkillRows: graph.summary.registeredSkillRows, observedSkillRows: skills.filter((s) => s.observation).length,
      referenceCount: refs.length, unresolvedReferences: refs.filter((r) => r.status !== "same-registry-resolved").length,
      issueCount: issues.length, skillsWithAbsentFields: skills.filter((s) => s.observation?.absentFields.length).length,
      skillsWithRepeatedFields: skills.filter((s) => s.observation?.repeatedFields.length).length },
    semanticContractReady: false, growtypeColumnMapping: "unresolved", actualLearnableMaximum: "unresolved",
    skillTreeValidation: "not-run", autoSkillValidation: "not-run", runtimeValidation: "not-run", authorizesPvfGeneration: false };
}
async function auditLearning(source, fingerprint) { return auditIdentityWithEvidence(source, fingerprint, buildLearningEvidence); }
module.exports = { SKILL_FIELDS, observeFields, resolveReferences, buildLearningEvidence, auditLearning };
