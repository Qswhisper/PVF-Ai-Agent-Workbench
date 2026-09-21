"use strict";
const { writeBlockDiagnosis } = require("../lib/write-block-diagnosis");

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
  CHANGE_SET_FIELD_CONTRACT,
  attachCapabilityIds,
  capabilityIdForChange,
  controlledWriteCapabilitySelfTest,
  validateWritePolicyCapabilityRegistry,
} = require("../lib/controlled-write-capabilities");
const {
  buildControlledExecutionPlan,
  compareControlledExecutionPlans,
  controlledExecutionPlanSelfTest,
  validateExecutionPlanPolicy,
} = require("../lib/controlled-execution-plan");
const {
  VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
  VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
  validateVerifiedTextEligibilityContract,
  verifiedTextEligibilitySelfTest,
} = require("../lib/verified-text-eligibility");
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
const { bytePreservingAsciiTextSelfTest } = require("../../../tools/pvf-bridge/byte-preserving-ascii-text");
const {
  auditMapRelativeResourceRebind,
  mapRelativeResourceAuditSelfTest,
} = require("../lib/map-relative-resource-audit");
const {
  UPGRADE_TABLE_LEVEL_EDIT_TYPE,
  expandUpgradeTableLevelEdit,
  upgradeTableLevelEditSelfTest,
  validateUpgradeTableLevelEditShape,
  validMaxLevelProof,
} = require("../lib/upgrade-table-level-edit");
const {
  analyzeContextAnchoredReplacement,
  applyContextAnchoredReplacement,
  occurrenceMismatch,
} = require("../../../tools/pvf-bridge/context-anchored-replace");
const {
  EXISTING_NUT_CONTROLLED_MODE,
  HIGH_RISK_NEW_FILE_MODES,
  containsExactFunctionCall,
  containsExactIdentifier,
  containsExactInteger,
  containsExactIntegerInFunctionCall,
  containsExecutableFragment,
  directStateReferencePresent,
  directSkillUseReferencePresent,
  directSkillProcRegistration,
  directSkillProcEvidence,
  extensionOf,
  normalizePvfPath: normalizeAuditedPvfPath,
  parseRegistryRows,
  parseRegionTownIds,
  parseTownWorldmapGates,
  parseWorldmapText,
  parseWorldmapUiButtons,
  resolveRegistryEntryPath,
  validateExistingNutTextTransition,
  validateExistingNutWriteProofShape,
  validateNewFileText,
  validateRegistryLifecycleTransition,
  validateRegistryRowProof,
  validateWriteProofShape,
} = require("../lib/high-risk-write-audit");

const rawArgs = process.argv.slice(2);
const workbenchRoot = resolveWorkbenchRoot(rawArgs, path.resolve(__dirname, "../../.."));
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0];
const COPY_FILE_CHANGE_TYPE = "copy-file";

function isReplacementChangeType(type) {
  return type === "replace-text" || type === UPGRADE_TABLE_LEVEL_EDIT_TYPE;
}

function structuredUpgradeChange(group) {
  return group.changes.find((change) => change.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE) || null;
}

function expandReplacementChangesForSource(group, sourceText) {
  const structured = structuredUpgradeChange(group);
  if (!structured) return { changes: group.changes.filter((change) => change.type === "replace-text"), structured: null };
  const expanded = expandUpgradeTableLevelEdit(sourceText, structured);
  return { changes: expanded.generatedChanges, structured: { request: structured, ...expanded } };
}

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
    capabilityIds: [...new Set(group.changes.map(capabilityIdForChange).filter(Boolean))],
    ordinaryReplaceCount: group.changes.filter((item) =>
      item.type === "replace-text" && !isVerifiedInlineTextMode(item.textWriteMode)).length,
    verifiedInlineTextCount: group.changes.filter((item) =>
      item.type === "replace-text" && isVerifiedInlineTextMode(item.textWriteMode)).length,
    exactRangeScopeCount: group.changes.filter((item) =>
      item.type === "replace-text" && item.scope).length,
    existingNutControlledCount: group.changes.filter((item) =>
      item.type === "replace-text" && item.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE).length,
    writeFileCount: group.changes.filter((item) => item.type === "write-file").length,
    copyFileCount: group.changes.filter((item) => item.type === COPY_FILE_CHANGE_TYPE).length,
    upgradeTableLevelEditCount: group.changes.filter((item) => item.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE).length,
  }));
  return {
    pathCount: paths.length,
    multiChangePathCount: paths.filter((item) => item.changeCount > 1).length,
    capabilityIds: [...new Set(paths.flatMap((item) => item.capabilityIds))],
    paths,
  };
}

function findInterleavedVerifiedTextBatchIssues(changes) {
  const issues = [];
  for (const group of groupChangesByPvfPath(Array.isArray(changes) ? changes : [])) {
    let sawVerifiedText = false;
    let ordinaryAfterVerified = null;
    for (const [index, change] of group.changes.entries()) {
      if (change?.type !== "replace-text") continue;
      if (typeof change.previousText === "string" && typeof change.newText === "string" && change.previousText === change.newText) {
        continue;
      }
      const verified = isVerifiedInlineTextMode(change.textWriteMode);
      if (verified) {
        if (ordinaryAfterVerified) {
          issues.push({
            pvfPath: group.pvfPath,
            changeId: change.id || `index-${index}`,
            ordinaryChangeId: ordinaryAfterVerified.id || null,
          });
          break;
        }
        sawVerifiedText = true;
      } else if (sawVerifiedText) {
        ordinaryAfterVerified = change;
      }
    }
  }
  return issues;
}

function changeSetAgentHandoff(changeSet, file) {
  const plan = changeSetPlanSummary(changeSet);
  const handoff = {
    structuralValidationComplete: true,
    semanticDryRunStillRequired: true,
    nextCommandOnly: `workbench.bat pvf-change dry-run --file "${file}" --out <external-preview-directory>`,
    helpProbeRequired: false,
    sourceCodeInspectionRequired: false,
    samePathChanges: {
      supported: true,
      plannedAsOneFinalFile: true,
      interleavedVerifiedTextBatchesSupported: false,
      cumulativeSplitRequiredWhenVerifiedOrdinaryVerified: true,
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
      homomorphicBlocks: "不同块里的正文和相邻内容仍完全相同时，为每条改动填写同次 --raw 读回的 scope.startText、scope.endText 和精确 expectedRanges；命中只在区间内部计算。",
    },
    exactRangeScope: {
      instruction: "scope 只负责限定查找范围，不扩大中文或结构写入权限。开始/结束标记不会被改写，范围、内容哈希和命中位置会绑定到预演与正式生成。",
      shape: { startText: "<raw exact block header>", endText: "<raw exact closing marker>", expectedRanges: 1 },
      example: "workspaces/examples/change-set.exact-scope.example.json",
    },
    cumulativeNextRound: {
      baselineDeclared: Boolean(changeSet.baseline?.applyManifest),
      instruction: "连续第二轮仍让 target.sourcePvf 指向最初受保护源，并用 baseline.applyManifest 指向上一轮成功的 APPLY-MANIFEST.json；按 nextCommandOnly 原样预演，不要自行增加指向最初源的 --pvf。只有明确覆盖时，--pvf 才能指向上一轮记录绑定的 outputPvf；不要把它写成新的 target.sourcePvf。",
      example: "workspaces/examples/change-set.cumulative-second-round.example.json",
    },
    existingNutControlledEdit: {
      enabled: plan.paths.some((item) => item.existingNutControlledCount > 0),
      instruction: "既有 .nut 仍默认受保护；同文件必须使用一致的 writeProof。默认核验 load_state/passive/appendage 链；显式 loadChainKind=direct-character-state 则按任务卡核验唯一、顶层、同职业的 pushState 直接登记及回调。显式direct-character-skill-use仅允许同职业common文件已有useSkill_before/after回调；各路线均保留原文 SHA256、函数/API/APID、临时独立 PVF 往返和最终字节读回，静态通过后仍须实机验证。",
      example: "workspaces/examples/change-set.existing-nut-controlled.example.json",
    },
    pvfInternalCopyNewFile: {
      enabled: plan.paths.some((item) => item.copyFileCount > 0),
      atomicReferenceSwitchSupported: true,
      instruction: "普通文本文件可用 copy-file 从同一目标 PVF 复制为不存在的同扩展名新路径；工作台会绑定完整源文本并进行临时独立读回。同一 change-set 可以同时精确修改其他路径的引用方，例如复制新 .til 并切换现有 .map 引用。只禁止对刚复制的新路径本身混入 replace-text；修改克隆内容才需要使用成功 APPLY-MANIFEST.json 开始累计第二轮。高风险扩展名仍走专用 writeProof 路线。",
      example: "workspaces/examples/change-set.copy-pvf-file.example.json",
    },
    upgradeTableLevelEdit: {
      enabled: plan.paths.some((item) => item.upgradeTableLevelEditCount > 0),
      instruction: "强化/增幅表只用 upgrade-table-level-edit：新请求用 tableEdit/amplificationConstEdit 独立声明原始分组索引，不推断游戏显示等级；B-R 复制/保留列必须完整声明，或用 setCells 精确绑定旧值。旧平铺字段仍兼容但不得与新字段混用；锻造文件不在此路线内。",
    },
    numericDecimalReplacement: {
      instruction: "整数与小数可以互相修改，但 previousText 应包含同次 --raw 读回的完整字段标签和原值（例如 [attack damage rate]\\r\\n1 → [attack damage rate]\\r\\n0.8），不要只替换在文件中重复出现的裸 1。",
    },
    prohibitedFollowUp: [
      "inspect pvf-change-set.js implementation",
      "split same-path changes into chained fresh sources",
      "treat replaceAll=false as a declared bulk count",
      "reuse reader-friendly display text as previousText",
      "invent scope markers instead of copying them from the same raw readback",
      "remove the existing NUT proof or treat static checks as runtime success",
      "mix copy-file and replace-text on the same target before a cumulative next round",
    ],
  };
  const changes = changeSet.changes || [];
  const hasText = changes.some(change => isVerifiedInlineTextMode(change.textWriteMode));
  const hasScalar = changes.some(change => change.textWriteMode === "verified-scalar-text");
  if (!hasText) delete handoff.verifiedInlineText;
  else if (hasScalar) handoff.verifiedInlineText = {
    instruction: "显式独立文字使用 verified-scalar-text；已知显示文字继续使用原模式。两者均需目标编码、精确计数、临时往返和最终读回。独立文字的运行含义仍未验证。",
    example: "workspaces/examples/change-set.scalar-text.example.json",
    taskCard: "knowledge-pack/task-cards/pvf-scalar-text-controlled-change.zh-CN.md",
  };
  for (const key of ["existingNutControlledEdit", "pvfInternalCopyNewFile", "upgradeTableLevelEdit"]) {
    if (!handoff[key].enabled) delete handoff[key];
  }
  if (!changes.some(change => change.scope)) delete handoff.exactRangeScope;
  if (!changes.some(change => change.type === "replace-text" && !isVerifiedInlineTextMode(change.textWriteMode))) delete handoff.numericDecimalReplacement;
  handoff.prohibitedFollowUp = handoff.prohibitedFollowUp.filter(text =>
    (!text.includes("NUT") || handoff.existingNutControlledEdit) &&
    (!text.includes("copy-file") || handoff.pvfInternalCopyNewFile) &&
    (!text.includes("scope") || handoff.exactRangeScope));
  return handoff;
}

function handoffCommandArgument(value) {
  const text = String(value || "");
  if (!text || /[\x00-\x1f\x7f%!?^&|<>"]/u.test(text)) return null;
  return `"${text}"`;
}

function dryRunAgentHandoff(file, manifestPath, approvalCode, blockedChanges = [], noChange = false) {
  const readyForApply = blockedChanges.length === 0 && typeof approvalCode === "string" && approvalCode.length > 0;
  const sameFileBatchBlockers = [...new Set(blockedChanges
    .map((item) => item.blockedByChangeId || item.details?.blockedByChangeId || null)
    .filter(Boolean))];
  const quotedFile = handoffCommandArgument(file);
  const quotedManifest = handoffCommandArgument(manifestPath);
  const safeApprovalCode = /^[A-Z0-9-]+$/u.test(String(approvalCode || "")) ? String(approvalCode) : null;
  const commandAvailable = readyForApply && quotedFile && quotedManifest && safeApprovalCode;
  return {
    semanticDryRunComplete: true,
    readyForApply,
    noChange: noChange === true,
    nextCommandOnly: commandAvailable
      ? `workbench.bat pvf-change apply --file ${quotedFile} --dry-run-manifest ${quotedManifest} --authorize-apply ${safeApprovalCode} --out "REPLACE_WITH_EXTERNAL_OUTPUT_DIRECTORY"`
      : null,
    outputDirectoryPlaceholder: commandAvailable ? "REPLACE_WITH_EXTERNAL_OUTPUT_DIRECTORY" : null,
    helpProbeRequired: false,
    sourceCodeInspectionRequired: false,
    outputDirectoryScanRequired: false,
    instruction: readyForApply
      ? "把 nextCommandOnly 中唯一的输出目录占位符替换为本次独立外部成品目录后执行；不要添加原始源 --pvf，不要查看帮助、实现或扫描预演目录。"
      : noChange === true
        ? "预演确认所有声明值已经满足，未生成批准码，也无需生成空的修改版 PVF。"
      : sameFileBatchBlockers.length > 0
        ? `同一文件批次被变化 ${sameFileBatchBlockers.join("、")} 阻断；先修正或移除这些变化，其余标记为 FILE_CHANGE_BATCH_BLOCKED 的变化本身已通过静态检查，应原样保留，然后重新 validate 和 dry-run。不要执行 apply。`
        : "预演仍有阻断，不能正式生成；按 blockedChanges 修正原始文本、范围或数量后重新 validate 和 dry-run。不要查看帮助或执行 apply。",
    sameFileBatchRecovery: {
      required: sameFileBatchBlockers.length > 0,
      blockedByChangeIds: sameFileBatchBlockers,
      retryUnaffectedChangesUnchanged: sameFileBatchBlockers.length > 0,
    },
    prohibitedFollowUp: [
      "pvf-change --help",
      "inspect pvf-change-set.js or schemas to rediscover apply syntax",
      "scan the preview directory for the manifest",
      "add an original-source --pvf override",
    ],
  };
}

function applyAgentHandoff(manifestPath, manifest) {
  const quotedManifest = handoffCommandArgument(manifestPath);
  const quotedProfile = handoffCommandArgument(manifest.sourceProfile);
  const commandAvailable = Boolean(quotedManifest && quotedProfile);
  return {
    controlledOutputComplete: true,
    clientDeploymentSeparatelyAuthorized: true,
    nextCommandOnly: commandAvailable
      ? `workbench.bat client-pvf preview --profile ${quotedProfile} --apply-manifest ${quotedManifest}`
      : null,
    instruction: commandAvailable
      ? "若用户已明确要求安装到该 profile 的测试客户端，直接执行 nextCommandOnly；预览不会修改客户端，也不要手工复制 PVF。"
      : "如需安装到测试客户端，请先使用已配置 client 的 profile，再运行 client-pvf preview；不要手工复制 PVF。",
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
  // A cumulative chain may already use this verified content-addressed file as
  // its protected source anchor. Reusing that exact path is intentional: the
  // hash is checked again by ensureContentAddressedSourceBackup before apply.
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

function dryRunBinding(results, sourcePvf, sourcePvfSha256, changeSetFile, changeSetFileSha256, executionPlanOverride = null) {
  const executionPlan = executionPlanOverride || buildControlledExecutionPlan(results);
  const payload = {
    schemaVersion: "1.0",
    sourcePvf: path.resolve(sourcePvf),
    sourcePvfSha256,
    changeSetFile: path.resolve(changeSetFile),
    changeSetFileSha256,
    executionPlanSha256: executionPlan.planSha256,
    changes: results.map((item) => ({
      id: item.id,
      type: item.type,
      capabilityId: item.capabilityId || capabilityIdForChange(item),
      pvfPath: item.pvfPath,
      applicable: item.applicable,
      changed: item.changed,
      afterSha256: item.diff?.afterSha256 || item.sourceSha256 || null,
      finalFileExpectedSha256: item.finalFileExpectedSha256 || null,
      expectedOccurrences: item.expectedOccurrences || null,
      contextAnchorSha256: item.contextAnchor
        ? sha256(JSON.stringify(item.contextAnchor))
        : null,
      ...(item.contextAnchor?.scope
        ? { scopeEvidenceSha256: sha256(JSON.stringify(item.contextAnchor.scope)) }
        : {}),
      rawAsciiTokenPlanProofSha256: item.rawAsciiTokenPlanProof
        ? sha256(JSON.stringify(item.rawAsciiTokenPlanProof))
        : null,
      textWriteMode: item.textWriteMode || null,
      pvfEncoding: item.pvfEncoding || null,
      encodingRoundTripProbeSha256: item.encodingRoundTripProbe
        ? sha256(JSON.stringify(item.encodingRoundTripProbe))
        : null,
      writeProofSha256: item.writeProof
        ? sha256(JSON.stringify(item.writeProof))
        : null,
      highRiskAuditSha256: item.highRiskAudit
        ? sha256(JSON.stringify(item.highRiskAudit))
        : null,
      mapRelativeResourceAuditSha256: item.mapRelativeResourceAudit
        ? canonicalJsonSha256(item.mapRelativeResourceAudit)
        : null,
      registryTargetClosureSha256: item.registryTargetClosure
        ? sha256(JSON.stringify(item.registryTargetClosure))
        : null,
      newFileRoundTripProbeSha256: item.roundTripProbe
        ? sha256(JSON.stringify(item.roundTripProbe))
        : null,
      existingNutAuditSha256: item.existingNutAudit
        ? canonicalJsonSha256(item.existingNutAudit)
        : null,
      existingNutRoundTripProbeSha256: item.existingNutRoundTripProbe
        ? canonicalJsonSha256(item.existingNutRoundTripProbe)
        : null,
      structuredEditProofSha256: item.structuredEditProof
        ? canonicalJsonSha256(item.structuredEditProof)
        : null,
      structuredRoundTripProbeSha256: item.structuredRoundTripProbe
        ? canonicalJsonSha256(item.structuredRoundTripProbe)
        : null,
      structuredComponentState: item.structuredEditProof?.componentState || null,
      structuredWriterRequired: item.structuredEditProof?.writerRequired ?? null,
    })),
  };
  const bindingSha256 = sha256(JSON.stringify(payload));
  return {
    ...payload,
    bindingSha256,
    approvalCode: `APPLY-${bindingSha256.toUpperCase()}`,
  };
}

function dryRunManifestBinding(
  results,
  sourcePvf,
  sourcePvfSha256,
  changeSetFile,
  changeSetFileSha256,
  blockedCount,
  changedCount = null,
  executionPlanOverride = null,
) {
  const binding = dryRunBinding(
    results,
    sourcePvf,
    sourcePvfSha256,
    changeSetFile,
    changeSetFileSha256,
    executionPlanOverride,
  );
  if (Number(blockedCount) > 0) {
    return {
      ...binding,
      approvalCode: null,
      authorizationWithheld: true,
      authorizationWithheldReason: "BLOCKED_DRY_RUN",
    };
  }
  const actualChangedCount = changedCount === null
    ? results.filter((item) => item.changed === true).length
    : Number(changedCount);
  if (actualChangedCount === 0) {
    return {
      ...binding,
      approvalCode: null,
      authorizationWithheld: true,
      authorizationWithheldReason: "NO_CHANGES",
      noChange: true,
    };
  }
  return {
    ...binding,
    authorizationWithheld: false,
    authorizationWithheldReason: null,
    noChange: false,
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
  const requestedChanges = readJson(changeSetFile).changes || [];
  for (const result of manifest.results || []) {
    const expectedCapabilityId = capabilityIdForChange(result);
    if (!expectedCapabilityId || result.capabilityId !== expectedCapabilityId) {
      throw codedError(
        "CONTROLLED_WRITE_CAPABILITY_BINDING_MISMATCH",
        `改动 ${result.id} 的受控能力标识与预演内容不一致；请重新预演。`,
        { expectedCapabilityId, authorizedCapabilityId: result.capabilityId || null },
      );
    }
    if (extensionOf(result.pvfPath) === ".map" && result.changed === true) {
      const audit = result.mapRelativeResourceAudit;
      if (
        audit?.mode !== "map-relative-resource-rebind" ||
        audit?.ok !== true ||
        audit?.highRisk !== false ||
        !Array.isArray(audit?.checkedChain) ||
        audit.checkedChain.join("|") !== ".map|.til|.img" ||
        audit?.clientAssetsWritten !== false
      ) {
        const error = new Error(`地图改动 ${result.id} 缺少目标目录 .map -> .til -> .img 重解析证明，或检测到高风险相对资源改绑。`);
        error.code = "MAP_RELATIVE_RESOURCE_AUDIT_REQUIRED";
        throw error;
      }
    }
    if (isReplacementChangeType(result.type) && !isVerifiedInlineTextMode(result.textWriteMode) && result.changed === true) {
      if (result.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE) {
        const structured = result.structuredEditProof;
        const probe = result.structuredRoundTripProbe;
        if (
          structured?.mode !== UPGRADE_TABLE_LEVEL_EDIT_TYPE ||
          structured?.pvfPath !== normalizePvfPath(result.pvfPath).toLowerCase() ||
          structured?.table?.width !== 17 ||
          structured?.table?.levelIndexMode !== "zero-based-group-index" ||
          structured?.table?.firstColumnIsLevelNumber !== false ||
          structured?.table?.nonTargetTokensPreserved !== true ||
          !validMaxLevelProof(structured?.maxLevelByRarity,
            requestedChanges.find((change) => change.id === (result.structuredEditParentId || result.id))) ||
          structured?.componentState !== "changed" ||
          structured?.declaredValuesVerified !== true ||
          structured?.writerRequired !== true ||
          structured?.forgingFileExcluded !== true ||
          structured?.clientWritten !== false ||
          structured?.inGameValidationRequired !== true ||
          structured?.staticChecksProveGameplayBehavior !== false ||
          !/^[a-f0-9]{64}$/iu.test(String(structured?.planBindingSha256 || "")) ||
          (normalizePvfPath(result.pvfPath).toLowerCase() === "etc/amplifyupgrade.etc" && (
            structured?.amplificationConst?.width !== 4 ||
            structured?.amplificationConst?.hasLevelZeroGroup !== true ||
            structured?.amplificationConst?.levelIndexMode !== "zero-based-group-index" ||
            structured?.amplificationConst?.nonTargetTokensPreserved !== true
          )) ||
          manifest.temporaryVerificationWriteOperationsExecuted !== true ||
          probe?.ok !== true ||
          probe?.sourceUnchanged !== true ||
          probe?.independentSemanticRead !== true ||
          probe?.semanticReadGuard?.reason !== "verified-text-readback" ||
          probe?.semanticReadGuard?.backend !== "typescript-readonly-fallback" ||
          probe?.comparison?.exactTextOk !== true ||
          probe?.fixedPoint !== true ||
          probe?.structuralProofOk !== true ||
          probe?.componentState !== "changed" ||
          probe?.declaredValuesVerified !== true ||
          probe?.writerRequired !== true ||
          probe?.componentReadbackState !== "no-op" ||
          probe?.temporaryWriteExecuted !== true ||
          probe?.temporaryOutputRetained !== false ||
          probe?.clientWritten !== false ||
          probe?.inGameValidationRequired !== true ||
          probe?.staticChecksProveGameplayBehavior !== false ||
          String(probe?.sourcePvfSha256 || "").toLowerCase() !== String(binding.sourcePvfSha256 || "").toLowerCase() ||
          !/^[a-f0-9]{64}$/iu.test(String(probe?.outputPvfSha256 || ""))
        ) {
          throw codedError("UPGRADE_TABLE_DRY_RUN_PROOF_REQUIRED", `强化/增幅结构化编辑 ${result.id} 缺少固定宽度、零级偏移、临时独立读回或重新解析证明；请重新预演。`);
        }
      }
      if (result.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE) {
        const audit = result.existingNutAudit;
        const probe = result.existingNutRoundTripProbe;
        if (
          audit?.ok !== true ||
          audit?.transition?.ok !== true ||
          audit?.runtimeValidationRequired !== true ||
          audit?.staticChecksProveRuntimeBehavior !== false ||
          !Array.isArray(audit?.loadChainChecks) || audit.loadChainChecks.length < (["direct-character-state", "direct-character-skill-use", "direct-character-skill-proc"].includes(result.writeProof.loadChainKind) ? 1 : 2) ||
          (result.writeProof.loadChainKind === "direct-character-skill-proc" && audit?.skillProcCheck?.ok !== true) ||
          audit?.loadChainChecks?.some((item) => item.exactReferencePresent !== true) ||
          !Array.isArray(audit?.apiSymbolChecks) || audit.apiSymbolChecks.length < 1 ||
          audit?.apiSymbolChecks?.some((item) => item.catalogDeclared !== true || item.finalTargetUsesSymbol !== true || !item.targetEvidence?.some((entry) => entry.exactSymbolPresent === true)) ||
          !Array.isArray(audit?.apidChecks) || audit.apidChecks.length !== (result.writeProof?.apidPlan?.ids?.length || 0) ||
          audit?.apidChecks?.some((item) => item.complete !== true || item.collisions?.length !== 0 || item.finalTargetContainsId !== true) ||
          probe?.ok !== true ||
          probe?.sourceUnchanged !== true ||
          probe?.independentSemanticRead !== true ||
          probe?.semanticReadGuard?.reason !== "verified-text-readback" ||
          probe?.semanticReadGuard?.backend !== "typescript-readonly-fallback" ||
          probe?.comparison?.ok !== true ||
          probe?.rawByteReadbackOk !== true ||
          String(probe?.expectedOutputRawSha256 || "").toLowerCase() !==
            String(result.rawAsciiTokenPlanProof?.outputRawSha256 || "").toLowerCase() ||
          String(probe?.actualOutputRawSha256 || "").toLowerCase() !==
            String(probe?.expectedOutputRawSha256 || "").toLowerCase() ||
          probe?.temporaryOutputRetained !== false ||
          probe?.runtimeValidationRequired !== true ||
          String(probe?.sourcePvfSha256 || "").toLowerCase() !== String(binding.sourcePvfSha256 || "").toLowerCase() ||
          !/^[a-f0-9]{64}$/iu.test(String(probe?.temporaryOutputPvfSha256 || ""))
        ) {
          const error = new Error(`既有 NUT 改动 ${result.id} 缺少完整的加载链/API/APID 审计或临时独立读回证据；请重新预演。`);
          error.code = "EXISTING_NUT_DRY_RUN_PROOF_REQUIRED";
          throw error;
        }
      }
      if (result.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE) {
        const proof = result.rawAsciiTokenPlanProof;
        if (
          proof?.mode !== EXISTING_NUT_CONTROLLED_MODE ||
          proof?.encoding !== result.pvfEncoding ||
          typeof proof?.originalRawBytesReencodedExactly !== "boolean" ||
          proof?.rawBytePreservingPatch !== true ||
          proof?.wholeFileReencodingUsed !== false ||
          proof?.sourceDecodedTextBound !== true ||
          proof?.nonTargetRawBytesPreserved !== true ||
          proof?.replacementCharactersPreserved !== true ||
          proof?.stepNonTargetRawBytesPreserved !== true ||
          proof?.existingStringEntriesPreserved !== true ||
          proof?.stringTableUntouched !== true ||
          proof?.appendedStringEntryCount !== 0 ||
          proof?.transitionAuditOk !== true ||
          proof?.sourceTextSha256 !== result.existingNutAudit?.transition?.sourceTextSha256 ||
          proof?.finalTextSha256 !== result.finalFileExpectedSha256 ||
          Number(proof?.expectedOccurrences) !== Number(result.expectedOccurrences) ||
          Number(proof?.occurrenceCount) !== Number(result.occurrenceCount) ||
          !Number.isSafeInteger(proof?.preservedRawByteCount) || proof.preservedRawByteCount < 0 ||
          !Number.isSafeInteger(proof?.removedRawByteCount) || proof.removedRawByteCount < 1 ||
          !Number.isSafeInteger(proof?.insertedRawByteCount) || proof.insertedRawByteCount < 0 ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.sourceRawSha256 || "")) ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.outputRawSha256 || "")) ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.preservedRawBytesSha256 || "")) ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.unchangedRangesSha256 || "")) ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.replacementRangesSha256 || "")) ||
          (result.contextAnchor && (
            proof?.contextAnchor?.selectorSha256 !== result.contextAnchor.selectorSha256 ||
            proof?.contextAnchor?.locationBindingSha256 !== result.contextAnchor.locationBindingSha256
          ))
        ) {
          const error = new Error(`既有 NUT 改动 ${result.id} 缺少原始字节/目标编码精确预演证明；请重新预演。`);
          error.code = "EXISTING_NUT_RAW_TEXT_PLAN_REQUIRED";
          throw error;
        }
      } else if (extensionOf(result.pvfPath) === ".ani") {
        const proof = result.rawAsciiTokenPlanProof;
        const probe = result.binaryAniRoundTripProbe;
        if (
          proof?.mode !== "raw-ascii-binary-ani" ||
          proof?.encoding !== "binary-ani" ||
          proof?.rawBytePreservingPatch !== true ||
          proof?.wholeFileReencodingUsed !== false ||
          proof?.nonTargetRawBytesPreserved !== true ||
          proof?.exactIndependentTextReadback !== true ||
          proof?.sourceBinaryParseFullyConsumed !== true ||
          proof?.outputBinaryParseFullyConsumed !== true ||
          proof?.existingStringEntriesPreserved !== true ||
          proof?.stringTableUntouched !== true ||
          proof?.appendedStringEntryCount !== 0 ||
          proof?.changedFieldCount < 1 ||
          !Array.isArray(proof?.changedFieldTags) || proof.changedFieldTags.length !== 1 || proof.changedFieldTags[0] !== "DELAY" ||
          !Array.isArray(proof?.targetRanges) || proof.targetRanges.length !== proof.changedFieldCount ||
          proof.targetRanges.some((range) => range?.tag !== "DELAY" || range?.length !== 4 || !Number.isSafeInteger(range?.offset) || range.offset < 0) ||
          proof?.finalTextSha256 !== result.finalFileExpectedSha256 ||
          Number(proof?.expectedOccurrences) !== Number(result.expectedOccurrences) ||
          Number(proof?.occurrenceCount) !== Number(result.occurrenceCount) ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.sourceRawSha256 || "")) ||
          !/^[a-f0-9]{64}$/iu.test(String(proof?.outputRawSha256 || "")) ||
          proof?.scriptBeforeSha256 !== proof?.sourceRawSha256 ||
          proof?.scriptAfterSha256 !== proof?.outputRawSha256 ||
          probe?.ok !== true ||
          probe?.sourceUnchanged !== true ||
          probe?.independentSemanticRead !== true ||
          probe?.independentRawRead !== true ||
          probe?.rawByteReadbackOk !== true ||
          String(probe?.expectedOutputRawSha256 || "").toLowerCase() !== String(proof?.outputRawSha256 || "").toLowerCase() ||
          String(probe?.actualOutputRawSha256 || "").toLowerCase() !== String(proof?.outputRawSha256 || "").toLowerCase() ||
          probe?.temporaryOutputRetained !== false ||
          probe?.runtimeValidationRequired !== true ||
          probe?.staticChecksProveGameplayBehavior !== false ||
          String(probe?.sourcePvfSha256 || "").toLowerCase() !== String(binding.sourcePvfSha256 || "").toLowerCase() ||
          !/^[a-f0-9]{64}$/iu.test(String(probe?.temporaryOutputPvfSha256 || "")) ||
          (result.contextAnchor && (
            proof?.contextAnchor?.selectorSha256 !== result.contextAnchor.selectorSha256 ||
            proof?.contextAnchor?.locationBindingSha256 !== result.contextAnchor.locationBindingSha256
          ))
        ) {
          const error = new Error(`既有 ANI [DELAY] 改动 ${result.id} 缺少完整的原字节补丁、临时独立 PVF 或 SHA256 读回证明；请重新预演。`);
          error.code = "RAW_ANI_DRY_RUN_PROOF_REQUIRED";
          throw error;
        }
      } else if (result.writeProof?.mode === "registry-lifecycle") {
        const proof = result.rawAsciiTokenPlanProof?.proof || result.rawAsciiTokenPlanProof;
        if (
          proof?.mode !== "registry-lifecycle" ||
          proof?.addOnly !== true ||
          proof?.transitionProof?.ok !== true ||
          result.registryTargetClosure?.ok !== true
        ) {
          const error = new Error(`登记表改动 ${result.id} 缺少登记表生命周期预演证据；请重新预演。`);
          error.code = "REGISTRY_LIFECYCLE_PROOF_REQUIRED";
          throw error;
        }
      } else {
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
          proof?.contextAnchor?.locationBindingSha256 !== result.contextAnchor.locationBindingSha256 ||
          (result.contextAnchor.scopeApplied === true && (
            proof?.contextAnchor?.scopeApplied !== true ||
            proof?.contextAnchor?.scope?.rangeBindingSha256 !== result.contextAnchor.scope?.rangeBindingSha256 ||
            proof?.contextAnchor?.scope?.rangesSha256 !== result.contextAnchor.scope?.rangesSha256
          ))
        )) ||
        !/^[a-f0-9]{64}$/i.test(String(proof?.scriptBeforeSha256 || "")) ||
        !/^[a-f0-9]{64}$/i.test(String(proof?.scriptAfterSha256 || ""))
      ) {
        const error = new Error(`参数改动 ${result.id} 缺少完整的原始 token 预演证据；请重新预演。`);
        error.code = "RAW_ASCII_TOKEN_PLAN_REQUIRED";
        throw error;
      }
      }
    }
    if (result.type === "write-file" && result.changed === true) {
      const expectedMode = HIGH_RISK_NEW_FILE_MODES[extensionOf(result.pvfPath)];
      if (expectedMode) {
        if (result.highRiskAudit?.ok !== true || result.roundTripProbe?.ok !== true || result.roundTripProbe?.temporaryOutputRetained !== false) {
          const error = new Error(`新增高风险文件 ${result.id} 缺少完整闭合或临时读回证据；请重新预演。`);
          error.code = "HIGH_RISK_NEW_FILE_PROOF_REQUIRED";
          throw error;
        }
      }
    }
    if (result.type === COPY_FILE_CHANGE_TYPE && result.changed === true) {
      const probe = result.roundTripProbe;
      if (
        result.semanticWriteSafety?.allowed !== true ||
        result.semanticWriteSafety?.details?.mode !== "same-pvf-copy" ||
        result.semanticWriteSafety?.details?.sourcePvfPath !== result.sourcePvfPath ||
        result.semanticWriteSafety?.details?.sourceTextSha256 !== result.sourceTextSha256 ||
        probe?.ok !== true ||
        probe?.sourceUnchanged !== true ||
        probe?.independentSemanticRead !== true ||
        probe?.semanticReadGuard?.reason !== "verified-text-readback" ||
        probe?.semanticReadGuard?.backend !== "typescript-readonly-fallback" ||
        probe?.comparison?.ok !== true ||
        probe?.temporaryOutputRetained !== false ||
        String(probe?.sourcePvfSha256 || "").toLowerCase() !== String(binding.sourcePvfSha256 || "").toLowerCase() ||
        !/^[a-f0-9]{64}$/iu.test(String(probe?.outputPvfSha256 || ""))
      ) {
        const error = new Error(`同一 PVF 文件复制 ${result.id} 缺少完整源文本绑定、临时写出或独立读回证据；请重新预演。`);
        error.code = "COPY_FILE_ROUNDTRIP_REQUIRED";
        throw error;
      }
    }
    if (!isVerifiedInlineTextMode(result.textWriteMode) || result.changed !== true) continue;
    const probe = result.encodingRoundTripProbe;
    const eligibility = result.semanticWriteSafety?.verifiedInlineTextWrite || null;
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
      eligibility?.eligibilityPolicyId !== VERIFIED_TEXT_ELIGIBILITY_POLICY_ID ||
      eligibility?.eligibilityPolicySha256 !== VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256 ||
      !Array.isArray(eligibility?.eligibilityProofs) ||
      eligibility.eligibilityProofs.length !== Number(result.expectedOccurrences || 1) ||
      eligibility?.eligibilityProofsSha256 !== sha256(JSON.stringify(eligibility.eligibilityProofs)) ||
      probe?.writerProof?.eligibilityPolicyId !== eligibility.eligibilityPolicyId ||
      probe?.writerProof?.eligibilityPolicySha256 !== eligibility.eligibilityPolicySha256 ||
      probe?.writerProof?.eligibilityProofsSha256 !== eligibility.eligibilityProofsSha256 ||
      probe?.writerProof?.eligibilityProofsSha256 !== sha256(JSON.stringify(probe?.writerProof?.eligibilityProofs || [])) ||
      Number(probe?.writerProof?.occurrenceCount || 1) !== Number(result.expectedOccurrences || 1) ||
      (result.contextAnchor && (
        probe?.writerProof?.contextAnchor?.selectorSha256 !== result.contextAnchor.selectorSha256 ||
        probe?.writerProof?.contextAnchor?.locationBindingSha256 !== result.contextAnchor.locationBindingSha256 ||
        (result.contextAnchor.scopeApplied === true && (
          probe?.writerProof?.contextAnchor?.scopeApplied !== true ||
          probe?.writerProof?.contextAnchor?.scope?.rangeBindingSha256 !== result.contextAnchor.scope?.rangeBindingSha256 ||
          probe?.writerProof?.contextAnchor?.scope?.rangesSha256 !== result.contextAnchor.scope?.rangesSha256
        ))
      )) ||
      !/^[a-f0-9]{64}$/i.test(String(probe?.temporaryOutputSha256 || "")) ||
      probe?.temporaryOutputRetained !== false
    ) {
      const error = new Error(`中文文本改动 ${result.id} 缺少成功且完整的临时写出复查证据；请重新预演。`);
      error.code = "CN_TEXT_ROUNDTRIP_REQUIRED";
      throw error;
    }
  }
  const recomputedExecutionPlan = buildControlledExecutionPlan(manifest.results || []);
  const executionPlanComparison = compareControlledExecutionPlans(manifest.executionPlan, recomputedExecutionPlan);
  if (!executionPlanComparison.ok || binding.executionPlanSha256 !== recomputedExecutionPlan.planSha256) {
    throw codedError(
      "CONTROLLED_EXECUTION_PLAN_BINDING_MISMATCH",
      "预演执行计划缺失、被修改或与预演结果不一致；请重新预演。",
      executionPlanComparison,
    );
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

async function changeSetAuthorizationSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-change-binding-"));
  const checks = [];
  const missingNewStrProof = semanticWriteSafety({ kind: "write-file", pvfPath: "stringview/new.str", pvfEncoding: "Cn", textContent: "key>文字" });
  const existingStrEdit = semanticWriteSafety({ kind: "replace-text", pvfPath: "stringview/existing.str", pvfEncoding: "Cn", previousText: "旧", newText: "新" });
  checks.push({ id: "new-localization-missing-proof-is-not-existing-localization-capability-block", ok:
    !missingNewStrProof.allowed && !existingStrEdit.allowed &&
    writeBlockDiagnosis({ semanticWriteSafety: missingNewStrProof }).category === "evidence-required" &&
    writeBlockDiagnosis({ semanticWriteSafety: existingStrEdit }).category === "unsupported-capability" });
  checks.push({ id: "write-block-diagnostics-separate-capability-evidence-encoding-and-batch", ok:
    writeBlockDiagnosis({ blockCode: "CN_LOCALIZATION_WRITE_UNVERIFIED" }).category === "unsupported-capability" &&
    writeBlockDiagnosis({ blockCode: "CN_TEXT_PARENT_TAG_UNSUPPORTED" }).taskCard?.endsWith("pvf-scalar-text-controlled-change.zh-CN.md") &&
    writeBlockDiagnosis({ blockCode: "CN_TEXT_CHARACTER_UNENCODABLE" }).category === "encoding-mismatch" &&
    writeBlockDiagnosis({ blockCode: "CN_TEXT_ROUNDTRIP_REQUIRED" }).category === "evidence-required" &&
    writeBlockDiagnosis({ blockCode: "FILE_CHANGE_BATCH_BLOCKED", blockDetails: { blockedByChangeId: "bad" } }).nextStep.includes("bad") &&
    writeBlockDiagnosis({ blockCode: "UNKNOWN" }).grantsWritePermission === false });
  try {
    const publicChangeSetSchema = readJson(path.join(workbenchRoot, "core", "pvf-agent-core", "schemas", "pvf-change-set.schema.json"));
    const writePolicy = loadWritePolicy();
    checks.push(...controlledWriteCapabilitySelfTest(publicChangeSetSchema, writePolicy));
    checks.push(...controlledExecutionPlanSelfTest(writePolicy));
    checks.push(...verifiedTextEligibilitySelfTest(writePolicy));
    checks.push(...await mapRelativeResourceAuditSelfTest());
    const upgradeTableSelfTest = upgradeTableLevelEditSelfTest();
    for (const check of upgradeTableSelfTest.checks) checks.push({ ...check, id: `upgrade-table-${check.id}` });
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
    attachCapabilityIds(results);
    const executionPlan = buildControlledExecutionPlan(results);
    const binding = dryRunBinding(
      results,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      executionPlan,
    );
    fs.writeFileSync(manifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: false,
      summary: { blockedCount: 0 },
      executionPlan,
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

    const capabilityTamperedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    capabilityTamperedManifest.results[0].capabilityId = "verified-inline-text";
    fs.writeFileSync(manifestFile, `${JSON.stringify(capabilityTamperedManifest, null, 2)}\n`, "utf8");
    let changedCapabilityRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, { manifestFile, authorizationCode: binding.approvalCode });
    } catch (error) {
      changedCapabilityRejected = error.code === "CONTROLLED_WRITE_CAPABILITY_BINDING_MISMATCH";
    }
    checks.push({ id: "changed-controlled-capability-binding-rejected", ok: changedCapabilityRejected });
    fs.writeFileSync(manifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: false,
      summary: { blockedCount: 0 },
      executionPlan,
      binding,
      results,
    }, null, 2)}\n`, "utf8");

    const executionPlanTamperedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    executionPlanTamperedManifest.executionPlan.entries[0].writerId = "tampered-writer";
    fs.writeFileSync(manifestFile, `${JSON.stringify(executionPlanTamperedManifest, null, 2)}\n`, "utf8");
    let changedExecutionPlanRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, { manifestFile, authorizationCode: binding.approvalCode });
    } catch (error) {
      changedExecutionPlanRejected = error.code === "CONTROLLED_EXECUTION_PLAN_BINDING_MISMATCH";
    }
    checks.push({ id: "changed-controlled-execution-plan-rejected", ok: changedExecutionPlanRejected });
    fs.writeFileSync(manifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: false,
      summary: { blockedCount: 0 },
      executionPlan,
      binding,
      results,
    }, null, 2)}\n`, "utf8");

    const registryManifestFile = path.join(tempRoot, "DRY-RUN-REGISTRY-MANIFEST.json");
    const registryResults = [{
      id: "registry-add-fixture",
      type: "replace-text",
      pvfPath: "worldmap/worldmap.lst",
      applicable: true,
      changed: true,
      occurrenceCount: 1,
      expectedOccurrences: 1,
      writeProof: {
        mode: "registry-lifecycle",
        allowExistingRegistryEdit: true,
        registry: { lstPath: "worldmap/worldmap.lst", id: 101, expectedPvfPath: "worldmap/new.wdm", action: "add" },
      },
      rawAsciiTokenPlanProof: {
        proof: {
          mode: "registry-lifecycle",
          addOnly: true,
          transitionProof: { ok: true },
        },
      },
      registryTargetClosure: { ok: false, expectedPvfPath: "worldmap/new.wdm" },
      diff: { afterSha256: sha256("registry-after") },
    }];
    attachCapabilityIds(registryResults);
    const registryExecutionPlan = buildControlledExecutionPlan(registryResults);
    let registryBinding = dryRunBinding(
      registryResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      registryExecutionPlan,
    );
    fs.writeFileSync(registryManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: false,
      summary: { blockedCount: 0 },
      executionPlan: registryExecutionPlan,
      binding: registryBinding,
      results: registryResults,
    }, null, 2)}\n`, "utf8");
    let missingRegistryTargetRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, {
        manifestFile: registryManifestFile,
        authorizationCode: registryBinding.approvalCode,
      });
    } catch (error) {
      missingRegistryTargetRejected = error.code === "REGISTRY_LIFECYCLE_PROOF_REQUIRED";
    }
    checks.push({ id: "registry-lifecycle-missing-target-closure-rejected", ok: missingRegistryTargetRejected });

    registryResults[0].registryTargetClosure = { ok: true, expectedPvfPath: "worldmap/new.wdm", targetPendingInChangeSet: true };
    registryBinding = dryRunBinding(
      registryResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      registryExecutionPlan,
    );
    fs.writeFileSync(registryManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: false,
      summary: { blockedCount: 0 },
      executionPlan: registryExecutionPlan,
      binding: registryBinding,
      results: registryResults,
    }, null, 2)}\n`, "utf8");
    const registryAuthorizationAccepted = verifyDryRunAuthorization(sourcePvf, changeSetFile, {
      manifestFile: registryManifestFile,
      authorizationCode: registryBinding.approvalCode,
    });
    checks.push({
      id: "registry-lifecycle-add-only-and-target-closure-authorized",
      ok: registryAuthorizationAccepted.binding.bindingSha256 === registryBinding.bindingSha256,
    });

    const verifiedManifestFile = path.join(tempRoot, "DRY-RUN-VERIFIED-TEXT-MANIFEST.json");
    const fixtureEligibilityProofs = [{
      policyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
      policySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
      ruleId: "direct-visible-text-tag",
      parentTag: "name",
    }];
    const fixtureEligibilityProofsSha256 = sha256(JSON.stringify(fixtureEligibilityProofs));
    const verifiedResults = [{
      id: "verified-text-fixture",
      type: "replace-text",
      pvfPath: "stackable/fixture.stk",
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfEncoding: "Tw",
      applicable: true,
      changed: true,
      occurrenceCount: 1,
      expectedOccurrences: 1,
      semanticWriteSafety: {
        allowed: true,
        verifiedInlineTextWrite: {
          eligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
          eligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
          eligibilityProofs: fixtureEligibilityProofs,
          eligibilityProofsSha256: fixtureEligibilityProofsSha256,
        },
      },
      diff: { afterSha256: sha256("verified-text-after") },
    }];
    attachCapabilityIds(verifiedResults);
    const verifiedExecutionPlan = buildControlledExecutionPlan(verifiedResults);
    let verifiedBinding = dryRunBinding(
      verifiedResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      verifiedExecutionPlan,
    );
    fs.writeFileSync(verifiedManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      executionPlan: verifiedExecutionPlan,
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
      writerProof: {
        mode: VERIFIED_INLINE_TEXT_MODE,
        encoding: "Tw",
        existingStringEntriesPreserved: true,
        occurrenceCount: 1,
        eligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
        eligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
        eligibilityProofs: fixtureEligibilityProofs,
        eligibilityProofsSha256: fixtureEligibilityProofsSha256,
      },
      temporaryOutputSha256: sha256("temporary-output"),
      temporaryOutputRetained: false,
    };
    verifiedBinding = dryRunBinding(
      verifiedResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      verifiedExecutionPlan,
    );
    fs.writeFileSync(verifiedManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      executionPlan: verifiedExecutionPlan,
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
    const tamperedEligibilityResults = JSON.parse(JSON.stringify(verifiedResults));
    tamperedEligibilityResults[0].semanticWriteSafety.verifiedInlineTextWrite.eligibilityPolicySha256 = "0".repeat(64);
    tamperedEligibilityResults[0].encodingRoundTripProbe.writerProof.eligibilityPolicySha256 = "0".repeat(64);
    attachCapabilityIds(tamperedEligibilityResults);
    const tamperedEligibilityPlan = buildControlledExecutionPlan(tamperedEligibilityResults);
    const tamperedEligibilityBinding = dryRunBinding(
      tamperedEligibilityResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      tamperedEligibilityPlan,
    );
    fs.writeFileSync(verifiedManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      executionPlan: tamperedEligibilityPlan,
      binding: tamperedEligibilityBinding,
      results: tamperedEligibilityResults,
    }, null, 2)}\n`, "utf8");
    let tamperedEligibilityRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, {
        manifestFile: verifiedManifestFile,
        authorizationCode: tamperedEligibilityBinding.approvalCode,
      });
    } catch (error) {
      tamperedEligibilityRejected = error.code === "CN_TEXT_ROUNDTRIP_REQUIRED";
    }
    checks.push({
      id: "verified-inline-text-eligibility-policy-tamper-rejected",
      ok: tamperedEligibilityRejected,
    });

    const copyManifestFile = path.join(tempRoot, "DRY-RUN-COPY-FILE-MANIFEST.json");
    const copySourceTextSha256 = sha256("copy-source-text");
    const copyResults = [{
      id: "copy-file-fixture",
      type: COPY_FILE_CHANGE_TYPE,
      pvfPath: "dungeon/fixture/copied.tbl",
      sourcePvfPath: "monster/monsterapcdifficultybonus.tbl",
      sourceTextSha256: copySourceTextSha256,
      applicable: true,
      changed: true,
      semanticWriteSafety: {
        allowed: true,
        details: {
          mode: "same-pvf-copy",
          sourcePvfPath: "monster/monsterapcdifficultybonus.tbl",
          sourceTextSha256: copySourceTextSha256,
        },
      },
    }];
    attachCapabilityIds(copyResults);
    const copyExecutionPlan = buildControlledExecutionPlan(copyResults);
    let copyBinding = dryRunBinding(
      copyResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      copyExecutionPlan,
    );
    fs.writeFileSync(copyManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      executionPlan: copyExecutionPlan,
      binding: copyBinding,
      results: copyResults,
    }, null, 2)}\n`, "utf8");
    let missingCopyProbeRejected = false;
    try {
      verifyDryRunAuthorization(sourcePvf, changeSetFile, {
        manifestFile: copyManifestFile,
        authorizationCode: copyBinding.approvalCode,
      });
    } catch (error) {
      missingCopyProbeRejected = error.code === "COPY_FILE_ROUNDTRIP_REQUIRED";
    }
    checks.push({ id: "same-pvf-copy-missing-roundtrip-rejected", ok: missingCopyProbeRejected });
    copyResults[0].roundTripProbe = {
      ok: true,
      sourceUnchanged: true,
      independentSemanticRead: true,
      semanticReadGuard: { reason: "verified-text-readback", backend: "typescript-readonly-fallback" },
      comparison: { ok: true, exactTextOk: true },
      sourcePvfSha256: sha256File(sourcePvf),
      outputPvfSha256: sha256("copy-temporary-output"),
      temporaryOutputRetained: false,
    };
    copyBinding = dryRunBinding(
      copyResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      copyExecutionPlan,
    );
    fs.writeFileSync(copyManifestFile, `${JSON.stringify({
      schemaVersion: "1.0",
      phase: "phase-3-dry-run-change-set",
      mode: "dry-run-only",
      writeOperationsExecuted: false,
      persistentWriteOperationsExecuted: false,
      temporaryVerificationWriteOperationsExecuted: true,
      summary: { blockedCount: 0 },
      executionPlan: copyExecutionPlan,
      binding: copyBinding,
      results: copyResults,
    }, null, 2)}\n`, "utf8");
    const copyProbeAccepted = verifyDryRunAuthorization(sourcePvf, changeSetFile, {
      manifestFile: copyManifestFile,
      authorizationCode: copyBinding.approvalCode,
    });
    checks.push({
      id: "same-pvf-copy-complete-roundtrip-authorized",
      ok: copyProbeAccepted.binding.bindingSha256 === copyBinding.bindingSha256,
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
    const noChangeResults = results.map((item) => ({ ...item, changed: false }));
    const noChangeBinding = dryRunManifestBinding(
      noChangeResults,
      sourcePvf,
      sha256File(sourcePvf),
      changeSetFile,
      sha256File(changeSetFile),
      0,
      0,
    );
    checks.push({
      id: "all-no-op-dry-run-withholds-approval-and-empty-output-route",
      ok:
        noChangeBinding.approvalCode === null &&
        noChangeBinding.authorizationWithheld === true &&
        noChangeBinding.authorizationWithheldReason === "NO_CHANGES" &&
        noChangeBinding.noChange === true,
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
    const protectedSourceBackup = path.join(
      tempRoot,
      "profile-output",
      "pvf-source-backups",
      "sha256",
      sha256File(sourcePvf) + ".Script.pvf",
    );
    fs.mkdirSync(path.dirname(protectedSourceBackup), { recursive: true });
    fs.copyFileSync(sourcePvf, protectedSourceBackup);
    const promotedApplyManifest = path.join(tempRoot, "PROMOTED-CUMULATIVE-APPLY-MANIFEST.json");
    const promotedManifest = readJson(cumulativeApplyManifest);
    promotedManifest.backupPath = protectedSourceBackup;
    promotedManifest.safety.backupCreated = true;
    promotedManifest.safety.backupContentAddressed = true;
    promotedManifest.safety.backupSha256Verified = true;
    fs.writeFileSync(promotedApplyManifest, `${JSON.stringify(promotedManifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(sourcePvf, "client-now-contains-deployed-output", "utf8");
    const promotedInput = resolveChangeInput(
      { target: { sourcePvf }, baseline: { applyManifest: promotedApplyManifest } },
      changeSetFile,
      null,
      null,
    );
    checks.push({
      id: "cumulative-client-origin-uses-verified-protected-backup-anchor",
      ok:
        promotedInput.sourcePvf === cumulativeOutputPvf &&
        promotedInput.protectedSourcePvf === protectedSourceBackup &&
        promotedInput.protectedSourceOriginPvf === sourcePvf &&
        promotedInput.cumulative.previousChangeCount === 3,
    });
    fs.writeFileSync(sourcePvf, "pvf-fixture-v1", "utf8");
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

    const samePvfCopyText = "#PVF_File\r\n[monster]\r\n1\t`既有中文注释`\r\n";
    const samePvfCopySafety = semanticWriteSafety({
      kind: COPY_FILE_CHANGE_TYPE,
      pvfPath: "dungeon/fixture/difficulty_copy.tbl",
      pvfEncoding: "Cn",
      textContent: samePvfCopyText,
      samePvfCopyProof: {
        mode: "same-pvf-copy",
        sourcePvfPath: "monster/monsterapcdifficultybonus.tbl",
        sourceTextSha256: sha256(samePvfCopyText),
      },
    });
    checks.push({
      id: "same-pvf-ordinary-text-copy-preserves-bound-non-ascii-source",
      ok: samePvfCopySafety.allowed === true && samePvfCopySafety.details?.mode === "same-pvf-copy",
    });
    const highRiskSamePvfCopy = semanticWriteSafety({
      kind: COPY_FILE_CHANGE_TYPE,
      pvfPath: "sqr/fixture/copied.nut",
      pvfEncoding: "Cn",
      textContent: "function copied() { return true; }",
      samePvfCopyProof: {
        mode: "same-pvf-copy",
        sourcePvfPath: "sqr/fixture/source.nut",
        sourceTextSha256: sha256("function copied() { return true; }"),
      },
    });
    checks.push({
      id: "same-pvf-copy-cannot-bypass-high-risk-new-file-route",
      ok: highRiskSamePvfCopy.allowed === false && highRiskSamePvfCopy.code === "COPY_FILE_HIGH_RISK_TYPE_BLOCKED",
    });

    const newWorldmapSafety = semanticWriteSafety({
      kind: "write-file",
      pvfPath: "worldmap/AgentAuditCandidate.wdm",
      pvfEncoding: "Tw",
      textContent: "#PVF_File\r\n[map image]\r\n`WorldMap/Towers.img`\t0\r\n",
    });
    checks.push({
      id: "new-worldmap-file-requires-registry-and-paired-entry-check",
      ok: !newWorldmapSafety.allowed &&
        newWorldmapSafety.code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED" &&
        newWorldmapSafety.reason.includes("worldmap.lst"),
    });

    const newNutWithoutProof = semanticWriteSafety({
      kind: "write-file",
      pvfPath: "sqr/audit/new.nut",
      pvfEncoding: "Cn",
      textContent: "function Audit(obj)\r\n{\r\n\treturn true;\r\n}\r\n",
    });
    checks.push({
      id: "new-nut-without-proof-blocked",
      ok: !newNutWithoutProof.allowed && newNutWithoutProof.code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
    });

    const newNutWithoutReference = semanticWriteSafety({
      kind: "write-file",
      pvfPath: "sqr/audit/new.nut",
      pvfEncoding: "Cn",
      textContent: "function Audit(obj)\r\n{\r\n\treturn true;\r\n}\r\n",
      writeProof: { mode: "script-new-file", compileRequired: true },
    });
    checks.push({
      id: "new-nut-without-target-reference-blocked",
      ok: !newNutWithoutReference.allowed && newNutWithoutReference.details?.proofErrors?.some((message) => message.includes("referencePaths")),
    });

    const newNutWithProof = semanticWriteSafety({
      kind: "write-file",
      pvfPath: "sqr/audit/new.nut",
      pvfEncoding: "Cn",
      textContent: "function Audit(obj)\r\n{\r\n\treturn true;\r\n}\r\n",
      writeProof: { mode: "script-new-file", compileRequired: true, referencePaths: ["sqr/audit/reference.nut"] },
    });
    checks.push({
      id: "new-nut-with-proof-enters-controlled-audit",
      ok: newNutWithProof.allowed && newNutWithProof.details?.expectedMode === "script-new-file",
    });

    const existingLstWithoutProof = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "worldmap/worldmap.lst",
      pvfEncoding: "Cn",
      previousText: "100\t`Towers.wdm`",
      newText: "101\t`AgentAudit.wdm`",
      sourceText: "#PVF_File\r\n100\t`Towers.wdm`\r\n",
    });
    checks.push({
      id: "existing-lst-protection-remains-without-registry-lifecycle-proof",
      ok: !existingLstWithoutProof.allowed && existingLstWithoutProof.code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
    });

    const existingLstWithProof = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "worldmap/worldmap.lst",
      pvfEncoding: "Cn",
      previousText: "#PVF_File\r\n",
      newText: "#PVF_File\r\n101\t`AgentAudit.wdm`\r\n",
      sourceText: "#PVF_File\r\n",
      writeProof: {
        mode: "registry-lifecycle",
        allowExistingRegistryEdit: true,
        registry: { lstPath: "worldmap/worldmap.lst", id: 101, expectedPvfPath: "worldmap/AgentAudit.wdm", action: "add" },
      },
    });
    checks.push({
      id: "registry-lifecycle-proof-opens-only-specialized-lst-route",
      ok: existingLstWithProof.allowed,
    });

    const existingNutSource = [
      "function onStart(appendage)",
      "{",
      "\tappendage.sq_AddFunctionName(\"proc\", \"fixture_proc\");",
      "}",
      "",
    ].join("\r\n");
    const existingNutAddedFunction = [
      "function fixture_apply_status(obj)",
      "{",
      "\tCNSquirrelAppendage.sq_AddChangeStatusAppendageID(obj, obj, 120, CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL, false, 100, 9901);",
      "}",
      "",
    ].join("\r\n");
    const existingNutProof = {
      mode: EXISTING_NUT_CONTROLLED_MODE,
      sourceTextSha256: sha256(existingNutSource),
      structureCheckRequired: true,
      temporaryRoundTripRequired: true,
      runtimeValidationRequired: true,
      loadChain: [
        {
          fromPvfPath: "sqr/character/fixture_load_state.nut",
          toPvfPath: "sqr/character/fixture/passive_skill_fixture.nut",
          requiredText: "pushScriptFiles(\"character/fixture/passive_skill_fixture.nut\");",
        },
        {
          fromPvfPath: "sqr/character/fixture/passive_skill_fixture.nut",
          toPvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
          requiredText: "CNSquirrelAppendage.sq_AppendAppendage(obj, obj, -1, false, \"character/fixture/appendage/ap_fixture.nut\", true);",
        },
      ],
      touchedFunctions: ["fixture_apply_status"],
      apiSymbols: [
        { name: "sq_AddChangeStatusAppendageID", kind: "function", targetEvidencePaths: ["sqr/fixture/api.nut"] },
        { name: "CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL", kind: "constant", targetEvidencePaths: ["sqr/fixture/status.nut"] },
      ],
      apidPlan: { namespace: "fixture-status-resistance", ids: [9901], conflictSearchRequired: true },
    };
    const stateLink = {
      fromPvfPath: "sqr/character/fixture_load_state.nut",
      toPvfPath: "sqr/character/fixture/skill/skill.nut",
      requiredText: 'IRDSQRCharacter.pushState(ENUM_CHARACTERJOB_FIXTURE, "Character/Fixture/skill/skill.nut", "Fixture", STATE_FIXTURE, SKILL_FIXTURE);',
    };
    const stateProof = { ...existingNutProof, loadChainKind: "direct-character-state", loadChain: [stateLink], touchedFunctions: ["onSetState_Fixture"] };
    checks.push({ id: "direct-state-explicit-same-job-registration-accepted", ok: validateExistingNutWriteProofShape(stateLink.toPvfPath, stateProof).ok && directStateReferencePresent(stateLink.requiredText, stateLink) });
    for (const [name, text] of [
      ["comment", `// ${stateLink.requiredText}`],
      ["string", `local fake = \`${stateLink.requiredText}\`;`],
      ["dead-function", `function unused() { ${stateLink.requiredText} }`],
      ["conditional", `if (false) ${stateLink.requiredText}`],
      ["conditional-block", `if (false) { ${stateLink.requiredText} }`],
      ["duplicate", `${stateLink.requiredText}\n${stateLink.requiredText}`],
      ["assignment", `local fake = ${stateLink.requiredText}`],
    ]) checks.push({ id: `direct-state-${name}-registration-blocked`, ok: !directStateReferencePresent(text, stateLink) });
    for (const [name, proof] of [
      ["implicit-opt-in", { ...stateProof, loadChainKind: undefined }],
      ["unknown-kind", { ...stateProof, loadChainKind: "anything" }],
      ["wrong-callback", { ...stateProof, touchedFunctions: ["onSetState_Other"] }],
      ["wrong-job", { ...stateProof, loadChain: [{ ...stateLink, requiredText: stateLink.requiredText.replace("ENUM_CHARACTERJOB_FIXTURE", "ENUM_CHARACTERJOB_OTHER") }] }],
      ["wrong-target", { ...stateProof, loadChain: [{ ...stateLink, requiredText: stateLink.requiredText.replace("skill/skill.nut", "skill/unrelated.nut") }] }],
      ["arbitrary-call", { ...stateProof, loadChain: [{ ...stateLink, requiredText: stateLink.requiredText.replace("IRDSQRCharacter.pushState", "fakeLoader") }] }],
      ["path-traversal", { ...stateProof, loadChain: [{ ...stateLink, requiredText: stateLink.requiredText.replace("skill/skill.nut", "skill/../skill.nut") }] }],
    ]) checks.push({ id: `direct-state-${name}-proof-blocked`, ok: !validateExistingNutWriteProofShape(stateLink.toPvfPath, proof).ok });
    const skillUseLink = { fromPvfPath: "sqr/character/fixture_load_state.nut", toPvfPath: "sqr/character/fixture/fixture_common.nut", requiredText: 'IRDSQRCharacter.pushScriptFiles("Character/Fixture/fixture_common.nut");' };
    const skillUseProof = { ...existingNutProof, loadChainKind: "direct-character-skill-use", loadChain: [skillUseLink], touchedFunctions: ["useSkill_before_Fixture"] };
    checks.push({ id: "skill-use-explicit-registration-accepted", ok: validateExistingNutWriteProofShape(skillUseLink.toPvfPath, skillUseProof).ok && directSkillUseReferencePresent(skillUseLink.requiredText, skillUseLink) });
    for (const [name, text] of [
      ["comment", `// ${skillUseLink.requiredText}`],
      ["string", `local x = \`${skillUseLink.requiredText}\`;`],
      ["conditional", `if (false) ${skillUseLink.requiredText}`],
      ["function", `function hidden() { ${skillUseLink.requiredText} }`],
      ["duplicate", `${skillUseLink.requiredText}\n${skillUseLink.requiredText}`],
      ["assignment", `local x = ${skillUseLink.requiredText}`],
    ]) checks.push({ id: `skill-use-${name}-blocked`, ok: !directSkillUseReferencePresent(text, skillUseLink) });
    for (const [name, proof] of [
      ["implicit", { ...skillUseProof, loadChainKind: undefined }],
      ["wrong-hook", { ...skillUseProof, touchedFunctions: ["onProc_Fixture"] }],
      ["wrong-job-hook", { ...skillUseProof, touchedFunctions: ["useSkill_before_Other"] }],
      ["wrong-loader", { ...skillUseProof, loadChain: [{ ...skillUseLink, fromPvfPath: "sqr/character/other_load_state.nut" }] }],
      ["wrong-target", { ...skillUseProof, loadChain: [{ ...skillUseLink, toPvfPath: "sqr/character/fixture/other.nut" }] }],
      ["dynamic", { ...skillUseProof, loadChain: [{ ...skillUseLink, requiredText: 'IRDSQRCharacter.pushScriptFiles(path);' }] }],
    ]) checks.push({ id: `skill-use-${name}-proof-blocked`, ok: !validateExistingNutWriteProofShape(skillUseLink.toPvfPath, proof).ok });
    const newHookSource = 'function oldHook(obj) { return 1; }\n';
    const newHookText = `${newHookSource}function useSkill_before_Fixture(obj) { return 1; }\n`;
    checks.push({ id: "skill-use-new-hook-blocked", ok: !validateExistingNutTextTransition(skillUseLink.toPvfPath, newHookSource, newHookText, { ...skillUseProof, sourceTextSha256: sha256(newHookSource) }, [{ previousText: newHookSource, newText: newHookText }]).ok });
    const emptyStubs = 'function legacy(obj) {}\nfunction legacy(obj) {}\n';
    const stubSource = `${emptyStubs}function useSkill_before_Fixture(obj) { return sq_GetIntData(obj, 1, 0); }\n`;
    const stubFinal = stubSource.replace('obj, 1, 0', 'obj, 1, 1');
    const stubProof = { ...skillUseProof, sourceTextSha256: sha256(stubSource), apiSymbols: [{ name: "sq_GetIntData", kind: "function", targetEvidencePaths: [skillUseLink.toPvfPath] }], apidPlan: { namespace: "fixture", ids: [], conflictSearchRequired: true } };
    const stubAudit = (source, final, proof = stubProof) => validateExistingNutTextTransition(skillUseLink.toPvfPath, source, final, { ...proof, sourceTextSha256: sha256(source) }, [{ previousText: 'obj, 1, 0', newText: 'obj, 1, 1' }]);
    checks.push({ id: "skill-use-unchanged-empty-stubs-retained", ok: stubAudit(stubSource, stubFinal).ok && stubAudit(stubSource, stubFinal).retainedEmptyDuplicates.includes("legacy") });
    for (const [name, source, final, proof] of [
      ["changed-first-stub", stubSource, stubFinal.replace('legacy(obj) {}', 'legacy(obj) { return 1; }')],
      ["removed-stub", stubSource, stubFinal.replace('function legacy(obj) {}\n', '')],
      ["added-stub", stubSource, `function legacy(obj) {}\n${stubFinal}`],
      ["nonempty-stubs", stubSource.replaceAll('legacy(obj) {}', 'legacy(obj) { return 1; }'), stubFinal.replaceAll('legacy(obj) {}', 'legacy(obj) { return 1; }')],
      ["comment-stubs", stubSource.replaceAll('legacy(obj) {}', 'legacy(obj) { /* retain */ }'), stubFinal.replaceAll('legacy(obj) {}', 'legacy(obj) { /* retain */ }')],
      ["declared-stub", stubSource, stubFinal, { ...stubProof, touchedFunctions: ['useSkill_before_Fixture', 'legacy'] }],
      ["new-duplicate-hook", stubSource, `${stubFinal}function useSkill_before_Fixture(obj) {}\n`],
    ]) checks.push({ id: `skill-use-${name}-blocked`, ok: !stubAudit(source, final, proof).ok });
    const procSource = 'function procSkill_Fixture(obj) { procSkill_Test(obj); }\nfunction procSkill_Test(obj) { return obj.sq_GetIntData(SKILL_FIXTURE, 0); }\n';
    const procState = { ...stateLink, requiredText: stateLink.requiredText.replace('"Fixture",', '"Test",') };
    const procHeader = { fromPvfPath: skillUseLink.fromPvfPath, toPvfPath: 'sqr/character/fixture/fixture_header.nut', requiredText: 'IRDSQRCharacter.pushScriptFiles("Character/Fixture/fixture_header.nut");' };
    const procProof = { ...stubProof, sourceTextSha256: sha256(procSource), loadChainKind: 'direct-character-skill-proc', touchedFunctions: ['procSkill_Test'], skillProc: { dispatcher: 'procSkill_Fixture', requiredCall: 'procSkill_Test(obj);', stateRegistration: procState, headerRegistration: procHeader, skillId: 7, skillRegistryPath: 'skill/fixtureskill.lst', skillPvfPath: 'skill/fixture/test.skl' } };
    const procEvidence = { commonText: procSource, loaderText: [skillUseLink.requiredText, procState.requiredText, procHeader.requiredText].join('\n'), headerText: 'SKILL_FIXTURE <- 7\n', registryText: '#PVF_File\n7\t`fixture/test.skl`\n', skillText: '#PVF_File\n[name]\n`Fixture`\n', stateText: 'function onSetState_Test(obj) {}\n' };
    checks.push({ id: 'skill-proc-complete-evidence-accepted', ok: validateExistingNutWriteProofShape(skillUseLink.toPvfPath, procProof).ok && directSkillProcEvidence(procProof, procEvidence).ok });
    for (const [name, override] of [
      ['wrong-job', { dispatcher: 'procSkill_Other' }], ['wrong-function', { requiredCall: 'procSkill_Other(obj);' }], ['wrong-registry', { skillRegistryPath: 'skill/otherskill.lst' }], ['wrong-skill-path', { skillPvfPath: 'skill/other/test.skl' }],
      ['wrong-loader', { stateRegistration: { ...procState, fromPvfPath: 'sqr/character/other_load_state.nut' } }],
      ['wrong-header', { headerRegistration: { ...procHeader, toPvfPath: 'sqr/character/other/other_header.nut' } }],
    ]) checks.push({ id: `skill-proc-${name}-blocked`, ok: !directSkillProcRegistration({ ...procProof, skillProc: { ...procProof.skillProc, ...override } }) });
    for (const [name, override] of [
      ['missing-call', { commonText: procSource.replace('procSkill_Test(obj);', '') }],
      ['conditional-call', { commonText: procSource.replace('procSkill_Test(obj);', 'if (false) procSkill_Test(obj);') }],
      ['unreachable-call', { commonText: procSource.replace('procSkill_Test(obj);', 'return; procSkill_Test(obj);') }],
      ['comment-call', { commonText: procSource.replace('procSkill_Test(obj);', '/* procSkill_Test(obj); */') }],
      ['fake-data-reference', { commonText: procSource.replace('return obj.sq_GetIntData(SKILL_FIXTURE, 0);', '/* obj.sq_GetIntData(SKILL_FIXTURE, 0); */ return 0;') }],
      ['missing-loader', { loaderText: '' }], ['conditional-header-load', { loaderText: procEvidence.loaderText.replace(procHeader.requiredText, `if (false) ${procHeader.requiredText}`) }],
      ['wrong-id', { headerText: 'SKILL_FIXTURE <- 8\n' }], ['computed-id', { headerText: 'SKILL_FIXTURE <- 7 + 1\n' }], ['duplicate-id', { headerText: 'SKILL_FIXTURE <- 7\nSKILL_FIXTURE = 8\n' }], ['conditional-id', { headerText: 'if (false) {\nSKILL_FIXTURE <- 7\n}\n' }],
      ['wrong-registry-row', { registryText: '#PVF_File\n7\t`fixture/other.skl`\n' }], ['duplicate-registry-row', { registryText: `${procEvidence.registryText}7\t\`fixture/test.skl\`\n` }], ['missing-skill', { skillText: '' }], ['missing-state', { stateText: '' }],
    ]) checks.push({ id: `skill-proc-${name}-evidence-blocked`, ok: !directSkillProcEvidence(procProof, { ...procEvidence, ...override }).ok });
    const procFinal = procSource.replace('SKILL_FIXTURE, 0', 'SKILL_FIXTURE, 1');
    const procTransition = (source, final, proof = procProof) => validateExistingNutTextTransition(skillUseLink.toPvfPath, source, final, { ...proof, sourceTextSha256: sha256(source) }, [{ previousText: 'SKILL_FIXTURE, 0', newText: 'SKILL_FIXTURE, 1' }]);
    checks.push({ id: 'skill-proc-transition-accepted', ok: procTransition(procSource, procFinal).ok });
    checks.push({ id: 'skill-proc-unchanged-empty-stubs-retained', ok: procTransition(emptyStubs + procSource, emptyStubs + procFinal).ok });
    checks.push({ id: 'skill-proc-changed-stub-blocked', ok: !procTransition(emptyStubs + procSource, emptyStubs.replace('{}', '{ return 1; }') + procFinal).ok });
    checks.push({ id: 'skill-proc-dispatcher-edit-blocked', ok: !procTransition(procSource, procFinal.replace('procSkill_Test(obj);', 'procSkill_Test(obj); procSkill_Test(obj);')).ok });
    checks.push({ id: 'skill-proc-new-callee-blocked', ok: !procTransition('function procSkill_Fixture(obj) { procSkill_Test(obj); }\n', procFinal).ok });
    const existingNutSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      pvfEncoding: "Cn",
      previousText: "}\r\n",
      newText: `}\r\n\r\n${existingNutAddedFunction}`,
      sourceText: existingNutSource,
      writeProof: existingNutProof,
    });
    checks.push({
      id: "existing-nut-specialized-proof-enters-controlled-audit",
      ok: existingNutSafety.allowed === true && existingNutSafety.runtimeValidationRequired === true,
    });
    const existingNutFinal = `${existingNutSource}\r\n${existingNutAddedFunction}`;
    const existingNutTransition = validateExistingNutTextTransition(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      existingNutSource,
      existingNutFinal,
      existingNutProof,
      [{ previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}` }],
    );
    checks.push({
      id: "existing-nut-function-only-ascii-transition-accepted",
      ok: existingNutTransition.ok && existingNutTransition.addedFunctions.includes("fixture_apply_status") && existingNutTransition.apids.includes(9901),
    });
    const duplicateApiProofShape = validateExistingNutWriteProofShape(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      { ...existingNutProof, apiSymbols: [...existingNutProof.apiSymbols, existingNutProof.apiSymbols[0]] },
    );
    checks.push({
      id: "existing-nut-duplicate-api-proof-blocked",
      ok: !duplicateApiProofShape.ok && duplicateApiProofShape.errors.some((message) => message.includes("apiSymbols contains duplicates")),
    });
    const commentOnlyLoadProofShape = validateExistingNutWriteProofShape(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      {
        ...existingNutProof,
        loadChain: [{
          ...existingNutProof.loadChain[0],
          requiredText: "local unrelated = 1; // pushScriptFiles(\"character/fixture/passive_skill_fixture.nut\");",
        }, existingNutProof.loadChain[1]],
      },
    );
    checks.push({
      id: "existing-nut-load-path-hidden-after-executable-comment-prefix-blocked",
      ok: !commentOnlyLoadProofShape.ok &&
        commentOnlyLoadProofShape.errors.some((message) => message.includes("executable function-call argument")),
    });
    const existingNutBadHash = validateExistingNutTextTransition(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      existingNutSource,
      existingNutFinal,
      { ...existingNutProof, sourceTextSha256: "0".repeat(64) },
      [{ previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}` }],
    );
    checks.push({
      id: "existing-nut-source-text-sha-mismatch-blocked",
      ok: !existingNutBadHash.ok && existingNutBadHash.errors.some((message) => message.includes("sourceTextSha256")),
    });
    const existingNutTopLevelMutation = validateExistingNutTextTransition(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      existingNutSource,
      `FIXTURE_GLOBAL <- 1;\r\n${existingNutFinal}`,
      existingNutProof,
      [{ previousText: "function", newText: "FIXTURE_GLOBAL <- 1;\r\nfunction" }],
    );
    checks.push({
      id: "existing-nut-top-level-mutation-blocked",
      ok: !existingNutTopLevelMutation.ok && existingNutTopLevelMutation.errors.some((message) => message.includes("non-function top-level")),
    });
    const spoofedNutFunction = [
      "function fixture_apply_status(obj)",
      "{",
      "\t// CNSquirrelAppendage.sq_AddChangeStatusAppendageID and CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL are not calls.",
      "\tlocal apiName = \"sq_AddChangeStatusAppendageID\";",
      "\tlocal sq_AddChangeStatusAppendageID = 1;",
      "\tlocal statusName = \"CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL\";",
      "\tlocal APID_9901 = 1;",
      "\treturn APID_9901;",
      "}",
      "",
    ].join("\r\n");
    const spoofedNutTransition = validateExistingNutTextTransition(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      existingNutSource,
      `${existingNutSource}\r\n${spoofedNutFunction}`,
      existingNutProof,
      [{ previousText: "}\r\n", newText: `}\r\n\r\n${spoofedNutFunction}` }],
    );
    checks.push({
      id: "existing-nut-comment-string-api-and-apid-spoof-blocked",
      ok: !spoofedNutTransition.ok &&
        spoofedNutTransition.errors.filter((message) => message.includes("declared API/constant is not used")).length === 2 &&
        spoofedNutTransition.errors.some((message) => message.includes("declared APID is not used by a declared API call")),
    });
    const unboundApidFunction = existingNutAddedFunction
      .replace(", 9901);", ", 1);")
      .replace("\r\n}", "\r\n\tlocal unusedApid = 9901;\r\n}");
    const unboundApidTransition = validateExistingNutTextTransition(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      existingNutSource,
      `${existingNutSource}\r\n${unboundApidFunction}`,
      existingNutProof,
      [{ previousText: "}\r\n", newText: `}\r\n\r\n${unboundApidFunction}` }],
    );
    checks.push({
      id: "existing-nut-apid-must-be-an-argument-of-a-declared-api-call",
      ok: !unboundApidTransition.ok &&
        unboundApidTransition.errors.some((message) => message.includes("declared APID is not used by a declared API call")),
    });
    const existingNutChineseSafety = semanticWriteSafety({
      kind: "replace-text",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      pvfEncoding: "Cn",
      previousText: "return true;",
      newText: "return `中文`;",
      sourceText: existingNutSource,
      writeProof: existingNutProof,
    });
    checks.push({
      id: "existing-nut-non-ascii-write-remains-blocked",
      ok: !existingNutChineseSafety.allowed && existingNutChineseSafety.code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
    });
    checks.push({
      id: "existing-co-sqr-str-protection-remains",
      ok: [".co", ".sqr", ".str"].every((extension) => {
        const safety = semanticWriteSafety({
          kind: "replace-text",
          pvfPath: `sqr/fixture/protected${extension}`,
          pvfEncoding: "Cn",
          previousText: "1",
          newText: "2",
          sourceText: "1",
          writeProof: existingNutProof,
        });
        return !safety.allowed && ["PROTECTED_FILE_TYPE_WRITE_BLOCKED", "CN_LOCALIZATION_WRITE_UNVERIFIED"].includes(safety.code);
      }),
    });
    const nutAuditFiles = new Map([
      ["sqr/character/fixture_load_state.nut", existingNutProof.loadChain[0].requiredText],
      ["sqr/character/fixture/passive_skill_fixture.nut", existingNutProof.loadChain[1].requiredText],
      ["sqr/fixture/api.nut", "function fixture_api(obj) { CNSquirrelAppendage.sq_AddChangeStatusAppendageID(obj, obj, 1, 1, false, 1, 1); }"],
      ["sqr/fixture/status.nut", "function fixture_status() { return CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL; }"],
    ]);
    const fakeNutAuditClient = (searchItems = []) => ({
      callTool: async (name, toolArgs) => {
        if (name === "pvf_read_file") {
          const textContent = nutAuditFiles.get(normalizePvfPath(toolArgs.pvfPath).toLowerCase());
          if (typeof textContent !== "string") return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "fixture path missing" }) }] };
          return { content: [{ type: "text", text: JSON.stringify({ textContent, metadata: { fixture: true } }) }] };
        }
        if (name === "pvf_search") {
          return { content: [{ type: "text", text: JSON.stringify({ items: searchItems, matchedCount: searchItems.length, returnedCount: searchItems.length, errorCount: 0, truncated: false }) }] };
        }
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `unsupported fixture tool ${name}` }) }] };
      },
    });
    const completeNutAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient(),
      sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource,
      finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } },
      adapterConfig: { defaults: { pvfReadEncoding: "Cn" } },
      textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-target-load-api-and-apid-audit-accepted",
      ok: completeNutAudit.ok && completeNutAudit.loadChainChecks.every((item) => item.exactReferencePresent) && completeNutAudit.apiSymbolChecks.every((item) => item.catalogDeclared && item.targetEvidence.some((entry) => entry.exactSymbolPresent)) && completeNutAudit.apidChecks.every((item) => item.complete && item.collisions.length === 0),
    });
    nutAuditFiles.set(
      "sqr/fixture/api.nut",
      "function fixture_api() { local sq_AddChangeStatusAppendageID = 1; return sq_AddChangeStatusAppendageID; }",
    );
    const nonCallApiEvidenceAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient(), sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource, finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } }, adapterConfig: { defaults: { pvfReadEncoding: "Cn" } }, textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-target-function-identifier-without-call-is-not-evidence",
      ok: !nonCallApiEvidenceAudit.ok && nonCallApiEvidenceAudit.errors.some((message) => message.includes("目标 PVF 证据脚本未观察到")),
    });
    nutAuditFiles.set(
      "sqr/fixture/api.nut",
      "function ::sq_AddChangeStatusAppendageID(sourceObj, targetObj, time, changeStatus, absolute, value, apid) { return null; }",
    );
    const definitionOnlyApiEvidenceAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient(), sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource, finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } }, adapterConfig: { defaults: { pvfReadEncoding: "Cn" } }, textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-target-function-definition-without-call-is-not-evidence",
      ok: !definitionOnlyApiEvidenceAudit.ok && definitionOnlyApiEvidenceAudit.errors.some((message) => message.includes("目标 PVF 证据脚本未观察到")),
    });
    nutAuditFiles.set(
      "sqr/fixture/api.nut",
      "function fixture_api(obj) { CNSquirrelAppendage.sq_AddChangeStatusAppendageID(obj, obj, 1, 1, false, 1, 1); }",
    );
    nutAuditFiles.set(
      "sqr/character/fixture_load_state.nut",
      `// ${existingNutProof.loadChain[0].requiredText}\r\nlocal fakeLoad = \`${existingNutProof.loadChain[0].requiredText}\`;`,
    );
    const commentedLoadChainAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient(), sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource, finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } }, adapterConfig: { defaults: { pvfReadEncoding: "Cn" } }, textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-comment-or-string-load-chain-reference-blocked",
      ok: !commentedLoadChainAudit.ok && commentedLoadChainAudit.errors.some((message) => message.includes("加载链缺少精确引用")),
    });
    nutAuditFiles.set("sqr/character/fixture_load_state.nut", existingNutProof.loadChain[0].requiredText);
    nutAuditFiles.set("sqr/fixture/status.nut", "function fixture_status() { return \"CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL\"; } // not runtime evidence");
    const missingTargetApiAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient(), sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource, finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } }, adapterConfig: { defaults: { pvfReadEncoding: "Cn" } }, textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-target-api-comment-or-string-evidence-blocked",
      ok: !missingTargetApiAudit.ok && missingTargetApiAudit.errors.some((message) => message.includes("目标 PVF 证据脚本未观察到")),
    });
    nutAuditFiles.set("sqr/fixture/status.nut", "function fixture_status() { return CHANGE_STATUS_TYPE_ACTIVESTATUS_TOLERANCE_ALL; }");
    nutAuditFiles.set("sqr/fixture/apid-spoof.nut", "function no_collision() { local APID_9901 = 1; return \"9901\"; } // 9901");
    const apidSpoofAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient([{ fileName: "sqr/fixture/apid-spoof.nut" }]), sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource, finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } }, adapterConfig: { defaults: { pvfReadEncoding: "Cn" } }, textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-apid-comment-string-or-identifier-is-not-a-conflict",
      ok: apidSpoofAudit.ok && apidSpoofAudit.apidChecks[0]?.collisions?.length === 0,
    });
    nutAuditFiles.set("sqr/fixture/apid-collision.nut", "function collision() { return 9901; }");
    const apidCollisionAudit = await auditExistingNutControlledEdit({
      client: fakeNutAuditClient([{ fileName: "sqr/fixture/apid-collision.nut" }]), sessionId: "fixture",
      pvfPath: "sqr/character/fixture/appendage/ap_fixture.nut",
      sourceText: existingNutSource, finalText: existingNutFinal,
      changes: [{ id: "fixture", previousText: "}\r\n", newText: `}\r\n\r\n${existingNutAddedFunction}`, writeProof: existingNutProof }],
      changeSet: { target: { pvfReadEncoding: "Cn" } }, adapterConfig: { defaults: { pvfReadEncoding: "Cn" } }, textCache: new Map(),
    });
    checks.push({
      id: "existing-nut-apid-target-source-conflict-blocked",
      ok: !apidCollisionAudit.ok && apidCollisionAudit.apidChecks[0]?.collisions?.length === 1,
    });
    const duplicateApidPlans = [
      { existingNutAudit: { ok: true, errors: [], apidChecks: [{ id: 9901 }] } },
      { existingNutAudit: { ok: true, errors: [], apidChecks: [{ id: 9901 }] } },
    ];
    enforceAtomicNutApidUniqueness(duplicateApidPlans);
    checks.push({
      id: "existing-nut-apid-conflict-inside-atomic-change-set-blocked",
      ok: duplicateApidPlans.every((plan) => !plan.existingNutAudit.ok && plan.existingNutAudit.errors.some((message) => message.includes("多个 NUT"))),
    });
    const malformedNutTransition = validateExistingNutTextTransition(
      "sqr/character/fixture/appendage/ap_fixture.nut",
      existingNutSource,
      `${existingNutSource}\r\nfunction fixture_apply_status(obj)\r\n{\r\n`,
      existingNutProof,
      [{ previousText: "}\r\n", newText: "}\r\nfunction fixture_apply_status(obj)\r\n{\r\n" }],
    );
    checks.push({
      id: "existing-nut-unbalanced-final-script-blocked",
      ok: !malformedNutTransition.ok && malformedNutTransition.errors.some((message) => message.includes("final:")),
    });

    const registryLifecycleProof = {
      mode: "registry-lifecycle",
      allowExistingRegistryEdit: true,
      registry: { lstPath: "worldmap/worldmap.lst", id: 101, expectedPvfPath: "worldmap/AgentAudit.wdm", action: "add" },
    };
    const registryAddOnly = validateRegistryLifecycleTransition(
      "#PVF_File\r\n100\t`Towers.wdm`\r\n",
      "#PVF_File\r\n100\t`Towers.wdm`\r\n101\t`AgentAudit.wdm`\r\n",
      [registryLifecycleProof],
      "worldmap/worldmap.lst",
    );
    checks.push({
      id: "registry-lifecycle-exact-row-add-transition-accepted",
      ok: registryAddOnly.ok && registryAddOnly.addedRows.length === 1,
    });

    const registryHistoricalDuplicates = validateRegistryLifecycleTransition(
      "#PVF_File\r\n100\t`Towers.wdm`\r\n100\t`LegacyDuplicate.wdm`\r\n",
      "#PVF_File\r\n100\t`Towers.wdm`\r\n100\t`LegacyDuplicate.wdm`\r\n101\t`AgentAudit.wdm`\r\n",
      [registryLifecycleProof],
      "worldmap/worldmap.lst",
    );
    checks.push({
      id: "registry-lifecycle-historical-duplicates-do-not-block-unrelated-add",
      ok:
        registryHistoricalDuplicates.ok === true &&
        registryHistoricalDuplicates.preExistingDuplicatesIgnoredForAddOnly === true &&
        registryHistoricalDuplicates.preExistingDuplicateSummary?.duplicateIdGroupCount === 1 &&
        registryHistoricalDuplicates.duplicateExpansions?.length === 0,
    });

    const registryDuplicateExpansion = validateRegistryLifecycleTransition(
      "#PVF_File\r\n100\t`Towers.wdm`\r\n100\t`LegacyDuplicate.wdm`\r\n",
      "#PVF_File\r\n100\t`Towers.wdm`\r\n100\t`LegacyDuplicate.wdm`\r\n101\t`AgentAudit.wdm`\r\n100\t`AnotherDuplicate.wdm`\r\n",
      [registryLifecycleProof],
      "worldmap/worldmap.lst",
    );
    checks.push({
      id: "registry-lifecycle-historical-duplicate-expansion-remains-blocked",
      ok:
        registryDuplicateExpansion.ok === false &&
        registryDuplicateExpansion.errors.some((message) => message.includes("expanded duplicate id 100")),
    });

    const registryExistingPathConflict = validateRegistryRowProof(
      registryLifecycleProof,
      "#PVF_File\r\n100\t`AgentAudit.wdm`\r\n",
    );
    checks.push({
      id: "registry-lifecycle-existing-path-conflict-identifies-id-and-line",
      ok:
        !registryExistingPathConflict.ok &&
        registryExistingPathConflict.conflicts?.path === true &&
        registryExistingPathConflict.existingByPath?.id === 100 &&
        registryExistingPathConflict.existingByPath?.line === 2 &&
        registryExistingPathConflict.errors.some((message) =>
          message.includes("already registered as ID 100 at line 2") && message.includes("reuse the existing ID")),
    });

    const registryRewriteDisguisedAsAdd = validateRegistryLifecycleTransition(
      "#PVF_File\r\n100\t`Towers.wdm`\r\n",
      "#PVF_File\r\n100\t`Changed.wdm`\r\n101\t`AgentAudit.wdm`\r\n",
      [registryLifecycleProof],
      "worldmap/worldmap.lst",
    );
    checks.push({
      id: "registry-lifecycle-existing-row-rewrite-blocked",
      ok: !registryRewriteDisguisedAsAdd.ok && registryRewriteDisguisedAsAdd.errors.some((message) => message.includes("changed content other than the proved new row")),
    });

    const worldmapSource = "#PVF_File\r\n[map image]\r\n`WorldMap/Towers.img`\t0\r\n[ui path]\r\n`WorldMap/UI/AgentAudit.ui`\r\n[dungeon]\r\n1\t0\r\n[/dungeon]\r\n";
    const worldmapMissingUiPair = semanticWriteSafety({
      kind: "write-file",
      pvfPath: "worldmap/AgentAudit.wdm",
      pvfEncoding: "Cn",
      textContent: worldmapSource,
      writeProof: {
        mode: "worldmap-lifecycle",
        registry: { lstPath: "worldmap/worldmap.lst", id: 101, expectedPvfPath: "worldmap/AgentAudit.wdm", action: "add" },
        pairedEntries: [
          { kind: "town-gate", pvfPath: "town/AgentAudit.twn", worldmapId: 101 },
          { kind: "region-town", pvfPath: "region/heaven.rgn", townId: 99 },
        ],
      },
    });
    checks.push({
      id: "worldmap-lifecycle-missing-ui-pair-blocked-before-target-audit",
      ok: !worldmapMissingUiPair.allowed && worldmapMissingUiPair.details?.proofErrors?.some((message) => message.includes("ui pairedEntry")),
    });

    const worldmapMissingRegionPair = semanticWriteSafety({
      kind: "write-file",
      pvfPath: "worldmap/AgentAudit.wdm",
      pvfEncoding: "Cn",
      textContent: worldmapSource,
      writeProof: {
        mode: "worldmap-lifecycle",
        registry: { lstPath: "worldmap/worldmap.lst", id: 101, expectedPvfPath: "worldmap/AgentAudit.wdm", action: "add" },
        pairedEntries: [
          { kind: "ui", pvfPath: "worldmap/UI/AgentAudit.ui" },
          { kind: "town-gate", pvfPath: "town/AgentAudit.twn", worldmapId: 101 },
        ],
      },
    });
    checks.push({
      id: "worldmap-lifecycle-missing-region-pair-blocked-before-target-audit",
      ok: !worldmapMissingRegionPair.allowed && worldmapMissingRegionPair.details?.proofErrors?.some((message) => message.includes("region-town pairedEntry")),
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

    const validCopyChangeSet = {
      ...invalidDirectChineseChangeSet,
      changes: [{
        id: "copy-difficulty-table",
        type: COPY_FILE_CHANGE_TYPE,
        pvfPath: "dungeon/fixture/monsterapcdifficultybonus_custom.tbl",
        sourcePvfPath: "monster/monsterapcdifficultybonus.tbl",
        expectAbsent: true,
        pvfEncoding: "Cn",
      }],
    };
    checks.push({
      id: "validate-allows-same-pvf-ordinary-text-copy",
      ok: validateChangeSet(validCopyChangeSet).length === 0,
    });
    checks.push({
      id: "validate-blocks-copy-and-replace-on-same-target-until-cumulative-round",
      ok: validateChangeSet({
        ...validCopyChangeSet,
        changes: [
          ...validCopyChangeSet.changes,
          {
            id: "premature-copy-edit",
            type: "replace-text",
            pvfPath: validCopyChangeSet.changes[0].pvfPath,
            previousText: "[rate]\r\n1",
            newText: "[rate]\r\n0.8",
            pvfEncoding: "Cn",
          },
        ],
      }).some((message) => message.includes("COPY_FILE_TARGET_CONFLICT")),
    });
    const atomicTilCopyAndMapSwitch = {
      ...validCopyChangeSet,
      changes: [
        {
          id: "copy-correct-tile",
          type: COPY_FILE_CHANGE_TYPE,
          pvfPath: "map/illusiontower/tile/prisontile1_fixed.til",
          sourcePvfPath: "map/towerofsighs/tile/prisontile1.til",
          expectAbsent: true,
          pvfEncoding: "Cn",
        },
        {
          id: "switch-map-reference",
          type: "replace-text",
          pvfPath: "map/illusiontower/floor01.map",
          previousText: "`Tile/prisontile1.til`",
          newText: "`Tile/prisontile1_fixed.til`",
          replaceAll: false,
          pvfEncoding: "Cn",
        },
      ],
    };
    const atomicTilHandoff = changeSetAgentHandoff(atomicTilCopyAndMapSwitch, changeSetFile);
    checks.push({
      id: "validate-allows-atomic-til-copy-and-other-map-reference-switch",
      ok:
        validateChangeSet(atomicTilCopyAndMapSwitch).length === 0 &&
        atomicTilHandoff.pvfInternalCopyNewFile?.atomicReferenceSwitchSupported === true &&
        atomicTilHandoff.pvfInternalCopyNewFile?.instruction?.includes("同一 change-set"),
    });
    const decimalRatePlan = planReplacementGroup(
      "[attack damage rate]\r\n1\r\n[attack speed rate]\r\n1\r\n",
      [{
        id: "attack-damage-rate-decimal",
        type: "replace-text",
        previousText: "[attack damage rate]\r\n1",
        newText: "[attack damage rate]\r\n0.8",
        pvfEncoding: "Cn",
      }],
      { pvfPath: "aicharacter/swordman/siran_ghost/siran_ghost.aic", pvfReadEncoding: "Cn", fallbackEncoding: "Cn" },
    );
    checks.push({
      id: "integer-to-decimal-uses-complete-tag-value-selector",
      ok: decimalRatePlan.blocked === false && decimalRatePlan.items[0]?.occurrenceCount === 1 && decimalRatePlan.expectedText.includes("[attack damage rate]\r\n0.8"),
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
        samePathHandoff.samePathChanges.interleavedVerifiedTextBatchesSupported === false &&
        samePathHandoff.samePathChanges.cumulativeSplitRequiredWhenVerifiedOrdinaryVerified === true &&
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

    const readyDryRunHandoff = dryRunAgentHandoff(
      changeSetFile,
      path.join(tempRoot, "preview", "DRY-RUN-MANIFEST.json"),
      "APPLY-0123456789ABCDEF",
      [],
    );
    const blockedDryRunHandoff = dryRunAgentHandoff(
      changeSetFile,
      path.join(tempRoot, "preview", "DRY-RUN-MANIFEST.json"),
      null,
      [{ id: "blocked" }],
    );
    const sameFileBatchBlockedHandoff = dryRunAgentHandoff(
      changeSetFile,
      path.join(tempRoot, "preview", "DRY-RUN-MANIFEST.json"),
      null,
      [{
        id: "valid-name",
        code: "FILE_CHANGE_BATCH_BLOCKED",
        blockedByChangeId: "invalid-dialog-event",
        details: { blockedByChangeId: "invalid-dialog-event" },
      }],
    );
    checks.push({
      id: "dry-run-handoff-provides-apply-command-without-help-or-source-override",
      ok:
        readyDryRunHandoff.readyForApply === true &&
        readyDryRunHandoff.nextCommandOnly.includes("pvf-change apply") &&
        readyDryRunHandoff.nextCommandOnly.includes("--dry-run-manifest") &&
        readyDryRunHandoff.nextCommandOnly.includes("--authorize-apply APPLY-0123456789ABCDEF") &&
        readyDryRunHandoff.nextCommandOnly.includes("REPLACE_WITH_EXTERNAL_OUTPUT_DIRECTORY") &&
        !readyDryRunHandoff.nextCommandOnly.includes("--pvf") &&
        readyDryRunHandoff.helpProbeRequired === false &&
        readyDryRunHandoff.outputDirectoryScanRequired === false &&
        blockedDryRunHandoff.readyForApply === false &&
        blockedDryRunHandoff.nextCommandOnly === null,
    });
    checks.push({
      id: "dry-run-handoff-identifies-same-file-batch-blocker",
      ok:
        sameFileBatchBlockedHandoff.readyForApply === false &&
        sameFileBatchBlockedHandoff.nextCommandOnly === null &&
        sameFileBatchBlockedHandoff.sameFileBatchRecovery?.required === true &&
        sameFileBatchBlockedHandoff.sameFileBatchRecovery?.blockedByChangeIds?.[0] === "invalid-dialog-event" &&
        sameFileBatchBlockedHandoff.sameFileBatchRecovery?.retryUnaffectedChangesUnchanged === true &&
        sameFileBatchBlockedHandoff.instruction.includes("invalid-dialog-event") &&
        sameFileBatchBlockedHandoff.instruction.includes("原样保留"),
    });
    const clientDeployHandoff = applyAgentHandoff(
      path.join(tempRoot, "output", "APPLY-MANIFEST.json"),
      { sourceProfile: "fixture-client" },
    );
    checks.push({
      id: "apply-handoff-routes-profile-output-to-client-preview-without-manual-copy",
      ok:
        clientDeployHandoff.clientDeploymentSeparatelyAuthorized === true &&
        clientDeployHandoff.nextCommandOnly.includes("client-pvf preview") &&
        clientDeployHandoff.nextCommandOnly.includes("--profile \"fixture-client\"") &&
        clientDeployHandoff.nextCommandOnly.includes("--apply-manifest") &&
        clientDeployHandoff.instruction.includes("不要手工复制 PVF"),
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

    const interleavedVerifiedTextErrors = validateChangeSet({
      ...invalidDirectChineseChangeSet,
      changes: [
        {
          id: "title-before-structure", type: "replace-text", pvfPath: "stackable/fixture.stk",
          previousText: "`舊標題`", newText: "`新標題`", replaceAll: false,
          textWriteMode: VERIFIED_INLINE_TEXT_MODE, pvfEncoding: "Tw",
        },
        {
          id: "structure-between-text", type: "replace-text", pvfPath: "stackable/fixture.stk",
          previousText: "[section]\r\n1", newText: "[section]\r\n2", replaceAll: false,
          pvfEncoding: "Tw",
        },
        {
          id: "message-after-structure", type: "replace-text", pvfPath: "stackable/fixture.stk",
          previousText: "`舊訊息`", newText: "`新訊息`", replaceAll: false,
          textWriteMode: VERIFIED_INLINE_TEXT_MODE, pvfEncoding: "Tw",
        },
      ],
    });
    checks.push({
      id: "validate-rejects-interleaved-verified-ordinary-verified-same-file-batches",
      ok: interleavedVerifiedTextErrors.some((message) =>
        message.includes("VERIFIED_TEXT_BATCH_SPLIT_REQUIRED") &&
        message.includes("baseline.applyManifest") &&
        message.includes("structure-between-text")),
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
    const bytePreservingNutSelfTest = bytePreservingAsciiTextSelfTest();
    for (const check of bytePreservingNutSelfTest.checks) {
      checks.push({ ...check, id: `existing-nut-${check.id}` });
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

    const blockedDgnBatchSource = [
      "[name]",
      "`舊名稱`",
      "[explain]",
      "`舊說明`",
      "[tower dialog]",
      "1",
      "`舊對話`",
      "`on start`",
      "",
    ].join("\r\n");
    const blockedDgnBatchPlan = planReplacementGroup(
      blockedDgnBatchSource,
      [
        {
          id: "valid-dgn-name", type: "replace-text",
          previousText: "`舊名稱`", newText: "`新名稱`", replaceAll: false,
          pvfEncoding: "Tw", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        },
        {
          id: "valid-dgn-explain", type: "replace-text",
          previousText: "`舊說明`", newText: "`新說明`", replaceAll: false,
          pvfEncoding: "Tw", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        },
        {
          id: "invalid-dialog-event", type: "replace-text",
          previousText: "`on start`", newText: "`不應修改事件 token`", replaceAll: false,
          pvfEncoding: "Tw", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        },
      ],
      { pvfPath: "dungeon/Towers/TowerOfIllusion.dgn", pvfReadEncoding: "Tw", fallbackEncoding: "Tw" },
    );
    annotateSameFileBatchBlock(blockedDgnBatchPlan);
    checks.push({
      id: "same-file-valid-dgn-text-identifies-illegal-dialog-blocker-without-roundtrip-misdiagnosis",
      ok:
        blockedDgnBatchPlan.blocked === true &&
        blockedDgnBatchPlan.expectedText === blockedDgnBatchSource &&
        blockedDgnBatchPlan.items[0]?.blockCode === "FILE_CHANGE_BATCH_BLOCKED" &&
        blockedDgnBatchPlan.items[1]?.blockCode === "FILE_CHANGE_BATCH_BLOCKED" &&
        blockedDgnBatchPlan.items[0]?.blockDetails?.blockedByChangeId === "invalid-dialog-event" &&
        blockedDgnBatchPlan.items[1]?.blockDetails?.ownStaticCheckPassed === true &&
        blockedDgnBatchPlan.items[2]?.blockCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED" &&
        blockedDgnBatchPlan.items.every((item) => item.changed === false) &&
        blockedDgnBatchPlan.items.every((item) => item.blockCode !== "CN_TEXT_ROUNDTRIP_REQUIRED"),
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

    const scopedBlock = (part) =>
      `[check]\r\n0\t1\t\`${part}\`\r\n` +
      "[skill]\r\n0\t7\r\n[explain]\r\n`相同说明`\r\n" +
      "[skill]\r\n1\t8\r\n[explain]\r\n`保留说明`\r\n[/check]\r\n";
    const coatBlock = scopedBlock("coat");
    const supportBlock = scopedBlock("support");
    const ringBlock = scopedBlock("ring");
    const scopedSource = coatBlock + supportBlock + ringBlock;
    const coatScope = {
      startText: "[check]\r\n0\t1\t`coat`\r\n",
      endText: "[/check]",
      expectedRanges: 1,
    };
    const scopedDeletionPlan = planReplacementGroup(
      scopedSource,
      [
        {
          id: "scope-clear-explain", type: "replace-text",
          previousText: "`相同说明`", newText: "``", scope: coatScope,
          replaceAll: false, pvfEncoding: "Cn", textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        },
        {
          id: "scope-delete-option", type: "replace-text",
          previousText: "[skill]\r\n0\t7\r\n[explain]\r\n``\r\n", newText: "", scope: coatScope,
          replaceAll: false, pvfEncoding: "Cn",
        },
        {
          id: "scope-renumber-option", type: "replace-text",
          previousText: "[skill]\r\n1\t8\r\n", newText: "[skill]\r\n0\t8\r\n", scope: coatScope,
          replaceAll: false, pvfEncoding: "Cn",
        },
      ],
      { pvfPath: "stackable/consumption_1256.stk", pvfReadEncoding: "Cn", fallbackEncoding: "Cn" },
    );
    let scopedDeletionApplication = null;
    try { scopedDeletionApplication = buildSameFileApplicationPlan(scopedDeletionPlan); } catch { /* asserted below */ }
    const expectedScopedCoat =
      "[check]\r\n0\t1\t`coat`\r\n" +
      "[skill]\r\n0\t8\r\n[explain]\r\n`保留说明`\r\n[/check]\r\n";
    checks.push({
      id: "exact-scope-verified-delete-renumber-chain-isolates-one-homomorphic-block",
      ok:
        scopedDeletionPlan.blocked === false &&
        scopedDeletionApplication?.verifiedInsertionIndex === 0 &&
        scopedDeletionApplication?.requiresTemporaryOrderedProof === true &&
        scopedDeletionApplication?.finalText === expectedScopedCoat + supportBlock + ringBlock &&
        scopedDeletionPlan.items.every((item) =>
          item.occurrenceCount === 1 &&
          item.contextAnchor?.scopeApplied === true &&
          item.contextAnchor?.scope?.rangeCount === 1 &&
          /^[a-f0-9]{64}$/.test(String(item.contextAnchor?.scope?.rangeBindingSha256 || "")) &&
          /^[a-f0-9]{64}$/.test(String(item.contextAnchor?.scope?.ranges?.[0]?.contentSha256 || "")) &&
          item.totalOccurrenceCount >= 1),
    });

    const scopeBeforeDrift = analyzeContextAnchoredReplacement({
      sourceText: scopedSource,
      previousText: "`相同说明`",
      newText: "``",
      scope: coatScope,
      replaceAll: false,
    });
    const scopeAfterDrift = analyzeContextAnchoredReplacement({
      sourceText: scopedSource.replace("[skill]\r\n1\t8", "[skill]\r\n1\t80"),
      previousText: "`相同说明`",
      newText: "``",
      scope: coatScope,
      replaceAll: false,
    });
    checks.push({
      id: "exact-scope-content-drift-changes-location-binding",
      ok:
        scopeBeforeDrift.evidence.selectorSha256 === scopeAfterDrift.evidence.selectorSha256 &&
        scopeBeforeDrift.evidence.locationBindingSha256 !== scopeAfterDrift.evidence.locationBindingSha256 &&
        scopeBeforeDrift.evidence.scope.ranges[0].contentSha256 !== scopeAfterDrift.evidence.scope.ranges[0].contentSha256,
    });

    const scopedContextAnalysis = analyzeContextAnchoredReplacement({
      sourceText: "<scope>LEFT:VALUE|RIGHT:VALUE</scope><other>RIGHT:VALUE</other>",
      previousText: "VALUE",
      newText: "NEW",
      contextBefore: "RIGHT:",
      scope: { startText: "<scope>", endText: "</scope>", expectedRanges: 1 },
      replaceAll: false,
    });
    checks.push({
      id: "exact-scope-and-adjacent-context-compose-inside-one-range",
      ok:
        scopedContextAnalysis.occurrenceCount === 1 &&
        scopedContextAnalysis.scopedOccurrenceCount === 2 &&
        scopedContextAnalysis.totalOccurrenceCount === 3 &&
        scopedContextAnalysis.evidence.mode === "exact-scope-adjacent-context" &&
        scopedContextAnalysis.evidence.anchored === true &&
        scopedContextAnalysis.evidence.scopeApplied === true,
    });
    const scopedBulkInput = {
      sourceText: "<scope>VALUE|VALUE</scope><other>VALUE</other>",
      previousText: "VALUE",
      newText: "NEW",
      scope: { startText: "<scope>", endText: "</scope>", expectedRanges: 1 },
      replaceAll: true,
      expectedOccurrences: 2,
    };
    const scopedBulkAnalysis = analyzeContextAnchoredReplacement(scopedBulkInput);
    checks.push({
      id: "exact-scope-replace-all-counts-inside-range-and-leaves-outside-match",
      ok:
        scopedBulkAnalysis.occurrenceCount === 2 &&
        scopedBulkAnalysis.totalOccurrenceCount === 3 &&
        applyContextAnchoredReplacement(scopedBulkInput, scopedBulkAnalysis) ===
          "<scope>NEW|NEW</scope><other>VALUE</other>",
    });
    const multiRangeBulkInput = {
      sourceText: "<s>VALUE</s>|<s>VALUE</s>|VALUE",
      previousText: "VALUE",
      newText: "NEW",
      scope: { startText: "<s>", endText: "</s>", expectedRanges: 2 },
      replaceAll: true,
      expectedOccurrences: 2,
    };
    const multiRangeBulkAnalysis = analyzeContextAnchoredReplacement(multiRangeBulkInput);
    checks.push({
      id: "exact-scope-supports-declared-non-overlapping-multiple-ranges",
      ok:
        multiRangeBulkAnalysis.evidence.scope?.rangeCount === 2 &&
        multiRangeBulkAnalysis.occurrenceCount === 2 &&
        applyContextAnchoredReplacement(multiRangeBulkInput, multiRangeBulkAnalysis) ===
          "<s>NEW</s>|<s>NEW</s>|VALUE",
    });

    for (const fixture of [
      {
        id: "exact-scope-range-count-mismatch-blocked",
        expectedCode: "SCOPE_RANGE_COUNT_MISMATCH",
        input: { sourceText: scopedSource, previousText: "`相同说明`", newText: "``", scope: { ...coatScope, expectedRanges: 2 } },
      },
      {
        id: "exact-scope-missing-end-marker-blocked",
        expectedCode: "SCOPE_END_NOT_FOUND",
        input: { sourceText: "<s>VALUE", previousText: "VALUE", newText: "NEW", scope: { startText: "<s>", endText: "</s>", expectedRanges: 1 } },
      },
      {
        id: "exact-scope-overlap-blocked",
        expectedCode: "SCOPE_RANGE_OVERLAP",
        input: { sourceText: "<s>A<s>B</s>C</s>", previousText: "B", newText: "N", scope: { startText: "<s>", endText: "</s>", expectedRanges: 2 } },
      },
      {
        id: "exact-scope-context-crossing-boundary-blocked",
        expectedCode: "SCOPE_CONTEXT_OUT_OF_BOUNDS",
        input: { sourceText: "<s>VALUE</s>", previousText: "VALUE", newText: "NEW", contextBefore: "<s>", scope: { startText: "<s>", endText: "</s>", expectedRanges: 1 } },
      },
      {
        id: "exact-scope-boundary-rewrite-blocked",
        expectedCode: "SCOPE_TARGET_OUT_OF_BOUNDS",
        input: { sourceText: scopedSource, previousText: coatScope.startText, newText: "", scope: coatScope },
      },
      {
        id: "exact-scope-marker-injection-blocked",
        expectedCode: "SCOPE_MARKER_INJECTION_BLOCKED",
        input: { sourceText: scopedSource, previousText: "`相同说明`", newText: "`新说明[/check]`", scope: coatScope },
      },
    ]) {
      let code = null;
      try { analyzeContextAnchoredReplacement({ replaceAll: false, ...fixture.input }); } catch (error) { code = error.code; }
      checks.push({ id: fixture.id, ok: code === fixture.expectedCode, code, expectedCode: fixture.expectedCode });
    }

    const unknownChangeFieldErrors = validateChangeSet({
      ...samePathHandoffChangeSet,
      changes: [{
        ...samePathHandoffChangeSet.changes[0],
        silentlyIgnoredSelector: "unsafe",
      }],
    });
    checks.push({
      id: "validate-rejects-unknown-change-field-instead-of-silently-ignoring-it",
      ok: unknownChangeFieldErrors.some((message) =>
        message.includes("changes[0] contains unsupported field(s): silentlyIgnoredSelector")),
    });

    const validScopedChangeSet = {
      ...samePathHandoffChangeSet,
      changes: [{ ...samePathHandoffChangeSet.changes[0], scope: coatScope }],
    };
    checks.push({
      id: "validate-accepts-complete-exact-scope-and-rejects-unknown-scope-field",
      ok:
        validateChangeSet(validScopedChangeSet).length === 0 &&
        validateChangeSet({
          ...validScopedChangeSet,
          changes: [{ ...validScopedChangeSet.changes[0], scope: { ...coatScope, part: "coat" } }],
        }).some((message) => message.includes("scope contains unsupported field(s): part")),
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
  const declaredProtectedSourcePvf = path.resolve(manifest.protectedSourcePvf || manifest.sourcePvf);
  const protectedSourceOriginPvf = path.resolve(
    manifest.protectedSourceOriginPvf ||
      manifest.cumulative?.protectedSourceOriginPvf ||
      declaredProtectedSourcePvf,
  );
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
      !samePath(manifest.cumulative.protectedSourcePvf || "", declaredProtectedSourcePvf) ||
      String(manifest.cumulative.protectedSourcePvfSha256 || "").toLowerCase() !== protectedSourcePvfSha256 ||
      (manifest.cumulative.protectedSourceOriginPvf !== undefined &&
        !samePath(manifest.cumulative.protectedSourceOriginPvf || "", protectedSourceOriginPvf)) ||
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
  let protectedSourcePvf = declaredProtectedSourcePvf;
  const recordedBackupPath = manifest.backupPath ? path.resolve(manifest.backupPath) : null;
  const recordedBackupVerified =
    manifest.safety?.backupCreated === true &&
    manifest.safety?.backupContentAddressed === true &&
    manifest.safety?.backupSha256Verified === true;
  if (recordedBackupPath && recordedBackupVerified) {
    if (pathInside(workbenchRoot, recordedBackupPath)) {
      throw codedError("CUMULATIVE_PROTECTED_SOURCE_UNVERIFIED", "上一轮受保护源备份错误地位于工作台内部。");
    }
    if (
      path.basename(path.dirname(recordedBackupPath)).toLowerCase() !== "sha256" ||
      path.basename(recordedBackupPath).toLowerCase() !== `${protectedSourcePvfSha256}.script.pvf`
    ) {
      throw codedError("CUMULATIVE_PROTECTED_SOURCE_UNVERIFIED", "上一轮受保护源备份路径没有按其 SHA256 命名。");
    }
    if (!fs.existsSync(recordedBackupPath) || !fs.statSync(recordedBackupPath).isFile()) {
      throw codedError("CUMULATIVE_PROTECTED_SOURCE_MISSING", `受保护源备份不存在：${recordedBackupPath}`);
    }
    if (sha256File(recordedBackupPath).toLowerCase() !== protectedSourcePvfSha256) {
      throw codedError("CUMULATIVE_PROTECTED_SOURCE_CHANGED", "受保护源备份 SHA256 不符，不能继续上一轮基线。");
    }
    protectedSourcePvf = recordedBackupPath;
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
    protectedSourceOriginPvf,
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
      protectedSourceOriginPvf: resolvedSource.sourcePvf,
      resolvedSource,
      cumulative: null,
    };
  }
  if (explicitPvf && !samePath(explicitPvf, cumulative.baselinePvf)) {
    throw codedError("CUMULATIVE_BASELINE_OVERRIDE_MISMATCH", "--pvf 必须指向上一轮生成记录绑定的输出 PVF；不要绕过累积基线。");
  }
  const profile = requestedProfile ? resolveSourcePvf(workbenchRoot, requestedProfile, null).profile : null;
  if (
    profile &&
    !samePath(profile.sourcePvf, cumulative.protectedSourcePvf) &&
    !samePath(profile.sourcePvf, cumulative.protectedSourceOriginPvf)
  ) {
    throw codedError("CUMULATIVE_PROFILE_SOURCE_MISMATCH", "所选 profile 的受保护源与上一轮生成记录不一致。");
  }
  if (
    !samePath(path.resolve(changeSet.target.sourcePvf), cumulative.protectedSourcePvf) &&
    !samePath(path.resolve(changeSet.target.sourcePvf), cumulative.protectedSourceOriginPvf)
  ) {
    throw codedError("CUMULATIVE_CHANGE_SET_SOURCE_MISMATCH", "change-set target.sourcePvf 必须保持为累积链最初的受保护源 PVF。");
  }
  return {
    sourcePvf: cumulative.baselinePvf,
    protectedSourcePvf: cumulative.protectedSourcePvf,
    protectedSourceOriginPvf: cumulative.protectedSourceOriginPvf,
    resolvedSource: {
      sourcePvf: cumulative.protectedSourceOriginPvf,
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
    protectedSourceOriginPvf: cumulative.protectedSourceOriginPvf,
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
  const capabilityRegistry = validateWritePolicyCapabilityRegistry(runner.capabilityRegistry);
  if (!capabilityRegistry.ok) {
    throw new Error(`Controlled write capability registry is incomplete or unsafe: ${capabilityRegistry.errors.join("; ")}`);
  }
  const executionPlanContract = validateExecutionPlanPolicy(runner.executionPlanContract);
  if (!executionPlanContract.ok) {
    throw new Error(`Controlled execution plan contract is incomplete or unsafe: ${executionPlanContract.errors.join("; ")}`);
  }
  const verifiedTextEligibilityContract = validateVerifiedTextEligibilityContract(runner.verifiedTextEligibilityContract);
  if (!verifiedTextEligibilityContract.ok) {
    throw new Error(`Verified-text eligibility contract is incomplete or unsafe: ${verifiedTextEligibilityContract.errors.join("; ")}`);
  }
  const semanticSafety = runner.semanticTextSafety || {};
  if (
    semanticSafety.automaticEncodingConflictGuardRequired !== true ||
    semanticSafety.cnStrWriteAllowed !== false ||
    semanticSafety.unverifiedDirectNonAsciiTextWriteAllowed !== false ||
    semanticSafety.verifiedInlineTextWriteAllowed !== true ||
    semanticSafety.verifiedInlineTextMultilineAllowed !== true ||
    semanticSafety.verifiedInlineTextBatchRequiresExactExpectedOccurrences !== true ||
    semanticSafety.verifiedInlineTextEligibilityDefaultBlocked !== true ||
    semanticSafety.verifiedInlineTextEligibilityProofBoundToDryRunAndApply !== true ||
    semanticSafety.verifiedInlineTextUnknownRuleAllowed !== false ||
    semanticSafety.verifiedInlineTextPermissionExpansionAllowed !== false ||
    semanticSafety.exactAdjacentContextAnchoringAllowed !== true ||
    semanticSafety.contextAnchorDoesNotRelaxTextSafety !== true ||
    semanticSafety.exactRangeScopeAllowed !== true ||
    semanticSafety.scopeBoundaryRewriteAllowed !== false ||
    semanticSafety.scopeEvidenceBoundToDryRunAndApply !== true ||
    semanticSafety.sameFileChangesPlannedAsOneFinalText !== true ||
    semanticSafety.sameFileChangeOrderPreservedWhenRequired !== true ||
    semanticSafety.sameFileVerifiedInlineTextAppliedAsOneBatch !== true ||
    semanticSafety.stringTableAppendedOncePerVerifiedFileBatch !== true ||
    semanticSafety.stringLinkTextWriteAllowed !== false ||
    semanticSafety.cnAndTwRoundTripProbeRequired !== true ||
    semanticSafety.numericOrAsciiMinimalWriteAllowed !== true ||
    semanticSafety.samePvfOrdinaryTextCopyAllowed !== true ||
    semanticSafety.samePvfCopyRequiresSameExtension !== true ||
    semanticSafety.samePvfCopyRequiresAbsentTarget !== true ||
    semanticSafety.samePvfCopyHighRiskExtensionsAllowed !== false ||
    semanticSafety.samePvfCopyRoundTripProbeRequired !== true ||
    semanticSafety.samePvfCopyModificationRequiresCumulativeNextRound !== true ||
    semanticSafety.highRiskNewFileProofRequired !== true ||
    semanticSafety.highRiskNewFileRoundTripProbeRequired !== true ||
    semanticSafety.highRiskFinalIndependentReadbackRequired !== true ||
    semanticSafety.highRiskSameExtensionReferenceRequired !== true ||
    semanticSafety.existingHighRiskFileProtectionRemains !== true ||
    semanticSafety.existingNutControlledEditRequiresDedicatedProof !== true ||
    semanticSafety.existingNutAsciiOnly !== true ||
    semanticSafety.existingNutSourceTextSha256Required !== true ||
    semanticSafety.existingNutRawBytePreservingPatchRequired !== true ||
    semanticSafety.existingNutWholeFileReencodingAllowed !== false ||
    semanticSafety.existingNutNonTargetRawBytesMustRemainIdentical !== true ||
    semanticSafety.existingNutLoadChainRequired !== true ||
    semanticSafety.existingNutFunctionApiAndApidAuditRequired !== true ||
    semanticSafety.existingNutEvidenceMustBeExecutableCode !== true ||
    semanticSafety.existingNutApidMustBeExactIntegerLiteral !== true ||
    semanticSafety.existingNutApidMustBeDeclaredApiCallArgument !== true ||
    semanticSafety.existingNutTemporaryRoundTripRequired !== true ||
    semanticSafety.existingNutFinalIndependentReadbackRequired !== true ||
    semanticSafety.existingNutRuntimeValidationRequired !== true ||
    semanticSafety.structuredUpgradeTableEditAllowed !== true ||
    semanticSafety.structuredUpgradeTableExactPathsOnly !== true ||
    semanticSafety.structuredUpgradeTableWidth !== 17 ||
    semanticSafety.structuredUpgradeLevelIndexIsZeroBasedGroupIndex !== true ||
    semanticSafety.structuredUpgradeIndependentGroupSelectorsAllowed !== true ||
    semanticSafety.structuredUpgradeGameplayDisplayLevelMappingInferred !== false ||
    semanticSafety.structuredUpgradeFirstColumnIsExplicitLevelNumber !== false ||
    semanticSafety.structuredUpgradeColumnsMustFormExactPartition !== true ||
    semanticSafety.structuredUpgradeExactSetCellsExpectedValueRequired !== true ||
    semanticSafety.structuredUpgradeComponentNoOpProofRequired !== true ||
    semanticSafety.structuredUpgradeAllNoOpApplyAuthorized !== false ||
    semanticSafety.structuredUpgradeAllSixRarityLimitsRequired !== true ||
    semanticSafety.structuredAmplificationConstGroupWidth !== 4 ||
    semanticSafety.structuredAmplificationConstHasLevelZeroGroup !== true ||
    semanticSafety.structuredForgingFileExcluded !== true ||
    semanticSafety.structuredUpgradeTemporaryRoundTripRequired !== true ||
    semanticSafety.structuredUpgradeFinalIndependentReadbackRequired !== true ||
    semanticSafety.structuredUpgradeRuntimeValidationRequired !== true ||
    semanticSafety.existingCoSqrStrProtectionRemains !== true ||
    semanticSafety.registryLifecycleOnlyForExplicitRowAdd !== true ||
    semanticSafety.registryLifecycleExistingTextPreserved !== true ||
    semanticSafety.registryLifecycleTargetClosureRequired !== true ||
    semanticSafety.worldmapLifecycleRequiresRegistryUiDungeonTownRegionClosure !== true ||
    semanticSafety.worldmapLifecycleRequiresBothTownAndRegion !== true ||
    semanticSafety.clientTextSmokeCheckRequired !== true ||
    !Array.isArray(semanticSafety.protectedNewWorldmapExtensions) ||
    !semanticSafety.protectedNewWorldmapExtensions.includes(".wdm")
  ) {
    throw new Error("Controlled write runner semantic text safety policy is incomplete or unsafe.");
  }
  const allowedBridgeTools = new Set(runner.allowedBridgeTools || []);
  for (const tool of ["pvf_open", "pvf_list_files", "pvf_search", "pvf_read_file", "pvf_replace_text", "pvf_apply_text_plan", "pvf_apply_verified_text_plan", "pvf_write_file", "pvf_save", "pvf_close"]) {
    if (!allowedBridgeTools.has(tool)) {
      throw new Error(`controlledWriteRunner.allowedBridgeTools is missing required tool: ${tool}`);
    }
  }
  const allowedOperations = new Set(writePolicy.allowedOperations || []);
  for (const operation of ["dry-run-upgrade-table-level-edit", "apply-upgrade-table-level-edit-to-explicit-output"]) {
    if (!allowedOperations.has(operation)) throw new Error(`write-policy.json is missing required controlled operation: ${operation}`);
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

function reportUnsupportedFields(value, supportedFields, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const supported = new Set(supportedFields);
  const unsupported = Object.keys(value).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    errors.push(`${label} contains unsupported field(s): ${unsupported.join(", ")}.`);
  }
}

function validateChangeSet(changeSet) {
  const errors = [];
  if (!changeSet || typeof changeSet !== "object" || Array.isArray(changeSet)) {
    return ["change-set root must be an object."];
  }
  reportUnsupportedFields(
    changeSet,
    CHANGE_SET_FIELD_CONTRACT.root,
    "change-set root",
    errors,
  );
  if (changeSet.schemaVersion !== "1.0") {
    errors.push("schemaVersion must be 1.0.");
  }
  if (changeSet.mode !== "dry-run-only") {
    errors.push("mode must be dry-run-only.");
  }
  if (!changeSet.target || typeof changeSet.target.sourcePvf !== "string" || !changeSet.target.sourcePvf.trim()) {
    errors.push("target.sourcePvf is required.");
  }
  reportUnsupportedFields(
    changeSet.target,
    CHANGE_SET_FIELD_CONTRACT.target,
    "target",
    errors,
  );
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
      reportUnsupportedFields(changeSet.baseline, CHANGE_SET_FIELD_CONTRACT.baseline, "baseline", errors);
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
  reportUnsupportedFields(
    changeSet.safety,
    CHANGE_SET_FIELD_CONTRACT.safety,
    "safety",
    errors,
  );

  const ids = new Set();
  for (const [index, change] of (Array.isArray(changeSet.changes) ? changeSet.changes : []).entries()) {
    const prefix = `changes[${index}]`;
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    const commonChangeFields = ["id", "type", "pvfPath", "pvfEncoding", "rationale", "requiredResolvedIds", "writeProof"];
    if (change.type === "replace-text") {
      reportUnsupportedFields(
        change,
        CHANGE_SET_FIELD_CONTRACT.changeTypes["replace-text"],
        prefix,
        errors,
      );
    } else if (change.type === "write-file") {
      reportUnsupportedFields(
        change,
        CHANGE_SET_FIELD_CONTRACT.changeTypes["write-file"],
        prefix,
        errors,
      );
    } else if (change.type === COPY_FILE_CHANGE_TYPE) {
      reportUnsupportedFields(
        change,
        CHANGE_SET_FIELD_CONTRACT.changeTypes["copy-file"],
        prefix,
        errors,
      );
    } else if (change.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE) {
      reportUnsupportedFields(
        change,
        CHANGE_SET_FIELD_CONTRACT.changeTypes["upgrade-table-level-edit"],
        prefix,
        errors,
      );
    } else {
      reportUnsupportedFields(change, commonChangeFields, prefix, errors);
    }
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
      if (change.scope !== undefined) {
        if (!change.scope || typeof change.scope !== "object" || Array.isArray(change.scope)) {
          errors.push(`${prefix}.scope must be an exact-range object when present.`);
        } else {
          reportUnsupportedFields(
            change.scope,
            CHANGE_SET_FIELD_CONTRACT.scope,
            `${prefix}.scope`,
            errors,
          );
          for (const field of ["startText", "endText"]) {
            if (typeof change.scope[field] !== "string" || change.scope[field].length === 0) {
              errors.push(`${prefix}.scope.${field} must be a non-empty exact string.`);
            }
          }
          if (!Number.isSafeInteger(change.scope.expectedRanges) || change.scope.expectedRanges < 1) {
            errors.push(`${prefix}.scope.expectedRanges must be a positive integer.`);
          }
          if (
            typeof change.scope.startText === "string" &&
            change.scope.startText === change.scope.endText
          ) {
            errors.push(`${prefix}.scope.startText and scope.endText must differ.`);
          }
          if (
            typeof change.newText === "string" &&
            (
              (typeof change.scope.startText === "string" && change.newText.includes(change.scope.startText)) ||
              (typeof change.scope.endText === "string" && change.newText.includes(change.scope.endText))
            )
          ) {
            errors.push(`[SCOPE_MARKER_INJECTION_BLOCKED] ${prefix}.newText must not inject scope.startText or scope.endText.`);
          }
        }
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
        const detach = change.textWriteMode === "verified-stringlink-detach";
        const validPrevious = detach
          ? /^<(\d+)::([^>`\r\n]{1,512})`([^`]*)`>$/u.test(change.previousText)
          : completeBacktickToken(change.previousText);
        if (!validPrevious || !completeBacktickToken(change.newText)) {
          errors.push(`[CN_TEXT_TOKEN_REQUIRED] ${prefix}.previousText and newText must each be one complete backtick token in verified inline text mode.`);
        }
        if (!new Set(["Cn", "Tw"]).has(change.pvfEncoding)) {
          errors.push(`[TEXT_ENCODING_REQUIRED] ${prefix}.pvfEncoding must be the Cn or Tw encoding selected by pvf-read --raw.`);
        }
      }
      if (change.writeProof !== undefined) {
        reportUnsupportedFields(
          change.writeProof,
          CHANGE_SET_FIELD_CONTRACT.writeProof,
          `${prefix}.writeProof`,
          errors,
        );
        if (change.writeProof?.mode === "registry-lifecycle") {
          if (!String(change.pvfPath || "").toLowerCase().replace(/\\/g, "/").endsWith(".lst")) {
            errors.push(`${prefix}.writeProof registry-lifecycle requires a .lst pvfPath.`);
          }
          if (change.writeProof?.allowExistingRegistryEdit !== true) {
            errors.push(`${prefix}.writeProof.allowExistingRegistryEdit must be true for a controlled registry row change.`);
          }
          if (!change.writeProof?.registry || typeof change.writeProof.registry !== "object") {
            errors.push(`${prefix}.writeProof.registry is required for a controlled registry row change.`);
          } else {
            reportUnsupportedFields(change.writeProof.registry, CHANGE_SET_FIELD_CONTRACT.registryProof, `${prefix}.writeProof.registry`, errors);
            if (change.writeProof.registry.action !== "add") errors.push(`${prefix}.writeProof.registry.action must be add for an existing .lst.`);
            if (!Number.isSafeInteger(change.writeProof.registry.id) || change.writeProof.registry.id < 0) errors.push(`${prefix}.writeProof.registry.id must be a non-negative integer.`);
            if (typeof change.writeProof.registry.expectedPvfPath !== "string" || !change.writeProof.registry.expectedPvfPath.trim()) errors.push(`${prefix}.writeProof.registry.expectedPvfPath is required.`);
            if (normalizePvfPath(change.writeProof.registry.lstPath).toLowerCase() !== normalizePvfPath(change.pvfPath).toLowerCase()) {
              errors.push(`${prefix}.writeProof.registry.lstPath must match pvfPath for an existing .lst.`);
            }
          }
        } else if (change.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE) {
          const proofShape = validateExistingNutWriteProofShape(change.pvfPath, change.writeProof);
          for (const message of proofShape.errors) errors.push(`[EXISTING_NUT_WRITE_PROOF_REQUIRED] ${prefix}: ${message}`);
          const existingNutEncoding = change.pvfEncoding || changeSet.target?.pvfReadEncoding;
          if (!new Set(["Cn", "Tw", "Utf8"]).has(existingNutEncoding)) {
            errors.push(`${prefix}.pvfEncoding (or target.pvfReadEncoding) must be Cn, Tw or Utf8 for an existing NUT controlled edit.`);
          }
          if (change.textWriteMode !== undefined) errors.push(`${prefix}.textWriteMode is not allowed for an existing NUT controlled edit.`);
          for (const [linkIndex, link] of (Array.isArray(change.writeProof.loadChain) ? change.writeProof.loadChain : []).entries()) {
            reportUnsupportedFields(link, CHANGE_SET_FIELD_CONTRACT.loadChainEntry, `${prefix}.writeProof.loadChain[${linkIndex}]`, errors);
          }
          if (change.writeProof.skillProc !== undefined) {
            reportUnsupportedFields(change.writeProof.skillProc, CHANGE_SET_FIELD_CONTRACT.skillProc, `${prefix}.writeProof.skillProc`, errors);
            for (const field of ["stateRegistration", "headerRegistration"]) reportUnsupportedFields(change.writeProof.skillProc?.[field], CHANGE_SET_FIELD_CONTRACT.loadChainEntry, `${prefix}.writeProof.skillProc.${field}`, errors);
          }
          for (const [symbolIndex, symbol] of (Array.isArray(change.writeProof.apiSymbols) ? change.writeProof.apiSymbols : []).entries()) {
            reportUnsupportedFields(symbol, CHANGE_SET_FIELD_CONTRACT.apiSymbol, `${prefix}.writeProof.apiSymbols[${symbolIndex}]`, errors);
          }
          if (change.writeProof.apidPlan && typeof change.writeProof.apidPlan === "object" && !Array.isArray(change.writeProof.apidPlan)) {
            reportUnsupportedFields(change.writeProof.apidPlan, CHANGE_SET_FIELD_CONTRACT.apidPlan, `${prefix}.writeProof.apidPlan`, errors);
          }
        } else {
          errors.push(`${prefix}.writeProof.mode is only allowed as registry-lifecycle or ${EXISTING_NUT_CONTROLLED_MODE} on replace-text changes.`);
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
      const highRiskMode = HIGH_RISK_NEW_FILE_MODES[extensionOf(change.pvfPath)];
      if (highRiskMode) {
        const proofShape = validateWriteProofShape(change.pvfPath, change.writeProof);
        if (!proofShape.ok) errors.push(`[HIGH_RISK_WRITE_PROOF_REQUIRED] ${prefix}: ${proofShape.errors.join("; ")}`);
        if (change.writeProof?.pvfEncoding && change.pvfEncoding && change.writeProof.pvfEncoding !== change.pvfEncoding) {
          errors.push(`${prefix}.writeProof.pvfEncoding must match change.pvfEncoding.`);
        }
        if (highRiskMode === "localization-new-file" && change.writeProof?.encodingRoundTripRequired !== true) {
          errors.push(`${prefix}.writeProof.encodingRoundTripRequired must be true for a new .str.`);
        }
        if (highRiskMode === "script-new-file" && change.writeProof?.compileRequired !== true) {
          errors.push(`${prefix}.writeProof.compileRequired must be true for a new script file.`);
        }
      } else if (change.writeProof !== undefined) {
        errors.push(`${prefix}.writeProof is only supported for audited high-risk new files or registry lifecycle changes.`);
      }
    } else if (change.type === COPY_FILE_CHANGE_TYPE) {
      if (typeof change.sourcePvfPath !== "string" || !change.sourcePvfPath.trim()) {
        errors.push(`${prefix}.sourcePvfPath is required.`);
      }
      if (change.expectAbsent !== true) {
        errors.push(`${prefix}.expectAbsent must be true; controlled copy-file cannot overwrite an existing PVF path.`);
      }
      if (change.compileScript !== undefined && typeof change.compileScript !== "boolean") {
        errors.push(`${prefix}.compileScript must be boolean when present.`);
      }
      const sourcePvfPath = normalizePvfPath(change.sourcePvfPath);
      const targetPvfPath = normalizePvfPath(change.pvfPath);
      if (sourcePvfPath && targetPvfPath && sourcePvfPath.toLowerCase() === targetPvfPath.toLowerCase()) {
        errors.push(`${prefix}.sourcePvfPath must differ from pvfPath.`);
      }
      if (sourcePvfPath && targetPvfPath && extensionOf(sourcePvfPath) !== extensionOf(targetPvfPath)) {
        errors.push(`${prefix}.sourcePvfPath and pvfPath must use the same file extension.`);
      }
      if (HIGH_RISK_NEW_FILE_MODES[extensionOf(targetPvfPath)]) {
        errors.push(`[COPY_FILE_HIGH_RISK_TYPE_BLOCKED] ${prefix} cannot copy a protected high-risk file type; use the dedicated writeProof route.`);
      }
      if (change.writeProof !== undefined) {
        errors.push(`${prefix}.writeProof is not supported for copy-file.`);
      }
    } else if (change.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE) {
      const shape = validateUpgradeTableLevelEditShape(change);
      for (const message of shape.errors) errors.push(`[UPGRADE_TABLE_EDIT_SHAPE_INVALID] ${prefix}: ${message}`);
      if (change.writeProof !== undefined) errors.push(`${prefix}.writeProof is not supported for ${UPGRADE_TABLE_LEVEL_EDIT_TYPE}.`);
    } else {
      errors.push(`${prefix}.type must be replace-text, write-file, ${COPY_FILE_CHANGE_TYPE} or ${UPGRADE_TABLE_LEVEL_EDIT_TYPE}.`);
    }
    if (change.requiredResolvedIds !== undefined) {
      if (!Array.isArray(change.requiredResolvedIds)) {
        errors.push(`${prefix}.requiredResolvedIds must be an array when present.`);
      } else {
        for (const [requiredIndex, required] of change.requiredResolvedIds.entries()) {
          const requiredPrefix = `${prefix}.requiredResolvedIds[${requiredIndex}]`;
          if (!required || typeof required !== "object" || Array.isArray(required)) {
            errors.push(`${requiredPrefix} must be an object.`);
            continue;
          }
          reportUnsupportedFields(required, CHANGE_SET_FIELD_CONTRACT.requiredResolvedId, requiredPrefix, errors);
          if (typeof required.lstPath !== "string") errors.push(`${requiredPrefix}.lstPath must be a string.`);
          if (!Number.isSafeInteger(required.id)) errors.push(`${requiredPrefix}.id must be an integer.`);
          if (typeof required.expectedPvfPath !== "string") errors.push(`${requiredPrefix}.expectedPvfPath must be a string.`);
        }
      }
    }
  }
  const declaredIds = new Set((Array.isArray(changeSet.changes) ? changeSet.changes : []).map((change) => change?.id).filter(Boolean));
  const generatedIds = new Set();
  for (const change of (Array.isArray(changeSet.changes) ? changeSet.changes : []).filter((item) => item?.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE)) {
    const componentIds = [`${change.id}.max-level-by-rarity`];
    if (normalizePvfPath(change.pvfPath).toLowerCase() === "etc/amplifyupgrade.etc") componentIds.push(`${change.id}.amplification-const`);
    for (const id of componentIds) {
      if (declaredIds.has(id) || generatedIds.has(id)) errors.push(`[UPGRADE_TABLE_GENERATED_ID_CONFLICT] Generated component id conflicts with another change: ${id}.`);
      generatedIds.add(id);
    }
  }
  for (const group of groupChangesByPvfPath(Array.isArray(changeSet.changes) ? changeSet.changes : [])) {
    const copyChanges = group.changes.filter((item) => item?.type === COPY_FILE_CHANGE_TYPE);
    const writeChanges = group.changes.filter((item) => item?.type === "write-file");
    const groupedReplaceChanges = group.changes.filter((item) => item?.type === "replace-text");
    const structuredChanges = group.changes.filter((item) => item?.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE);
    if (structuredChanges.length > 1 || (structuredChanges.length === 1 && group.changes.length !== 1)) {
      errors.push(`[UPGRADE_TABLE_TARGET_CONFLICT] ${UPGRADE_TABLE_LEVEL_EDIT_TYPE} must be the only change for ${group.pvfPath}.`);
    }
    if (copyChanges.length > 1) {
      errors.push(`[COPY_FILE_TARGET_CONFLICT] Only one copy-file change is allowed for ${group.pvfPath}.`);
    }
    if (copyChanges.length && (writeChanges.length || groupedReplaceChanges.length)) {
      errors.push(`[COPY_FILE_TARGET_CONFLICT] copy-file cannot be mixed with write-file or replace-text for ${group.pvfPath}; modify the clone in a cumulative next round.`);
    }
    const replaceChanges = group.changes.filter((item) => item?.type === "replace-text");
    const interleavedVerifiedTextIssues = findInterleavedVerifiedTextBatchIssues(group.changes);
    for (const issue of interleavedVerifiedTextIssues) {
      errors.push(
        `[VERIFIED_TEXT_BATCH_SPLIT_REQUIRED] 同一 pvfPath 的 verified-inline-text 不能分成被普通 replace-text 隔开的多个批次：${issue.pvfPath} 在普通变化 ${issue.ordinaryChangeId || "unknown"} 之后又出现文字变化 ${issue.changeId}。请拆为累计下一轮，并用 baseline.applyManifest 绑定上一轮 APPLY-MANIFEST.json；不要把上一轮输出写成新的 target.sourcePvf。`,
      );
    }
    const existingNutChanges = replaceChanges.filter((item) => item?.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE);
    if (!existingNutChanges.length) continue;
    if (existingNutChanges.length !== replaceChanges.length) {
      errors.push(`[EXISTING_NUT_PROOF_MISMATCH] Every replace-text change for ${group.pvfPath} must carry the same ${EXISTING_NUT_CONTROLLED_MODE} writeProof.`);
      continue;
    }
    const expectedProofSha256 = canonicalJsonSha256(existingNutChanges[0].writeProof);
    if (existingNutChanges.some((item) => canonicalJsonSha256(item.writeProof) !== expectedProofSha256)) {
      errors.push(`[EXISTING_NUT_PROOF_MISMATCH] All changes for ${group.pvfPath} must carry an identical existing NUT writeProof.`);
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

async function readVerifiedPvfCopySource(client, sessionId, changeSet, change, adapterConfig) {
  const sourcePvfPath = normalizePvfPath(change.sourcePvfPath);
  const targetPvfPath = normalizePvfPath(change.pvfPath);
  if (!sourcePvfPath || sourcePvfPath.toLowerCase() === targetPvfPath.toLowerCase()) {
    throw codedError("COPY_FILE_SOURCE_INVALID", "copy-file 的源路径必须存在且与目标路径不同。");
  }
  if (extensionOf(sourcePvfPath) !== extensionOf(targetPvfPath)) {
    throw codedError("COPY_FILE_EXTENSION_MISMATCH", "copy-file 只允许同扩展名复制。");
  }
  if (HIGH_RISK_NEW_FILE_MODES[extensionOf(targetPvfPath)]) {
    throw codedError("COPY_FILE_HIGH_RISK_TYPE_BLOCKED", "copy-file 不能绕过高风险新增文件的专用 writeProof 流程。");
  }
  const pvfEncoding = change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
  const read = await callAndParse(client, "pvf_read_file", {
    sessionId,
    pvfPath: sourcePvfPath,
    pvfEncoding,
    convertToSimplifiedChinese: false,
    autoConvertStringLink: false,
    semanticVerificationRead: true,
    maxChars: 0,
  });
  if (typeof read.textContent !== "string") {
    throw codedError("COPY_FILE_SOURCE_NOT_TEXT", `copy-file 源文件无法作为完整文本读取：${sourcePvfPath}`);
  }
  const textContent = read.textContent;
  const sourceTextSha256 = sha256(textContent);
  return {
    sourcePvfPath,
    textContent,
    raw: Buffer.from(textContent, "utf8"),
    sourceTextSha256,
    actualSha256: sourceTextSha256,
    metadata: read.metadata || null,
    semanticReadGuard: read.semanticReadGuard || null,
    samePvfCopyProof: {
      mode: "same-pvf-copy",
      sourcePvfPath,
      sourceTextSha256,
    },
  };
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
        scope: change.scope,
        writeProof: change.writeProof,
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
        scope: change.scope,
        writeProof: change.writeProof,
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
      scopedOccurrenceCount: anchored?.scopedOccurrenceCount ?? anchored?.totalOccurrenceCount ?? 0,
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

function annotateSameFileBatchBlock(plan) {
  if (!plan?.blocked || !Array.isArray(plan.items) || plan.items.length === 0) return plan;
  const blockerIndex = plan.items.findIndex((item) =>
    item.applicable !== true && item.blockCode !== "FILE_CHANGE_SEQUENCE_BLOCKED");
  if (blockerIndex < 0) return plan;
  const blocker = plan.items[blockerIndex];
  const dependency = {
    blockedByChangeId: blocker.change?.id || null,
    blockedByCode: blocker.blockCode || "SEMANTIC_WRITE_BLOCKED",
    blockedByReason: blocker.blockReason || "同一文件中的另一条变化未通过。",
    temporaryVerificationExecuted: false,
    retryAfterBlockerFixed: true,
  };
  plan.atomicBatchBlocker = dependency;
  for (let index = 0; index < plan.items.length; index += 1) {
    if (index === blockerIndex) continue;
    const item = plan.items[index];
    if (index < blockerIndex && item.applicable === true) {
      item.applicable = false;
      item.changed = false;
      item.after = item.before;
      item.blockCode = "FILE_CHANGE_BATCH_BLOCKED";
      item.blockReason = `变化 ${item.change?.id || "<unknown>"} 本身已通过静态检查，但同一文件中的变化 ${dependency.blockedByChangeId || "<unknown>"} 未通过，因此没有执行临时往返核验。请先修正或移除阻断项，再原样重试本变化。`;
      item.blockDetails = {
        ...dependency,
        ownStaticCheckPassed: true,
        retryThisChangeUnchanged: true,
      };
    } else if (item.blockCode === "FILE_CHANGE_SEQUENCE_BLOCKED") {
      item.blockDetails = {
        ...(item.blockDetails || {}),
        ...dependency,
        ownStaticCheckPassed: null,
        retryThisChangeUnchanged: false,
      };
    }
  }
  plan.expectedText = plan.sourceText;
  return plan;
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
          scope: item.change.scope,
          writeProof: item.change.writeProof,
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
        item.scopedOccurrenceCount = anchored.scopedOccurrenceCount;
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
        scope: item.change.scope,
        writeProof: item.change.writeProof,
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
        existingNutTransition: applied?.existingNutTransition || null,
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
        scope: item.change.scope,
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

async function runUpgradeTableRoundTripProbe({
  sourcePvf,
  changeSet,
  adapterConfig,
  writePolicy,
  filePlans,
}) {
  const outcomes = new Map();
  const probePlans = (Array.isArray(filePlans) ? filePlans : [])
    .filter((plan) => plan.structuredUpgradeEdit && plan.items.some((item) => item.changed));
  if (probePlans.length === 0) return outcomes;
  const probeBase = runtimePath(workbenchRoot, "upgrade-table-probes");
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
    if (!sourceSessionId) throw new Error("Upgrade-table probe pvf_open did not return a sessionId.");
    if (opened.session?.readOnly === true) {
      throw codedError("READ_ONLY_FALLBACK", "强化/增幅结构化编辑的临时独立验证需要 native 写入环境；当前只能读取。");
    }
    const coordinated = await applyFilePlansCoherently({
      client,
      sessionId: sourceSessionId,
      filePlans: probePlans,
      changeSet,
      adapterConfig,
    });
    sourceSessionId = coordinated.sessionId;
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
    if (!outputSessionId) throw new Error("Upgrade-table probe readback pvf_open did not return a sessionId.");
    for (const plan of probePlans) {
      const request = plan.structuredUpgradeEdit.request;
      const pvfEncoding = request.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const readback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: plan.pvfPath,
        pvfEncoding,
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
        readback.semanticReadGuard?.selectedEncoding === pvfEncoding;
      const reparsed = expandUpgradeTableLevelEdit(readback.textContent, request);
      const fixedPoint = reparsed.expectedText === readback.textContent;
      const structuralProofOk =
        reparsed.proof?.selectorsAreRawGroupIndexes === true &&
        reparsed.proof?.gameplayDisplayLevelMappingInferred === false &&
        reparsed.proof?.table?.width === 17 &&
        reparsed.proof?.table?.levelIndexMode === "zero-based-group-index" &&
        reparsed.proof?.table?.firstColumnIsLevelNumber === false &&
        validMaxLevelProof(reparsed.proof?.maxLevelByRarity, request) &&
        (normalizePvfPath(plan.pvfPath).toLowerCase() !== "etc/amplifyupgrade.etc" ||
          (reparsed.proof?.amplificationConst?.width === 4 && reparsed.proof?.amplificationConst?.hasLevelZeroGroup === true));
      const sourceUnchanged = sha256File(sourcePvf) === sourceSha256Before;
      const outputPvfSha256 = sha256File(outputPvf);
      const readbackProofByComponent = new Map([
        ["table", reparsed.proof?.table || null],
        ["max-level-by-rarity", reparsed.proof?.maxLevelByRarity || null],
        ["amplification-const", reparsed.proof?.amplificationConst || null],
      ]);
      for (const item of plan.items) {
        const componentState = item.changed ? "changed" : "no-op";
        const writerRequired = item.changed === true;
        const declaredProof = item.change.structuredEditProof || null;
        const componentReadbackProof = readbackProofByComponent.get(item.change.structuredEditComponent) || null;
        const writerProof = writerRequired
          ? coordinated.ordinaryResults.get(item.change.id)?.writeResult || null
          : null;
        const declaredValuesVerified =
          declaredProof?.declaredValuesVerified === true &&
          componentReadbackProof?.declaredValuesVerified === true;
        const componentStateOk =
          declaredProof?.componentState === componentState &&
          declaredProof?.writerRequired === writerRequired &&
          componentReadbackProof?.state === "no-op" &&
          componentReadbackProof?.writerRequired === false;
        const writerProofOk = !writerRequired || (
          writerProof?.existingStringEntriesPreserved === true &&
          writerProof?.exactIndependentTextReadback === true
        );
        const ok =
          comparison.exactTextOk === true && independentSemanticRead && fixedPoint && structuralProofOk && sourceUnchanged &&
          declaredValuesVerified && componentStateOk && writerProofOk;
        outcomes.set(item.change.id, {
          ok,
          code: ok ? null : "UPGRADE_TABLE_ROUNDTRIP_FAILED",
          reason: ok
            ? "强化/增幅结构化编辑已通过临时独立 PVF 写出、精确读回、重新解析和稳定结果检查。"
            : "强化/增幅结构化编辑未通过临时独立读回或重新解析，已阻止生成批准码。",
          sourceUnchanged,
          sourcePvfSha256: sourceSha256Before,
          independentSemanticRead,
          semanticReadGuard: readback.semanticReadGuard || null,
          comparison,
          writerProof,
          componentState,
          declaredValuesVerified,
          writerRequired,
          componentReadbackState: componentReadbackProof?.state || null,
          componentReadbackProof,
          fixedPoint,
          structuralProofOk,
          reparsedProof: reparsed.proof,
          outputPvfSha256,
          temporaryWriteExecuted: true,
          temporaryOutputRetained: false,
          clientWritten: false,
          inGameValidationRequired: true,
          staticChecksProveGameplayBehavior: false,
        });
      }
    }
  } catch (error) {
    for (const plan of probePlans) for (const item of plan.items) {
      outcomes.set(item.change.id, {
        ok: false,
        code: error.code || "UPGRADE_TABLE_ROUNDTRIP_FAILED",
        reason: error.message,
        sourceUnchanged: sha256File(sourcePvf) === sourceSha256Before,
        sourcePvfSha256: sourceSha256Before,
        componentState: item.changed ? "changed" : "no-op",
        declaredValuesVerified: false,
        writerRequired: item.changed === true,
        temporaryWriteExecuted: true,
        temporaryOutputRetained: false,
        clientWritten: false,
        inGameValidationRequired: true,
        staticChecksProveGameplayBehavior: false,
      });
    }
  } finally {
    if (outputSessionId) try { await callAndParse(client, "pvf_close", { sessionId: outputSessionId }); } catch { /* best effort */ }
    if (sourceSessionId) try { await callAndParse(client, "pvf_close", { sessionId: sourceSessionId }); } catch { /* best effort */ }
    client.stop();
    if (!pathInside(probeBase, probeRoot)) throw new Error(`Unsafe upgrade-table probe path: ${probeRoot}`);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  return outcomes;
}

async function runBinaryAniRoundTripProbe({
  sourcePvf,
  changeSet,
  adapterConfig,
  writePolicy,
  filePlans,
}) {
  const outcomes = new Map();
  if (!filePlans.length) return outcomes;
  const probeBase = path.join(os.tmpdir(), "pvf-workbench-binary-ani-probes");
  const probeRoot = path.join(probeBase, `${timestamp()}-${crypto.randomUUID()}`);
  const outputPvf = path.join(probeRoot, "Script.pvf");
  fs.mkdirSync(probeRoot, { recursive: true });
  const sourceSha256Before = sha256File(sourcePvf);
  const client = new BackendStdioClient(controlledWriteLaunchOptions(adapterConfig, writePolicy));
  let sourceSessionId = null;
  let outputSessionId = null;
  const expectedRawByPath = new Map();
  try {
    const opened = await callAndParse(client, "pvf_open", {
      path: sourcePvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    sourceSessionId = opened.session?.sessionId;
    if (!sourceSessionId) throw new Error("ANI probe pvf_open did not return a sessionId.");
    if (opened.session?.readOnly === true) {
      throw codedError("READ_ONLY_FALLBACK", "既有 ANI 的临时独立 PVF 往返验证需要 native 写入环境。");
    }
    const coordinated = await applyFilePlansCoherently({
      client,
      sessionId: sourceSessionId,
      filePlans,
      changeSet,
      adapterConfig,
    });
    sourceSessionId = coordinated.sessionId;
    for (const plan of coordinated.coordinatedPlans) {
      const rawHashes = new Set();
      for (const item of plan.items.filter((candidate) => candidate.changed)) {
        const applied = coordinated.ordinaryResults.get(item.change.id);
        const proof = applied?.writeResult;
        if (applied?.ok !== true || proof?.mode !== "raw-ascii-binary-ani" ||
            proof?.rawBytePreservingPatch !== true || proof?.nonTargetRawBytesPreserved !== true ||
            !/^[a-f0-9]{64}$/iu.test(String(proof?.outputRawSha256 || ""))) {
          throw codedError("RAW_ANI_TEMPORARY_APPLY_FAILED", `既有 ANI ${item.change.id} 未返回完整的临时原字节补丁证明。`);
        }
        rawHashes.add(String(proof.outputRawSha256).toLowerCase());
      }
      if (rawHashes.size !== 1) {
        throw codedError("RAW_ANI_TEMPORARY_PLAN_MISMATCH", `既有 ANI ${plan.pvfPath} 的临时原始字节计划不一致。`);
      }
      expectedRawByPath.set(normalizePvfPath(plan.pvfPath).toLowerCase(), [...rawHashes][0]);
    }
    await callAndParse(client, "pvf_save", { sessionId: sourceSessionId, targetPath: outputPvf, allowOverwriteSource: false });
    await callAndParse(client, "pvf_close", { sessionId: sourceSessionId });
    sourceSessionId = null;
    const reopened = await callAndParse(client, "pvf_open", {
      path: outputPvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    outputSessionId = reopened.session?.sessionId;
    if (!outputSessionId) throw new Error("ANI probe readback pvf_open did not return a sessionId.");
    for (const plan of filePlans) {
      const firstChange = plan.items[0]?.change || {};
      const encoding = firstChange.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const readback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: plan.pvfPath,
        pvfEncoding: encoding,
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
        maxChars: 0,
      });
      const rawReadback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: plan.pvfPath,
        pvfEncoding: encoding,
        semanticVerificationRead: true,
        rawSha256Only: true,
      });
      const comparison = pvfTextReadbackResult(plan.expectedText, readback.textContent);
      const expectedOutputRawSha256 = expectedRawByPath.get(normalizePvfPath(plan.pvfPath).toLowerCase()) || null;
      const actualOutputRawSha256 = String(rawReadback.rawContentSha256 || "").toLowerCase() || null;
      const rawByteReadbackOk = Boolean(expectedOutputRawSha256) && actualOutputRawSha256 === expectedOutputRawSha256;
      const independentSemanticRead = readback.semanticReadGuard?.applied === true &&
        readback.semanticReadGuard?.reason === "verified-text-readback" &&
        readback.semanticReadGuard?.backend === "typescript-readonly-fallback";
      const independentRawRead = rawReadback.semanticReadGuard?.applied === true &&
        rawReadback.semanticReadGuard?.reason === "verified-text-readback" &&
        rawReadback.semanticReadGuard?.backend === "typescript-readonly-fallback";
      const sourceUnchanged = sha256File(sourcePvf) === sourceSha256Before;
      const ok = comparison.exactTextOk === true && independentSemanticRead && independentRawRead && rawByteReadbackOk && sourceUnchanged;
      for (const item of plan.items.filter((candidate) => candidate.changed)) outcomes.set(item.change.id, {
        ok,
        code: ok ? null : "RAW_ANI_ROUNDTRIP_FAILED",
        reason: ok
          ? "既有 ANI [DELAY] 已通过临时独立 PVF 写出、二进制反编译和原始字节 SHA256 读回。"
          : "既有 ANI [DELAY] 未通过临时独立 PVF 与原始字节读回；已阻止生成批准码。",
        sourcePvfSha256: sourceSha256Before,
        sourceUnchanged,
        comparison,
        independentSemanticRead,
        independentRawRead,
        expectedOutputRawSha256,
        actualOutputRawSha256,
        rawByteReadbackOk,
        temporaryOutputPvfSha256: fs.existsSync(outputPvf) ? sha256File(outputPvf) : null,
        temporaryOutputRetained: false,
        runtimeValidationRequired: true,
        staticChecksProveGameplayBehavior: false,
      });
    }
  } catch (error) {
    for (const plan of filePlans) for (const item of plan.items.filter((candidate) => candidate.changed)) outcomes.set(item.change.id, {
      ok: false,
      code: error.code || "RAW_ANI_ROUNDTRIP_FAILED",
      reason: error.message,
      sourcePvfSha256: sourceSha256Before,
      sourceUnchanged: fs.existsSync(sourcePvf) && sha256File(sourcePvf) === sourceSha256Before,
      temporaryOutputRetained: false,
      runtimeValidationRequired: true,
      staticChecksProveGameplayBehavior: false,
    });
  } finally {
    if (outputSessionId) try { await callAndParse(client, "pvf_close", { sessionId: outputSessionId }); } catch { /* preserve result */ }
    if (sourceSessionId) try { await callAndParse(client, "pvf_close", { sessionId: sourceSessionId }); } catch { /* preserve result */ }
    client.stop();
    if (!pathInside(probeBase, probeRoot)) throw new Error(`Unsafe binary ANI probe path: ${probeRoot}`);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  return outcomes;
}

function scriptTagSignature(text) {
  return (String(text || "").match(/\[[^\]\r\n]+\]|\[\/[^\]\r\n]+\]/g) || [])
    .map((tag) => tag.trim().toLowerCase())
    .join("\n");
}

function shouldCompileNewFile(pvfPath, change = {}) {
  const ext = extensionOf(pvfPath);
  if ([".nut", ".sqr", ".str"].includes(ext)) return false;
  return change.compileScript !== false;
}

async function readTargetTextForAudit(client, sessionId, pvfPath, encoding, required = true) {
  try {
    const result = await callAndParse(client, "pvf_read_file", {
      sessionId,
      pvfPath,
      pvfEncoding: encoding,
      convertToSimplifiedChinese: false,
      autoConvertStringLink: false,
      semanticVerificationRead: true,
      maxChars: 0,
    });
    if (typeof result.textContent !== "string") {
      const error = new Error(`目标文件不是可审阅的文本：${pvfPath}`);
      error.code = "AUDIT_TARGET_NOT_TEXT";
      throw error;
    }
    return { exists: true, text: result.textContent, metadata: result.metadata || null };
  } catch (error) {
    if (!required) return { exists: false, text: null, error: error.message, code: error.code || null };
    throw error;
  }
}

let builtinNutApiCatalogCache = null;

function loadBuiltinNutApiCatalog() {
  if (builtinNutApiCatalogCache) return builtinNutApiCatalogCache;
  const file = path.join(workbenchRoot, "knowledge-pack", "indexes", "nut-api-facts.compact.json");
  const catalog = readJson(file);
  if (catalog.phase !== "builtin-nut-api-facts" || !Array.isArray(catalog.declarations)) {
    throw codedError("NUT_API_CATALOG_INVALID", "内置 NUT API 事实目录不可用，既有 NUT 修改保持阻断。");
  }
  builtinNutApiCatalogCache = { file, sha256: sha256File(file), declarations: catalog.declarations };
  return builtinNutApiCatalogCache;
}

async function cachedNutAuditText(client, sessionId, pvfPath, encoding, cache) {
  const normalized = normalizePvfPath(pvfPath);
  const key = normalized.toLowerCase();
  if (!cache.has(key)) {
    const read = await readTargetTextForAudit(client, sessionId, normalized, encoding, true);
    cache.set(key, { pvfPath: normalized, text: read.text });
  }
  return cache.get(key);
}

async function auditExistingNutControlledEdit({
  client,
  sessionId,
  pvfPath,
  sourceText,
  finalText,
  changes,
  changeSet,
  adapterConfig,
  textCache,
}) {
  const normalizedTarget = normalizePvfPath(pvfPath);
  const errors = [];
  const warnings = [];
  const proof = changes[0]?.writeProof || null;
  const proofSha256 = proof ? canonicalJsonSha256(proof) : null;
  for (const change of changes) {
    if (change.writeProof?.mode !== EXISTING_NUT_CONTROLLED_MODE || canonicalJsonSha256(change.writeProof) !== proofSha256) {
      errors.push("同一既有 NUT 的所有改动必须携带完全一致的专用 writeProof");
    }
  }
  const transition = validateExistingNutTextTransition(normalizedTarget, sourceText, finalText, proof, changes);
  if (!transition.ok) errors.push(...transition.errors);
  const encoding = changes[0]?.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
  const loadChainChecks = [];
  for (const link of Array.isArray(proof?.loadChain) ? proof.loadChain : []) {
    try {
      const source = await cachedNutAuditText(client, sessionId, link.fromPvfPath, encoding, textCache);
      const exactReferencePresent = proof.loadChainKind === "direct-character-state"
        ? directStateReferencePresent(source.text, link)
        : ["direct-character-skill-use", "direct-character-skill-proc"].includes(proof.loadChainKind) ? directSkillUseReferencePresent(source.text, link)
        : containsExecutableFragment(source.text, link.requiredText);
      loadChainChecks.push({
        fromPvfPath: normalizePvfPath(link.fromPvfPath),
        toPvfPath: normalizePvfPath(link.toPvfPath),
        requiredTextSha256: sha256(link.requiredText),
        sourceTextSha256: sha256(source.text),
        exactReferencePresent,
      });
      if (!exactReferencePresent) errors.push(`加载链缺少精确引用：${link.fromPvfPath} -> ${link.toPvfPath}`);
    } catch (error) {
      loadChainChecks.push({
        fromPvfPath: normalizePvfPath(link?.fromPvfPath),
        toPvfPath: normalizePvfPath(link?.toPvfPath),
        exactReferencePresent: false,
        error: error.message,
      });
      errors.push(`加载链文件无法读取：${link?.fromPvfPath}`);
    }
  }

  let skillProcCheck = null;
  if (proof?.loadChainKind === "direct-character-skill-proc") {
    try {
      if (!directSkillProcRegistration(proof)) throw new Error("invalid skill-proc proof");
      const evidence = proof.skillProc;
      const evidencePaths = {
        loaderText: proof.loadChain[0].fromPvfPath,
        headerText: evidence.headerRegistration.toPvfPath,
        registryText: evidence.skillRegistryPath,
        skillText: evidence.skillPvfPath,
        stateText: evidence.stateRegistration.toPvfPath,
      };
      const texts = { commonText: sourceText };
      const bindings = [];
      for (const [key, evidencePath] of Object.entries(evidencePaths)) {
        // The skill's numeric data may change atomically. Its identity evidence may not.
        if (key !== "skillText" && (changeSet.changes || []).some((item) => normalizePvfPath(item.pvfPath).toLowerCase() === normalizePvfPath(evidencePath).toLowerCase())) throw new Error(`skill-proc evidence must stay unchanged: ${evidencePath}`);
        const read = await cachedNutAuditText(client, sessionId, evidencePath, encoding, textCache);
        texts[key] = read.text;
        bindings.push({ pvfPath: read.pvfPath, sourceTextSha256: sha256(read.text) });
      }
      skillProcCheck = { ...directSkillProcEvidence(proof, texts), bindings };
      if (!skillProcCheck.ok) errors.push(...skillProcCheck.errors);
    } catch (error) {
      skillProcCheck = { ok: false, errors: [error.message] };
      errors.push(`skill-proc evidence failed: ${error.message}`);
    }
  }

  let catalog = null;
  try {
    catalog = loadBuiltinNutApiCatalog();
  } catch (error) {
    errors.push(error.message);
  }
  const apiSymbolChecks = [];
  for (const symbol of Array.isArray(proof?.apiSymbols) ? proof.apiSymbols : []) {
    const catalogMatches = catalog
      ? catalog.declarations.filter((item) =>
        item.group === "dnf" &&
        item.kind === symbol.kind &&
        [item.name, item.qualifiedName].some((name) => String(name || "") === String(symbol.name || "")))
      : [];
    if (catalogMatches.length === 0) errors.push(`内置 DNF NUT API 事实目录未精确声明：${symbol.kind} ${symbol.name}`);
    const evidence = [];
    for (const evidencePath of Array.isArray(symbol.targetEvidencePaths) ? symbol.targetEvidencePaths : []) {
      try {
        const target = await cachedNutAuditText(client, sessionId, evidencePath, encoding, textCache);
        const exactSymbolPresent = symbol.kind === "function"
          ? containsExactFunctionCall(target.text, symbol.name)
          : containsExactIdentifier(target.text, symbol.name);
        evidence.push({ pvfPath: target.pvfPath, textSha256: sha256(target.text), exactSymbolPresent });
      } catch (error) {
        evidence.push({ pvfPath: normalizePvfPath(evidencePath), exactSymbolPresent: false, error: error.message });
      }
    }
    if (!evidence.some((item) => item.exactSymbolPresent)) errors.push(`目标 PVF 证据脚本未观察到精确符号：${symbol.name}`);
    apiSymbolChecks.push({
      name: symbol.name,
      kind: symbol.kind,
      catalogDeclared: catalogMatches.length > 0,
      catalogQualifiedNames: [...new Set(catalogMatches.map((item) => item.qualifiedName))],
      finalTargetUsesSymbol: symbol.kind === "function"
        ? containsExactFunctionCall(finalText, symbol.name)
        : containsExactIdentifier(finalText, symbol.name),
      targetEvidence: evidence,
    });
  }

  const apidChecks = [];
  for (const id of Array.isArray(proof?.apidPlan?.ids) ? proof.apidPlan.ids : []) {
    try {
      const search = await callAndParse(client, "pvf_search", {
        sessionId,
        keyword: String(id),
        searchPath: "sqr",
        isStartMatch: false,
        isUseLikeSearchPath: false,
        searchType: "SearchScript",
        matchMode: "Like",
        pvfEncoding: encoding,
        convertToSimplifiedChinese: false,
        limit: 2000,
      });
      const returned = Array.isArray(search.items) ? search.items : [];
      const matchedCount = Number(search.matchedCount ?? returned.length);
      const incomplete = search.truncated === true || matchedCount > returned.length || Number(search.errorCount || 0) > 0;
      const collisions = [];
      for (const item of returned) {
        const candidatePath = normalizePvfPath(item.fileName || item.pvfPath);
        if (!candidatePath) continue;
        try {
          const candidate = await cachedNutAuditText(client, sessionId, candidatePath, encoding, textCache);
          if (containsExactInteger(candidate.text, id)) collisions.push({ pvfPath: candidate.pvfPath, textSha256: sha256(candidate.text) });
        } catch (error) {
          errors.push(`APID ${id} 的候选冲突文件无法读回：${candidatePath}`);
        }
      }
      if (incomplete) errors.push(`APID ${id} 的目标 PVF 冲突搜索不完整`);
      if (collisions.length > 0) errors.push(`APID ${id} 已在目标 PVF 源脚本中出现`);
      apidChecks.push({
        id,
        namespace: proof.apidPlan.namespace,
        searchPath: "sqr",
        matchedCount,
        returnedCount: returned.length,
        errorCount: Number(search.errorCount || 0),
        complete: !incomplete,
        collisions,
        finalTargetContainsId: (Array.isArray(proof?.apiSymbols) ? proof.apiSymbols : [])
          .filter((symbol) => symbol?.kind === "function")
          .some((symbol) => containsExactIntegerInFunctionCall(finalText, symbol.name, id)),
      });
    } catch (error) {
      errors.push(`APID ${id} 冲突搜索失败：${error.message}`);
      apidChecks.push({ id, namespace: proof?.apidPlan?.namespace || null, complete: false, collisions: [], error: error.message });
    }
  }
  return {
    ok: errors.length === 0,
    mode: EXISTING_NUT_CONTROLLED_MODE,
    errors: [...new Set(errors)],
    warnings,
    pvfPath: normalizedTarget,
    proofSha256,
    transition,
    loadChainChecks,
    skillProcCheck,
    apiCatalog: catalog ? { path: "knowledge-pack/indexes/nut-api-facts.compact.json", sha256: catalog.sha256, targetRuntimeVerified: false } : null,
    apiSymbolChecks,
    apidNamespace: proof?.apidPlan?.namespace || null,
    apidChecks,
    staticChecksProveRuntimeBehavior: false,
    runtimeValidationRequired: proof?.runtimeValidationRequired === true,
    temporaryRoundTripRequired: proof?.temporaryRoundTripRequired === true,
  };
}

function enforceAtomicNutApidUniqueness(plans) {
  const claims = new Map();
  for (const plan of plans) {
    for (const check of plan.existingNutAudit?.apidChecks || []) {
      if (!claims.has(check.id)) claims.set(check.id, []);
      claims.get(check.id).push(plan);
    }
  }
  for (const [id, owners] of claims) {
    if (owners.length < 2) continue;
    for (const plan of owners) {
      plan.existingNutAudit.errors.push(`APID ${id} 在同一原子 change-set 的多个 NUT 中重复声明`);
      plan.existingNutAudit.errors = [...new Set(plan.existingNutAudit.errors)];
      plan.existingNutAudit.ok = false;
    }
  }
}

function blockPlanFromExistingNutAudit(plan) {
  if (plan.existingNutAudit?.ok === true) return;
  plan.blocked = true;
  for (const item of plan.items) {
    item.applicable = false;
    item.changed = false;
    item.blockCode = "EXISTING_NUT_AUDIT_FAILED";
    item.blockReason = (plan.existingNutAudit?.errors || ["既有 NUT 专用审计未通过。"]).join("；");
    item.blockDetails = plan.existingNutAudit || null;
  }
}

function plannedTextForAudit(pvfPath, pendingWrites, plannedTexts) {
  const key = normalizePvfPath(pvfPath).toLowerCase();
  return plannedTexts.get(key) || pendingWrites.get(key)?.source?.textContent || null;
}

async function runMapRelativeResourceAudits({
  client,
  sessionId,
  entries,
  pendingWrites,
  plannedTexts,
  directoryCache,
  encoding,
}) {
  const audits = [];
  const effectivePathExists = async (candidatePath) => {
    const normalized = normalizePvfPath(candidatePath);
    const pending = pendingWrites.get(normalized.toLowerCase());
    if (pending && pending.targetExists !== true && pending.result?.applicable !== false) return true;
    return pvfPathExists(client, sessionId, normalized, directoryCache);
  };
  const readTil = async (candidatePath) => {
    const normalized = normalizePvfPath(candidatePath);
    const planned = plannedTextForAudit(normalized, pendingWrites, plannedTexts);
    if (typeof planned === "string") {
      return {
        text: planned,
        contentSha256: sha256(planned),
        rawContentSha256: null,
        sha256Kind: "planned-semantic-text",
        plannedInChangeSet: true,
      };
    }
    const read = await readTargetTextForAudit(client, sessionId, normalized, encoding);
    let rawContentSha256 = null;
    try {
      const raw = await callAndParse(client, "pvf_read_file", {
        sessionId,
        pvfPath: normalized,
        pvfEncoding: encoding,
        semanticVerificationRead: true,
        rawSha256Only: true,
      });
      rawContentSha256 = raw.rawContentSha256 || null;
    } catch {
      // The semantic text hash remains a stable comparison when raw-byte metadata is unavailable.
    }
    return {
      text: read.text,
      contentSha256: sha256(read.text),
      rawContentSha256,
      sha256Kind: "semantic-text",
      plannedInChangeSet: false,
    };
  };

  for (const entry of entries) {
    let audit;
    try {
      audit = await auditMapRelativeResourceRebind({
        sourceMapPath: entry.sourceMapPath,
        targetMapPath: entry.targetMapPath,
        sourceMapText: entry.sourceMapText,
        targetMapText: entry.targetMapText,
        pathExists: effectivePathExists,
        readTil,
      });
    } catch (error) {
      audit = {
        mode: "map-relative-resource-rebind",
        sourceMapPath: normalizePvfPath(entry.sourceMapPath),
        targetMapPath: normalizePvfPath(entry.targetMapPath),
        checkedChain: [".map", ".til", ".img"],
        referenceCount: null,
        references: [],
        errors: [error.message],
        warnings: [],
        highRisk: true,
        ok: false,
        clientAssetsWritten: false,
        inGameValidationRequired: true,
      };
    }
    audits.push({ ...entry, audit });
  }
  return audits;
}

function attachMapRelativeResourceAudits(audits, results, replacementPlans = []) {
  for (const entry of audits) {
    const resultIds = new Set(entry.changeIds || []);
    for (const result of results) {
      if (!resultIds.has(result.id)) continue;
      result.mapRelativeResourceAudit = entry.audit;
      if (entry.audit.ok === true) continue;
      result.applicable = false;
      result.changed = false;
      result.blockCode = "MAP_RELATIVE_RESOURCE_REBIND_HIGH_RISK";
      result.blockReason = (entry.audit.errors || ["地图相对资源重解析未通过。 "]).join("；");
      result.blockDetails = entry.audit;
    }
    const targetKey = normalizePvfPath(entry.targetMapPath).toLowerCase();
    const plan = replacementPlans.find((candidate) => normalizePvfPath(candidate.pvfPath).toLowerCase() === targetKey);
    if (plan && entry.audit.ok !== true) plan.blocked = true;
  }
}

function mapRelativeResourceAuditEntries(pendingNewFiles, replacementPlans) {
  const entries = [];
  for (const pending of pendingNewFiles || []) {
    const targetMapPath = normalizePvfPath(pending.change?.pvfPath);
    if (extensionOf(targetMapPath) !== ".map") continue;
    const copied = pending.change?.type === COPY_FILE_CHANGE_TYPE;
    entries.push({
      changeIds: [pending.change.id],
      sourceMapPath: copied ? normalizePvfPath(pending.source?.sourcePvfPath) : targetMapPath,
      targetMapPath,
      sourceMapText: copied ? String(pending.source?.textContent || "") : "",
      targetMapText: String(pending.source?.textContent || ""),
    });
  }
  for (const plan of replacementPlans || []) {
    if (extensionOf(plan.pvfPath) !== ".map") continue;
    entries.push({
      changeIds: plan.items.map((item) => item.change.id),
      sourceMapPath: normalizePvfPath(plan.pvfPath),
      targetMapPath: normalizePvfPath(plan.pvfPath),
      sourceMapText: String(plan.sourceText || ""),
      targetMapText: String(plan.expectedText || ""),
    });
  }
  return entries;
}

async function auditHighRiskNewFile({
  client,
  sessionId,
  change,
  source,
  targetExists,
  pendingWrites,
  plannedTexts,
  changeSet,
  adapterConfig,
  directoryCache,
}) {
  const pvfPath = normalizePvfPath(change.pvfPath);
  const extension = extensionOf(pvfPath);
  const mode = HIGH_RISK_NEW_FILE_MODES[extension];
  if (!mode) return { ok: true, mode: null, errors: [], warnings: [] };
  const errors = [];
  const warnings = [];
  const proofShape = validateWriteProofShape(pvfPath, change.writeProof);
  if (!proofShape.ok) errors.push(...proofShape.errors);
  const sourceValidation = validateNewFileText(pvfPath, source.textContent, change.writeProof || {});
  if (!sourceValidation.ok) errors.push(...sourceValidation.errors);
  if (targetExists) errors.push(`目标 PVF 路径已存在：${pvfPath}`);
  const encoding = change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
  const effectiveText = (candidatePath) => plannedTextForAudit(candidatePath, pendingWrites, plannedTexts);

  if (mode === "registry-lifecycle") {
    const proofRegistryPath = normalizePvfPath(change.writeProof?.registry?.lstPath || pvfPath);
    const targetRegistry = await readTargetTextForAudit(client, sessionId, proofRegistryPath, encoding, false);
    const registryText = effectiveText(proofRegistryPath) || targetRegistry.text;
    const parsed = parseRegistryRows(registryText);
    if (parsed.malformed.length || parsed.duplicateIds.length || parsed.duplicatePaths.length) {
      errors.push("新登记表含格式错误或重复 ID/path");
    }
    const rows = parsed.rows;
    for (const row of rows) {
      const targetPath = resolveRegistryEntryPath(proofRegistryPath, row.pvfPath);
      const targetIsPending = pendingWrites.has(targetPath.toLowerCase());
      if (!targetIsPending && !(await pvfPathExists(client, sessionId, targetPath, directoryCache))) {
        errors.push(`登记表行 ${row.id} -> ${row.pvfPath} 没有对应 PVF 文件`);
      }
    }
    if (proofRegistryPath.toLowerCase() !== pvfPath.toLowerCase()) {
      const rowProof = validateRegistryRowProof(change.writeProof, targetRegistry.text || "", pvfPath);
      if (!rowProof.ok) errors.push(...rowProof.errors);
    }
  }

  if (mode === "script-new-file" || mode === "localization-new-file") {
    const references = Array.isArray(change.writeProof?.referencePaths) ? change.writeProof.referencePaths : [];
    if (references.length === 0) errors.push(`${extension} 新文件必须提供至少一个目标 PVF 同类 referencePaths 样本`);
    const signatures = [];
    for (const reference of references.slice(0, 3)) {
      const refPath = normalizePvfPath(reference);
      if (extensionOf(refPath) !== extension) errors.push(`referencePaths 扩展名不匹配：${reference}`);
      try {
        const refText = effectiveText(refPath) || (await readTargetTextForAudit(client, sessionId, refPath, encoding)).text;
        signatures.push({ pvfPath: refPath, textSha256: sha256(refText), tagSignature: scriptTagSignature(refText) });
      } catch (error) {
        errors.push(`referencePaths 无法读取 ${reference}：${error.message}`);
      }
    }
    if (mode === "script-new-file" && extension === ".co" && signatures.length && scriptTagSignature(source.textContent).length === 0) {
      errors.push("脚本新文件没有可审阅的 Section/tag 结构");
    }
    if (mode === "localization-new-file" && /\uFFFD/u.test(source.textContent)) errors.push(".str 新文件含 replacement character");
  }

  if (mode === "worldmap-lifecycle") {
    const worldmap = parseWorldmapText(source.textContent);
    const registryPath = normalizePvfPath(change.writeProof?.registry?.lstPath || "worldmap/worldmap.lst");
    const targetRegistry = await readTargetTextForAudit(client, sessionId, registryPath, encoding, false);
    const registryText = effectiveText(registryPath) || targetRegistry.text || "";
    const rowProof = validateRegistryRowProof(change.writeProof, targetRegistry.text || "", pvfPath);
    if (!rowProof.ok) errors.push(...rowProof.errors);
    const registryFinal = parseRegistryRows(registryText);
    if (!registryFinal.headerPresent || registryFinal.malformed.length || registryFinal.duplicateIds.length || registryFinal.duplicatePaths.length) {
      errors.push("worldmap/worldmap.lst 最终文本含格式错误或重复 ID/path");
    }
    const registryRow = registryFinal.byId.get(rowProof.id);
    if (!registryRow || resolveRegistryEntryPath(registryPath, registryRow.pvfPath).toLowerCase() !== pvfPath.toLowerCase()) {
      errors.push(`worldmap registry 最终文本没有闭合 ${rowProof.id} -> ${pvfPath}`);
    }
    const loadEffectiveRegistry = async (candidatePath) => {
      const target = await readTargetTextForAudit(client, sessionId, candidatePath, encoding, false);
      const text = effectiveText(candidatePath) || target.text || "";
      const parsed = parseRegistryRows(text);
      if (!parsed.headerPresent || parsed.malformed.length || parsed.duplicateIds.length || parsed.duplicatePaths.length) {
        errors.push(`${candidatePath} 最终文本含格式错误或重复 ID/path`);
      }
      return { pvfPath: candidatePath, text, parsed };
    };
    const dungeonRegistry = await loadEffectiveRegistry("dungeon/dungeon.lst");
    const dungeonResolution = { resolved: [], errors: [] };
    for (const id of [...new Set(worldmap.dungeonIds)]) {
      const row = dungeonRegistry.parsed.byId.get(id);
      if (!row) {
        dungeonResolution.errors.push(`dungeon ID ${id} 未在 dungeon/dungeon.lst 最终文本注册`);
        continue;
      }
      const targetPath = resolveRegistryEntryPath("dungeon/dungeon.lst", row.pvfPath);
      const targetIsPending = pendingWrites.has(targetPath.toLowerCase());
      if (!targetIsPending && !(await pvfPathExists(client, sessionId, targetPath, directoryCache))) {
        dungeonResolution.errors.push(`dungeon ID ${id} 的目标文件不存在：${targetPath}`);
        continue;
      }
      dungeonResolution.resolved.push({ id, pvfPath: targetPath });
    }
    errors.push(...dungeonResolution.errors);
    const uiPath = normalizePvfPath(worldmap.uiPath || "");
    const paired = Array.isArray(change.writeProof?.pairedEntries) ? change.writeProof.pairedEntries : [];
    const uiPair = paired.find((entry) => entry.kind === "ui" && normalizePvfPath(entry.pvfPath).toLowerCase() === uiPath.toLowerCase());
    if (!uiPair) errors.push(`worldmap proof 没有对应的 ui pairedEntry：${uiPath}`);
    const uiText = effectiveText(uiPath) || (uiPath ? (await readTargetTextForAudit(client, sessionId, uiPath, encoding, false)).text : null);
    if (!uiText) errors.push(`worldmap [ui path] 不存在或未在同一 change-set 新增：${uiPath}`);
    else {
      const buttons = parseWorldmapUiButtons(uiText);
      const buttonIds = new Set(buttons.map((button) => button.dungeonId).filter(Number.isInteger));
      for (const id of worldmap.dungeonIds) if (!buttonIds.has(id)) errors.push(`UI 没有对应 dungeon 按钮：${id}`);
      for (const button of buttons) {
        if (!Number.isInteger(button.dungeonId)) warnings.push(`UI 控件 ${button.controlId} 没有可解析 dungeon ID`);
      }
    }
    const townPairs = paired.filter((entry) => entry.kind === "town-gate");
    const regionPairs = paired.filter((entry) => entry.kind === "region-town");
    if (townPairs.length === 0) errors.push("worldmap proof 至少需要一个 town-gate pairedEntry");
    if (regionPairs.length === 0) errors.push("worldmap proof 至少需要一个 region-town pairedEntry");
    const townRegistry = await loadEffectiveRegistry("town/town.lst");
    const regionRegistry = await loadEffectiveRegistry("region/region.lst");
    const pairedTownIds = new Set();
    for (const entry of townPairs) {
      const entryPath = normalizePvfPath(entry.pvfPath);
      const text = effectiveText(entryPath) || (await readTargetTextForAudit(client, sessionId, entryPath, encoding, false)).text;
      if (!text) { errors.push(`入口配套文件不存在：${entryPath}`); continue; }
      const gates = parseTownWorldmapGates(text);
      const expectedWorldmapId = Number(entry.worldmapId ?? rowProof.id);
      if (expectedWorldmapId !== rowProof.id) errors.push(`town-gate pairedEntry 的 worldmapId ${expectedWorldmapId} 与新增 worldmap ID ${rowProof.id} 不一致：${entryPath}`);
      if (!gates.includes(expectedWorldmapId)) errors.push(`town 文件没有 dungeon gate -> worldmap ${expectedWorldmapId}：${entryPath}`);
      const townRow = townRegistry.parsed.rows.find((row) =>
        resolveRegistryEntryPath("town/town.lst", row.pvfPath).toLowerCase() === entryPath.toLowerCase());
      if (!townRow) errors.push(`town 文件未在 town/town.lst 最终文本注册：${entryPath}`);
      else pairedTownIds.add(townRow.id);
    }
    for (const entry of regionPairs) {
      const entryPath = normalizePvfPath(entry.pvfPath);
      const text = effectiveText(entryPath) || (await readTargetTextForAudit(client, sessionId, entryPath, encoding, false)).text;
      if (!text) { errors.push(`区域配套文件不存在：${entryPath}`); continue; }
      const townId = Number(entry.townId);
      if (!Number.isSafeInteger(townId) || townId < 0) errors.push(`region-town pairedEntry 缺少有效 townId：${entryPath}`);
      else {
        const towns = parseRegionTownIds(text);
        if (!towns.includes(townId)) errors.push(`region 文件没有 towns -> ${townId}：${entryPath}`);
      }
      const regionRow = regionRegistry.parsed.rows.find((row) =>
        resolveRegistryEntryPath("region/region.lst", row.pvfPath).toLowerCase() === entryPath.toLowerCase());
      if (!regionRow) errors.push(`region 文件未在 region/region.lst 最终文本注册：${entryPath}`);
    }
    if (townPairs.length && regionPairs.length && !regionPairs.some((entry) => pairedTownIds.has(Number(entry.townId)))) {
      errors.push("town-gate 与 region-town 没有通过同一个已登记 town ID 闭合");
    }
    return {
      ok: errors.length === 0,
      mode,
      errors,
      warnings,
      sourceValidation,
      worldmap,
      dungeonResolution,
      uiPath,
      registryPath,
    };
  }
  return { ok: errors.length === 0, mode, errors, warnings, sourceValidation };
}

async function runNewFileRoundTripProbe({
  sourcePvf,
  changeSet,
  adapterConfig,
  writePolicy,
  newFiles,
}) {
  const outcomes = new Map();
  if (!newFiles.length) return outcomes;
  const probeBase = path.join(os.tmpdir(), "pvf-workbench-new-file-probes");
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
    if (!sourceSessionId) throw new Error("new-file probe pvf_open did not return a sessionId.");
    if (opened.session?.readOnly === true) throw Object.assign(new Error("新增高风险文件的临时写出/读回需要 native 写入环境。"), { code: "READ_ONLY_FALLBACK" });
    const probeResults = [];
    for (const item of newFiles) {
      const change = item.change;
      const ext = extensionOf(change.pvfPath);
      const write = await callAndParse(client, "pvf_write_file", {
        sessionId: sourceSessionId,
        pvfPath: normalizePvfPath(change.pvfPath),
        textContent: item.source.textContent,
        pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
        compileScript: shouldCompileNewFile(change.pvfPath, change),
        compileBinaryAni: false,
        convertToTraditionalChinese: false,
        writeProof: change.writeProof,
        samePvfCopyProof: change.type === COPY_FILE_CHANGE_TYPE ? item.source.samePvfCopyProof : undefined,
      });
      probeResults.push({ id: change.id, write });
    }
    await callAndParse(client, "pvf_save", { sessionId: sourceSessionId, targetPath: outputPvf, allowOverwriteSource: false });
    await callAndParse(client, "pvf_close", { sessionId: sourceSessionId });
    sourceSessionId = null;
    const reopened = await callAndParse(client, "pvf_open", {
      path: outputPvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    outputSessionId = reopened.session?.sessionId;
    if (!outputSessionId) throw new Error("new-file probe readback pvf_open did not return a sessionId.");
    for (const item of newFiles) {
      const change = item.change;
      const encoding = change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const readback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: normalizePvfPath(change.pvfPath),
        pvfEncoding: encoding,
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
        maxChars: 0,
      });
      const comparison = typeof readback.textContent === "string"
        ? pvfTextReadbackResult(item.source.textContent, readback.textContent)
        : { ok: false, exactTextOk: false, comparison: "no-text-readback" };
      const independentSemanticRead = readback.semanticReadGuard?.applied === true &&
        readback.semanticReadGuard?.reason === "verified-text-readback" &&
        readback.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
        readback.semanticReadGuard?.selectedEncoding === encoding;
      const ok = comparison.ok === true && independentSemanticRead && sourceSha256Before === sha256File(sourcePvf);
      outcomes.set(change.id, {
        ok,
        code: ok ? null : (change.type === COPY_FILE_CHANGE_TYPE ? "COPY_FILE_ROUNDTRIP_FAILED" : "HIGH_RISK_NEW_FILE_ROUNDTRIP_FAILED"),
        reason: ok
          ? (change.type === COPY_FILE_CHANGE_TYPE
            ? "同一 PVF 文件复制已通过临时写出和独立读回。"
            : "新增文件已通过格式/脚本结构、临时写出或编码往返和独立读回。")
          : (change.type === COPY_FILE_CHANGE_TYPE
            ? "同一 PVF 文件复制的临时输出读回与源文本不一致。"
            : "新增文件临时输出读回与源文本不一致。"),
        comparison,
        independentSemanticRead,
        semanticReadGuard: readback.semanticReadGuard || null,
        outputPvfSha256: fs.existsSync(outputPvf) ? sha256File(outputPvf) : null,
        sourcePvfSha256: sourceSha256Before,
        sourceUnchanged: sourceSha256Before === sha256File(sourcePvf),
        temporaryOutputRetained: false,
        probeWrite: probeResults.find((entry) => entry.id === change.id)?.write || null,
      });
    }
  } catch (error) {
    for (const item of newFiles) outcomes.set(item.change.id, {
      ok: false,
      code: error.code || (item.change.type === COPY_FILE_CHANGE_TYPE ? "COPY_FILE_ROUNDTRIP_FAILED" : "HIGH_RISK_NEW_FILE_ROUNDTRIP_FAILED"),
      reason: error.message,
      sourcePvfSha256: sourceSha256Before,
      temporaryOutputRetained: false,
    });
  } finally {
    if (outputSessionId) try { await callAndParse(client, "pvf_close", { sessionId: outputSessionId }); } catch { /* preserve result */ }
    if (sourceSessionId) try { await callAndParse(client, "pvf_close", { sessionId: sourceSessionId }); } catch { /* preserve result */ }
    client.stop();
    if (!pathInside(probeBase, probeRoot)) throw new Error(`Unsafe new-file probe path: ${probeRoot}`);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  return outcomes;
}

async function runExistingNutRoundTripProbe({
  sourcePvf,
  changeSet,
  adapterConfig,
  writePolicy,
  filePlans,
}) {
  const outcomes = new Map();
  if (!filePlans.length) return outcomes;
  const probeBase = path.join(os.tmpdir(), "pvf-workbench-existing-nut-probes");
  const probeRoot = path.join(probeBase, `${timestamp()}-${crypto.randomUUID()}`);
  const outputPvf = path.join(probeRoot, "Script.pvf");
  fs.mkdirSync(probeRoot, { recursive: true });
  const sourceSha256Before = sha256File(sourcePvf);
  const client = new BackendStdioClient(controlledWriteLaunchOptions(adapterConfig, writePolicy));
  let sourceSessionId = null;
  let outputSessionId = null;
  const expectedRawByPath = new Map();
  try {
    const opened = await callAndParse(client, "pvf_open", {
      path: sourcePvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    sourceSessionId = opened.session?.sessionId;
    if (!sourceSessionId) throw new Error("existing-NUT probe pvf_open did not return a sessionId.");
    if (opened.session?.readOnly === true) {
      throw Object.assign(new Error("既有 NUT 的临时独立 PVF 往返验证需要 native 写入环境。"), { code: "READ_ONLY_FALLBACK" });
    }
    const coordinated = await applyFilePlansCoherently({
      client,
      sessionId: sourceSessionId,
      filePlans,
      changeSet,
      adapterConfig,
    });
    sourceSessionId = coordinated.sessionId;
    for (const plan of coordinated.coordinatedPlans) {
      const planRawHashes = new Set();
      for (const item of plan.items.filter((candidate) => candidate.changed)) {
        const applied = coordinated.ordinaryResults.get(item.change.id);
        if (applied?.ok !== true || applied?.existingNutTransition?.ok !== true) {
          throw codedError("EXISTING_NUT_TEMPORARY_APPLY_FAILED", `既有 NUT ${item.change.id} 未通过临时最终文本写入审计。`);
        }
        if (!/^[a-f0-9]{64}$/iu.test(String(applied?.writeResult?.outputRawSha256 || ""))) {
          throw codedError("EXISTING_NUT_TEMPORARY_RAW_PROOF_MISSING", `既有 NUT ${item.change.id} 缺少临时原始字节输出哈希。`);
        }
        planRawHashes.add(String(applied.writeResult.outputRawSha256).toLowerCase());
      }
      if (planRawHashes.size !== 1) {
        throw codedError("EXISTING_NUT_TEMPORARY_RAW_PROOF_MISMATCH", `既有 NUT ${plan.pvfPath} 的临时原始字节计划不一致。`);
      }
      expectedRawByPath.set(normalizePvfPath(plan.pvfPath).toLowerCase(), [...planRawHashes][0]);
    }
    await callAndParse(client, "pvf_save", { sessionId: sourceSessionId, targetPath: outputPvf, allowOverwriteSource: false });
    await callAndParse(client, "pvf_close", { sessionId: sourceSessionId });
    sourceSessionId = null;
    const reopened = await callAndParse(client, "pvf_open", {
      path: outputPvf,
      encoding: changeSet.target.pvfOpenEncoding || adapterConfig.defaults.pvfOpenEncoding,
    });
    outputSessionId = reopened.session?.sessionId;
    if (!outputSessionId) throw new Error("existing-NUT probe readback pvf_open did not return a sessionId.");
    for (const plan of filePlans) {
      const firstChange = plan.items[0]?.change || {};
      const encoding = firstChange.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const readback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: plan.pvfPath,
        pvfEncoding: encoding,
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
        maxChars: 0,
      });
      const comparison = pvfTextReadbackResult(plan.expectedText, readback.textContent);
      const rawReadback = await callAndParse(client, "pvf_read_file", {
        sessionId: outputSessionId,
        pvfPath: plan.pvfPath,
        pvfEncoding: encoding,
        semanticVerificationRead: true,
        rawSha256Only: true,
      });
      const expectedOutputRawSha256 = expectedRawByPath.get(normalizePvfPath(plan.pvfPath).toLowerCase()) || null;
      const actualOutputRawSha256 = String(rawReadback.rawContentSha256 || "").toLowerCase() || null;
      const rawByteReadbackOk = Boolean(expectedOutputRawSha256) && actualOutputRawSha256 === expectedOutputRawSha256;
      const independentSemanticRead = readback.semanticReadGuard?.applied === true &&
        readback.semanticReadGuard?.reason === "verified-text-readback" &&
        readback.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
        readback.semanticReadGuard?.selectedEncoding === encoding;
      const sourceUnchanged = sourceSha256Before === sha256File(sourcePvf);
      const independentRawRead = rawReadback.semanticReadGuard?.applied === true &&
        rawReadback.semanticReadGuard?.reason === "verified-text-readback" &&
        rawReadback.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
        rawReadback.semanticReadGuard?.selectedEncoding === encoding;
      const ok = comparison.ok === true && independentSemanticRead && independentRawRead && rawByteReadbackOk && sourceUnchanged;
      const shared = {
        ok,
        code: ok ? null : "EXISTING_NUT_ROUNDTRIP_FAILED",
        reason: ok
          ? "既有 NUT 已通过临时独立 PVF 写出、重新打开和 TypeScript 独立读回；这不替代实机行为验证。"
          : "既有 NUT 临时独立 PVF 的最终文本或独立读回不一致。",
        pvfPath: plan.pvfPath,
        comparison,
        independentSemanticRead,
        independentRawRead,
        rawByteReadbackOk,
        expectedOutputRawSha256,
        actualOutputRawSha256,
        rawContentBytes: rawReadback.rawContentBytes ?? null,
        rawSemanticReadGuard: rawReadback.semanticReadGuard || null,
        semanticReadGuard: readback.semanticReadGuard || null,
        sourceUnchanged,
        sourcePvfSha256: sourceSha256Before,
        temporaryOutputPvfSha256: fs.existsSync(outputPvf) ? sha256File(outputPvf) : null,
        temporaryOutputRetained: false,
        runtimeValidationRequired: true,
        staticChecksProveRuntimeBehavior: false,
      };
      for (const item of plan.items) outcomes.set(item.change.id, shared);
    }
  } catch (error) {
    for (const plan of filePlans) for (const item of plan.items) outcomes.set(item.change.id, {
      ok: false,
      code: error.code || "EXISTING_NUT_ROUNDTRIP_FAILED",
      reason: error.message,
      pvfPath: plan.pvfPath,
      sourcePvfSha256: sourceSha256Before,
      sourceUnchanged: fs.existsSync(sourcePvf) && sha256File(sourcePvf) === sourceSha256Before,
      temporaryOutputRetained: false,
      runtimeValidationRequired: true,
      staticChecksProveRuntimeBehavior: false,
    });
  } finally {
    if (outputSessionId) try { await callAndParse(client, "pvf_close", { sessionId: outputSessionId }); } catch { /* preserve result */ }
    if (sourceSessionId) try { await callAndParse(client, "pvf_close", { sessionId: sourceSessionId }); } catch { /* preserve result */ }
    client.stop();
    if (!pathInside(probeBase, probeRoot)) throw new Error(`Unsafe existing-NUT probe path: ${probeRoot}`);
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
  const pendingWrites = new Map();
  const pendingNewFiles = [];
  const plannedTexts = new Map();
  const existingNutPlans = [];
  const nutAuditTextCache = new Map();
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
      const copyFileChanges = group.changes.filter((change) => change.type === COPY_FILE_CHANGE_TYPE);
      let replaceChanges = group.changes.filter((change) => change.type === "replace-text");
      const structuredChange = structuredUpgradeChange(group);
      if (copyFileChanges.length && (writeFileChanges.length || replaceChanges.length)) {
        throw new Error(`同一目标路径不能混用 copy-file、write-file 或 replace-text：${pvfPath}`);
      }
      if (copyFileChanges.length > 1) {
        throw new Error(`同一目标路径只能有一条 copy-file：${pvfPath}`);
      }
      if (copyFileChanges.length === 1) {
        const change = copyFileChanges[0];
        const source = await readVerifiedPvfCopySource(client, sessionId, changeSet, change, adapterConfig);
        const targetExists = await pvfPathExists(client, sessionId, pvfPath, directoryCache);
        const writeSafety = semanticWriteSafety({
          kind: COPY_FILE_CHANGE_TYPE,
          pvfPath,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
          fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
          textContent: source.textContent,
          samePvfCopyProof: source.samePvfCopyProof,
        });
        const result = {
          id: change.id,
          type: change.type,
          pvfPath,
          sourcePvfPath: source.sourcePvfPath,
          sourceTextSha256: source.sourceTextSha256,
          sourceLength: source.raw.length,
          sourceSemanticReadGuard: source.semanticReadGuard,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          expectAbsent: true,
          targetExists,
          applicable: !targetExists && writeSafety.allowed,
          changed: !targetExists && writeSafety.allowed,
          semanticWriteSafety: writeSafety,
          rationale: change.rationale || "",
        };
        results.push(result);
        pendingWrites.set(pvfPath.toLowerCase(), { change, source, targetExists, result });
        pendingNewFiles.push({ change, source, targetExists, result });
        continue;
      }
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
          writeProof: change.writeProof,
        });
        const result = {
          id: change.id,
          type: change.type,
          pvfPath,
          sourceFile: source.sourceFile,
          sourceSha256: source.actualSha256,
          sourceLength: source.raw.length,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          expectAbsent: true,
          targetExists,
          applicable: !targetExists && writeSafety.allowed,
          changed: !targetExists && writeSafety.allowed,
          semanticWriteSafety: writeSafety,
          writeProof: change.writeProof || null,
          rationale: change.rationale || "",
        };
        results.push(result);
        pendingWrites.set(pvfPath.toLowerCase(), { change, source, targetExists, result });
        pendingNewFiles.push({ change, source, targetExists, result });
        continue;
      }
      const replacementDeclarations = structuredChange ? [structuredChange] : replaceChanges;
      const encodings = new Set(replacementDeclarations.map((change) =>
        change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding));
      if (encodings.size !== 1) {
        for (const change of replacementDeclarations) results.push({
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
        ...rawTextOptions(changeSet, replacementDeclarations[0], adapterConfig),
        semanticVerificationRead: true,
        maxChars: 0,
      });
      if (typeof read.textContent !== "string") {
        throw new Error(`PVF file is not readable as text for dry-run replacement: ${pvfPath}`);
      }
      const structuredExpansion = structuredChange
        ? expandReplacementChangesForSource(group, read.textContent).structured
        : null;
      if (structuredExpansion) replaceChanges = structuredExpansion.generatedChanges;
      const plan = planReplacementGroup(read.textContent, replaceChanges, {
        pvfPath,
        pvfReadEncoding: changeSet.target.pvfReadEncoding,
        fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
      });
      plan.pvfPath = pvfPath;
      plan.structuredUpgradeEdit = structuredExpansion;
      if (replaceChanges.some((change) => change.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE)) {
        plan.existingNutAudit = await auditExistingNutControlledEdit({
          client,
          sessionId,
          pvfPath,
          sourceText: read.textContent,
          finalText: plan.expectedText,
          changes: replaceChanges,
          changeSet,
          adapterConfig,
          textCache: nutAuditTextCache,
        });
        existingNutPlans.push(plan);
        if (!plan.existingNutAudit.ok) blockPlanFromExistingNutAudit(plan);
      }
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
                scope: item.change.scope,
                writeProof: item.change.writeProof,
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
      annotateSameFileBatchBlock(plan);
      plannedTexts.set(pvfPath.toLowerCase(), plan.expectedText);
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
          scopedOccurrenceCount: item.scopedOccurrenceCount,
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
          writeProof: change.writeProof || null,
          existingNutAudit: plan.existingNutAudit || null,
          structuredEditParentId: change.structuredEditParentId || null,
          structuredEditComponent: change.structuredEditComponent || null,
          structuredEditProof: change.structuredEditProof || null,
          rationale: change.rationale || "",
        });
      }
    }
    enforceAtomicNutApidUniqueness(existingNutPlans);
    for (const plan of existingNutPlans) {
      if (plan.existingNutAudit?.ok === true) continue;
      blockPlanFromExistingNutAudit(plan);
      for (const item of plan.items) {
        const result = results.find((entry) => entry.id === item.change.id);
        if (!result) continue;
        result.applicable = false;
        result.changed = false;
        result.blockCode = item.blockCode;
        result.blockReason = item.blockReason;
        result.blockDetails = item.blockDetails;
        result.existingNutAudit = plan.existingNutAudit;
      }
    }
    for (const change of changeSet.changes.filter((item) =>
      item.type === "replace-text" && item.writeProof?.mode === "registry-lifecycle")) {
      const result = results.find((item) => item.id === change.id);
      if (!result) continue;
      const expectedPvfPath = normalizePvfPath(change.writeProof?.registry?.expectedPvfPath);
      const pendingTarget = pendingWrites.get(expectedPvfPath.toLowerCase());
      const targetExists = Boolean(expectedPvfPath) && (Boolean(pendingTarget) || await pvfPathExists(client, sessionId, expectedPvfPath, directoryCache));
      result.registryTargetClosure = {
        ok: targetExists,
        expectedPvfPath,
        targetPendingInChangeSet: Boolean(pendingTarget),
        targetExistsInSource: targetExists && !pendingTarget,
      };
      if (!targetExists) {
        result.applicable = false;
        result.changed = false;
        result.blockCode = "REGISTRY_TARGET_FILE_MISSING";
        result.blockReason = `登记表新增行的目标文件不存在且未在同一 change-set 新增：${expectedPvfPath}`;
      }
    }
    for (const pending of pendingNewFiles) {
      const audit = await auditHighRiskNewFile({
        client,
        sessionId,
        change: pending.change,
        source: pending.source,
        targetExists: pending.targetExists,
        pendingWrites,
        plannedTexts,
        changeSet,
        adapterConfig,
        directoryCache,
      });
      pending.result.highRiskAudit = audit;
      if (!audit.ok) {
        pending.result.applicable = false;
        pending.result.changed = false;
        pending.result.blockCode = "HIGH_RISK_AUDIT_FAILED";
        pending.result.blockReason = audit.errors.join("；");
        pending.result.blockDetails = audit;
      }
    }
    const mapAudits = await runMapRelativeResourceAudits({
      client,
      sessionId,
      entries: mapRelativeResourceAuditEntries(pendingNewFiles, replacementPlans),
      pendingWrites,
      plannedTexts,
      directoryCache,
      encoding: changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
    });
    attachMapRelativeResourceAudits(mapAudits, results, replacementPlans);
  } finally {
    try {
      await callAndParse(client, "pvf_close", { sessionId });
    } finally {
      client.stop();
    }
  }

  const newFileProbeOutcomes = await runNewFileRoundTripProbe({
    sourcePvf,
    changeSet,
    adapterConfig,
    writePolicy,
    newFiles: pendingNewFiles.filter((item) => item.result.applicable && item.result.changed),
  });
  for (const pending of pendingNewFiles) {
    if (!pending.result.applicable || !pending.result.changed) continue;
    const outcome = newFileProbeOutcomes.get(pending.change.id) || {
      ok: false,
      code: pending.change.type === COPY_FILE_CHANGE_TYPE ? "COPY_FILE_ROUNDTRIP_REQUIRED" : "HIGH_RISK_NEW_FILE_ROUNDTRIP_REQUIRED",
      reason: pending.change.type === COPY_FILE_CHANGE_TYPE
        ? "同一 PVF 文件复制缺少临时写出和独立读回证明。"
        : "新增高风险文件缺少临时写出/编码往返证明。",
      temporaryOutputRetained: false,
    };
    pending.result.roundTripProbe = outcome;
    if (!outcome.ok) {
      pending.result.applicable = false;
      pending.result.changed = false;
      pending.result.blockCode = outcome.code;
      pending.result.blockReason = outcome.reason;
    }
  }

  const existingNutProbeOutcomes = await runExistingNutRoundTripProbe({
    sourcePvf,
    changeSet,
    adapterConfig,
    writePolicy,
    filePlans: existingNutPlans.filter((plan) => !plan.blocked && plan.existingNutAudit?.ok === true),
  });
  for (const plan of existingNutPlans) {
    for (const item of plan.items) {
      const result = results.find((entry) => entry.id === item.change.id);
      if (!result || !result.applicable || !result.changed) continue;
      const outcome = existingNutProbeOutcomes.get(item.change.id) || {
        ok: false,
        code: "EXISTING_NUT_ROUNDTRIP_REQUIRED",
        reason: "既有 NUT 缺少临时独立 PVF 写出和独立读回证明。",
        temporaryOutputRetained: false,
        runtimeValidationRequired: true,
      };
      result.existingNutRoundTripProbe = outcome;
      if (!outcome.ok) {
        result.applicable = false;
        result.changed = false;
        result.blockCode = outcome.code;
        result.blockReason = outcome.reason;
      }
    }
  }

  const structuredUpgradePlans = replacementPlans.filter((plan) =>
    !plan.blocked && plan.structuredUpgradeEdit);
  const structuredUpgradeChangedPlans = structuredUpgradePlans.filter((plan) =>
    plan.items.some((item) => item.changed));
  const structuredUpgradeProbeOutcomes = await runUpgradeTableRoundTripProbe({
    sourcePvf,
    changeSet,
    adapterConfig,
    writePolicy,
    filePlans: structuredUpgradeChangedPlans,
  });
  for (const plan of structuredUpgradePlans) {
    const planHasChanges = plan.items.some((item) => item.changed);
    for (const item of plan.items) {
      const result = results.find((entry) => entry.id === item.change.id);
      if (!result || !result.applicable) continue;
      const declaredProof = item.change.structuredEditProof || null;
      const outcome = planHasChanges
        ? structuredUpgradeProbeOutcomes.get(item.change.id) || {
          ok: false,
          code: "UPGRADE_TABLE_ROUNDTRIP_REQUIRED",
          reason: "强化/增幅结构化编辑缺少临时独立 PVF 写出、精确读回和重新解析证明。",
          componentState: item.changed ? "changed" : "no-op",
          declaredValuesVerified: false,
          writerRequired: item.changed === true,
          temporaryWriteExecuted: true,
          temporaryOutputRetained: false,
          inGameValidationRequired: true,
        }
        : {
          ok:
            declaredProof?.componentState === "no-op" &&
            declaredProof?.declaredValuesVerified === true &&
            declaredProof?.writerRequired === false,
          code: null,
          reason: "该组件声明值已由源文件重新解析确认，无需写入。",
          sourceUnchanged: true,
          sourcePvfSha256: sourcePvfSha256AtStart,
          componentState: "no-op",
          declaredValuesVerified: true,
          writerRequired: false,
          componentReadbackState: "no-op",
          componentReadbackProof: null,
          fixedPoint: true,
          structuralProofOk: true,
          verificationMode: "source-reparse-no-write",
          temporaryWriteExecuted: false,
          temporaryOutputRetained: false,
          clientWritten: false,
          inGameValidationRequired: true,
          staticChecksProveGameplayBehavior: false,
        };
      result.structuredRoundTripProbe = outcome;
      if (!outcome.ok) {
        result.applicable = false;
        result.changed = false;
        result.blockCode = outcome.code;
        result.blockReason = outcome.reason;
      }
    }
  }

  const binaryAniPlans = replacementPlans.filter((plan) =>
    !plan.blocked && extensionOf(plan.pvfPath) === ".ani" && plan.items.some((item) => item.changed));
  const binaryAniProbeOutcomes = await runBinaryAniRoundTripProbe({
    sourcePvf,
    changeSet,
    adapterConfig,
    writePolicy,
    filePlans: binaryAniPlans,
  });
  for (const plan of binaryAniPlans) {
    for (const item of plan.items) {
      const result = results.find((entry) => entry.id === item.change.id);
      if (!result || !result.applicable || !result.changed) continue;
      const outcome = binaryAniProbeOutcomes.get(item.change.id) || {
        ok: false,
        code: "RAW_ANI_ROUNDTRIP_REQUIRED",
        reason: "既有 ANI [DELAY] 缺少临时独立 PVF 和原始字节 SHA256 读回证明。",
        temporaryOutputRetained: false,
        runtimeValidationRequired: true,
      };
      result.binaryAniRoundTripProbe = outcome;
      if (!outcome.ok) {
        result.applicable = false;
        result.changed = false;
        result.blockCode = outcome.code;
        result.blockReason = outcome.reason;
      }
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
  attachCapabilityIds(results);
  const executionPlan = buildControlledExecutionPlan(results);

  const manifest = {
    schemaVersion: "1.0",
    phase: "phase-3-dry-run-change-set",
    generatedAt: new Date().toISOString(),
    mode: "dry-run-only",
    writeOperationsExecuted: false,
    persistentWriteOperationsExecuted: false,
    temporaryVerificationWriteOperationsExecuted: replacementPlans.some((plan) =>
      !plan.blocked && plan.items.some((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode))) ||
      pendingNewFiles.some((item) => item.result.roundTripProbe?.ok === true) ||
      results.some((item) => item.existingNutRoundTripProbe?.ok === true) ||
      results.some((item) => item.binaryAniRoundTripProbe?.ok === true) ||
      results.some((item) => item.structuredRoundTripProbe?.ok === true && item.structuredRoundTripProbe?.temporaryWriteExecuted === true),
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
      verifiedTextEligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
      verifiedTextEligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
      verifiedTextEligibilityDefaultBlocked: true,
      verifiedTextEligibilityProofBoundToDryRunAndApply: true,
      verifiedTextEligibilityPermissionExpansionAllowed: false,
      exactAdjacentContextAnchoringAllowed: true,
      contextAnchorDoesNotRelaxTextSafety: true,
      exactRangeScopeAllowed: true,
      scopeBoundaryRewriteAllowed: false,
      scopeEvidenceBoundToDryRunAndApply: true,
      cumulativeBaselineDeclared: Boolean(input.cumulative),
      cumulativeBaselineManifestVerified: input.cumulative ? true : null,
      unverifiedDirectNonAsciiTextWriteAllowed: false,
      cnStrWriteAllowed: false,
      highRiskNewFileProofRequired: true,
      highRiskNewFileRoundTripProbeRequired: true,
      highRiskFinalIndependentReadbackRequired: true,
      highRiskSameExtensionReferenceRequired: true,
      samePvfOrdinaryTextCopyAllowed: true,
      samePvfCopyRequiresSameExtension: true,
      samePvfCopyRequiresAbsentTarget: true,
      samePvfCopyHighRiskExtensionsAllowed: false,
      samePvfCopyRoundTripProbeRequired: true,
      samePvfCopyModificationRequiresCumulativeNextRound: true,
      samePvfCopyRoundTripExecuted: pendingNewFiles.some((item) => item.change.type === COPY_FILE_CHANGE_TYPE && item.result.roundTripProbe?.ok === true),
      existingHighRiskFileProtectionRemains: true,
      existingNutControlledEditRequiresDedicatedProof: true,
      existingNutAsciiOnly: true,
      existingNutSourceTextSha256Required: true,
      existingNutRawBytePreservingPatchRequired: true,
      existingNutWholeFileReencodingAllowed: false,
      existingNutNonTargetRawBytesMustRemainIdentical: true,
      existingNutLoadChainRequired: true,
      existingNutFunctionApiAndApidAuditRequired: true,
      existingNutEvidenceMustBeExecutableCode: true,
      existingNutApidMustBeExactIntegerLiteral: true,
      existingNutApidMustBeDeclaredApiCallArgument: true,
      existingNutTemporaryRoundTripRequired: true,
      existingNutFinalIndependentReadbackRequired: true,
      existingNutRuntimeValidationRequired: true,
      existingBinaryAniDelayOnly: true,
      existingBinaryAniRawBytePreservingPatchRequired: true,
      existingBinaryAniWholeFileReencodingAllowed: false,
      existingBinaryAniNonTargetRawBytesMustRemainIdentical: true,
      existingBinaryAniTemporaryRoundTripRequired: true,
      existingBinaryAniFinalRawByteSha256ReadbackRequired: true,
      existingBinaryAniRuntimeValidationRequired: true,
      structuredUpgradeTableEditAllowed: true,
      structuredUpgradeTableExactPathsOnly: true,
      structuredUpgradeTableWidth: 17,
      structuredUpgradeLevelIndexIsZeroBasedGroupIndex: true,
      structuredUpgradeIndependentGroupSelectorsAllowed: true,
      structuredUpgradeGameplayDisplayLevelMappingInferred: false,
      structuredUpgradeFirstColumnIsExplicitLevelNumber: false,
      structuredUpgradeColumnsMustFormExactPartition: true,
      structuredUpgradeExactSetCellsExpectedValueRequired: true,
      structuredUpgradeComponentNoOpProofRequired: true,
      structuredUpgradeAllNoOpApplyAuthorized: false,
      structuredUpgradeAllSixRarityLimitsRequired: true,
      structuredAmplificationConstGroupWidth: 4,
      structuredAmplificationConstHasLevelZeroGroup: true,
      structuredForgingFileExcluded: true,
      structuredUpgradeTemporaryRoundTripRequired: true,
      structuredUpgradeFinalIndependentReadbackRequired: true,
      structuredUpgradeRuntimeValidationRequired: true,
      mapRelativeResourceRebindAuditRequired: true,
      mapRelativeResourceRebindAuditChecksTilAndImg: true,
      mapRelativeResourceSilentContentRebindAllowed: false,
      existingCoSqrStrProtectionRemains: true,
      registryLifecycleOnlyForExplicitRowAdd: true,
      registryLifecycleExistingTextPreserved: true,
      registryLifecycleTargetClosureRequired: true,
      worldmapLifecycleRequiresRegistryUiDungeonTownRegionClosure: true,
      worldmapLifecycleRequiresBothTownAndRegion: true,
      stringLinkTextWriteAllowed: false,
      temporaryIsolatedEncodingProbeExecuted: replacementPlans.some((plan) =>
        !plan.blocked && plan.items.some((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode))),
      temporaryBinaryAniProbeExecuted: results.some((item) => item.binaryAniRoundTripProbe?.ok === true),
      highRiskNewFileAuditExecuted: pendingNewFiles.some((item) => item.change.type === "write-file" && Boolean(HIGH_RISK_NEW_FILE_MODES[extensionOf(item.change.pvfPath)])),
      highRiskNewFileRoundTripExecuted: pendingNewFiles.some((item) => item.change.type === "write-file" && Boolean(HIGH_RISK_NEW_FILE_MODES[extensionOf(item.change.pvfPath)]) && item.result.roundTripProbe?.ok === true),
      existingNutAuditExecuted: existingNutPlans.length > 0,
      existingNutRoundTripExecuted: results.some((item) => item.existingNutRoundTripProbe?.ok === true),
      existingBinaryAniRoundTripExecuted: results.some((item) => item.binaryAniRoundTripProbe?.ok === true),
      structuredUpgradeRoundTripExecuted: results.some((item) =>
        item.structuredRoundTripProbe?.ok === true && item.structuredRoundTripProbe?.temporaryWriteExecuted === true),
      registryLifecycleChecksExecuted: results.some((item) => item.writeProof?.mode === "registry-lifecycle"),
      sameFileVerifiedInlineTextAppliedAsOneBatch: true,
      stringTableAppendedOncePerVerifiedFileBatch: true,
      temporaryProbeOutputsRetained: false,
    },
    summary: {
      changeCount: results.length,
      applicableCount: results.filter((item) => item.applicable).length,
      changedCount: results.filter((item) => item.changed).length,
      noOpCount: results.filter((item) => item.applicable && !item.changed).length,
      noChange: results.every((item) => item.applicable && !item.changed),
      blockedCount: results.filter((item) => !item.applicable).length,
      clientTextSmokeCheckRequiredCount: results.filter((item) => item.semanticWriteSafety?.clientTextSmokeCheckRequired).length,
      highRiskNewFileCount: results.filter((item) => item.type === "write-file" && HIGH_RISK_NEW_FILE_MODES[extensionOf(item.pvfPath)]).length,
      highRiskNewFilePassedCount: results.filter((item) => item.type === "write-file" && HIGH_RISK_NEW_FILE_MODES[extensionOf(item.pvfPath)] && item.highRiskAudit?.ok === true && item.roundTripProbe?.ok === true).length,
      samePvfCopyCount: results.filter((item) => item.type === COPY_FILE_CHANGE_TYPE).length,
      samePvfCopyPassedCount: results.filter((item) => item.type === COPY_FILE_CHANGE_TYPE && item.roundTripProbe?.ok === true && item.applicable).length,
      existingNutControlledCount: results.filter((item) => item.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE).length,
      existingNutControlledPassedCount: results.filter((item) => item.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE && item.existingNutAudit?.ok === true && item.existingNutRoundTripProbe?.ok === true && item.applicable).length,
      existingBinaryAniDelayCount: results.filter((item) => extensionOf(item.pvfPath) === ".ani" && item.changed).length,
      existingBinaryAniDelayPassedCount: results.filter((item) => extensionOf(item.pvfPath) === ".ani" && item.binaryAniRoundTripProbe?.ok === true && item.applicable).length,
      structuredUpgradeTableComponentCount: results.filter((item) => item.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE).length,
      structuredUpgradeTableComponentPassedCount: results.filter((item) => item.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE && item.structuredRoundTripProbe?.ok === true && item.applicable).length,
      mapRelativeResourceAuditCount: results.filter((item) => Boolean(item.mapRelativeResourceAudit)).length,
      mapRelativeResourceHighRiskCount: results.filter((item) => item.mapRelativeResourceAudit?.highRisk === true).length,
      inGameRuntimeValidationRequiredCount: results.filter((item) =>
        (item.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE || extensionOf(item.pvfPath) === ".ani" || item.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE || item.mapRelativeResourceAudit?.inGameValidationRequired === true) && item.changed).length,
    },
    executionPlan,
    binding: dryRunManifestBinding(
      results,
      sourcePvf,
      sourcePvfSha256AtEnd,
      changeSetFile,
      changeSetFileSha256AtEnd,
      results.filter((item) => !item.applicable).length,
      results.filter((item) => item.changed).length,
      executionPlan,
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

function buildApplyPreflightExecutionResults({
  changeSet,
  adapterConfig,
  pendingWrites,
  replacementPlansByPath,
}) {
  const results = [];
  for (const group of groupChangesByPvfPath(changeSet.changes)) {
    const key = normalizePvfPath(group.pvfPath).toLowerCase();
    const pending = pendingWrites.get(key);
    if (pending) {
      const change = pending.change;
      const pvfEncoding = change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const result = {
        id: change.id,
        type: change.type,
        pvfPath: group.pvfPath,
        pvfEncoding,
        applicable: pending.targetExists !== true,
        changed: pending.targetExists !== true,
        writeProof: change.writeProof || null,
      };
      if (change.type === COPY_FILE_CHANGE_TYPE) {
        result.sourcePvfPath = pending.source.sourcePvfPath;
        result.sourceTextSha256 = pending.source.sourceTextSha256;
      } else {
        result.sourceSha256 = pending.source.actualSha256;
      }
      results.push(result);
      continue;
    }
    const planned = replacementPlansByPath.get(key);
    if (!planned) continue;
    const { plan } = planned;
    for (const item of plan.items) {
      const change = item.change;
      results.push({
        id: change.id,
        type: change.type,
        pvfPath: group.pvfPath,
        pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
        textWriteMode: change.textWriteMode || null,
        applicable: item.applicable,
        changed: item.changed,
        occurrenceCount: item.occurrenceCount,
        expectedOccurrences: item.expectedOccurrences,
        replaceAll: change.replaceAll === true,
        contextAnchor: item.contextAnchor,
        semanticWriteSafety: item.semanticWriteSafety,
        diff: diffSummary(item.before, item.after),
        finalFileExpectedSha256: sha256(plan.expectedText),
        writeProof: change.writeProof || null,
        structuredEditComponent: change.structuredEditComponent || null,
        structuredEditProof: change.structuredEditProof || null,
      });
    }
  }
  attachCapabilityIds(results);
  return results;
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
  for (const change of changeSet.changes) {
    const capabilityId = capabilityIdForChange(change);
    const authorized = authorizedResults.get(change.id);
    const authorizedCapabilityId = authorized?.capabilityId || capabilityIdForChange(authorized || {});
    if (!capabilityId || !authorized || authorizedCapabilityId !== capabilityId) {
      throw codedError(
        "CONTROLLED_WRITE_CAPABILITY_BINDING_MISMATCH",
        `改动 ${change.id} 的受控能力与预演记录不一致；请重新预演。`,
        { expectedCapabilityId: capabilityId, authorizedCapabilityId },
      );
    }
  }
  const directoryCache = new Map();
  let backupResult = null;
  let saveResult = null;
  let readbackSessionId = null;
  let activeApplySessionId = sessionId;
  let recomputedExecutionPlan = null;
  const replacementPlans = [];
  const preflightPendingWrites = new Map();
  const preflightPlannedTexts = new Map();
  const preflightNewFiles = [];
  const preflightReplacementPlans = [];
  const preflightReplacementPlansByPath = new Map();
  const preflightExistingNutPlans = [];
  const preflightNutAuditTextCache = new Map();

  try {
  // Build a read-only view of every final text before any in-memory write.
  // This lets a worldmap proof inspect the registry row and the paired entry
  // even when the change-set contains both new files and existing-file edits.
  for (const group of groupChangesByPvfPath(changeSet.changes)) {
    const writeFileChanges = group.changes.filter((change) => change.type === "write-file");
    const copyFileChanges = group.changes.filter((change) => change.type === COPY_FILE_CHANGE_TYPE);
    let replaceChanges = group.changes.filter((change) => change.type === "replace-text");
    const structuredChange = structuredUpgradeChange(group);
    const replacementDeclarations = structuredChange ? [structuredChange] : replaceChanges;
    if (
      writeFileChanges.length > 1 ||
      copyFileChanges.length > 1 ||
      (writeFileChanges.length && (replacementDeclarations.length || copyFileChanges.length)) ||
      (copyFileChanges.length && replacementDeclarations.length)
    ) {
      throw new Error(`同一目标路径不能混用或重复 copy-file、write-file、replace-text：${group.pvfPath}`);
    }
    if (copyFileChanges.length === 1) {
      const change = copyFileChanges[0];
      const source = await readVerifiedPvfCopySource(client, sessionId, changeSet, change, adapterConfig);
      const targetExists = await pvfPathExists(client, sessionId, group.pvfPath, directoryCache);
      const pending = { change, source, targetExists };
      preflightPendingWrites.set(normalizePvfPath(group.pvfPath).toLowerCase(), pending);
      preflightNewFiles.push(pending);
      continue;
    }
    if (writeFileChanges.length === 1) {
      const change = writeFileChanges[0];
      const source = readVerifiedSourceFile(changeSetFile, change);
      const targetExists = await pvfPathExists(client, sessionId, group.pvfPath, directoryCache);
      const pending = { change, source, targetExists };
      preflightPendingWrites.set(normalizePvfPath(group.pvfPath).toLowerCase(), pending);
      preflightNewFiles.push(pending);
      continue;
    }
    if (!replacementDeclarations.length) continue;
    const read = await callAndParse(client, "pvf_read_file", {
      sessionId,
      pvfPath: group.pvfPath,
      ...rawTextOptions(changeSet, replacementDeclarations[0], adapterConfig),
      semanticVerificationRead: true,
      maxChars: 0,
    });
    if (typeof read.textContent !== "string") throw new Error(`PVF file is not readable for apply preflight: ${group.pvfPath}`);
    const structuredExpansion = structuredChange
      ? expandReplacementChangesForSource(group, read.textContent).structured
      : null;
    if (structuredExpansion) replaceChanges = structuredExpansion.generatedChanges;
    const plan = planReplacementGroup(read.textContent, replaceChanges, {
      pvfPath: group.pvfPath,
      pvfReadEncoding: changeSet.target.pvfReadEncoding,
      fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
    });
    if (plan.blocked) {
      const blocked = plan.items.find((item) => !item.applicable);
      throw codedError(blocked.blockCode || "FILE_CHANGE_SEQUENCE_BLOCKED", blocked.blockReason || "apply preflight blocked");
    }
    buildSameFileApplicationPlan(plan);
    plan.pvfPath = group.pvfPath;
    plan.structuredUpgradeEdit = structuredExpansion;
    preflightReplacementPlans.push(plan);
    preflightReplacementPlansByPath.set(normalizePvfPath(group.pvfPath).toLowerCase(), {
      plan,
      beforeRead: read,
      replaceChanges,
      structuredExpansion,
    });
    if (replaceChanges.some((change) => change.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE)) {
      plan.existingNutAudit = await auditExistingNutControlledEdit({
        client,
        sessionId,
        pvfPath: group.pvfPath,
        sourceText: read.textContent,
        finalText: plan.expectedText,
        changes: replaceChanges,
        changeSet,
        adapterConfig,
        textCache: preflightNutAuditTextCache,
      });
      preflightExistingNutPlans.push(plan);
    }
    preflightPlannedTexts.set(normalizePvfPath(group.pvfPath).toLowerCase(), plan.expectedText);
  }
  enforceAtomicNutApidUniqueness(preflightExistingNutPlans);
  for (const plan of preflightExistingNutPlans) {
    if (plan.existingNutAudit?.ok !== true) {
      const error = new Error(`既有 NUT ${plan.pvfPath} 的正式生成前复核失败：${(plan.existingNutAudit?.errors || []).join("；")}`);
      error.code = "EXISTING_NUT_AUDIT_FAILED";
      error.details = plan.existingNutAudit;
      throw error;
    }
    for (const item of plan.items) {
      const authorized = authorizedResults.get(item.change.id);
      if (
        !authorized ||
        authorized.writeProof?.mode !== EXISTING_NUT_CONTROLLED_MODE ||
        authorized.existingNutAudit?.ok !== true ||
        authorized.existingNutRoundTripProbe?.ok !== true ||
        canonicalJsonSha256(authorized.existingNutAudit) !== canonicalJsonSha256(plan.existingNutAudit)
      ) {
        throw codedError("EXISTING_NUT_DRY_RUN_PROOF_MISMATCH", `既有 NUT ${item.change.id} 的预演审计或临时读回证据缺失/漂移；请重新预演。`);
      }
    }
  }
  for (const change of changeSet.changes.filter((item) =>
    item.type === "replace-text" && item.writeProof?.mode === "registry-lifecycle")) {
    const expectedPvfPath = normalizePvfPath(change.writeProof?.registry?.expectedPvfPath);
    const pendingTarget = preflightPendingWrites.get(expectedPvfPath.toLowerCase());
    const targetExists = Boolean(expectedPvfPath) && (Boolean(pendingTarget) || await pvfPathExists(client, sessionId, expectedPvfPath, directoryCache));
    if (!targetExists) {
      throw codedError(
        "REGISTRY_TARGET_FILE_MISSING",
        `登记表新增行的目标文件不存在且未在同一 change-set 新增：${expectedPvfPath}`,
      );
    }
  }
  for (const pending of preflightNewFiles) {
    const audit = await auditHighRiskNewFile({
      client,
      sessionId,
      change: pending.change,
      source: pending.source,
      targetExists: pending.targetExists,
      pendingWrites: preflightPendingWrites,
      plannedTexts: preflightPlannedTexts,
      changeSet,
      adapterConfig,
      directoryCache,
    });
    if (!audit.ok) {
      const error = new Error(`Change ${pending.change.id} is blocked by high-risk audit: ${audit.errors.join("；")}`);
      error.code = "HIGH_RISK_AUDIT_FAILED";
      error.details = audit;
      throw error;
    }
  }
  const preflightMapAudits = await runMapRelativeResourceAudits({
    client,
    sessionId,
    entries: mapRelativeResourceAuditEntries(preflightNewFiles, preflightReplacementPlans),
    pendingWrites: preflightPendingWrites,
    plannedTexts: preflightPlannedTexts,
    directoryCache,
    encoding: changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
  });
  for (const entry of preflightMapAudits) {
    if (entry.audit.ok !== true || entry.audit.highRisk === true) {
      const error = new Error(`地图 ${entry.targetMapPath} 的正式生成前相对资源重解析失败：${entry.audit.errors.join("；")}`);
      error.code = "MAP_RELATIVE_RESOURCE_REBIND_HIGH_RISK";
      error.details = entry.audit;
      throw error;
    }
    for (const changeId of entry.changeIds) {
      const authorized = authorizedResults.get(changeId);
      if (
        authorized?.mapRelativeResourceAudit?.ok !== true ||
        canonicalJsonSha256(authorized.mapRelativeResourceAudit) !== canonicalJsonSha256(entry.audit)
      ) {
        throw codedError(
          "MAP_RELATIVE_RESOURCE_AUDIT_MISMATCH",
          `地图改动 ${changeId} 的 .map -> .til -> .img 重解析证据与预演不一致；请重新预演。`,
        );
      }
    }
  }

  const preflightExecutionResults = buildApplyPreflightExecutionResults({
    changeSet,
    adapterConfig,
    pendingWrites: preflightPendingWrites,
    replacementPlansByPath: preflightReplacementPlansByPath,
  });
  recomputedExecutionPlan = buildControlledExecutionPlan(preflightExecutionResults);
  const executionPlanComparison = compareControlledExecutionPlans(
    authorization.manifest.executionPlan,
    recomputedExecutionPlan,
  );
  if (!executionPlanComparison.ok) {
    const mismatchSummary = executionPlanComparison.entryMismatches
      .slice(0, 5)
      .map((item) => `${item.expectedId || item.actualId || item.index}:${item.fields.join(",")}`)
      .join("；");
    throw codedError(
      "CONTROLLED_EXECUTION_PLAN_RECOMPUTE_MISMATCH",
      `正式生成前重新计算的执行计划与已授权预演不一致；尚未执行写入。${mismatchSummary ? ` 差异：${mismatchSummary}` : ""}`,
      executionPlanComparison,
    );
  }

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
      const copyFileChanges = group.changes.filter((change) => change.type === COPY_FILE_CHANGE_TYPE);
      let replaceChanges = group.changes.filter((change) => change.type === "replace-text");
      const structuredChange = structuredUpgradeChange(group);
      const replacementDeclarations = structuredChange ? [structuredChange] : replaceChanges;
      if (copyFileChanges.length && (writeFileChanges.length || replaceChanges.length)) throw new Error(`同一目标路径不能混用 copy-file、write-file 或 replace-text：${pvfPath}`);
      if (copyFileChanges.length > 1) throw new Error(`同一目标路径只能有一条 copy-file：${pvfPath}`);
      if (copyFileChanges.length === 1) {
        const change = copyFileChanges[0];
        const pending = preflightPendingWrites.get(normalizePvfPath(pvfPath).toLowerCase());
        if (!pending || pending.change.id !== change.id) {
          throw codedError("CONTROLLED_EXECUTION_PLAN_RECOMPUTE_MISMATCH", `同一 PVF 文件复制 ${change.id} 缺少统一预检计划。`);
        }
        const source = pending.source;
        const targetExists = pending.targetExists;
        if (targetExists) throw codedError("COPY_FILE_TARGET_EXISTS", `同一 PVF 文件复制目标已存在：${pvfPath}`);
        const writeSafety = semanticWriteSafety({
          kind: COPY_FILE_CHANGE_TYPE,
          pvfPath,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
          fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
          textContent: source.textContent,
          samePvfCopyProof: source.samePvfCopyProof,
        });
        if (!writeSafety.allowed) throw codedError(writeSafety.code, `Change ${change.id} is blocked: ${writeSafety.reason}`);
        const authorizedCopy = authorizedResults.get(change.id);
        if (
          authorizedCopy?.type !== COPY_FILE_CHANGE_TYPE ||
          authorizedCopy?.sourcePvfPath !== source.sourcePvfPath ||
          authorizedCopy?.sourceTextSha256 !== source.sourceTextSha256 ||
          authorizedCopy?.roundTripProbe?.ok !== true ||
          authorizedCopy?.roundTripProbe?.sourceUnchanged !== true ||
          authorizedCopy?.roundTripProbe?.independentSemanticRead !== true ||
          authorizedCopy?.roundTripProbe?.comparison?.ok !== true
        ) {
          throw codedError("COPY_FILE_DRY_RUN_PROOF_MISMATCH", `同一 PVF 文件复制 ${change.id} 的源文本或临时读回证据与预演不一致；请重新预演。`);
        }
        const applyResult = await callAndParse(client, "pvf_write_file", {
          sessionId,
          pvfPath,
          textContent: source.textContent,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          compileScript: shouldCompileNewFile(pvfPath, change),
          compileBinaryAni: false,
          convertToTraditionalChinese: false,
          samePvfCopyProof: source.samePvfCopyProof,
        });
        expectedAfterByPath.set(pvfPath, {
          kind: COPY_FILE_CHANGE_TYPE,
          sourceText: source.textContent,
          sourceTextSha256: source.sourceTextSha256,
          sourcePvfPath: source.sourcePvfPath,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          highRiskNewFile: false,
        });
        results.push({
          id: change.id,
          type: change.type,
          pvfPath,
          sourcePvfPath: source.sourcePvfPath,
          sourceTextSha256: source.sourceTextSha256,
          sourceLength: source.raw.length,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          targetExistedBeforeApply: false,
          changed: true,
          semanticWriteSafety: writeSafety,
          roundTripProbe: authorizedCopy.roundTripProbe,
          mapRelativeResourceAudit: authorizedCopy.mapRelativeResourceAudit || null,
          applyResult,
          rationale: change.rationale || "",
        });
        continue;
      }
      if (writeFileChanges.length && replaceChanges.length) throw new Error(`同一目标路径不能混用 write-file 和 replace-text：${pvfPath}`);
      if (writeFileChanges.length > 1) throw new Error(`同一目标路径只能有一条 write-file：${pvfPath}`);
      if (writeFileChanges.length === 1) {
        const change = writeFileChanges[0];
        const pending = preflightPendingWrites.get(normalizePvfPath(pvfPath).toLowerCase());
        if (!pending || pending.change.id !== change.id) {
          throw codedError("CONTROLLED_EXECUTION_PLAN_RECOMPUTE_MISMATCH", `新增文件 ${change.id} 缺少统一预检计划。`);
        }
        const source = pending.source;
        const targetExists = pending.targetExists;
        if (targetExists) {
          throw new Error(`Controlled write-file target already exists: ${pvfPath}`);
        }
        const writeSafety = semanticWriteSafety({
          kind: "write-file",
          pvfPath,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding,
          fallbackEncoding: adapterConfig.defaults.pvfReadEncoding,
          textContent: source.textContent,
          writeProof: change.writeProof,
        });
        if (!writeSafety.allowed) {
          const error = new Error(`Change ${change.id} is blocked: ${writeSafety.reason}`);
          error.code = writeSafety.code;
          throw error;
        }
        const authorizedNewFile = authorizedResults.get(change.id);
        if (HIGH_RISK_NEW_FILE_MODES[extensionOf(pvfPath)] &&
          (authorizedNewFile?.highRiskAudit?.ok !== true || authorizedNewFile?.roundTripProbe?.ok !== true)) {
          const error = new Error(`新增高风险文件 ${change.id} 的预演闭合或临时读回证据缺失；请重新预演。`);
          error.code = "HIGH_RISK_NEW_FILE_PROOF_REQUIRED";
          throw error;
        }
        const applyResult = await callAndParse(client, "pvf_write_file", {
          sessionId,
          pvfPath,
          textContent: source.textContent,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          compileScript: shouldCompileNewFile(pvfPath, change),
          compileBinaryAni: change.compileBinaryAni !== false,
          convertToTraditionalChinese: false,
          writeProof: change.writeProof,
        });
        expectedAfterByPath.set(pvfPath, {
          kind: "write-file",
          sourceText: source.textContent,
          sourceRawSha256: source.actualSha256,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          writeProof: change.writeProof || null,
          highRiskNewFile: Boolean(HIGH_RISK_NEW_FILE_MODES[extensionOf(pvfPath)]),
        });
        results.push({
          id: change.id,
          type: change.type,
          pvfPath,
          sourceFile: source.sourceFile,
          sourceSha256: source.actualSha256,
          sourceLength: source.raw.length,
          pvfEncoding: change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding,
          targetExistedBeforeApply: false,
          changed: true,
          semanticWriteSafety: writeSafety,
          writeProof: change.writeProof || null,
          highRiskAudit: authorizedResults.get(change.id)?.highRiskAudit || null,
          roundTripProbe: authorizedResults.get(change.id)?.roundTripProbe || null,
          mapRelativeResourceAudit: authorizedResults.get(change.id)?.mapRelativeResourceAudit || null,
          applyResult,
          rationale: change.rationale || "",
        });
        continue;
      }
      const encodings = new Set(replacementDeclarations.map((change) =>
        change.pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding));
      if (encodings.size !== 1) {
        const error = new Error(`同一文件的多条改动必须使用同一种 PVF 编码：${pvfPath}`);
        error.code = "FILE_CHANGE_ENCODING_CONFLICT";
        throw error;
      }
      const preflightReplacement = preflightReplacementPlansByPath.get(normalizePvfPath(pvfPath).toLowerCase());
      if (!preflightReplacement) {
        throw codedError("CONTROLLED_EXECUTION_PLAN_RECOMPUTE_MISMATCH", `文件 ${pvfPath} 缺少统一预检计划。`);
      }
      const beforeRead = preflightReplacement.beforeRead;
      const structuredExpansion = preflightReplacement.structuredExpansion;
      replaceChanges = preflightReplacement.replaceChanges;
      const plan = preflightReplacement.plan;
      if (plan.blocked) {
        const blocked = plan.items.find((item) => !item.applicable);
        const error = new Error(`Change ${blocked.change.id} is blocked: ${blocked.blockReason}`);
        error.code = blocked.blockCode;
        throw error;
      }
      plan.structuredUpgradeEdit = structuredExpansion;
      const preflightNutPlan = preflightExistingNutPlans.find((candidate) =>
        normalizePvfPath(candidate.pvfPath).toLowerCase() === normalizePvfPath(pvfPath).toLowerCase()) || null;
      const highRiskExistingNut = replaceChanges.some((change) => change.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE);
      if (highRiskExistingNut && preflightNutPlan?.existingNutAudit?.ok !== true) {
        throw codedError("EXISTING_NUT_AUDIT_FAILED", `既有 NUT ${pvfPath} 缺少正式生成前专用审计。`);
      }
      for (const item of plan.items) {
        const authorized = authorizedResults.get(item.change.id);
        const currentAnchor = item.contextAnchor;
        if (!authorized || authorized.finalFileExpectedSha256 !== sha256(plan.expectedText)) {
          const error = new Error(`改动 ${item.change.id} 的最终文件计划与预演记录不一致；请重新预演。`);
          error.code = "DRY_RUN_FILE_PLAN_MISMATCH";
          throw error;
        }
        if (item.change.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE && (
          authorized.structuredEditProof?.planBindingSha256 !== item.change.structuredEditProof?.planBindingSha256 ||
          authorized.structuredEditProof?.component !== item.change.structuredEditComponent ||
          authorized.structuredEditProof?.componentState !== (item.changed ? "changed" : "no-op") ||
          authorized.structuredEditProof?.componentState !== item.change.structuredEditProof?.componentState ||
          authorized.structuredEditProof?.componentBeforeSha256 !== item.change.structuredEditProof?.componentBeforeSha256 ||
          authorized.structuredEditProof?.componentAfterSha256 !== item.change.structuredEditProof?.componentAfterSha256 ||
          authorized.structuredEditProof?.declaredValuesVerified !== true ||
          authorized.structuredEditProof?.writerRequired !== item.changed ||
          authorized.structuredRoundTripProbe?.ok !== true ||
          authorized.structuredRoundTripProbe?.componentState !== (item.changed ? "changed" : "no-op") ||
          authorized.structuredRoundTripProbe?.declaredValuesVerified !== true ||
          authorized.structuredRoundTripProbe?.writerRequired !== item.changed ||
          authorized.structuredRoundTripProbe?.componentReadbackState !== "no-op"
        )) {
          throw codedError("UPGRADE_TABLE_DRY_RUN_PROOF_MISMATCH", `强化/增幅结构化编辑 ${item.change.id} 的解析计划或临时独立读回证据与预演不一致；请重新预演。`);
        }
        if (
          authorized.contextAnchor?.selectorSha256 !== currentAnchor?.selectorSha256 ||
          authorized.contextAnchor?.locationBindingSha256 !== currentAnchor?.locationBindingSha256 ||
          authorized.contextAnchor?.occurrenceOffsetsSha256 !== currentAnchor?.occurrenceOffsetsSha256 ||
          Boolean(authorized.contextAnchor?.scopeApplied) !== Boolean(currentAnchor?.scopeApplied) ||
          (currentAnchor?.scopeApplied === true && (
            authorized.contextAnchor?.scope?.rangeBindingSha256 !== currentAnchor?.scope?.rangeBindingSha256 ||
            authorized.contextAnchor?.scope?.rangesSha256 !== currentAnchor?.scope?.rangesSha256
          ))
        ) {
          const error = new Error(`改动 ${item.change.id} 的定位位置与预演记录不一致；请重新读取目标并预演。`);
          error.code = "CONTEXT_ANCHOR_BINDING_MISMATCH";
          throw error;
        }
      }
      replacementPlans.push({ ...plan, pvfPath });
      const verifiedItems = plan.items.filter((item) => item.changed && isVerifiedInlineTextMode(item.change.textWriteMode));
      const pvfEncoding = replaceChanges[0].pvfEncoding || changeSet.target.pvfReadEncoding || adapterConfig.defaults.pvfReadEncoding;
      const controlledBinaryAni = extensionOf(pvfPath) === ".ani";
      expectedAfterByPath.set(pvfPath, {
        kind: "replace-text",
        expectedText: plan.expectedText,
        pvfEncoding,
        verifiedInlineText: verifiedItems.length > 0,
        highRiskExistingNut,
        controlledBinaryAni,
        structuredUpgradeRequest: structuredExpansion?.request || null,
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
          scopedOccurrenceCount: item.scopedOccurrenceCount,
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
          writeProof: change.writeProof || null,
          existingNutAudit: highRiskExistingNut ? preflightNutPlan.existingNutAudit : null,
          existingNutRoundTripProbe: highRiskExistingNut ? authorizedResults.get(change.id)?.existingNutRoundTripProbe || null : null,
          binaryAniRoundTripProbe: controlledBinaryAni ? authorizedResults.get(change.id)?.binaryAniRoundTripProbe || null : null,
          structuredEditParentId: change.structuredEditParentId || null,
          structuredEditComponent: change.structuredEditComponent || null,
          structuredEditProof: change.structuredEditProof || null,
          structuredRoundTripProbe: change.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE ? authorizedResults.get(change.id)?.structuredRoundTripProbe || null : null,
          mapRelativeResourceAudit: authorizedResults.get(change.id)?.mapRelativeResourceAudit || null,
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
          const eligibility = result.semanticWriteSafety?.verifiedInlineTextWrite || null;
          if (
            eligibility?.eligibilityPolicyId !== VERIFIED_TEXT_ELIGIBILITY_POLICY_ID ||
            eligibility?.eligibilityPolicySha256 !== VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256 ||
            proof?.eligibilityPolicyId !== eligibility.eligibilityPolicyId ||
            proof?.eligibilityPolicySha256 !== eligibility.eligibilityPolicySha256 ||
            proof?.eligibilityProofsSha256 !== eligibility.eligibilityProofsSha256 ||
            proof?.eligibilityProofsSha256 !== sha256(JSON.stringify(proof?.eligibilityProofs || []))
          ) {
            throw codedError(
              "CN_TEXT_ELIGIBILITY_PROOF_MISMATCH",
              `中文文本改动 ${item.change.id} 的结构化文字资格证明与写前计划不一致；已停止生成。`,
            );
          }
          writerProofs.push(proof);
          result.applyResult = applied;
        } else {
          const applied = coordinatedApply.ordinaryResults.get(item.change.id) || null;
          if (item.change.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE && applied?.existingNutTransition?.ok !== true) {
            throw codedError("EXISTING_NUT_TRANSITION_AUDIT_FAILED", `既有 NUT ${item.change.id} 的最终文本写入审计未返回成功证明。`);
          }
          if (item.change.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE) {
            const authorized = authorizedResults.get(item.change.id);
            const expectedRawSha256 = String(authorized?.rawAsciiTokenPlanProof?.outputRawSha256 || "").toLowerCase();
            const appliedRawSha256 = String(applied?.writeResult?.outputRawSha256 || "").toLowerCase();
            if (!/^[a-f0-9]{64}$/u.test(expectedRawSha256) || appliedRawSha256 !== expectedRawSha256) {
              throw codedError("EXISTING_NUT_APPLY_RAW_PLAN_MISMATCH", `既有 NUT ${item.change.id} 的正式原始字节计划与预演不一致。`);
            }
            expected.existingNutOutputRawSha256 = expectedRawSha256;
          }
          if (extensionOf(plan.pvfPath) === ".ani") {
            const authorized = authorizedResults.get(item.change.id);
            const expectedRawSha256 = String(authorized?.rawAsciiTokenPlanProof?.outputRawSha256 || "").toLowerCase();
            const appliedRawSha256 = String(applied?.writeResult?.outputRawSha256 || "").toLowerCase();
            if (!/^[a-f0-9]{64}$/u.test(expectedRawSha256) || appliedRawSha256 !== expectedRawSha256 ||
                applied?.writeResult?.mode !== "raw-ascii-binary-ani") {
              throw codedError("RAW_ANI_APPLY_RAW_PLAN_MISMATCH", `既有 ANI ${item.change.id} 的正式原始字节计划与预演不一致。`);
            }
            if (expected.binaryAniOutputRawSha256 && expected.binaryAniOutputRawSha256 !== expectedRawSha256) {
              throw codedError("RAW_ANI_APPLY_RAW_PLAN_MISMATCH", `既有 ANI ${plan.pvfPath} 的同文件多项改动返回了不一致的最终原始字节哈希。`);
            }
            expected.binaryAniOutputRawSha256 = expectedRawSha256;
          }
          result.applyResult = applied;
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
        semanticVerificationRead: expected.kind === "replace-text" || expected.kind === COPY_FILE_CHANGE_TYPE || expected.highRiskNewFile === true,
        maxChars: 0,
      });
      if (expected.kind === "replace-text") {
        const comparison = pvfTextReadbackResult(expected.expectedText, rb.textContent);
        const controlledRawReadbackRequired = expected.highRiskExistingNut === true || expected.controlledBinaryAni === true;
        const rawReadback = controlledRawReadbackRequired
          ? await callAndParse(client, "pvf_read_file", {
            sessionId: readbackSessionId,
            pvfPath,
            pvfEncoding: expected.pvfEncoding,
            semanticVerificationRead: true,
            rawSha256Only: true,
          })
          : null;
        const actualOutputRawSha256 = rawReadback
          ? String(rawReadback.rawContentSha256 || "").toLowerCase()
          : null;
        const expectedOutputRawSha256 = expected.highRiskExistingNut === true
          ? expected.existingNutOutputRawSha256
          : expected.controlledBinaryAni === true ? expected.binaryAniOutputRawSha256 : null;
        const rawByteReadbackOk = controlledRawReadbackRequired
          ? /^[a-f0-9]{64}$/u.test(String(expectedOutputRawSha256 || "")) &&
            actualOutputRawSha256 === expectedOutputRawSha256
          : null;
        const independentRawRead = controlledRawReadbackRequired
          ? rawReadback?.semanticReadGuard?.applied === true &&
            rawReadback.semanticReadGuard?.reason === "verified-text-readback" &&
            rawReadback.semanticReadGuard?.backend === "typescript-readonly-fallback"
          : null;
        const structuredUpgradeReadbackRequired = Boolean(expected.structuredUpgradeRequest);
        const independentSemanticRead = expected.verifiedInlineText === true || controlledRawReadbackRequired || structuredUpgradeReadbackRequired
          ? rb.semanticReadGuard?.applied === true &&
            rb.semanticReadGuard?.reason === "verified-text-readback" &&
            rb.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
            (expected.controlledBinaryAni === true || rb.semanticReadGuard?.selectedEncoding === expected.pvfEncoding)
          : null;
        const structuredReparse = structuredUpgradeReadbackRequired
          ? expandUpgradeTableLevelEdit(rb.textContent, expected.structuredUpgradeRequest)
          : null;
        const structuredFixedPoint = structuredUpgradeReadbackRequired
          ? structuredReparse.expectedText === rb.textContent &&
            structuredReparse.noChange === true &&
            structuredReparse.proof?.selectorsAreRawGroupIndexes === true &&
            structuredReparse.proof?.gameplayDisplayLevelMappingInferred === false &&
            structuredReparse.proof?.table?.width === 17 &&
            structuredReparse.proof?.table?.state === "no-op" &&
            structuredReparse.proof?.table?.levelIndexMode === "zero-based-group-index" &&
            validMaxLevelProof(structuredReparse.proof?.maxLevelByRarity, expected.structuredUpgradeRequest) &&
            structuredReparse.proof?.maxLevelByRarity?.state === "no-op" &&
            (normalizePvfPath(pvfPath).toLowerCase() !== "etc/amplifyupgrade.etc" ||
              (structuredReparse.proof?.amplificationConst?.width === 4 &&
                structuredReparse.proof?.amplificationConst?.hasLevelZeroGroup === true &&
                structuredReparse.proof?.amplificationConst?.state === "no-op"))
          : null;
        const writerProofsOk = expected.verifiedInlineText === true
          ? Array.isArray(expected.writerProofs) && expected.writerProofs.length > 0 &&
            expected.writerProofs.every((proof) =>
              proof?.existingStringEntriesPreserved === true &&
              proof?.encoding === expected.pvfEncoding &&
              proof?.eligibilityPolicyId === VERIFIED_TEXT_ELIGIBILITY_POLICY_ID &&
              proof?.eligibilityPolicySha256 === VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256 &&
              proof?.eligibilityProofsSha256 === sha256(JSON.stringify(proof?.eligibilityProofs || [])))
          : null;
        const writerBatchProofOk = expected.verifiedInlineText === true
          ? expected.writerBatchProof?.ok === true &&
            expected.writerBatchProof?.mode === "verified-inline-text-batch" &&
            expected.writerBatchProof?.encoding === expected.pvfEncoding &&
            expected.writerBatchProof?.proof?.eligibilityPolicyId === VERIFIED_TEXT_ELIGIBILITY_POLICY_ID &&
            expected.writerBatchProof?.proof?.eligibilityPolicySha256 === VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256 &&
            expected.writerBatchProof?.proof?.existingStringEntriesPreserved === true
          : null;
        const verifiedOk = expected.verifiedInlineText === true
          ? comparison.exactTextOk === true && independentSemanticRead && writerProofsOk && writerBatchProofOk
          : (structuredUpgradeReadbackRequired
            ? comparison.exactTextOk === true && independentSemanticRead && structuredFixedPoint === true
          : (controlledRawReadbackRequired
            ? comparison.ok === true && independentSemanticRead && independentRawRead && rawByteReadbackOk
            : comparison.ok));
        readback.push({
          pvfPath,
          kind: expected.kind,
          ...comparison,
          ok: verifiedOk,
          verifiedInlineText: expected.verifiedInlineText === true,
          verifiedInlineCn: expected.verifiedInlineText === true && expected.pvfEncoding === "Cn",
          highRiskExistingNut: expected.highRiskExistingNut === true,
          controlledBinaryAni: expected.controlledBinaryAni === true,
          structuredUpgradeTableEdit: structuredUpgradeReadbackRequired,
          structuredFixedPoint,
          structuredReparseProof: structuredReparse?.proof || null,
          runtimeValidationRequired: expected.highRiskExistingNut === true || expected.controlledBinaryAni === true || structuredUpgradeReadbackRequired ||
            (expected.writerProofs || []).some(proof => (proof.eligibilityProofs || []).some(item => item.runtimeValidationRequired === true)),
          independentSemanticRead,
          independentRawRead,
          rawByteReadbackOk,
          expectedOutputRawSha256: expectedOutputRawSha256 || null,
          actualOutputRawSha256,
          rawContentBytes: rawReadback?.rawContentBytes ?? null,
          rawSemanticReadGuard: rawReadback?.semanticReadGuard || null,
          semanticReadGuard: rb.semanticReadGuard || null,
          writerProofs: expected.writerProofs || [],
          writerBatchProof: expected.writerBatchProof || null,
          changeIds: expected.changeIds || [],
          metadata: rb.metadata,
        });
      } else {
        const hasText = typeof rb.textContent === "string";
        if (hasText) {
          const comparison = pvfTextReadbackResult(expected.sourceText, rb.textContent);
          const independentSemanticRead = expected.highRiskNewFile === true || expected.kind === COPY_FILE_CHANGE_TYPE
            ? rb.semanticReadGuard?.applied === true &&
              rb.semanticReadGuard?.reason === "verified-text-readback" &&
              rb.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
              rb.semanticReadGuard?.selectedEncoding === expected.pvfEncoding
            : null;
          readback.push({
            pvfPath,
            kind: expected.kind,
            ...comparison,
            ok: comparison.ok === true && ((expected.highRiskNewFile !== true && expected.kind !== COPY_FILE_CHANGE_TYPE) || independentSemanticRead),
            highRiskNewFile: expected.highRiskNewFile === true,
            samePvfCopy: expected.kind === COPY_FILE_CHANGE_TYPE,
            independentSemanticRead,
            semanticReadGuard: rb.semanticReadGuard || null,
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
  const protectedSourceInputPvf = input.protectedSourcePvf;
  const protectedSourceOriginPvf = input.protectedSourceOriginPvf || protectedSourceInputPvf;
  const protectedSourcePvfSha256 = input.cumulative?.protectedSourcePvfSha256 || authorization.sourcePvfSha256;
  const protectedSourceInputPvfSha256AfterApply = sha256File(protectedSourceInputPvf);
  const protectedSourceUnchanged = protectedSourceInputPvfSha256AfterApply.toLowerCase() === protectedSourcePvfSha256.toLowerCase();
  const protectedSourcePvf = paths.backupPath;
  const protectedSourcePvfSha256AfterApply = sha256File(protectedSourcePvf);
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
  attachCapabilityIds(results);
  const manifest = {
    schemaVersion: "1.0",
    phase: "phase-3-controlled-output-apply",
    generatedAt: new Date().toISOString(),
    mode: "controlled-output-only",
    writeOperationsExecuted: true,
    sourcePvf,
    protectedSourcePvf,
    protectedSourceOriginPvf,
    protectedSourcePvfSha256,
    protectedSourcePvfSha256AfterApply,
    outputPvf: paths.outputPvf,
    outputPvfSha256,
    outputPvfBytes,
    backupPath: paths.backupPath,
    changeSetFile: path.resolve(changeSetFile),
    dryRunManifest: authorization.manifestFile,
    dryRunBindingSha256: authorization.binding.bindingSha256,
    authorizedExecutionPlanSha256: authorization.manifest.executionPlan.planSha256,
    recomputedExecutionPlanSha256: recomputedExecutionPlan?.planSha256 || null,
    executionPlanMatch: recomputedExecutionPlan?.planSha256 === authorization.manifest.executionPlan.planSha256,
    executionPlan: recomputedExecutionPlan,
    sourcePvfSha256: authorization.sourcePvfSha256,
    sourcePvfSha256AfterApply,
    changeSetFileSha256: authorization.changeSetFileSha256,
    sourceProfile: resolvedSource.profile?.name || null,
    safety: {
      sourceOverwriteAllowed: false,
      sourceOverwritten: !sourceUnchanged,
      sourceUnchanged,
      protectedSourceUnchanged,
      protectedSourceAnchoredByContentAddressedBackup: true,
      protectedSourceOriginPathMayBeAuthorizedClientTarget: true,
      backupCreated: Boolean(backupResult?.targetPath && fs.existsSync(backupResult.targetPath)),
      backupContentAddressed: true,
      backupCreatedThisRun: backupResult?.created === true,
      backupReused: backupResult?.reused === true,
      backupSha256Verified: backupResult?.sha256 === protectedSourcePvfSha256,
      matchingDryRunRequired: true,
      matchingDryRunVerified: true,
      executionPlanRecomputedBeforeWrite: true,
      executionPlanMatchedAuthorizedDryRun: recomputedExecutionPlan?.planSha256 === authorization.manifest.executionPlan.planSha256,
      replacementWriterConsumedPreflightPlanObject: true,
      explicitUserAuthorizationRequired: true,
      explicitUserAuthorizationVerified: true,
      explicitOutputPath: true,
      readbackExecuted: true,
      readbackOk,
      outputSha256Bound: true,
      readbackComparisonPolicy: "exact-text-or-float32-aware-token-equivalence",
      semanticWriteGuardEnabled: true,
      verifiedInlineTextWriteAllowed: true,
      verifiedTextEligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
      verifiedTextEligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
      verifiedTextEligibilityDefaultBlocked: true,
      verifiedTextEligibilityProofBoundToDryRunAndApply: true,
      verifiedTextEligibilityPermissionExpansionAllowed: false,
      verifiedInlineTextRequiresExactIndependentReadback: true,
      exactAdjacentContextAnchoringAllowed: true,
      contextAnchorDoesNotRelaxTextSafety: true,
      exactRangeScopeAllowed: true,
      scopeBoundaryRewriteAllowed: false,
      scopeEvidenceBoundToDryRunAndApply: true,
      sameFileChangesPlannedAsOneFinalText: true,
      sameFileChangeOrderPreservedWhenRequired: true,
      sameFileVerifiedInlineTextAppliedAsOneBatch: true,
      stringTableAppendedOncePerVerifiedFileBatch: true,
      unverifiedDirectNonAsciiTextWriteAllowed: false,
      cnStrWriteAllowed: false,
      highRiskNewFileProofRequired: true,
      highRiskNewFileRoundTripProbeRequired: true,
      highRiskFinalIndependentReadbackRequired: true,
      highRiskSameExtensionReferenceRequired: true,
      samePvfOrdinaryTextCopyAllowed: true,
      samePvfCopyRequiresSameExtension: true,
      samePvfCopyRequiresAbsentTarget: true,
      samePvfCopyHighRiskExtensionsAllowed: false,
      samePvfCopyRoundTripProbeRequired: true,
      samePvfCopyModificationRequiresCumulativeNextRound: true,
      existingHighRiskFileProtectionRemains: true,
      existingNutControlledEditRequiresDedicatedProof: true,
      existingNutAsciiOnly: true,
      existingNutSourceTextSha256Required: true,
      existingNutRawBytePreservingPatchRequired: true,
      existingNutWholeFileReencodingAllowed: false,
      existingNutNonTargetRawBytesMustRemainIdentical: true,
      existingNutLoadChainRequired: true,
      existingNutFunctionApiAndApidAuditRequired: true,
      existingNutEvidenceMustBeExecutableCode: true,
      existingNutApidMustBeExactIntegerLiteral: true,
      existingNutApidMustBeDeclaredApiCallArgument: true,
      existingNutTemporaryRoundTripRequired: true,
      existingNutFinalIndependentReadbackRequired: true,
      existingNutFinalRawByteSha256ReadbackRequired: true,
      existingNutRuntimeValidationRequired: true,
      existingBinaryAniDelayOnly: true,
      existingBinaryAniRawBytePreservingPatchRequired: true,
      existingBinaryAniWholeFileReencodingAllowed: false,
      existingBinaryAniNonTargetRawBytesMustRemainIdentical: true,
      existingBinaryAniTemporaryRoundTripRequired: true,
      existingBinaryAniFinalRawByteSha256ReadbackRequired: true,
      existingBinaryAniRuntimeValidationRequired: true,
      structuredUpgradeTableEditAllowed: true,
      structuredUpgradeTableExactPathsOnly: true,
      structuredUpgradeTableWidth: 17,
      structuredUpgradeLevelIndexIsZeroBasedGroupIndex: true,
      structuredUpgradeIndependentGroupSelectorsAllowed: true,
      structuredUpgradeGameplayDisplayLevelMappingInferred: false,
      structuredUpgradeFirstColumnIsExplicitLevelNumber: false,
      structuredUpgradeColumnsMustFormExactPartition: true,
      structuredUpgradeExactSetCellsExpectedValueRequired: true,
      structuredUpgradeComponentNoOpProofRequired: true,
      structuredUpgradeAllNoOpApplyAuthorized: false,
      structuredUpgradeAllSixRarityLimitsRequired: true,
      structuredAmplificationConstGroupWidth: 4,
      structuredAmplificationConstHasLevelZeroGroup: true,
      structuredForgingFileExcluded: true,
      structuredUpgradeTemporaryRoundTripRequired: true,
      structuredUpgradeFinalIndependentReadbackRequired: true,
      structuredUpgradeRuntimeValidationRequired: true,
      existingCoSqrStrProtectionRemains: true,
      registryLifecycleOnlyForExplicitRowAdd: true,
      registryLifecycleExistingTextPreserved: true,
      registryLifecycleTargetClosureRequired: true,
      worldmapLifecycleRequiresRegistryUiDungeonTownRegionClosure: true,
      worldmapLifecycleRequiresBothTownAndRegion: true,
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
      samePvfCopyCount: results.filter((item) => item.type === COPY_FILE_CHANGE_TYPE && item.changed).length,
      samePvfCopyReadbackPassedCount: readback.filter((item) => item.samePvfCopy === true && item.ok).length,
      existingNutControlledCount: results.filter((item) => item.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE).length,
      existingNutControlledReadbackPassedCount: readback.filter((item) => item.highRiskExistingNut === true && item.ok).length,
      existingBinaryAniDelayCount: results.filter((item) => extensionOf(item.pvfPath) === ".ani" && item.changed).length,
      existingBinaryAniDelayReadbackPassedCount: readback.filter((item) => item.controlledBinaryAni === true && item.ok).length,
      structuredUpgradeTableComponentCount: results.filter((item) => item.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE && item.changed).length,
      structuredUpgradeTableReadbackPassedCount: readback.filter((item) => item.structuredUpgradeTableEdit === true && item.ok).length,
      mapRelativeResourceAuditCount: results.filter((item) => Boolean(item.mapRelativeResourceAudit)).length,
      mapRelativeResourceHighRiskCount: results.filter((item) => item.mapRelativeResourceAudit?.highRisk === true).length,
      inGameRuntimeValidationRequiredCount: results.filter((item) =>
        (item.writeProof?.mode === EXISTING_NUT_CONTROLLED_MODE || extensionOf(item.pvfPath) === ".ani" || item.type === UPGRADE_TABLE_LEVEL_EDIT_TYPE || item.mapRelativeResourceAudit?.inGameValidationRequired === true) && item.changed).length,
    },
    cumulative: {
      enabled: Boolean(input.cumulative),
      previousApplyManifest: input.cumulative?.manifestPath || null,
      previousApplyManifestSha256: input.cumulative?.manifestSha256 || null,
      inputPvf: sourcePvf,
      inputPvfSha256: authorization.sourcePvfSha256,
      protectedSourcePvf,
      protectedSourceOriginPvf,
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
    const report = await changeSetAuthorizationSelfTest();
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
        recovery: writeBlockDiagnosis(item),
        blockedByChangeId: item.blockDetails?.blockedByChangeId || null,
        blockedByCode: item.blockDetails?.blockedByCode || null,
        details: item.blockDetails || null,
      }));
    printJson({
      ok: true,
      command,
      manifestPath,
      summary: manifest.summary,
      noChange: manifest.summary?.noChange === true,
      approvalCode: blockedChanges.length ? null : manifest.binding.approvalCode,
      blockedChanges,
      agentHandoff: dryRunAgentHandoff(
        file,
        manifestPath,
        blockedChanges.length ? null : manifest.binding.approvalCode,
        blockedChanges,
        manifest.summary?.noChange === true,
      ),
    });
    if (manifest.summary.blockedCount > 0) {
      process.exit(2);
    }
    return;
  }
  if (command === "apply") {
    const { manifestPath, manifest } = await runApply(changeSet, file, loadedChangeSetSha256);
    const automaticDeployment = args.includes("--no-auto-deploy")
      ? { status: "skipped", reason: "explicit-output-only" }
      : require("../lib/client-pvf-preferences").autoDeployAfterApply(workbenchRoot, manifestPath, manifest);
    printJson({
      ok: true,
      command,
      manifestPath,
      outputPvf: manifest.outputPvf,
      backupPath: manifest.backupPath,
      summary: manifest.summary,
      automaticDeployment,
      agentHandoff: automaticDeployment.status === "not-enabled" ? applyAgentHandoff(manifestPath, manifest) : {
        ...applyAgentHandoff(manifestPath, manifest), automaticDeployment,
        instruction: automaticDeployment.status === "skipped" ? "本轮明确只生成独立输出，未自动部署；已保存偏好未改变。" : ["deployed", "already-deployed"].includes(automaticDeployment.status)
          ? "已按保存的客户端授权完成自动部署或确认版本一致；报告备份和结果，不要再次部署或重复询问授权。"
          : "独立输出已完成，但自动部署被阻断。报告原因；保留成品，解决客户端运行或核验问题后用 client-pvf auto-deploy 重试，无需重复请求已保存的部署授权。",
      },
    });
    return;
  }
  throw new Error(`Unsupported command: ${command}`);
}

main().catch((error) => {
  const code = error?.code ? `[${error.code}] ` : "";
  console.error(`ERROR ${code}${error.message}`);
  if (error?.code === "CN_LOCALIZATION_WRITE_UNVERIFIED") {
    console.error("提示：既有共享 .str 编辑尚未实现；新增文件与道具名称解除引用有独立路线。没有生成或覆盖 PVF。");
  } else if (error?.code === "NON_ASCII_TEXT_WRITE_UNVERIFIED") {
    console.error("提示：普通脚本中文需要使用完整文字验证模式；参数/结构请拆成同文件的普通改动。未声明模式的中文仍会被阻止。");
  } else if (["CN_TEXT_CHARACTER_UNENCODABLE", "CN_TEXT_ENCODING_ROUNDTRIP_FAILED"].includes(error?.code)) {
    console.error("提示：新文字含当前编码无法无损保存的字符，请换用常见简体中文、数字或符号后重试。");
  } else if (error?.code === "HTML_NUMERIC_ENTITY_WRITE_BLOCKED") {
    console.error("提示：请使用目标 PVF 原始读回中的真实文字，不要把网页里的 &#数字; 形式写进 PVF。");
  } else if (["CN_TEXT_TOKEN_REQUIRED", "CN_TEXT_PARENT_TAG_UNSUPPORTED", "CN_TEXT_FILE_TYPE_UNSUPPORTED"].includes(error?.code)) {
    console.error("提示：需完整文字 token 和匹配的结构路线。未知标签下的独立标量见 pvf-scalar-text-controlled-change 任务卡；未知结构不代表已证明危险。");
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
