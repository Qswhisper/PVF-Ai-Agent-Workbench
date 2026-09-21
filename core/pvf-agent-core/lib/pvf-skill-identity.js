"use strict";

const path = require("path");
const fallback = require("../../../tools/pvf-bridge/fallback/pvf-readonly-backend.ts");
const { rawStringReader } = require("./pvf-scope-audit");
const { sha256, validatePaths } = require("./pvf-evidence-export");
const CHARACTER_ROOT = "character/character.lst";
const SKILL_ROOT = "skill/skilllist.lst";

function fail(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; throw error; }
function ascii(bytes, context) {
  if ([...bytes].some((b) => b < 32 || b > 126)) fail("IDENTITY_ASCII_UNRESOLVED", `Non-ASCII identity token: ${context}`);
  return bytes.toString("ascii");
}
function tokensOf(bytes, stringAt) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 16 * 1024 * 1024 || bytes[0] !== 0xb0 || bytes[1] !== 0xd0 || (bytes.length - 2) % 5 !== 0) {
    fail("IDENTITY_SCRIPT_INCOMPLETE", "A complete binary script is required.");
  }
  const tokens = [];
  for (let offset = 2; offset < bytes.length; offset += 5) {
    const type = bytes[offset], value = bytes.readUInt32LE(offset + 1);
    if (![2, 3, 4, 5, 6, 7, 8, 9, 10].includes(type)) fail("IDENTITY_TOKEN_UNSUPPORTED", "Unsupported token type.");
    if ([5, 6, 7, 8, 10].includes(type)) stringAt(value);
    tokens.push({ type, value, offset });
  }
  for (let i = 0; i < tokens.length; i += 1) if (tokens[i].type === 9) {
    if (tokens[i + 1]?.type !== 10) fail("IDENTITY_STRINGLINK_INCOMPLETE", "Incomplete StringLink pair.");
    stringAt(tokens[i + 1].value);
  }
  return tokens;
}
function registryRows(bytes, stringAt, registryPath) {
  const tokens = tokensOf(bytes, stringAt), rows = [], ids = new Set();
  if (tokens.length % 2 !== 0) fail("IDENTITY_REGISTRY_MALFORMED", `Incomplete registry row: ${registryPath}`);
  for (let i = 0; i < tokens.length; i += 2) {
    const id = tokens[i], target = tokens[i + 1];
    if (![2, 3].includes(id.type) || id.value > 0x7fffffff || ![6, 7, 8, 10].includes(target.type)) {
      fail("IDENTITY_REGISTRY_MALFORMED", `Invalid registry row: ${registryPath}`);
    }
    if (ids.has(id.value)) fail("IDENTITY_DUPLICATE_ID", `Duplicate ID in ${registryPath}: ${id.value}`);
    ids.add(id.value);
    const relativePath = ascii(stringAt(target.value), registryPath).replace(/\\/g, "/");
    validatePaths([relativePath]);
    const pvfPath = path.posix.join(path.posix.dirname(registryPath), relativePath).toLowerCase();
    validatePaths([pvfPath]);
    rows.push({ id: id.value, pvfPath, registryRowByteOffset: id.offset });
  }
  return rows;
}
function characterJob(bytes, stringAt) {
  const tokens = tokensOf(bytes, stringAt), hits = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type === 5 && stringAt(tokens[i].value).equals(Buffer.from("[job]"))) hits.push(i);
  }
  if (hits.length !== 1) fail("IDENTITY_JOB_AMBIGUOUS", "Character must have one exact [job] field.");
  const i = hits[0], value = tokens[i + 1];
  if (value?.type !== 7 || (tokens[i + 2] && tokens[i + 2].type !== 5)) fail("IDENTITY_JOB_AMBIGUOUS", "Expected one complete job string token.");
  const jobToken = ascii(stringAt(value.value), "character [job]");
  if (!/^\[[a-zA-Z0-9][a-zA-Z0-9 _-]*\]$/u.test(jobToken)) fail("IDENTITY_JOB_TOKEN_INVALID", "Invalid exact job token.");
  return { jobToken, fieldByteOffset: tokens[i].offset };
}

async function buildIdentityGraph({ read, sourceFingerprint }) {
  const table = await read("stringtable.bin"), stringAt = rawStringReader(table);
  const evidence = new Map([["stringtable.bin", { pvfPath: "stringtable.bin", rawSha256: sha256(table), byteCount: table.length }]]);
  const readBound = async (pvfPath) => {
    const bytes = await read(pvfPath);
    evidence.set(pvfPath, { pvfPath, rawSha256: sha256(bytes), byteCount: bytes.length });
    return bytes;
  };
  const characters = registryRows(await readBound(CHARACTER_ROOT), stringAt, CHARACTER_ROOT);
  const skillRoots = registryRows(await readBound(SKILL_ROOT), stringAt, SKILL_ROOT);
  if (characters.length > 256 || skillRoots.length > 256) fail("IDENTITY_READ_LIMIT", "Character roots exceed the bounded audit scope.");
  const rootsById = new Map(skillRoots.map((item) => [item.id, item]));
  const branches = [], issues = [], seenJobs = new Map();
  if (characters.length === 0 || skillRoots.length === 0) issues.push({ code: "IDENTITY_ROOT_EMPTY" });
  for (const root of skillRoots) if (!characters.some((item) => item.id === root.id)) {
    issues.push({ code: "IDENTITY_CHARACTER_ROOT_MISSING", characterId: root.id });
  }
  for (const character of characters) {
    const branch = { characterId: character.id, characterPath: character.pvfPath,
      characterRegistryRowByteOffset: character.registryRowByteOffset, skills: [], complete: false };
    branches.push(branch);
    try {
      const root = rootsById.get(character.id);
      if (!root) fail("IDENTITY_SKILL_ROOT_MISSING", "Character ID has no skill-root row.");
      if (!character.pvfPath.endsWith(".chr") || !root.pvfPath.endsWith(".lst")) fail("IDENTITY_ROUTE_TYPE_INVALID", "Unexpected character or registry extension.");
      const characterBytes = await readBound(character.pvfPath);
      Object.assign(branch, characterJob(characterBytes, stringAt), { characterRawSha256: sha256(characterBytes),
        skillRegistry: root.pvfPath, skillRootRowByteOffset: root.registryRowByteOffset });
      if (seenJobs.has(branch.jobToken)) issues.push({ code: "IDENTITY_DUPLICATE_JOB_TOKEN", characterId: character.id, otherCharacterId: seenJobs.get(branch.jobToken) });
      seenJobs.set(branch.jobToken, character.id);
      const registryBytes = await readBound(root.pvfPath);
      branch.skillRegistryRawSha256 = sha256(registryBytes);
      const rows = registryRows(registryBytes, stringAt, root.pvfPath);
      if (rows.length === 0) fail("IDENTITY_SKILL_REGISTRY_EMPTY", "Empty skill registry cannot establish branch coverage.");
      if (rows.length > 50000 || branches.reduce((sum, b) => sum + b.skills.length, 0) + rows.length > 100000) fail("IDENTITY_READ_LIMIT", "Skill rows exceed the bounded audit scope.");
      branch.registeredSkillCount = rows.length;
      const aliases = new Map();
      for (const row of rows) {
        const skill = { skillId: row.id, pvfPath: row.pvfPath, registryRowByteOffset: row.registryRowByteOffset, status: "unresolved" };
        branch.skills.push(skill);
        if (!aliases.has(row.pvfPath)) aliases.set(row.pvfPath, []);
        aliases.get(row.pvfPath).push(row.id);
        try {
          if (!row.pvfPath.endsWith(".skl")) fail("IDENTITY_SKILL_TYPE_INVALID", "Skill registry target is not .skl.");
          const bytes = await readBound(row.pvfPath);
          tokensOf(bytes, stringAt);
          Object.assign(skill, { status: "registered-script-read", rawSha256: sha256(bytes), byteCount: bytes.length });
        } catch (error) {
          skill.error = { code: error.code || "IDENTITY_SKILL_READ_FAILED", message: error.message };
          issues.push({ ...skill.error, characterId: character.id, skillId: row.id, pvfPath: row.pvfPath });
        }
      }
      branch.pathAliases = [...aliases].filter(([, ids]) => ids.length > 1).map(([pvfPath, skillIds]) => ({ pvfPath, skillIds }));
      branch.complete = branch.skills.every((item) => item.status === "registered-script-read");
    } catch (error) {
      branch.error = { code: error.code || "IDENTITY_BRANCH_READ_FAILED", message: error.message };
      issues.push({ ...branch.error, characterId: character.id });
    }
  }
  const complete = issues.length === 0 && branches.length > 0 && branches.every((item) => item.complete);
  return { format: "pvf-skill-identity-graph-v1", ok: complete, complete, source: sourceFingerprint,
    characterRegistry: CHARACTER_ROOT, skillRootRegistry: SKILL_ROOT, branches, issues,
    evidence: [...evidence.values()], summary: { branchCount: branches.length, completeBranchCount: branches.filter((b) => b.complete).length,
      registeredSkillRows: branches.reduce((sum, b) => sum + (b.registeredSkillCount || 0), 0),
      confirmedSkillRows: branches.reduce((sum, b) => sum + b.skills.filter((s) => s.status === "registered-script-read").length, 0),
      issueCount: issues.length, evidenceFileCount: evidence.size },
    scope: "current character and skill registries; each registered .chr/.lst/.skl reread",
    playableBranchValidation: "not-run", growTypeValidation: "not-run", learnabilityValidation: "not-run",
    equipmentSlotValidation: "not-run", parameterSemanticsValidation: "not-run", runtimeValidation: "not-run", authorizesPvfGeneration: false };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    fail("IDENTITY_CLAIMS_FORMAT_INVALID", `Unexpected or missing fields: ${label}`);
  }
}
function checkIdentityClaims(graph, claims) {
  exactKeys(claims, ["format", "sourcePvfSha256", "claims"], "root");
  if (claims.format !== "pvf-skill-identity-claims-v1" || !/^[a-f0-9]{64}$/u.test(claims.sourcePvfSha256) ||
      !Array.isArray(claims.claims) || claims.claims.length < 1 || claims.claims.length > 10000) fail("IDENTITY_CLAIMS_FORMAT_INVALID", "Invalid identity claims.");
  const issues = [], results = [], seen = new Set();
  if (claims.sourcePvfSha256 !== graph.source.sourcePvfSha256) issues.push({ code: "IDENTITY_SOURCE_MISMATCH" });
  if (!graph.complete) issues.push({ code: "IDENTITY_GRAPH_INCOMPLETE", graphIssueCount: graph.issues.length });
  for (const claim of claims.claims) {
    exactKeys(claim, ["characterId", "jobToken", "skillRegistry", "skillId", "expectedPvfPath"], "claim");
    if (!Number.isSafeInteger(claim.characterId) || claim.characterId < 0 || !Number.isSafeInteger(claim.skillId) || claim.skillId < 0 || typeof claim.jobToken !== "string") fail("IDENTITY_CLAIMS_FORMAT_INVALID", "Invalid character, job or skill selector.");
    validatePaths([claim.skillRegistry]); validatePaths([claim.expectedPvfPath]);
    const key = `${claim.characterId}:${claim.skillId}`;
    const errors = [];
    if (seen.has(key)) errors.push("IDENTITY_DUPLICATE_CLAIM");
    seen.add(key);
    const branch = graph.branches.find((item) => item.characterId === claim.characterId);
    if (!branch) errors.push("IDENTITY_CHARACTER_UNRESOLVED");
    else {
      if (claim.jobToken !== branch.jobToken) errors.push("IDENTITY_JOB_MISMATCH");
      if (claim.skillRegistry !== branch.skillRegistry) errors.push("IDENTITY_REGISTRY_MISMATCH");
      const skill = branch.skills.find((item) => item.skillId === claim.skillId);
      if (!skill || skill.status !== "registered-script-read") errors.push("IDENTITY_SKILL_UNRESOLVED");
      else if (claim.expectedPvfPath !== skill.pvfPath) errors.push("IDENTITY_PATH_MISMATCH");
    }
    results.push({ ...claim, ok: errors.length === 0 && issues.length === 0, errors });
  }
  return { ok: issues.length === 0 && results.every((r) => r.ok), scope: "exact registration identity only", source: graph.source,
    graphComplete: graph.complete, issues, results, summary: { claimCount: results.length, mismatchCount: results.filter((r) => !r.ok).length },
    growTypeValidation: "not-run", learnabilityValidation: "not-run", equipmentSlotValidation: "not-run",
    parameterSemanticsValidation: "not-run", runtimeValidation: "not-run", authorizesPvfGeneration: false };
}

async function auditIdentityWithEvidence(sourcePvf, fingerprint, inspect) {
  const before = fingerprint(sourcePvf);
  const session = await fallback.openSession(sourcePvf, "Tw");
  let graph;
  try {
    const read = async (name) => {
      const meta = await fallback.getFileMetadata(session.sessionId, name);
      if (meta.dataLength > (name === "stringtable.bin" ? 128 : 16) * 1024 * 1024) fail("IDENTITY_READ_LIMIT", `Oversized identity evidence: ${name}`);
      const result = await fallback.readFile(session.sessionId, name, { rawContent: true });
      if (typeof result.base64Content !== "string") fail("IDENTITY_RAW_READ_FAILED", `Raw bytes unavailable: ${name}`);
      const bytes = Buffer.from(result.base64Content, "base64");
      if (bytes.length !== meta.dataLength) fail("IDENTITY_RAW_READ_FAILED", `Incomplete bytes: ${name}`);
      return bytes;
    };
    const identity = await buildIdentityGraph({ sourceFingerprint: before, read });
    graph = await inspect(identity, read);
  } finally { await fallback.closeSession(session.sessionId); }
  const after = fingerprint(sourcePvf);
  if (before.stableDuringFingerprint !== true || after.stableDuringFingerprint !== true || before.sourcePvfSha256 !== after.sourcePvfSha256 || before.sourceSize !== after.sourceSize || before.sourceMtimeMs !== after.sourceMtimeMs) {
    fail("IDENTITY_SOURCE_CHANGED", "Source changed during identity audit.");
  }
  graph.sourceAfter = after;
  return graph;
}

async function auditSkillIdentity(sourcePvf, fingerprint) {
  return auditIdentityWithEvidence(sourcePvf, fingerprint, async (graph) => graph);
}

module.exports = { tokensOf, registryRows, characterJob, buildIdentityGraph, checkIdentityClaims, auditSkillIdentity, auditIdentityWithEvidence };
