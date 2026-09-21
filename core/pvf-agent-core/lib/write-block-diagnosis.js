"use strict";

// Describe a failed verification without presenting missing implementation as
// a judgement about the user's task. This is diagnostic only, never permission.
function writeBlockDiagnosis(item = {}) {
  const code = item.blockCode || item.encodingRoundTripProbe?.code || item.semanticWriteSafety?.code || "UNKNOWN";
  const details = item.blockDetails || item.semanticWriteSafety?.details || {};
  let category = details.category || "verification-failed";
  let nextStep = "按具体核验失败项修正方案；不修改规则来跳过失败。";
  let taskCard = details.recoveryTaskCard || null;
  if (code === "FILE_CHANGE_BATCH_BLOCKED") {
    category = "dependent-change-blocked";
    nextStep = `先修复 ${details.blockedByChangeId || "同文件中的真正阻断项"}，其他已通过静态检查的变化保持原样。`;
  } else if (/CHARACTER_UNENCODABLE|ENCODING_ROUNDTRIP_FAILED|TEXT_ENCODING|ENCODING_CONFLICT/.test(code)) {
    category = "encoding-mismatch";
    nextStep = "按目标原始读取的编码检查文字；不能静默换字或有损保存。";
  } else if (/OCCURRENCE|CONTEXT_|SCOPE_|DISPLAY_TEXT_USED|CHANGE_TEXT_ENCODING_MISMATCH/.test(code)) {
    category = "source-selection-mismatch";
    nextStep = "重新原始读取同一路径，修正精确原文、上下文、范围或命中数量。";
  } else if (code === "CN_TEXT_PARENT_TAG_UNSUPPORTED") {
    category = "unsupported-structure";
    nextStep = "独立标量文字可使用显式文字路线；结构记录须使用对应任务卡。未识别不等于危险。";
    taskCard = "knowledge-pack/task-cards/pvf-scalar-text-controlled-change.zh-CN.md";
  } else if (code === "CN_LOCALIZATION_WRITE_UNVERIFIED" || category === "unsupported-capability") {
    category = "unsupported-capability";
    nextStep = "当前缺少该既有文件编辑的实现；重试、换编码或套用新增文件证明不能补齐能力。";
    taskCard ||= "knowledge-pack/task-cards/pvf-controlled-change-routing.zh-CN.md";
  } else if (/STRINGLINK/.test(code)) {
    category = "shared-reference";
    nextStep = "先确认共享引用影响；明确的道具名称改名已有解除引用路线，其他共享文字编辑尚未实现。";
    taskCard = "knowledge-pack/task-cards/stackable-stringlink-detach-controlled-change.zh-CN.md";
  } else if (/PROOF_REQUIRED|ROUNDTRIP_REQUIRED/.test(code) || category === "route-required" || category === "evidence-required") {
    category = "evidence-required";
    nextStep = "通过对应任务卡和工具补齐可复核证明，不把缺少证明描述为永久禁止。";
    taskCard ||= "knowledge-pack/task-cards/pvf-controlled-change-routing.zh-CN.md";
  } else if (/REBIN|CONFLICT|COLLISION|TARGET_FILE_MISSING/.test(code)) {
    category = "dependency-conflict";
    nextStep = "检查报告指出的真实路径、ID 或依赖冲突，修正同一原子方案后重试。";
  } else if (code === "READ_ONLY_FALLBACK") {
    category = "environment-unavailable";
    nextStep = "读取仍可用；运行 workbench.bat check 修复写出后端。";
  }
  return { category, code, nextStep, taskCard, grantsWritePermission: false };
}

module.exports = { writeBlockDiagnosis };
