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
  containsNonAscii,
  semanticWriteSafety,
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  isVerifiedInlineTextMode,
} = require("../lib/semantic-read-guard");
const {
  verifiedInlineTextSelfTest,
  verifiedInlineTextBatchStressSelfTest,
} = require("../../../tools/pvf-bridge/verified-inline-cn-text");
const {
  analyzeContextAnchoredReplacement,
  applyContextAnchoredReplacement,
  occurrenceMismatch,
} = require("../../../tools/pvf-bridge/context-anchored-replace");

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

For a cumulative next round, add baseline.applyManifest to the change-set. The verified
previous output becomes this round's input; target.sourcePvf remains the protected source.
`;
}

function completeBacktickToken(value) {
  return /^`[^`]*`$/u.test(String(value || ""));
}

function changeSetPlanSummary(changeSet) {
  const paths = groupChangesByPvfPath(changeSet.changes || []).map((group) => ({
    pvfPath: group.pvfPath,
    changeCount: group.changes.length,
    ordinaryReplaceCount: group.changes.filter((item) =>
      item.type === "replace-text" && !isVerifiedInlineTextMode(item.textWriteMode)).length,
    verifiedInlineTextCount: group.changes.filter((item) =>
      item.type === "replace-text" && isVerifiedInlineTextMode(item.textWriteMode)).length,
    writeFileCount: group.changes.filter((item) => item.type === "write-file").length,
  }));
  return {
    pathCount: paths.length,
    multiChangePathCount: paths.filter((item) => item.changeCount > 1).length,
    paths,
  };
}

function changeSetAgentHandoff(changeSet, file) {
  const plan = changeSetPlanSummary(changeSet);
  return {
    structuralValidationComplete: true,
    semanticDryRunStillRequired: true,
    nextCommandOnly: `workbench.bat pvf-change dry-run --file "${file}" --out <external-preview-directory>`,
    helpProbeRequired: false,
    sourceCodeInspectionRequired: false,
    samePathChanges: {
      supported: true,
      plannedAsOneFinalFile: true,
      multiChangePaths: plan.paths.filter((item) => item.changeCount > 1),
      instruction: "同一 pvfPath 的参数和文字改动保留在同一个 changes 数组中；不要拆成多个 change-set，也不要把前一输出直接改写成下一条 sourcePvf。",
    },
    verifiedInlineText: {
      instruction: "完整中文名称/说明使用 textWriteMode=verified-inline-text，并在该 change 上填写本次 --raw 选中的 pvfEncoding（Cn 或 Tw）。参数/结构改动保持为独立的普通 ASCII-only replace-text。",
      example: "workspaces/examples/change-set.verified-cn-text.example.json",
    },
    exactCount: {
      singleOccurrence: "replaceAll=false 固定表示精确 1 次。",
      bulk: "批量必须使用 replaceAll=true 和正整数 expectedOccurrences；实际数量不一致会停止。",
      duplicateSingleTarget: "只改重复文字中的一处时，使用同次 --raw 读回的 contextBefore/contextAfter 精确定位。",
    },
    cumulativeNextRound: {
      baselineDeclared: Boolean(changeSet.baseline?.applyManifest),
      instruction: "连续第二轮仍让 target.sourcePvf 指向最初受保护源，并用 baseline.applyManifest 指向上一轮成功的 APPLY-MANIFEST.json；按 nextCommandOnly 原样预演，不要自行增加指向最初源的 --pvf。只有明确覆盖时，--pvf 才能指向上一轮记录绑定的 outputPvf；不要把它写成新的 target.sourcePvf。",
      example: "workspaces/examples/change-set.cumulative-second-round.example.json",
    },
    prohibitedFollowUp: [
      "inspect pvf-change-set.js implementation",
      "split same-path changes into chained fresh sources",
      "treat replaceAll=false as a declared bulk count",
      "reuse reader-friendly display text as previousText",
    ],
  };
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

function syncFile(file) {
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sourceBackupPath(sourcePvf, sourcePvfSha256, externalOutputRoot) {
  const resolvedOutputRoot = path.resolve(externalOutputRoot);
  const backupRoot = path.join(resolvedOutputRoot, "pvf-source-backups", "sha256");
  const backupPath = path.join(backupRoot, `${sourcePvfSha256.toLowerCase()}.Script.pvf`);
  if (samePath(sourcePvf, backupPath)) {
    const error = new Error("Calculated source backup path collides with the source PVF.");
    error.code = "BACKUP_SOURCE_COLLISION";
    throw error;
  }
  return backupPath;
}

function ensureContentAddressedSourceBackup(sourcePvf, backupPath, expectedSha256) {
  const source = path.resolve(sourcePvf);
  const destination = path.resolve(backupPath);
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile()) {
      const error = new Error(`Existing source backup is not a regular file: ${destination}`);
      error.code = "BACKUP_NOT_REGULAR_FILE";
      throw error;
    }
    const actualSha256 = sha256File(destination);
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      const error = new Error("Refusing to reuse a content-addressed source backup whose content does not match its name.");
      error.code = "BACKUP_HASH_MISMATCH";
      throw error;
    }
    return { ok: true, sourcePath: source, targetPath: destination, sha256: actualSha256, created: false, reused: true };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    syncFile(temporary);
    const temporarySha256 = sha256File(temporary);
    if (temporarySha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      const error = new Error("Source PVF changed while its verified backup was being created.");
      error.code = "BACKUP_SOURCE_CHANGED";
      throw error;
    }
    if (fs.existsSync(destination)) {
      const existingSha256 = sha256File(destination);
      if (existingSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        const error = new Error("Concurrent content-addressed source backup has the wrong SHA256.");
        error.code = "BACKUP_HASH_MISMATCH";
        throw error;
      }
      fs.rmSync(temporary, { force: true });
      return { ok: true, sourcePath: source, targetPath: destination, sha256: existingSha256, created: false, reused: true };
    }
    fs.renameSync(temporary, destination);
    const backupSha256 = sha256File(destination);
    if (backupSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      const error = new Error("Verified source backup SHA256 changed after final placement.");
      error.code = "BACKUP_HASH_MISMATCH";
      throw error;
    }
    return { ok: true, sourcePath: source, targetPath: destination, sha256: backupSha256, created: true, reused: false };
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
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
      finalFileExpectedSha256: item.finalFileExpectedSha256 || null,
      expectedOccurrences: item.expectedOccurrences || null,
      contextAnchorSha256: item.contextAnchor
        ? sha256(JSON.stringify(item.contextAnchor))
        : null,
      rawAsciiTokenPlanProofSha256: item.rawAsciiTokenPlanProof
        ? sha256(JSON.stringify(item.rawAsciiTokenPlanProof))
        : null,
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

function dryRunManifestBinding(results, sourcePvf, sourcePvfSha256, changeSetFile, changeSetFileSha256, blockedCount) {
  const binding = dryRunBinding(results, sourcePvf, sourcePvfSha256, changeSetFile, changeSetFileSha256);
  if (Number(blockedCount) > 0) {
    return {
      ...binding,
      approvalCode: null,
      authorizationWithheld: true,
      authorizationWithheldReason: "BLOCKED_DRY_RUN",
    };
  }
  return {
    ...binding,
    authorizationWithheld: false,
    authorizationWithheldReason: null,
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
    if (result.type === "replace-text" && !isVerifiedInlineTextMode(result.textWriteMode) && result.changed === true) {
      const proof = result.rawAsciiTokenPlanProof;
      if (
        proof?.existingStringEntriesPreserved !== true ||
        !Number.isSafeInteger(proof?.appendedStringEntryCount) ||
        proof.appendedStringEntryCount < 0 ||
        proof?.exactIndependentTextReadback !== true ||
        Number(proof?.expectedOccurrences) !== Number(result.expectedOccurrences) ||
        Number(proof?.occurrenceCount) !== Number(result.occurrenceCount) ||
        (result.contextAnchor && (
          proof?.contextAnchor?.selectorSha256 !== result.contextAnchor.selectorSha256 ||
          proof?.contextAnchor?.locationBindingSha256 !== result.contextAnchor.locationBindingSha256
        )) ||
        !/^[a-f0-9]{64}$/i.test(String(proof?.scriptBeforeSha256 || "")) ||
        !/^[a-f0-9]{64}$/i.test(String(proof?.scriptAfterSha256 || ""))
      ) {
        const error = new Error(`参数改动 ${result.id} 缺少完整的原始 token 预演证据；请重新预演。`);
        error.code = "RAW_ASCII_TOKEN_PLAN_REQUIRED";
        throw error;
      }
    }
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
      Number(probe?.writerProof?.occurrenceCount || 1) !== Number(result.expectedOccurrences || 1) ||
      (result.contextAnchor && (
        probe?.writerProof?.contextAnchor?.selectorSha256 !== result.contextAnchor.selectorSha256 ||
        probe?.writerProof?.contextAnchor?.locationBindingSha256 !== result.contextAnchor.locationBindingSha256
      )) ||
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
    const sourceSha256 = sha256File(sourcePvf);
    const sourceBackup = path.join(tempRoot, "source-backups", `${sourceSha256}.Script.pvf`);
    const firstBackup = ensureContentAddressedSourceBackup(sourcePvf, sourceBackup, sourceSha256);
    const secondBackup = ensureContentAddressedSourceBackup(sourcePvf, sourceBackup, sourceSha256);
    checks.push({
      id: "identical-source-backup-is-content-addressed-and-reused",
      ok:
        firstBackup.created === true && firstBackup.reused === false &&
        secondBackup.created === false && secondBackup.reused === true &&
        firstBackup.targetPath === secondBackup.targetPath &&
        sha256File(sourceBackup) === sourceSha256,
    });
    fs.writeFileSync(path.join(tempRoot, "wrong-backup.pvf"), "wrong-content", "utf8");
    let mismatchedBackupRejected = false;
    try {
      ensureContentAddressedSourceBackup(sourcePvf, path.join(tempRoot, "wrong-backup.pvf"), sourceSha256);
    } catch (error) {
      mismatchedBackupRejected = error.code === "BACKUP_HASH_MISMATCH";
    }
    checks.push({ id: "mismatched-content-addressed-source-backup-is-rejected", ok: mismatchedBackupRejected });
    const results = [{
      id: "fixture-change",
      type: "replace-text",
      pvfPath: "skill/fixture.skl",
      applicable: true,
      changed: true,
      occurrenceCount: 1,
      expectedOccurrences: 1,
      rawAsciiTokenPlanProof: {
        occurrenceCount: 1,
        expectedOccurrences: 1,
        stringTableUntouched: true,
        existingStringEntriesPreserved: true,
        appendedStringEntryCount: 0,
        exactIndependentTextReadback: true,
        scriptBeforeSha256: sha256("script-before"),
        scriptAfterSha256: sha256("script-after"),
      },
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

    const withheldBinding = dryRunManifestBinding(
      results,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      1,
    );
    checks.push({
      id: "blocked-dry-run-manifest-withholds-internal-binding-approval-code",
      ok:
        /^[a-f0-9]{64}$/.test(String(withheldBinding.bindingSha256 || "")) &&
        withheldBinding.approvalCode === null &&
        withheldBinding.authorizationWithheld === true &&
        withheldBinding.authorizationWithheldReason === "BLOCKED_DRY_RUN",
    });

    const outputIdentity = outputPvfIdentity(sourcePvf);
    checks.push({
      id: "final-output-sha256-and-size-bound",
      ok:
        outputIdentity.sha256 === sha256File(sourcePvf) &&
        outputIdentity.bytes === fs.statSync(sourcePvf).size &&
        /^[a-f0-9]{64}$/.test(outputIdentity.sha256),
    });

    const cumulativeOutputPvf = path.join(tempRoot, "cumulative-output.pvf");
    const cumulativeApplyManifest = path.join(tempRoot, "CUMULATIVE-APPLY-MANIFEST.json");
    fs.writeFileSync(cumulativeOutputPvf, "pvf-fixture-output-v2", "utf8");
    fs.writeFileSync(cumulativeApplyManifest, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-controlled-output-apply",
      mode: "controlled-output-only",
      sourcePvf,
      sourcePvfSha256: sha256File(sourcePvf),
      protectedSourcePvf: sourcePvf,
      protectedSourcePvfSha256: sha256File(sourcePvf),
      outputPvf: cumulativeOutputPvf,
      outputPvfSha256: sha256File(cumulativeOutputPvf),
      safety: {
        sourceOverwritten: false,
        sourceUnchanged: true,
        readbackOk: true,
        outputSha256Bound: true,
      },
      summary: { readbackOk: true, outputSha256Verified: true, changedCount: 3 },
      cumulative: {
        enabled: false,
        chainDepth: 0,
        previousChangeCount: 0,
        currentChangeCount: 3,
        totalChangeCount: 3,
      },
    }, null, 2)}\n`, "utf8");
    const cumulativeChangeSet = {
      target: { sourcePvf },
      baseline: { applyManifest: cumulativeApplyManifest },
    };
    const cumulativeInput = resolveChangeInput(cumulativeChangeSet, changeSetFile, null, null);
    checks.push({
      id: "cumulative-baseline-uses-verified-previous-output",
      ok:
        cumulativeInput.sourcePvf === cumulativeOutputPvf &&
        cumulativeInput.protectedSourcePvf === sourcePvf &&
        cumulativeInput.cumulative.previousChangeCount === 3 &&
        cumulativeInput.cumulative.chainDepth === 1,
    });
    fs.writeFileSync(cumulativeOutputPvf, "tampered-output", "utf8");
    let tamperedBaselineRejected = false;
    try {
      resolveChangeInput(cumulativeChangeSet, changeSetFile, null, null);
    } catch (error) {
      tamperedBaselineRejected = error.code === "CUMULATIVE_BASELINE_OUTPUT_CHANGED";
    }
    checks.push({ id: "tampered-cumulative-baseline-output-rejected", ok: tamperedBaselineRejected });

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

    const invalidDirectChineseChangeSet = {
      schemaVersion: "1.0",
      mode: "dry-run-only",
      target: { sourcePvf },
      changes: [{
        id: "invalid-direct-chinese",
        type: "replace-text",
        pvfPath: "stackable/fixture.stk",
        previousText: "`旧文本`",
        newText: "`新文本`",
        replaceAll: false,
      }],
      safety: {
        writeModeEnabled: false,
        requiresBackupBeforeApply: true,
        requiresExplicitOutputPath: true,
        requiresReadback: true,
      },
    };
    checks.push({
      id: "validate-rejects-non-ascii-before-dry-run-with-actionable-mode",
      ok: validateChangeSet(invalidDirectChineseChangeSet).some((message) =>
        message.includes("NON_ASCII_TEXT_WRITE_UNVERIFIED") && message.includes(VERIFIED_INLINE_TEXT_MODE)),
    });

    const samePathHandoffChangeSet = {
      ...invalidDirectChineseChangeSet,
      changes: [
        {
          id: "parameter", type: "replace-text", pvfPath: "stackable/fixture.stk",
          previousText: "[value]\r\n10", newText: "[value]\r\n20", replaceAll: false, pvfEncoding: "Tw",
        },
        {
          id: "name", type: "replace-text", pvfPath: "stackable/fixture.stk",
          previousText: "`舊名稱`", newText: "`新名稱`", replaceAll: false,
          textWriteMode: VERIFIED_INLINE_TEXT_MODE, pvfEncoding: "Tw",
        },
      ],
    };
    const samePathHandoff = changeSetAgentHandoff(samePathHandoffChangeSet, changeSetFile);
    checks.push({
      id: "validate-handoff-keeps-same-path-changes-together",
      ok:
        validateChangeSet(samePathHandoffChangeSet).length === 0 &&
        samePathHandoff.samePathChanges.supported === true &&
        samePathHandoff.samePathChanges.multiChangePaths?.[0]?.changeCount === 2 &&
        samePathHandoff.sourceCodeInspectionRequired === false &&
        samePathHandoff.prohibitedFollowUp.includes("split same-path changes into chained fresh sources"),
    });

    const cumulativeHandoff = changeSetAgentHandoff({
      ...samePathHandoffChangeSet,
      baseline: { applyManifest: path.join(tempRoot, "previous", "APPLY-MANIFEST.json") },
    }, changeSetFile);
    checks.push({
      id: "validate-handoff-cumulative-command-omits-unsafe-source-override",
      ok:
        cumulativeHandoff.cumulativeNextRound.baselineDeclared === true &&
        !cumulativeHandoff.nextCommandOnly.includes("--pvf") &&
        cumulativeHandoff.cumulativeNextRound.instruction.includes("不要自行增加指向最初源的 --pvf") &&
        cumulativeHandoff.cumulativeNextRound.instruction.includes("上一轮记录绑定的 outputPvf"),
    });

    const batchValidationErrors = validateChangeSet({
      ...invalidDirectChineseChangeSet,
      changes: [{
        id: "invalid-bulk", type: "replace-text", pvfPath: "stackable/fixture.stk",
        previousText: "`舊文本`", newText: "`新文本`", replaceAll: true,
        textWriteMode: VERIFIED_INLINE_TEXT_MODE, pvfEncoding: "Tw",
      }],
    });
    checks.push({
      id: "validate-requires-exact-count-for-verified-text-bulk",
      ok: batchValidationErrors.some((message) => message.includes("expectedOccurrences is required when replaceAll=true")),
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
    const batchStress = verifiedInlineTextBatchStressSelfTest();
    for (const stressCase of batchStress.cases) {
      checks.push({
        id: `verified-inline-text-batch-stress-${stressCase.count}`,
        ok: stressCase.ok,
        elapsedMilliseconds: stressCase.elapsedMilliseconds,
        appendedStringEntryCount: stressCase.appendedStringEntryCount,
        proofBytes: stressCase.proofBytes,
        proofBytesPerChange: stressCase.proofBytesPerChange,
      });
    }

    const sameFilePlan = planReplacementGroup(
      "[value]\r\n10\r\n[skill explain]\r\n`旧说明\r\n第二行`\r\n[name]\r\n`旧名称`\r\n",
      [
        { id: "parameter", type: "replace-text", previousText: "[value]\r\n10", newText: "[value]\r\n20", replaceAll: false, pvfEncoding: "Cn" },
        { id: "explain", type: "replace-text", previousText: "`旧说明\r\n第二行`", newText: "`新说明\r\n第二行新`", replaceAll: false, pvfEncoding: "Cn", textWriteMode: VERIFIED_INLINE_TEXT_MODE },
        { id: "name", type: "replace-text", previousText: "`旧名称`", newText: "`新名称`", replaceAll: false, pvfEncoding: "Cn", textWriteMode: VERIFIED_INLINE_TEXT_MODE },
      ],
      { pvfPath: "stackable/fixture.stk", pvfReadEncoding: "Cn", fallbackEncoding: "Cn" },
    );
    checks.push({
      id: "same-file-parameter-and-two-text-changes-share-final-plan",
      ok: sameFilePlan.blocked === false && sameFilePlan.items.length === 3 &&
        sameFilePlan.items.every((item) => item.applicable === true && item.blockCode === null && item.blockReason === null) &&
        sameFilePlan.expectedText.includes("[value]\r\n20") &&
        sameFilePlan.expectedText.includes("`新说明\r\n第二行新`") &&
        sameFilePlan.expectedText.includes("`新名称`"),
    });

    const linkedSource = "[skill]\r\n9\r\n`[swordman]`\t60\r\n`[dungeon type]`\r\n`[static]`\t0\r\n`%`\t6\r\n[/skill]\r\n\r\n[skill explain]\r\n`移動距離 +6%%`\r\n\r\n[skill explain]\r\n`移動距離 +6%%`\r\n";
    const linkedOldParameter = "[skill]\r\n9\r\n`[swordman]`\t60\r\n`[dungeon type]`\r\n`[static]`\t0\r\n`%`\t6\r\n[/skill]";
    const linkedNewParameter = "[skill]\r\n9\r\n`[swordman]`\t60\r\n`[dungeon type]`\r\n`[static]`\t0\r\n`+`\t150\r\n[/skill]";
    const linkedPlan = planReplacementGroup(
      linkedSource,
      [
        {
          id: "linked-parameter", type: "replace-text",
          previousText: linkedOldParameter, newText: linkedNewParameter,
          replaceAll: false, pvfEncoding: "Tw",
        },
        {
          id: "linked-explain", type: "replace-text",
          previousText: "`移動距離 +6%%`", newText: "`移動距離 +100%%`",
          contextBefore: `${linkedNewParameter}\r\n\r\n[skill explain]\r\n`,
          replaceAll: false, pvfEncoding: "Tw", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        },
      ],
      { pvfPath: "stackable/consumption_1256.stk", pvfReadEncoding: "Tw", fallbackEncoding: "Tw" },
    );
    let linkedApplication = null;
    try { linkedApplication = buildSameFileApplicationPlan(linkedPlan); } catch { /* asserted below */ }
    checks.push({
      id: "same-file-parameter-then-anchored-duplicate-text-share-final-plan",
      ok:
        linkedPlan.blocked === false &&
        linkedPlan.items[1]?.occurrenceCount === 1 &&
        linkedPlan.items[1]?.totalOccurrenceCount === 2 &&
        linkedPlan.items[1]?.contextAnchor?.anchored === true &&
        linkedApplication?.finalText === linkedPlan.expectedText &&
        linkedApplication?.finalText.includes("`+`\t150") &&
        linkedApplication?.finalText.split("`移動距離 +100%%`").length - 1 === 1 &&
        linkedApplication?.finalText.split("`移動距離 +6%%`").length - 1 === 1,
    });

    const deletionSource = "[option]\r\n[type]\r\n`weapon`\r\n[explain]\r\n`删除说明`\r\n[/option]\r\n";
    const deletionPlan = planReplacementGroup(
      deletionSource,
      [
        {
          id: "delete-explain-first", type: "replace-text",
          previousText: "`删除说明`", newText: "``",
          replaceAll: false, pvfEncoding: "Cn", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        },
        {
          id: "delete-residue-after-text", type: "replace-text",
          previousText: "[explain]\r\n``\r\n", newText: "",
          replaceAll: false, pvfEncoding: "Cn",
        },
        {
          id: "delete-option-structure-last", type: "replace-text",
          previousText: "[option]\r\n[type]\r\n`weapon`\r\n[/option]\r\n", newText: "",
          replaceAll: false, pvfEncoding: "Cn",
        },
      ],
      { pvfPath: "stackable/fixture.stk", pvfReadEncoding: "Cn", fallbackEncoding: "Cn" },
    );
    let deletionApplication = null;
    try { deletionApplication = buildSameFileApplicationPlan(deletionPlan); } catch { /* asserted below */ }
    checks.push({
      id: "same-file-verified-then-ordinary-deletion-chain-preserves-order",
      ok:
        deletionPlan.blocked === false &&
        deletionApplication?.verifiedInsertionIndex === 0 &&
        deletionApplication?.requiresTemporaryOrderedProof === true &&
        deletionApplication?.stages?.map((stage) => stage.kind).join(",") === "verified,ordinary" &&
        deletionApplication?.finalText === "",
    });

    const zeroMatchPlan = planReplacementGroup("[value]\r\n10\r\n", [{
      id: "missing", type: "replace-text", previousText: "[value]\r\n11", newText: "[value]\r\n12",
      replaceAll: false, pvfEncoding: "Cn", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    }], { pvfPath: "stackable/fixture.stk", pvfReadEncoding: "Cn", fallbackEncoding: "Cn" });
    checks.push({
      id: "zero-match-reported-before-text-shape-validation",
      ok: zeroMatchPlan.items[0]?.blockCode === "OCCURRENCE_COUNT_MISMATCH" &&
        zeroMatchPlan.items[0]?.occurrenceCount === 0 && zeroMatchPlan.items[0]?.semanticWriteSafety === null,
    });

    const displayTextDiagnosis = diagnoseZeroOccurrenceSource({
      id: "display-text-misuse",
      pvfPath: "stackable/fixture.stk",
      previousText: "`准备时间 -10%%`",
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    }, {
      rawOccurrenceCount: 0,
      displayText: "[skill explain]\r\n`准备时间 -10%%`\r\n",
      alternateRawText: "[skill explain]\r\n`准備時間 -10%%`\r\n",
      requestedEncoding: "Tw",
      displaySelectedEncoding: "Tw",
      alternateEncoding: "Cn",
      pvfPath: "stackable/fixture.stk",
    });
    checks.push({
      id: "zero-match-identifies-reader-friendly-display-text",
      ok: displayTextDiagnosis?.code === "DISPLAY_TEXT_USED_AS_CHANGE_SOURCE" &&
        displayTextDiagnosis?.displayOccurrenceCount === 1 &&
        displayTextDiagnosis?.recovery?.command === "pvf-read read --raw" &&
        displayTextDiagnosis?.recovery?.pvfEncoding === "Tw" &&
        displayTextDiagnosis?.automaticRewriteAttempted === false,
    });

    const encodingMismatchDiagnosis = diagnoseZeroOccurrenceSource({
      id: "encoding-mismatch",
      pvfPath: "stackable/fixture.stk",
      previousText: "`准備時間 -10%%`",
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    }, {
      rawOccurrenceCount: 0,
      displayText: "[skill explain]\r\n`准备时间 -10%%`\r\n",
      alternateRawText: "[skill explain]\r\n`准備時間 -10%%`\r\n",
      requestedEncoding: "Cn",
      displaySelectedEncoding: "Cn",
      alternateEncoding: "Tw",
      pvfPath: "stackable/fixture.stk",
    });
    checks.push({
      id: "zero-match-identifies-declared-encoding-mismatch-without-rewrite",
      ok: encodingMismatchDiagnosis?.code === "CHANGE_TEXT_ENCODING_MISMATCH" &&
        encodingMismatchDiagnosis?.alternateRawOccurrenceCount === 1 &&
        encodingMismatchDiagnosis?.recovery?.pvfEncoding === "Tw" &&
        encodingMismatchDiagnosis?.automaticRewriteAttempted === false,
    });
    checks.push({
      id: "zero-match-diagnosis-does-not-guess-unknown-text",
      ok: diagnoseZeroOccurrenceSource({
        previousText: "`不存在`",
        textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      }, {
        rawOccurrenceCount: 0,
        displayText: "`准备时间`",
        alternateRawText: "`准備時間`",
      }) === null,
    });
    checks.push({
      id: "zero-match-diagnosis-never-overrides-an-actual-raw-match",
      ok: diagnoseZeroOccurrenceSource({
        previousText: "`准備時間`",
        textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      }, {
        rawOccurrenceCount: 1,
        displayText: "`准备时间`",
        alternateRawText: "`准備時間`",
      }) === null,
    });

    for (const count of [1, 3]) {
      const exactCountPlan = planReplacementGroup("A\r\nA\r\n", [{
        id: `count-${count}`, type: "replace-text", previousText: "A", newText: "B",
        replaceAll: true, expectedOccurrences: count, pvfEncoding: "Cn",
      }], { pvfPath: "etc/fixture.etc", pvfReadEncoding: "Cn", fallbackEncoding: "Cn" });
      checks.push({
        id: `replace-all-exact-count-${count}-blocked`,
        ok: exactCountPlan.items[0]?.blockCode === "OCCURRENCE_COUNT_MISMATCH",
      });
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

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function resolveExternalManifestPath(changeSetFile, value) {
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(path.dirname(changeSetFile), value);
}

function resolveCumulativeBaseline(changeSet, changeSetFile) {
  const declared = changeSet.baseline?.applyManifest;
  if (!declared) return null;
  const manifestPath = resolveExternalManifestPath(changeSetFile, declared);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw codedError("CUMULATIVE_BASELINE_MANIFEST_MISSING", `上一轮生成记录不存在：${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  if (
    manifest.schemaVersion !== "1.0" ||
    manifest.phase !== "phase-3-controlled-output-apply" ||
    manifest.mode !== "controlled-output-only" ||
    manifest.safety?.sourceOverwritten !== false ||
    manifest.safety?.sourceUnchanged !== true ||
    manifest.safety?.readbackOk !== true ||
    manifest.safety?.outputSha256Bound !== true ||
    manifest.summary?.readbackOk !== true ||
    manifest.summary?.outputSha256Verified !== true
  ) {
    throw codedError("CUMULATIVE_BASELINE_MANIFEST_UNVERIFIED", "上一轮生成记录未能证明源文件保持不变、输出完整复查且 SHA256 已绑定。");
  }
  const protectedSourcePvf = path.resolve(manifest.protectedSourcePvf || manifest.sourcePvf);
  const protectedSourcePvfSha256 = String(manifest.protectedSourcePvfSha256 || manifest.sourcePvfSha256 || "").toLowerCase();
  const baselinePvf = path.resolve(manifest.outputPvf || "");
  const baselinePvfSha256 = String(manifest.outputPvfSha256 || "").toLowerCase();
  const manifestChangedCount = Number(manifest.summary?.changedCount);
  if (!Number.isSafeInteger(manifestChangedCount) || manifestChangedCount < 0) {
    throw codedError("CUMULATIVE_BASELINE_MANIFEST_UNVERIFIED", "上一轮生成记录缺少有效的本轮改动数量。");
  }
  const manifestResultChangedCount = Array.isArray(manifest.results)
    ? manifest.results.filter((item) => item?.changed === true).length
    : null;
  if (manifestResultChangedCount !== null && manifestResultChangedCount !== manifestChangedCount) {
    throw codedError("CUMULATIVE_BASELINE_MANIFEST_UNVERIFIED", "上一轮生成记录的改动数量与逐条结果不一致。");
  }
  let previousChangeCount = manifestChangedCount;
  let chainDepth = 1;
  if (manifest.cumulative?.enabled === true) {
    const previousCount = Number(manifest.cumulative.previousChangeCount);
    const currentCount = Number(manifest.cumulative.currentChangeCount);
    const totalCount = Number(manifest.cumulative.totalChangeCount);
    const priorDepth = Number(manifest.cumulative.chainDepth);
    if (
      !samePath(manifest.cumulative.protectedSourcePvf || "", protectedSourcePvf) ||
      String(manifest.cumulative.protectedSourcePvfSha256 || "").toLowerCase() !== protectedSourcePvfSha256 ||
      !samePath(manifest.cumulative.inputPvf || "", manifest.sourcePvf || "") ||
      String(manifest.cumulative.inputPvfSha256 || "").toLowerCase() !== String(manifest.sourcePvfSha256 || "").toLowerCase() ||
      !Number.isSafeInteger(previousCount) || previousCount < 0 ||
      !Number.isSafeInteger(currentCount) || currentCount !== manifestChangedCount ||
      !Number.isSafeInteger(totalCount) || totalCount !== previousCount + currentCount ||
      !Number.isSafeInteger(priorDepth) || priorDepth < 1
    ) {
      throw codedError("CUMULATIVE_BASELINE_MANIFEST_UNVERIFIED", "上一轮核验记录中的累积链字段彼此不一致。");
    }
    previousChangeCount = totalCount;
    chainDepth = priorDepth + 1;
  } else if (manifest.cumulative && (
    manifest.cumulative.chainDepth !== undefined && Number(manifest.cumulative.chainDepth) !== 0 ||
    manifest.cumulative.previousChangeCount !== undefined && Number(manifest.cumulative.previousChangeCount) !== 0 ||
    manifest.cumulative.currentChangeCount !== undefined && Number(manifest.cumulative.currentChangeCount) !== manifestChangedCount ||
    manifest.cumulative.totalChangeCount !== undefined && Number(manifest.cumulative.totalChangeCount) !== manifestChangedCount
  )) {
    throw codedError("CUMULATIVE_BASELINE_MANIFEST_UNVERIFIED", "上一轮非累积生成记录中的数量字段彼此不一致。");
  }
  if (!/^[a-f0-9]{64}$/.test(protectedSourcePvfSha256) || !/^[a-f0-9]{64}$/.test(baselinePvfSha256)) {
    throw codedError("CUMULATIVE_BASELINE_MANIFEST_UNVERIFIED", "上一轮生成记录缺少有效的源/输出 SHA256。");
  }
  if (!fs.existsSync(protectedSourcePvf) || !fs.statSync(protectedSourcePvf).isFile()) {
    throw codedError("CUMULATIVE_PROTECTED_SOURCE_MISSING", `受保护源 PVF 不存在：${protectedSourcePvf}`);
  }
  if (!fs.existsSync(baselinePvf) || !fs.statSync(baselinePvf).isFile()) {
    throw codedError("CUMULATIVE_BASELINE_OUTPUT_MISSING", `上一轮输出 PVF 不存在：${baselinePvf}`);
  }
  if (sha256File(protectedSourcePvf).toLowerCase() !== protectedSourcePvfSha256) {
    throw codedError("CUMULATIVE_PROTECTED_SOURCE_CHANGED", "受保护源 PVF 已变化，不能继续上一轮基线。");
  }
  if (sha256File(baselinePvf).toLowerCase() !== baselinePvfSha256) {
    throw codedError("CUMULATIVE_BASELINE_OUTPUT_CHANGED", "上一轮输出 PVF 已变化，不能作为累积基线。");
  }
  if (samePath(protectedSourcePvf, baselinePvf)) {
    throw codedError("CUMULATIVE_BASELINE_SOURCE_COLLISION", "上一轮输出不能与受保护源 PVF 是同一文件。");
  }
  return {
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    manifest,
    protectedSourcePvf,
    protectedSourcePvfSha256,
    baselinePvf,
    baselinePvfSha256,
    previousChangeCount,
    chainDepth,
  };
}

function resolveChangeInput(changeSet, changeSetFile, explicitPvf, requestedProfile) {
  const cumulative = resolveCumulativeBaseline(changeSet, changeSetFile);
  if (!cumulative) {
    const resolvedSource = explicitPvf || requestedProfile
      ? resolveSourcePvf(workbenchRoot, requestedProfile, explicitPvf)
      : { sourcePvf: path.resolve(changeSet.target.sourcePvf), profile: null, source: "change-set" };
    return {
      sourcePvf: resolvedSource.sourcePvf,
      protectedSourcePvf: resolvedSource.sourcePvf,
      resolvedSource,
      cumulative: null,
    };
  }
  if (explicitPvf && !samePath(explicitPvf, cumulative.baselinePvf)) {
    throw codedError("CUMULATIVE_BASELINE_OVERRIDE_MISMATCH", "--pvf 必须指向上一轮生成记录绑定的输出 PVF；不要绕过累积基线。");
  }
  const profile = requestedProfile ? resolveSourcePvf(workbenchRoot, requestedProfile, null).profile : null;
  if (profile && !samePath(profile.sourcePvf, cumulative.protectedSourcePvf)) {
    throw codedError("CUMULATIVE_PROFILE_SOURCE_MISMATCH", "所选 profile 的受保护源与上一轮生成记录不一致。");
  }
  if (!samePath(path.resolve(changeSet.target.sourcePvf), cumulative.protectedSourcePvf)) {
    throw codedError("CUMULATIVE_CHANGE_SET_SOURCE_MISMATCH", "change-set target.sourcePvf 必须保持为累积链最初的受保护源 PVF。");
  }
  return {
    sourcePvf: cumulative.baselinePvf,
    protectedSourcePvf: cumulative.protectedSourcePvf,
    resolvedSource: {
      sourcePvf: cumulative.protectedSourcePvf,
      profile,
      source: "baseline.applyManifest",
    },
    cumulative,
  };
}

function cumulativeBaselineBinding(cumulative) {
  if (!cumulative) return null;
  return {
    previousApplyManifest: cumulative.manifestPath,
    previousApplyManifestSha256: cumulative.manifestSha256,
    inputPvf: cumulative.baselinePvf,
    inputPvfSha256: cumulative.baselinePvfSha256,
    protectedSourcePvf: cumulative.protectedSourcePvf,
    protectedSourcePvfSha256: cumulative.protectedSourcePvfSha256,
    previousChangeCount: cumulative.previousChangeCount,
    chainDepth: cumulative.chainDepth,
  };
}

function assertCumulativeBindingMatchesDryRun(cumulative, manifest) {
  const expected = cumulativeBaselineBinding(cumulative);
  const actual = manifest.cumulativeBaseline || null;
  const expectedSha256 = expected ? sha256(JSON.stringify(expected)) : null;
  const actualSha256 = actual ? sha256(JSON.stringify(actual)) : null;
  if (
    JSON.stringify(expected) !== JSON.stringify(actual) ||
    manifest.cumulativeBaselineSha256 !== expectedSha256 ||
    actualSha256 !== expectedSha256
  ) {
    throw codedError("CUMULATIVE_BASELINE_BINDING_MISMATCH", "累积基线与预演记录不一致；请重新预演。");
  }
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
  if (runner.contentAddressedSourceBackupRequired !== true || runner.existingSourceBackupSha256RecheckRequired !== true) {
    throw new Error("Controlled write runner must require a content-addressed source backup and recheck its SHA256 before reuse.");
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
    semanticSafety.verifiedInlineTextMultilineAllowed !== true ||
    semanticSafety.verifiedInlineTextBatchRequiresExactExpectedOccurrences !== true ||
    semanticSafety.exactAdjacentContextAnchoringAllowed !== true ||
    semanticSafety.contextAnchorDoesNotRelaxTextSafety !== true ||
    semanticSafety.sameFileChangesPlannedAsOneFinalText !== true ||
    semanticSafety.sameFileChangeOrderPreservedWhenRequired !== true ||
    semanticSafety.sameFileVerifiedInlineTextAppliedAsOneBatch !== true ||
    semanticSafety.stringTableAppendedOncePerVerifiedFileBatch !== true ||
    semanticSafety.stringLinkTextWriteAllowed !== false ||
    semanticSafety.cnAndTwRoundTripProbeRequired !== true ||
    semanticSafety.numericOrAsciiMinimalWriteAllowed !== true ||
    semanticSafety.clientTextSmokeCheckRequired !== true
  ) {
    throw new Error("Controlled write runner semantic text safety policy is incomplete or unsafe.");
  }
  const allowedBridgeTools = new Set(runner.allowedBridgeTools || []);
  for (const tool of ["pvf_open", "pvf_list_files", "pvf_read_file", "pvf_replace_text", "pvf_apply_text_plan", "pvf_apply_verified_text_plan", "pvf_write_file", "pvf_save", "pvf_close"]) {
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
  if (changeSet.baseline !== undefined) {
    if (!changeSet.baseline || typeof changeSet.baseline !== "object" || Array.isArray(changeSet.baseline)) {
      errors.push("baseline must be an object when present.");
    } else {
      if (typeof changeSet.baseline.applyManifest !== "string" || !changeSet.baseline.applyManifest.trim()) {
        errors.push("baseline.applyManifest is required when baseline is present.");
      }
      const extraBaselineKeys = Object.keys(changeSet.baseline).filter((key) => key !== "applyManifest");
      if (extraBaselineKeys.length > 0) errors.push(`baseline contains unsupported field(s): ${extraBaselineKeys.join(", ")}.`);
    }
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
    }
    if (change.type === "replace-text") {
      if (typeof change.previousText !== "string" || change.previousText.length === 0) {
        errors.push(`${prefix}.previousText is required.`);
      }
      if (typeof change.newText !== "string") {
        errors.push(`${prefix}.newText must be a string.`);
      }
      for (const field of ["contextBefore", "contextAfter"]) {
        if (change[field] !== undefined && (typeof change[field] !== "string" || change[field].length === 0)) {
          errors.push(`${prefix}.${field} must be a non-empty exact string when present.`);
        }
      }
      if (
        typeof change.previousText === "string" &&
        (
          (typeof change.contextBefore === "string" && change.contextBefore.includes(change.previousText)) ||
          (typeof change.contextAfter === "string" && change.contextAfter.includes(change.previousText))
        )
      ) {
        errors.push(`${prefix}.contextBefore/contextAfter must not contain previousText.`);
      }
      if (change.occurrenceIndex !== undefined) {
        errors.push(`${prefix}.occurrenceIndex is unsupported; use exact contextBefore/contextAfter instead.`);
      }
      if (/&#(?:\d+|x[0-9a-f]+);/i.test(change.newText)) {
        errors.push(`${prefix}.newText must not contain HTML numeric entities; use real characters from raw/no-simplified target readback.`);
      }
      if (change.replaceAll !== undefined && typeof change.replaceAll !== "boolean") {
        errors.push(`${prefix}.replaceAll must be boolean when present.`);
      }
      if (change.expectedOccurrences !== undefined && (!Number.isSafeInteger(change.expectedOccurrences) || change.expectedOccurrences < 1)) {
        errors.push(`${prefix}.expectedOccurrences must be a positive integer when present.`);
      }
      if (change.replaceAll === true && !Number.isSafeInteger(change.expectedOccurrences)) {
        errors.push(`${prefix}.expectedOccurrences is required when replaceAll=true.`);
      }
      if (change.replaceAll !== true && change.expectedOccurrences !== undefined && change.expectedOccurrences !== 1) {
        errors.push(`${prefix}.expectedOccurrences must be 1 unless replaceAll=true.`);
      }
      if (change.textWriteMode !== undefined && !isVerifiedInlineTextMode(change.textWriteMode)) {
        errors.push(`${prefix}.textWriteMode must be ${VERIFIED_INLINE_TEXT_MODE} (legacy ${VERIFIED_INLINE_CN_TEXT_MODE} is also accepted) when present.`);
      }
      const nonAsciiPayload = containsNonAscii(change.previousText) || containsNonAscii(change.newText);
      if (nonAsciiPayload && !isVerifiedInlineTextMode(change.textWriteMode)) {
        errors.push(`[NON_ASCII_TEXT_WRITE_UNVERIFIED] ${prefix} contains Chinese or other non-ASCII text; keep the complete backtick token and set textWriteMode to ${VERIFIED_INLINE_TEXT_MODE}.`);
      }
      if (isVerifiedInlineTextMode(change.textWriteMode)) {
        if (!completeBacktickToken(change.previousText) || !completeBacktickToken(change.newText)) {
          errors.push(`[CN_TEXT_TOKEN_REQUIRED] ${prefix}.previousText and newText must each be one complete backtick token in verified inline text mode.`);
        }
        if (!new Set(["Cn", "Tw"]).has(change.pvfEncoding)) {
          errors.push(`[TEXT_ENCODING_REQUIRED] ${prefix}.pvfEncoding must be the Cn or Tw encoding selected by pvf-read --raw.`);
        }
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

function groupChangesByPvfPath(changes) {
  const groups = new Map();
  for (const change of changes) {
    const pvfPath = normalizePvfPath(change.pvfPath);
    const key = pvfPath.toLowerCase();
    if (!groups.has(key)) groups.set(key, { pvfPath, changes: [] });
    groups.get(key).changes.push(change);
  }
  return [...groups.values()];
}

function planReplacementGroup(sourceText, changes, context = {}) {
  let currentText = String(sourceText || "");
  const items = [];
  let blocked = false;
  for (const change of changes) {
    const before = currentText;
    let anchored = null;
    let failure = null;
    try {
      anchored = analyzeContextAnchoredReplacement({
        sourceText: before,
        previousText: change.previousText,
        newText: change.newText,
        contextBefore: change.contextBefore,
        contextAfter: change.contextAfter,
        replaceAll: change.replaceAll === true,
        expectedOccurrences: change.expectedOccurrences,
      });
      const mismatch = occurrenceMismatch(anchored);
      if (mismatch) failure = { code: mismatch.code, reason: mismatch.message, details: mismatch.details || null };
    } catch (error) {
      failure = { code: error.code || "CONTEXT_ANCHOR_INVALID", reason: error.message, details: error.details || null };
    }
    let writeSafety = null;
    let after = before;
    if (!failure) {
      writeSafety = semanticWriteSafety({
        kind: "replace-text",
        pvfPath: context.pvfPath,
        pvfEncoding: change.pvfEncoding || context.pvfReadEncoding,
        fallbackEncoding: context.fallbackEncoding,
        previousText: change.previousText,
        newText: change.newText,
        contextBefore: change.contextBefore,
        contextAfter: change.contextAfter,
        replaceAll: change.replaceAll === true,
        expectedOccurrences: anchored.expectedOccurrences,
        textWriteMode: change.textWriteMode,
        sourceText: before,
      });
      if (writeSafety.allowed) {
        after = applyContextAnchoredReplacement({
          sourceText: before,
          previousText: change.previousText,
          newText: change.newText,
        }, anchored);
      }
    }
    const applicable = !blocked && !failure && writeSafety?.allowed === true;
    const resolvedFailure = failure || (!blocked && writeSafety?.allowed !== true
      ? {
        code: writeSafety?.code || "SEMANTIC_WRITE_BLOCKED",
        reason: writeSafety?.reason || "改动未通过语义写入检查。",
        details: writeSafety?.details || null,
      }
      : null);
    const item = {
      change,
      before,
      after: applicable ? after : before,
      occurrenceCount: anchored?.occurrenceCount ?? 0,
      totalOccurrenceCount: anchored?.totalOccurrenceCount ?? 0,
      expectedOccurrences: anchored?.expectedOccurrences ?? (change.replaceAll === true ? change.expectedOccurrences : 1),
      occurrenceApplicable: anchored?.occurrenceApplicable === true,
      contextAnchor: anchored?.evidence || null,
      applicable,
      changed: applicable && after !== before,
      semanticWriteSafety: writeSafety,
      blockCode: applicable ? null : (blocked ? "FILE_CHANGE_SEQUENCE_BLOCKED" : resolvedFailure?.code),
      blockReason: applicable ? null : (blocked
        ? "同一文件中更早的改动未通过，后续改动未继续计算。"
        : resolvedFailure?.reason),
      blockDetails: applicable ? null : (blocked ? null : resolvedFailure?.details),
    };
    items.push(item);
    if (!applicable) blocked = true;
    else currentText = after;
  }
  return { sourceText, expectedText: currentText, items, blocked };
}

function buildSameFileApplicationPlan(plan) {
  const ordinaryItems = plan.items.filter((item) => item.changed && !isVerifiedInlineTextMode(item.change.textWriteMode));
  const verifiedItems = plan.items.filter((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode));
  const failures = [];

  // Keep every verified text change in one batch, but allow that batch to sit
  // before, after, or between ordinary structure changes. Prefer the legacy
  // ordinary-first placement when changes commute. A placement is accepted
  // only when every exact selector still matches and the declared final text
  // is byte-for-byte identical to the original ordered plan.
  for (let verifiedInsertionIndex = ordinaryItems.length; verifiedInsertionIndex >= 0; verifiedInsertionIndex -= 1) {
    const beforeVerifiedItems = ordinaryItems.slice(0, verifiedInsertionIndex);
    const afterVerifiedItems = ordinaryItems.slice(verifiedInsertionIndex);
    const orderedItems = [...beforeVerifiedItems, ...verifiedItems, ...afterVerifiedItems];
    const analyses = new Map();
    let finalText = plan.sourceText;
    let failure = null;
    for (const item of orderedItems) {
      try {
        const anchored = analyzeContextAnchoredReplacement({
          sourceText: finalText,
          previousText: item.change.previousText,
          newText: item.change.newText,
          contextBefore: item.change.contextBefore,
          contextAfter: item.change.contextAfter,
          replaceAll: item.change.replaceAll === true,
          expectedOccurrences: item.expectedOccurrences,
        });
        const mismatch = occurrenceMismatch(anchored);
        if (mismatch) throw mismatch;
        analyses.set(item, anchored);
        finalText = applyContextAnchoredReplacement({
          sourceText: finalText,
          previousText: item.change.previousText,
          newText: item.change.newText,
        }, anchored);
      } catch (cause) {
        failure = { id: item.change.id, cause };
        break;
      }
    }
    if (!failure && finalText === plan.expectedText) {
      for (const [item, anchored] of analyses) {
        item.applicationContextAnchor = anchored.evidence;
        item.contextAnchor = anchored.evidence;
        item.occurrenceCount = anchored.occurrenceCount;
        item.totalOccurrenceCount = anchored.totalOccurrenceCount;
      }
      const stages = [];
      if (beforeVerifiedItems.length > 0) stages.push({ kind: "ordinary", items: beforeVerifiedItems });
      if (verifiedItems.length > 0) stages.push({ kind: "verified", items: verifiedItems });
      if (afterVerifiedItems.length > 0) stages.push({ kind: "ordinary", items: afterVerifiedItems });
      return {
        ordinaryItems,
        verifiedItems,
        beforeVerifiedItems,
        afterVerifiedItems,
        verifiedInsertionIndex,
        stages,
        requiresTemporaryOrderedProof: verifiedItems.length > 0 && afterVerifiedItems.length > 0,
        finalText,
      };
    }
    failures.push(failure || { id: null, cause: new Error("candidate final text differed") });
  }

  const firstFailure = failures.find((entry) => entry?.id) || failures[0];
  const error = new Error(
    `同一文件无法在保持一次文字批处理的同时得到声明的最终结果${firstFailure?.id ? `：${firstFailure.id}` : ""}。`,
  );
  error.code = "FILE_CHANGE_REORDER_UNSAFE";
  error.cause = firstFailure?.cause;
  throw error;
}

function rawTextOptions(changeSet, change, adapterConfig) {
  return {
    pvfEncoding: change?.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
    // Change-set writes must operate on source text, not simplified display text.
    // Simplified display text can be serialized back as HTML numeric entities in TW PVFs.
    convertToSimplifiedChinese: false,
  };
}

function countExactOccurrences(sourceText, previousText) {
  const source = String(sourceText || "");
  const target = String(previousText || "");
  if (!target) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(target, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + target.length;
  }
}

function diagnoseZeroOccurrenceSource(change, evidence = {}) {
  if (!change || !isVerifiedInlineTextMode(change.textWriteMode)) return null;
  if (Number(evidence.rawOccurrenceCount || 0) !== 0) return null;
  const previousText = String(change.previousText || "");
  if (!previousText) return null;
  const displayOccurrenceCount = countExactOccurrences(evidence.displayText, previousText);
  if (displayOccurrenceCount > 0) {
    return {
      code: "DISPLAY_TEXT_USED_AS_CHANGE_SOURCE",
      message: "previousText 在便于阅读的显示文本中可以命中，但在修改校验使用的原始文本中为 0 次。显示结果可能已经转成简体或整理布局，不能直接作为修改原文。",
      rawOccurrenceCount: 0,
      displayOccurrenceCount,
      requestedEncoding: evidence.requestedEncoding || null,
      selectedEncoding: evidence.displaySelectedEncoding || evidence.requestedEncoding || null,
      safeStop: true,
      automaticRewriteAttempted: false,
      recovery: {
        command: "pvf-read read --raw",
        pvfPath: evidence.pvfPath || change.pvfPath || null,
        pvfEncoding: evidence.displaySelectedEncoding || evidence.requestedEncoding || null,
        instruction: "对同一 PVF 路径重新原始读取，并从结果复制完整 previousText；不要手工转换繁简体或猜另一种编码。",
      },
    };
  }
  const alternateRawOccurrenceCount = countExactOccurrences(evidence.alternateRawText, previousText);
  if (alternateRawOccurrenceCount > 0) {
    return {
      code: "CHANGE_TEXT_ENCODING_MISMATCH",
      message: `previousText 只在 ${evidence.alternateEncoding || "另一种"} 编码的原始读回中命中，当前声明编码不一致；工作台已停止，不会自动跨编码写入。`,
      rawOccurrenceCount: 0,
      alternateRawOccurrenceCount,
      requestedEncoding: evidence.requestedEncoding || null,
      alternateEncoding: evidence.alternateEncoding || null,
      safeStop: true,
      automaticRewriteAttempted: false,
      recovery: {
        command: "pvf-read read --raw",
        pvfPath: evidence.pvfPath || change.pvfPath || null,
        pvfEncoding: evidence.alternateEncoding || null,
        instruction: "先按提示编码重新原始读取并人工确认文字正常，再从该结果重建 change-set；不要沿用当前 previousText。",
      },
    };
  }
  return null;
}

async function diagnoseZeroOccurrenceItems(client, sessionId, plan, changeSet, adapterConfig) {
  const candidates = plan.items.filter((item) =>
    item.blockCode === "OCCURRENCE_COUNT_MISMATCH" &&
    item.occurrenceCount === 0 &&
    isVerifiedInlineTextMode(item.change.textWriteMode));
  if (candidates.length === 0) return;
  const firstChange = candidates[0].change;
  const requestedEncoding = firstChange.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
  let displayRead = null;
  try {
    displayRead = await callAndParse(client, "pvf_read_file", {
      sessionId,
      pvfPath: plan.pvfPath,
      pvfEncoding: requestedEncoding,
      decompileScript: true,
      autoConvertStringLink: false,
      useCompatibleDecompiler: true,
      convertToSimplifiedChinese: true,
      semanticVerificationRead: false,
      maxChars: 0,
    });
  } catch {
    // Diagnosis must never replace the primary exact-match safety failure.
  }
  const displaySelectedEncoding = displayRead?.semanticReadGuard?.selectedEncoding || requestedEncoding;
  let alternateRead = null;
  let alternateEncoding = null;
  if (!displayRead || candidates.some((item) => countExactOccurrences(displayRead.textContent, item.change.previousText) === 0)) {
    alternateEncoding = requestedEncoding === "Cn" ? "Tw" : requestedEncoding === "Tw" ? "Cn" : null;
    if (alternateEncoding) {
      try {
        alternateRead = await callAndParse(client, "pvf_read_file", {
          sessionId,
          pvfPath: plan.pvfPath,
          pvfEncoding: alternateEncoding,
          decompileScript: true,
          autoConvertStringLink: false,
          useCompatibleDecompiler: true,
          convertToSimplifiedChinese: false,
          semanticVerificationRead: true,
          maxChars: 0,
        });
      } catch {
        // Keep the ordinary occurrence mismatch when alternate read is unavailable.
      }
    }
  }
  for (const item of candidates) {
    const diagnosis = diagnoseZeroOccurrenceSource(item.change, {
      rawOccurrenceCount: item.occurrenceCount,
      displayText: displayRead?.textContent,
      alternateRawText: alternateRead?.textContent,
      requestedEncoding,
      displaySelectedEncoding,
      alternateEncoding,
      pvfPath: plan.pvfPath,
    });
    if (!diagnosis) continue;
    item.blockDetails = { ...(item.blockDetails || {}), sourceTextDiagnosis: diagnosis };
    item.blockReason = `${item.blockReason} ${diagnosis.message}`;
  }
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
    if (parsed?.data?.details) error.details = parsed.data.details;
    throw error;
  }
  return parseBackendTextResult(result);
}

async function applyFilePlansCoherently({
  client,
  sessionId,
  filePlans,
  changeSet,
  adapterConfig,
}) {
  const coordinatedPlans = filePlans.map((plan) => ({ ...plan, application: buildSameFileApplicationPlan(plan) }));
  let activeSessionId = sessionId;
  const ordinaryResults = new Map();
  const verifiedResults = new Map();
  const verifiedBatchResults = new Map();
  const applyOrdinaryStage = async (plan, items) => {
    if (items.length === 0) return;
    const applied = await callAndParse(client, "pvf_apply_text_plan", {
      sessionId: activeSessionId,
      pvfPath: plan.pvfPath,
      ...rawTextOptions(changeSet, items[0].change, adapterConfig),
      dryRun: false,
      changes: items.map((item) => ({
        id: item.change.id,
        previousText: item.change.previousText,
        newText: item.change.newText,
        contextBefore: item.change.contextBefore,
        contextAfter: item.change.contextAfter,
        replaceAll: item.change.replaceAll === true,
        expectedOccurrences: item.expectedOccurrences,
      })),
    });
    for (const item of items) {
      ordinaryResults.set(item.change.id, {
        ok: applied?.ok === true,
        dryRun: false,
        pvfPath: plan.pvfPath,
        writeResult: applied?.results?.find((entry) => entry.id === item.change.id) || null,
        semanticReadGuard: applied?.semanticReadGuard || null,
      });
    }
  };
  const applyVerifiedStage = async (plan, verifiedItems) => {
    if (verifiedItems.length === 0) return;
    const firstChange = verifiedItems[0].change;
    const applied = await callAndParse(client, "pvf_apply_verified_text_plan", {
      sessionId: activeSessionId,
      pvfPath: plan.pvfPath,
      ...rawTextOptions(changeSet, firstChange, adapterConfig),
      changes: verifiedItems.map((item) => ({
        id: item.change.id,
        previousText: item.change.previousText,
        newText: item.change.newText,
        contextBefore: item.change.contextBefore,
        contextAfter: item.change.contextAfter,
        replaceAll: item.change.replaceAll === true,
        expectedOccurrences: item.expectedOccurrences,
        textWriteMode: item.change.textWriteMode,
        pvfEncoding: item.change.pvfEncoding || firstChange.pvfEncoding,
      })),
    });
    const batchWriteResult = applied?.writeResult || {};
    verifiedBatchResults.set(plan.pvfPath, {
      ok: applied?.ok === true && batchWriteResult.ok !== false,
      pvfPath: plan.pvfPath,
      mode: batchWriteResult.mode || null,
      encoding: batchWriteResult.encoding || null,
      changeCount: batchWriteResult.changeCount || verifiedItems.length,
      proof: batchWriteResult.proof || null,
      semanticReadGuard: applied?.semanticReadGuard || null,
    });
    for (const item of verifiedItems) {
      const itemProof = batchWriteResult.proofs?.find((proof) => proof.id === item.change.id) || null;
      verifiedResults.set(item.change.id, {
        ok: applied?.ok === true && batchWriteResult.ok !== false,
        dryRun: false,
        pvfPath: plan.pvfPath,
        semanticReadGuard: applied?.semanticReadGuard || null,
        batch: {
          mode: batchWriteResult.mode || null,
          encoding: batchWriteResult.encoding || null,
          changeCount: batchWriteResult.changeCount || verifiedItems.length,
        },
        writeResult: {
          ok: batchWriteResult.ok === true,
          skipped: batchWriteResult.skipped === true,
          reason: batchWriteResult.reason || null,
          mode: batchWriteResult.mode || null,
          encoding: batchWriteResult.encoding || null,
          stringTableUpdated: Boolean(batchWriteResult.stringTableResult),
          scriptUpdated: Boolean(batchWriteResult.scriptResult),
          proof: itemProof,
        },
      });
    }
  };
  for (const plan of coordinatedPlans) {
    for (const stage of plan.application.stages) {
      if (stage.kind === "ordinary") {
        await applyOrdinaryStage(plan, stage.items);
      } else {
        await applyVerifiedStage(plan, stage.items);
      }
    }
  }
  return { sessionId: activeSessionId, coordinatedPlans, ordinaryResults, verifiedResults, verifiedBatchResults };
}

async function runVerifiedInlineTextRoundTripProbe({
  sourcePvf,
  changeSet,
  adapterConfig,
  writePolicy,
  filePlans,
}) {
  const outcomes = new Map();
  const ordinaryProofs = new Map();
  const probePlans = (Array.isArray(filePlans) ? filePlans : [])
    .filter((plan) => plan.items.some((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode)));
  if (probePlans.length === 0) return { outcomes, ordinaryProofs };
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
    const coordinated = await applyFilePlansCoherently({
      client,
      sessionId: sourceSessionId,
      filePlans: probePlans,
      changeSet,
      adapterConfig,
    });
    sourceSessionId = coordinated.sessionId;
    for (const plan of probePlans) {
      for (const item of plan.items.filter((entry) => entry.changed && !isVerifiedInlineTextMode(entry.change.textWriteMode))) {
        const applied = coordinated.ordinaryResults.get(item.change.id);
        if (applied?.writeResult) ordinaryProofs.set(item.change.id, applied.writeResult);
      }
    }
    for (const plan of probePlans) {
      for (const item of plan.items.filter((entry) => entry.changed && isVerifiedInlineTextMode(entry.change.textWriteMode))) {
        const applied = coordinated.verifiedResults.get(item.change.id) || null;
        outcomes.set(item.change.id, {
          ok: false,
          code: "CN_TEXT_ROUNDTRIP_INCOMPLETE",
          reason: "中文文本临时写出尚未完成独立读回。",
          writerProof: applied?.writeResult?.proof || null,
          temporaryOutputRetained: false,
        });
      }
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
    for (const plan of probePlans) {
      const verifiedItems = plan.items.filter((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode));
      const probeEncoding = verifiedItems[0].change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const readback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: plan.pvfPath,
        pvfEncoding: probeEncoding,
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
        maxChars: 0,
      });
      const comparison = pvfTextReadbackResult(plan.expectedText, readback.textContent);
      const independentSemanticRead =
        readback.semanticReadGuard?.applied === true &&
        readback.semanticReadGuard?.reason === "verified-text-readback" &&
        readback.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
        readback.semanticReadGuard?.selectedEncoding === probeEncoding;
      const sourceUnchanged = sha256File(sourcePvf) === sourceSha256Before;
      for (const item of verifiedItems) {
        const writerProof = outcomes.get(item.change.id)?.writerProof || null;
        const itemEncoding = item.change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
        const ok = comparison.exactTextOk === true && independentSemanticRead &&
          writerProof?.encoding === itemEncoding && writerProof?.existingStringEntriesPreserved === true && sourceUnchanged;
        outcomes.set(item.change.id, {
          ok,
          code: ok ? null : "CN_TEXT_ROUNDTRIP_FAILED",
          reason: ok
            ? "同一文件的参数与文字改动已一起通过临时输出、独立解析和既有字符串保持检查。"
            : "同一文件的最终结果未通过临时输出精确复查，已阻止生成批准码。",
          sourceUnchanged,
          sourcePvfSha256: sourceSha256Before,
          independentSemanticRead,
          semanticReadGuard: readback.semanticReadGuard || null,
          comparison,
          writerProof,
          fileChangeCount: plan.items.filter((entry) => entry.changed).length,
          filePlanSha256: sha256(JSON.stringify({
            pvfPath: plan.pvfPath,
            expectedTextSha256: sha256(plan.expectedText),
            changeIds: plan.items.filter((entry) => entry.changed).map((entry) => entry.change.id),
          })),
          temporaryOutputSha256: sha256File(outputPvf),
          temporaryOutputRetained: false,
        });
      }
    }
  } catch (error) {
    for (const plan of probePlans) for (const item of plan.items.filter((entry) => entry.changed && isVerifiedInlineTextMode(entry.change.textWriteMode))) {
      const existing = outcomes.get(item.change.id) || {};
      outcomes.set(item.change.id, {
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
  return { outcomes, ordinaryProofs };
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
  const input = resolveChangeInput(changeSet, changeSetFile, explicitPvf, requestedProfile);
  const resolvedSource = input.resolvedSource;
  const sourcePvf = input.sourcePvf;
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
  const replacementPlans = [];
  const rawAsciiPlanProofs = new Map();
  const directoryCache = new Map();
  try {
    for (const group of groupChangesByPvfPath(changeSet.changes)) {
      const pvfPath = group.pvfPath;
      for (const change of group.changes) for (const required of change.requiredResolvedIds || []) {
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
      const writeFileChanges = group.changes.filter((change) => change.type === "write-file");
      const replaceChanges = group.changes.filter((change) => change.type === "replace-text");
      if (writeFileChanges.length && replaceChanges.length) {
        throw new Error(`同一目标路径不能同时包含 write-file 和 replace-text：${pvfPath}`);
      }
      if (writeFileChanges.length > 1) {
        throw new Error(`同一目标路径只能有一条 write-file：${pvfPath}`);
      }
      if (writeFileChanges.length === 1) {
        const change = writeFileChanges[0];
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
      const encodings = new Set(replaceChanges.map((change) =>
        change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding));
      if (encodings.size !== 1) {
        for (const change of replaceChanges) results.push({
          id: change.id, type: change.type, pvfPath, applicable: false, changed: false,
          blockCode: "FILE_CHANGE_ENCODING_CONFLICT",
          blockReason: "同一文件的多条改动必须使用同一种 PVF 编码。",
          rationale: change.rationale || "",
        });
        continue;
      }
      const read = await callAndParse(client, "pvf_read_file", {
        sessionId,
        pvfPath,
        ...rawTextOptions(changeSet, replaceChanges[0], adapterConfig),
        semanticVerificationRead: true,
        maxChars: 0,
      });
      if (typeof read.textContent !== "string") {
        throw new Error(`PVF file is not readable as text for dry-run replacement: ${pvfPath}`);
      }
      const plan = planReplacementGroup(read.textContent, replaceChanges, {
        pvfPath,
        pvfReadEncoding: changeSet.target.pvfReadEncoding,
        fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
      });
      plan.pvfPath = pvfPath;
      if (plan.blocked) {
        await diagnoseZeroOccurrenceItems(client, sessionId, plan, changeSet, adapterConfig);
      }
      if (!plan.blocked) {
        try {
          const application = buildSameFileApplicationPlan(plan);
          if (application.ordinaryItems.length > 0 && !application.requiresTemporaryOrderedProof) {
            const proof = await callAndParse(client, "pvf_apply_text_plan", {
              sessionId,
              pvfPath,
              pvfEncoding: replaceChanges[0].pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
              dryRun: true,
              changes: application.ordinaryItems.map((item) => ({
                id: item.change.id,
                previousText: item.change.previousText,
                newText: item.change.newText,
                contextBefore: item.change.contextBefore,
                contextAfter: item.change.contextAfter,
                replaceAll: item.change.replaceAll === true,
                expectedOccurrences: item.expectedOccurrences,
              })),
            });
            for (const item of application.ordinaryItems) {
              rawAsciiPlanProofs.set(item.change.id, proof.results?.find((entry) => entry.id === item.change.id) || null);
            }
          }
        } catch (error) {
          const firstOrdinary = plan.items.find((item) => item.changed && !isVerifiedInlineTextMode(item.change.textWriteMode));
          if (firstOrdinary) {
            firstOrdinary.applicable = false;
            firstOrdinary.changed = false;
            firstOrdinary.blockCode = error.code || "RAW_ASCII_TOKEN_PLAN_UNSAFE";
            firstOrdinary.blockReason = error.message;
            plan.blocked = true;
          }
        }
      }
      replacementPlans.push(plan);
      for (const item of plan.items) {
        const change = item.change;
        results.push({
          id: change.id,
          type: change.type,
          pvfPath,
          textWriteMode: change.textWriteMode || null,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          occurrenceCount: item.occurrenceCount,
          totalOccurrenceCount: item.totalOccurrenceCount,
          expectedOccurrences: item.expectedOccurrences,
          contextAnchor: item.contextAnchor,
          replaceAll: change.replaceAll === true,
          occurrenceApplicable: item.occurrenceApplicable,
          applicable: item.applicable,
          changed: item.changed,
          fileMetadata: read.metadata,
          diff: diffSummary(item.before, item.after),
          finalFileExpectedSha256: sha256(plan.expectedText),
          semanticReadGuard: read.semanticReadGuard || null,
          semanticWriteSafety: item.semanticWriteSafety,
          blockCode: item.blockCode || null,
          blockReason: item.blockReason || null,
          blockDetails: item.blockDetails || null,
          rawAsciiTokenPlanProof: rawAsciiPlanProofs.get(change.id) || null,
          rationale: change.rationale || "",
        });
      }
    }
  } finally {
    try {
      await callAndParse(client, "pvf_close", { sessionId });
    } finally {
      client.stop();
    }
  }

  const probeResult = await runVerifiedInlineTextRoundTripProbe({
    sourcePvf,
    changeSet,
    adapterConfig,
    writePolicy,
    filePlans: replacementPlans.filter((plan) => !plan.blocked),
  });
  const probeOutcomes = probeResult.outcomes;
  for (const [changeId, proof] of probeResult.ordinaryProofs) {
    rawAsciiPlanProofs.set(changeId, proof);
    const result = results.find((entry) => entry.id === changeId);
    if (result) result.rawAsciiTokenPlanProof = proof;
  }
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
    temporaryVerificationWriteOperationsExecuted: replacementPlans.some((plan) =>
      !plan.blocked && plan.items.some((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode))),
    sourcePvf,
    protectedSourcePvf: input.protectedSourcePvf,
    protectedSourcePvfSha256: input.cumulative?.protectedSourcePvfSha256 || sourcePvfSha256AtEnd,
    cumulativeBaseline: cumulativeBaselineBinding(input.cumulative),
    cumulativeBaselineSha256: input.cumulative
      ? sha256(JSON.stringify(cumulativeBaselineBinding(input.cumulative)))
      : null,
    changeSetFile: path.resolve(changeSetFile),
    safety: {
      writeToolsEnabled: false,
      publicWriteToolsEnabled: false,
      backupRequiredBeforeFutureApply: true,
      explicitOutputRequiredBeforeFutureApply: true,
      readbackRequiredBeforeFutureApply: true,
      semanticWriteGuardEnabled: true,
      verifiedInlineTextWriteAllowed: true,
      exactAdjacentContextAnchoringAllowed: true,
      contextAnchorDoesNotRelaxTextSafety: true,
      cumulativeBaselineDeclared: Boolean(input.cumulative),
      cumulativeBaselineManifestVerified: input.cumulative ? true : null,
      unverifiedDirectNonAsciiTextWriteAllowed: false,
      cnStrWriteAllowed: false,
      stringLinkTextWriteAllowed: false,
      temporaryIsolatedEncodingProbeExecuted: replacementPlans.some((plan) =>
        !plan.blocked && plan.items.some((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode))),
      sameFileVerifiedInlineTextAppliedAsOneBatch: true,
      stringTableAppendedOncePerVerifiedFileBatch: true,
      temporaryProbeOutputsRetained: false,
    },
    summary: {
      changeCount: results.length,
      applicableCount: results.filter((item) => item.applicable).length,
      changedCount: results.filter((item) => item.changed).length,
      blockedCount: results.filter((item) => !item.applicable).length,
      clientTextSmokeCheckRequiredCount: results.filter((item) => item.semanticWriteSafety?.clientTextSmokeCheckRequired).length,
    },
    binding: dryRunManifestBinding(
      results,
      sourcePvf,
      sourcePvfSha256AtEnd,
      changeSetFile,
      changeSetFileSha256AtEnd,
      results.filter((item) => !item.applicable).length,
    ),
    results,
  };
  const manifestPath = path.join(outRoot, writePolicy.outputs?.dryRunManifestFileName || "DRY-RUN-MANIFEST.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { manifestPath, manifest };
}

function resolveApplyPaths(
  writePolicy,
  sourcePvf,
  sourcePvfSha256,
  resolvedSource,
  protectedSourcePvf = sourcePvf,
  protectedSourcePvfSha256 = sourcePvfSha256,
) {
  const outputPvfArg = option("--output-pvf");
  const outArg = option("--out");
  if (!outputPvfArg && !outArg) {
    throw new Error("apply requires --out <directory> or --output-pvf <path>.");
  }
  const runRoot = outputPvfArg ? path.dirname(path.resolve(outputPvfArg)) : path.resolve(outArg);
  if (pathInside(workbenchRoot, runRoot)) {
    const error = new Error(`Apply outputs and source backups must stay outside the clean Workbench: ${runRoot}`);
    error.code = "APPLY_OUTPUT_INSIDE_WORKBENCH";
    throw error;
  }
  const outputPvf = outputPvfArg
    ? path.resolve(outputPvfArg)
    : path.join(runRoot, "output", writePolicy.outputs?.outputFileName || "Script.pvf");
  if (samePath(sourcePvf, outputPvf)) {
    throw new Error("Refusing to save output PVF over the source PVF.");
  }
  if (samePath(protectedSourcePvf, outputPvf)) {
    throw new Error("Refusing to save output PVF over the protected source PVF.");
  }
  const backupStoreRoot = resolvedSource.profile?.output
    ? path.resolve(resolvedSource.profile.output)
    : outputPvfArg ? runRoot : path.dirname(runRoot);
  const backupPath = sourceBackupPath(protectedSourcePvf, protectedSourcePvfSha256, backupStoreRoot);
  if (pathInside(workbenchRoot, backupPath)) {
    const error = new Error(`Source backups must stay outside the clean Workbench: ${backupPath}`);
    error.code = "SOURCE_BACKUP_INSIDE_WORKBENCH";
    throw error;
  }
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
  const input = resolveChangeInput(changeSet, changeSetFile, explicitPvf, requestedProfile);
  const resolvedSource = input.resolvedSource;
  const sourcePvf = input.sourcePvf;
  if (!fs.existsSync(sourcePvf)) {
    throw new Error(`PVF file does not exist: ${sourcePvf}`);
  }
  const inputPvfSha256AtStart = sha256File(sourcePvf);
  const protectedSourcePvfSha256AtStart = sha256File(input.protectedSourcePvf);

  const authorization = verifyDryRunAuthorization(sourcePvf, changeSetFile);
  assertCumulativeBindingMatchesDryRun(input.cumulative, authorization.manifest);
  if (loadedChangeSetSha256 && authorization.changeSetFileSha256 !== loadedChangeSetSha256) {
    const error = new Error("Change-set changed while apply was loading it; run dry-run again.");
    error.code = "CHANGE_SET_CHANGED_DURING_APPLY";
    throw error;
  }
  if (
    inputPvfSha256AtStart !== authorization.sourcePvfSha256 ||
    protectedSourcePvfSha256AtStart !== (input.cumulative?.protectedSourcePvfSha256 || authorization.sourcePvfSha256)
  ) {
    throw codedError("APPLY_SOURCE_IDENTITY_CHANGED", "本轮输入或受保护源在正式生成前发生变化；请重新预演。");
  }

  const paths = resolveApplyPaths(
    writePolicy,
    sourcePvf,
    authorization.sourcePvfSha256,
    resolvedSource,
    input.protectedSourcePvf,
    input.cumulative?.protectedSourcePvfSha256 || authorization.sourcePvfSha256,
  );
  for (const [label, candidate] of [
    ["output PVF", paths.outputPvf],
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
  let activeApplySessionId = sessionId;
  const replacementPlans = [];
  if (changeSet.changes.some((change) => change.type === "write-file") && changeSet.changes.some((change) => change.type === "replace-text")) {
    throw new Error("同一个 change-set 暂不允许混合新增文件与现有文件替换；请拆分为两个受控步骤。");
  }

  try {
    for (const group of groupChangesByPvfPath(changeSet.changes)) {
      const pvfPath = group.pvfPath;
      for (const change of group.changes) for (const required of change.requiredResolvedIds || []) {
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
      const writeFileChanges = group.changes.filter((change) => change.type === "write-file");
      const replaceChanges = group.changes.filter((change) => change.type === "replace-text");
      if (writeFileChanges.length && replaceChanges.length) throw new Error(`同一目标路径不能混用 write-file 和 replace-text：${pvfPath}`);
      if (writeFileChanges.length > 1) throw new Error(`同一目标路径只能有一条 write-file：${pvfPath}`);
      if (writeFileChanges.length === 1) {
        const change = writeFileChanges[0];
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
      const encodings = new Set(replaceChanges.map((change) =>
        change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding));
      if (encodings.size !== 1) {
        const error = new Error(`同一文件的多条改动必须使用同一种 PVF 编码：${pvfPath}`);
        error.code = "FILE_CHANGE_ENCODING_CONFLICT";
        throw error;
      }
      const beforeRead = await callAndParse(client, "pvf_read_file", {
        sessionId,
        pvfPath,
        ...rawTextOptions(changeSet, replaceChanges[0], adapterConfig),
        semanticVerificationRead: true,
        maxChars: 0,
      });
      if (typeof beforeRead.textContent !== "string") {
        throw new Error(`PVF file is not readable as text for apply: ${pvfPath}`);
      }
      const plan = planReplacementGroup(beforeRead.textContent, replaceChanges, {
        pvfPath,
        pvfReadEncoding: changeSet.target.pvfReadEncoding,
        fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
      });
      if (plan.blocked) {
        const blocked = plan.items.find((item) => !item.applicable);
        const error = new Error(`Change ${blocked.change.id} is blocked: ${blocked.blockReason}`);
        error.code = blocked.blockCode;
        throw error;
      }
      buildSameFileApplicationPlan(plan);
      for (const item of plan.items) {
        const authorized = authorizedResults.get(item.change.id);
        const currentAnchor = item.contextAnchor;
        if (!authorized || authorized.finalFileExpectedSha256 !== sha256(plan.expectedText)) {
          const error = new Error(`改动 ${item.change.id} 的最终文件计划与预演记录不一致；请重新预演。`);
          error.code = "DRY_RUN_FILE_PLAN_MISMATCH";
          throw error;
        }
        if (
          authorized.contextAnchor?.selectorSha256 !== currentAnchor?.selectorSha256 ||
          authorized.contextAnchor?.locationBindingSha256 !== currentAnchor?.locationBindingSha256 ||
          authorized.contextAnchor?.occurrenceOffsetsSha256 !== currentAnchor?.occurrenceOffsetsSha256
        ) {
          const error = new Error(`改动 ${item.change.id} 的定位位置与预演记录不一致；请重新读取目标并预演。`);
          error.code = "CONTEXT_ANCHOR_BINDING_MISMATCH";
          throw error;
        }
      }
      replacementPlans.push({ ...plan, pvfPath });
      const verifiedItems = plan.items.filter((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode));
      const pvfEncoding = replaceChanges[0].pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      expectedAfterByPath.set(pvfPath, {
        kind: "replace-text",
        expectedText: plan.expectedText,
        pvfEncoding,
        verifiedInlineText: verifiedItems.length > 0,
        writerProofs: [],
        changeIds: plan.items.map((item) => item.change.id),
      });
      for (const item of plan.items) {
        const change = item.change;
        results.push({
          id: change.id, type: change.type, pvfPath,
          textWriteMode: change.textWriteMode || null,
          pvfEncoding,
          occurrenceCount: item.occurrenceCount,
          totalOccurrenceCount: item.totalOccurrenceCount,
          expectedOccurrences: item.expectedOccurrences,
          contextAnchor: item.contextAnchor,
          replaceAll: change.replaceAll === true,
          changed: item.changed,
          beforeSha256: sha256(item.before),
          expectedAfterSha256: sha256(item.after),
          finalFileExpectedSha256: sha256(plan.expectedText),
          semanticReadGuard: beforeRead.semanticReadGuard || null,
          semanticWriteSafety: item.semanticWriteSafety,
          encodingRoundTripProbe: authorizedResults.get(change.id)?.encodingRoundTripProbe || null,
          applyResult: null,
          rationale: change.rationale || "",
        });
      }
    }

    const coordinatedApply = replacementPlans.length > 0
      ? await applyFilePlansCoherently({
        client,
        sessionId: activeApplySessionId,
        filePlans: replacementPlans,
        changeSet,
        adapterConfig,
      })
      : {
        sessionId: activeApplySessionId,
        coordinatedPlans: [],
        ordinaryResults: new Map(),
        verifiedResults: new Map(),
        verifiedBatchResults: new Map(),
      };
    activeApplySessionId = coordinatedApply.sessionId;
    for (const plan of coordinatedApply.coordinatedPlans) {
      const expected = expectedAfterByPath.get(plan.pvfPath);
      const writerProofs = [];
      for (const item of plan.items) {
        const result = results.find((entry) => entry.id === item.change.id);
        if (!result) continue;
        if (!item.changed) {
          result.applyResult = { ok: true, skipped: true, reason: "no-op replacement" };
          continue;
        }
        if (isVerifiedInlineTextMode(item.change.textWriteMode)) {
          const applied = coordinatedApply.verifiedResults.get(item.change.id);
          const proof = applied?.writeResult?.proof || null;
          if (proof?.existingStringEntriesPreserved !== true || proof?.encoding !== result.pvfEncoding) {
            const error = new Error(`中文文本改动 ${item.change.id} 未能证明既有字符串表条目保持不变。`);
            error.code = "CN_TEXT_STRING_TABLE_PRESERVATION_FAILED";
            throw error;
          }
          writerProofs.push(proof);
          result.applyResult = applied;
        } else {
          result.applyResult = coordinatedApply.ordinaryResults.get(item.change.id) || null;
        }
      }
      if (expected) {
        expected.writerProofs = writerProofs;
        expected.writerBatchProof = coordinatedApply.verifiedBatchResults.get(plan.pvfPath) || null;
      }
    }

    backupResult = ensureContentAddressedSourceBackup(
      input.protectedSourcePvf,
      paths.backupPath,
      input.cumulative?.protectedSourcePvfSha256 || authorization.sourcePvfSha256,
    );

    saveResult = await callAndParse(client, "pvf_save", {
      sessionId: activeApplySessionId,
      targetPath: paths.outputPvf,
      allowOverwriteSource: false,
    });
  } finally {
    try {
      if (activeApplySessionId) await callAndParse(client, "pvf_close", { sessionId: activeApplySessionId });
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
        // Every controlled replacement is written as raw PVF tokens. Read it
        // back through the independent TypeScript parser even when the change
        // is ASCII-only (notably .lst, whose native session metadata can lose
        // the script flag after a raw upsert).
        semanticVerificationRead: expected.kind === "replace-text",
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
        const writerProofsOk = expected.verifiedInlineText === true
          ? Array.isArray(expected.writerProofs) && expected.writerProofs.length > 0 &&
            expected.writerProofs.every((proof) => proof?.existingStringEntriesPreserved === true && proof?.encoding === expected.pvfEncoding)
          : null;
        const writerBatchProofOk = expected.verifiedInlineText === true
          ? expected.writerBatchProof?.ok === true &&
            expected.writerBatchProof?.mode === "verified-inline-text-batch" &&
            expected.writerBatchProof?.encoding === expected.pvfEncoding &&
            expected.writerBatchProof?.proof?.existingStringEntriesPreserved === true
          : null;
        const verifiedOk = expected.verifiedInlineText === true
          ? comparison.exactTextOk === true && independentSemanticRead && writerProofsOk && writerBatchProofOk
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
          writerProofs: expected.writerProofs || [],
          writerBatchProof: expected.writerBatchProof || null,
          changeIds: expected.changeIds || [],
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
  const protectedSourcePvf = input.protectedSourcePvf;
  const protectedSourcePvfSha256 = input.cumulative?.protectedSourcePvfSha256 || authorization.sourcePvfSha256;
  const protectedSourcePvfSha256AfterApply = sha256File(protectedSourcePvf);
  const protectedSourceUnchanged = protectedSourcePvfSha256AfterApply.toLowerCase() === protectedSourcePvfSha256.toLowerCase();
  const readbackOk = readback.every((item) => item.ok) && sourceUnchanged && protectedSourceUnchanged;
  const readbackExactCount = readback.filter((item) => item.ok && item.exactTextOk === true).length;
  const readbackNormalizedEquivalentCount = readback.filter((item) => item.ok && item.layoutNormalizationAccepted === true).length;
  const readbackRawBinaryCount = readback.filter((item) => item.ok && item.comparison === "raw-base64-sha256").length;
  const readbackFailedCount = readback.filter((item) => !item.ok).length;
  const finalOutputIdentity = outputPvfIdentity(paths.outputPvf);
  const outputPvfSha256 = finalOutputIdentity.sha256;
  const outputPvfBytes = finalOutputIdentity.bytes;
  if (
    sha256File(sourcePvf) !== inputPvfSha256AtStart ||
    sha256File(input.protectedSourcePvf) !== protectedSourcePvfSha256AtStart
  ) {
    throw codedError("APPLY_SOURCE_IDENTITY_CHANGED", "本轮输入或受保护源在正式生成过程中发生变化；输出不可授权。");
  }
  const manifest = {
    schemaVersion: "1.0",
    phase: "phase-3-controlled-output-apply",
    generatedAt: new Date().toISOString(),
    mode: "controlled-output-only",
    writeOperationsExecuted: true,
    sourcePvf,
    protectedSourcePvf,
    protectedSourcePvfSha256,
    protectedSourcePvfSha256AfterApply,
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
      protectedSourceUnchanged,
      backupCreated: Boolean(backupResult?.targetPath && fs.existsSync(backupResult.targetPath)),
      backupContentAddressed: true,
      backupCreatedThisRun: backupResult?.created === true,
      backupReused: backupResult?.reused === true,
      backupSha256Verified: backupResult?.sha256 === protectedSourcePvfSha256,
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
      exactAdjacentContextAnchoringAllowed: true,
      contextAnchorDoesNotRelaxTextSafety: true,
      sameFileChangesPlannedAsOneFinalText: true,
      sameFileChangeOrderPreservedWhenRequired: true,
      sameFileVerifiedInlineTextAppliedAsOneBatch: true,
      stringTableAppendedOncePerVerifiedFileBatch: true,
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
      backupReused: backupResult?.reused === true,
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
    cumulative: {
      enabled: Boolean(input.cumulative),
      previousApplyManifest: input.cumulative?.manifestPath || null,
      previousApplyManifestSha256: input.cumulative?.manifestSha256 || null,
      inputPvf: sourcePvf,
      inputPvfSha256: authorization.sourcePvfSha256,
      protectedSourcePvf,
      protectedSourcePvfSha256,
      chainDepth: input.cumulative?.chainDepth || 0,
      previousChangeCount: input.cumulative?.previousChangeCount || 0,
      currentChangeCount: results.filter((item) => item.changed).length,
      totalChangeCount: (input.cumulative?.previousChangeCount || 0) + results.filter((item) => item.changed).length,
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
    printJson({
      ok: true,
      command,
      file,
      changeCount: changeSet.changes.length,
      changePlan: changeSetPlanSummary(changeSet),
      agentHandoff: changeSetAgentHandoff(changeSet, file),
    });
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
        diagnosis: item.blockDetails?.sourceTextDiagnosis || null,
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
    console.error("提示：普通脚本中文需要使用完整文字验证模式；参数/结构请拆成同文件的普通改动。未声明模式的中文仍会被阻止。");
  } else if (["CN_TEXT_CHARACTER_UNENCODABLE", "CN_TEXT_ENCODING_ROUNDTRIP_FAILED"].includes(error?.code)) {
    console.error("提示：新文字含当前编码无法无损保存的字符，请换用常见简体中文、数字或符号后重试。");
  } else if (error?.code === "HTML_NUMERIC_ENTITY_WRITE_BLOCKED") {
    console.error("提示：请使用目标 PVF 原始读回中的真实文字，不要把网页里的 &#数字; 形式写进 PVF。");
  } else if (["CN_TEXT_TOKEN_REQUIRED", "CN_TEXT_PARENT_TAG_UNSUPPORTED", "CN_TEXT_FILE_TYPE_UNSUPPORTED"].includes(error?.code)) {
    console.error("提示：中文必须覆盖一个完整的名称或说明文本；完整多行文本也支持。工作台没有生成或覆盖 PVF。");
  } else if (error?.code === "EXPECTED_OCCURRENCES_REQUIRED") {
    console.error("提示：批量替换必须填写 expectedOccurrences（预计命中数量），实际数量必须完全一致。");
  } else if (error?.code === "OCCURRENCE_COUNT_MISMATCH") {
    console.error("提示：旧文字没有按预计数量精确定位。若同一完整文字重复，请从同一次原始读回复制紧邻的 contextBefore 或 contextAfter；工作台不会按不稳定的出现序号猜位置。");
  } else if (["CONTEXT_ANCHOR_EMPTY", "CONTEXT_ANCHOR_CONTAINS_TARGET"].includes(error?.code)) {
    console.error("提示：定位上下文必须是目标文字紧邻的非空原文，并且不能把旧文字本身包含进去。");
  } else if (error?.code === "STRINGLINK_TEXT_WRITE_UNVERIFIED") {
    console.error("提示：这是引用到独立文字资源的内容，当前路线仍保持只读，以免产生乱码或改错位置。");
  } else if (["CN_TEXT_ROUNDTRIP_FAILED", "CN_TEXT_ROUNDTRIP_REQUIRED"].includes(error?.code)) {
    console.error("提示：临时写出后的独立复查没有通过，因此没有获得正式生成许可；源 PVF 未被覆盖。");
  } else if (error?.code === "READ_ONLY_FALLBACK") {
    console.error("提示：读取仍可使用，但写出环境未就绪。请运行 workbench.bat check 查看修复说明。");
  }
  process.exit(1);
});
