"use strict";

const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function findOccurrences(text, needle) {
  const source = String(text ?? "");
  const target = String(needle ?? "");
  if (!target) return [];
  const offsets = [];
  let searchOffset = 0;
  while (true) {
    const offset = source.indexOf(target, searchOffset);
    if (offset < 0) return offsets;
    offsets.push(offset);
    searchOffset = offset + target.length;
  }
}

function optionalContext(input, name) {
  if (input[name] === undefined) return null;
  if (typeof input[name] !== "string" || input[name].length === 0) {
    throw codedError(
      "CONTEXT_ANCHOR_EMPTY",
      `${name} 提供后必须是非空的精确原文。`,
      { field: name },
    );
  }
  return input[name];
}

function selectorBinding(previousText, contextBefore, contextAfter) {
  const payload = {
    schemaVersion: "1.0",
    mode: contextBefore !== null || contextAfter !== null ? "adjacent-context" : "exact-text",
    previousTextSha256: sha256(previousText),
    contextBeforeSha256: contextBefore === null ? null : sha256(contextBefore),
    contextAfterSha256: contextAfter === null ? null : sha256(contextAfter),
    previousTextLength: previousText.length,
    contextBeforeLength: contextBefore === null ? 0 : contextBefore.length,
    contextAfterLength: contextAfter === null ? 0 : contextAfter.length,
  };
  return { ...payload, selectorSha256: sha256(JSON.stringify(payload)) };
}

function analyzeContextAnchoredReplacement(input = {}) {
  const sourceText = String(input.sourceText ?? "");
  const previousText = String(input.previousText ?? "");
  if (input.occurrenceIndex !== undefined) {
    throw codedError(
      "OCCURRENCE_INDEX_UNSUPPORTED",
      "不支持按出现序号定位；请使用来自目标原始读回的 contextBefore/contextAfter。",
    );
  }
  if (!previousText) {
    throw codedError("PREVIOUS_TEXT_REQUIRED", "previousText 必须是非空的精确原文。");
  }
  const contextBefore = optionalContext(input, "contextBefore");
  const contextAfter = optionalContext(input, "contextAfter");
  if (contextBefore?.includes(previousText) || contextAfter?.includes(previousText)) {
    throw codedError(
      "CONTEXT_ANCHOR_CONTAINS_TARGET",
      "上下文锚点不得包含 previousText；请只保留目标文本紧邻的前后原文。",
      {
        contextBeforeContainsTarget: Boolean(contextBefore?.includes(previousText)),
        contextAfterContainsTarget: Boolean(contextAfter?.includes(previousText)),
      },
    );
  }

  const replaceAll = input.replaceAll === true;
  const suppliedExpectedOccurrences = Number.isSafeInteger(input.expectedOccurrences)
    ? input.expectedOccurrences
    : null;
  if (replaceAll && (suppliedExpectedOccurrences === null || suppliedExpectedOccurrences < 1)) {
    throw codedError("EXPECTED_OCCURRENCES_REQUIRED", "批量替换必须明确填写正整数 expectedOccurrences。");
  }
  if (!replaceAll && suppliedExpectedOccurrences !== null && suppliedExpectedOccurrences !== 1) {
    throw codedError("EXPECTED_OCCURRENCES_SINGLE_ONLY", "replaceAll=false 时 expectedOccurrences 只能为 1。");
  }
  const expectedOccurrences = replaceAll ? suppliedExpectedOccurrences : 1;
  const totalOccurrenceOffsets = findOccurrences(sourceText, previousText);
  const occurrenceOffsets = totalOccurrenceOffsets.filter((offset) => {
    if (contextBefore !== null) {
      const start = offset - contextBefore.length;
      if (start < 0 || sourceText.slice(start, offset) !== contextBefore) return false;
    }
    if (contextAfter !== null) {
      const start = offset + previousText.length;
      if (sourceText.slice(start, start + contextAfter.length) !== contextAfter) return false;
    }
    return true;
  });
  const selector = selectorBinding(previousText, contextBefore, contextAfter);
  const offsetBinding = {
    selectorSha256: selector.selectorSha256,
    sourceTextSha256: sha256(sourceText),
    occurrenceOffsets,
  };
  const evidence = {
    ...selector,
    anchored: selector.mode === "adjacent-context",
    sourceTextSha256: offsetBinding.sourceTextSha256,
    totalOccurrenceCount: totalOccurrenceOffsets.length,
    occurrenceCount: occurrenceOffsets.length,
    expectedOccurrences,
    firstOccurrenceOffset: occurrenceOffsets.length > 0 ? occurrenceOffsets[0] : null,
    lastOccurrenceOffset: occurrenceOffsets.length > 0 ? occurrenceOffsets[occurrenceOffsets.length - 1] : null,
    occurrenceOffsetsSha256: sha256(JSON.stringify(occurrenceOffsets)),
    locationBindingSha256: sha256(JSON.stringify(offsetBinding)),
  };
  return {
    sourceText,
    previousText,
    contextBefore,
    contextAfter,
    replaceAll,
    expectedOccurrences,
    totalOccurrenceCount: totalOccurrenceOffsets.length,
    totalOccurrenceOffsets,
    occurrenceCount: occurrenceOffsets.length,
    occurrenceOffsets,
    occurrenceApplicable: occurrenceOffsets.length === expectedOccurrences,
    evidence,
  };
}

function occurrenceMismatch(analysis) {
  if (analysis.occurrenceApplicable) return null;
  return codedError(
    "OCCURRENCE_COUNT_MISMATCH",
    analysis.evidence.anchored
      ? `上下文锚定后的原文命中数量与预期不一致：预计 ${analysis.expectedOccurrences} 次，实际 ${analysis.occurrenceCount} 次（全文原文共 ${analysis.totalOccurrenceCount} 次）。`
      : `原文命中数量与预期不一致：预计 ${analysis.expectedOccurrences} 次，实际 ${analysis.occurrenceCount} 次。`,
    {
      expectedOccurrences: analysis.expectedOccurrences,
      actualOccurrences: analysis.occurrenceCount,
      totalOccurrences: analysis.totalOccurrenceCount,
      contextAnchored: analysis.evidence.anchored,
      selectorSha256: analysis.evidence.selectorSha256,
    },
  );
}

function replaceAtOffsets(sourceText, previousText, newText, offsets) {
  const source = String(sourceText ?? "");
  const target = String(previousText ?? "");
  const replacement = String(newText ?? "");
  let cursor = 0;
  const parts = [];
  for (const offset of offsets) {
    if (!Number.isSafeInteger(offset) || offset < cursor || source.slice(offset, offset + target.length) !== target) {
      throw codedError("CONTEXT_ANCHOR_OFFSET_INVALID", "上下文锚定位置与当前原文不一致，已停止替换。", { offset });
    }
    parts.push(source.slice(cursor, offset), replacement);
    cursor = offset + target.length;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function applyContextAnchoredReplacement(input = {}, analysis = null) {
  const resolved = analysis || analyzeContextAnchoredReplacement(input);
  const mismatch = occurrenceMismatch(resolved);
  if (mismatch) throw mismatch;
  return replaceAtOffsets(
    resolved.sourceText,
    resolved.previousText,
    String(input.newText ?? ""),
    resolved.occurrenceOffsets,
  );
}

module.exports = {
  analyzeContextAnchoredReplacement,
  applyContextAnchoredReplacement,
  findOccurrences,
  occurrenceMismatch,
  replaceAtOffsets,
  selectorBinding,
};
