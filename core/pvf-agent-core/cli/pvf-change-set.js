"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { BackendStdioClient, parseBackendTextResult } = require("../lib/backend-stdio-client");
const { resolveSourcePvf } = require("../lib/workspace-profiles");
const {
  assertReadOnlyAdapter,
  loadAdapterConfig,
  resolveWorkbenchRoot,
  upstreamLaunchOptions,
} = require("../lib/adapter-config");
const { runtimePath } = require("../lib/runtime-state");
const { sha256File } = require("../lib/release-utils");
const {
  semanticWriteSafety,
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  isVerifiedInlineTextMode,
} = require("../lib/semantic-read-guard");
const {
  verifiedInlineTextSelfTest,
} = require("../../../tools/pvf-bridge/verified-inline-cn-text");

const rawArgs = process.argv.slice(2);
const workbenchRoot = resolveWorkbenchRoot(rawArgs, path.resolve(__dirname, "../../.."));
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0];

function usage() {
  return `Usage:
  workbench.bat pvf-change validate --file <change-set.json>
  workbench.bat pvf-change self-test
  workbench.bat pvf-change dry-run --file <change-set.json> [--profile <name> | --pvf <override Script.pvf>] [--out <directory>]
  workbench.bat pvf-change apply --file <change-set.json> [--profile <name> | --pvf <override Script.pvf>] --dry-run-manifest <DRY-RUN-MANIFEST.json> --authorize-apply <approval-code> (--out <directory> | --output-pvf <Script.pvf>)
`;
}

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function requireOption(name) {
  const value = option(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function outputPvfIdentity(file) {
  const resolved = path.resolve(file);
  return {
    sha256: sha256File(resolved),
    bytes: fs.statSync(resolved).size,
  };
}

function pvfTokens(value) {
  return String(value || "").match(/`[^`]*`|\[[^\]\r\n]*\]|#[^\r\n]*|[^\s]+/g) || [];
}

function normalizePvfToken(token) {
  const value = String(token);
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) {
    const float32 = Math.fround(Number(value));
    return `float32:${Object.is(float32, -0) ? 0 : float32}`;
  }
  return `exact:${value}`;
}

function comparePvfTextReadback(sourceText, readbackText) {
  const sourceRaw = String(sourceText || "");
  const actualRaw = String(readbackText || "");
  const source = pvfTokens(sourceRaw);
  const actual = pvfTokens(actualRaw);
  const expectedNormalized = source.map(normalizePvfToken);
  const actualNormalized = actual.map(normalizePvfToken);
  const mismatches = [];
  const count = Math.max(source.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    const sourceToken = source[index];
    const actualToken = actual[index];
    const expectedToken = sourceToken === undefined ? undefined : normalizePvfToken(sourceToken);
    const readbackToken = actualToken === undefined ? undefined : normalizePvfToken(actualToken);
    if (expectedToken !== readbackToken) {
      mismatches.push({ index, sourceToken, actualToken, reason: "token-mismatch" });
    }
  }
  const exactTextOk = sourceRaw === actualRaw;
  const tokenEquivalent = mismatches.length === 0;
  return {
    ok: exactTextOk || tokenEquivalent,
    exactTextOk,
    layoutNormalizationAccepted: !exactTextOk && tokenEquivalent,
    comparison: exactTextOk
      ? "exact-text-sha256"
      : (tokenEquivalent ? "normalized-pvf-token-sha256" : "normalized-pvf-token-mismatch"),
    expectedTextSha256: sha256(sourceRaw),
    actualTextSha256: sha256(actualRaw),
    expectedTokenSha256: sha256(expectedNormalized.join("\n")),
    actualTokenSha256: sha256(actualNormalized.join("\n")),
    sourceTokenCount: source.length,
    readbackTokenCount: actual.length,
    mismatches: mismatches.slice(0, 20),
  };
}

function pvfTextReadbackResult(expectedText, readbackText) {
  if (typeof readbackText !== "string") {
    return {
      comparison: "missing-text-readback",
      ok: false,
      exactTextOk: false,
      layoutNormalizationAccepted: false,
      expectedSha256: sha256(String(expectedText || "")),
      actualSha256: null,
      expectedTokenSha256: null,
      actualTokenSha256: null,
      sourceTokenCount: pvfTokens(expectedText).length,
      readbackTokenCount: 0,
      mismatches: [{ index: 0, sourceToken: null, actualToken: null, reason: "missing-text-readback" }],
    };
  }
  const comparison = comparePvfTextReadback(expectedText, readbackText);
  return {
    comparison: comparison.comparison,
    ok: comparison.ok,
    exactTextOk: comparison.exactTextOk,
    layoutNormalizationAccepted: comparison.layoutNormalizationAccepted,
    expectedSha256: comparison.expectedTextSha256,
    actualSha256: comparison.actualTextSha256,
    expectedTokenSha256: comparison.expectedTokenSha256,
    actualTokenSha256: comparison.actualTokenSha256,
    sourceTokenCount: comparison.sourceTokenCount,
    readbackTokenCount: comparison.readbackTokenCount,
    mismatches: comparison.mismatches,
  };
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function normalizePvfPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function dryRunBinding(results, sourcePvf, sourcePvfSha256, changeSetFile, changeSetFileSha256) {
  const payload = {
    schemaVersion: "1.0",
    sourcePvf: path.resolve(sourcePvf),
    sourcePvfSha256,
    changeSetFile: path.resolve(changeSetFile),
    changeSetFileSha256,
    changes: results.map((item) => ({
      id: item.id,
      type: item.type,
      pvfPath: item.pvfPath,
      applicable: item.applicable,
      changed: item.changed,
      afterSha256: item.diff?.afterSha256 || item.sourceSha256 || null,
      textWriteMode: item.textWriteMode || null,
      pvfEncoding: item.pvfEncoding || null,
      encodingRoundTripProbeSha256: item.encodingRoundTripProbe
        ? sha256(JSON.stringify(item.encodingRoundTripProbe))
        : null,
    })),
  };
  const bindingSha256 = sha256(JSON.stringify(payload));
  return {
    ...payload,
    bindingSha256,
    approvalCode: `APPLY-${bindingSha256.toUpperCase()}`,
  };
}

function verifyDryRunAuthorization(sourcePvf, changeSetFile, explicit = {}) {
  const manifestFile = path.resolve(explicit.manifestFile || requireOption("--dry-run-manifest"));
  const authorizationCode = explicit.authorizationCode || requireOption("--authorize-apply");
  if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) {
    throw new Error(`Dry-run manifest does not exist: ${manifestFile}`);
  }
  const manifest = readJson(manifestFile);
  if (manifest.phase !== "phase-3-dry-run-change-set" || manifest.mode !== "dry-run-only") {
    throw new Error("Apply requires a phase-3 dry-run manifest.");
  }
  if (manifest.writeOperationsExecuted !== false || Number(manifest.summary?.blockedCount) !== 0) {
    throw new Error("Dry-run manifest is blocked or does not prove that no persistent output was written.");
  }
  const binding = manifest.binding;
  if (!binding || binding.schemaVersion !== "1.0" || !binding.bindingSha256 || !binding.approvalCode) {
    throw new Error("Dry-run manifest does not contain a valid apply binding.");
  }
  for (const result of manifest.results || []) {
    if (!isVerifiedInlineTextMode(result.textWriteMode) || result.changed !== true) continue;
    const probe = result.encodingRoundTripProbe;
    if (
      manifest.persistentWriteOperationsExecuted !== false ||
      manifest.temporaryVerificationWriteOperationsExecuted !== true ||
      probe?.ok !== true ||
      String(probe?.sourcePvfSha256 || "").toLowerCase() !== String(binding.sourcePvfSha256 || "").toLowerCase() ||
      probe?.sourceUnchanged !== true ||
      probe?.independentSemanticRead !== true ||
      probe?.semanticReadGuard?.reason !== "verified-text-readback" ||
      probe?.semanticReadGuard?.backend !== "typescript-readonly-fallback" ||
      probe?.comparison?.exactTextOk !== true ||
      !isVerifiedInlineTextMode(probe?.writerProof?.mode) ||
      probe?.writerProof?.encoding !== result.pvfEncoding ||
      probe?.writerProof?.existingStringEntriesPreserved !== true ||
      !/^[a-f0-9]{64}$/i.test(String(probe?.temporaryOutputSha256 || "")) ||
      probe?.temporaryOutputRetained !== false
    ) {
      const error = new Error(`中文文本改动 ${result.id} 缺少成功且完整的临时写出复查证据；请重新预演。`);
      error.code = "CN_TEXT_ROUNDTRIP_REQUIRED";
      throw error;
    }
  }
  if (!samePath(binding.sourcePvf, sourcePvf)) {
    throw new Error("Dry-run source PVF does not match the apply source PVF.");
  }
  const currentSourceSha256 = sha256File(sourcePvf);
  if (String(binding.sourcePvfSha256).toLowerCase() !== currentSourceSha256.toLowerCase()) {
    throw new Error("Source PVF changed after dry-run; run dry-run again.");
  }
  const currentChangeSetSha256 = sha256File(changeSetFile);
  if (String(binding.changeSetFileSha256).toLowerCase() !== currentChangeSetSha256.toLowerCase()) {
    throw new Error("Change-set changed after dry-run; run dry-run again.");
  }
  const expectedBinding = dryRunBinding(
    manifest.results || [],
    sourcePvf,
    currentSourceSha256,
    changeSetFile,
    currentChangeSetSha256,
  );
  if (expectedBinding.bindingSha256 !== binding.bindingSha256 || expectedBinding.approvalCode !== binding.approvalCode) {
    throw new Error("Dry-run binding is invalid or was edited.");
  }
  if (authorizationCode !== binding.approvalCode) {
    throw new Error("Explicit apply authorization code does not match the dry-run manifest.");
  }
  return {
    manifestFile,
    manifest,
    binding,
    sourcePvfSha256: currentSourceSha256,
    changeSetFileSha256: currentChangeSetSha256,
  };
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function changeSetAuthorizationSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-change-binding-"));
  const checks = [];
  try {
    const sourcePvf = path.join(tempRoot, "Script.pvf");
    const changeSetFile = path.join(tempRoot, "change-set.json");
    const manifestFile = path.join(tempRoot, "DRY-RUN-MANIFEST.json");
    fs.writeFileSync(sourcePvf, "pvf-fixture-v1", "utf8");
    fs.writeFileSync(changeSetFile, '{"fixture":true}\n', "utf8");
    const results = [{
      id: "fixture-change",
      type: "replace-text",
      pvfPath: "skill/fixture.skl",
      applicable: true,
      changed: true,
      diff: { afterSha256: sha256("after") },
    }];
    const binding = dryRunBinding(results, sourcePvf, sha256File(sourcePvf), changeSetFile, sha256File(changeSetFile));
    fs.writeFileSync(manifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: false,
      summary: { blockedCount: 0 },
      binding,
      results,
    }, null, 2)}\n`, "utf8");

    const verified = verifyDryRunAuthorization(sourcePvf, changeSetFile, {
      manifestFile,
      authorizationCode: binding.approvalCode,
    });
    checks.push({ id: "matching-binding-accepted", ok: verified.binding.bindingSha256 === binding.bindingSha256 });

    let wrongCodeRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, { manifestFile, authorizationCode: "APPLY-WRONG" });
    } catch (error) {
      wrongCodeRejected = /authorization code does not match/.test(String(error.message));
    }
    checks.push({ id: "wrong-authorization-rejected", ok: wrongCodeRejected });

    const verifiedManifestFile = path.join(tempRoot, "DRY-RUN-VERIFIED-TEXT-MANIFEST.json");
    const verifiedResults = [{
      id: "verified-text-fixture",
      type: "replace-text",
      pvfPath: "stackable/fixture.stk",
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfEncoding: "Tw",
      applicable: true,
      changed: true,
      diff: { afterSha256: sha256("verified-text-after") },
    }];
    let verifiedBinding = dryRunBinding(verifiedResults, sourcePvf, sha256File(sourcePvf), changeSetFile, sha256File(changeSetFile));
    fs.writeFileSync(verifiedManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      binding: verifiedBinding,
      results: verifiedResults,
    }, null, 2)}\n`, "utf8");
    let missingVerifiedProbeRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, {
        manifestFile: verifiedManifestFile,
        authorizationCode: verifiedBinding.approvalCode,
      });
    } catch (error) {
      missingVerifiedProbeRejected = error.code === "CN_TEXT_ROUNDTRIP_REQUIRED";
    }
    checks.push({ id: "verified-inline-text-missing-roundtrip-rejected", ok: missingVerifiedProbeRejected });

    verifiedResults[0].encodingRoundTripProbe = {
      ok: true,
      sourceUnchanged: true,
      sourcePvfSha256: sha256File(sourcePvf),
      independentSemanticRead: true,
      semanticReadGuard: { reason: "verified-text-readback", backend: "typescript-readonly-fallback" },
      comparison: { exactTextOk: true },
      writerProof: { mode: VERIFIED_INLINE_TEXT_MODE, encoding: "Tw", existingStringEntriesPreserved: true },
      temporaryOutputSha256: sha256("temporary-output"),
      temporaryOutputRetained: false,
    };
    verifiedBinding = dryRunBinding(verifiedResults, sourcePvf, sha256File(sourcePvf), changeSetFile, sha256File(changeSetFile));
    fs.writeFileSync(verifiedManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      binding: verifiedBinding,
      results: verifiedResults,
    }, null, 2)}\n`, "utf8");
    const verifiedProbeAccepted = verifyDryRunAuthorization(sourcePvf, changeSetFile, {
      manifestFile: verifiedManifestFile,
      authorizationCode: verifiedBinding.approvalCode,
    });
    checks.push({
      id: "verified-inline-text-complete-roundtrip-accepted",
      ok: verifiedProbeAccepted.binding.bindingSha256 === verifiedBinding.bindingSha256,
    });

    fs.writeFileSync(sourcePvf, "pvf-fixture-v2", "utf8");
    let changedSourceRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, { manifestFile, authorizationCode: binding.approvalCode });
    } catch (error) {
      changedSourceRejected = /Source PVF changed after dry-run/.test(String(error.message));
    }
    checks.push({ id: "changed-source-rejected", ok: changedSourceRejected });
    fs.writeFileSync(sourcePvf, "pvf-fixture-v1", "utf8");

    fs.writeFileSync(changeSetFile, '{"fixture":false}\n', "utf8");
    let changedChangeSetRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, { manifestFile, authorizationCode: binding.approvalCode });
    } catch (error) {
      changedChangeSetRejected = /Change-set changed after dry-run/.test(String(error.message));
    }
    checks.push({ id: "changed-change-set-rejected", ok: changedChangeSetRejected });

    const blockedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    blockedManifest.summary.blockedCount = 1;
    fs.writeFileSync(manifestFile, `${JSON.stringify(blockedManifest, null, 2)}\n`, "utf8");
    let blockedRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, { manifestFile, authorizationCode: binding.approvalCode });
    } catch (error) {
      blockedRejected = /manifest is blocked/.test(String(error.message));
    }
    checks.push({ id: "blocked-dry-run-rejected", ok: blockedRejected });

    const outputIdentity = outputPvfIdentity(sourcePvf);
    checks.push({
      id: "final-output-sha256-and-size-bound",
      ok:
        outputIdentity.sha256 === sha256File(sourcePvf) &&
        outputIdentity.bytes === fs.statSync(sourcePvf).size &&
        /^[a-f0-9]{64}$/.test(outputIdentity.sha256),
    });

    const exactComparison = comparePvfTextReadback(
      "[equipment]\r\n100\t0\t0\t\r\n[/equipment]\r\n",
      "[equipment]\r\n100\t0\t0\t\r\n[/equipment]\r\n",
    );
    checks.push({
      id: "exact-text-readback-accepted",
      ok: exactComparison.ok && exactComparison.exactTextOk && !exactComparison.layoutNormalizationAccepted,
    });

    const uiLayoutComparison = comparePvfTextReadback(
      "#PVF_File\r\n\r\n[ui controls]\r\n`[balloon]`\r\n`IDC_FIXTURE_1`\r\n[/ui controls]\r\n\r\n\r\n[ui controls]\r\n`[balloon]`\r\n`IDC_FIXTURE_2`\r\n[/ui controls]\r\n",
      "#PVF_File\r\n\r\n[ui controls]\r\n`[balloon]`\r\n`IDC_FIXTURE_1`\r\n[/ui controls]\r\n\r\n[ui controls]\r\n`[balloon]`\r\n`IDC_FIXTURE_2`\r\n[/ui controls]\r\n",
    );
    checks.push({
      id: "ui-blank-line-normalization-accepted",
      ok: uiLayoutComparison.ok && !uiLayoutComparison.exactTextOk && uiLayoutComparison.layoutNormalizationAccepted,
    });

    const aicLayoutComparison = comparePvfTextReadback(
      "[equipment]\r\n100\t0\t0\t\r\n400\t0\t0\t\r\n[/equipment]\r\n",
      "[equipment]\r\n100\t0\t0\t400\t0\t0\t\r\n[/equipment]\r\n",
    );
    checks.push({
      id: "aic-data-row-normalization-accepted",
      ok: aicLayoutComparison.ok && !aicLayoutComparison.exactTextOk && aicLayoutComparison.layoutNormalizationAccepted,
    });

    const float32Comparison = comparePvfTextReadback(
      "[rate]\r\n0.2\t\r\n",
      "[rate]\r\n0.20000000298023224\t\r\n",
    );
    checks.push({
      id: "float32-readback-normalization-accepted",
      ok: float32Comparison.ok && float32Comparison.layoutNormalizationAccepted,
    });

    const changedNumber = comparePvfTextReadback(
      "[equipment]\r\n400330094\t0\t0\t\r\n[/equipment]\r\n",
      "[equipment]\r\n400330095\t0\t0\t\r\n[/equipment]\r\n",
    );
    checks.push({ id: "changed-number-readback-rejected", ok: !changedNumber.ok && changedNumber.mismatches.length === 1 });

    const changedStringCase = comparePvfTextReadback("[name]\r\n`Fixture Name`\r\n", "[name]\r\n`fixture Name`\r\n");
    checks.push({ id: "changed-string-case-readback-rejected", ok: !changedStringCase.ok });

    const changedStringWhitespace = comparePvfTextReadback("[name]\r\n`Fixture Name`\r\n", "[name]\r\n`Fixture  Name`\r\n");
    checks.push({ id: "changed-string-whitespace-readback-rejected", ok: !changedStringWhitespace.ok });

    const changedTag = comparePvfTextReadback("[equipment]\r\n100\t0\t0\t\r\n[/equipment]\r\n", "[quick item]\r\n100\t0\t0\t\r\n[/quick item]\r\n");
    checks.push({ id: "changed-tag-readback-rejected", ok: !changedTag.ok });

    const cnStrSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "itemshop/itemshop.kor.str",
      pvfEncoding: "Cn",
      previousText: "1",
      newText: "2",
      sourceText: "message_1>中文",
    });
    checks.push({
      id: "cn-str-write-blocked",
      ok: !cnStrSafety.allowed && cnStrSafety.code === "CN_LOCALIZATION_WRITE_UNVERIFIED",
    });

    const noOpCnStrSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "itemshop/itemshop.kor.str",
      pvfEncoding: "Cn",
      previousText: "message_1>",
      newText: "message_1>",
      sourceText: "message_1>中文",
    });
    checks.push({
      id: "no-op-cn-str-requires-no-write",
      ok: noOpCnStrSafety.allowed && noOpCnStrSafety.noOp === true,
    });

    const directChineseSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "itemshop/birken.shp",
      pvfEncoding: "Cn",
      previousText: "`旧文本`",
      newText: "`新文本`",
      sourceText: "[name]\r\n`旧文本`\r\n",
    });
    checks.push({
      id: "unverified-direct-non-ascii-write-blocked",
      ok: !directChineseSafety.allowed && directChineseSafety.code === "NON_ASCII_TEXT_WRITE_UNVERIFIED",
    });

    const htmlEntitySafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "stackable/fixture.stk",
      pvfEncoding: "Cn",
      previousText: "`旧文本`",
      newText: "`&#20320;好`",
      sourceText: "[name]\r\n`旧文本`\r\n",
      replaceAll: false,
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    });
    checks.push({
      id: "html-numeric-entity-write-blocked",
      ok: !htmlEntitySafety.allowed && htmlEntitySafety.code === "HTML_NUMERIC_ENTITY_WRITE_BLOCKED",
    });

    const verifiedChineseSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "stackable/fixture.stk",
      pvfEncoding: "Cn",
      previousText: "`旧描述`",
      newText: "`新描述测试`",
      sourceText: "[name]\r\n`旧描述`\r\n",
      replaceAll: false,
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    });
    checks.push({
      id: "verified-inline-text-structure-accepted",
      ok:
        verifiedChineseSafety.allowed === true &&
        verifiedChineseSafety.verifiedInlineTextWrite?.mode === VERIFIED_INLINE_TEXT_MODE &&
        verifiedChineseSafety.verifiedInlineTextWrite?.encoding === "Cn" &&
        verifiedChineseSafety.verifiedInlineTextWrite?.requiresEncodingRoundTripProbe === true &&
        verifiedChineseSafety.clientTextSmokeCheckRequired === true,
    });

    const inlineWriterSelfTest = verifiedInlineTextSelfTest();
    for (const check of inlineWriterSelfTest.checks) {
      checks.push({ ...check, id: `verified-inline-text-${check.id}` });
    }

    const numericStringLinkSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "itemshop/birken.shp",
      pvfEncoding: "Cn",
      previousText: "9990001",
      newText: "9990002",
      sourceText: "[message]\r\n<5::message_520`中文`>\r\n",
    });
    checks.push({
      id: "numeric-stringlink-change-allowed-with-smoke-check",
      ok: numericStringLinkSafety.allowed && numericStringLinkSafety.clientTextSmokeCheckRequired,
    });
  } finally {
    if (!pathInside(os.tmpdir(), tempRoot)) throw new Error(`Unsafe change-set self-test path: ${tempRoot}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return {
    schemaVersion: "1.0",
    phase: "pvf-change-authorization-self-test",
    summary: {
      ok: checks.every((check) => check.ok),
      checkCount: checks.length,
      failedChecks: checks.filter((check) => !check.ok).length,
    },
    checks,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadWritePolicy() {
  return readJson(path.join(workbenchRoot, "config", "write-policy.json"));
}

function assertControlledWriteRunnerPolicy(writePolicy) {
  const permissionModel = writePolicy.permissionModel || {};
  const runner = writePolicy.controlledWriteRunner || {};
  if (permissionModel.hostExposedWriteToolsEnabled !== false || writePolicy.publicWriteToolsEnabled !== false) {
    throw new Error("Public write tools must remain disabled; only the controlled write runner may write.");
  }
  if (permissionModel.sourceOverwriteAllowed !== false || runner.sourceOverwriteAllowed !== false) {
    throw new Error("Controlled write runner must not allow source PVF overwrite.");
  }
  if (permissionModel.clientWriteAllowed !== false || runner.clientWriteAllowed !== false) {
    throw new Error("Controlled write runner must not allow client resource writes.");
  }
  if (runner.requiresDryRunFirst !== true || runner.requiresMatchingDryRunManifest !== true || runner.requiresExplicitAuthorizationCode !== true) {
    throw new Error("Controlled write runner must require a matching dry-run manifest and explicit authorization code.");
  }
  if (
    runner.serverCapability?.environmentVariable !== "PVF_WORKBENCH_SERVER_MODE" ||
    runner.serverCapability?.value !== "controlled-write"
  ) {
    throw new Error("Controlled write runner must activate the dedicated controlled-write server capability.");
  }
  const semanticSafety = runner.semanticTextSafety || {};
  if (
    semanticSafety.automaticEncodingConflictGuardRequired !== true ||
    semanticSafety.cnStrWriteAllowed !== false ||
    semanticSafety.unverifiedDirectNonAsciiTextWriteAllowed !== false ||
    semanticSafety.verifiedInlineTextWriteAllowed !== true ||
    semanticSafety.verifiedInlineTextAppliedBeforeOtherWrites !== true ||
    semanticSafety.stringLinkTextWriteAllowed !== false ||
    semanticSafety.cnAndTwRoundTripProbeRequired !== true ||
    semanticSafety.numericOrAsciiMinimalWriteAllowed !== true ||
    semanticSafety.clientTextSmokeCheckRequired !== true
  ) {
    throw new Error("Controlled write runner semantic text safety policy is incomplete or unsafe.");
  }
  const allowedBridgeTools = new Set(runner.allowedBridgeTools || []);
  for (const tool of ["pvf_open", "pvf_list_files", "pvf_read_file", "pvf_replace_text", "pvf_write_file", "pvf_backup", "pvf_save", "pvf_close"]) {
    if (!allowedBridgeTools.has(tool)) {
      throw new Error(`controlledWriteRunner.allowedBridgeTools is missing required tool: ${tool}`);
    }
  }
}

function controlledWriteLaunchOptions(adapterConfig, writePolicy) {
  const launch = upstreamLaunchOptions(adapterConfig);
  const capability = writePolicy.controlledWriteRunner.serverCapability;
  return {
    ...launch,
    env: {
      ...(launch.env || {}),
      [capability.environmentVariable]: capability.value,
    },
  };
}

function validateChangeSet(changeSet) {
  const errors = [];
  if (changeSet.schemaVersion !== "1.0") {
    errors.push("schemaVersion must be 1.0.");
  }
  if (changeSet.mode !== "dry-run-only") {
    errors.push("mode must be dry-run-only.");
  }
  if (!changeSet.target || typeof changeSet.target.sourcePvf !== "string" || !changeSet.target.sourcePvf.trim()) {
    errors.push("target.sourcePvf is required.");
  }
  if (!Array.isArray(changeSet.changes) || changeSet.changes.length === 0) {
    errors.push("changes must contain at least one entry.");
  }
  if (changeSet.safety?.writeModeEnabled !== false) {
    errors.push("safety.writeModeEnabled must be false.");
  }
  if (changeSet.safety?.requiresBackupBeforeApply !== true) {
    errors.push("safety.requiresBackupBeforeApply must be true.");
  }
  if (changeSet.safety?.requiresExplicitOutputPath !== true) {
    errors.push("safety.requiresExplicitOutputPath must be true.");
  }
  if (changeSet.safety?.requiresReadback !== true) {
    errors.push("safety.requiresReadback must be true.");
  }

  const ids = new Set();
  const targetPaths = new Set();
  for (const [index, change] of (changeSet.changes || []).entries()) {
    const prefix = `changes[${index}]`;
    if (!change.id || !/^[A-Za-z0-9._-]+$/.test(change.id)) {
      errors.push(`${prefix}.id is required and must be stable ASCII.`);
    } else if (ids.has(change.id)) {
      errors.push(`Duplicate change id: ${change.id}`);
    }
    ids.add(change.id);
    if (!change.pvfPath) {
      errors.push(`${prefix}.pvfPath is required.`);
    } else {
      const normalizedTarget = normalizePvfPath(change.pvfPath).toLowerCase();
      if (targetPaths.has(normalizedTarget)) {
        errors.push(`Duplicate target PVF path: ${change.pvfPath}`);
      }
      targetPaths.add(normalizedTarget);
    }
    if (change.type === "replace-text") {
      if (typeof change.previousText !== "string" || change.previousText.length === 0) {
        errors.push(`${prefix}.previousText is required.`);
      }
      if (typeof change.newText !== "string") {
        errors.push(`${prefix}.newText must be a string.`);
      }
      if (/&#(?:\d+|x[0-9a-f]+);/i.test(change.newText)) {
        errors.push(`${prefix}.newText must not contain HTML numeric entities; use real characters from raw/no-simplified target readback.`);
      }
      if (change.replaceAll !== undefined && typeof change.replaceAll !== "boolean") {
        errors.push(`${prefix}.replaceAll must be boolean when present.`);
      }
      if (change.textWriteMode !== undefined && !isVerifiedInlineTextMode(change.textWriteMode)) {
        errors.push(`${prefix}.textWriteMode must be ${VERIFIED_INLINE_TEXT_MODE} (legacy ${VERIFIED_INLINE_CN_TEXT_MODE} is also accepted) when present.`);
      }
    } else if (change.type === "write-file") {
      if (typeof change.sourceFile !== "string" || !change.sourceFile.trim()) {
        errors.push(`${prefix}.sourceFile is required.`);
      }
      if (typeof change.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(change.sourceSha256)) {
        errors.push(`${prefix}.sourceSha256 must be a SHA256 hex string.`);
      }
      if (change.expectAbsent !== true) {
        errors.push(`${prefix}.expectAbsent must be true; controlled write-file cannot overwrite an existing PVF path.`);
      }
      if (change.compileScript !== undefined && typeof change.compileScript !== "boolean") {
        errors.push(`${prefix}.compileScript must be boolean when present.`);
      }
      if (change.compileBinaryAni !== undefined && typeof change.compileBinaryAni !== "boolean") {
        errors.push(`${prefix}.compileBinaryAni must be boolean when present.`);
      }
    } else {
      errors.push(`${prefix}.type must be replace-text or write-file.`);
    }
  }
  return errors;
}

function resolveChangeSourceFile(changeSetFile, sourceFile) {
  return path.isAbsolute(sourceFile)
    ? path.resolve(sourceFile)
    : path.resolve(path.dirname(changeSetFile), sourceFile);
}

function readVerifiedSourceFile(changeSetFile, change) {
  const sourceFile = resolveChangeSourceFile(changeSetFile, change.sourceFile);
  if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
    throw new Error(`write-file source does not exist: ${sourceFile}`);
  }
  const raw = fs.readFileSync(sourceFile);
  const actualSha256 = sha256(raw);
  if (actualSha256.toLowerCase() !== change.sourceSha256.toLowerCase()) {
    throw new Error(`write-file source hash mismatch: ${sourceFile}`);
  }
  const textContent = raw.toString("utf8").replace(/^\uFEFF/, "");
  return { sourceFile, raw, textContent, actualSha256 };
}

async function pvfPathExists(client, sessionId, pvfPath, directoryCache) {
  const slash = pvfPath.lastIndexOf("/");
  const directoryPrefix = slash >= 0 ? pvfPath.slice(0, slash + 1).toLowerCase() : "";
  if (!directoryCache.has(directoryPrefix)) {
    const listed = await callAndParse(client, "pvf_list_files", {
      sessionId,
      prefix: directoryPrefix,
      limit: 2000,
    });
    const names = new Set((listed.items || []).map((item) => normalizePvfPath(item.fileName).toLowerCase()));
    directoryCache.set(directoryPrefix, {
      complete: Number(listed.matchedCount || 0) <= Number(listed.returnedCount || 0),
      names,
    });
  }
  const cached = directoryCache.get(directoryPrefix);
  if (cached.complete) {
    return cached.names.has(pvfPath.toLowerCase());
  }
  const exact = await callAndParse(client, "pvf_list_files", {
    sessionId,
    prefix: pvfPath,
    limit: 2000,
  });
  return (exact.items || []).some((item) => normalizePvfPath(item.fileName).toLowerCase() === pvfPath.toLowerCase());
}

function countOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found < 0) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function replaceText(text, previousText, newText, replaceAll) {
  if (replaceAll) {
    return text.split(previousText).join(newText);
  }
  return text.replace(previousText, newText);
}

function rawTextOptions(changeSet, change, adapterConfig) {
  return {
    pvfEncoding: change?.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
    // Change-set writes must operate on source text, not simplified display text.
    // Simplified display text can be serialized back as HTML numeric entities in TW PVFs.
    convertToSimplifiedChinese: false,
  };
}

function diffSummary(before, after) {
  if (before === after) {
    return {
      changed: false,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      beforeLength: before.length,
      afterLength: after.length,
    };
  }
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) {
    start += 1;
  }
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const context = 160;
  return {
    changed: true,
    beforeSha256: sha256(before),
    afterSha256: sha256(after),
    beforeLength: before.length,
    afterLength: after.length,
    firstDifferenceOffset: start,
    beforeSnippet: before.slice(Math.max(0, start - context), Math.min(before.length, beforeEnd + 1 + context)),
    afterSnippet: after.slice(Math.max(0, start - context), Math.min(after.length, afterEnd + 1 + context)),
  };
}

async function callAndParse(client, name, toolArgs) {
  const result = await client.callTool(name, toolArgs);
  if (result && result.isError) {
    const parsed = parseBackendTextResult(result);
    const error = new Error(parsed.error || parsed.text || JSON.stringify(parsed));
    if (parsed?.data?.code) error.code = parsed.data.code;
    throw error;
  }
  return parseBackendTextResult(result);
}

async function runVerifiedInlineTextRoundTripProbe({
  sourcePvf,
  changeSet,
  adapterConfig,
  writePolicy,
  probes,
}) {
  const outcomes = new Map();
  if (!Array.isArray(probes) || probes.length === 0) return outcomes;
  const probeBase = runtimePath(workbenchRoot, "text-write-probes");
  const probeRoot = path.join(probeBase, `${timestamp()}-${crypto.randomUUID()}`);
  const outputPvf = path.join(probeRoot, "Script.pvf");
  fs.mkdirSync(probeRoot, { recursive: true });
  const sourceSha256Before = sha256File(sourcePvf);
  const client = new BackendStdioClient(controlledWriteLaunchOptions(adapterConfig, writePolicy));
  let sourceSessionId = null;
  let outputSessionId = null;
  try {
    const opened = await callAndParse(client, "pvf_open", {
      path: sourcePvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    sourceSessionId = opened.session?.sessionId;
    if (!sourceSessionId) throw new Error("Chinese text probe pvf_open did not return a sessionId.");
    if (opened.session?.readOnly === true) {
      const error = new Error("中文文本往返验证需要 native 写入环境；当前只能读取。");
      error.code = "READ_ONLY_FALLBACK";
      throw error;
    }
    for (const probe of probes) {
      const probeEncoding = probe.change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const applied = await callAndParse(client, "pvf_replace_text", {
        sessionId: sourceSessionId,
        pvfPath: probe.pvfPath,
        previousText: probe.change.previousText,
        newText: probe.change.newText,
        replaceAll: false,
        dryRun: false,
        pvfEncoding: probeEncoding,
        convertToSimplifiedChinese: false,
        convertToTraditionalChinese: false,
        textWriteMode: probe.change.textWriteMode,
      });
      outcomes.set(probe.change.id, {
        ok: false,
        code: "CN_TEXT_ROUNDTRIP_INCOMPLETE",
        reason: "中文文本临时写出尚未完成独立读回。",
        writerProof: applied.writeResult?.proof || null,
        temporaryOutputRetained: false,
      });
    }
    await callAndParse(client, "pvf_save", {
      sessionId: sourceSessionId,
      targetPath: outputPvf,
      allowOverwriteSource: false,
    });
    await callAndParse(client, "pvf_close", { sessionId: sourceSessionId });
    sourceSessionId = null;

    const reopened = await callAndParse(client, "pvf_open", {
      path: outputPvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    outputSessionId = reopened.session?.sessionId;
    if (!outputSessionId) throw new Error("Chinese text probe readback pvf_open did not return a sessionId.");
    for (const probe of probes) {
      const probeEncoding = probe.change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const readback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: probe.pvfPath,
        pvfEncoding: probeEncoding,
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
        maxChars: 0,
      });
      const comparison = pvfTextReadbackResult(probe.expectedAfter, readback.textContent);
      const independentSemanticRead =
        readback.semanticReadGuard?.applied === true &&
        readback.semanticReadGuard?.reason === "verified-text-readback" &&
        readback.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
        readback.semanticReadGuard?.selectedEncoding === probeEncoding;
      const writerProof = outcomes.get(probe.change.id)?.writerProof || null;
      const sourceUnchanged = sha256File(sourcePvf) === sourceSha256Before;
      const ok =
        comparison.ok === true &&
        comparison.exactTextOk === true &&
        independentSemanticRead &&
        writerProof?.encoding === probeEncoding &&
        writerProof?.existingStringEntriesPreserved === true &&
        sourceUnchanged;
      outcomes.set(probe.change.id, {
        ok,
        code: ok ? null : "CN_TEXT_ROUNDTRIP_FAILED",
        reason: ok
          ? "中文文本已通过临时输出、独立解析和既有字符串保持检查。"
          : "中文文本未通过临时输出的精确往返检查，已阻止生成批准码。",
        sourceUnchanged,
        sourcePvfSha256: sourceSha256Before,
        independentSemanticRead,
        semanticReadGuard: readback.semanticReadGuard || null,
        comparison,
        writerProof,
        temporaryOutputSha256: sha256File(outputPvf),
        temporaryOutputRetained: false,
      });
    }
  } catch (error) {
    for (const probe of probes) {
      const existing = outcomes.get(probe.change.id) || {};
      outcomes.set(probe.change.id, {
        ...existing,
        ok: false,
        code: error.code || "CN_TEXT_ROUNDTRIP_FAILED",
        reason: error.message,
        sourceUnchanged: sha256File(sourcePvf) === sourceSha256Before,
        sourcePvfSha256: sourceSha256Before,
        temporaryOutputRetained: false,
      });
    }
  } finally {
    if (outputSessionId) {
      try { await callAndParse(client, "pvf_close", { sessionId: outputSessionId }); } catch { /* best effort */ }
    }
    if (sourceSessionId) {
      try { await callAndParse(client, "pvf_close", { sessionId: sourceSessionId }); } catch { /* best effort */ }
    }
    client.stop();
    if (!pathInside(probeBase, probeRoot)) throw new Error(`Unsafe Chinese text probe path: ${probeRoot}`);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  return outcomes;
}

async function runDryRun(changeSet, changeSetFile, outDirOverride, loadedChangeSetSha256) {
  const adapterConfig = loadAdapterConfig(workbenchRoot);
  assertReadOnlyAdapter(adapterConfig);
  const writePolicy = loadWritePolicy();
  if (writePolicy.mode !== "controlled-output-only" || writePolicy.publicWriteToolsEnabled !== false) {
    throw new Error("write-policy.json must remain controlled-output-only with publicWriteToolsEnabled=false.");
  }
  assertControlledWriteRunnerPolicy(writePolicy);

  const explicitPvf = option("--pvf");
  const requestedProfile = option("--profile", changeSet.target.profile);
  const resolvedSource = explicitPvf || requestedProfile
    ? resolveSourcePvf(workbenchRoot, requestedProfile, explicitPvf)
    : { sourcePvf: path.resolve(changeSet.target.sourcePvf), profile: null, source: "change-set" };
  const sourcePvf = resolvedSource.sourcePvf;
  if (!fs.existsSync(sourcePvf)) {
    throw new Error(`PVF file does not exist: ${sourcePvf}`);
  }
  const sourcePvfSha256AtStart = sha256File(sourcePvf);
  const changeSetFileSha256AtStart = sha256File(changeSetFile);
  if (loadedChangeSetSha256 && loadedChangeSetSha256 !== changeSetFileSha256AtStart) {
    const error = new Error("Change-set changed while it was being loaded; run dry-run again.");
    error.code = "CHANGE_SET_CHANGED_DURING_DRY_RUN";
    throw error;
  }

  const outRoot = outDirOverride
    ? path.resolve(outDirOverride)
    : runtimePath(workbenchRoot, "dry-runs", timestamp());
  fs.mkdirSync(outRoot, { recursive: true });

  const client = new BackendStdioClient(upstreamLaunchOptions(adapterConfig));
  const opened = await callAndParse(client, "pvf_open", {
    path: sourcePvf,
    encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
  });
  const sessionId = opened.session?.sessionId;
  if (!sessionId) {
    throw new Error("pvf_open did not return a sessionId.");
  }
  const results = [];
  const verifiedTextProbes = [];
  const directoryCache = new Map();
  try {
    for (const change of changeSet.changes) {
      const pvfPath = normalizePvfPath(change.pvfPath);
      for (const required of change.requiredResolvedIds || []) {
        const resolved = await callAndParse(client, "pvf_resolve_lst_id", {
          sessionId,
          lstPath: required.lstPath,
          id: required.id,
          includeFileSummary: false,
          pvfEncoding: changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
        });
        if (!resolved.found || normalizePvfPath(resolved.entry?.pvfPath) !== normalizePvfPath(required.expectedPvfPath)) {
          throw new Error(`Required ID resolution failed for ${required.lstPath}:${required.id}`);
        }
      }

      if (change.type === "write-file") {
        const source = readVerifiedSourceFile(changeSetFile, change);
        const targetExists = await pvfPathExists(client, sessionId, pvfPath, directoryCache);
        const writeSafety = semanticWriteSafety({
          kind: "write-file",
          pvfPath,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
          fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
          textContent: source.textContent,
        });
        results.push({
          id: change.id,
          type: change.type,
          pvfPath,
          sourceFile: source.sourceFile,
          sourceSha256: source.actualSha256,
          sourceLength: source.raw.length,
          expectAbsent: true,
          targetExists,
          applicable: !targetExists && writeSafety.allowed,
          changed: !targetExists && writeSafety.allowed,
          semanticWriteSafety: writeSafety,
          rationale: change.rationale || "",
        });
        continue;
      }

      const read = await callAndParse(client, "pvf_read_file", {
        sessionId,
        pvfPath,
        ...rawTextOptions(changeSet, change, adapterConfig),
        semanticVerificationRead: isVerifiedInlineTextMode(change.textWriteMode),
        maxChars: 0,
      });
      if (typeof read.textContent !== "string") {
        throw new Error(`PVF file is not readable as text for dry-run replacement: ${pvfPath}`);
      }
      const occurrenceCount = countOccurrences(read.textContent, change.previousText);
      const replaceAll = change.replaceAll === true;
      const occurrenceApplicable = replaceAll ? occurrenceCount > 0 : occurrenceCount === 1;
      const writeSafety = semanticWriteSafety({
        kind: "replace-text",
        pvfPath,
        pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
        fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
        previousText: change.previousText,
        newText: change.newText,
        replaceAll,
        textWriteMode: change.textWriteMode,
        sourceText: read.textContent,
      });
      const applicable = occurrenceApplicable && writeSafety.allowed;
      const after = occurrenceApplicable ? replaceText(read.textContent, change.previousText, change.newText, replaceAll) : read.textContent;
      const result = {
        id: change.id,
        type: change.type,
        pvfPath,
        textWriteMode: change.textWriteMode || null,
        pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
        occurrenceCount,
        replaceAll,
        occurrenceApplicable,
        applicable,
        changed: applicable && after !== read.textContent,
        fileMetadata: read.metadata,
        diff: diffSummary(read.textContent, after),
        semanticReadGuard: read.semanticReadGuard || null,
        semanticWriteSafety: writeSafety,
        rationale: change.rationale || "",
      };
      results.push(result);
      if (
        applicable &&
        result.changed &&
        isVerifiedInlineTextMode(change.textWriteMode) &&
        writeSafety.verifiedInlineTextWrite?.requiresEncodingRoundTripProbe === true
      ) {
        verifiedTextProbes.push({ change, pvfPath, expectedAfter: after });
      }
    }
  } finally {
    try {
      await callAndParse(client, "pvf_close", { sessionId });
    } finally {
      client.stop();
    }
  }

  const probeOutcomes = await runVerifiedInlineTextRoundTripProbe({
    sourcePvf,
    changeSet,
    adapterConfig,
    writePolicy,
    probes: verifiedTextProbes,
  });
  const sourcePvfSha256AtEnd = sha256File(sourcePvf);
  const changeSetFileSha256AtEnd = sha256File(changeSetFile);
  if (sourcePvfSha256AtEnd !== sourcePvfSha256AtStart) {
    const error = new Error("Source PVF changed during dry-run; run dry-run again.");
    error.code = "SOURCE_PVF_CHANGED_DURING_DRY_RUN";
    throw error;
  }
  if (changeSetFileSha256AtEnd !== changeSetFileSha256AtStart) {
    const error = new Error("Change-set changed during dry-run; run dry-run again.");
    error.code = "CHANGE_SET_CHANGED_DURING_DRY_RUN";
    throw error;
  }
  for (const result of results) {
    if (!isVerifiedInlineTextMode(result.textWriteMode) || !result.changed) continue;
    const outcome = probeOutcomes.get(result.id) || {
      ok: false,
      code: "CN_TEXT_ROUNDTRIP_REQUIRED",
      reason: "中文文本改动缺少临时写出复查结果。",
      temporaryOutputRetained: false,
    };
    result.encodingRoundTripProbe = outcome;
    if (!outcome.ok) {
      result.applicable = false;
      result.changed = false;
      result.blockCode = outcome.code;
      result.blockReason = outcome.reason;
    }
  }

  const manifest = {
    schemaVersion: "1.0",
    phase: "phase-3-dry-run-change-set",
    generatedAt: new Date().toISOString(),
    mode: "dry-run-only",
    writeOperationsExecuted: false,
    persistentWriteOperationsExecuted: false,
    temporaryVerificationWriteOperationsExecuted: verifiedTextProbes.length > 0,
    sourcePvf,
    changeSetFile: path.resolve(changeSetFile),
    safety: {
      writeToolsEnabled: false,
      publicWriteToolsEnabled: false,
      backupRequiredBeforeFutureApply: true,
      explicitOutputRequiredBeforeFutureApply: true,
      readbackRequiredBeforeFutureApply: true,
      semanticWriteGuardEnabled: true,
      verifiedInlineTextWriteAllowed: true,
      unverifiedDirectNonAsciiTextWriteAllowed: false,
      cnStrWriteAllowed: false,
      stringLinkTextWriteAllowed: false,
      temporaryIsolatedEncodingProbeExecuted: verifiedTextProbes.length > 0,
      temporaryProbeOutputsRetained: false,
    },
    summary: {
      changeCount: results.length,
      applicableCount: results.filter((item) => item.applicable).length,
      changedCount: results.filter((item) => item.changed).length,
      blockedCount: results.filter((item) => !item.applicable).length,
      clientTextSmokeCheckRequiredCount: results.filter((item) => item.semanticWriteSafety?.clientTextSmokeCheckRequired).length,
    },
    binding: dryRunBinding(
      results,
      sourcePvf,
      sourcePvfSha256AtEnd,
      changeSetFile,
      changeSetFileSha256AtEnd,
    ),
    results,
  };
  const manifestPath = path.join(outRoot, writePolicy.outputs?.dryRunManifestFileName || "DRY-RUN-MANIFEST.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { manifestPath, manifest };
}

function resolveApplyPaths(writePolicy, sourcePvf) {
  const outputPvfArg = option("--output-pvf");
  const outArg = option("--out");
  if (!outputPvfArg && !outArg) {
    throw new Error("apply requires --out <directory> or --output-pvf <path>.");
  }
  const runRoot = outputPvfArg ? path.dirname(path.resolve(outputPvfArg)) : path.resolve(outArg);
  const outputPvf = outputPvfArg
    ? path.resolve(outputPvfArg)
    : path.join(runRoot, "output", writePolicy.outputs?.outputFileName || "Script.pvf");
  if (samePath(sourcePvf, outputPvf)) {
    throw new Error("Refusing to save output PVF over the source PVF.");
  }
  const backupPath = path.join(
    runRoot,
    "backups",
    `${path.basename(sourcePvf)}.${timestamp()}.bak`,
  );
  const manifestPath = path.join(runRoot, writePolicy.outputs?.applyManifestFileName || "APPLY-MANIFEST.json");
  return { runRoot, outputPvf, backupPath, manifestPath };
}

async function runApply(changeSet, changeSetFile, loadedChangeSetSha256) {
  const adapterConfig = loadAdapterConfig(workbenchRoot);
  assertReadOnlyAdapter(adapterConfig);
  const writePolicy = loadWritePolicy();
  if (writePolicy.mode !== "controlled-output-only" || writePolicy.controlledApplyEnabled !== true) {
    throw new Error("write-policy.json must enable controlled-output-only apply.");
  }
  assertControlledWriteRunnerPolicy(writePolicy);

  const explicitPvf = option("--pvf");
  const requestedProfile = option("--profile", changeSet.target.profile);
  const resolvedSource = explicitPvf || requestedProfile
    ? resolveSourcePvf(workbenchRoot, requestedProfile, explicitPvf)
    : { sourcePvf: path.resolve(changeSet.target.sourcePvf), profile: null, source: "change-set" };
  const sourcePvf = resolvedSource.sourcePvf;
  if (!fs.existsSync(sourcePvf)) {
    throw new Error(`PVF file does not exist: ${sourcePvf}`);
  }

  const authorization = verifyDryRunAuthorization(sourcePvf, changeSetFile);
  if (loadedChangeSetSha256 && authorization.changeSetFileSha256 !== loadedChangeSetSha256) {
    const error = new Error("Change-set changed while apply was loading it; run dry-run again.");
    error.code = "CHANGE_SET_CHANGED_DURING_APPLY";
    throw error;
  }

  const paths = resolveApplyPaths(writePolicy, sourcePvf);
  for (const [label, candidate] of [
    ["output PVF", paths.outputPvf],
    ["backup", paths.backupPath],
    ["apply manifest", paths.manifestPath],
  ]) {
    if (fs.existsSync(candidate)) {
      throw new Error(`Refusing to overwrite an existing ${label}: ${candidate}`);
    }
  }
  fs.mkdirSync(path.dirname(paths.outputPvf), { recursive: true });
  fs.mkdirSync(path.dirname(paths.backupPath), { recursive: true });
  fs.mkdirSync(path.dirname(paths.manifestPath), { recursive: true });

  const client = new BackendStdioClient(controlledWriteLaunchOptions(adapterConfig, writePolicy));
  const opened = await callAndParse(client, "pvf_open", {
    path: sourcePvf,
    encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
  });
  const sessionId = opened.session?.sessionId;
  if (!sessionId) {
    throw new Error("pvf_open did not return a sessionId.");
  }

  if (opened.session?.readOnly === true) {
    const error = new Error("Controlled PVF apply is unavailable because the active backend is the TypeScript read-only fallback. Install the Microsoft Visual C++ v14 x64 runtime and rerun workbench.bat check.");
    error.code = "READ_ONLY_FALLBACK";
    client.stop();
    throw error;
  }

  const results = [];
  const expectedAfterByPath = new Map();
  const authorizedResults = new Map((authorization.manifest.results || []).map((item) => [item.id, item]));
  const directoryCache = new Map();
  let backupResult = null;
  let saveResult = null;
  let readbackSessionId = null;
  const applyChanges = [...changeSet.changes].sort((left, right) => {
    const leftPriority = isVerifiedInlineTextMode(left.textWriteMode) ? 0 : 1;
    const rightPriority = isVerifiedInlineTextMode(right.textWriteMode) ? 0 : 1;
    return leftPriority - rightPriority;
  });

  try {
    for (const change of applyChanges) {
      const pvfPath = normalizePvfPath(change.pvfPath);
      for (const required of change.requiredResolvedIds || []) {
        const resolved = await callAndParse(client, "pvf_resolve_lst_id", {
          sessionId,
          lstPath: required.lstPath,
          id: required.id,
          includeFileSummary: false,
          pvfEncoding: changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
        });
        if (!resolved.found || normalizePvfPath(resolved.entry?.pvfPath) !== normalizePvfPath(required.expectedPvfPath)) {
          throw new Error(`Required ID resolution failed for ${required.lstPath}:${required.id}`);
        }
      }

      if (change.type === "write-file") {
        const source = readVerifiedSourceFile(changeSetFile, change);
        const targetExists = await pvfPathExists(client, sessionId, pvfPath, directoryCache);
        if (targetExists) {
          throw new Error(`Controlled write-file target already exists: ${pvfPath}`);
        }
        const writeSafety = semanticWriteSafety({
          kind: "write-file",
          pvfPath,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
          fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
          textContent: source.textContent,
        });
        if (!writeSafety.allowed) {
          const error = new Error(`Change ${change.id} is blocked: ${writeSafety.reason}`);
          error.code = writeSafety.code;
          throw error;
        }
        const applyResult = await callAndParse(client, "pvf_write_file", {
          sessionId,
          pvfPath,
          textContent: source.textContent,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          compileScript: change.compileScript !== false,
          compileBinaryAni: change.compileBinaryAni !== false,
          convertToTraditionalChinese: false,
        });
        expectedAfterByPath.set(pvfPath, {
          kind: "write-file",
          sourceText: source.textContent,
          sourceRawSha256: source.actualSha256,
        });
        results.push({
          id: change.id,
          type: change.type,
          pvfPath,
          sourceFile: source.sourceFile,
          sourceSha256: source.actualSha256,
          sourceLength: source.raw.length,
          targetExistedBeforeApply: false,
          changed: true,
          semanticWriteSafety: writeSafety,
          applyResult,
          rationale: change.rationale || "",
        });
        continue;
      }

      const beforeRead = await callAndParse(client, "pvf_read_file", {
        sessionId,
        pvfPath,
        ...rawTextOptions(changeSet, change, adapterConfig),
        semanticVerificationRead: isVerifiedInlineTextMode(change.textWriteMode),
        maxChars: 0,
      });
      if (typeof beforeRead.textContent !== "string") {
        throw new Error(`PVF file is not readable as text for apply: ${pvfPath}`);
      }
      const writeSafety = semanticWriteSafety({
        kind: "replace-text",
        pvfPath,
        pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
        fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
        previousText: change.previousText,
        newText: change.newText,
        replaceAll: change.replaceAll === true,
        textWriteMode: change.textWriteMode,
        sourceText: beforeRead.textContent,
      });
      if (!writeSafety.allowed) {
        const error = new Error(`Change ${change.id} is blocked: ${writeSafety.reason}`);
        error.code = writeSafety.code;
        throw error;
      }
      const occurrenceCount = countOccurrences(beforeRead.textContent, change.previousText);
      const replaceAll = change.replaceAll === true;
      const applicable = replaceAll ? occurrenceCount > 0 : occurrenceCount === 1;
      if (!applicable) {
        throw new Error(`Change is not safely applicable: ${change.id} occurrences=${occurrenceCount}`);
      }
      const expectedAfter = replaceText(beforeRead.textContent, change.previousText, change.newText, replaceAll);
      const applyResult = expectedAfter === beforeRead.textContent
        ? { ok: true, skipped: true, reason: "no-op replacement" }
        : await callAndParse(client, "pvf_replace_text", {
          sessionId,
          pvfPath,
          previousText: change.previousText,
          newText: change.newText,
          replaceAll,
          dryRun: false,
          textWriteMode: change.textWriteMode,
          ...rawTextOptions(changeSet, change, adapterConfig),
        });
      const pvfEncoding = change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const verifiedInlineText = isVerifiedInlineTextMode(change.textWriteMode) && expectedAfter !== beforeRead.textContent;
      const writerProof = applyResult?.writeResult?.proof || null;
      if (verifiedInlineText && (writerProof?.existingStringEntriesPreserved !== true || writerProof?.encoding !== pvfEncoding)) {
        const error = new Error(`中文文本改动 ${change.id} 未能证明既有字符串表条目保持不变。`);
        error.code = "CN_TEXT_STRING_TABLE_PRESERVATION_FAILED";
        throw error;
      }
      expectedAfterByPath.set(pvfPath, {
        kind: "replace-text",
        expectedText: expectedAfter,
        pvfEncoding,
        verifiedInlineText,
        writerProof,
      });
      results.push({
        id: change.id,
        type: change.type,
        pvfPath,
        textWriteMode: change.textWriteMode || null,
        pvfEncoding,
        occurrenceCount,
        replaceAll,
        changed: expectedAfter !== beforeRead.textContent,
        beforeSha256: sha256(beforeRead.textContent),
        expectedAfterSha256: sha256(expectedAfter),
        semanticReadGuard: beforeRead.semanticReadGuard || null,
        semanticWriteSafety: writeSafety,
        encodingRoundTripProbe: authorizedResults.get(change.id)?.encodingRoundTripProbe || null,
        applyResult,
        rationale: change.rationale || "",
      });
    }

    backupResult = await callAndParse(client, "pvf_backup", {
      path: sourcePvf,
      targetPath: paths.backupPath,
    });

    saveResult = await callAndParse(client, "pvf_save", {
      sessionId,
      targetPath: paths.outputPvf,
      allowOverwriteSource: false,
    });
  } finally {
    try {
      await callAndParse(client, "pvf_close", { sessionId });
    } catch {
      // Preserve the original apply error if close fails.
    }
  }

  const readback = [];
  try {
    const reopened = await callAndParse(client, "pvf_open", {
      path: paths.outputPvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    readbackSessionId = reopened.session?.sessionId;
    if (!readbackSessionId) {
      throw new Error("readback pvf_open did not return a sessionId.");
    }
    for (const [pvfPath, expected] of expectedAfterByPath.entries()) {
      const rb = await callAndParse(client, "pvf_read_file", {
        sessionId: readbackSessionId,
        pvfPath,
        pvfEncoding: expected.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: expected.verifiedInlineText === true,
        maxChars: 0,
      });
      if (expected.kind === "replace-text") {
        const comparison = pvfTextReadbackResult(expected.expectedText, rb.textContent);
        const independentSemanticRead = expected.verifiedInlineText === true
          ? rb.semanticReadGuard?.applied === true &&
            rb.semanticReadGuard?.reason === "verified-text-readback" &&
            rb.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
            rb.semanticReadGuard?.selectedEncoding === expected.pvfEncoding
          : null;
        const verifiedOk = expected.verifiedInlineText === true
          ? comparison.exactTextOk === true && independentSemanticRead && expected.writerProof?.existingStringEntriesPreserved === true && expected.writerProof?.encoding === expected.pvfEncoding
          : comparison.ok;
        readback.push({
          pvfPath,
          kind: expected.kind,
          ...comparison,
          ok: verifiedOk,
          verifiedInlineText: expected.verifiedInlineText === true,
          verifiedInlineCn: expected.verifiedInlineText === true && expected.pvfEncoding === "Cn",
          independentSemanticRead,
          semanticReadGuard: rb.semanticReadGuard || null,
          writerProof: expected.writerProof || null,
          metadata: rb.metadata,
        });
      } else {
        const hasText = typeof rb.textContent === "string";
        if (hasText) {
          readback.push({
            pvfPath,
            kind: expected.kind,
            ...pvfTextReadbackResult(expected.sourceText, rb.textContent),
            metadata: rb.metadata,
          });
        } else {
          const expectedSha256 = expected.sourceRawSha256;
          const actualSha256 = rb.base64Content ? sha256(Buffer.from(rb.base64Content, "base64")) : null;
          readback.push({
            pvfPath,
            kind: expected.kind,
            comparison: "raw-base64-sha256",
            ok: actualSha256 === expectedSha256,
            exactTextOk: null,
            layoutNormalizationAccepted: false,
            expectedSha256,
            actualSha256,
            expectedTokenSha256: null,
            actualTokenSha256: null,
            sourceTokenCount: null,
            readbackTokenCount: null,
            mismatches: [],
            metadata: rb.metadata,
          });
        }
      }
    }
  } finally {
    if (readbackSessionId) {
      try {
        await callAndParse(client, "pvf_close", { sessionId: readbackSessionId });
      } catch {
        // No further action.
      }
    }
    client.stop();
  }

  const sourcePvfSha256AfterApply = sha256File(sourcePvf);
  const sourceUnchanged = sourcePvfSha256AfterApply.toLowerCase() === authorization.sourcePvfSha256.toLowerCase();
  const readbackOk = readback.every((item) => item.ok) && sourceUnchanged;
  const readbackExactCount = readback.filter((item) => item.ok && item.exactTextOk === true).length;
  const readbackNormalizedEquivalentCount = readback.filter((item) => item.ok && item.layoutNormalizationAccepted === true).length;
  const readbackRawBinaryCount = readback.filter((item) => item.ok && item.comparison === "raw-base64-sha256").length;
  const readbackFailedCount = readback.filter((item) => !item.ok).length;
  const finalOutputIdentity = outputPvfIdentity(paths.outputPvf);
  const outputPvfSha256 = finalOutputIdentity.sha256;
  const outputPvfBytes = finalOutputIdentity.bytes;
  const manifest = {
    schemaVersion: "1.0",
    phase: "phase-3-controlled-output-apply",
    generatedAt: new Date().toISOString(),
    mode: "controlled-output-only",
    writeOperationsExecuted: true,
    sourcePvf,
    outputPvf: paths.outputPvf,
    outputPvfSha256,
    outputPvfBytes,
    backupPath: paths.backupPath,
    changeSetFile: path.resolve(changeSetFile),
    dryRunManifest: authorization.manifestFile,
    dryRunBindingSha256: authorization.binding.bindingSha256,
    sourcePvfSha256: authorization.sourcePvfSha256,
    sourcePvfSha256AfterApply,
    changeSetFileSha256: authorization.changeSetFileSha256,
    sourceProfile: resolvedSource.profile?.name || null,
    safety: {
      sourceOverwriteAllowed: false,
      sourceOverwritten: !sourceUnchanged,
      sourceUnchanged,
      backupCreated: Boolean(backupResult?.targetPath && fs.existsSync(backupResult.targetPath)),
      matchingDryRunRequired: true,
      matchingDryRunVerified: true,
      explicitUserAuthorizationRequired: true,
      explicitUserAuthorizationVerified: true,
      explicitOutputPath: true,
      readbackExecuted: true,
      readbackOk,
      outputSha256Bound: true,
      readbackComparisonPolicy: "exact-text-or-float32-aware-token-equivalence",
      semanticWriteGuardEnabled: true,
      verifiedInlineTextWriteAllowed: true,
      verifiedInlineTextRequiresExactIndependentReadback: true,
      verifiedInlineTextAppliedBeforeOtherWrites: true,
      unverifiedDirectNonAsciiTextWriteAllowed: false,
      cnStrWriteAllowed: false,
      stringLinkTextWriteAllowed: false,
      clientTextSmokeCheckRequired: results.some((item) => item.semanticWriteSafety?.clientTextSmokeCheckRequired),
      clientResourceWrite: false,
    },
    summary: {
      changeCount: results.length,
      changedCount: results.filter((item) => item.changed).length,
      outputExists: fs.existsSync(paths.outputPvf),
      backupExists: fs.existsSync(paths.backupPath),
      readbackOk,
      outputSha256Verified: true,
      readbackExactCount,
      readbackNormalizedEquivalentCount,
      readbackRawBinaryCount,
      readbackFailedCount,
      verifiedInlineTextCount: results.filter((item) => isVerifiedInlineTextMode(item.textWriteMode) && item.changed).length,
      verifiedInlineTextByEncoding: {
        Cn: results.filter((item) => isVerifiedInlineTextMode(item.textWriteMode) && item.pvfEncoding === "Cn" && item.changed).length,
        Tw: results.filter((item) => isVerifiedInlineTextMode(item.textWriteMode) && item.pvfEncoding === "Tw" && item.changed).length,
      },
      clientTextSmokeCheckRequiredCount: results.filter((item) => item.semanticWriteSafety?.clientTextSmokeCheckRequired).length,
    },
    backupResult,
    saveResult,
    results,
    readback,
  };
  fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (!readbackOk) {
    throw new Error(`Apply readback failed. Manifest: ${paths.manifestPath}`);
  }
  return { manifestPath: paths.manifestPath, manifest };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "self-test") {
    const report = changeSetAuthorizationSelfTest();
    printJson(report);
    if (!report.summary.ok) process.exitCode = 1;
    return;
  }
  const file = path.resolve(requireOption("--file"));
  const changeSetRaw = fs.readFileSync(file);
  const loadedChangeSetSha256 = sha256(changeSetRaw);
  const changeSet = JSON.parse(changeSetRaw.toString("utf8"));
  const validationErrors = validateChangeSet(changeSet);
  if (validationErrors.length > 0) {
    printJson({ ok: false, command, errors: validationErrors });
    process.exit(1);
  }
  if (command === "validate") {
    printJson({ ok: true, command, file, changeCount: changeSet.changes.length });
    return;
  }
  if (command === "dry-run") {
    const { manifestPath, manifest } = await runDryRun(changeSet, file, option("--out"), loadedChangeSetSha256);
    const blockedChanges = manifest.results
      .filter((item) => !item.applicable)
      .map((item) => ({
        id: item.id,
        pvfPath: item.pvfPath,
        occurrenceCount: item.occurrenceCount,
        targetExists: item.targetExists,
        code: item.blockCode || item.encodingRoundTripProbe?.code || item.semanticWriteSafety?.code || null,
        reason: item.blockReason || item.encodingRoundTripProbe?.reason || item.semanticWriteSafety?.reason || (item.occurrenceApplicable === false ? "Exact source text did not match once." : "Change is not safely applicable."),
      }));
    printJson({
      ok: true,
      command,
      manifestPath,
      summary: manifest.summary,
      approvalCode: blockedChanges.length ? null : manifest.binding.approvalCode,
      blockedChanges,
    });
    if (manifest.summary.blockedCount > 0) {
      process.exit(2);
    }
    return;
  }
  if (command === "apply") {
    const { manifestPath, manifest } = await runApply(changeSet, file, loadedChangeSetSha256);
    printJson({
      ok: true,
      command,
      manifestPath,
      outputPvf: manifest.outputPvf,
      backupPath: manifest.backupPath,
      summary: manifest.summary,
    });
    return;
  }
  throw new Error(`Unsupported command: ${command}`);
}

main().catch((error) => {
  const code = error?.code ? `[${error.code}] ` : "";
  console.error(`ERROR ${code}${error.message}`);
  if (error?.code === "CN_LOCALIZATION_WRITE_UNVERIFIED") {
    console.error("提示：这是工作台主动阻止可能导致中文乱码的 .str 写入；没有生成或覆盖 PVF。");
  } else if (error?.code === "NON_ASCII_TEXT_WRITE_UNVERIFIED") {
    console.error("提示：普通脚本中文需要使用已验证的单字段文本模式；未声明模式的中文写入仍会被阻止。");
  } else if (["CN_TEXT_CHARACTER_UNENCODABLE", "CN_TEXT_ENCODING_ROUNDTRIP_FAILED"].includes(error?.code)) {
    console.error("提示：新文字含当前编码无法无损保存的字符，请换用常见简体中文、数字或符号后重试。");
  } else if (error?.code === "HTML_NUMERIC_ENTITY_WRITE_BLOCKED") {
    console.error("提示：请使用目标 PVF 原始读回中的真实文字，不要把网页里的 &#数字; 形式写进 PVF。");
  } else if (["CN_TEXT_TOKEN_REQUIRED", "CN_TEXT_PARENT_TAG_UNSUPPORTED", "CN_TEXT_FILE_TYPE_UNSUPPORTED", "CN_TEXT_REPLACE_ALL_BLOCKED"].includes(error?.code)) {
    console.error("提示：一次只能修改一个完整、明确的名称或描述字段；工作台没有生成或覆盖 PVF。");
  } else if (error?.code === "STRINGLINK_TEXT_WRITE_UNVERIFIED") {
    console.error("提示：这是引用到独立文字资源的内容，当前路线仍保持只读，以免产生乱码或改错位置。");
  } else if (["CN_TEXT_ROUNDTRIP_FAILED", "CN_TEXT_ROUNDTRIP_REQUIRED"].includes(error?.code)) {
    console.error("提示：临时写出后的独立复查没有通过，因此没有获得正式生成许可；源 PVF 未被覆盖。");
  } else if (error?.code === "READ_ONLY_FALLBACK") {
    console.error("提示：读取仍可使用，但写出环境未就绪。请运行 workbench.bat check 查看修复说明。");
  }
  process.exit(1);
});
