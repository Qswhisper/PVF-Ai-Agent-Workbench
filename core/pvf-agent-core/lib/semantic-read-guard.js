"use strict";

const path = require("path");

const CN_SEMANTIC_SEARCH_TYPES = new Set(["searchscript", "searchstrings"]);

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
  return /<\s*\d+\s*::[^>\r\n`]{1,512}`[^>\r\n`]*`>/.test(value);
}

function retryReadReason(file, options = {}, fallbackEncoding = "Tw") {
  if (!isCnEncoding(options.pvfEncoding, fallbackEncoding)) return null;
  if (options.decompileScript === false) return null;
  if (containsStringLinkToken(file && file.textContent)) return "cn-stringlink-detected";
  if (file?.isScriptFile === true && containsNonAscii(file.textContent)) return "cn-nonascii-script-detected";
  return null;
}

function guardDetails(reason) {
  return {
    applied: true,
    reason,
    backend: "typescript-readonly-fallback",
    automatic: true,
  };
}

function containsNonAscii(value) {
  return typeof value === "string" && /[^\x00-\x7f]/.test(value);
}

function semanticWriteSafety(input = {}) {
  const pvfPath = String(input.pvfPath || "").replace(/\\/g, "/");
  const extension = path.posix.extname(pvfPath.toLowerCase());
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

  if (encoding === "Cn" && extension === ".str") {
    return {
      allowed: false,
      code: "CN_LOCALIZATION_WRITE_UNVERIFIED",
      reason: "已阻止 Cn .str 写入：当前 native 写出无法保持中文编码。",
      clientTextSmokeCheckRequired: true,
      noOp: false,
    };
  }
  if (payloads.some(containsNonAscii)) {
    return {
      allowed: false,
      code: "NON_ASCII_TEXT_WRITE_UNVERIFIED",
      reason: "已阻止直接非 ASCII 文本写入；当前仅放行数字或 ASCII 最小修改。",
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
  containsNonAscii,
  containsStringLinkToken,
  directReadReason,
  directSearchReason,
  guardDetails,
  isCnEncoding,
  normalizeEncoding,
  retryReadReason,
  retrySearchReason,
  semanticWriteSafety,
};
