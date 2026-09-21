"use strict";

const crypto = require("crypto");
const {
  CAPABILITY_REGISTRY_ID,
  DEFAULT_CAPABILITY_DECISION,
  resolveControlledWriteCapability,
} = require("./controlled-write-capabilities");

const EXECUTION_PLAN_ID = "pvf-change-controlled-execution-plan";
const EXECUTION_PLAN_SCHEMA_VERSION = "1.1";
const EXECUTION_PLAN_RUNTIME_PATH = "core/pvf-agent-core/lib/controlled-execution-plan.js";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function canonicalJsonSha256(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function optionalHash(value) {
  const text = String(value || "").toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function stateOf(result) {
  if (result?.applicable !== true) return "blocked";
  return result?.changed === true ? "changed" : "no-op";
}

function contextBindingOf(result) {
  const anchor = result?.contextAnchor;
  if (!anchor) return null;
  return {
    selectorSha256: optionalHash(anchor.selectorSha256),
    locationBindingSha256: optionalHash(anchor.locationBindingSha256),
    occurrenceOffsetsSha256: optionalHash(anchor.occurrenceOffsetsSha256),
    scopeApplied: anchor.scopeApplied === true,
    scopeRangeBindingSha256: optionalHash(anchor.scope?.rangeBindingSha256),
    scopeRangesSha256: optionalHash(anchor.scope?.rangesSha256),
  };
}

function sourceContentSha256Of(result) {
  return optionalHash(result?.sourceTextSha256 || result?.sourceSha256);
}

function targetContentSha256Of(result) {
  return optionalHash(result?.finalFileExpectedSha256) || sourceContentSha256Of(result);
}

function verifiedTextEligibilityBindingOf(result) {
  const proof = result?.semanticWriteSafety?.verifiedInlineTextWrite;
  if (!proof) return null;
  return {
    policyId: String(proof.eligibilityPolicyId || "") || null,
    policySha256: optionalHash(proof.eligibilityPolicySha256),
    proofsSha256: optionalHash(proof.eligibilityProofsSha256),
  };
}

function projectExecutionEntry(result, ordinal) {
  const capability = resolveControlledWriteCapability(result || {});
  if (!capability) {
    const error = new Error(`Unknown controlled write capability for change ${result?.id || "<missing-id>"}.`);
    error.code = "CONTROLLED_EXECUTION_PLAN_UNKNOWN_CAPABILITY";
    throw error;
  }
  if (result.capabilityId !== capability.id) {
    const error = new Error(`Controlled write capability mismatch for change ${result?.id || "<missing-id>"}.`);
    error.code = "CONTROLLED_EXECUTION_PLAN_CAPABILITY_MISMATCH";
    error.details = { expectedCapabilityId: capability.id, actualCapabilityId: result?.capabilityId || null };
    throw error;
  }
  const id = String(result?.id || "");
  const pvfPath = normalizePvfPath(result?.pvfPath);
  if (!id || !pvfPath) {
    const error = new Error("Controlled execution plan entries require id and pvfPath.");
    error.code = "CONTROLLED_EXECUTION_PLAN_IDENTITY_REQUIRED";
    throw error;
  }
  return {
    ordinal,
    id,
    type: String(result.type || ""),
    pvfPath,
    capabilityId: capability.id,
    plannerId: capability.plannerId,
    writerId: capability.writerId,
    state: stateOf(result),
    pvfEncoding: result.pvfEncoding || null,
    textWriteMode: result.textWriteMode || null,
    replaceAll: result.replaceAll === true,
    expectedOccurrences: Number.isInteger(result.expectedOccurrences) ? result.expectedOccurrences : null,
    actualOccurrences: Number.isInteger(result.occurrenceCount) ? result.occurrenceCount : null,
    stepBeforeSha256: optionalHash(result.diff?.beforeSha256 || result.beforeSha256),
    stepAfterSha256: optionalHash(result.diff?.afterSha256 || result.expectedAfterSha256),
    targetContentSha256: targetContentSha256Of(result),
    sourceContentSha256: sourceContentSha256Of(result),
    sourcePvfPath: result.sourcePvfPath ? normalizePvfPath(result.sourcePvfPath) : null,
    contextBinding: contextBindingOf(result),
    verifiedTextEligibility: verifiedTextEligibilityBindingOf(result),
    structuredPlanBindingSha256: optionalHash(result.structuredEditProof?.planBindingSha256),
    structuredComponent: result.structuredEditComponent || null,
    structuredComponentState: result.structuredEditProof?.componentState || null,
    structuredWriterRequired: result.structuredEditProof?.writerRequired ?? null,
    writeProofSha256: result.writeProof ? canonicalJsonSha256(result.writeProof) : null,
    runtimeValidationRequired: capability.runtimeValidationRequired,
    temporaryRoundTripRequired: capability.temporaryRoundTripRequired === true,
    finalIndependentReadbackRequired: capability.finalIndependentReadbackRequired === true,
  };
}

function buildFilePlans(entries) {
  const files = new Map();
  for (const entry of entries) {
    if (!files.has(entry.pvfPath)) {
      files.set(entry.pvfPath, {
        pvfPath: entry.pvfPath,
        orderedEntryIds: [],
        capabilityIds: [],
        plannerIds: [],
        writerIds: [],
        states: [],
        targetContentSha256: null,
      });
    }
    const file = files.get(entry.pvfPath);
    file.orderedEntryIds.push(entry.id);
    for (const [field, value] of [
      ["capabilityIds", entry.capabilityId],
      ["plannerIds", entry.plannerId],
      ["writerIds", entry.writerId],
      ["states", entry.state],
    ]) {
      if (!file[field].includes(value)) file[field].push(value);
    }
    if (entry.targetContentSha256) {
      if (file.targetContentSha256 && file.targetContentSha256 !== entry.targetContentSha256) {
        const error = new Error(`Controlled execution plan produced conflicting final hashes for ${entry.pvfPath}.`);
        error.code = "CONTROLLED_EXECUTION_PLAN_FILE_HASH_CONFLICT";
        throw error;
      }
      file.targetContentSha256 = entry.targetContentSha256;
    }
  }
  return [...files.values()];
}

function buildControlledExecutionPlan(results = []) {
  const entries = results.map(projectExecutionEntry);
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    const error = new Error("Controlled execution plan change ids must be unique.");
    error.code = "CONTROLLED_EXECUTION_PLAN_DUPLICATE_ID";
    throw error;
  }
  const payload = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    planId: EXECUTION_PLAN_ID,
    capabilityRegistryId: CAPABILITY_REGISTRY_ID,
    defaultDecision: DEFAULT_CAPABILITY_DECISION,
    permissionExpansionAllowed: false,
    entryCount: entries.length,
    changedCount: entries.filter((entry) => entry.state === "changed").length,
    noOpCount: entries.filter((entry) => entry.state === "no-op").length,
    blockedCount: entries.filter((entry) => entry.state === "blocked").length,
    entries,
    files: buildFilePlans(entries),
  };
  return {
    ...payload,
    planSha256: canonicalJsonSha256(payload),
  };
}

function compareControlledExecutionPlans(expected, actual) {
  const errors = [];
  const entryMismatches = [];
  if (!expected || expected.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION || expected.planId !== EXECUTION_PLAN_ID) {
    errors.push("authorized execution plan identity is missing or unsupported");
  }
  if (!actual || actual.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION || actual.planId !== EXECUTION_PLAN_ID) {
    errors.push("recomputed execution plan identity is missing or unsupported");
  }
  if (expected?.capabilityRegistryId !== CAPABILITY_REGISTRY_ID || actual?.capabilityRegistryId !== CAPABILITY_REGISTRY_ID) {
    errors.push("execution plan capability registry identity mismatch");
  }
  if (expected?.defaultDecision !== DEFAULT_CAPABILITY_DECISION || actual?.defaultDecision !== DEFAULT_CAPABILITY_DECISION) {
    errors.push("execution plan must retain the default blocked decision");
  }
  if (expected?.permissionExpansionAllowed !== false || actual?.permissionExpansionAllowed !== false) {
    errors.push("execution plan must not grant permission expansion");
  }
  const expectedPayload = expected ? { ...expected } : null;
  const actualPayload = actual ? { ...actual } : null;
  if (expectedPayload) delete expectedPayload.planSha256;
  if (actualPayload) delete actualPayload.planSha256;
  const expectedComputedSha256 = expectedPayload ? canonicalJsonSha256(expectedPayload) : null;
  const actualComputedSha256 = actualPayload ? canonicalJsonSha256(actualPayload) : null;
  if (expected?.planSha256 !== expectedComputedSha256) errors.push("authorized execution plan hash is invalid");
  if (actual?.planSha256 !== actualComputedSha256) errors.push("recomputed execution plan hash is invalid");
  if (expected?.planSha256 !== actual?.planSha256) {
    errors.push("authorized and recomputed execution plans differ");
    const expectedEntries = Array.isArray(expected?.entries) ? expected.entries : [];
    const actualEntries = Array.isArray(actual?.entries) ? actual.entries : [];
    const count = Math.max(expectedEntries.length, actualEntries.length);
    for (let index = 0; index < count; index += 1) {
      const expectedEntry = expectedEntries[index] || null;
      const actualEntry = actualEntries[index] || null;
      if (canonicalJsonSha256(expectedEntry) === canonicalJsonSha256(actualEntry)) continue;
      const fields = [...new Set([
        ...Object.keys(expectedEntry || {}),
        ...Object.keys(actualEntry || {}),
      ])].filter((field) =>
        canonicalJsonSha256(expectedEntry?.[field] ?? null) !== canonicalJsonSha256(actualEntry?.[field] ?? null));
      entryMismatches.push({
        index,
        expectedId: expectedEntry?.id || null,
        actualId: actualEntry?.id || null,
        fields,
      });
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    entryMismatches,
    expectedPlanSha256: expected?.planSha256 || null,
    actualPlanSha256: actual?.planSha256 || null,
  };
}

function expectedExecutionPlanPolicy() {
  return {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    planId: EXECUTION_PLAN_ID,
    runtimeModule: EXECUTION_PLAN_RUNTIME_PATH,
    defaultDecision: DEFAULT_CAPABILITY_DECISION,
    permissionExpansionAllowed: false,
    dryRunProducesBoundPlan: true,
    applyRecomputesBeforeWrite: true,
    replacementWriterConsumesPreflightPlan: true,
  };
}

function validateExecutionPlanPolicy(policy = {}) {
  const expected = expectedExecutionPlanPolicy();
  const errors = [];
  for (const [field, value] of Object.entries(expected)) {
    if (policy?.[field] !== value) {
      errors.push(`write-policy executionPlanContract.${field} must be ${JSON.stringify(value)}`);
    }
  }
  return { ok: errors.length === 0, errors, expected };
}

function controlledExecutionPlanSelfTest(writePolicy = null) {
  const checks = [];
  const baseResults = [
    {
      id: "raw-change",
      type: "replace-text",
      capabilityId: "ordinary-raw-token-replacement",
      pvfPath: "skill/fixture.skl",
      applicable: true,
      changed: true,
      pvfEncoding: "Tw",
      expectedOccurrences: 1,
      occurrenceCount: 1,
      diff: { beforeSha256: sha256("before"), afterSha256: sha256("after") },
      finalFileExpectedSha256: sha256("final"),
    },
    {
      id: "text-change",
      type: "replace-text",
      capabilityId: "verified-inline-text",
      pvfPath: "skill/fixture.skl",
      applicable: true,
      changed: false,
      pvfEncoding: "Tw",
      textWriteMode: "verified-inline-text",
      expectedOccurrences: 1,
      occurrenceCount: 1,
      semanticWriteSafety: {
        verifiedInlineTextWrite: {
          eligibilityPolicyId: "fixture-visible-text-policy",
          eligibilityPolicySha256: sha256("eligibility-policy"),
          eligibilityProofsSha256: sha256("eligibility-proofs"),
        },
      },
      diff: { beforeSha256: sha256("final"), afterSha256: sha256("final") },
      finalFileExpectedSha256: sha256("final"),
    },
  ];
  const first = buildControlledExecutionPlan(baseResults);
  const second = buildControlledExecutionPlan(JSON.parse(JSON.stringify(baseResults)));
  checks.push({
    id: "controlled-execution-plan-is-deterministic-and-order-bound",
    ok: first.planSha256 === second.planSha256 &&
      first.planSha256 !== buildControlledExecutionPlan([...baseResults].reverse()).planSha256,
  });
  checks.push({
    id: "controlled-execution-plan-preserves-closed-capability-writer-routing",
    ok:
      first.defaultDecision === "blocked" &&
      first.permissionExpansionAllowed === false &&
      first.entries[0].plannerId === "exact-raw-token-plan" &&
      first.entries[0].writerId === "raw-script-token-patch" &&
      first.entries[1].writerId === "verified-inline-text-batch-patch" &&
      first.entries[1].verifiedTextEligibility?.policyId === "fixture-visible-text-policy" &&
      first.entries[1].verifiedTextEligibility?.proofsSha256 === sha256("eligibility-proofs"),
  });
  const eligibilityDrift = JSON.parse(JSON.stringify(baseResults));
  eligibilityDrift[1].semanticWriteSafety.verifiedInlineTextWrite.eligibilityProofsSha256 = sha256("other-proof");
  checks.push({
    id: "controlled-execution-plan-rejects-verified-text-eligibility-drift",
    ok: compareControlledExecutionPlans(first, buildControlledExecutionPlan(eligibilityDrift)).ok === false,
  });
  const changedResult = JSON.parse(JSON.stringify(baseResults));
  for (const result of changedResult) result.finalFileExpectedSha256 = sha256("different-final");
  const comparison = compareControlledExecutionPlans(first, buildControlledExecutionPlan(changedResult));
  checks.push({ id: "controlled-execution-plan-rejects-semantic-plan-drift", ok: comparison.ok === false });
  const tampered = JSON.parse(JSON.stringify(first));
  tampered.entries[0].writerId = "different-writer";
  checks.push({
    id: "controlled-execution-plan-rejects-manifest-tampering",
    ok: compareControlledExecutionPlans(tampered, second).ok === false,
  });
  let unknownRejected = false;
  try {
    buildControlledExecutionPlan([{ id: "unknown", type: "unknown-write", pvfPath: "x/y.stk", applicable: false, changed: false }]);
  } catch (error) {
    unknownRejected = error.code === "CONTROLLED_EXECUTION_PLAN_UNKNOWN_CAPABILITY";
  }
  checks.push({ id: "controlled-execution-plan-unknown-routes-fail-closed", ok: unknownRejected });
  if (writePolicy) {
    const policyContract = validateExecutionPlanPolicy(writePolicy?.controlledWriteRunner?.executionPlanContract);
    checks.push({
      id: "write-policy-execution-plan-contract-matches-runtime",
      ok: policyContract.ok,
      errors: policyContract.errors,
    });
  }
  return checks;
}

module.exports = {
  EXECUTION_PLAN_ID,
  EXECUTION_PLAN_RUNTIME_PATH,
  EXECUTION_PLAN_SCHEMA_VERSION,
  buildControlledExecutionPlan,
  compareControlledExecutionPlans,
  controlledExecutionPlanSelfTest,
  expectedExecutionPlanPolicy,
  validateExecutionPlanPolicy,
};
