"use strict";

const crypto = require("crypto");
const { lexDecompiledScript } = require("./script-text-lexer");
const { inspectStaticEventAppend } = require("../../core/pvf-agent-core/lib/event-intro-text");
const path = require("path");
const {
  compareChineseEncodingCandidates,
  decodeText,
  normalizeEncoding,
} = require("./fallback/codec.ts");
const { inspectBinaryAni } = require("./fallback/ani.ts");
const { StringTable, parseTokens } = require("./fallback/script.ts");
const {
  analyzeContextAnchoredReplacement,
  applyContextAnchoredReplacement,
  occurrenceMismatch,
} = require("./context-anchored-replace");
const {
  ALLOWED_INLINE_TEXT_EXTENSIONS,
  ALLOWED_VISIBLE_TEXT_TAGS,
  VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
  VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
  classifyVisibleTextOccurrence,
  directBacktickTokenValue: directBacktickValue,
} = require("../../core/pvf-agent-core/lib/verified-text-eligibility");

const VERIFIED_INLINE_TEXT_MODE = "verified-inline-text";
const VERIFIED_INLINE_CN_TEXT_MODE = "verified-inline-cn";
const VERIFIED_STRINGLINK_DETACH_MODE = "verified-stringlink-detach";
const VERIFIED_INLINE_TEXT_MODES = new Set([
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  VERIFIED_STRINGLINK_DETACH_MODE,
  "verified-scalar-text",
]);
const TITLEBOOK_SECTION_NAME_RULE_ID = "titlebook-section-name-visible-text";
const QST_CONDITION_DATA_PROGRESS_RULE_ID = "qst-condition-data-progress-message";
const STRUCTURED_VISIBLE_TEXT_RULE_IDS = new Set([
  "event-list-paired-intro-text",
  "dgn-tower-dialog-visible-message",
  TITLEBOOK_SECTION_NAME_RULE_ID,
  QST_CONDITION_DATA_PROGRESS_RULE_ID,
]);
const SINGLE_LINE_VISIBLE_TEXT_RULE_IDS = new Set([
  TITLEBOOK_SECTION_NAME_RULE_ID,
  QST_CONDITION_DATA_PROGRESS_RULE_ID,
]);
const TAG_INJECTION_BLOCKED_RULE_IDS = new Set([
  TITLEBOOK_SECTION_NAME_RULE_ID,
  QST_CONDITION_DATA_PROGRESS_RULE_ID,
]);
const SUPPORTED_INLINE_TEXT_ENCODINGS = new Set(["Cn", "Tw"]);
const RAW_BINARY_ANI_PATCH_MODE = "raw-ascii-binary-ani";
const MAX_INLINE_TEXT_CHARACTERS = 4000;
const MAX_STRING_TABLE_ENTRIES = 5_000_000;
const MAX_VERIFIED_TEXT_PROOF_BYTES_PER_CHANGE = 3800;
const RAW_TOKEN_PATCH_EXTENSIONS = new Set([
  ".act",
  ".ai",
  ".aic",
  ".atk",
  ".chr",
  ".cre",
  ".dgn",
  ".equ",
  ".etc",
  ".exp",
  ".job",
  ".key",
  ".map",
  ".mm",
  ".mob",
  ".msn",
  ".npc",
  ".obj",
  ".ptl",
  ".qst",
  ".rgn",
  ".set",
  ".shp",
  ".skl",
  ".stk",
  ".tbl",
  ".twn",
  ".ui",
  ".wdm",
]);
const legacyEncodeMaps = new Map();

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function containsNonAscii(value) {
  return /[^\x00-\x7f]/u.test(String(value || ""));
}

function eligibilityProofRouteMatches(expected, actual) {
  if (!expected || !actual) return false;
  return [
    "policyId",
    "policySha256",
    "ruleId",
    "ruleKind",
    "parentTag",
    "pvfPath",
    "extension",
    "baseTag",
    "suffix",
    "baseRuleId",
    "matchedPath",
    "floor",
    "event",
    "tokenOwnLine",
    "singleLineToken",
    "conditionDataInteger",
    "closingTag",
    "closedContainer",
    "placeholderOrderPreservedRequired",
    "semanticMeaningVerified", "runtimeValidationRequired",
    "role", "eventId", "eventGroup", "eventType", "eventCode", "eventTitle",
    "startDate", "endDate", "width", "pairedDescription",
  ].every((field) => (expected[field] ?? null) === (actual[field] ?? null));
}

function isInsideStringLinkToken(sourceText, tokenOffset, tokenLength) {
  const targetEnd = tokenOffset + tokenLength;
  const pattern = /<\s*\d+\s*::[^>`]{1,512}`[^`]*`>/gu;
  for (const match of String(sourceText || "").matchAll(pattern)) {
    const matchStart = match.index || 0;
    const matchEnd = matchStart + match[0].length;
    if (tokenOffset >= matchStart && targetEnd <= matchEnd) return true;
  }
  return false;
}

function printfPlaceholderSignature(value) {
  const pattern = /%(?!%)(?:\d+\$)?[-+#0 ]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[A-Za-z]/g;
  return [...String(value || "").matchAll(pattern)].map((match) => match[0]);
}

function assertVisibleTextRuleSpecificValueSafety(eligibilityProof, previousValue, newValue) {
  const ruleId = eligibilityProof?.ruleId || "";
  if (ruleId === "event-list-paired-intro-text" && /title$/u.test(eligibilityProof.role || "") && /[\r\n\[\]]/u.test(previousValue + newValue)) {
    throw codedError("CN_TEXT_SINGLE_LINE_TOKEN_REQUIRED", "活动标题必须是成对的单行普通文字。");
  }
  if (ruleId === "event-list-paired-intro-text" &&
      (!newValue.trim() || /https?:\/\/|[<>]/iu.test(newValue))) {
    throw codedError("CN_TEXT_EVENT_INTRO_PLAIN_TEXT_REQUIRED", "活动介绍只允许非空普通说明文字，不允许链接或标记。");
  }
  if (SINGLE_LINE_VISIBLE_TEXT_RULE_IDS.has(ruleId) && (/[\r\n]/u.test(previousValue) || /[\r\n]/u.test(newValue))) {
    throw codedError(
      "CN_TEXT_SINGLE_LINE_TOKEN_REQUIRED",
      "该结构化可见文字只允许单行完整反引号 token；多行文字仍保持阻断。",
      { ruleId },
    );
  }
  if (TAG_INJECTION_BLOCKED_RULE_IDS.has(ruleId) && /[\[\]]/u.test(`${previousValue}${newValue}`)) {
    throw codedError(
      "CN_TEXT_TAG_INJECTION_BLOCKED",
      "该结构化可见文字不得包含 PVF 标签括号，避免把显示文本写成结构注入。",
      { ruleId },
    );
  }
  if (ruleId === "explicit-scalar-text" || ruleId === QST_CONDITION_DATA_PROGRESS_RULE_ID || ruleId === "event-list-paired-intro-text") {
    const previousPlaceholders = printfPlaceholderSignature(previousValue);
    const newPlaceholders = printfPlaceholderSignature(newValue);
    if (JSON.stringify(previousPlaceholders) !== JSON.stringify(newPlaceholders)) {
      throw codedError(
        "CN_TEXT_PLACEHOLDER_SIGNATURE_CHANGED",
        "结构化可见文字必须保留原有占位符数量和顺序。",
        { ruleId, previousPlaceholders, newPlaceholders },
      );
    }
    return { previousPlaceholders, newPlaceholders };
  }
  return {};
}

function buildStructuredVisibleTextProof(eligibilityProof, parentTag, ruleSpecificProof = {}) {
  if (!STRUCTURED_VISIBLE_TEXT_RULE_IDS.has(eligibilityProof?.ruleId)) return null;
  return {
    ok: true,
    mode: eligibilityProof.mode,
    parentTag,
    pvfPath: eligibilityProof.pvfPath,
    ruleId: eligibilityProof.ruleId,
    policyId: eligibilityProof.policyId,
    policySha256: eligibilityProof.policySha256,
    ...(eligibilityProof.floor !== undefined ? { floor: eligibilityProof.floor } : {}),
    ...(eligibilityProof.event !== undefined ? { event: eligibilityProof.event } : {}),
    ...(eligibilityProof.matchedPath !== undefined ? { matchedPath: eligibilityProof.matchedPath } : {}),
    ...(eligibilityProof.tokenOwnLine !== undefined ? { tokenOwnLine: eligibilityProof.tokenOwnLine } : {}),
    ...(eligibilityProof.singleLineToken !== undefined ? { singleLineToken: eligibilityProof.singleLineToken } : {}),
    ...(eligibilityProof.conditionDataInteger !== undefined ? { conditionDataInteger: eligibilityProof.conditionDataInteger } : {}),
    ...(eligibilityProof.closingTag !== undefined ? { closingTag: eligibilityProof.closingTag } : {}),
    ...(eligibilityProof.closedContainer !== undefined ? { closedContainer: eligibilityProof.closedContainer } : {}),
    ...(eligibilityProof.placeholderOrderPreservedRequired !== undefined
      ? { placeholderOrderPreservedRequired: eligibilityProof.placeholderOrderPreservedRequired }
      : {}),
    ...(ruleSpecificProof.previousPlaceholders
      ? {
        placeholderSignature: ruleSpecificProof.previousPlaceholders,
        placeholderSignatureSha256: sha256(JSON.stringify(ruleSpecificProof.previousPlaceholders)),
      }
      : {}),
  };
}

function isVerifiedInlineTextMode(value) {
  return VERIFIED_INLINE_TEXT_MODES.has(String(value || ""));
}

function alternateChineseEncoding(encoding) {
  return encoding === "Cn" ? "Tw" : "Cn";
}

function compactEncodingComparison(comparison) {
  return {
    requestedEncoding: comparison.requestedEncoding,
    alternateEncoding: comparison.alternateEncoding,
    requestedScore: comparison.requested?.score ?? null,
    alternateScore: comparison.alternate?.score ?? null,
    requestedReasons: comparison.requested?.reasons || [],
    alternateReasons: comparison.alternate?.reasons || [],
    requestedLooksMojibake: comparison.requestedLooksMojibake === true,
    alternateLooksMojibake: comparison.alternateLooksMojibake === true,
    preferredEncoding: comparison.preferredEncoding || null,
  };
}

function buildLegacyEncodeMap(encoding) {
  const normalized = normalizeEncoding(encoding);
  if (!SUPPORTED_INLINE_TEXT_ENCODINGS.has(normalized)) {
    throw codedError("TEXT_ENCODING_UNSUPPORTED", `安全文字模式当前只支持简体（Cn）或繁体（Tw）编码，收到：${normalized}。`);
  }
  if (legacyEncodeMaps.has(normalized)) return legacyEncodeMaps.get(normalized);
  const decoder = new TextDecoder(normalized === "Cn" ? "gb18030" : "big5", { fatal: true });
  const map = new Map();
  for (let byte = 0x80; byte <= 0xff; byte += 1) {
    try {
      const decoded = decoder.decode(Uint8Array.of(byte));
      if ([...decoded].length === 1 && decoded !== "\uFFFD" && !map.has(decoded)) {
        map.set(decoded, Buffer.from([byte]));
      }
    } catch {
      // Most high bytes are lead bytes and are invalid by themselves.
    }
  }
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      try {
        const decoded = decoder.decode(Uint8Array.of(lead, trail));
        if ([...decoded].length === 1 && decoded !== "\uFFFD" && !map.has(decoded)) {
          map.set(decoded, Buffer.from([lead, trail]));
        }
      } catch {
        // Invalid two-byte sequences are deliberately skipped.
      }
    }
  }
  legacyEncodeMaps.set(normalized, map);
  return map;
}

function encodeLegacyText(value, encoding) {
  const text = String(value || "");
  const normalized = normalizeEncoding(encoding);
  const map = buildLegacyEncodeMap(normalized);
  const parts = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) {
      parts.push(Buffer.from([codePoint]));
      continue;
    }
    const encoded = map.get(character);
    if (!encoded) {
      throw codedError(
        "CN_TEXT_CHARACTER_UNENCODABLE",
        `目标文字包含 ${normalized} 编码不能无损保存的字符：${character}`,
        { character, encoding: normalized, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}` },
      );
    }
    parts.push(encoded);
  }
  const output = Buffer.concat(parts);
  if (decodeText(output, normalized, { trimNull: false }) !== text) {
    throw codedError("CN_TEXT_ENCODING_ROUNDTRIP_FAILED", `目标文字未通过 ${normalized} 编码往返检查。`);
  }
  return output;
}

function encodeGbkText(value) {
  return encodeLegacyText(value, "Cn");
}

function analyzeVerifiedInlineTextChange(input = {}) {
  const mode = String(input.textWriteMode || "");
  if (!isVerifiedInlineTextMode(mode)) {
    throw codedError("CN_TEXT_VERIFIED_MODE_REQUIRED", "直接中文修改必须使用已验证的内联文本模式。");
  }
  const pvfPath = String(input.pvfPath || "").replace(/\\/g, "/");
  const extension = path.posix.extname(pvfPath.toLowerCase());
  if (extension === ".str") {
    throw codedError("CN_LOCALIZATION_WRITE_UNVERIFIED", "既有共享 .str 编辑尚未实现；新增 .str 可使用 localization-new-file 路线。");
  }
  if (!ALLOWED_INLINE_TEXT_EXTENSIONS.has(extension)) {
    throw codedError("CN_TEXT_FILE_TYPE_UNSUPPORTED", `当前未开放 ${extension || "无扩展名"} 文件中的中文写入。`);
  }
  const encoding = normalizeEncoding(input.pvfEncoding, input.fallbackEncoding || "Tw");
  if (!SUPPORTED_INLINE_TEXT_ENCODINGS.has(encoding)) {
    throw codedError("TEXT_ENCODING_UNSUPPORTED", `安全文字模式当前只支持简体（Cn）或繁体（Tw）编码，收到：${encoding}。`);
  }
  const previousText = String(input.previousText || "");
  const newText = String(input.newText || "");
  const detach = mode === VERIFIED_STRINGLINK_DETACH_MODE;
  const link = /^<(\d+)::([^>`\r\n]{1,512})`([^`]*)`>$/u.exec(previousText);
  if (detach && (!link || extension !== ".stk" || input.replaceAll === true || !SUPPORTED_INLINE_TEXT_ENCODINGS.has(input.pvfEncoding))) {
    throw codedError("STRINGLINK_DETACH_SCOPE_INVALID", "显式解除引用仅支持.stk中一个完整StringLink，必须明确Cn/Tw编码。");
  }
  if ((!detach && /^<\s*\d+\s*::/u.test(previousText)) || /^<\s*\d+\s*::/u.test(newText)) {
    throw codedError("STRINGLINK_TEXT_WRITE_UNVERIFIED", "普通文字模式禁止StringLink；明确的.stk名称改名请走verified-stringlink-detach任务卡，共享文字表仍受保护。");
  }
  const previousValue = detach ? link[3] : directBacktickValue(previousText);
  const newValue = directBacktickValue(newText);
  if (previousValue === null || newValue === null) {
    throw codedError("CN_TEXT_TOKEN_REQUIRED", "中文修改必须替换一个完整的反引号文本，例如 `旧描述` → `新描述`。");
  }
  if (previousText === newText) {
    return {
      allowed: true,
      noOp: true,
      mode,
      encoding,
      eligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
      eligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
      eligibilityProofs: [],
      eligibilityProofsSha256: null,
      clientTextSmokeCheckRequired: false,
      requiresEncodingRoundTripProbe: false,
    };
  }
  if (previousValue.includes("\uFFFD") || newValue.includes("\uFFFD") || previousValue.includes("\0") || newValue.includes("\0")) {
    throw codedError("CN_TEXT_INVALID_CHARACTER", "中文文本包含替换字符或空字符，不能安全写入。");
  }
  if ([...newValue].length > MAX_INLINE_TEXT_CHARACTERS) {
    throw codedError("CN_TEXT_TOO_LONG", `中文文本超过安全上限：${MAX_INLINE_TEXT_CHARACTERS} 个字符。`);
  }
  const sourceText = String(input.sourceText || "");
  const anchored = analyzeContextAnchoredReplacement({
    sourceText,
    previousText,
    newText,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    scope: input.scope,
    occurrenceIndex: input.occurrenceIndex,
    replaceAll: input.replaceAll === true,
    expectedOccurrences: input.expectedOccurrences,
  });
  const mismatch = occurrenceMismatch(anchored);
  if (mismatch) throw mismatch;
  const occurrenceCount = anchored.occurrenceCount;
  const replaceAll = anchored.replaceAll;
  const requiredOccurrences = anchored.expectedOccurrences;
  const occurrences = [];
  for (let index = 0; index < occurrenceCount; index += 1) {
    const tokenOffset = anchored.occurrenceOffsets[index];
    if (!detach && isInsideStringLinkToken(sourceText, tokenOffset, previousText.length)) {
      throw codedError("STRINGLINK_TEXT_WRITE_UNVERIFIED", "普通文字模式禁止StringLink；明确的.stk名称改名请走verified-stringlink-detach任务卡，共享文字表仍受保护。");
    }
    const eligibility = classifyVisibleTextOccurrence({
      pvfPath,
      sourceText,
      tokenOffset,
      tokenLength: previousText.length,
      textWriteMode: mode,
    });
    const parentTag = eligibility.parentTag || null;
    if (eligibility.allowed !== true || !eligibility.proof) {
      throw codedError(
        "CN_TEXT_PARENT_TAG_UNSUPPORTED",
        `目标字段 ${parentTag ? `[${parentTag}]` : "无法识别"} 未命中当前文字路线；这不等于该字段危险。独立标量文字可按专用任务卡使用 verified-scalar-text，结构记录须使用对应路线。`,
        {
          parentTag,
          extension,
          occurrenceIndex: index,
          eligibilityPolicyId: eligibility.policyId || VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
          eligibilityPolicySha256: eligibility.policySha256 || VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
          eligibilityReason: eligibility.reason || "unregistered-structure",
          category: "unsupported-structure",
          recoveryTaskCard: "knowledge-pack/task-cards/pvf-scalar-text-controlled-change.zh-CN.md",
        },
      );
    }
    const eligibilityProof = eligibility.proof;
    if (eligibilityProof.ruleId === "event-list-paired-intro-text" &&
        !anchored.occurrenceOffsets.includes(eligibilityProof.pairedTokenOffset)) {
      throw codedError("CN_TEXT_EVENT_INTRO_PAIR_REQUIRED", "活动简介和弹窗正文必须在同一变化中同步替换。");
    }
    const ruleSpecificValueProof = assertVisibleTextRuleSpecificValueSafety(eligibilityProof, previousValue, newValue);
    const structuredContainerProof = buildStructuredVisibleTextProof(eligibilityProof, parentTag, ruleSpecificValueProof);
    const visibleTextFamilyProof = eligibilityProof.ruleId === "skl-visible-text-ex-variant"
      ? {
        ok: true,
        mode: eligibilityProof.mode,
        parentTag,
        baseTag: eligibilityProof.baseTag,
        suffix: eligibilityProof.suffix,
        baseRuleId: eligibilityProof.baseRuleId,
        pvfPath: eligibilityProof.pvfPath,
        ruleId: eligibilityProof.ruleId,
        policyId: eligibilityProof.policyId,
        policySha256: eligibilityProof.policySha256,
      }
      : null;
    occurrences.push({
      offset: tokenOffset,
      parentTag,
      eligibilityProof,
      structuredContainerProof,
      visibleTextFamilyProof,
    });
  }
  const parentTags = [...new Set(occurrences.map((item) => item.parentTag))];
  const eligibilityProofs = occurrences.map((item) => item.eligibilityProof);
  const structuredContainerProofs = occurrences
    .map((item) => item.structuredContainerProof)
    .filter((item) => item?.ok === true);
  const visibleTextFamilyProofs = occurrences
    .map((item) => item.visibleTextFamilyProof)
    .filter((item) => item?.ok === true);
  const encodedPreviousValue = encodeLegacyText(previousValue, encoding);
  const encodedNewValue = encodeLegacyText(newValue, encoding);
  return {
    allowed: true,
    noOp: false,
    mode,
    encoding,
    parentTag: parentTags[0],
    parentTags,
    replaceAll,
    expectedOccurrences: requiredOccurrences,
    occurrenceCount,
    occurrenceOffsets: occurrences.map((item) => item.offset),
    eligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
    eligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
    eligibilityProofs,
    eligibilityProofsSha256: sha256(JSON.stringify(eligibilityProofs)),
    structuredContainerProofs,
    structuredContainerProofsSha256: structuredContainerProofs.length > 0
      ? sha256(JSON.stringify(structuredContainerProofs))
      : null,
    visibleTextFamilyProofs,
    visibleTextFamilyProofsSha256: visibleTextFamilyProofs.length > 0
      ? sha256(JSON.stringify(visibleTextFamilyProofs))
      : null,
    totalOccurrenceCount: anchored.totalOccurrenceCount,
    scopedOccurrenceCount: anchored.scopedOccurrenceCount,
    contextAnchor: anchored.evidence,
    previousValue,
    stringLinkDetach: detach,
    newValue,
    previousCharacterCount: [...previousValue].length,
    newCharacterCount: [...newValue].length,
    encodedPreviousValueSha256: sha256(encodedPreviousValue),
    encodedNewValue,
    encodedNewValueSha256: sha256(encodedNewValue),
    clientTextSmokeCheckRequired: true,
    requiresEncodingRoundTripProbe: true,
  };
}

function analyzeVerifiedInlineCnTextChange(input = {}) {
  return analyzeVerifiedInlineTextChange(input);
}

function parseStringTableEntries(source) {
  if (!Buffer.isBuffer(source) || source.length < 8) {
    throw codedError("CN_TEXT_STRING_TABLE_INVALID", "stringtable.bin 太短或不可读。");
  }
  const count = source.readInt32LE(0);
  const offsetTableEnd = 4 + (count + 1) * 4;
  if (count < 0 || count >= MAX_STRING_TABLE_ENTRIES || offsetTableEnd > source.length) {
    throw codedError("CN_TEXT_STRING_TABLE_INVALID", "stringtable.bin 的条目数量或偏移表无效。");
  }
  const finalEnd = source.readInt32LE(4 + count * 4) + 4;
  if (finalEnd !== source.length) {
    throw codedError("CN_TEXT_STRING_TABLE_TRAILING_BYTES_UNVERIFIED", "stringtable.bin 含未识别的尾随字节，已停止中文写入。");
  }
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const start = source.readInt32LE(4 + index * 4) + 4;
    const end = source.readInt32LE(8 + index * 4) + 4;
    if (start < offsetTableEnd || end < start || end > source.length) {
      throw codedError("CN_TEXT_STRING_TABLE_INVALID", `stringtable.bin 条目 ${index} 的边界无效。`);
    }
    entries.push(Buffer.from(source.subarray(start, end)));
  }
  return entries;
}

function entrySequenceSha256(entries) {
  const hash = crypto.createHash("sha256");
  const length = Buffer.allocUnsafe(4);
  for (const entry of entries) {
    length.writeUInt32LE(entry.length, 0);
    hash.update(length);
    hash.update(entry);
  }
  return hash.digest("hex");
}

function appendStringTableEntry(source, appendedValue) {
  const originalEntries = parseStringTableEntries(source);
  const entries = [...originalEntries, Buffer.from(appendedValue)];
  const count = entries.length;
  const headerLength = 4 + (count + 1) * 4;
  const dataLength = entries.reduce((sum, entry) => sum + entry.length, 0);
  const output = Buffer.alloc(headerLength + dataLength);
  output.writeInt32LE(count, 0);
  let relativeOffset = headerLength - 4;
  let dataOffset = headerLength;
  for (let index = 0; index < entries.length; index += 1) {
    output.writeUInt32LE(relativeOffset, 4 + index * 4);
    entries[index].copy(output, dataOffset);
    relativeOffset += entries[index].length;
    dataOffset += entries[index].length;
  }
  output.writeUInt32LE(relativeOffset, 4 + count * 4);
  const rebuiltEntries = parseStringTableEntries(output);
  const originalSequenceSha256 = entrySequenceSha256(originalEntries);
  const preservedSequenceSha256 = entrySequenceSha256(rebuiltEntries.slice(0, originalEntries.length));
  if (originalSequenceSha256 !== preservedSequenceSha256) {
    throw codedError("CN_TEXT_STRING_TABLE_PRESERVATION_FAILED", "追加中文文本时未能保持既有字符串表条目不变。");
  }
  return {
    bytes: output,
    newIndex: count - 1,
    originalCount: originalEntries.length,
    outputCount: count,
    originalSequenceSha256,
    preservedSequenceSha256,
  };
}

function appendStringTableEntries(source, appendedValues) {
  const originalEntries = parseStringTableEntries(source);
  const values = Array.from(appendedValues || [], (value) => Buffer.from(value));
  const entries = [...originalEntries, ...values];
  const count = entries.length;
  const headerLength = 4 + (count + 1) * 4;
  const dataLength = entries.reduce((sum, entry) => sum + entry.length, 0);
  const bytes = Buffer.alloc(headerLength + dataLength);
  bytes.writeInt32LE(count, 0);
  let relativeOffset = headerLength - 4;
  let dataOffset = headerLength;
  for (let index = 0; index < entries.length; index += 1) {
    bytes.writeUInt32LE(relativeOffset, 4 + index * 4);
    entries[index].copy(bytes, dataOffset);
    relativeOffset += entries[index].length;
    dataOffset += entries[index].length;
  }
  bytes.writeUInt32LE(relativeOffset, 4 + count * 4);
  const outputEntries = parseStringTableEntries(bytes);
  const originalSequenceSha256 = entrySequenceSha256(originalEntries);
  const preservedSequenceSha256 = entrySequenceSha256(outputEntries.slice(0, originalEntries.length));
  if (originalSequenceSha256 !== preservedSequenceSha256) {
    throw codedError("CN_TEXT_STRING_TABLE_PRESERVATION_FAILED", "批量追加中文文本时未能保持既有字符串表条目不变。");
  }
  return {
    bytes,
    newIndexes: values.map((value, index) => originalEntries.length + index),
    originalCount: originalEntries.length,
    outputCount: outputEntries.length,
    originalSequenceSha256,
    preservedSequenceSha256,
  };
}

function buildVerifiedInlineTextPatch(input = {}) {
  if (input.textWriteMode === VERIFIED_STRINGLINK_DETACH_MODE) {
    const batch = buildVerifiedInlineTextBatchPatch({ ...input, changes: [input] });
    return { ...batch, analysis: analyzeVerifiedInlineTextChange(input), proof: batch.proofs[0] };
  }
  const analysis = analyzeVerifiedInlineTextChange(input);
  if (analysis.noOp) {
    return { noOp: true, analysis, proof: { mode: analysis.mode, encoding: analysis.encoding, noOp: true } };
  }
  const stringTableBytes = input.stringTableBytes;
  const scriptBytes = input.scriptBytes;
  if (!Buffer.isBuffer(stringTableBytes) || !Buffer.isBuffer(scriptBytes)) {
    throw codedError("CN_TEXT_RAW_INPUT_REQUIRED", "安全中文写入缺少原始字符串表或目标脚本字节。");
  }
  const stringTable = StringTable.parse(stringTableBytes, analysis.encoding);
  const tokens = parseTokens(scriptBytes);
  const extension = path.posix.extname(String(input.pvfPath || "").replace(/\\/g, "/").toLowerCase());
  const sourceAtoms = bindAtomsToRawTokens(lexDecompiledScript(String(input.sourceText || "")), tokens, stringTable);
  const requestedOffsets = new Set(analysis.occurrenceOffsets);
  const eligibilityProofByOffset = new Map(analysis.eligibilityProofs.map((proof) => [proof.tokenOffset, proof]));
  const candidates = sourceAtoms
    .filter((atom) => requestedOffsets.has(atom.start))
    .map((atom) => {
      const rawToken = atom.rawTokens?.[0];
      const eligibility = classifyVisibleTextOccurrence({
        pvfPath: input.pvfPath,
        textWriteMode: input.textWriteMode,
        sourceText: String(input.sourceText || ""),
        tokenOffset: atom.start,
        tokenLength: String(input.previousText || "").length,
      });
      const parentTag = eligibility.parentTag || null;
      const expectedEligibilityProof = eligibilityProofByOffset.get(atom.start) || null;
      if (
        atom.kind !== "string" ||
        atom.value !== analysis.previousValue ||
        atom.rawTokens?.length !== 1 ||
        rawToken?.type !== 7 ||
        !analysis.parentTags.includes(parentTag) ||
        eligibility.allowed !== true ||
        !eligibilityProofRouteMatches(expectedEligibilityProof, eligibility.proof)
      ) {
        throw codedError(
          "CN_TEXT_RAW_TOKEN_UNSAFE",
          "上下文锚定的显示文字未能映射到一个完整且获准的原始字符串 token。",
          { offset: atom.start, atomKind: atom.kind, parentTag },
        );
      }
      return { tokenIndex: atom.tokenStart, originalStringIndex: rawToken.value, parentTag, textOffset: atom.start };
    });
  if (candidates.length !== analysis.expectedOccurrences) {
    throw codedError(
      "CN_TEXT_RAW_TOKEN_UNSAFE",
      `原始脚本中的对应文本 token 数量必须为 ${analysis.expectedOccurrences}，当前为 ${candidates.length} 个。`,
      {
        parentTags: analysis.parentTags,
        expectedOccurrences: analysis.expectedOccurrences,
        candidateCount: candidates.length,
        requestedOffsets: analysis.occurrenceOffsets,
      },
    );
  }
  const candidate = candidates[0];
  const alternateEncoding = alternateChineseEncoding(analysis.encoding);
  const alternateStringTable = StringTable.parse(stringTableBytes, alternateEncoding);
  const alternateValue = alternateStringTable.get(candidate.originalStringIndex);
  const prevalidatedEncodingProof = input.prevalidatedEncodingProof || null;
  if (prevalidatedEncodingProof && (
    prevalidatedEncodingProof.encoding !== analysis.encoding ||
    prevalidatedEncodingProof.parentTag !== analysis.parentTag ||
    prevalidatedEncodingProof.encodedPreviousValueSha256 !== analysis.encodedPreviousValueSha256 ||
    prevalidatedEncodingProof.encodedNewValueSha256 !== analysis.encodedNewValueSha256 ||
    prevalidatedEncodingProof.sourceEncodingMismatchSuspected !== false
  )) {
    throw codedError("CN_TEXT_PREVALIDATED_PROOF_MISMATCH", "同文件联动写入的中文编码预验证证据与当前改动不一致。");
  }
  const encodingComparison = prevalidatedEncodingProof?.sourceEncodingComparison || compareChineseEncodingCandidates(
    analysis.previousValue,
    alternateValue,
    analysis.encoding,
    alternateEncoding,
  );
  if (!prevalidatedEncodingProof && encodingComparison.requestedLooksMojibake === true) {
    throw codedError(
      "TEXT_ENCODING_MISMATCH_SUSPECTED",
      `目标原文按 ${analysis.encoding} 读取时呈现明显乱码特征；同一条目按 ${alternateEncoding} 更可信。请改用 ${alternateEncoding} 重新读取和预演。`,
      {
        requestedEncoding: analysis.encoding,
        suggestedEncoding: alternateEncoding,
        requestedValuePreview: analysis.previousValue.slice(0, 160),
        alternateValuePreview: String(alternateValue || "").slice(0, 160),
        comparison: compactEncodingComparison(encodingComparison),
      },
    );
  }
  const encodingEvidence = prevalidatedEncodingProof?.sourceEncodingEvidence || {
    kind: containsNonAscii(analysis.previousValue) ? "target-token" : "same-script-references",
    requestedEncoding: analysis.encoding,
    alternateEncoding,
    requestedSupportCount: 0,
    alternateSupportCount: 0,
    ambiguousReferenceCount: 0,
  };
  if (!prevalidatedEncodingProof && containsNonAscii(analysis.previousValue)) {
    encodingEvidence.requestedSupportCount = 1;
  } else if (!prevalidatedEncodingProof && containsNonAscii(analysis.newValue)) {
    const stringIndexes = new Set();
    for (const token of tokens) {
      if ([5, 6, 7, 8, 10].includes(token.type)) stringIndexes.add(token.value);
    }
    for (const stringIndex of stringIndexes) {
      if (stringIndex === candidate.originalStringIndex) continue;
      const requestedReference = stringTable.get(stringIndex);
      const alternateReference = alternateStringTable.get(stringIndex);
      if (!containsNonAscii(requestedReference) && !containsNonAscii(alternateReference)) continue;
      const referenceComparison = compareChineseEncodingCandidates(
        requestedReference,
        alternateReference,
        analysis.encoding,
        alternateEncoding,
      );
      if (referenceComparison.alternateLooksMojibake === true) encodingEvidence.requestedSupportCount += 1;
      else if (referenceComparison.requestedLooksMojibake === true) encodingEvidence.alternateSupportCount += 1;
      else if (referenceComparison.different === true) encodingEvidence.ambiguousReferenceCount += 1;
    }
    if (encodingEvidence.requestedSupportCount === 0 || encodingEvidence.alternateSupportCount > 0) {
      throw codedError(
        "TEXT_ENCODING_EVIDENCE_REQUIRED",
        `旧字段本身不含中文，当前脚本也不足以证明应使用 ${analysis.encoding} 写入新中文。请从目标中确认一个已有中文字段的编码，或改用能够提供明确编码证据的样本。`,
        encodingEvidence,
      );
    }
  }
  const appended = appendStringTableEntries(
    stringTableBytes,
    candidates.map(() => analysis.encodedNewValue),
  );
  const patchedScriptBytes = Buffer.from(scriptBytes);
  candidates.forEach((item, index) => {
    patchedScriptBytes.writeUInt32LE(appended.newIndexes[index], 3 + item.tokenIndex * 5);
  });
  return {
    noOp: false,
    analysis,
    stringTableBytes: appended.bytes,
    scriptBytes: patchedScriptBytes,
    proof: {
      mode: analysis.mode,
      encoding: analysis.encoding,
      parentTag: analysis.parentTag,
      eligibilityPolicyId: analysis.eligibilityPolicyId,
      eligibilityPolicySha256: analysis.eligibilityPolicySha256,
      eligibilityProofs: analysis.eligibilityProofs,
      eligibilityProofsSha256: analysis.eligibilityProofsSha256,
      structuredContainerProofs: analysis.structuredContainerProofs,
      structuredContainerProofsSha256: analysis.structuredContainerProofsSha256,
      ...(analysis.visibleTextFamilyProofs?.length > 0
        ? {
          visibleTextFamilyProofs: analysis.visibleTextFamilyProofs,
          visibleTextFamilyProofsSha256: analysis.visibleTextFamilyProofsSha256,
        }
        : {}),
      targetTokenIndex: candidate.tokenIndex,
      targetTokenIndexes: candidates.map((item) => item.tokenIndex),
      targetTextOffset: candidate.textOffset,
      targetTextOffsets: candidates.map((item) => item.textOffset),
      originalStringIndex: candidate.originalStringIndex,
      originalStringIndexes: candidates.map((item) => item.originalStringIndex),
      newStringIndex: appended.newIndexes[0],
      newStringIndexes: appended.newIndexes,
      occurrenceCount: candidates.length,
      expectedOccurrences: analysis.expectedOccurrences,
      totalOccurrenceCount: analysis.totalOccurrenceCount,
      scopedOccurrenceCount: analysis.scopedOccurrenceCount,
      contextAnchor: analysis.contextAnchor,
      originalStringCount: appended.originalCount,
      outputStringCount: appended.outputCount,
      existingStringEntriesPreserved: appended.originalSequenceSha256 === appended.preservedSequenceSha256,
      existingStringEntriesSha256: appended.originalSequenceSha256,
      sourceEncodingCheckedAgainst: alternateEncoding,
      sourceEncodingMismatchSuspected: false,
      sourceEncodingComparison: compactEncodingComparison(encodingComparison),
      sourceEncodingEvidence: encodingEvidence,
      encodingEvidencePrevalidated: Boolean(prevalidatedEncodingProof),
      encodedPreviousValueSha256: analysis.encodedPreviousValueSha256,
      encodedNewValueSha256: analysis.encodedNewValueSha256,
      scriptBeforeSha256: sha256(scriptBytes),
      scriptAfterSha256: sha256(patchedScriptBytes),
      stringTableBeforeSha256: sha256(stringTableBytes),
      stringTableAfterSha256: sha256(appended.bytes),
    },
  };
}

function buildVerifiedInlineTextBatchPatch(input = {}) {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (changes.length === 0) {
    throw codedError("CN_TEXT_BATCH_INPUT_REQUIRED", "批量中文写入至少需要一条改动。");
  }
  if (!Buffer.isBuffer(input.stringTableBytes) || !Buffer.isBuffer(input.scriptBytes)) {
    throw codedError("CN_TEXT_RAW_INPUT_REQUIRED", "安全中文批量写入缺少原始字符串表或目标脚本字节。");
  }

  const pvfPath = String(input.pvfPath || "").replace(/\\/g, "/");
  const extension = path.posix.extname(pvfPath.toLowerCase());
  const encoding = normalizeEncoding(input.pvfEncoding, input.fallbackEncoding || "Tw");
  const originalStringEntries = parseStringTableEntries(input.stringTableBytes);
  const originalStringEntriesSha256 = entrySequenceSha256(originalStringEntries);
  const originalStringTable = StringTable.parse(input.stringTableBytes, encoding);
  const alternateEncoding = alternateChineseEncoding(encoding);
  const alternateStringTable = StringTable.parse(input.stringTableBytes, alternateEncoding);
  const originalTokens = parseTokens(input.scriptBytes);
  const sourceAtoms = bindAtomsToRawTokens(lexDecompiledScript(String(input.sourceText || "")), originalTokens, originalStringTable);
  const stringIndexes = new Set();
  for (const token of originalTokens) {
    if ([5, 6, 7, 8, 10].includes(token.type)) stringIndexes.add(token.value);
  }
  const encodingEvidenceCache = new Map();
  const sameScriptEncodingEvidence = (excludedIndexes) => {
    const exclusionKey = [...excludedIndexes].sort((left, right) => left - right).join(",");
    if (encodingEvidenceCache.has(exclusionKey)) return { ...encodingEvidenceCache.get(exclusionKey) };
    const evidence = {
      kind: "same-script-references",
      requestedEncoding: encoding,
      alternateEncoding,
      requestedSupportCount: 0,
      alternateSupportCount: 0,
      ambiguousReferenceCount: 0,
    };
    for (const stringIndex of stringIndexes) {
      if (excludedIndexes.has(stringIndex)) continue;
      const requestedReference = originalStringTable.get(stringIndex);
      const alternateReference = alternateStringTable.get(stringIndex);
      if (!containsNonAscii(requestedReference) && !containsNonAscii(alternateReference)) continue;
      const referenceComparison = compareChineseEncodingCandidates(
        requestedReference,
        alternateReference,
        encoding,
        alternateEncoding,
      );
      if (referenceComparison.alternateLooksMojibake === true) evidence.requestedSupportCount += 1;
      else if (referenceComparison.requestedLooksMojibake === true) evidence.alternateSupportCount += 1;
      else if (referenceComparison.different === true) evidence.ambiguousReferenceCount += 1;
    }
    encodingEvidenceCache.set(exclusionKey, evidence);
    return { ...evidence };
  };
  let sourceText = String(input.sourceText || "");
  const appliedTextEdits = [];
  const planned = [];
  const pendingStringValues = [];
  const pendingStringIndexBySha256 = new Map();
  const startedAt = process.hrtime.bigint();
  const currentOffsetToOriginal = (offset) => {
    let delta = 0;
    const ordered = [...appliedTextEdits].sort((left, right) => left.originalStart - right.originalStart);
    for (const edit of ordered) {
      const currentStart = edit.originalStart + delta;
      const currentEnd = currentStart + edit.newLength;
      if (offset < currentStart) return offset - delta;
      if (offset < currentEnd) return null;
      delta += edit.newLength - edit.oldLength;
    }
    return offset - delta;
  };

  for (const change of changes) {
    if (change.textWriteMode === VERIFIED_STRINGLINK_DETACH_MODE && !SUPPORTED_INLINE_TEXT_ENCODINGS.has(change.pvfEncoding)) {
      throw codedError("STRINGLINK_DETACH_SCOPE_INVALID", "解除引用必须在每项变化中明确声明Cn/Tw。");
    }
    const analysis = analyzeVerifiedInlineTextChange({
      ...change,
      pvfPath,
      pvfEncoding: change.pvfEncoding || encoding,
      fallbackEncoding: input.fallbackEncoding || encoding,
      sourceText,
    });
    if (analysis.noOp) {
      planned.push({ id: change.id || null, change, analysis, candidates: [], noOp: true });
      continue;
    }
    if (analysis.encoding !== encoding) {
      throw codedError("CN_TEXT_BATCH_ENCODING_MISMATCH", "同一文件的中文批量写入不能混用不同编码。");
    }
    const originalRequestedOffsets = analysis.occurrenceOffsets.map((offset) => currentOffsetToOriginal(offset));
    if (originalRequestedOffsets.some((offset) => offset === null)) {
      throw codedError(
        "CN_TEXT_BATCH_OVERLAP_UNSUPPORTED",
        "同一批次中的文字改动再次命中了本批次已经替换的文字；请合并为一次最终替换。",
        { id: change.id || null },
      );
    }
    const requestedOffsets = new Set(originalRequestedOffsets);
    const eligibilityProofByOriginalOffset = new Map(
      originalRequestedOffsets.map((offset, index) => [offset, analysis.eligibilityProofs[index] || null]),
    );
    const currentOffsetByOriginalOffset = new Map(
      originalRequestedOffsets.map((offset, index) => [offset, analysis.occurrenceOffsets[index]]),
    );
    const candidates = sourceAtoms
      .filter((atom) => requestedOffsets.has(atom.start))
      .map((atom) => {
        const rawToken = atom.rawTokens?.[0];
        const originalEligibility = classifyVisibleTextOccurrence({
          pvfPath,
          sourceText: String(input.sourceText || ""),
          tokenOffset: atom.start,
          tokenLength: String(change.previousText || "").length,
          textWriteMode: change.textWriteMode,
        });
        // Earlier verified edits can change a paired title and shift offsets.
        // Bind bytes against the original atoms, but compare the current proof
        // against the same evolving text used by the change analyzer.
        const eligibility = classifyVisibleTextOccurrence({
          pvfPath, sourceText, tokenOffset: currentOffsetByOriginalOffset.get(atom.start),
          tokenLength: String(change.previousText || "").length, textWriteMode: change.textWriteMode,
        });
        const parentTag = eligibility.parentTag || null;
        const expectedEligibilityProof = eligibilityProofByOriginalOffset.get(atom.start) || null;
        if (
          (analysis.stringLinkDetach
            ? (atom.kind !== "stringlink" || atom.rawTokens?.length !== 2 || rawToken?.type !== 9 || atom.rawTokens[1]?.type !== 10)
            : (atom.kind !== "string" || atom.value !== analysis.previousValue || atom.rawTokens?.length !== 1 || rawToken?.type !== 7)) ||
          !analysis.parentTags.includes(parentTag) ||
          originalEligibility.allowed !== true || eligibility.allowed !== true ||
          !eligibilityProofRouteMatches(expectedEligibilityProof, eligibility.proof)
        ) {
          throw codedError(
            "CN_TEXT_RAW_TOKEN_UNSAFE",
            "批量中文写入中的显示文字未能映射到完整且获准的原始字符串 token。",
            { id: change.id || null, offset: atom.start, atomKind: atom.kind, parentTag },
          );
        }
        return { tokenIndex: atom.tokenStart, tokenCount: analysis.stringLinkDetach ? 2 : 1,
          originalStringIndex: analysis.stringLinkDetach ? atom.rawTokens[1].value : rawToken.value, parentTag, textOffset: atom.start };
      });
    if (candidates.length !== analysis.expectedOccurrences) {
      throw codedError(
        "CN_TEXT_RAW_TOKEN_UNSAFE",
        `批量中文写入中的对应原始 token 数量必须为 ${analysis.expectedOccurrences}，当前为 ${candidates.length} 个。`,
        { id: change.id || null, expectedOccurrences: analysis.expectedOccurrences, candidateCount: candidates.length },
      );
    }

    // The link display is not an encoding oracle. Detachment uses the explicitly
    // selected destination encoding and the normal lossless/independent probes.
    const alternateValue = analysis.stringLinkDetach ? analysis.previousValue : alternateStringTable.get(candidates[0].originalStringIndex);
    const encodingComparison = compareChineseEncodingCandidates(
      analysis.previousValue,
      alternateValue,
      encoding,
      alternateEncoding,
    );
    if (encodingComparison.requestedLooksMojibake === true) {
      throw codedError(
        "TEXT_ENCODING_MISMATCH_SUSPECTED",
        `目标原文按 ${encoding} 读取时呈现明显乱码特征；同一条目按 ${alternateEncoding} 更可信。请改用 ${alternateEncoding} 重新读取和预演。`,
        {
          requestedEncoding: encoding,
          suggestedEncoding: alternateEncoding,
          requestedValuePreview: analysis.previousValue.slice(0, 160),
          alternateValuePreview: String(alternateValue || "").slice(0, 160),
          comparison: compactEncodingComparison(encodingComparison),
        },
      );
    }
    const encodingEvidence = analysis.stringLinkDetach
      ? { kind: "explicit-destination-encoding-stringlink-detach", requestedEncoding: encoding,
        requestedSupportCount: 1, alternateSupportCount: 0, linkedDisplayUsedAsEncodingEvidence: false }
      : containsNonAscii(analysis.previousValue)
      ? {
        kind: "target-token",
        requestedEncoding: encoding,
        alternateEncoding,
        requestedSupportCount: 1,
        alternateSupportCount: 0,
        ambiguousReferenceCount: 0,
      }
      : sameScriptEncodingEvidence(new Set(candidates.map((candidate) => candidate.originalStringIndex)));
    if (!containsNonAscii(analysis.previousValue) && containsNonAscii(analysis.newValue)) {
      if (encodingEvidence.requestedSupportCount === 0 || encodingEvidence.alternateSupportCount > 0) {
        throw codedError(
          "TEXT_ENCODING_EVIDENCE_REQUIRED",
          `旧字段本身不含中文，当前脚本也不足以证明应使用 ${encoding} 写入新中文。`,
          encodingEvidence,
        );
      }
    }
    planned.push({
      id: change.id || null,
      change,
      analysis,
      candidates,
      alternateEncoding,
      encodingComparison,
      encodingEvidence,
      newStringIndexes: [],
      pendingStringSlots: [],
      noOp: false,
    });
    for (const candidate of candidates) {
      void candidate;
      const valueSha256 = analysis.encodedNewValueSha256;
      let pendingStringSlot = pendingStringIndexBySha256.get(valueSha256);
      if (pendingStringSlot === undefined) {
        pendingStringSlot = pendingStringValues.length;
        pendingStringValues.push(analysis.encodedNewValue);
        pendingStringIndexBySha256.set(valueSha256, pendingStringSlot);
      } else if (!pendingStringValues[pendingStringSlot].equals(analysis.encodedNewValue)) {
        throw codedError("CN_TEXT_BATCH_DEDUP_COLLISION", "批量文字去重遇到哈希冲突，已停止写入。");
      }
      planned[planned.length - 1].pendingStringSlots.push(pendingStringSlot);
    }
    sourceText = applyContextAnchoredReplacement({
      sourceText,
      previousText: change.previousText,
      newText: change.newText,
    }, analyzeContextAnchoredReplacement({
      sourceText,
      previousText: change.previousText,
      newText: change.newText,
      contextBefore: change.contextBefore,
      contextAfter: change.contextAfter,
      scope: change.scope,
      replaceAll: change.replaceAll === true,
      expectedOccurrences: change.expectedOccurrences,
    }));
    for (const originalStart of originalRequestedOffsets) {
      appliedTextEdits.push({
        originalStart,
        oldLength: String(change.previousText).length,
        newLength: String(change.newText).length,
      });
    }
  }

  const appended = appendStringTableEntries(input.stringTableBytes, pendingStringValues);
  const outputTokens = originalTokens.map((token) => ({ ...token }));
  const removedTokenIndexes = new Set();
  for (const item of planned.filter((entry) => !entry.noOp)) {
    for (let candidateIndex = 0; candidateIndex < item.candidates.length; candidateIndex += 1) {
      const candidate = item.candidates[candidateIndex];
      const newStringIndex = appended.newIndexes[item.pendingStringSlots[candidateIndex]];
      outputTokens[candidate.tokenIndex] = { ...outputTokens[candidate.tokenIndex], type: 7, value: newStringIndex };
      if (candidate.tokenCount === 2) removedTokenIndexes.add(candidate.tokenIndex + 1);
      item.newStringIndexes.push(newStringIndex);
    }
  }
  const stringTableBytes = appended.bytes;
  const scriptBytes = encodeScriptTokens(input.scriptBytes, outputTokens.filter((_, index) => !removedTokenIndexes.has(index)));
  const outputStringEntries = parseStringTableEntries(stringTableBytes);
  const preservedStringEntriesSha256 = entrySequenceSha256(outputStringEntries.slice(0, originalStringEntries.length));
  if (preservedStringEntriesSha256 !== originalStringEntriesSha256) {
    throw codedError("CN_TEXT_STRING_TABLE_PRESERVATION_FAILED", "批量中文写入未能保持既有字符串表条目不变。");
  }
  const finalStringTable = StringTable.parse(stringTableBytes, encoding);
  bindAtomsToRawTokens(lexDecompiledScript(sourceText), parseTokens(scriptBytes), finalStringTable);
  const proofs = planned.map((item) => {
    if (item.noOp) return { id: item.id, mode: item.analysis.mode, encoding, noOp: true };
    const candidate = item.candidates[0];
    return {
      id: item.id,
      mode: item.analysis.mode,
      encoding,
      parentTag: item.analysis.parentTag,
      eligibilityPolicyId: item.analysis.eligibilityPolicyId,
      eligibilityPolicySha256: item.analysis.eligibilityPolicySha256,
      eligibilityProofs: item.analysis.eligibilityProofs,
      eligibilityProofsSha256: item.analysis.eligibilityProofsSha256,
      structuredContainerProofs: item.analysis.structuredContainerProofs,
      structuredContainerProofsSha256: item.analysis.structuredContainerProofsSha256,
      ...(item.analysis.visibleTextFamilyProofs?.length > 0
        ? {
          visibleTextFamilyProofs: item.analysis.visibleTextFamilyProofs,
          visibleTextFamilyProofsSha256: item.analysis.visibleTextFamilyProofsSha256,
        }
        : {}),
      targetTokenIndex: candidate.tokenIndex,
      targetTokenIndexes: item.candidates.map((entry) => entry.tokenIndex),
      targetTextOffset: candidate.textOffset,
      targetTextOffsets: item.candidates.map((entry) => entry.textOffset),
      originalStringIndex: candidate.originalStringIndex,
      originalStringIndexes: item.candidates.map((entry) => entry.originalStringIndex),
      newStringIndex: item.newStringIndexes[0],
      newStringIndexes: item.newStringIndexes,
      occurrenceCount: item.candidates.length,
      expectedOccurrences: item.analysis.expectedOccurrences,
      totalOccurrenceCount: item.analysis.totalOccurrenceCount,
      scopedOccurrenceCount: item.analysis.scopedOccurrenceCount,
      contextAnchor: item.analysis.contextAnchor,
      originalStringCount: appended.originalCount,
      outputStringCount: appended.outputCount,
      existingStringEntriesPreserved: true,
      existingStringEntriesSha256: originalStringEntriesSha256,
      sourceEncodingCheckedAgainst: item.alternateEncoding,
      sourceEncodingMismatchSuspected: false,
      sourceEncodingComparison: compactEncodingComparison(item.encodingComparison),
      sourceEncodingEvidence: item.encodingEvidence,
      encodingEvidencePrevalidated: false,
      encodedPreviousValueSha256: item.analysis.encodedPreviousValueSha256,
      encodedNewValueSha256: item.analysis.encodedNewValueSha256,
      scriptBeforeSha256: sha256(input.scriptBytes),
      scriptAfterSha256: sha256(scriptBytes),
      stringTableBeforeSha256: sha256(input.stringTableBytes),
      stringTableAfterSha256: sha256(stringTableBytes),
      batchMode: true,
      batchChangeCount: changes.length,
    };
  });
  return {
    noOp: proofs.every((proof) => proof.noOp === true),
    mode: "verified-inline-text-batch",
    encoding,
    changeCount: changes.length,
    sourceText,
    stringTableBytes,
    scriptBytes,
    proofs,
    proof: {
      mode: "verified-inline-text-batch",
      encoding,
      changeCount: changes.length,
      eligibilityPolicyId: VERIFIED_TEXT_ELIGIBILITY_POLICY_ID,
      eligibilityPolicySha256: VERIFIED_TEXT_ELIGIBILITY_POLICY_SHA256,
      eligibilityProofsByChangeSha256: sha256(JSON.stringify(proofs.map((proof) => ({
        id: proof.id,
        eligibilityProofsSha256: proof.eligibilityProofsSha256 || null,
      })))),
      existingStringEntriesPreserved: true,
      existingStringEntriesSha256: originalStringEntriesSha256,
      originalStringCount: originalStringEntries.length,
      outputStringCount: outputStringEntries.length,
      appendedStringEntryCount: outputStringEntries.length - originalStringEntries.length,
      replacedTokenCount: planned.reduce((sum, item) => sum + item.candidates.length, 0),
      duplicateNewStringReferenceCount:
        planned.reduce((sum, item) => sum + item.candidates.length, 0) - pendingStringValues.length,
      scriptBeforeSha256: sha256(input.scriptBytes),
      scriptAfterSha256: sha256(scriptBytes),
      stringTableBeforeSha256: sha256(input.stringTableBytes),
      stringTableAfterSha256: sha256(stringTableBytes),
      elapsedMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1e6,
    },
  };
}

function buildVerifiedInlineCnPatch(input = {}) {
  return buildVerifiedInlineTextPatch(input);
}

function signedTokenValue(value) {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function floatTokenText(value, keepIntegerDecimal = false) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  const number = buffer.readFloatLE(0);
  if (!Number.isFinite(number)) return String(number);
  if (keepIntegerDecimal && Number.isInteger(number)) return number.toFixed(1);
  return number.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function bindAtomsToRawTokens(atoms, tokens, stringTable) {
  let tokenIndex = 0;
  let currentSection = null;
  for (const atom of atoms) {
    const start = tokenIndex;
    const token = tokens[tokenIndex];
    if (!token) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "脚本文本的 token 数量多于原始脚本。");
    if (atom.kind === "section") {
      if (token.type !== 5 || stringTable.get(token.value) !== atom.value) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "Section 与原始 token 不一致。");
      currentSection = atom.value.startsWith("[/") ? null : atom.value.toLowerCase();
      tokenIndex += 1;
    } else if (atom.kind === "string") {
      if (token.type !== 7 || stringTable.get(token.value) !== atom.value) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "字符串与原始 token 不一致。");
      tokenIndex += 1;
    } else if (atom.kind === "stringlink") {
      const next = tokens[tokenIndex + 1];
      if (token.type !== 9 || next?.type !== 10 || signedTokenValue(token.value) !== atom.namespace || stringTable.get(next.value) !== atom.key) {
        throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "StringLink 与原始 token 不一致。");
      }
      tokenIndex += 2;
    } else if (atom.kind === "typed-string") {
      if (token.type !== atom.type || stringTable.get(token.value) !== atom.value) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "带类型字符串与原始 token 不一致。");
      tokenIndex += 1;
    } else if (atom.kind === "typed-number") {
      if (token.type !== atom.type || String(signedTokenValue(token.value)) !== atom.valueText) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "带类型数字与原始 token 不一致。");
      tokenIndex += 1;
    } else {
      const rendered = token.type === 4
        ? floatTokenText(token.value, currentSection === "[level property]")
        : [2, 3, 10].includes(token.type) ? String(signedTokenValue(token.value)) : null;
      if (rendered !== atom.valueText) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", `数字 ${atom.valueText} 与原始 token 不一致。`);
      atom.rawNumericType = token.type;
      tokenIndex += 1;
    }
    atom.tokenStart = start;
    atom.tokenEnd = tokenIndex;
    atom.rawTokens = tokens.slice(start, tokenIndex);
  }
  if (tokenIndex !== tokens.length) throw codedError("RAW_ASCII_SOURCE_TOKEN_MISMATCH", "原始脚本仍有未映射 token。");
  return atoms;
}

function atomIdentity(atom) {
  if (atom.kind === "number") return `number:${atom.valueText}`;
  if (atom.kind === "stringlink") return `stringlink:${atom.namespace}:${atom.key}:${atom.display}`;
  if (atom.kind === "typed-number") return `typed-number:${atom.type}:${atom.valueText}`;
  if (atom.kind === "typed-string") return `typed-string:${atom.type}:${atom.value}`;
  return `${atom.kind}:${atom.value}`;
}

function alignReplacementAtoms(oldAtoms, newAtoms) {
  if (
    oldAtoms.length === newAtoms.length &&
    oldAtoms.every((atom, index) => atom.kind === newAtoms[index].kind && atom.kind !== "stringlink")
  ) {
    return new Map(newAtoms.map((_, index) => [index, oldAtoms[index]]));
  }
  const rows = oldAtoms.length + 1;
  const cols = newAtoms.length + 1;
  const cost = Array.from({ length: rows }, () => new Array(cols).fill(Number.POSITIVE_INFINITY));
  const action = Array.from({ length: rows }, () => new Array(cols).fill(null));
  cost[0][0] = 0;
  for (let i = 0; i <= oldAtoms.length; i += 1) for (let j = 0; j <= newAtoms.length; j += 1) {
    const base = cost[i][j];
    if (!Number.isFinite(base)) continue;
    if (i < oldAtoms.length && base + 2 < cost[i + 1][j]) { cost[i + 1][j] = base + 2; action[i + 1][j] = "delete"; }
    if (j < newAtoms.length && base + 2 < cost[i][j + 1]) { cost[i][j + 1] = base + 2; action[i][j + 1] = "insert"; }
    if (i < oldAtoms.length && j < newAtoms.length) {
      const exact = atomIdentity(oldAtoms[i]) === atomIdentity(newAtoms[j]);
      const compatible = oldAtoms[i].kind === newAtoms[j].kind && oldAtoms[i].kind !== "stringlink";
      const step = exact ? 0 : compatible ? 1 : 5;
      if (base + step < cost[i + 1][j + 1]) { cost[i + 1][j + 1] = base + step; action[i + 1][j + 1] = "match"; }
    }
  }
  const mapping = new Map();
  let i = oldAtoms.length;
  let j = newAtoms.length;
  while (i > 0 || j > 0) {
    const step = action[i][j];
    if (step === "match") { mapping.set(j - 1, oldAtoms[i - 1]); i -= 1; j -= 1; }
    else if (step === "delete") i -= 1;
    else if (step === "insert") j -= 1;
    else throw codedError("RAW_ASCII_TOKEN_ALIGNMENT_FAILED", "参数块无法与原始 token 安全对齐。");
  }
  return mapping;
}

function numericValueForToken(valueText, type) {
  const number = Number(valueText);
  if (!Number.isFinite(number)) throw codedError("RAW_ASCII_NUMBER_INVALID", `数字无法编码：${valueText}`);
  if (type === 4) {
    const float32 = Math.fround(number);
    if (!Number.isFinite(float32)) {
      throw codedError("RAW_ASCII_NUMBER_INVALID", `浮点超出 float32 有限范围：${valueText}`);
    }
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeFloatLE(float32, 0);
    return bytes.readUInt32LE(0);
  }
  if (!Number.isSafeInteger(number) || number < -0x80000000 || number > 0x7fffffff) {
    throw codedError("RAW_ASCII_NUMBER_INVALID", `整数超出 32 位范围：${valueText}`);
  }
  return number >>> 0;
}

function numericTokenTypeForReplacement(valueText, mapped) {
  const explicitDecimal = /^-?(?:\d+\.\d+|\.\d+)$/u.test(String(valueText || ""));
  if (explicitDecimal) return 4;
  return mapped?.kind === "number" ? mapped.rawNumericType : 2;
}

function encodeScriptTokens(headerSource, tokens) {
  if (!Buffer.isBuffer(headerSource) || headerSource.length < 2 || (headerSource.length - 2) % 5 !== 0) {
    throw codedError("RAW_ASCII_SCRIPT_LAYOUT_UNSUPPORTED", "脚本含未识别尾随字节或 token 布局异常。");
  }
  // Keep the source preamble. The controlled server supplies raw binary bytes
  // to native.upsertFile, so save/reopen must preserve them exactly.
  const output = Buffer.alloc(2 + tokens.length * 5);
  headerSource.copy(output, 0, 0, 2);
  tokens.forEach((token, index) => {
    output[2 + index * 5] = token.type;
    output.writeUInt32LE(token.value >>> 0, 3 + index * 5);
  });
  return output;
}

function buildRawAsciiScriptPatch(input = {}) {
  const pvfPath = String(input.pvfPath || "").replace(/\\/g, "/");
  const extension = path.posix.extname(pvfPath.toLowerCase());
  if (!RAW_TOKEN_PATCH_EXTENSIONS.has(extension) && extension !== ".evt") {
    const recovery = extension === ".til"
      ? " 可优先使用 copy-file 复制正确的同 PVF、同扩展名 TIL，并在同一 change-set 精确切换其他 .map 的引用；只有修改克隆内容本身才需要累计下一轮。"
      : "";
    throw codedError("RAW_ASCII_FILE_TYPE_UNSUPPORTED", `当前未开放 ${extension || "无扩展名"} 文件的原始参数补丁。${recovery}`);
  }
  const previousText = String(input.previousText || "");
  const newText = String(input.newText || "");
  if (containsNonAscii(previousText) || containsNonAscii(newText)) {
    throw codedError("RAW_ASCII_NON_ASCII_BLOCKED", "原始参数补丁只允许数字、英文、标签、Tab 和常见符号；中文必须拆成安全文字改动。");
  }
  if (!previousText || previousText === newText) {
    return { noOp: previousText === newText, scriptBytes: input.scriptBytes, proof: { noOp: previousText === newText } };
  }
  const sourceText = String(input.sourceText || "");
  const anchored = analyzeContextAnchoredReplacement({
    sourceText,
    previousText,
    newText,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    scope: input.scope,
    occurrenceIndex: input.occurrenceIndex,
    replaceAll: input.replaceAll === true,
    expectedOccurrences: input.expectedOccurrences,
  });
  const mismatch = occurrenceMismatch(anchored);
  if (mismatch) throw mismatch;
  const expectedOccurrences = anchored.expectedOccurrences;
  const actualOccurrences = anchored.occurrenceCount;
  const staticEventAppend = extension === ".evt" ? inspectStaticEventAppend({ ...input, pvfPath }, anchored.occurrenceOffsets) : null;
  if (extension === ".evt" && !staticEventAppend) {
    throw codedError("RAW_ASCII_EVENT_APPEND_REQUIRED", "活动结构只允许在文件末尾追加一个完整静态说明条目，沿用现有末条的非文字元数据并保留所有原文。");
  }
  const stringTableBytes = input.stringTableBytes;
  const scriptBytes = input.scriptBytes;
  if (!Buffer.isBuffer(stringTableBytes) || !Buffer.isBuffer(scriptBytes)) {
    throw codedError("RAW_ASCII_INPUT_REQUIRED", "原始参数补丁缺少字符串表或脚本原始字节。");
  }
  const encoding = normalizeEncoding(input.pvfEncoding, input.fallbackEncoding || "Tw");
  const stringTable = StringTable.parse(stringTableBytes, encoding);
  const originalStringEntries = parseStringTableEntries(stringTableBytes);
  const originalStringEntriesSha256 = entrySequenceSha256(originalStringEntries);
  let outputStringTableBytes = Buffer.from(stringTableBytes);
  const appendedStringIndexes = new Map();
  const appendedStringValueSha256s = [];
  const stringIndexForNewAsciiValue = (value) => {
    const key = String(value);
    if (appendedStringIndexes.has(key)) return appendedStringIndexes.get(key);
    const appended = appendStringTableEntry(outputStringTableBytes, Buffer.from(key, "ascii"));
    outputStringTableBytes = appended.bytes;
    appendedStringIndexes.set(key, appended.newIndex);
    appendedStringValueSha256s.push(sha256(Buffer.from(key, "ascii")));
    return appended.newIndex;
  };
  const tokens = parseTokens(scriptBytes);
  const normalize = (value) => String(value || "").replace(/\r?\n/g, "\r\n");
  const normalizedSourceText = normalize(sourceText);
  const normalizedPreviousText = normalize(previousText);
  const normalizedNewText = normalize(newText);
  const normalizedAnchor = analyzeContextAnchoredReplacement({
    sourceText: normalizedSourceText,
    previousText: normalizedPreviousText,
    newText: normalizedNewText,
    contextBefore: anchored.contextBefore === null ? undefined : normalize(anchored.contextBefore),
    contextAfter: anchored.contextAfter === null ? undefined : normalize(anchored.contextAfter),
    scope: anchored.scope === null ? undefined : {
      startText: normalize(anchored.scope.startText),
      endText: normalize(anchored.scope.endText),
      expectedRanges: anchored.scope.expectedRanges,
    },
    replaceAll: anchored.replaceAll,
    expectedOccurrences,
  });
  const normalizedMismatch = occurrenceMismatch(normalizedAnchor);
  if (normalizedMismatch) throw normalizedMismatch;
  const rawExpected = applyContextAnchoredReplacement({
    sourceText: normalizedSourceText,
    previousText: normalizedPreviousText,
    newText: normalizedNewText,
  }, normalizedAnchor);
  const sourceAtoms = bindAtomsToRawTokens(lexDecompiledScript(normalizedSourceText), tokens, stringTable);
  const occurrenceRanges = [];
  for (let index = 0; index < expectedOccurrences; index += 1) {
    const start = normalizedAnchor.occurrenceOffsets[index];
    occurrenceRanges.push({ start, end: start + normalizedPreviousText.length });
  }
  const outputTokens = [];
  const changedTokenIndexes = [];
  const numericTypeTransitions = [];
  let sourceAtomIndex = 0;
  for (const range of occurrenceRanges) {
    while (sourceAtomIndex < sourceAtoms.length && sourceAtoms[sourceAtomIndex].end <= range.start) {
      outputTokens.push(...sourceAtoms[sourceAtomIndex].rawTokens);
      sourceAtomIndex += 1;
    }
    const oldAtoms = [];
    while (sourceAtomIndex < sourceAtoms.length && sourceAtoms[sourceAtomIndex].start < range.end) {
      const atom = sourceAtoms[sourceAtomIndex];
      if (atom.start < range.start || atom.end > range.end) {
        throw codedError("RAW_ASCII_PARTIAL_TOKEN_BLOCKED", "参数替换边界切入了一个 PVF token；请扩大为完整参数行或完整块。");
      }
      oldAtoms.push(atom);
      sourceAtomIndex += 1;
    }
    const replacementAtoms = lexDecompiledScript(normalizedNewText);
    const mapping = alignReplacementAtoms(oldAtoms, replacementAtoms);
    for (let replacementIndex = 0; replacementIndex < replacementAtoms.length; replacementIndex += 1) {
      const atom = replacementAtoms[replacementIndex];
      const mapped = mapping.get(replacementIndex);
      if (mapped && atomIdentity(mapped) === atomIdentity(atom)) {
        outputTokens.push(...mapped.rawTokens);
        continue;
      }
      if (atom.kind === "number") {
        const type = numericTokenTypeForReplacement(atom.valueText, mapped);
        if (![2, 3, 4, 10].includes(type)) throw codedError("RAW_ASCII_NUMBER_TYPE_UNSAFE", "新增数字无法继承明确的原始 token 类型。");
        outputTokens.push({ type, value: numericValueForToken(atom.valueText, type) });
        changedTokenIndexes.push(outputTokens.length - 1);
        if (!mapped || mapped.rawNumericType !== type) {
          numericTypeTransitions.push({
            outputTokenIndex: outputTokens.length - 1,
            fromType: mapped?.kind === "number" ? mapped.rawNumericType : null,
            toType: type,
            valueText: atom.valueText,
          });
        }
        continue;
      }
      if (atom.kind === "string" || atom.kind === "section" || atom.kind === "typed-string") {
        const value = atom.value;
        const candidates = sourceAtoms.filter((oldAtom) =>
          oldAtom.kind === atom.kind && atomIdentity(oldAtom) === atomIdentity(atom));
        if (candidates.length > 0) {
          outputTokens.push(...candidates[0].rawTokens);
          continue;
        }
        let tokenType;
        if (atom.kind === "section") tokenType = 5;
        else if (atom.kind === "typed-string") tokenType = atom.type;
        else tokenType = mapped?.rawTokens?.length === 1 ? mapped.rawTokens[0].type : 7;
        if (atom.kind === "typed-string" && ![6, 7, 8, 10].includes(tokenType)) {
          throw codedError("RAW_ASCII_TOKEN_PLAN_UNSAFE", `带类型字符串使用了未验证的 token 类型：${tokenType}。`);
        }
        if (atom.kind === "string" && ![6, 7, 8, 10].includes(tokenType)) {
          throw codedError("RAW_ASCII_TOKEN_PLAN_UNSAFE", `字符串无法继承安全的原始 token 类型：${tokenType}。`);
        }
        outputTokens.push({ type: tokenType, value: stringIndexForNewAsciiValue(value) });
        changedTokenIndexes.push(outputTokens.length - 1);
        continue;
      }
      throw codedError("RAW_ASCII_TOKEN_PLAN_UNSAFE", "原始参数补丁只允许保留既有非数字 token；新增/修改标签、字符串或 StringLink 仍被阻止。");
    }
  }
  while (sourceAtomIndex < sourceAtoms.length) {
    outputTokens.push(...sourceAtoms[sourceAtomIndex].rawTokens);
    sourceAtomIndex += 1;
  }
  const patchedScriptBytes = encodeScriptTokens(scriptBytes, outputTokens);
  const patchedTokens = parseTokens(patchedScriptBytes);
  // Bind the complete expected text back to every raw token. StringLink
  // display text is resolved by StringView outside stringtable.bin, so its
  // visible payload is deliberately not compared here; namespace and key are.
  const outputStringTable = StringTable.parse(outputStringTableBytes, encoding);
  bindAtomsToRawTokens(lexDecompiledScript(rawExpected), patchedTokens, outputStringTable);
  const outputStringEntries = parseStringTableEntries(outputStringTableBytes);
  const preservedStringEntriesSha256 = entrySequenceSha256(outputStringEntries.slice(0, originalStringEntries.length));
  const existingStringEntriesPreserved = preservedStringEntriesSha256 === originalStringEntriesSha256;
  if (!existingStringEntriesPreserved) {
    throw codedError("RAW_ASCII_STRING_TABLE_PRESERVATION_FAILED", "参数补丁未能保持既有字符串表条目不变。");
  }
  return {
    noOp: false,
    stringTableBytes: outputStringTableBytes,
    scriptBytes: patchedScriptBytes,
    expectedText: rawExpected,
    proof: {
      mode: "raw-ascii-script-token",
      ...(staticEventAppend ? { staticEventAppend } : {}),
      encoding,
      occurrenceCount: actualOccurrences,
      expectedOccurrences,
      totalOccurrenceCount: anchored.totalOccurrenceCount,
      scopedOccurrenceCount: anchored.scopedOccurrenceCount,
      contextAnchor: anchored.evidence,
      changedTokenIndexes,
      changedTokenCount: changedTokenIndexes.length,
      numericTypeTransitions,
      numericTypeTransitionCount: numericTypeTransitions.length,
      floatTokenWriteCount: changedTokenIndexes.filter((index) => outputTokens[index]?.type === 4).length,
      originalTokenCount: tokens.length,
      outputTokenCount: outputTokens.length,
      stringTableUntouched: appendedStringIndexes.size === 0,
      existingStringEntriesPreserved,
      existingStringEntriesSha256: originalStringEntriesSha256,
      appendedStringEntryCount: appendedStringIndexes.size,
      appendedStringValueSha256s,
      scriptBeforeSha256: sha256(scriptBytes),
      scriptAfterSha256: sha256(patchedScriptBytes),
      stringTableBeforeSha256: sha256(stringTableBytes),
      stringTableAfterSha256: sha256(outputStringTableBytes),
      exactIndependentTextReadback: true,
    },
  };
}

function aniNumericTokens(value) {
  const tokens = [];
  const regex = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)/gu;
  let match;
  while ((match = regex.exec(String(value))) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function maskAniNumericTokens(value) {
  return String(value).replace(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)/gu, "#");
}

function buildRawAsciiAniPatch(input = {}) {
  const pvfPath = String(input.pvfPath || "").replace(/\\/g, "/");
  if (path.posix.extname(pvfPath.toLowerCase()) !== ".ani") {
    throw codedError("RAW_ASCII_FILE_TYPE_UNSUPPORTED", `当前未开放 ${path.posix.extname(pvfPath.toLowerCase()) || "无扩展名"} 文件的原始参数补丁。`);
  }
  if (!Buffer.isBuffer(input.sourceBytes)) {
    throw codedError("RAW_ASCII_INPUT_REQUIRED", "二进制 ANI 原始参数补丁缺少源文件字节。 ");
  }
  const inspection = inspectBinaryAni(input.sourceBytes);
  if (!inspection || inspection.fullyConsumed !== true) {
    throw codedError("RAW_ANI_BINARY_PARSE_FAILED", "既有 ANI 无法由受控解析器完整展开并消费全部原始字节；已保持阻断。");
  }
  const normalize = (value) => String(value || "").replace(/\r?\n/g, "\r\n");
  const sourceText = normalize(input.sourceText);
  const inspectedText = normalize(inspection.text);
  if (sourceText !== inspectedText) {
    throw codedError("RAW_ANI_SOURCE_TEXT_MISMATCH", "ANI 原始字节与受控展开文本不一致；请重新读取同一文件后再预演。");
  }
  const previousText = normalize(input.previousText);
  const newText = normalize(input.newText);
  if (containsNonAscii(previousText) || containsNonAscii(newText)) {
    throw codedError("RAW_ASCII_NON_ASCII_BLOCKED", "ANI 原始参数补丁只允许数字、英文、标签、Tab 和常见符号；中文必须拆成安全文字改动。");
  }
  if (!previousText || previousText === newText) {
    return {
      noOp: previousText === newText,
      bytes: input.sourceBytes,
      expectedText: sourceText,
      proof: { mode: RAW_BINARY_ANI_PATCH_MODE, noOp: previousText === newText },
    };
  }

  const anchored = analyzeContextAnchoredReplacement({
    sourceText,
    previousText,
    newText,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    scope: input.scope,
    occurrenceIndex: input.occurrenceIndex,
    replaceAll: input.replaceAll === true,
    expectedOccurrences: input.expectedOccurrences,
  });
  const mismatch = occurrenceMismatch(anchored);
  if (mismatch) throw mismatch;
  const expectedText = applyContextAnchoredReplacement({ sourceText, previousText, newText }, anchored);
  const outputBytes = Buffer.from(input.sourceBytes);
  const changedFields = [];
  const targetRanges = [];
  const seenOffsets = new Set();
  const fields = Array.isArray(inspection.fields) ? inspection.fields : [];
  const fieldAt = (start, end, text) => fields.find((field) =>
    Number(field.start) === start && Number(field.end) === end && String(field.text) === text);

  for (let occurrenceIndex = 0; occurrenceIndex < anchored.expectedOccurrences; occurrenceIndex += 1) {
    const start = anchored.occurrenceOffsets[occurrenceIndex];
    const end = start + previousText.length;
    for (const field of fields) {
      const fieldStart = Number(field.start);
      const fieldEnd = Number(field.end);
      const intersects = fieldStart < end && fieldEnd > start;
      const contained = fieldStart >= start && fieldEnd <= end;
      if (intersects && !contained) {
        throw codedError("RAW_ANI_PARTIAL_FIELD_BLOCKED", "ANI 参数替换边界切入了一个完整字段；请扩大为完整帧块或完整参数范围。");
      }
    }
    const oldSegment = sourceText.slice(start, end);
    const newSegment = newText;
    if (maskAniNumericTokens(oldSegment) !== maskAniNumericTokens(newSegment)) {
      throw codedError("RAW_ANI_STRUCTURE_CHANGE_BLOCKED", "ANI 受控补丁只能改变既有数值；标签、路径、空白和结构必须保持不变。");
    }
    const oldTokens = aniNumericTokens(oldSegment);
    const newTokens = aniNumericTokens(newSegment);
    if (oldTokens.length !== newTokens.length) {
      throw codedError("RAW_ANI_STRUCTURE_CHANGE_BLOCKED", "ANI 参数补丁不能新增或删除数值 token。");
    }
    for (let tokenIndex = 0; tokenIndex < oldTokens.length; tokenIndex += 1) {
      const oldToken = oldTokens[tokenIndex];
      const newToken = newTokens[tokenIndex];
      const field = fieldAt(start + oldToken.start, start + oldToken.end, oldToken.text);
      if (!field) {
        if (oldToken.text !== newToken.text) {
          throw codedError("RAW_ANI_LITERAL_CHANGE_BLOCKED", "ANI 帧编号或其他非字段数字不能通过此参数补丁修改。");
        }
        continue;
      }
      if (oldToken.text === newToken.text) continue;
      if (String(field.tag).toUpperCase() !== "DELAY" || String(field.kind) !== "i32" || Number(field.width) !== 4) {
        throw codedError("RAW_ANI_FIELD_CHANGE_BLOCKED", "当前 ANI 受控路线仅开放既有 [DELAY] 的 32 位整数值替换。");
      }
      if (!/^-?\d+$/u.test(newToken.text)) {
        throw codedError("RAW_ANI_DELAY_INTEGER_REQUIRED", "[DELAY] 只能替换为十进制整数。");
      }
      const value = Number(newToken.text);
      if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
        throw codedError("RAW_ANI_DELAY_OUT_OF_RANGE", "[DELAY] 数值超出有符号 32 位范围。");
      }
      const offset = Number(field.offset);
      if (seenOffsets.has(offset)) throw codedError("RAW_ANI_OVERLAPPING_TARGET", "ANI 补丁目标字段发生重叠；请缩小范围。");
      seenOffsets.add(offset);
      outputBytes.writeInt32LE(value, offset);
      const range = { offset, length: 4, tag: "DELAY" };
      targetRanges.push(range);
      changedFields.push({ offset, width: 4, tag: "DELAY", previousText: oldToken.text, newText: newToken.text });
    }
  }
  if (changedFields.length === 0) throw codedError("RAW_ANI_NO_NUMERIC_CHANGE", "ANI 补丁没有检测到允许的 [DELAY] 数值变化。");

  const targetBytes = new Uint8Array(input.sourceBytes.length);
  for (const range of targetRanges) {
    for (let index = range.offset; index < range.offset + range.length; index += 1) targetBytes[index] = 1;
  }
  for (let index = 0; index < input.sourceBytes.length; index += 1) {
    if (input.sourceBytes[index] !== outputBytes[index] && targetBytes[index] !== 1) {
      throw codedError("RAW_ANI_NON_TARGET_BYTES_CHANGED", "ANI 补丁改变了目标字段以外的原始字节；已停止写入。");
    }
  }
  const outputInspection = inspectBinaryAni(outputBytes);
  if (!outputInspection || outputInspection.fullyConsumed !== true || normalize(outputInspection.text) !== expectedText) {
    throw codedError("RAW_ANI_READBACK_FAILED", "ANI 原始字节补丁的独立展开读回与预期文本不一致。");
  }
  const sourceRawSha256 = sha256(input.sourceBytes);
  const outputRawSha256 = sha256(outputBytes);
  return {
    noOp: false,
    bytes: outputBytes,
    expectedText,
    proof: {
      mode: RAW_BINARY_ANI_PATCH_MODE,
      encoding: "binary-ani",
      textEncoding: input.pvfEncoding || null,
      occurrenceCount: anchored.occurrenceCount,
      expectedOccurrences: anchored.expectedOccurrences,
      totalOccurrenceCount: anchored.totalOccurrenceCount,
      scopedOccurrenceCount: anchored.scopedOccurrenceCount,
      contextAnchor: anchored.evidence,
      sourceTextSha256: sha256(sourceText),
      finalTextSha256: sha256(expectedText),
      sourceRawSha256,
      outputRawSha256,
      scriptBeforeSha256: sourceRawSha256,
      scriptAfterSha256: outputRawSha256,
      sourceRawByteLength: input.sourceBytes.length,
      outputRawByteLength: outputBytes.length,
      rawBytePreservingPatch: true,
      wholeFileReencodingUsed: false,
      nonTargetRawBytesPreserved: true,
      exactIndependentTextReadback: true,
      sourceBinaryParseFullyConsumed: inspection.fullyConsumed === true,
      outputBinaryParseFullyConsumed: outputInspection.fullyConsumed === true,
      sourceDecodedTextBound: true,
      existingStringEntriesPreserved: true,
      stringTableUntouched: true,
      appendedStringEntryCount: 0,
      changedFieldCount: changedFields.length,
      changedFieldTags: [...new Set(changedFields.map((field) => field.tag))],
      targetRanges,
      targetRangesSha256: sha256(JSON.stringify(targetRanges)),
      changedFields,
      changedFieldsSha256: sha256(JSON.stringify(changedFields)),
      preservedRawByteCount: input.sourceBytes.length - targetRanges.reduce((sum, range) => sum + range.length, 0),
      removedRawByteCount: 0,
      insertedRawByteCount: 0,
    },
  };
}

function createFixtureStringTable(values, encoding = "Cn") {
  const encoded = values.map((value) => encodeLegacyText(value, encoding));
  const count = encoded.length;
  const headerLength = 4 + (count + 1) * 4;
  const output = Buffer.alloc(headerLength + encoded.reduce((sum, item) => sum + item.length, 0));
  output.writeInt32LE(count, 0);
  let relativeOffset = headerLength - 4;
  let dataOffset = headerLength;
  for (let index = 0; index < encoded.length; index += 1) {
    output.writeUInt32LE(relativeOffset, 4 + index * 4);
    encoded[index].copy(output, dataOffset);
    relativeOffset += encoded[index].length;
    dataOffset += encoded[index].length;
  }
  output.writeUInt32LE(relativeOffset, 4 + count * 4);
  return output;
}

function createFixtureScript(tokens) {
  const output = Buffer.alloc(2 + tokens.length * 5);
  output[0] = 0xb0;
  output[1] = 0xd0;
  for (let index = 0; index < tokens.length; index += 1) {
    output[2 + index * 5] = tokens[index][0];
    output.writeUInt32LE(tokens[index][1] >>> 0, 3 + index * 5);
  }
  return output;
}

function createFixtureBinaryAni(delay = 80) {
  const image = Buffer.from("Monster/fixture1.img", "ascii");
  const output = Buffer.alloc(32 + image.length);
  let cursor = 0;
  output.writeUInt16LE(1, cursor); cursor += 2;
  output.writeUInt16LE(1, cursor); cursor += 2;
  output.writeInt32LE(image.length, cursor); cursor += 4;
  image.copy(output, cursor); cursor += image.length;
  output.writeUInt16LE(0, cursor); cursor += 2;
  output.writeUInt16LE(0, cursor); cursor += 2;
  output.writeInt16LE(0, cursor); cursor += 2;
  output.writeUInt16LE(65, cursor); cursor += 2;
  output.writeInt32LE(-252, cursor); cursor += 4;
  output.writeInt32LE(-379, cursor); cursor += 4;
  output.writeUInt16LE(1, cursor); cursor += 2;
  output.writeUInt16LE(12, cursor); cursor += 2;
  output.writeInt32LE(delay, cursor);
  return output;
}

function stringLinkDetachSelfTest() {
  const checks = [];
  for (const encoding of ["Cn", "Tw"]) {
    const empty = Buffer.alloc(8); empty.writeUInt32LE(4, 4);
    const table = appendStringTableEntries(empty, ["[name]", "shared_key", "[name2]", "[grade]"]
      .map((text) => encodeLegacyText(text, encoding))).bytes;
    const raw = encodeScriptTokens(Buffer.from([0xb0, 0xd0]), [
      { type: 5, value: 0 }, { type: 9, value: 13 }, { type: 10, value: 1 },
      { type: 5, value: 2 }, { type: 9, value: 13 }, { type: 10, value: 1 },
      { type: 5, value: 3 }, { type: 2, value: 1 },
    ]);
    const link = "<13::shared_key`Old name`>";
    const sourceText = `[name]\r\n${link}\r\n[name2]\r\n${link}\r\n[grade]\r\n1`;
    const change = { id: "detach", textWriteMode: VERIFIED_STRINGLINK_DETACH_MODE, pvfEncoding: encoding,
      previousText: link, newText: "`魂息`", contextBefore: "[name]\r\n", replaceAll: false };
    const input = { pvfPath: "stackable/fixture.stk", pvfEncoding: encoding,
      sourceText, scriptBytes: raw, stringTableBytes: table, changes: [change] };
    const patch = buildVerifiedInlineTextBatchPatch(input);
    const tokens = parseTokens(patch.scriptBytes);
    checks.push({ id: `stringlink-detach-${encoding}-preserves-shared-reference-and-nontarget-bytes`,
      ok: tokens.length === 7 && tokens[1].type === 7 &&
        StringTable.parse(patch.stringTableBytes, encoding).get(tokens[1].value) === "魂息" &&
        patch.scriptBytes.subarray(12).equals(raw.subarray(17)) &&
        entrySequenceSha256(parseStringTableEntries(patch.stringTableBytes).slice(0, 4)) === entrySequenceSha256(parseStringTableEntries(table)) });
    for (const [id, override, target] of [
      ["ordinary-mode", { textWriteMode: VERIFIED_INLINE_TEXT_MODE }],
      ["partial-display", { previousText: "`Old name`" }],
      ["new-link", { newText: "<13::other`Other`>" }],
      ["wrong-parent", { contextBefore: "[name2]\r\n" }],
      ["bulk", { replaceAll: true, expectedOccurrences: 2 }],
      ["unencodable", { newText: "`😀`" }],
      ["missing-encoding", { pvfEncoding: null }],
      ["protected-file", {}, "etc/fixture.str"],
      ["forged-key", { previousText: "<13::forged`Old name`>" }],
    ]) {
      let rejected = false;
      try { buildVerifiedInlineTextBatchPatch({ ...input, pvfPath: target || input.pvfPath, changes: [{ ...change, ...override }] }); }
      catch { rejected = true; }
      checks.push({ id: `stringlink-detach-${encoding}-${id}-rejected`, ok: rejected });
    }
  }
  return checks;
}

function eventIntroWriterSelfTest() {
  const checks = [];
  for (const encoding of ["Cn", "Tw"]) {
    const oldValue = encoding === "Tw" ? "舊版說明\r\n第二行" : "旧版说明\r\n第二行";
    const newValue = encoding === "Tw" ? "新版說明\r\n搭配指南" : "新版说明\r\n搭配指南";
    const sourceText = "#PVF_File\r\n[entry]\r\n[event info]\r\n-1\t2\t4\r\n`fixture\r\nevent`\r\n`Intro`\r\n`20260101`\r\n`20261231`\r\n`" + oldValue + "`\r\n[/event info]\r\n[popupwindow design]\r\n[title]\r\n`Intro`\r\n[explain]\r\n`" + oldValue + "`\t230\r\n[using ok button]\r\n1\r\n[/popupwindow design]\r\n[/entry]\r\n";
    const strings = [], tokens = [];
    for (const match of sourceText.matchAll(/`[^`]*`|\[[^\]]+\]|-?\d+/g)) {
      const value = match[0];
      if (/^-?\d+$/u.test(value)) tokens.push([2, Number(value)]);
      else {
        const decoded = value.startsWith("`") ? value.slice(1, -1) : value;
        let index = strings.indexOf(decoded);
        if (index < 0) { index = strings.length; strings.push(decoded); }
        tokens.push([value.startsWith("`") ? 7 : 5, index]);
      }
    }
    const input = { pvfPath: "event/eventlistwindow.evt", pvfEncoding: encoding,
      textWriteMode: VERIFIED_INLINE_TEXT_MODE, sourceText,
      previousText: "`" + oldValue + "`", newText: "`" + newValue + "`",
      replaceAll: true, expectedOccurrences: 2,
      stringTableBytes: createFixtureStringTable(strings, encoding), scriptBytes: createFixtureScript(tokens) };
    const patched = buildVerifiedInlineTextPatch(input);
    const table = StringTable.parse(patched.stringTableBytes, encoding);
    const outputTokens = parseTokens(patched.scriptBytes);
    const originalTokens = parseTokens(input.scriptBytes);
    checks.push({ id: `event-intro-${encoding}-paired-raw-roundtrip`, ok:
      outputTokens.filter(t => t.type === 7 && table.get(t.value) === newValue).length === 2 &&
      strings.every((s, i) => table.get(i) === s) &&
      patched.proof.existingStringEntriesPreserved === true &&
      outputTokens.every((t, i) => tokens[i][0] === t.type &&
        (tokens[i][0] === 7 && strings[tokens[i][1]] === oldValue || t.value === originalTokens[i].value)) });
    const negatives = [
      ["title-newline", { previousText: "`Intro`", newText: "`Title\nNext`" }, "CN_TEXT_SINGLE_LINE_TOKEN_REQUIRED"],
      ["pair", { replaceAll: false, expectedOccurrences: undefined, contextBefore: "[explain]\r\n" }, "CN_TEXT_EVENT_INTRO_PAIR_REQUIRED"],
      ["count", { expectedOccurrences: 3 }, null],
      ["url", { newText: "`https://example.invalid/`" }, "CN_TEXT_EVENT_INTRO_PLAIN_TEXT_REQUIRED"],
      ["markup", { newText: "`<html>guide</html>`" }, "CN_TEXT_EVENT_INTRO_PLAIN_TEXT_REQUIRED"],
      ["placeholder", { newText: "`guide %s`" }, "CN_TEXT_PLACEHOLDER_SIGNATURE_CHANGED"],
      ["other-path", { pvfPath: "event/other.evt" }, "CN_TEXT_PARENT_TAG_UNSUPPORTED"],
    ];
    for (const [id, override, code] of negatives) {
      let error;
      try { buildVerifiedInlineTextPatch({ ...input, ...override }); } catch (caught) { error = caught; }
      checks.push({ id: `event-intro-${encoding}-${id}-blocked`, ok: Boolean(error && (!code || error.code === code)) });
    }
    const titled = buildVerifiedInlineTextPatch({ ...input, previousText: "`Intro`", newText: "`Independent guide`" });
    checks.push({ id: `event-intro-${encoding}-paired-title-roundtrip`, ok: titled.proof.existingStringEntriesPreserved === true });
    const titleAndBody = buildVerifiedInlineTextBatchPatch({ ...input, changes: [
      { ...input, id: "title", previousText: "`Intro`", newText: "`Independent guide`" },
      { ...input, id: "body" },
    ] });
    checks.push({ id: `event-intro-${encoding}-title-then-body-batch`, ok:
      titleAndBody.sourceText === sourceText.replaceAll("`Intro`", "`Independent guide`").replaceAll(input.previousText, input.newText) &&
      titleAndBody.proof.existingStringEntriesPreserved === true });
    const suffix = "[using ok button]\r\n1\r\n[/popupwindow design]\r\n[/entry]";
    const added = sourceText.slice(sourceText.indexOf("[entry]")).replaceAll("`Intro`", "`Separate guide`").replaceAll("`" + oldValue + "`", "`New guide body`");
    const appendInput = { ...input, previousText: suffix, newText: suffix + "\r\n" + added, replaceAll: false, expectedOccurrences: 1 };
    const appended = buildRawAsciiScriptPatch(appendInput);
    const trailingAppend = buildRawAsciiScriptPatch({ ...appendInput,
      previousText: suffix + "\r\n", newText: suffix + "\r\n\r\n" + added });
    checks.push({ id: `event-intro-${encoding}-append-trailing-newline`, ok:
      trailingAppend.proof.staticEventAppend?.originalTextPreserved === true &&
      trailingAppend.expectedText.startsWith(sourceText) });
    checks.push({ id: `event-intro-${encoding}-static-append`, ok: appended.proof.staticEventAppend?.originalTextPreserved === true && appended.proof.existingStringEntriesPreserved === true && appended.expectedText.startsWith(sourceText.trimEnd()) });
    for (const [id, override] of [
      ["other-path", { pvfPath: "event/other.evt" }],
      ["metadata", { newText: appendInput.newText.replace("-1\t2\t4", "-2\t2\t4") }],
      ["code-change", { newText: appendInput.newText.replace("fixture\r\nevent", "changed\r\nevent") }],
      ["double-entry", { newText: appendInput.newText + added }],
      ["original-change", { newText: appendInput.newText.replace("button]\r\n1", "button]\r\n0") }],
      ["duplicate-title", { newText: appendInput.newText.replaceAll("Separate guide", "Intro") }],
      ["ordinary-edit", { previousText: "[using ok button]\r\n1", newText: "[using ok button]\r\n0" }],
    ]) {
      let rejected = false;
      try { buildRawAsciiScriptPatch({ ...appendInput, ...override }); } catch { rejected = true; }
      checks.push({ id: `event-intro-${encoding}-append-${id}-blocked`, ok: rejected });
    }
  }
  return checks;
}

function scalarTextSelfTest() {
  const checks = [];
  for (const encoding of ["Cn", "Tw"]) {
    const empty = Buffer.alloc(8); empty.writeUInt32LE(4, 4);
    const values = ["[custom caption]", "魂息 %d", "[value]"];
    const table = appendStringTableEntries(empty, values.map(text => encodeLegacyText(text, encoding))).bytes;
    const raw = createFixtureScript([[5, 0], [7, 1], [5, 2], [2, 42]]);
    const sourceText = "[custom caption]\r\n" + "`魂息 %d`" + "\r\n[value]\r\n42";
    const input = { pvfPath: "stackable/custom.stk", sourceText, pvfEncoding: encoding,
      previousText: "`魂息 %d`", newText: "`魂息 %d 新`", textWriteMode: "verified-scalar-text",
      replaceAll: false, stringTableBytes: table, scriptBytes: raw };
    const single = buildVerifiedInlineTextPatch(input);
    const batch = buildVerifiedInlineTextBatchPatch({ ...input, changes: [{ ...input, id: "custom" }] });
    checks.push({ id: "scalar-" + encoding + "-single-and-batch-preserve-raw-and-old-strings", ok:
      single.scriptBytes.equals(batch.scriptBytes) && single.scriptBytes.subarray(12).equals(raw.subarray(12)) &&
      entrySequenceSha256(parseStringTableEntries(batch.stringTableBytes).slice(0, values.length)) === entrySequenceSha256(parseStringTableEntries(table)) &&
      batch.proofs[0].eligibilityProofs[0].semanticMeaningVerified === false &&
      batch.proofs[0].eligibilityProofs[0].runtimeValidationRequired === true });
    for (const [id, override] of [
      ["ordinary-mode", { textWriteMode: "verified-inline-text" }],
      ["record-values", { sourceText: sourceText.replace("\r\n[value]", "\t1\r\n[value]") }],
      ["partial", { previousText: "魂息 %d" }],
      ["placeholder", { newText: "`魂息 %s 新`" }],
      ["unencodable", { newText: "`魂息 %d 😀`" }],
      ["protected", { pvfPath: "sqr/custom.nut" }],
      ["event", { pvfPath: "event/custom.evt" }],
      ["known-structured-tag", { sourceText: sourceText.replace("custom caption", "tower dialog"), pvfPath: "dungeon/custom.dgn" }],
      ["stringlink", { sourceText: sourceText.replace("`魂息 %d`", "<0::shared`魂息 %d`>") }],
      ["count", { expectedOccurrences: 2, replaceAll: true }],
      ["nested-string-spoof", { sourceText: "[explain]\r\n`outer\r\n[custom caption]\r\n`魂息 %d`\r\n[value]\r\n42`" }],
    ]) {
      let code = null; try { analyzeVerifiedInlineTextChange({ ...input, ...override }); } catch(error) { code=error.code; }
      checks.push({ id: "scalar-" + encoding + "-" + id + "-rejected", ok: !!code, code });
    }
  }
  return checks;
}

function verifiedInlineTextSelfTest() {
  const checks = [...scalarTextSelfTest(), ...stringLinkDetachSelfTest(), ...eventIntroWriterSelfTest()];
  const sourceText = "#PVF_File\r\n[name]\r\n`旧描述`\r\n";
  const table = createFixtureStringTable(["[name]", "旧描述"], "Cn");
  const script = createFixtureScript([[5, 0], [7, 1]]);
  const patch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
    pvfPath: "stackable/fixture.stk",
    pvfEncoding: "Cn",
    sourceText,
    previousText: "`旧描述`",
    newText: "`新描述测试`",
    replaceAll: false,
    stringTableBytes: table,
    scriptBytes: script,
  });
  const outputTable = StringTable.parse(patch.stringTableBytes, "Cn");
  const outputTokens = parseTokens(patch.scriptBytes);
  checks.push({
    id: "gbk-inline-text-patch-roundtrip",
    ok:
      outputTable.get(outputTokens[1].value) === "新描述测试" &&
      patch.proof.existingStringEntriesPreserved === true &&
      outputTable.get(1) === "旧描述",
  });

  const twSourceText = "#PVF_File\r\n[condition message]\r\n`將任意裝備強化至+20以上一次。`\r\n";
  const twTable = createFixtureStringTable(["[condition message]", "將任意裝備強化至+20以上一次。"], "Tw");
  const twScript = createFixtureScript([[5, 0], [7, 1]]);
  const twPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "n_quest/title/fixture.qst",
    pvfEncoding: "Tw",
    sourceText: twSourceText,
    previousText: "`將任意裝備強化至+20以上一次。`",
    newText: "`將任意裝備強化至+15以上一次。`",
    replaceAll: false,
    stringTableBytes: twTable,
    scriptBytes: twScript,
  });
  const twOutputTable = StringTable.parse(twPatch.stringTableBytes, "Tw");
  const twOutputTokens = parseTokens(twPatch.scriptBytes);
  checks.push({
    id: "big5-inline-text-patch-roundtrip",
    ok:
      twOutputTable.get(twOutputTokens[1].value) === "將任意裝備強化至+15以上一次。" &&
      twPatch.proof.encoding === "Tw" &&
      twPatch.proof.existingStringEntriesPreserved === true &&
      twOutputTable.get(1) === "將任意裝備強化至+20以上一次。",
  });

  const towerDialogSourceText = [
    "#PVF_File",
    "[tower dialog]",
    "1",
    "`歡迎來到第一層`",
    "`on start`",
    "[tower dialog]",
    "2",
    "`第二層歡迎\r\n請繼續前進`",
    "`on complete`",
    "",
  ].join("\r\n");
  const towerDialogTable = createFixtureStringTable([
    "[tower dialog]",
    "歡迎來到第一層",
    "on start",
    "第二層歡迎\r\n請繼續前進",
    "on complete",
  ], "Tw");
  const towerDialogScript = createFixtureScript([
    [5, 0], [2, 1], [7, 1], [7, 2],
    [5, 0], [2, 2], [7, 3], [7, 4],
  ]);
  const towerDialogSinglePatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "dungeon/Towers/TowerOfIllusion.dgn",
    pvfEncoding: "Tw",
    sourceText: towerDialogSourceText,
    previousText: "`歡迎來到第一層`",
    newText: "`歡迎來到幻影之塔第一層`",
    replaceAll: false,
    stringTableBytes: towerDialogTable,
    scriptBytes: towerDialogScript,
  });
  const towerDialogSingleTable = StringTable.parse(towerDialogSinglePatch.stringTableBytes, "Tw");
  const towerDialogSingleTokens = parseTokens(towerDialogSinglePatch.scriptBytes);
  checks.push({
    id: "big5-dgn-tower-dialog-on-start-complete-token-roundtrip",
    ok:
      towerDialogSingleTable.get(towerDialogSingleTokens[2].value) === "歡迎來到幻影之塔第一層" &&
      towerDialogSinglePatch.proof.parentTag === "tower dialog" &&
      towerDialogSinglePatch.proof.structuredContainerProofs?.[0]?.event === "on start" &&
      towerDialogSinglePatch.proof.structuredContainerProofs?.[0]?.floor === 1 &&
      towerDialogSinglePatch.proof.existingStringEntriesPreserved === true,
  });
  const towerDialogMultilinePatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "dungeon/Towers/TowerOfIllusion.dgn",
    pvfEncoding: "Tw",
    sourceText: towerDialogSourceText,
    previousText: "`第二層歡迎\r\n請繼續前進`",
    newText: "`第二層歡迎\r\n請擊敗所有敵人後繼續前進`",
    replaceAll: false,
    stringTableBytes: towerDialogTable,
    scriptBytes: towerDialogScript,
  });
  const towerDialogMultilineTable = StringTable.parse(towerDialogMultilinePatch.stringTableBytes, "Tw");
  const towerDialogMultilineTokens = parseTokens(towerDialogMultilinePatch.scriptBytes);
  checks.push({
    id: "big5-dgn-tower-dialog-on-complete-multiline-roundtrip",
    ok:
      towerDialogMultilineTable.get(towerDialogMultilineTokens[6].value) === "第二層歡迎\r\n請擊敗所有敵人後繼續前進" &&
      towerDialogMultilinePatch.proof.structuredContainerProofs?.[0]?.event === "on complete" &&
      towerDialogMultilinePatch.proof.structuredContainerProofs?.[0]?.floor === 2,
  });
  let towerDialogEventTokenCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "dungeon/Towers/TowerOfIllusion.dgn",
      pvfEncoding: "Tw",
      sourceText: towerDialogSourceText,
      previousText: "`on start`",
      newText: "`開始時`",
      replaceAll: false,
    });
  } catch (error) { towerDialogEventTokenCode = error.code; }
  checks.push({
    id: "dgn-tower-dialog-event-token-remains-logic-and-blocked",
    ok: towerDialogEventTokenCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: towerDialogEventTokenCode,
  });
  let malformedTowerDialogCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "dungeon/Towers/TowerOfIllusion.dgn",
      pvfEncoding: "Tw",
      sourceText: towerDialogSourceText.replace("`on start`", "`on enter`") ,
      previousText: "`歡迎來到第一層`",
      newText: "`結構不完整時不得寫入`",
      replaceAll: false,
    });
  } catch (error) { malformedTowerDialogCode = error.code; }
  checks.push({
    id: "dgn-tower-dialog-unknown-event-remains-blocked",
    ok: malformedTowerDialogCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: malformedTowerDialogCode,
  });
  let duplicateTowerDialogCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "dungeon/Towers/TowerOfIllusion.dgn",
      pvfEncoding: "Tw",
      sourceText: towerDialogSourceText.replace("`第二層歡迎\r\n請繼續前進`", "`歡迎來到第一層`"),
      previousText: "`歡迎來到第一層`",
      newText: "`未定位的重複對話不得猜測`",
      replaceAll: false,
    });
  } catch (error) { duplicateTowerDialogCode = error.code; }
  checks.push({
    id: "dgn-tower-dialog-duplicate-without-context-remains-blocked",
    ok: duplicateTowerDialogCode === "OCCURRENCE_COUNT_MISMATCH",
    code: duplicateTowerDialogCode,
  });

  const explainExSourceText = [
    "#PVF_File",
    "[explain ex]",
    "`每級增加技能攻擊力。`",
    "[explain ex]",
    "`每級增加技能攻擊力。`",
    "",
  ].join("\r\n");
  const explainExTable = createFixtureStringTable(["[explain ex]", "每級增加技能攻擊力。"], "Tw");
  const explainExScript = createFixtureScript([[5, 0], [7, 1], [5, 0], [7, 1]]);
  const explainExPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "skill/swordman/fixture.skl",
    pvfEncoding: "Tw",
    sourceText: explainExSourceText,
    previousText: "`每級增加技能攻擊力。`",
    newText: "`每級增加技能攻擊力與範圍。`",
    replaceAll: true,
    expectedOccurrences: 2,
    stringTableBytes: explainExTable,
    scriptBytes: explainExScript,
  });
  const explainExOutputTable = StringTable.parse(explainExPatch.stringTableBytes, "Tw");
  const explainExOutputTokens = parseTokens(explainExPatch.scriptBytes);
  checks.push({
    id: "big5-skl-explain-ex-two-complete-tokens-roundtrip",
    ok:
      explainExPatch.proof.parentTag === "explain ex" &&
      explainExPatch.proof.visibleTextFamilyProofs?.every((item) => item.baseTag === "explain") &&
      explainExPatch.proof.occurrenceCount === 2 &&
      explainExPatch.proof.existingStringEntriesPreserved === true &&
      explainExOutputTable.get(explainExOutputTokens[1].value) === "每級增加技能攻擊力與範圍。" &&
      explainExOutputTable.get(explainExOutputTokens[3].value) === "每級增加技能攻擊力與範圍。",
  });
  const basicExplainExSourceText = [
    "#PVF_File",
    "[basic explain ex]",
    "`特性技能的備用基礎說明。`",
    "",
  ].join("\r\n");
  const basicExplainExTable = createFixtureStringTable(["[basic explain ex]", "特性技能的備用基礎說明。"], "Tw");
  const basicExplainExScript = createFixtureScript([[5, 0], [7, 1]]);
  const basicExplainExPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "skill/swordman/fixture.skl",
    pvfEncoding: "Tw",
    sourceText: basicExplainExSourceText,
    previousText: "`特性技能的備用基礎說明。`",
    newText: "`特性技能的完整備用基礎說明。`",
    replaceAll: false,
    stringTableBytes: basicExplainExTable,
    scriptBytes: basicExplainExScript,
  });
  const basicExplainExOutputTable = StringTable.parse(basicExplainExPatch.stringTableBytes, "Tw");
  const basicExplainExOutputTokens = parseTokens(basicExplainExPatch.scriptBytes);
  checks.push({
    id: "big5-skl-basic-explain-ex-visible-family-roundtrip",
    ok:
      basicExplainExPatch.proof.parentTag === "basic explain ex" &&
      basicExplainExPatch.proof.visibleTextFamilyProofs?.[0]?.mode === "skl-visible-text-ex-variant" &&
      basicExplainExPatch.proof.visibleTextFamilyProofs?.[0]?.baseTag === "basic explain" &&
      basicExplainExPatch.proof.existingStringEntriesPreserved === true &&
      basicExplainExOutputTable.get(basicExplainExOutputTokens[1].value) === "特性技能的完整備用基礎說明。",
  });
  const skillExplainExAnalysis = analyzeVerifiedInlineTextChange({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "skill/swordman/future-variant.skl",
    pvfEncoding: "Tw",
    sourceText: "[skill explain ex]\r\n`未來同構說明`\r\n",
    previousText: "`未來同構說明`",
    newText: "`未來同構說明已驗證`",
    replaceAll: false,
  });
  checks.push({
    id: "skl-known-visible-base-plus-ex-variant-generalizes",
    ok:
      skillExplainExAnalysis.allowed === true &&
      skillExplainExAnalysis.parentTag === "skill explain ex" &&
      skillExplainExAnalysis.visibleTextFamilyProofs?.[0]?.baseTag === "skill explain",
  });
  let unknownExplainExBaseCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "skill/swordman/unknown-variant.skl",
      pvfEncoding: "Tw",
      sourceText: "[logic explain ex]\r\n`不得把未知基礎標籤當成說明`\r\n",
      previousText: "`不得把未知基礎標籤當成說明`",
      newText: "`此變體仍須阻斷`",
      replaceAll: false,
    });
  } catch (error) { unknownExplainExBaseCode = error.code; }
  checks.push({
    id: "skl-unknown-visible-base-plus-ex-variant-remains-blocked",
    ok: unknownExplainExBaseCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: unknownExplainExBaseCode,
  });
  let explainExOutsideSklCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "stackable/fixture.stk",
      pvfEncoding: "Tw",
      sourceText: explainExSourceText,
      previousText: "`每級增加技能攻擊力。`",
      newText: "`此路徑不得開放。`",
      replaceAll: true,
      expectedOccurrences: 2,
    });
  } catch (error) { explainExOutsideSklCode = error.code; }
  checks.push({
    id: "explain-ex-outside-skl-remains-blocked",
    ok: explainExOutsideSklCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: explainExOutsideSklCode,
  });

  const postalSourceText = [
    "#PVF_File",
    "[send postal]",
    "2660296\t1",
    "`Title Book Reward`",
    "`Congratulations!`",
    "`The reward is sent to your mailbox.`",
    "[name]",
    "`稱號簿特殊成就獎勵`",
    "",
  ].join("\r\n");
  const postalAnalysis = analyzeVerifiedInlineTextChange({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "etc/titlebook.etc",
    pvfEncoding: "Tw",
    sourceText: postalSourceText,
    previousText: "`Title Book Reward`",
    newText: "`稱號簿鎮魂試煉獎勵`",
    replaceAll: false,
  });
  checks.push({
    id: "big5-etc-send-postal-complete-text-accepted",
    ok:
      postalAnalysis.allowed === true &&
      postalAnalysis.parentTag === "send postal" &&
      postalAnalysis.occurrenceCount === 1 &&
      postalAnalysis.requiresEncodingRoundTripProbe === true,
  });

  let postalOutsideEtcCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "etc/other-postal.etc",
      pvfEncoding: "Tw",
      sourceText: postalSourceText,
      previousText: "`Title Book Reward`",
      newText: "`稱號簿鎮魂試煉獎勵`",
      replaceAll: false,
    });
  } catch (error) { postalOutsideEtcCode = error.code; }
  checks.push({
    id: "send-postal-outside-etc-remains-blocked",
    ok: postalOutsideEtcCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: postalOutsideEtcCode,
  });

  const titlebookSectionSourceText = [
    "#PVF_File",
    "[section name]",
    "`舊稱號分類`",
    "",
  ].join("\r\n");
  const titlebookSectionPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "etc/titlebook.etc",
    pvfEncoding: "Tw",
    sourceText: titlebookSectionSourceText,
    previousText: "`舊稱號分類`",
    newText: "`新稱號分類`",
    replaceAll: false,
    stringTableBytes: createFixtureStringTable(["[section name]", "舊稱號分類"], "Tw"),
    scriptBytes: createFixtureScript([[5, 0], [7, 1]]),
  });
  const titlebookSectionOutputTable = StringTable.parse(titlebookSectionPatch.stringTableBytes, "Tw");
  const titlebookSectionOutputTokens = parseTokens(titlebookSectionPatch.scriptBytes);
  checks.push({
    id: "big5-titlebook-section-name-scalar-line-roundtrip",
    ok:
      titlebookSectionPatch.proof.parentTag === "section name" &&
      titlebookSectionPatch.proof.structuredContainerProofs?.[0]?.ruleId === TITLEBOOK_SECTION_NAME_RULE_ID &&
      titlebookSectionPatch.proof.structuredContainerProofs?.[0]?.matchedPath === "etc/titlebook.etc" &&
      titlebookSectionPatch.proof.structuredContainerProofs?.[0]?.singleLineToken === true &&
      titlebookSectionOutputTable.get(titlebookSectionOutputTokens[1].value) === "新稱號分類",
  });
  let titlebookSectionWrongPathCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "etc/other-titlebook.etc",
      pvfEncoding: "Tw",
      sourceText: titlebookSectionSourceText,
      previousText: "`舊稱號分類`",
      newText: "`新稱號分類`",
      replaceAll: false,
    });
  } catch (error) { titlebookSectionWrongPathCode = error.code; }
  checks.push({
    id: "titlebook-section-name-outside-titlebook-remains-blocked",
    ok: titlebookSectionWrongPathCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: titlebookSectionWrongPathCode,
  });
  let titlebookSectionMultilineCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "etc/titlebook.etc",
      pvfEncoding: "Tw",
      sourceText: titlebookSectionSourceText,
      previousText: "`舊稱號分類`",
      newText: "`新稱號\r\n分類`",
      replaceAll: false,
    });
  } catch (error) { titlebookSectionMultilineCode = error.code; }
  checks.push({
    id: "titlebook-section-name-multiline-remains-blocked",
    ok: titlebookSectionMultilineCode === "CN_TEXT_SINGLE_LINE_TOKEN_REQUIRED",
    code: titlebookSectionMultilineCode,
  });
  let titlebookSectionTagInjectionCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "etc/titlebook.etc",
      pvfEncoding: "Tw",
      sourceText: titlebookSectionSourceText,
      previousText: "`舊稱號分類`",
      newText: "`[section name]`",
      replaceAll: false,
    });
  } catch (error) { titlebookSectionTagInjectionCode = error.code; }
  checks.push({
    id: "titlebook-section-name-tag-injection-remains-blocked",
    ok: titlebookSectionTagInjectionCode === "CN_TEXT_TAG_INJECTION_BLOCKED",
    code: titlebookSectionTagInjectionCode,
  });

  const qstProgressSourceText = [
    "#PVF_File",
    "[condition data]",
    "0",
    "`完成次數 : %d / %d`",
    "[/condition data]",
    "",
  ].join("\r\n");
  const qstProgressPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "n_quest/title/fixture.qst",
    pvfEncoding: "Tw",
    sourceText: qstProgressSourceText,
    previousText: "`完成次數 : %d / %d`",
    newText: "`完成稱號 : %d / %d`",
    replaceAll: false,
    stringTableBytes: createFixtureStringTable(["[condition data]", "完成次數 : %d / %d", "[/condition data]"], "Tw"),
    scriptBytes: createFixtureScript([[5, 0], [2, 0], [7, 1], [5, 2]]),
  });
  const qstProgressOutputTable = StringTable.parse(qstProgressPatch.stringTableBytes, "Tw");
  const qstProgressOutputTokens = parseTokens(qstProgressPatch.scriptBytes);
  checks.push({
    id: "big5-qst-condition-data-progress-placeholder-roundtrip",
    ok:
      qstProgressPatch.proof.parentTag === "condition data" &&
      qstProgressPatch.proof.structuredContainerProofs?.[0]?.ruleId === QST_CONDITION_DATA_PROGRESS_RULE_ID &&
      qstProgressPatch.proof.structuredContainerProofs?.[0]?.conditionDataInteger === 0 &&
      qstProgressPatch.proof.structuredContainerProofs?.[0]?.placeholderSignature?.join(",") === "%d,%d" &&
      qstProgressOutputTable.get(qstProgressOutputTokens[2].value) === "完成稱號 : %d / %d",
  });
  let qstProgressPlaceholderCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "n_quest/title/fixture.qst",
      pvfEncoding: "Tw",
      sourceText: qstProgressSourceText,
      previousText: "`完成次數 : %d / %d`",
      newText: "`完成稱號 : %d`",
      replaceAll: false,
    });
  } catch (error) { qstProgressPlaceholderCode = error.code; }
  checks.push({
    id: "qst-condition-data-placeholder-signature-change-blocked",
    ok: qstProgressPlaceholderCode === "CN_TEXT_PLACEHOLDER_SIGNATURE_CHANGED",
    code: qstProgressPlaceholderCode,
  });
  let qstProgressMalformedCode = null;
  try {
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "n_quest/title/fixture.qst",
      pvfEncoding: "Tw",
      sourceText: qstProgressSourceText.replace("[/condition data]", "[next]"),
      previousText: "`完成次數 : %d / %d`",
      newText: "`完成稱號 : %d / %d`",
      replaceAll: false,
    });
  } catch (error) { qstProgressMalformedCode = error.code; }
  checks.push({
    id: "qst-condition-data-progress-unclosed-record-blocked",
    ok: qstProgressMalformedCode === "CN_TEXT_PARENT_TAG_UNSUPPORTED",
    code: qstProgressMalformedCode,
  });

  for (const fixture of [
    {
      id: "gbk-multiline-inline-text-roundtrip",
      encoding: "Cn",
      oldValue: "第一行说明\r\n第二行说明",
      newValue: "第一行已修改\r\n第二行也已修改",
    },
    {
      id: "big5-multiline-inline-text-roundtrip",
      encoding: "Tw",
      oldValue: "第一行說明\r\n第二行說明",
      newValue: "第一行已修改\r\n第二行也已修改",
    },
  ]) {
    const multilineTable = createFixtureStringTable(["[skill explain]", fixture.oldValue], fixture.encoding);
    const multilinePatch = buildVerifiedInlineTextPatch({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "stackable/multiline.stk",
      pvfEncoding: fixture.encoding,
      sourceText: `#PVF_File\r\n[skill explain]\r\n\`${fixture.oldValue}\`\r\n`,
      previousText: `\`${fixture.oldValue}\``,
      newText: `\`${fixture.newValue}\``,
      replaceAll: false,
      stringTableBytes: multilineTable,
      scriptBytes: createFixtureScript([[5, 0], [7, 1]]),
    });
    const multilineOutputTable = StringTable.parse(multilinePatch.stringTableBytes, fixture.encoding);
    const multilineOutputTokens = parseTokens(multilinePatch.scriptBytes);
    checks.push({
      id: fixture.id,
      ok: multilineOutputTable.get(multilineOutputTokens[1].value) === fixture.newValue &&
        multilinePatch.proof.existingStringEntriesPreserved === true,
    });
  }

  const batchTable = createFixtureStringTable(["[explain]", "批量旧说明"], "Cn");
  const batchSourceText = "#PVF_File\r\n[explain]\r\n`批量旧说明`\r\n[explain]\r\n`批量旧说明`\r\n";
  const batchPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "stackable/batch.stk",
    pvfEncoding: "Cn",
    sourceText: batchSourceText,
    previousText: "`批量旧说明`",
    newText: "`批量新说明`",
    replaceAll: true,
    expectedOccurrences: 2,
    stringTableBytes: batchTable,
    scriptBytes: createFixtureScript([[5, 0], [7, 1], [5, 0], [7, 1]]),
  });
  const batchOutputTable = StringTable.parse(batchPatch.stringTableBytes, "Cn");
  const batchOutputTokens = parseTokens(batchPatch.scriptBytes);
  checks.push({
    id: "verified-batch-exact-count-roundtrip",
    ok: batchPatch.proof.occurrenceCount === 2 && batchPatch.proof.newStringIndexes.length === 2 &&
      batchOutputTable.get(batchOutputTokens[1].value) === "批量新说明" &&
      batchOutputTable.get(batchOutputTokens[3].value) === "批量新说明",
  });

  const anchoredSourceText = "#PVF_File\r\n[skill]\r\n9\r\n`[swordman]`\t60\r\n[skill explain]\r\n`移動距離 +6%%`\r\n[skill]\r\n10\r\n`[fighter]`\t60\r\n[skill explain]\r\n`移動距離 +6%%`\r\n";
  const anchoredTable = createFixtureStringTable(
    ["[skill]", "[swordman]", "[skill explain]", "移動距離 +6%%", "[fighter]"],
    "Tw",
  );
  const anchoredScript = createFixtureScript([
    [5, 0], [2, 9], [7, 1], [2, 60], [5, 2], [7, 3],
    [5, 0], [2, 10], [7, 4], [2, 60], [5, 2], [7, 3],
  ]);
  const anchoredContextBefore = "[skill]\r\n9\r\n`[swordman]`\t60\r\n[skill explain]\r\n";
  const anchoredPatch = buildVerifiedInlineTextPatch({
    textWriteMode: VERIFIED_INLINE_TEXT_MODE,
    pvfPath: "stackable/consumption_1256.stk",
    pvfEncoding: "Tw",
    sourceText: anchoredSourceText,
    previousText: "`移動距離 +6%%`",
    newText: "`移動距離 +100%%`",
    contextBefore: anchoredContextBefore,
    replaceAll: false,
    stringTableBytes: anchoredTable,
    scriptBytes: anchoredScript,
  });
  const anchoredOutputTable = StringTable.parse(anchoredPatch.stringTableBytes, "Tw");
  const anchoredOutputTokens = parseTokens(anchoredPatch.scriptBytes);
  checks.push({
    id: "verified-duplicate-text-adjacent-context-selects-one-token",
    ok:
      anchoredPatch.proof.totalOccurrenceCount === 2 &&
      anchoredPatch.proof.occurrenceCount === 1 &&
      anchoredPatch.proof.contextAnchor?.anchored === true &&
      anchoredOutputTable.get(anchoredOutputTokens[5].value) === "移動距離 +100%%" &&
      anchoredOutputTable.get(anchoredOutputTokens[11].value) === "移動距離 +6%%" &&
      anchoredPatch.proof.targetTokenIndexes.length === 1,
  });

  for (const fixture of [
    {
      id: "verified-context-zero-match-blocked",
      contextBefore: "[skill]\r\n999\r\n[skill explain]\r\n",
      expectedCode: "OCCURRENCE_COUNT_MISMATCH",
    },
    {
      id: "verified-context-ambiguous-match-blocked",
      contextBefore: "[skill explain]\r\n",
      expectedCode: "OCCURRENCE_COUNT_MISMATCH",
    },
    {
      id: "verified-context-containing-target-blocked",
      contextBefore: "`移動距離 +6%%`\r\n[skill explain]\r\n",
      expectedCode: "CONTEXT_ANCHOR_CONTAINS_TARGET",
    },
  ]) {
    let code = null;
    try {
      analyzeVerifiedInlineTextChange({
        textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        pvfPath: "stackable/consumption_1256.stk",
        pvfEncoding: "Tw",
        sourceText: anchoredSourceText,
        previousText: "`移動距離 +6%%`",
        newText: "`移動距離 +100%%`",
        contextBefore: fixture.contextBefore,
        replaceAll: false,
      });
    } catch (error) { code = error.code; }
    checks.push({ id: fixture.id, ok: code === fixture.expectedCode, code });
  }

  for (const expectedOccurrences of [1, 3]) {
    let code = null;
    try {
      analyzeVerifiedInlineTextChange({
        textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        pvfPath: "stackable/batch.stk",
        pvfEncoding: "Cn",
        sourceText: batchSourceText,
        previousText: "`批量旧说明`",
        newText: "`批量新说明`",
        replaceAll: true,
        expectedOccurrences,
      });
    } catch (error) { code = error.code; }
    checks.push({
      id: `verified-batch-count-${expectedOccurrences}-blocked`,
      ok: code === "OCCURRENCE_COUNT_MISMATCH",
      code,
    });
  }

  let multilineStringLinkCode = null;
  try {
    const value = "链接第一行\r\n链接第二行";
    analyzeVerifiedInlineTextChange({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "stackable/stringlink.stk",
      pvfEncoding: "Cn",
      sourceText: `[explain]\r\n<13::fixture\`${value}\`>\r\n`,
      previousText: `\`${value}\``,
      newText: "`新的多行链接文字`",
      replaceAll: false,
    });
  } catch (error) { multilineStringLinkCode = error.code; }
  checks.push({
    id: "multiline-stringlink-inner-token-blocked",
    ok: multilineStringLinkCode === "STRINGLINK_TEXT_WRITE_UNVERIFIED",
    code: multilineStringLinkCode,
  });

  const rawTable = createFixtureStringTable(["[value]", "[skill]", "[swordman]", "[dungeon type]", "[static]", "%", "[/skill]"], "Cn");
  const rawScript = createFixtureScript([
    [5, 0], [2, 10],
    [5, 1], [2, 13], [7, 2], [2, 72], [7, 3], [7, 4], [2, 0], [7, 5], [2, 2], [5, 6],
  ]);
  const rawSource = "#PVF_File\r\n[value]\r\n10\r\n\r\n[skill]\r\n13\r\n`[swordman]`\t72\r\n`[dungeon type]`\r\n`[static]`\t0\r\n`%`\t2\r\n[/skill]\r\n";
  const rawNext = "#PVF_File\r\n[value]\r\n11\r\n\r\n[skill]\r\n13\r\n`[swordman]`\t72\r\n`[dungeon type]`\r\n`[static]`\t2\r\n`%`\t2000\r\n`[swordman]`\t72\r\n`[dungeon type]`\r\n`[static]`\t0\r\n`%`\t3\r\n[/skill]\r\n";
  const rawPatch = buildRawAsciiScriptPatch({
    pvfPath: "stackable/raw.stk", pvfEncoding: "Cn",
    sourceText: rawSource, previousText: rawSource, newText: rawNext,
    replaceAll: false, stringTableBytes: rawTable, scriptBytes: rawScript,
  });
  checks.push({
    id: "raw-ascii-parameter-token-insert-delete-roundtrip",
    ok: rawPatch.expectedText === rawNext && rawPatch.proof.stringTableUntouched === true &&
      rawPatch.proof.outputTokenCount > rawPatch.proof.originalTokenCount && rawPatch.proof.exactIndependentTextReadback === true,
  });

  const tableValues = Array.from({ length: 20 * 17 }, (_, index) => index + 1);
  const tableSourceText = `#PVF_File\r\n[table]\r\n${tableValues.join("\t")}\r\n[/table]\r\n`;
  const tableNextValues = [...tableValues];
  for (const level of [14, 15]) for (const column of [0, 1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 16]) {
    tableNextValues[level * 17 + column] = tableValues[13 * 17 + column];
  }
  const tableNextText = `#PVF_File\r\n[table]\r\n${tableNextValues.join("\t")}\r\n[/table]\r\n`;
  const largeTableStringTable = createFixtureStringTable(["[table]", "[/table]"], "Tw");
  const largeTableScript = createFixtureScript([[5, 0], ...tableValues.map((value) => [2, value]), [5, 1]]);
  const largeTablePatch = buildRawAsciiScriptPatch({
    pvfPath: "etc/upgrade.etc",
    pvfEncoding: "Tw",
    sourceText: tableSourceText,
    previousText: tableSourceText,
    newText: tableNextText,
    replaceAll: false,
    stringTableBytes: largeTableStringTable,
    scriptBytes: largeTableScript,
  });
  checks.push({
    id: "raw-ascii-fixed-width-large-table-roundtrip",
    ok:
      largeTablePatch.expectedText === tableNextText &&
      largeTablePatch.proof.originalTokenCount === largeTablePatch.proof.outputTokenCount &&
      largeTablePatch.proof.changedTokenCount === 24 &&
      largeTablePatch.proof.stringTableUntouched === true,
  });

  const phaseTable = createFixtureStringTable(["[blood phase time]", "[/blood phase time]"], "Cn");
  const phaseSource = "#PVF_File\r\n[blood phase time]\r\n1\t0\t100\t1\t5\t6\r\n[/blood phase time]\r\n";
  const phaseScript = createFixtureScript([
    [5, 0], [2, 1], [2, 0], [2, 100], [2, 1], [2, 5], [2, 6], [5, 1],
  ]);
  const phaseDecimal = "#PVF_File\r\n[blood phase time]\r\n1\t0\t100\t1.1\t5\t6\r\n[/blood phase time]\r\n";
  const phaseDecimalPatch = buildRawAsciiScriptPatch({
    pvfPath: "map/TowerOfBloodyFight/fixture.map",
    pvfEncoding: "Cn",
    sourceText: phaseSource,
    previousText: phaseSource,
    newText: phaseDecimal,
    replaceAll: false,
    stringTableBytes: phaseTable,
    scriptBytes: phaseScript,
  });
  const phaseDecimalTokens = parseTokens(phaseDecimalPatch.scriptBytes);
  checks.push({
    id: "raw-ascii-integer-token-to-float32-roundtrip",
    ok:
      phaseDecimalPatch.expectedText === phaseDecimal &&
      phaseDecimalTokens[4]?.type === 4 &&
      phaseDecimalPatch.proof.numericTypeTransitions?.some((item) => item.fromType === 2 && item.toType === 4 && item.valueText === "1.1") &&
      phaseDecimalPatch.proof.floatTokenWriteCount === 1,
  });

  const phaseExpanded = "#PVF_File\r\n[blood phase time]\r\n1\t0\t100\t1.1\t5\t6\r\n2\t0\t120\t1.3\t5\t6\r\n[/blood phase time]\r\n";
  const phaseExpandedPatch = buildRawAsciiScriptPatch({
    pvfPath: "map/TowerOfBloodyFight/fixture.map",
    pvfEncoding: "Cn",
    sourceText: phaseSource,
    previousText: phaseSource,
    newText: phaseExpanded,
    replaceAll: false,
    stringTableBytes: phaseTable,
    scriptBytes: phaseScript,
  });
  checks.push({
    id: "raw-ascii-inserted-float32-phase-row-roundtrip",
    ok:
      phaseExpandedPatch.expectedText === phaseExpanded &&
      phaseExpandedPatch.proof.outputTokenCount === phaseExpandedPatch.proof.originalTokenCount + 6 &&
      phaseExpandedPatch.proof.floatTokenWriteCount === 2 &&
      phaseExpandedPatch.proof.numericTypeTransitions?.filter((item) => item.toType === 4).length === 2,
  });

  const floatBits = Buffer.allocUnsafe(4);
  floatBits.writeFloatLE(0.8, 0);
  const phaseFloatSource = "#PVF_File\r\n[blood phase time]\r\n1\t0\t100\t0.8\t5\t6\r\n[/blood phase time]\r\n";
  const phaseFloatScript = createFixtureScript([
    [5, 0], [2, 1], [2, 0], [2, 100], [4, floatBits.readUInt32LE(0)], [2, 5], [2, 6], [5, 1],
  ]);
  const phaseInteger = "#PVF_File\r\n[blood phase time]\r\n1\t0\t100\t1\t5\t6\r\n[/blood phase time]\r\n";
  const phaseIntegerPatch = buildRawAsciiScriptPatch({
    pvfPath: "map/TowerOfBloodyFight/fixture.map",
    pvfEncoding: "Cn",
    sourceText: phaseFloatSource,
    previousText: phaseFloatSource,
    newText: phaseInteger,
    replaceAll: false,
    stringTableBytes: phaseTable,
    scriptBytes: phaseFloatScript,
  });
  checks.push({
    id: "raw-ascii-float32-token-to-integer-text-roundtrip",
    ok: phaseIntegerPatch.expectedText === phaseInteger && parseTokens(phaseIntegerPatch.scriptBytes)[4]?.type === 4,
  });

  let floatOverflowCode = null;
  try {
    buildRawAsciiScriptPatch({
      pvfPath: "map/TowerOfBloodyFight/fixture.map",
      pvfEncoding: "Cn",
      sourceText: phaseSource,
      previousText: "1\t0\t100\t1\t5\t6",
      newText: "1\t0\t100\t340282400000000000000000000000000000000.0\t5\t6",
      replaceAll: false,
      stringTableBytes: phaseTable,
      scriptBytes: phaseScript,
    });
  } catch (error) {
    floatOverflowCode = error.code;
  }
  checks.push({
    id: "raw-ascii-float32-overflow-blocked",
    ok: floatOverflowCode === "RAW_ASCII_NUMBER_INVALID",
    code: floatOverflowCode,
  });

  for (const invalidFloatText of ["NaN", "Infinity"]) {
    let invalidFloatCode = null;
    try {
      buildRawAsciiScriptPatch({
        pvfPath: "map/TowerOfBloodyFight/fixture.map",
        pvfEncoding: "Cn",
        sourceText: phaseSource,
        previousText: "1\t0\t100\t1\t5\t6",
        newText: `1\t0\t100\t${invalidFloatText}\t5\t6`,
        replaceAll: false,
        stringTableBytes: phaseTable,
        scriptBytes: phaseScript,
      });
    } catch (error) {
      invalidFloatCode = error.code;
    }
    checks.push({
      id: `raw-ascii-${invalidFloatText.toLowerCase()}-blocked`,
      ok: invalidFloatCode === "RAW_ASCII_SCRIPT_LEX_FAILED",
      code: invalidFloatCode,
    });
  }

  const wdmTable = createFixtureStringTable(["[dungeon]", "[/dungeon]", "[name]", "亡者峽谷"], "Tw");
  const wdmScript = createFixtureScript([
    [5, 0], [2, 11000], [2, -1], [2, 11001], [2, -1], [2, 323], [2, -1],
    [5, 1], [5, 2], [7, 3],
  ]);
  const wdmSource = "#PVF_File\r\n[dungeon]\r\n11000\t-1\t11001\t-1\t323\t-1\r\n[/dungeon]\r\n\r\n[name]\r\n`亡者峽谷`\r\n";
  const wdmNext = "#PVF_File\r\n[dungeon]\r\n11000\t-1\t11001\t-1\t323\t-1\t120\t-1\t121\t-1\r\n[/dungeon]\r\n\r\n[name]\r\n`亡者峽谷`\r\n";
  const wdmPatch = buildRawAsciiScriptPatch({
    pvfPath: "worldmap/towers.wdm",
    pvfEncoding: "Tw",
    sourceText: wdmSource,
    previousText: "11000\t-1\t11001\t-1\t323\t-1",
    newText: "11000\t-1\t11001\t-1\t323\t-1\t120\t-1\t121\t-1",
    replaceAll: false,
    stringTableBytes: wdmTable,
    scriptBytes: wdmScript,
  });
  checks.push({
    id: "raw-ascii-worldmap-wdm-dungeon-list-extension-roundtrip",
    ok:
      wdmPatch.expectedText === wdmNext &&
      wdmPatch.proof.encoding === "Tw" &&
      wdmPatch.proof.occurrenceCount === 1 &&
      wdmPatch.proof.originalTokenCount === 10 &&
      wdmPatch.proof.outputTokenCount === 14 &&
      wdmPatch.proof.stringTableUntouched === true &&
      wdmPatch.proof.existingStringEntriesPreserved === true,
  });

  for (const [extension, pvfPath] of [
    [".cre", "creature/fixture.cre"],
    [".mm", "region/minimap/fixture.mm"],
    [".msn", "pvp_mission/fixture.msn"],
    [".npc", "npc/fixture.npc"],
    [".rgn", "region/fixture.rgn"],
    [".twn", "town/fixture.twn"],
  ]) {
    const patch = buildRawAsciiScriptPatch({
      pvfPath,
      pvfEncoding: "Cn",
      sourceText: "#PVF_File\r\n[value]\r\n10\r\n",
      previousText: "10",
      newText: "20",
      replaceAll: false,
      stringTableBytes: rawTable,
      scriptBytes: createFixtureScript([[5, 0], [2, 10]]),
    });
    checks.push({
      id: `raw-ascii-${extension.slice(1)}-canonical-script-parameter-roundtrip`,
      ok: patch.expectedText === "#PVF_File\r\n[value]\r\n20\r\n" && patch.proof.changedTokenCount === 1,
    });
  }

  let rawRegistryCode = null;
  try {
    buildRawAsciiScriptPatch({
      pvfPath: "dungeon/dungeon.lst",
      pvfEncoding: "Cn",
      sourceText: "#PVF_File\r\n[value]\r\n10\r\n",
      previousText: "10",
      newText: "20",
      replaceAll: false,
      stringTableBytes: rawTable,
      scriptBytes: createFixtureScript([[5, 0], [2, 10]]),
    });
  } catch (error) {
    rawRegistryCode = error.code;
  }
  checks.push({
    id: "raw-ascii-lst-registry-remains-protected",
    ok: rawRegistryCode === "RAW_ASCII_FILE_TYPE_UNSUPPORTED",
    code: rawRegistryCode,
  });

  let rawTilError = null;
  try {
    buildRawAsciiScriptPatch({
      pvfPath: "map/illusiontower/tile/prisontile1.til",
      pvfEncoding: "Cn",
      sourceText: "#PVF_File\r\n[img pos]\r\n0\r\n",
      previousText: "[img pos]\r\n0",
      newText: "[img pos]\r\n80",
      replaceAll: false,
      stringTableBytes: rawTable,
      scriptBytes: createFixtureScript([[5, 0], [2, 0]]),
    });
  } catch (error) {
    rawTilError = error;
  }
  checks.push({
    id: "raw-ascii-til-block-suggests-atomic-copy-and-map-switch",
    ok:
      rawTilError?.code === "RAW_ASCII_FILE_TYPE_UNSUPPORTED" &&
      rawTilError?.message.includes("copy-file") &&
      rawTilError?.message.includes("同一 change-set") &&
      rawTilError?.message.includes(".map"),
    code: rawTilError?.code || null,
  });

  let rawClientLogicCode = null;
  try {
    buildRawAsciiScriptPatch({
      pvfPath: "clientonly/eventmaker/growdialog.co",
      pvfEncoding: "Cn",
      sourceText: "#PVF_File\r\n[value]\r\n10\r\n",
      previousText: "10",
      newText: "20",
      replaceAll: false,
      stringTableBytes: rawTable,
      scriptBytes: createFixtureScript([[5, 0], [2, 10]]),
    });
  } catch (error) {
    rawClientLogicCode = error.code;
  }
  checks.push({
    id: "raw-ascii-co-client-logic-remains-protected",
    ok: rawClientLogicCode === "RAW_ASCII_FILE_TYPE_UNSUPPORTED",
    code: rawClientLogicCode,
  });

  const rawBatchSource = "#PVF_File\r\n[value]\r\n10\r\n[value]\r\n10\r\n";
  const rawBatchScript = createFixtureScript([[5, 0], [2, 10], [5, 0], [2, 10]]);
  const rawBatchPatch = buildRawAsciiScriptPatch({
    pvfPath: "stackable/raw-batch.stk", pvfEncoding: "Cn",
    sourceText: rawBatchSource, previousText: "[value]\r\n10", newText: "[value]\r\n20",
    replaceAll: true, expectedOccurrences: 2, stringTableBytes: rawTable, scriptBytes: rawBatchScript,
  });
  checks.push({
    id: "raw-ascii-batch-exact-count-roundtrip",
    ok: rawBatchPatch.proof.occurrenceCount === 2 && rawBatchPatch.expectedText.includes("[value]\r\n20"),
  });

  const binaryAniSource = createFixtureBinaryAni(80);
  const binaryAniInspection = inspectBinaryAni(binaryAniSource);
  const binaryAniPrevious = "[FRAME000]\r\n\t[IMAGE]\r\n\t\t`Monster/fixture1.img`\r\n\t\t65\r\n\t[IMAGE POS]\r\n\t\t-252\t-379\r\n\t[DELAY]\r\n\t\t80";
  const binaryAniNext = binaryAniPrevious.replace("\t\t80", "\t\t10000");
  const binaryAniPatch = buildRawAsciiAniPatch({
    pvfPath: "monster/fixture/animation/down.ani",
    pvfEncoding: "Cn",
    sourceText: binaryAniInspection.text,
    sourceBytes: binaryAniSource,
    previousText: binaryAniPrevious,
    newText: binaryAniNext,
    replaceAll: false,
  });
  const binaryAniReadback = inspectBinaryAni(binaryAniPatch.bytes);
  checks.push({
    id: "raw-binary-ani-delay-byte-preserving-roundtrip",
    ok:
      binaryAniInspection.fullyConsumed === true &&
      binaryAniReadback?.fullyConsumed === true &&
      binaryAniReadback?.text.includes("[DELAY]\r\n\t\t10000") &&
      binaryAniPatch.proof.mode === RAW_BINARY_ANI_PATCH_MODE &&
      binaryAniPatch.proof.changedFieldCount === 1 &&
      binaryAniPatch.proof.changedFieldTags?.length === 1 &&
      binaryAniPatch.proof.changedFieldTags[0] === "DELAY" &&
      binaryAniPatch.proof.rawBytePreservingPatch === true &&
      binaryAniPatch.proof.wholeFileReencodingUsed === false &&
      binaryAniPatch.proof.nonTargetRawBytesPreserved === true &&
      binaryAniPatch.proof.sourceRawSha256 === sha256(binaryAniSource) &&
      binaryAniSource.readInt32LE(binaryAniPatch.proof.targetRanges[0].offset) === 80 &&
      binaryAniPatch.bytes.readInt32LE(binaryAniPatch.proof.targetRanges[0].offset) === 10000,
  });

  let binaryAniOtherFieldCode = null;
  try {
    buildRawAsciiAniPatch({
      pvfPath: "monster/fixture/animation/down.ani",
      sourceText: binaryAniInspection.text,
      sourceBytes: binaryAniSource,
      previousText: "[IMAGE POS]\r\n\t\t-252\t-379",
      newText: "[IMAGE POS]\r\n\t\t-251\t-379",
      replaceAll: false,
    });
  } catch (error) {
    binaryAniOtherFieldCode = error.code;
  }
  checks.push({
    id: "raw-binary-ani-non-delay-field-remains-blocked",
    ok: binaryAniOtherFieldCode === "RAW_ANI_FIELD_CHANGE_BLOCKED",
    code: binaryAniOtherFieldCode,
  });

  let binaryAniLiteralCode = null;
  try {
    buildRawAsciiAniPatch({
      pvfPath: "monster/fixture/animation/down.ani",
      sourceText: binaryAniInspection.text,
      sourceBytes: binaryAniSource,
      previousText: "`Monster/fixture1.img`",
      newText: "`Monster/fixture2.img`",
      replaceAll: false,
    });
  } catch (error) {
    binaryAniLiteralCode = error.code;
  }
  checks.push({
    id: "raw-binary-ani-path-and-literal-change-remains-blocked",
    ok: binaryAniLiteralCode === "RAW_ANI_LITERAL_CHANGE_BLOCKED",
    code: binaryAniLiteralCode,
  });

  let binaryAniTrailingBytesCode = null;
  try {
    const sourceWithTrailingBytes = Buffer.concat([binaryAniSource, Buffer.from([0xaa])]);
    buildRawAsciiAniPatch({
      pvfPath: "monster/fixture/animation/down.ani",
      sourceText: binaryAniInspection.text,
      sourceBytes: sourceWithTrailingBytes,
      previousText: "[DELAY]\r\n\t\t80",
      newText: "[DELAY]\r\n\t\t10000",
      replaceAll: false,
    });
  } catch (error) {
    binaryAniTrailingBytesCode = error.code;
  }
  checks.push({
    id: "raw-binary-ani-unparsed-trailing-bytes-remain-blocked",
    ok: binaryAniTrailingBytesCode === "RAW_ANI_BINARY_PARSE_FAILED",
    code: binaryAniTrailingBytesCode,
  });

  const rawAnchoredPatch = buildRawAsciiScriptPatch({
    pvfPath: "stackable/raw-context.stk", pvfEncoding: "Cn",
    sourceText: rawBatchSource, previousText: "[value]\r\n10", newText: "[value]\r\n20",
    contextBefore: "#PVF_File\r\n", replaceAll: false,
    stringTableBytes: rawTable, scriptBytes: rawBatchScript,
  });
  checks.push({
    id: "raw-ascii-duplicate-block-adjacent-context-selects-one",
    ok: rawAnchoredPatch.expectedText === "#PVF_File\r\n[value]\r\n20\r\n[value]\r\n10\r\n" &&
      rawAnchoredPatch.proof.totalOccurrenceCount === 2 &&
      rawAnchoredPatch.proof.occurrenceCount === 1 &&
      rawAnchoredPatch.proof.contextAnchor?.anchored === true,
  });

  const scopedStrings = ["[check]", "coat", "[value]", "[explain]", "同值说明", "[/check]", "support", "ring"];
  const scopedTable = createFixtureStringTable(scopedStrings, "Cn");
  const scopedTokens = [];
  for (const partStringIndex of [1, 6, 7]) {
    scopedTokens.push(
      [5, 0], [2, 0], [2, 1], [7, partStringIndex],
      [5, 2], [2, 10], [5, 3], [7, 4], [5, 5],
    );
  }
  const scopedScript = createFixtureScript(scopedTokens);
  const scopedTextBlock = (part, value = 10, explain = "同值说明") =>
    `[check]\r\n0\t1\t\`${part}\`\r\n[value]\r\n${value}\r\n[explain]\r\n\`${explain}\`\r\n[/check]\r\n`;
  const scopedSource = scopedTextBlock("coat") + scopedTextBlock("support") + scopedTextBlock("ring");
  const coatScope = {
    startText: "[check]\r\n0\t1\t`coat`\r\n",
    endText: "[/check]",
    expectedRanges: 1,
  };
  const scopedVerifiedBatchPatch = buildVerifiedInlineTextBatchPatch({
    pvfPath: "stackable/scoped-batch.stk",
    pvfEncoding: "Cn",
    sourceText: scopedSource,
    changes: [{
      id: "scoped-explain",
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfEncoding: "Cn",
      previousText: "`同值说明`",
      newText: "`目标说明`",
      scope: coatScope,
      replaceAll: false,
    }],
    stringTableBytes: scopedTable,
    scriptBytes: scopedScript,
  });
  const scopedVerifiedOutputTable = StringTable.parse(scopedVerifiedBatchPatch.stringTableBytes, "Cn");
  const scopedVerifiedOutputTokens = parseTokens(scopedVerifiedBatchPatch.scriptBytes);
  checks.push({
    id: "verified-batch-exact-scope-changes-only-target-homomorphic-block",
    ok:
      scopedVerifiedBatchPatch.sourceText ===
        scopedTextBlock("coat", 10, "目标说明") + scopedTextBlock("support") + scopedTextBlock("ring") &&
      scopedVerifiedOutputTable.get(scopedVerifiedOutputTokens[7].value) === "目标说明" &&
      scopedVerifiedOutputTable.get(scopedVerifiedOutputTokens[16].value) === "同值说明" &&
      scopedVerifiedOutputTable.get(scopedVerifiedOutputTokens[25].value) === "同值说明" &&
      scopedVerifiedBatchPatch.proofs[0]?.contextAnchor?.scopeApplied === true &&
      scopedVerifiedBatchPatch.proofs[0]?.contextAnchor?.scope?.rangeCount === 1 &&
      scopedVerifiedBatchPatch.proofs[0]?.totalOccurrenceCount === 3,
  });

  const scopedRawPatch = buildRawAsciiScriptPatch({
    pvfPath: "stackable/scoped-raw.stk",
    pvfEncoding: "Cn",
    sourceText: scopedSource,
    previousText: "[value]\r\n10",
    newText: "[value]\r\n20",
    scope: coatScope,
    replaceAll: false,
    stringTableBytes: scopedTable,
    scriptBytes: scopedScript,
  });
  checks.push({
    id: "raw-ascii-exact-scope-changes-only-target-homomorphic-block",
    ok:
      scopedRawPatch.expectedText ===
        scopedTextBlock("coat", 20) + scopedTextBlock("support") + scopedTextBlock("ring") &&
      scopedRawPatch.proof.occurrenceCount === 1 &&
      scopedRawPatch.proof.totalOccurrenceCount === 3 &&
      scopedRawPatch.proof.contextAnchor?.scopeApplied === true &&
      scopedRawPatch.proof.contextAnchor?.scope?.ranges?.[0]?.contentSha256 &&
      scopedRawPatch.proof.exactIndependentTextReadback === true,
  });

  const rawNewTokenSource = "#PVF_File\r\n[skill]\r\n13\r\n`[swordman]`\t72\r\n[/skill]\r\n";
  const rawNewTokenNext = "#PVF_File\r\n[skill]\r\n13\r\n`[swordman]`\t72\r\n`[level]`\t0\r\n[/skill]\r\n";
  const rawNewTokenPatch = buildRawAsciiScriptPatch({
    pvfPath: "stackable/raw-new-token.stk", pvfEncoding: "Cn",
    sourceText: rawNewTokenSource, previousText: rawNewTokenSource, newText: rawNewTokenNext,
    replaceAll: false, stringTableBytes: rawTable,
    scriptBytes: createFixtureScript([[5, 1], [2, 13], [7, 2], [2, 72], [5, 6]]),
  });
  checks.push({
    id: "raw-ascii-new-token-appended-with-existing-strings-preserved",
    ok: rawNewTokenPatch.expectedText === rawNewTokenNext &&
      rawNewTokenPatch.proof.stringTableUntouched === false &&
      rawNewTokenPatch.proof.existingStringEntriesPreserved === true &&
      rawNewTokenPatch.proof.appendedStringEntryCount === 1 &&
      StringTable.parse(rawNewTokenPatch.stringTableBytes, "Cn").get(rawTable.readInt32LE(0)) === "[level]",
  });


  const mojibakeTable = createFixtureStringTable(["[name]", "太陽"], "Tw");
  const mojibakeScript = createFixtureScript([[5, 0], [7, 1]]);
  const wrongCnValue = StringTable.parse(mojibakeTable, "Cn").get(1);
  let wrongEncodingCode = null;
  try {
    buildVerifiedInlineTextPatch({
      textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
      pvfPath: "creature/fixture.cre",
      pvfEncoding: "Cn",
      sourceText: `#PVF_File\r\n[name]\r\n\`${wrongCnValue}\`\r\n`,
      previousText: `\`${wrongCnValue}\``,
      newText: "`中文错误写入`",
      replaceAll: false,
      stringTableBytes: mojibakeTable,
      scriptBytes: mojibakeScript,
    });
  } catch (error) {
    wrongEncodingCode = error.code;
  }
  checks.push({
    id: "big5-source-misread-as-gbk-blocked",
    ok: wrongEncodingCode === "TEXT_ENCODING_MISMATCH_SUSPECTED",
    code: wrongEncodingCode,
  });

  const asciiTable = createFixtureStringTable(["[name]", "fixture-name"], "Cn");
  let missingEncodingEvidenceCode = null;
  try {
    buildVerifiedInlineTextPatch({
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfPath: "stackable/fixture.stk",
      pvfEncoding: "Cn",
      sourceText: "#PVF_File\r\n[name]\r\n`fixture-name`\r\n",
      previousText: "`fixture-name`",
      newText: "`中文新名称`",
      replaceAll: false,
      stringTableBytes: asciiTable,
      scriptBytes: createFixtureScript([[5, 0], [7, 1]]),
    });
  } catch (error) {
    missingEncodingEvidenceCode = error.code;
  }
  checks.push({
    id: "ascii-source-without-encoding-evidence-blocked",
    ok: missingEncodingEvidenceCode === "TEXT_ENCODING_EVIDENCE_REQUIRED",
    code: missingEncodingEvidenceCode,
  });

  for (const fixture of [
    {
      id: "partial-token-blocked",
      expectedCode: "CN_TEXT_TOKEN_REQUIRED",
      input: { previousText: "旧描述", newText: "新描述" },
    },
    {
      id: "logic-file-type-blocked",
      expectedCode: "CN_TEXT_FILE_TYPE_UNSUPPORTED",
      input: { pvfPath: "clientonly/eventmaker/growdialog.co", previousText: "`旧描述`", newText: "`新描述`" },
    },
    {
      id: "stringlink-text-blocked",
      expectedCode: "STRINGLINK_TEXT_WRITE_UNVERIFIED",
      input: { previousText: "<13::name`旧描述`>", newText: "<13::name`新描述`>" },
    },
    {
      id: "stringlink-inner-token-blocked",
      expectedCode: "STRINGLINK_TEXT_WRITE_UNVERIFIED",
      input: {
        sourceText: "#PVF_File\r\n[name]\r\n<13::name`旧描述`>\r\n",
        previousText: "`旧描述`",
        newText: "`新描述`",
      },
    },
    {
      id: "unencodable-character-blocked",
      expectedCode: "CN_TEXT_CHARACTER_UNENCODABLE",
      input: { previousText: "`旧描述`", newText: "`新描述😀`" },
    },
  ]) {
    let code = null;
    try {
      analyzeVerifiedInlineTextChange({
        textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
        pvfPath: "stackable/fixture.stk",
        pvfEncoding: "Cn",
        sourceText,
        replaceAll: false,
        ...fixture.input,
      });
    } catch (error) {
      code = error.code;
    }
    checks.push({ id: fixture.id, ok: code === fixture.expectedCode, code, expectedCode: fixture.expectedCode });
  }
  return {
    ok: checks.every((check) => check.ok),
    checkCount: checks.length,
    failedChecks: checks.filter((check) => !check.ok).length,
    checks,
  };
}

function verifiedInlineTextBatchStressSelfTest() {
  const results = [];
  for (const count of [100, 500]) {
    const strings = ["[name]"];
    const tokens = [];
    const changes = [];
    const lines = [];
    for (let index = 0; index < count; index += 1) {
      const previousValue = `旧文本${index}`;
      strings.push(previousValue);
      tokens.push({ type: 5, value: 0 }, { type: 7, value: index + 1 });
      lines.push("[name]", `\`${previousValue}\``);
      changes.push({
        id: `stress-${count}-${index}`,
        textWriteMode: VERIFIED_INLINE_TEXT_MODE,
        pvfEncoding: "Cn",
        previousText: `\`${previousValue}\``,
        newText: `\`新文本${index}\``,
        replaceAll: false,
      });
    }
    const encodedStrings = strings.map((value) => encodeLegacyText(value, "Cn"));
    const headerLength = 4 + (encodedStrings.length + 1) * 4;
    const stringTableBytes = Buffer.alloc(headerLength + encodedStrings.reduce((sum, value) => sum + value.length, 0));
    stringTableBytes.writeInt32LE(encodedStrings.length, 0);
    let relativeOffset = headerLength - 4;
    let dataOffset = headerLength;
    encodedStrings.forEach((value, index) => {
      stringTableBytes.writeUInt32LE(relativeOffset, 4 + index * 4);
      value.copy(stringTableBytes, dataOffset);
      relativeOffset += value.length;
      dataOffset += value.length;
    });
    stringTableBytes.writeUInt32LE(relativeOffset, 4 + encodedStrings.length * 4);
    const scriptBytes = Buffer.alloc(2 + tokens.length * 5);
    scriptBytes[0] = 0xb0;
    scriptBytes[1] = 0xd0;
    tokens.forEach((token, index) => {
      scriptBytes[2 + index * 5] = token.type;
      scriptBytes.writeUInt32LE(token.value >>> 0, 3 + index * 5);
    });
    const patch = buildVerifiedInlineTextBatchPatch({
      pvfPath: "stackable/stress.stk",
      pvfEncoding: "Cn",
      sourceText: `${lines.join("\r\n")}\r\n`,
      changes,
      stringTableBytes,
      scriptBytes,
    });
    const outputStringTable = StringTable.parse(patch.stringTableBytes, "Cn");
    const outputTokens = parseTokens(patch.scriptBytes);
    const allValuesMatch = changes.every((change, index) => {
      const token = outputTokens[index * 2 + 1];
      return outputStringTable.get(token.value) === `新文本${index}`;
    });
    const proofBytes = Buffer.byteLength(JSON.stringify({ proof: patch.proof, proofs: patch.proofs }), "utf8");
    results.push({
      count,
      ok:
        patch.changeCount === count &&
        patch.proofs.length === count &&
        patch.proof.appendedStringEntryCount === count &&
        proofBytes < count * MAX_VERIFIED_TEXT_PROOF_BYTES_PER_CHANGE &&
        patch.proof.existingStringEntriesPreserved === true &&
        allValuesMatch,
      elapsedMilliseconds: patch.proof.elapsedMilliseconds,
      appendedStringEntryCount: patch.proof.appendedStringEntryCount,
      proofBytes,
      proofBytesPerChange: proofBytes / count,
      maxProofBytesPerChange: MAX_VERIFIED_TEXT_PROOF_BYTES_PER_CHANGE,
    });
  }
  const sharedTable = createFixtureStringTable(["[name]", "批量旧说明"], "Cn");
  const sharedScript = createFixtureScript([
    [5, 0], [7, 1],
    [5, 0], [7, 1],
    [5, 0], [7, 1],
  ]);
  const sharedPatch = buildVerifiedInlineTextBatchPatch({
    pvfPath: "stackable/shared-batch.stk",
    pvfEncoding: "Cn",
    sourceText: "[name]\r\n`批量旧说明`\r\n[name]\r\n`批量旧说明`\r\n[name]\r\n`批量旧说明`\r\n",
    changes: [{
      id: "stress-shared-value",
      textWriteMode: VERIFIED_INLINE_TEXT_MODE,
      pvfEncoding: "Cn",
      previousText: "`批量旧说明`",
      newText: "`批量新说明`",
      replaceAll: true,
      expectedOccurrences: 3,
    }],
    stringTableBytes: sharedTable,
    scriptBytes: sharedScript,
  });
  results.push({
    count: "shared-value-dedup",
    ok:
      sharedPatch.proof.appendedStringEntryCount === 1 &&
      sharedPatch.proof.replacedTokenCount === 3 &&
      sharedPatch.proof.duplicateNewStringReferenceCount === 2 &&
      new Set(sharedPatch.proofs[0].newStringIndexes).size === 1,
    appendedStringEntryCount: sharedPatch.proof.appendedStringEntryCount,
    replacedTokenCount: sharedPatch.proof.replacedTokenCount,
  });
  const stress100 = results.find((result) => result.count === 100);
  const stress500 = results.find((result) => result.count === 500);
  results.push({
    count: "proof-growth-linear",
    ok:
      Boolean(stress100?.ok && stress500?.ok) &&
      stress500.proofBytes <= stress100.proofBytes * 5.1 &&
      Math.abs(stress500.proofBytesPerChange - stress100.proofBytesPerChange) < 100,
    proofBytes100: stress100?.proofBytes || null,
    proofBytes500: stress500?.proofBytes || null,
    growthRatio: stress100?.proofBytes ? stress500.proofBytes / stress100.proofBytes : null,
  });
  return {
    ok: results.every((result) => result.ok),
    cases: results,
  };
}

function verifiedInlineCnTextSelfTest() {
  return verifiedInlineTextSelfTest();
}

module.exports = {
  VERIFIED_STRINGLINK_DETACH_MODE,
  RAW_BINARY_ANI_PATCH_MODE,
  ALLOWED_VISIBLE_TEXT_TAGS,
  ALLOWED_INLINE_TEXT_EXTENSIONS,
  MAX_INLINE_TEXT_CHARACTERS,
  SUPPORTED_INLINE_TEXT_ENCODINGS,
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  analyzeVerifiedInlineTextChange,
  analyzeVerifiedInlineCnTextChange,
  buildVerifiedInlineTextPatch,
  buildVerifiedInlineTextBatchPatch,
  buildVerifiedInlineCnPatch,
  buildRawAsciiScriptPatch,
  buildRawAsciiAniPatch,
  encodeLegacyText,
  encodeGbkText,
  isVerifiedInlineTextMode,
  verifiedInlineTextSelfTest,
  verifiedInlineTextBatchStressSelfTest,
  verifiedInlineCnTextSelfTest,
};
