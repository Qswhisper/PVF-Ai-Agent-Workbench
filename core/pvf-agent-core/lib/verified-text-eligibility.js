"use strict";

const crypto = require("crypto");
const path = require("path");
const { lexDecompiledScript } = require("../../../tools/pvf-bridge/script-text-lexer");
const { inspectEventIntroText, eventIntroTextSelfTest } = require("./event-intro-text");

const VERIFIED_TEXT_ELIGIBILITY_SCHEMA_VERSION = "1.0";
const VERIFIED_TEXT_ELIGIBILITY_POLICY_ID = "pvf-verified-visible-text-eligibility";
const VERIFIED_TEXT_ELIGIBILITY_RUNTIME_PATH = "core/pvf-agent-core/lib/verified-text-eligibility.js";
const VERIFIED_TEXT_ELIGIBILITY_DEFAULT_DECISION = "blocked";

const DIRECT_VISIBLE_TEXT_TAGS = [
  "basic explain",
  "condition message",
  "depend message",
  "desc",
  "description",
  "explain",
  "flavor text",
  "map name",
  "message",
  "minimum info",
  "name",
  "name2",
  "on attack",
  "skill explain",
  "skill string",
  "solve message",
  "speech on situation",
];

const INLINE_TEXT_EXTENSIONS = [
  ".aic",
  ".cre",
  ".dgn",
  ".equ",
  ".etc",
  ".evt",
  ".map",
  ".mob",
  ".msn",
  ".npc",
  ".obj",
  ".qst",
  ".shp",
  ".skl",
  ".stk",
  ".ui",
];

const PROTECTED_EXISTING_TEXT_EXTENSIONS = [".co", ".lst", ".nut", ".sqr", ".str"];

const VERIFIED_TEXT_ELIGIBILITY_REGISTRY = deepFreeze({
  schemaVersion: VERIFIED_TEXT_ELIGIBILITY_SCHEMA_VERSION,
  policyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
  defaultDecision: VERIFIED_TEXT_ELIGIBILITY_DEFAULT_DECISION,
  permissionExpansionAllowed: false,
  completeBacktickTokenRequired: true,
  stringLinkWriteAllowed: false,
  unknownRuleAllowed: false,
  allowedExtensions: INLINE_TEXT_EXTENSIONS,
  protectedExistingTextExtensions: PROTECTED_EXISTING_TEXT_EXTENSIONS,
  rules: [
    { id: "explicit-scalar-text", kind: "explicit-scalar-token", textWriteMode: "verified-scalar-text",
      completeScalarRequired: true, placeholderOrderPreservedRequired: true,
      semanticMeaningVerified: false, runtimeValidationRequired: true },
    {
      id: "event-list-paired-intro-text",
      kind: "path-scoped-structured-record",
      paths: ["event/eventlistwindow.evt"],
      pairedDescriptionRequired: true,
      pairedSingleLineTitleAllowed: true,
      plainTextOnly: true,
      placeholderOrderPreservedRequired: true,
    },
    {
      id: "stk-name-stringlink-detach",
      kind: "explicit-stringlink-to-inline",
      extensions: [".stk"],
      tags: ["name"],
      textWriteMode: "verified-stringlink-detach",
      externalStringResourcesUnchanged: true,
    },
    {
      id: "direct-visible-text-tag",
      kind: "direct-parent-tag",
      tags: DIRECT_VISIBLE_TEXT_TAGS,
    },
    {
      id: "skl-visible-text-ex-variant",
      kind: "derived-parent-tag-family",
      extensions: [".skl"],
      suffix: " ex",
      baseRuleId: "direct-visible-text-tag",
    },
    {
      id: "titlebook-send-postal-visible-text",
      kind: "path-scoped-open-container",
      paths: ["etc/titlebook.etc"],
      tags: ["send postal"],
    },
    {
      id: "titlebook-section-name-visible-text",
      kind: "path-scoped-scalar-line",
      paths: ["etc/titlebook.etc"],
      tags: ["section name"],
      singleLineTokenRequired: true,
      messageTokenOwnLineRequired: true,
    },
    {
      id: "dgn-tower-dialog-visible-message",
      kind: "structured-record",
      extensions: [".dgn"],
      parentTag: "tower dialog",
      precedingSequence: ["parent-tag", "integer-floor", "complete-message-token"],
      followingEventTokens: ["on complete", "on start"],
      messageTokenOwnLineRequired: true,
    },
    {
      id: "qst-condition-data-progress-message",
      kind: "structured-record",
      extensions: [".qst"],
      parentTag: "condition data",
      closingTag: "/condition data",
      precedingSequence: ["parent-tag", "integer-parameter", "complete-progress-token"],
      placeholderOrderPreservedRequired: true,
      messageTokenOwnLineRequired: true,
      singleLineTokenRequired: true,
    },
  ],
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalJsonSha256(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

const VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256 = canonicalJsonSha256(VERIFIED_TEXT_ELIGIBILITY_REGISTRY);
const ALLOWED_VISIBLE_TEXT_TAGS = new Set(DIRECT_VISIBLE_TEXT_TAGS);
const ALLOWED_INLINE_TEXT_EXTENSIONS = new Set(INLINE_TEXT_EXTENSIONS);
const PROTECTED_EXISTING_TEXT_EXTENSION_SET = new Set(PROTECTED_EXISTING_TEXT_EXTENSIONS);
const RULES_BY_ID = new Map(VERIFIED_TEXT_ELIGIBILITY_REGISTRY.rules.map((rule) => [rule.id, rule]));

function normalizeTag(value) {
  return String(value || "").trim().replace(/^\[/u, "").replace(/\]$/u, "").trim().toLowerCase();
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\/{2,}/gu, "/")
    .toLowerCase();
}

function directBacktickTokenValue(fragment) {
  const match = /^`([^`]*)`$/u.exec(String(fragment || ""));
  return match ? match[1] : null;
}

function immediateParentTag(sourceText, tokenOffset) {
  const text = String(sourceText || "");
  const lineStart = text.lastIndexOf("\n", Math.max(0, Number(tokenOffset) - 1)) + 1;
  const lines = text.slice(0, lineStart).split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = /^\[([^\]\r\n]+)\]$/u.exec(line);
    if (!match || match[1].trim().startsWith("/")) return null;
    return normalizeTag(match[1]);
  }
  return null;
}

function nearestOpenTag(sourceText, tokenOffset) {
  const text = String(sourceText || "");
  const lineStart = text.lastIndexOf("\n", Math.max(0, Number(tokenOffset) - 1)) + 1;
  const lines = text.slice(0, lineStart).split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\[([^\]\r\n]+)\]$/u.exec(lines[index].trim());
    if (!match) continue;
    if (match[1].trim().startsWith("/")) return null;
    return normalizeTag(match[1]);
  }
  return null;
}

function tokenLineInfo(sourceText, tokenOffset, tokenLength) {
  const text = String(sourceText || "");
  const offset = Number(tokenOffset);
  const length = Number(tokenLength);
  const tokenEnd = offset + length;
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf("\n", tokenEnd);
  const lineEnd = nextLineBreak < 0 ? text.length : nextLineBreak;
  return {
    lineStart,
    lineEnd,
    tokenEnd,
    tokenOwnLine: !text.slice(lineStart, offset).trim() && !text.slice(tokenEnd, lineEnd).trim(),
  };
}

function scalarLineEvidence(rule, sourceText, tokenOffset, tokenLength) {
  const text = String(sourceText || "");
  const offset = Number(tokenOffset);
  const length = Number(tokenLength);
  const value = directBacktickTokenValue(text.slice(offset, offset + length));
  if (value === null) return { ok: false };
  const line = tokenLineInfo(text, offset, length);
  if (rule.singleLineTokenRequired && /[\r\n]/u.test(value)) return { ok: false };
  if (rule.messageTokenOwnLineRequired && !line.tokenOwnLine) return { ok: false };
  return {
    ok: true,
    tokenOwnLine: line.tokenOwnLine,
    singleLineToken: !/[\r\n]/u.test(value),
  };
}

function inspectDgnTowerDialogTextToken(sourceText, tokenOffset, tokenLength, pvfPath) {
  const rule = RULES_BY_ID.get("dgn-tower-dialog-visible-message");
  const text = String(sourceText || "");
  const offset = Number(tokenOffset);
  const length = Number(tokenLength);
  const normalizedPath = normalizePvfPath(pvfPath);
  const extension = path.posix.extname(normalizedPath);
  if (!rule.extensions.includes(extension) || !Number.isInteger(offset) || !Number.isInteger(length) || length < 2) {
    return { ok: false };
  }
  const tokenEnd = offset + length;
  if (offset < 0 || tokenEnd > text.length || directBacktickTokenValue(text.slice(offset, tokenEnd)) === null) {
    return { ok: false };
  }
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf("\n", tokenEnd);
  const lineEnd = nextLineBreak < 0 ? text.length : nextLineBreak;
  if (rule.messageTokenOwnLineRequired && (text.slice(lineStart, offset).trim() || text.slice(tokenEnd, lineEnd).trim())) {
    return { ok: false };
  }
  const beforeLines = text.slice(0, lineStart).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (beforeLines.length < 2) return { ok: false };
  const floorText = beforeLines[beforeLines.length - 1];
  const tagText = beforeLines[beforeLines.length - 2];
  if (!/^\d+$/u.test(floorText) || normalizeTag(tagText) !== rule.parentTag) return { ok: false };
  const afterLines = text.slice(lineEnd < text.length ? lineEnd + 1 : lineEnd)
    .split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const eventValue = directBacktickTokenValue(afterLines[0] || "");
  const event = String(eventValue || "").trim().toLowerCase();
  if (!rule.followingEventTokens.includes(event)) return { ok: false };
  return {
    ok: true,
    floor: Number(floorText),
    event,
    tokenOwnLine: true,
  };
}

function inspectQstConditionDataProgressTextToken(sourceText, tokenOffset, tokenLength, pvfPath) {
  const rule = RULES_BY_ID.get("qst-condition-data-progress-message");
  const text = String(sourceText || "");
  const offset = Number(tokenOffset);
  const length = Number(tokenLength);
  const normalizedPath = normalizePvfPath(pvfPath);
  const extension = path.posix.extname(normalizedPath);
  if (!rule.extensions.includes(extension) || !Number.isInteger(offset) || !Number.isInteger(length) || length < 2) {
    return { ok: false };
  }
  const tokenEnd = offset + length;
  const tokenValue = directBacktickTokenValue(text.slice(offset, tokenEnd));
  if (offset < 0 || tokenEnd > text.length || tokenValue === null) return { ok: false };
  if (rule.singleLineTokenRequired && /[\r\n]/u.test(tokenValue)) return { ok: false };
  const line = tokenLineInfo(text, offset, length);
  if (rule.messageTokenOwnLineRequired && !line.tokenOwnLine) return { ok: false };
  const beforeLines = text.slice(0, line.lineStart).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (beforeLines.length < 2) return { ok: false };
  const integerText = beforeLines[beforeLines.length - 1];
  const tagText = beforeLines[beforeLines.length - 2];
  if (!/^-?\d+$/u.test(integerText) || normalizeTag(tagText) !== rule.parentTag) return { ok: false };
  const afterLines = text.slice(line.lineEnd < text.length ? line.lineEnd + 1 : line.lineEnd)
    .split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (normalizeTag(afterLines[0] || "") !== rule.closingTag) return { ok: false };
  return {
    ok: true,
    conditionDataInteger: Number(integerText),
    closingTag: rule.closingTag,
    tokenOwnLine: line.tokenOwnLine,
    closedContainer: true,
    singleLineToken: true,
  };
}

function ruleProof(rule, input, parentTag, evidence = {}) {
  const normalizedPath = normalizePvfPath(input.pvfPath);
  const proof = {
    schemaVersion: VERIFIED_TEXT_ELIGIBILITY_SCHEMA_VERSION,
    policyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
    policySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
    defaultDecision: VERIFIED_TEXT_ELIGIBILITY_DEFAULT_DECISION,
    permissionExpansionAllowed: false,
    ruleId: rule.id,
    ruleKind: rule.kind,
    parentTag,
    pvfPath: normalizedPath,
    extension: path.posix.extname(normalizedPath),
    tokenOffset: Number(input.tokenOffset),
    tokenLength: Number(input.tokenLength),
    ...evidence,
  };
  return { ...proof, proofSha256: canonicalJsonSha256(proof) };
}

function denied(input, parentTag, reason) {
  return {
    allowed: false,
    decision: VERIFIED_TEXT_ELIGIBILITY_DEFAULT_DECISION,
    policyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
    policySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
    permissionExpansionAllowed: false,
    parentTag: parentTag || null,
    reason,
    pvfPath: normalizePvfPath(input.pvfPath),
  };
}

function derivedFamilyMatch(parentTag, extension) {
  const rule = RULES_BY_ID.get("skl-visible-text-ex-variant");
  if (!rule.extensions.includes(extension)) return null;
  const normalizedParentTag = normalizeTag(parentTag);
  if (!normalizedParentTag.endsWith(rule.suffix)) return null;
  const baseTag = normalizedParentTag.slice(0, -rule.suffix.length).trim();
  return ALLOWED_VISIBLE_TEXT_TAGS.has(baseTag) ? { rule, baseTag } : null;
}

function pathScopedMatch(parentTag, pvfPath) {
  const normalizedParentTag = normalizeTag(parentTag);
  const normalizedPath = normalizePvfPath(pvfPath);
  return VERIFIED_TEXT_ELIGIBILITY_REGISTRY.rules.find((rule) =>
    Array.isArray(rule.tags) &&
    Array.isArray(rule.paths) &&
    rule.tags.includes(normalizedParentTag) &&
    rule.paths.includes(normalizedPath)) || null;
}

function classifyVisibleTextOccurrence(input = {}) {
  const normalizedPath = normalizePvfPath(input.pvfPath);
  const extension = path.posix.extname(normalizedPath);
  if (!ALLOWED_INLINE_TEXT_EXTENSIONS.has(extension)) return denied(input, null, "file-type-not-eligible");
  const offset = Number(input.tokenOffset);
  const length = Number(input.tokenLength);
  const text = String(input.sourceText || "");
  if (input.textWriteMode === "verified-stringlink-detach") {
    const rule = RULES_BY_ID.get("stk-name-stringlink-detach");
    const token = text.slice(offset, offset + length);
    const parentTag = immediateParentTag(text, offset);
    if (Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && offset + length <= text.length &&
        extension === ".stk" && parentTag === "name" && tokenLineInfo(text, offset, length).tokenOwnLine &&
        /^<(\d+)::([^>`\r\n]{1,512})`([^`]*)`>$/u.test(token)) {
      return { allowed: true, decision: "allowed-by-registered-rule", parentTag,
        proof: ruleProof(rule, input, parentTag, { mode: rule.id, externalStringResourcesUnchanged: true }) };
    }
    return denied(input, parentTag, "stringlink-detach-name-only");
  }
  if (!Number.isInteger(offset) || !Number.isInteger(length) || length < 2 || offset < 0 || offset + length > text.length ||
      directBacktickTokenValue(text.slice(offset, offset + length)) === null) {
    return denied(input, null, "complete-backtick-token-required");
  }

  if (input.textWriteMode === "verified-scalar-text") {
    // This route proves a literal scalar replacement, never display/runtime semantics.
    // Tokenize first: tags embedded in strings must not become parents or boundaries.
    let atoms;
    try { atoms = lexDecompiledScript(text); } catch { return denied(input, null, "scalar-tokenization-failed"); }
    const index = atoms.findIndex(atom => atom.start === offset && atom.end === offset + length);
    const atom = atoms[index], parent = atoms[index - 1], next = atoms[index + 1];
    const parentTag = parent?.kind === "section" ? normalizeTag(parent.value) : null;
    const reserved = VERIFIED_TEXT_ELIGIBILITY_REGISTRY.rules
      .filter(rule => rule.kind.startsWith("path-scoped") || rule.kind === "structured-record")
      .flatMap(rule => [...(rule.tags || []), ...(rule.parentTag ? [rule.parentTag] : [])]);
    if (extension === ".evt" || !atom || atom.kind !== "string" || !parentTag || parentTag.startsWith("/") ||
        reserved.includes(parentTag) || (next && next.kind !== "section") ||
        !tokenLineInfo(text, offset, length).tokenOwnLine) {
      return denied(input, parentTag, "explicit-scalar-structure-required");
    }
    const rule = RULES_BY_ID.get("explicit-scalar-text");
    return { allowed: true, decision: "allowed-by-registered-rule", parentTag,
      proof: ruleProof(rule, input, parentTag, { mode: rule.id, tokenOwnLine: true,
        placeholderOrderPreservedRequired: true, semanticMeaningVerified: false, runtimeValidationRequired: true }) };
  }

  // EVT never falls through to the generic [explain]/[name] rules.
  if (extension === ".evt") {
    const evidence = inspectEventIntroText(text, offset, length, normalizedPath);
    if (!evidence) return denied(input, null, "event-intro-structure-not-eligible");
    const rule = RULES_BY_ID.get("event-list-paired-intro-text");
    const parentTag = evidence.role === "event-summary" ? "event info" : "explain";
    return { allowed: true, decision: "allowed-by-registered-rule", parentTag,
      proof: ruleProof(rule, input, parentTag, { mode: rule.id, matchedPath: normalizedPath, ...evidence }) };
  }

  const towerDialog = inspectDgnTowerDialogTextToken(text, offset, length, normalizedPath);
  if (towerDialog.ok) {
    const rule = RULES_BY_ID.get("dgn-tower-dialog-visible-message");
    return {
      allowed: true,
      decision: "allowed-by-registered-rule",
      parentTag: rule.parentTag,
      proof: ruleProof(rule, input, rule.parentTag, {
        mode: rule.id,
        floor: towerDialog.floor,
        event: towerDialog.event,
        tokenOwnLine: towerDialog.tokenOwnLine,
      }),
    };
  }

  const qstConditionDataProgress = inspectQstConditionDataProgressTextToken(text, offset, length, normalizedPath);
  if (qstConditionDataProgress.ok) {
    const rule = RULES_BY_ID.get("qst-condition-data-progress-message");
    return {
      allowed: true,
      decision: "allowed-by-registered-rule",
      parentTag: rule.parentTag,
      proof: ruleProof(rule, input, rule.parentTag, {
        mode: rule.id,
        conditionDataInteger: qstConditionDataProgress.conditionDataInteger,
        closingTag: qstConditionDataProgress.closingTag,
        tokenOwnLine: qstConditionDataProgress.tokenOwnLine,
        closedContainer: qstConditionDataProgress.closedContainer,
        singleLineToken: qstConditionDataProgress.singleLineToken,
        placeholderOrderPreservedRequired: rule.placeholderOrderPreservedRequired,
      }),
    };
  }

  const directParent = immediateParentTag(text, offset);
  if (directParent) {
    const directRule = RULES_BY_ID.get("direct-visible-text-tag");
    if (directRule.tags.includes(directParent)) {
      return {
        allowed: true,
        decision: "allowed-by-registered-rule",
        parentTag: directParent,
        proof: ruleProof(directRule, input, directParent, { mode: directRule.id }),
      };
    }
    const family = derivedFamilyMatch(directParent, extension);
    if (family) {
      return {
        allowed: true,
        decision: "allowed-by-registered-rule",
        parentTag: directParent,
        proof: ruleProof(family.rule, input, directParent, {
          mode: family.rule.id,
          baseTag: family.baseTag,
          suffix: family.rule.suffix,
          baseRuleId: family.rule.baseRuleId,
        }),
      };
    }
    const pathRule = pathScopedMatch(directParent, normalizedPath);
    if (pathRule) {
      const scalarEvidence = scalarLineEvidence(pathRule, text, offset, length);
      if (!scalarEvidence.ok) return denied(input, directParent, "path-scoped-scalar-line-not-eligible");
      return {
        allowed: true,
        decision: "allowed-by-registered-rule",
        parentTag: directParent,
        proof: ruleProof(pathRule, input, directParent, { mode: pathRule.id, matchedPath: normalizedPath, ...scalarEvidence }),
      };
    }
    return denied(input, directParent, "unregistered-direct-parent-tag");
  }

  const nearestParent = nearestOpenTag(text, offset);
  if (!nearestParent || nearestParent === "tower dialog") {
    return denied(input, nearestParent, nearestParent === "tower dialog" ? "structured-record-not-eligible" : "parent-tag-not-found");
  }
  const family = derivedFamilyMatch(nearestParent, extension);
  if (family) {
    return {
      allowed: true,
      decision: "allowed-by-registered-rule",
      parentTag: nearestParent,
      proof: ruleProof(family.rule, input, nearestParent, {
        mode: family.rule.id,
        baseTag: family.baseTag,
        suffix: family.rule.suffix,
        baseRuleId: family.rule.baseRuleId,
      }),
    };
  }
  const pathRule = pathScopedMatch(nearestParent, normalizedPath);
  if (pathRule) {
    const scalarEvidence = scalarLineEvidence(pathRule, text, offset, length);
    if (!scalarEvidence.ok) return denied(input, nearestParent, "path-scoped-scalar-line-not-eligible");
    return {
      allowed: true,
      decision: "allowed-by-registered-rule",
      parentTag: nearestParent,
      proof: ruleProof(pathRule, input, nearestParent, { mode: pathRule.id, matchedPath: normalizedPath, ...scalarEvidence }),
    };
  }
  return denied(input, nearestParent, "unregistered-open-container");
}

function expectedVerifiedTextEligibilityContract() {
  return {
    schemaVersion: VERIFIED_TEXT_ELIGIBILITY_SCHEMA_VERSION,
    policyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
    runtimeModule: VERIFIED_TEXT_ELIGIBILITY_RUNTIME_PATH,
    policySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
    defaultDecision: VERIFIED_TEXT_ELIGIBILITY_DEFAULT_DECISION,
    permissionExpansionAllowed: false,
    ruleCount: VERIFIED_TEXT_ELIGIBILITY_REGISTRY.rules.length,
    completeBacktickTokenRequired: true,
    stringLinkWriteAllowed: false,
    unknownRuleAllowed: false,
    dryRunAndApplyProofBindingRequired: true,
    protectedFileTypesRemainBlocked: true,
  };
}

function validateVerifiedTextEligibilityContract(contract = {}) {
  const expected = expectedVerifiedTextEligibilityContract();
  const errors = [];
  for (const [field, value] of Object.entries(expected)) {
    if (contract?.[field] !== value) {
      errors.push(`write-policy verifiedTextEligibilityContract.${field} must be ${JSON.stringify(value)}`);
    }
  }
  return { ok: errors.length === 0, errors, expected };
}

function validateRegistryIntegrity() {
  const errors = [];
  const ruleIds = VERIFIED_TEXT_ELIGIBILITY_REGISTRY.rules.map((rule) => rule.id);
  if (new Set(ruleIds).size !== ruleIds.length) errors.push("eligibility rule ids must be unique");
  if (VERIFIED_TEXT_ELIGIBILITY_REGISTRY.defaultDecision !== "blocked") errors.push("default decision must remain blocked");
  if (VERIFIED_TEXT_ELIGIBILITY_REGISTRY.permissionExpansionAllowed !== false) errors.push("permission expansion must remain disabled");
  if (INLINE_TEXT_EXTENSIONS.some((extension) => PROTECTED_EXISTING_TEXT_EXTENSION_SET.has(extension))) {
    errors.push("protected existing text extensions must not be inline-text eligible");
  }
  if (RULES_BY_ID.get("skl-visible-text-ex-variant")?.baseRuleId !== "direct-visible-text-tag") {
    errors.push("derived SKL family must inherit the registered direct visible-text base rule");
  }
  const titlebookSection = RULES_BY_ID.get("titlebook-section-name-visible-text");
  if (titlebookSection?.kind !== "path-scoped-scalar-line" ||
      !titlebookSection.paths?.includes("etc/titlebook.etc") ||
      !titlebookSection.tags?.includes("section name") ||
      titlebookSection.singleLineTokenRequired !== true) {
    errors.push("titlebook section-name must remain an exact path-scoped scalar line rule");
  }
  const qstConditionData = RULES_BY_ID.get("qst-condition-data-progress-message");
  if (qstConditionData?.kind !== "structured-record" ||
      !qstConditionData.extensions?.includes(".qst") ||
      qstConditionData.parentTag !== "condition data" ||
      qstConditionData.closingTag !== "/condition data" ||
      qstConditionData.placeholderOrderPreservedRequired !== true) {
    errors.push("qst condition-data progress text must remain a strict structured record rule");
  }
  return errors;
}

function verifiedTextEligibilitySelfTest(writePolicy = null) {
  const checks = [];
  checks.push(...eventIntroTextSelfTest(classifyVisibleTextOccurrence));
  const registryErrors = validateRegistryIntegrity();
  checks.push({ id: "registry-fail-closed-invariants", ok: registryErrors.length === 0, errors: registryErrors });
  checks.push({
    id: "registry-policy-hash-deterministic",
    ok: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256 === canonicalJsonSha256(VERIFIED_TEXT_ELIGIBILITY_REGISTRY),
  });
  if (writePolicy) {
    const contract = validateVerifiedTextEligibilityContract(writePolicy?.controlledWriteRunner?.verifiedTextEligibilityContract);
    checks.push({ id: "write-policy-eligibility-contract-matches-runtime", ok: contract.ok, errors: contract.errors });
    const tampered = { ...contract.expected, permissionExpansionAllowed: true };
    checks.push({
      id: "write-policy-eligibility-permission-expansion-rejected",
      ok: validateVerifiedTextEligibilityContract(tampered).ok === false,
    });
  }

  const directSource = "[name]\r\n`可見名稱`\r\n";
  const directOffset = directSource.indexOf("`可見名稱`");
  const direct = classifyVisibleTextOccurrence({
    pvfPath: "stackable/fixture.stk",
    sourceText: directSource,
    tokenOffset: directOffset,
    tokenLength: "`可見名稱`".length,
  });
  checks.push({
    id: "direct-visible-tag-classified-with-policy-proof",
    ok: direct.allowed === true && direct.proof?.ruleId === "direct-visible-text-tag" &&
      direct.proof?.policySha256 === VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
  });

  const familySource = "[skill explain ex]\r\n`派生說明`\r\n";
  const familyOffset = familySource.indexOf("`派生說明`");
  const family = classifyVisibleTextOccurrence({
    pvfPath: "skill/swordman/fixture.skl",
    sourceText: familySource,
    tokenOffset: familyOffset,
    tokenLength: "`派生說明`".length,
  });
  const familyOutsideSkl = classifyVisibleTextOccurrence({
    pvfPath: "stackable/fixture.stk",
    sourceText: familySource,
    tokenOffset: familyOffset,
    tokenLength: "`派生說明`".length,
  });
  checks.push({
    id: "derived-skl-family-inherits-known-base-only-in-skl",
    ok: family.allowed === true && family.proof?.ruleId === "skl-visible-text-ex-variant" &&
      family.proof?.baseTag === "skill explain" && familyOutsideSkl.allowed === false,
  });

  const unknownSource = "[logic explain ex]\r\n`未知邏輯文字`\r\n";
  const unknownOffset = unknownSource.indexOf("`未知邏輯文字`");
  const unknown = classifyVisibleTextOccurrence({
    pvfPath: "skill/swordman/fixture.skl",
    sourceText: unknownSource,
    tokenOffset: unknownOffset,
    tokenLength: "`未知邏輯文字`".length,
  });
  checks.push({ id: "unknown-derived-base-remains-blocked", ok: unknown.allowed === false });

  const postalSource = "[send postal]\r\n2660296\t1\r\n`郵件標題`\r\n";
  const postalOffset = postalSource.indexOf("`郵件標題`");
  const postal = classifyVisibleTextOccurrence({
    pvfPath: "etc/titlebook.etc",
    sourceText: postalSource,
    tokenOffset: postalOffset,
    tokenLength: "`郵件標題`".length,
  });
  const postalWrongPath = classifyVisibleTextOccurrence({
    pvfPath: "etc/other.etc",
    sourceText: postalSource,
    tokenOffset: postalOffset,
    tokenLength: "`郵件標題`".length,
  });
  checks.push({
    id: "path-scoped-container-does-not-leak-to-other-paths",
    ok: postal.allowed === true && postal.proof?.ruleId === "titlebook-send-postal-visible-text" && postalWrongPath.allowed === false,
  });

  const titlebookSectionSource = "[section name]\r\n`稱號分類`\r\n";
  const titlebookSectionOffset = titlebookSectionSource.indexOf("`稱號分類`");
  const titlebookSection = classifyVisibleTextOccurrence({
    pvfPath: "etc/titlebook.etc",
    sourceText: titlebookSectionSource,
    tokenOffset: titlebookSectionOffset,
    tokenLength: "`稱號分類`".length,
  });
  const titlebookSectionWrongPath = classifyVisibleTextOccurrence({
    pvfPath: "etc/other.etc",
    sourceText: titlebookSectionSource,
    tokenOffset: titlebookSectionOffset,
    tokenLength: "`稱號分類`".length,
  });
  const titlebookSectionMultiline = classifyVisibleTextOccurrence({
    pvfPath: "etc/titlebook.etc",
    sourceText: "[section name]\r\n`稱號\r\n分類`\r\n",
    tokenOffset: "[section name]\r\n".length,
    tokenLength: "`稱號\r\n分類`".length,
  });
  checks.push({
    id: "titlebook-section-name-is-path-scoped-single-line-only",
    ok:
      titlebookSection.allowed === true &&
      titlebookSection.proof?.ruleId === "titlebook-section-name-visible-text" &&
      titlebookSection.proof?.matchedPath === "etc/titlebook.etc" &&
      titlebookSectionWrongPath.allowed === false &&
      titlebookSectionMultiline.allowed === false,
  });

  const qstProgressSource = "[condition data]\r\n0\r\n`進度 : %d / %d`\r\n[/condition data]\r\n";
  const qstProgressOffset = qstProgressSource.indexOf("`進度 : %d / %d`");
  const qstProgress = classifyVisibleTextOccurrence({
    pvfPath: "n_quest/title/fixture.qst",
    sourceText: qstProgressSource,
    tokenOffset: qstProgressOffset,
    tokenLength: "`進度 : %d / %d`".length,
  });
  const qstProgressWrongExtension = classifyVisibleTextOccurrence({
    pvfPath: "stackable/fixture.stk",
    sourceText: qstProgressSource,
    tokenOffset: qstProgressOffset,
    tokenLength: "`進度 : %d / %d`".length,
  });
  const qstProgressUnclosed = classifyVisibleTextOccurrence({
    pvfPath: "n_quest/title/fixture.qst",
    sourceText: qstProgressSource.replace("[/condition data]", "[next]"),
    tokenOffset: qstProgressOffset,
    tokenLength: "`進度 : %d / %d`".length,
  });
  checks.push({
    id: "qst-condition-data-progress-token-is-structured-and-closed",
    ok:
      qstProgress.allowed === true &&
      qstProgress.proof?.ruleId === "qst-condition-data-progress-message" &&
      qstProgress.proof?.conditionDataInteger === 0 &&
      qstProgress.proof?.closedContainer === true &&
      qstProgressWrongExtension.allowed === false &&
      qstProgressUnclosed.allowed === false,
  });

  const dgnSource = "[tower dialog]\r\n1\r\n`第一層訊息`\r\n`on start`\r\n";
  const messageOffset = dgnSource.indexOf("`第一層訊息`");
  const eventOffset = dgnSource.indexOf("`on start`");
  const dgnMessage = classifyVisibleTextOccurrence({
    pvfPath: "dungeon/tower/fixture.dgn",
    sourceText: dgnSource,
    tokenOffset: messageOffset,
    tokenLength: "`第一層訊息`".length,
  });
  const dgnEvent = classifyVisibleTextOccurrence({
    pvfPath: "dungeon/tower/fixture.dgn",
    sourceText: dgnSource,
    tokenOffset: eventOffset,
    tokenLength: "`on start`".length,
  });
  checks.push({
    id: "structured-dgn-message-allowed-but-event-token-blocked",
    ok: dgnMessage.allowed === true && dgnMessage.proof?.ruleId === "dgn-tower-dialog-visible-message" &&
      dgnMessage.proof?.floor === 1 && dgnMessage.proof?.event === "on start" && dgnEvent.allowed === false,
  });

  const protectedFile = classifyVisibleTextOccurrence({
    pvfPath: "stringtable/fixture.str",
    sourceText: directSource,
    tokenOffset: directOffset,
    tokenLength: "`可見名稱`".length,
  });
  checks.push({ id: "protected-file-type-remains-blocked", ok: protectedFile.allowed === false });
  return checks;
}

const registryErrors = validateRegistryIntegrity();
if (registryErrors.length > 0) {
  throw new Error(`Verified-text eligibility registry is unsafe: ${registryErrors.join("; ")}`);
}

module.exports = {
  ALLOWED_INLINE_TEXT_EXTENSIONS,
  ALLOWED_VISIBLE_TEXT_TAGS,
  VERIFIED_TEXT_ELIGIBILITY_DEFAULT_DECISION,
  VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
  VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
  VERIFIED_TEXT_ELIGIBILITY_REGISTRY,
  VERIFIED_TEXT_ELIGIBILITY_RUNTIME_PATH,
  VERIFIED_TEXT_ELIGIBILITY_SCHEMA_VERSION,
  canonicalJsonSha256,
  classifyVisibleTextOccurrence,
  directBacktickTokenValue,
  expectedVerifiedTextEligibilityContract,
  normalizePvfPath,
  validateVerifiedTextEligibilityContract,
  verifiedTextEligibilitySelfTest,
};
