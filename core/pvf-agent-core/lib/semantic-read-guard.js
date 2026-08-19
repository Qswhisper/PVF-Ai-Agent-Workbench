"use strict";

const path = require("path");
const {
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  analyzeVerifiedInlineTextChange,
  isVerifiedInlineTextMode,
} = require("../../../tools/pvf-bridge/verified-inline-cn-text");
const {
  compareChineseEncodingCandidates,
} = require("../../../tools/pvf-bridge/fallback/codec.ts");
const {
  HIGH_RISK_NEW_FILE_MODES,
  PROTECTED_EXISTING_FILE_EXTENSIONS,
  extensionOf,
  validateNewFileText,
  validateWriteProofShape,
} = require("./high-risk-write-audit");

const CN_SEMANTIC_SEARCH_TYPES = new Set(["searchname", "searchscript", "searchstrings"]);
const PROTECTED_NEW_FILE_EXTENSIONS = new Set(Object.keys(HIGH_RISK_NEW_FILE_MODES));

function automaticChineseNameSearchPlan(query = {}, fallbackEncoding = "Cn") {
  if (query.encodingExplicit === true) return null;
  if (String(query.searchType || "SearchName").trim().toLowerCase() !== "searchname") return null;
  if (!containsNonAscii(String(query.keyword || ""))) return null;
  const requestedEncoding = normalizeEncoding(query.pvfEncoding, fallbackEncoding);
  if (!new Set(["Cn", "Tw"]).has(requestedEncoding)) return null;
  return {
    automatic: true,
    purpose: "read-only-name-search",
    requestedEncoding,
    alternateEncoding: requestedEncoding === "Cn" ? "Tw" : "Cn",
    checkedEncodings: requestedEncoding === "Cn" ? ["Cn", "Tw"] : ["Tw", "Cn"],
    safeForWriteEncodingSelection: false,
  };
}

function normalizeEncoding(value, fallback = "Tw") {
  const raw = String(value || fallback).trim().toLowerCase();
  const aliases = new Map([
    ["cn", "Cn"],
    ["gbk", "Cn"],
    ["gb18030", "Cn"],
    ["cp936", "Cn"],
    ["tw", "Tw"],
    ["big5", "Tw"],
    ["cp950", "Tw"],
    ["kr", "Kr"],
    ["jp", "Jp"],
    ["utf8", "Utf8"],
    ["utf-8", "Utf8"],
    ["unicode", "Unicode"],
  ]);
  return aliases.get(raw) || String(value || fallback);
}

function isCnEncoding(value, fallback) {
  return normalizeEncoding(value, fallback) === "Cn";
}

function directReadReason(pvfPath, options = {}, fallbackEncoding = "Tw") {
  if (options.semanticVerificationRead === true) return "verified-text-readback";
  if (!isCnEncoding(options.pvfEncoding, fallbackEncoding)) return null;
  const extension = path.posix.extname(String(pvfPath || "").replace(/\\/g, "/").toLowerCase());
  if (extension === ".str") return "cn-localization-file";
  if (options.decompileScript !== false && options.autoConvertStringLink === true) {
    return "cn-stringlink-conversion";
  }
  return null;
}

function directSearchReason(query = {}, fallbackEncoding = "Tw") {
  if (!isCnEncoding(query.pvfEncoding, fallbackEncoding)) return null;
  return CN_SEMANTIC_SEARCH_TYPES.has(String(query.searchType || "").trim().toLowerCase()) && containsNonAscii(String(query.keyword || ""))
    ? "cn-semantic-search"
    : null;
}

function retrySearchReason(result, query = {}, fallbackEncoding = "Tw") {
  if (!isCnEncoding(query.pvfEncoding, fallbackEncoding)) return null;
  if (!CN_SEMANTIC_SEARCH_TYPES.has(String(query.searchType || "").trim().toLowerCase())) return null;
  const items = Array.isArray(result?.items) ? result.items : [];
  return items.some((item) => containsNonAscii(String(item?.preview || "")) || containsStringLinkToken(String(item?.preview || "")))
    ? "cn-nonascii-search-preview-detected"
    : null;
}

function containsStringLinkToken(value) {
  if (typeof value !== "string" || !value.includes("::") || !value.includes("`")) return false;
  return /<\s*\d+\s*::[^>`]{1,512}`[^`]*`>/u.test(value);
}

function retryReadReason(file, options = {}, fallbackEncoding = "Tw") {
  if (!isCnEncoding(options.pvfEncoding, fallbackEncoding)) return null;
  if (options.decompileScript === false) return null;
  if (containsStringLinkToken(file && file.textContent)) return "cn-stringlink-detected";
  if (file?.isScriptFile === true && containsNonAscii(file.textContent)) return "cn-nonascii-script-detected";
  return null;
}

function guardDetails(reason, details = {}) {
  return {
    applied: true,
    reason,
    backend: details.backend || "typescript-readonly-fallback",
    automatic: true,
    ...details,
  };
}

function compactEncodingComparison(comparison) {
  return {
    requestedScore: comparison.requested?.score ?? null,
    alternateScore: comparison.alternate?.score ?? null,
    requestedReasons: comparison.requested?.reasons || [],
    alternateReasons: comparison.alternate?.reasons || [],
    preferredEncoding: comparison.preferredEncoding || null,
  };
}

function chooseSemanticReadCandidate(nativeFile, fallbackFile, options = {}, sessionEncoding = "Tw", reason = "") {
  const requestedEncoding = normalizeEncoding(options.pvfEncoding, sessionEncoding);
  const normalizedSessionEncoding = normalizeEncoding(sessionEncoding, "Tw");
  if (
    requestedEncoding === normalizedSessionEncoding ||
    typeof nativeFile?.textContent !== "string" ||
    typeof fallbackFile?.textContent !== "string"
  ) {
    return {
      file: fallbackFile,
      semanticReadGuard: guardDetails(reason, {
        requestedEncoding,
        selectedEncoding: requestedEncoding,
      }),
    };
  }
  const comparison = compareChineseEncodingCandidates(
    fallbackFile.textContent,
    nativeFile.textContent,
    requestedEncoding,
    normalizedSessionEncoding,
  );
  if (comparison.requestedLooksMojibake === true) {
    return {
      file: nativeFile,
      semanticReadGuard: guardDetails("text-encoding-mismatch-session-preferred", {
        backend: "native-session",
        requestedEncoding,
        selectedEncoding: normalizedSessionEncoding,
        originalGuardReason: reason,
        encodingConflict: true,
        warning: `按 ${requestedEncoding} 复核时出现明显乱码特征，已保留按 ${normalizedSessionEncoding} 正常读取的文本。修改文字前必须明确使用 ${normalizedSessionEncoding}。`,
        encodingEvidence: compactEncodingComparison(comparison),
      }),
    };
  }
  return {
    file: fallbackFile,
    semanticReadGuard: guardDetails(reason, {
      requestedEncoding,
      selectedEncoding: requestedEncoding,
      encodingConflict: comparison.different === true,
    }),
  };
}

function containsNonAscii(value) {
  return typeof value === "string" && /[^\x00-\x7f]/.test(value);
}

function containsHtmlNumericEntity(value) {
  return typeof value === "string" && /&#(?:\d+|x[0-9a-f]+);/i.test(value);
}

function semanticWriteSafety(input = {}) {
  const pvfPath = String(input.pvfPath || "").replace(/\\/g, "/");
  const extension = extensionOf(pvfPath) || path.posix.extname(pvfPath.toLowerCase());
  const encoding = normalizeEncoding(input.pvfEncoding, input.fallbackEncoding || "Tw");
  const sourceText = String(input.sourceText || "");
  const payloads = input.kind === "write-file"
    ? [String(input.textContent || "")]
    : [String(input.previousText || ""), String(input.newText || "")];
  const clientTextSmokeCheckRequired =
    extension === ".str" ||
    containsStringLinkToken(sourceText) ||
    containsNonAscii(sourceText) ||
    payloads.some(containsNonAscii);

  if (input.kind !== "write-file" && String(input.previousText || "") === String(input.newText || "")) {
    return {
      allowed: true,
      code: null,
      reason: "No-op replacement; no PVF text write is required.",
      clientTextSmokeCheckRequired: false,
      noOp: true,
    };
  }

  const newWritePayload = input.kind === "write-file" ? String(input.textContent || "") : String(input.newText || "");
  if (containsHtmlNumericEntity(newWritePayload)) {
    return {
      allowed: false,
      code: "HTML_NUMERIC_ENTITY_WRITE_BLOCKED",
      reason: "已阻止 HTML 数字实体写入 PVF；请从目标原始文本取得真实字符，不要写入 &#数字;。",
      clientTextSmokeCheckRequired: true,
      noOp: false,
    };
  }

  const proofShape = input.kind === "write-file" && PROTECTED_NEW_FILE_EXTENSIONS.has(extension)
    ? validateWriteProofShape(pvfPath, input.writeProof)
    : null;
  if (encoding === "Cn" && extension === ".str" && !(input.kind === "write-file" && proofShape?.ok === true && input.writeProof?.encodingRoundTripRequired === true)) {
    return {
      allowed: false,
      code: "CN_LOCALIZATION_WRITE_UNVERIFIED",
      reason: "已阻止 Cn .str 写入：当前 native 写出无法保持中文编码。",
      clientTextSmokeCheckRequired: true,
      noOp: false,
    };
  }
  if (input.kind === "write-file" && PROTECTED_NEW_FILE_EXTENSIONS.has(extension)) {
    const sourceValidation = validateNewFileText(pvfPath, input.textContent, input.writeProof || {});
    if (!proofShape?.ok || !sourceValidation.ok) {
      const reason = extension === ".wdm"
        ? "已阻止新增 .wdm：必须先完成 worldmap.lst 登记以及 .ui、城镇/区域入口配套核验。"
        : `已阻止新增高风险文件类型 ${extension}；必须提供匹配的受控证据、格式检查和独立读回证明。`;
      return {
        allowed: false,
        code: "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
        reason,
        details: {
          expectedMode: proofShape?.expectedMode || HIGH_RISK_NEW_FILE_MODES[extension],
          proofErrors: proofShape?.errors || [],
          sourceErrors: sourceValidation.errors || [],
        },
        clientTextSmokeCheckRequired: true,
        noOp: false,
      };
    }
    if (containsNonAscii(newWritePayload) && input.writeProof?.encodingRoundTripRequired !== true) {
      return {
        allowed: false,
        code: "HIGH_RISK_ENCODING_PROOF_REQUIRED",
        reason: `新增 ${extension} 含非 ASCII 文本，必须声明并通过独立编码往返验证。`,
        clientTextSmokeCheckRequired: true,
        noOp: false,
      };
    }
    return {
      allowed: true,
      code: null,
      reason: "新增高风险文件已提交匹配的受控证据；仍需目标 PVF 闭合、脚本结构、临时写出/编码往返和最终读回。",
      details: { expectedMode: proofShape.expectedMode, sourceValidation },
      clientTextSmokeCheckRequired: true,
      noOp: false,
    };
  }
  if (input.kind !== "write-file" && PROTECTED_EXISTING_FILE_EXTENSIONS.has(extension)) {
    const registryEdit = extension === ".lst" &&
      input.writeProof?.mode === "registry-lifecycle" &&
      input.writeProof?.allowExistingRegistryEdit === true &&
      input.writeProof?.registry?.action === "add" &&
      Number.isSafeInteger(input.writeProof?.registry?.id) &&
      input.writeProof.registry.id >= 0 &&
      typeof input.writeProof?.registry?.expectedPvfPath === "string" &&
      input.writeProof.registry.expectedPvfPath.trim().length > 0 &&
      String(input.writeProof?.registry?.lstPath || "").replace(/\\/g, "/").toLowerCase() === pvfPath.toLowerCase();
    if (!registryEdit) {
      return {
        allowed: false,
        code: "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
        reason: `已保持既有高风险文件保护：${extension} 只能通过专用登记表生命周期或新增文件受控流程处理。`,
        clientTextSmokeCheckRequired: true,
        noOp: false,
      };
    }
    if (containsNonAscii(newWritePayload) || containsNonAscii(String(input.previousText || ""))) {
      return {
        allowed: false,
        code: "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
        reason: "登记表生命周期只允许数字、英文、Tab 和常见符号的精确新增行；中文或脚本逻辑修改仍被阻止。",
        clientTextSmokeCheckRequired: true,
        noOp: false,
      };
    }
    return {
      allowed: true,
      code: null,
      reason: "登记表生命周期证据已提交；仍需目标 registry 冲突、引用闭合和最终读回检查。",
      clientTextSmokeCheckRequired: true,
      noOp: false,
    };
  }
  if (input.kind !== "write-file" && isVerifiedInlineTextMode(input.textWriteMode)) {
    try {
      const analysis = analyzeVerifiedInlineTextChange({
        ...input,
        pvfPath,
        pvfEncoding: encoding,
      });
      return {
        allowed: true,
        code: null,
        reason: "中文内联文本结构检查通过；仍需临时输出往返验证和客户端文字检查。",
        clientTextSmokeCheckRequired: analysis.clientTextSmokeCheckRequired,
        noOp: analysis.noOp,
        verifiedInlineTextWrite: {
          mode: analysis.mode,
          encoding: analysis.encoding,
          parentTag: analysis.parentTag,
          parentTags: analysis.parentTags,
          occurrenceCount: analysis.occurrenceCount,
          scopedOccurrenceCount: analysis.scopedOccurrenceCount,
          totalOccurrenceCount: analysis.totalOccurrenceCount,
          expectedOccurrences: analysis.expectedOccurrences,
          contextAnchor: analysis.contextAnchor,
          previousCharacterCount: analysis.previousCharacterCount,
          newCharacterCount: analysis.newCharacterCount,
          encodedNewValueSha256: analysis.encodedNewValueSha256,
          requiresEncodingRoundTripProbe: analysis.requiresEncodingRoundTripProbe,
        },
      };
    } catch (error) {
      return {
        allowed: false,
        code: error.code || "CN_TEXT_VERIFICATION_FAILED",
        reason: error.message,
        details: error.details || null,
        clientTextSmokeCheckRequired: true,
        noOp: false,
      };
    }
  }
  if (payloads.some(containsNonAscii)) {
    return {
      allowed: false,
      code: "NON_ASCII_TEXT_WRITE_UNVERIFIED",
      reason: "直接中文文本必须使用已验证的内联文本模式；未验证写入仍被阻止。",
      clientTextSmokeCheckRequired: true,
      noOp: false,
    };
  }
  return {
    allowed: true,
    code: null,
    reason: null,
    clientTextSmokeCheckRequired,
    noOp: false,
  };
}

module.exports = {
  automaticChineseNameSearchPlan,
  containsNonAscii,
  containsHtmlNumericEntity,
  containsStringLinkToken,
  chooseSemanticReadCandidate,
  directReadReason,
  directSearchReason,
  guardDetails,
  isCnEncoding,
  normalizeEncoding,
  retryReadReason,
  retrySearchReason,
  semanticWriteSafety,
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  isVerifiedInlineTextMode,
};
