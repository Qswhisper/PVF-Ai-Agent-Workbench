"use strict";

const path = require("path");

const CAPABILITY_REGISTRY_ID = "pvf-change-controlled-write-capabilities";
const CAPABILITY_REGISTRY_SCHEMA_VERSION = "1.0";
const DEFAULT_CAPABILITY_DECISION = "blocked";
const RUNTIME_RESOLVER_PATH = "core/pvf-agent-core/lib/controlled-write-capabilities.js";
const PUBLIC_SCHEMA_PATH = "core/pvf-agent-core/schemas/pvf-change-set.schema.json";

const CHANGE_SET_FIELD_CONTRACT = Object.freeze({
  root: Object.freeze(["$schema", "schemaVersion", "mode", "description", "baseline", "target", "changes", "safety"]),
  baseline: Object.freeze(["applyManifest"]),
  target: Object.freeze(["profile", "sourcePvf", "pvfOpenEncoding", "pvfReadEncoding"]),
  safety: Object.freeze(["writeModeEnabled", "requiresBackupBeforeApply", "requiresExplicitOutputPath", "requiresReadback"]),
  scope: Object.freeze(["startText", "endText", "expectedRanges"]),
  requiredResolvedId: Object.freeze(["lstPath", "id", "expectedPvfPath"]),
  writeProof: Object.freeze([
    "mode", "allowExistingRegistryEdit", "registry", "pairedEntries", "referencePaths",
    "compileRequired", "encodingRoundTripRequired", "pvfEncoding", "sourceTextSha256",
    "crossVersionEvidence", "structureCheckRequired", "temporaryRoundTripRequired",
    "runtimeValidationRequired", "loadChain", "loadChainKind", "skillProc", "touchedFunctions", "apiSymbols", "apidPlan",
  ]),
  registryProof: Object.freeze(["lstPath", "id", "expectedPvfPath", "action"]),
  loadChainEntry: Object.freeze(["fromPvfPath", "toPvfPath", "requiredText"]),
  skillProc: Object.freeze(["dispatcher", "requiredCall", "stateRegistration", "headerRegistration", "skillId", "skillRegistryPath", "skillPvfPath"]),
  apiSymbol: Object.freeze(["name", "kind", "targetEvidencePaths"]),
  apidPlan: Object.freeze(["namespace", "ids", "conflictSearchRequired"]),
  changeTypes: Object.freeze({
    "replace-text": Object.freeze([
      "id", "type", "pvfPath", "pvfEncoding", "rationale", "requiredResolvedIds", "writeProof",
      "previousText", "newText", "contextBefore", "contextAfter", "scope", "replaceAll",
      "expectedOccurrences", "textWriteMode",
    ]),
    "write-file": Object.freeze([
      "id", "type", "pvfPath", "pvfEncoding", "rationale", "requiredResolvedIds", "writeProof",
      "sourceFile", "sourceSha256", "expectAbsent", "compileScript", "compileBinaryAni",
    ]),
    "copy-file": Object.freeze([
      "id", "type", "pvfPath", "pvfEncoding", "rationale", "requiredResolvedIds",
      "sourcePvfPath", "expectAbsent", "compileScript",
    ]),
    "upgrade-table-level-edit": Object.freeze([
      "id", "type", "pvfPath", "pvfEncoding", "rationale", "requiredResolvedIds",
      "sourceLevel", "targetLevels", "copyColumns", "preserveColumns", "maxLevelByRarity",
      "copyAmplificationConstFromLevel", "copyAmplificationConstToLevels",
      "amplificationConstGroupWidth", "amplificationConstHasLevelZeroGroup",
      "tableEdit", "amplificationConstEdit",
    ]),
  }),
});

const CAPABILITY_DEFINITIONS = Object.freeze([
  {
    id: "ordinary-raw-token-replacement",
    changeType: "replace-text",
    family: "script-token",
    plannerId: "exact-raw-token-plan",
    writerId: "raw-script-token-patch",
    temporaryRoundTripRequired: false,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: false,
  },
  {
    id: "verified-inline-text",
    changeType: "replace-text",
    family: "visible-text",
    plannerId: "verified-inline-text-plan",
    writerId: "verified-inline-text-batch-patch",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: "client-text-smoke-check",
  },
  {
    id: "existing-binary-ani-delay",
    changeType: "replace-text",
    family: "binary-field",
    plannerId: "ani-delay-field-plan",
    writerId: "raw-binary-ani-delay-patch",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: true,
    runtimeValidationRequired: true,
  },
  {
    id: "existing-nut-controlled-edit",
    changeType: "replace-text",
    family: "protected-runtime-script",
    plannerId: "existing-nut-transition-plan",
    writerId: "byte-preserving-ascii-text-patch",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: true,
    runtimeValidationRequired: true,
  },
  {
    id: "registry-lifecycle-row-add",
    changeType: "replace-text",
    family: "registry-lifecycle",
    plannerId: "registry-row-add-plan",
    writerId: "raw-script-token-patch",
    temporaryRoundTripRequired: false,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: false,
  },
  {
    id: "same-pvf-file-copy",
    changeType: "copy-file",
    family: "file-lifecycle",
    plannerId: "same-pvf-copy-plan",
    writerId: "same-pvf-copy-write",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: "route-defined",
  },
  {
    id: "ordinary-new-file",
    changeType: "write-file",
    family: "file-lifecycle",
    plannerId: "ordinary-new-file-plan",
    writerId: "controlled-new-file-write",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: "route-defined",
  },
  {
    id: "high-risk-new-file",
    changeType: "write-file",
    family: "protected-file-lifecycle",
    plannerId: "high-risk-new-file-audit-plan",
    writerId: "controlled-new-file-write",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: "route-defined",
  },
  {
    id: "upgrade-amplification-table",
    changeType: "upgrade-table-level-edit",
    family: "structured-table",
    plannerId: "upgrade-table-level-plan",
    writerId: "raw-script-token-patch",
    temporaryRoundTripRequired: true,
    finalIndependentReadbackRequired: true,
    nonTargetRawBytesMustRemainIdentical: false,
    runtimeValidationRequired: true,
  },
].map((definition) => Object.freeze({
  ...definition,
  decisionStates: Object.freeze(["changed", "no-op", "blocked"]),
  permissionExpansionAllowed: false,
})));

const CAPABILITY_BY_ID = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
const HIGH_RISK_NEW_FILE_EXTENSIONS = new Set([".wdm", ".lst", ".co", ".nut", ".sqr", ".str"]);
const VERIFIED_INLINE_TEXT_MODES = new Set(["verified-inline-text", "verified-inline-cn", "verified-stringlink-detach", "verified-scalar-text"]);

function extensionOf(pvfPath) {
  return path.posix.extname(String(pvfPath || "").replace(/\\/g, "/").toLowerCase());
}

function resolveControlledWriteCapability(change = {}) {
  const type = String(change.type || "");
  const proofMode = String(change.writeProof?.mode || "");
  let capabilityId = null;
  if (type === "upgrade-table-level-edit") capabilityId = "upgrade-amplification-table";
  else if (type === "copy-file") capabilityId = "same-pvf-file-copy";
  else if (type === "write-file") {
    capabilityId = HIGH_RISK_NEW_FILE_EXTENSIONS.has(extensionOf(change.pvfPath))
      ? "high-risk-new-file"
      : "ordinary-new-file";
  } else if (type === "replace-text") {
    if (proofMode === "existing-nut-controlled-edit") capabilityId = "existing-nut-controlled-edit";
    else if (proofMode === "registry-lifecycle") capabilityId = "registry-lifecycle-row-add";
    else if (VERIFIED_INLINE_TEXT_MODES.has(String(change.textWriteMode || ""))) capabilityId = "verified-inline-text";
    else if (extensionOf(change.pvfPath) === ".ani") capabilityId = "existing-binary-ani-delay";
    else capabilityId = "ordinary-raw-token-replacement";
  }
  const definition = CAPABILITY_BY_ID.get(capabilityId) || null;
  if (!definition) return null;
  return {
    ...definition,
    selection: {
      changeType: type,
      pvfExtension: extensionOf(change.pvfPath) || null,
      writeProofMode: proofMode || null,
      textWriteMode: change.textWriteMode || null,
    },
  };
}

function capabilityIdForChange(change = {}) {
  return resolveControlledWriteCapability(change)?.id || null;
}

function attachCapabilityIds(results = []) {
  for (const result of results) {
    result.capabilityId = capabilityIdForChange(result);
  }
  return results;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStringSet(left, right) {
  const a = sortedUnique(left || []);
  const b = sortedUnique(right || []);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateCapabilityRegistry() {
  const errors = [];
  const ids = CAPABILITY_DEFINITIONS.map((definition) => definition.id);
  if (new Set(ids).size !== ids.length) errors.push("controlled write capability ids must be unique");
  for (const definition of CAPABILITY_DEFINITIONS) {
    if (!CHANGE_SET_FIELD_CONTRACT.changeTypes[definition.changeType]) {
      errors.push(`capability ${definition.id} references unsupported change type ${definition.changeType}`);
    }
    if (!definition.plannerId || !definition.writerId) errors.push(`capability ${definition.id} requires plannerId and writerId`);
    if (definition.permissionExpansionAllowed !== false) errors.push(`capability ${definition.id} must not grant permission by declaration alone`);
    if (!sameStringSet(definition.decisionStates, ["changed", "no-op", "blocked"])) {
      errors.push(`capability ${definition.id} must use changed/no-op/blocked states`);
    }
  }
  return { ok: errors.length === 0, errors, capabilityIds: ids };
}

function propertyNames(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value.properties || {})
    : [];
}

function validatePublicSchemaContract(schema = {}) {
  const errors = [];
  const compare = (label, actual, expected) => {
    if (!sameStringSet(actual, expected)) {
      errors.push(`${label} fields do not match the runtime contract: expected ${sortedUnique(expected).join(", ")}; found ${sortedUnique(actual).join(", ")}`);
    }
  };
  compare("change-set root", propertyNames(schema), CHANGE_SET_FIELD_CONTRACT.root);
  compare("target", propertyNames(schema.properties?.target), CHANGE_SET_FIELD_CONTRACT.target);
  compare("safety", propertyNames(schema.properties?.safety), CHANGE_SET_FIELD_CONTRACT.safety);
  const defs = schema.$defs || {};
  const schemaChangeFields = new Map();
  for (const definition of Object.values(defs)) {
    const type = definition?.properties?.type?.const;
    if (type) schemaChangeFields.set(type, propertyNames(definition));
  }
  compare("change types", [...schemaChangeFields.keys()], Object.keys(CHANGE_SET_FIELD_CONTRACT.changeTypes));
  for (const [type, expectedFields] of Object.entries(CHANGE_SET_FIELD_CONTRACT.changeTypes)) {
    compare(`${type} change`, schemaChangeFields.get(type) || [], expectedFields);
  }
  compare("writeProof", propertyNames(defs.writeProof), CHANGE_SET_FIELD_CONTRACT.writeProof);
  compare("skillProc", propertyNames(defs.writeProof?.properties?.skillProc), CHANGE_SET_FIELD_CONTRACT.skillProc);
  return { ok: errors.length === 0, errors };
}

function expectedWritePolicyCapabilityRegistry() {
  return {
    schemaVersion: CAPABILITY_REGISTRY_SCHEMA_VERSION,
    registryId: CAPABILITY_REGISTRY_ID,
    runtimeResolver: RUNTIME_RESOLVER_PATH,
    publicSchema: PUBLIC_SCHEMA_PATH,
    defaultDecision: DEFAULT_CAPABILITY_DECISION,
    permissionExpansionAllowed: false,
    capabilityIds: CAPABILITY_DEFINITIONS.map((definition) => definition.id),
  };
}

function validateWritePolicyCapabilityRegistry(policyRegistry = {}) {
  const expected = expectedWritePolicyCapabilityRegistry();
  const errors = [];
  for (const field of ["schemaVersion", "registryId", "runtimeResolver", "publicSchema", "defaultDecision", "permissionExpansionAllowed"]) {
    if (policyRegistry?.[field] !== expected[field]) {
      errors.push(`write-policy capabilityRegistry.${field} must be ${JSON.stringify(expected[field])}`);
    }
  }
  if (!sameStringSet(policyRegistry?.capabilityIds, expected.capabilityIds)) {
    errors.push("write-policy capabilityRegistry.capabilityIds must exactly match the runtime registry");
  }
  return { ok: errors.length === 0, errors, expected };
}

function controlledWriteCapabilitySelfTest(schema, writePolicy) {
  const checks = [];
  const registry = validateCapabilityRegistry();
  checks.push({ id: "controlled-write-capability-registry-is-closed-and-fail-safe", ok: registry.ok, errors: registry.errors });
  const schemaContract = validatePublicSchemaContract(schema);
  checks.push({ id: "public-change-set-schema-matches-runtime-field-contract", ok: schemaContract.ok, errors: schemaContract.errors });
  const policyContract = validateWritePolicyCapabilityRegistry(writePolicy?.controlledWriteRunner?.capabilityRegistry);
  checks.push({ id: "write-policy-capability-registry-matches-runtime", ok: policyContract.ok, errors: policyContract.errors });

  const fixtures = [
    [{ type: "replace-text", pvfPath: "stackable/fixture.stk" }, "ordinary-raw-token-replacement"],
    [{ type: "replace-text", pvfPath: "skill/fixture.skl", textWriteMode: "verified-inline-text" }, "verified-inline-text"],
    [{ type: "replace-text", pvfPath: "monster/fixture.ani" }, "existing-binary-ani-delay"],
    [{ type: "replace-text", pvfPath: "sqr/fixture.nut", writeProof: { mode: "existing-nut-controlled-edit" } }, "existing-nut-controlled-edit"],
    [{ type: "replace-text", pvfPath: "monster/monster.lst", writeProof: { mode: "registry-lifecycle" } }, "registry-lifecycle-row-add"],
    [{ type: "copy-file", pvfPath: "map/fixture.til" }, "same-pvf-file-copy"],
    [{ type: "write-file", pvfPath: "stackable/new.stk" }, "ordinary-new-file"],
    [{ type: "write-file", pvfPath: "sqr/new.nut" }, "high-risk-new-file"],
    [{ type: "upgrade-table-level-edit", pvfPath: "etc/upgrade.etc" }, "upgrade-amplification-table"],
    [{ type: "unknown-write", pvfPath: "stackable/fixture.stk" }, null],
  ];
  checks.push({
    id: "existing-controlled-write-routes-resolve-without-permission-expansion",
    ok: fixtures.every(([change, expected]) => capabilityIdForChange(change) === expected),
  });
  return checks;
}

module.exports = {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_REGISTRY_ID,
  CHANGE_SET_FIELD_CONTRACT,
  DEFAULT_CAPABILITY_DECISION,
  PUBLIC_SCHEMA_PATH,
  RUNTIME_RESOLVER_PATH,
  attachCapabilityIds,
  capabilityIdForChange,
  controlledWriteCapabilitySelfTest,
  expectedWritePolicyCapabilityRegistry,
  resolveControlledWriteCapability,
  validateCapabilityRegistry,
  validatePublicSchemaContract,
  validateWritePolicyCapabilityRegistry,
};
