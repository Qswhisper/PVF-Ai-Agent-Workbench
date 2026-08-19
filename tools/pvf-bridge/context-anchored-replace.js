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

function normalizeExactScope(input) {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw codedError("SCOPE_INVALID", "scope 提供后必须是精确区间对象。", { field: "scope" });
  }
  const supportedFields = new Set(["startText", "endText", "expectedRanges"]);
  const unsupportedFields = Object.keys(input).filter((key) => !supportedFields.has(key));
  if (unsupportedFields.length > 0) {
    throw codedError(
      "SCOPE_FIELD_UNSUPPORTED",
      `scope 包含不支持的字段：${unsupportedFields.join(", ")}。`,
      { unsupportedFields },
    );
  }
  for (const field of ["startText", "endText"]) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw codedError("SCOPE_BOUNDARY_REQUIRED", `scope.${field} 必须是非空的精确原文。`, { field });
    }
  }
  if (!Number.isSafeInteger(input.expectedRanges) || input.expectedRanges < 1) {
    throw codedError("SCOPE_EXPECTED_RANGES_REQUIRED", "scope.expectedRanges 必须是正整数。", {
      expectedRanges: input.expectedRanges,
    });
  }
  if (input.startText === input.endText) {
    throw codedError("SCOPE_BOUNDARIES_AMBIGUOUS", "scope.startText 与 scope.endText 不能完全相同。");
  }
  return {
    startText: input.startText,
    endText: input.endText,
    expectedRanges: input.expectedRanges,
  };
}

function resolveExactScopeRanges(sourceText, scopeInput) {
  const source = String(sourceText ?? "");
  const scope = normalizeExactScope(scopeInput);
  if (!scope) return null;
  const startOffsets = findOccurrences(source, scope.startText);
  if (startOffsets.length !== scope.expectedRanges) {
    throw codedError(
      "SCOPE_RANGE_COUNT_MISMATCH",
      `精确区间开始标记数量与声明不一致：预计 ${scope.expectedRanges} 个，实际 ${startOffsets.length} 个。`,
      {
        expectedRanges: scope.expectedRanges,
        actualStartMarkers: startOffsets.length,
        totalEndMarkers: findOccurrences(source, scope.endText).length,
      },
    );
  }

  const ranges = [];
  let previousEndOffset = -1;
  for (let index = 0; index < startOffsets.length; index += 1) {
    const startOffset = startOffsets[index];
    const contentStartOffset = startOffset + scope.startText.length;
    const nextStartOffset = startOffsets[index + 1] ?? null;
    const endTextOffset = source.indexOf(scope.endText, contentStartOffset);
    if (endTextOffset < 0) {
      throw codedError(
        "SCOPE_END_NOT_FOUND",
        `精确区间 ${index + 1} 缺少对应的结束标记。`,
        { rangeIndex: index, startOffset },
      );
    }
    if (nextStartOffset !== null && nextStartOffset < endTextOffset + scope.endText.length) {
      throw codedError(
        "SCOPE_RANGE_OVERLAP",
        "精确区间出现嵌套或重叠；请使用能够唯一划分非重叠块的开始和结束原文。",
        { rangeIndex: index, startOffset, nextStartOffset, endTextOffset },
      );
    }
    const endOffset = endTextOffset + scope.endText.length;
    if (startOffset < previousEndOffset) {
      throw codedError(
        "SCOPE_RANGE_OVERLAP",
        "精确区间出现重叠；已停止匹配。",
        { rangeIndex: index, startOffset, previousEndOffset },
      );
    }
    const content = source.slice(contentStartOffset, endTextOffset);
    const rangeText = source.slice(startOffset, endOffset);
    ranges.push({
      index,
      startOffset,
      contentStartOffset,
      endTextOffset,
      endOffset,
      contentLength: content.length,
      contentSha256: sha256(content),
      rangeTextLength: rangeText.length,
      rangeTextSha256: sha256(rangeText),
    });
    previousEndOffset = endOffset;
  }

  const selector = {
    schemaVersion: "1.0",
    startTextSha256: sha256(scope.startText),
    endTextSha256: sha256(scope.endText),
    startTextLength: scope.startText.length,
    endTextLength: scope.endText.length,
    expectedRanges: scope.expectedRanges,
  };
  const rangeBinding = {
    selector,
    sourceTextSha256: sha256(source),
    ranges,
  };
  return {
    scope,
    ranges,
    evidence: {
      ...selector,
      rangeCount: ranges.length,
      firstRangeStartOffset: ranges[0]?.startOffset ?? null,
      lastRangeEndOffset: ranges[ranges.length - 1]?.endOffset ?? null,
      ranges,
      rangesSha256: sha256(JSON.stringify(ranges)),
      rangeBindingSha256: sha256(JSON.stringify(rangeBinding)),
    },
  };
}

function selectorBinding(previousText, contextBefore, contextAfter, scopeEvidence = null) {
  const contextAnchored = contextBefore !== null || contextAfter !== null;
  const payload = {
    schemaVersion: "1.0",
    mode: scopeEvidence
      ? (contextAnchored ? "exact-scope-adjacent-context" : "exact-scope")
      : (contextAnchored ? "adjacent-context" : "exact-text"),
    previousTextSha256: sha256(previousText),
    contextBeforeSha256: contextBefore === null ? null : sha256(contextBefore),
    contextAfterSha256: contextAfter === null ? null : sha256(contextAfter),
    previousTextLength: previousText.length,
    contextBeforeLength: contextBefore === null ? 0 : contextBefore.length,
    contextAfterLength: contextAfter === null ? 0 : contextAfter.length,
  };
  if (scopeEvidence) {
    payload.scopeSelector = {
      schemaVersion: scopeEvidence.schemaVersion,
      startTextSha256: scopeEvidence.startTextSha256,
      endTextSha256: scopeEvidence.endTextSha256,
      startTextLength: scopeEvidence.startTextLength,
      endTextLength: scopeEvidence.endTextLength,
      expectedRanges: scopeEvidence.expectedRanges,
    };
  }
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
  const resolvedScope = resolveExactScopeRanges(sourceText, input.scope);
  if (
    resolvedScope &&
    (String(input.newText ?? "").includes(resolvedScope.scope.startText) ||
      String(input.newText ?? "").includes(resolvedScope.scope.endText))
  ) {
    throw codedError(
      "SCOPE_MARKER_INJECTION_BLOCKED",
      "newText 不得注入精确区间的开始或结束标记。",
      {
        injectsStartText: String(input.newText ?? "").includes(resolvedScope.scope.startText),
        injectsEndText: String(input.newText ?? "").includes(resolvedScope.scope.endText),
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
  const scopedOccurrences = [];
  for (const offset of totalOccurrenceOffsets) {
    const targetEndOffset = offset + previousText.length;
    if (!resolvedScope) {
      scopedOccurrences.push({ offset, range: null });
      continue;
    }
    const containingRange = resolvedScope.ranges.find((range) =>
      offset >= range.contentStartOffset && targetEndOffset <= range.endTextOffset);
    if (containingRange) {
      scopedOccurrences.push({ offset, range: containingRange });
      continue;
    }
    const boundaryRange = resolvedScope.ranges.find((range) =>
      offset < range.endOffset && targetEndOffset > range.startOffset);
    if (boundaryRange) {
      throw codedError(
        "SCOPE_TARGET_OUT_OF_BOUNDS",
        "previousText 触及精确区间边界；区间开始和结束标记禁止被改写。",
        { offset, targetEndOffset, rangeIndex: boundaryRange.index },
      );
    }
  }
  const occurrenceOffsets = scopedOccurrences.filter(({ offset, range }) => {
    if (range && contextBefore !== null && offset - contextBefore.length < range.contentStartOffset) {
      const contextStart = offset - contextBefore.length;
      if (contextStart >= 0 && sourceText.slice(contextStart, offset) === contextBefore) {
        throw codedError(
          "SCOPE_CONTEXT_OUT_OF_BOUNDS",
          "contextBefore 越过精确区间边界；请缩短为区间内部的相邻原文。",
          { offset, rangeIndex: range.index },
        );
      }
      return false;
    }
    if (range && contextAfter !== null && offset + previousText.length + contextAfter.length > range.endTextOffset) {
      const contextStart = offset + previousText.length;
      if (sourceText.slice(contextStart, contextStart + contextAfter.length) === contextAfter) {
        throw codedError(
          "SCOPE_CONTEXT_OUT_OF_BOUNDS",
          "contextAfter 越过精确区间边界；请缩短为区间内部的相邻原文。",
          { offset, rangeIndex: range.index },
        );
      }
      return false;
    }
    if (contextBefore !== null) {
      const start = offset - contextBefore.length;
      if (start < 0 || sourceText.slice(start, offset) !== contextBefore) return false;
    }
    if (contextAfter !== null) {
      const start = offset + previousText.length;
      if (sourceText.slice(start, start + contextAfter.length) !== contextAfter) return false;
    }
    return true;
  }).map((item) => item.offset);
  const selector = selectorBinding(previousText, contextBefore, contextAfter, resolvedScope?.evidence || null);
  const offsetBinding = {
    selectorSha256: selector.selectorSha256,
    sourceTextSha256: sha256(sourceText),
    occurrenceOffsets,
  };
  if (resolvedScope) offsetBinding.scopeRangeBindingSha256 = resolvedScope.evidence.rangeBindingSha256;
  const evidence = {
    ...selector,
    anchored: contextBefore !== null || contextAfter !== null,
    scopeApplied: Boolean(resolvedScope),
    sourceTextSha256: offsetBinding.sourceTextSha256,
    totalOccurrenceCount: totalOccurrenceOffsets.length,
    scopedOccurrenceCount: scopedOccurrences.length,
    occurrenceCount: occurrenceOffsets.length,
    expectedOccurrences,
    firstOccurrenceOffset: occurrenceOffsets.length > 0 ? occurrenceOffsets[0] : null,
    lastOccurrenceOffset: occurrenceOffsets.length > 0 ? occurrenceOffsets[occurrenceOffsets.length - 1] : null,
    occurrenceOffsetsSha256: sha256(JSON.stringify(occurrenceOffsets)),
    locationBindingSha256: sha256(JSON.stringify(offsetBinding)),
  };
  if (resolvedScope) evidence.scope = resolvedScope.evidence;
  return {
    sourceText,
    previousText,
    contextBefore,
    contextAfter,
    scope: resolvedScope?.scope || null,
    scopeRanges: resolvedScope?.ranges || [],
    replaceAll,
    expectedOccurrences,
    totalOccurrenceCount: totalOccurrenceOffsets.length,
    totalOccurrenceOffsets,
    scopedOccurrenceCount: scopedOccurrences.length,
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
    analysis.evidence.scopeApplied
      ? `精确区间内的原文命中数量与预期不一致：预计 ${analysis.expectedOccurrences} 次，实际 ${analysis.occurrenceCount} 次（区间内原文共 ${analysis.scopedOccurrenceCount} 次，全文共 ${analysis.totalOccurrenceCount} 次）。`
      : analysis.evidence.anchored
      ? `上下文锚定后的原文命中数量与预期不一致：预计 ${analysis.expectedOccurrences} 次，实际 ${analysis.occurrenceCount} 次（全文原文共 ${analysis.totalOccurrenceCount} 次）。`
      : `原文命中数量与预期不一致：预计 ${analysis.expectedOccurrences} 次，实际 ${analysis.occurrenceCount} 次。`,
    {
      expectedOccurrences: analysis.expectedOccurrences,
      actualOccurrences: analysis.occurrenceCount,
      scopedOccurrences: analysis.scopedOccurrenceCount,
      totalOccurrences: analysis.totalOccurrenceCount,
      contextAnchored: analysis.evidence.anchored,
      scopeApplied: analysis.evidence.scopeApplied,
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
  normalizeExactScope,
  occurrenceMismatch,
  replaceAtOffsets,
  resolveExactScopeRanges,
  selectorBinding,
};
