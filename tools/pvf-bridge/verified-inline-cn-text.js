"use strict";

const crypto = require("crypto");
const path = require("path");
const {
  compareChineseEncodingCandidates,
  decodeText,
  normalizeEncoding,
} = require("./fallback/codec.ts");
const { StringTable, parseTokens } = require("./fallback/script.ts");

const VERIFIED_INLINE_TEXT_MODE = "verified-inline-text";
const VERIFIED_INLINE_CN_TEXT_MODE = "verified-inline-cn";
const VERIFIED_INLINE_TEXT_MODES = new Set([
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
]);
const SUPPORTED_INLINE_TEXT_ENCODINGS = new Set(["Cn", "Tw"]);
const MAX_INLINE_TEXT_CHARACTERS = 4000;
const MAX_STRING_TABLE_ENTRIES = 5_000_000;
const ALLOWED_INLINE_TEXT_EXTENSIONS = new Set([
  ".aic",
  ".cre",
  ".dgn",
  ".equ",
  ".etc",
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
]);
const ALLOWED_VISIBLE_TEXT_TAGS = new Set([
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

function normalizeTag(value) {
  return String(value || "").trim().replace(/^\[/, "").replace(/\]$/, "").trim().toLowerCase();
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

function directBacktickValue(fragment) {
  const match = /^`([^`\r\n]*)`$/u.exec(String(fragment || ""));
  return match ? match[1] : null;
}

function containsNonAscii(value) {
  return /[^\x00-\x7f]/u.test(String(value || ""));
}

function immediateParentTag(sourceText, tokenOffset) {
  const lineStart = sourceText.lastIndexOf("\n", Math.max(0, tokenOffset - 1)) + 1;
  const lines = sourceText.slice(0, lineStart).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = /^\[([^\]\r\n]+)\]$/.exec(line);
    if (!match || match[1].trim().startsWith("/")) return null;
    return normalizeTag(match[1]);
  }
  return null;
}

function isInsideStringLinkToken(sourceText, tokenOffset, tokenLength) {
  const lineStart = sourceText.lastIndexOf("\n", Math.max(0, tokenOffset - 1)) + 1;
  const lineEndFound = sourceText.indexOf("\n", tokenOffset + tokenLength);
  const lineEnd = lineEndFound < 0 ? sourceText.length : lineEndFound;
  const line = sourceText.slice(lineStart, lineEnd);
  const relativeStart = tokenOffset - lineStart;
  const relativeEnd = relativeStart + tokenLength;
  const pattern = /<\s*\d+\s*::[^>\r\n`]{1,512}`[^>\r\n`]*`>/gu;
  for (const match of line.matchAll(pattern)) {
    const matchStart = match.index || 0;
    const matchEnd = matchStart + match[0].length;
    if (relativeStart >= matchStart && relativeEnd <= matchEnd) return true;
  }
  return false;
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
    throw codedError("CN_LOCALIZATION_WRITE_UNVERIFIED", "独立 .str 中文资源仍未开放写入。");
  }
  if (!ALLOWED_INLINE_TEXT_EXTENSIONS.has(extension)) {
    throw codedError("CN_TEXT_FILE_TYPE_UNSUPPORTED", `当前未开放 ${extension || "无扩展名"} 文件中的中文写入。`);
  }
  const encoding = normalizeEncoding(input.pvfEncoding, input.fallbackEncoding || "Tw");
  if (!SUPPORTED_INLINE_TEXT_ENCODINGS.has(encoding)) {
    throw codedError("TEXT_ENCODING_UNSUPPORTED", `安全文字模式当前只支持简体（Cn）或繁体（Tw）编码，收到：${encoding}。`);
  }
  if (input.replaceAll === true) {
    throw codedError("CN_TEXT_REPLACE_ALL_BLOCKED", "中文文本修改一次只允许定位并替换一个明确字段。");
  }
  const previousText = String(input.previousText || "");
  const newText = String(input.newText || "");
  if (/^<\s*\d+\s*::/u.test(previousText) || /^<\s*\d+\s*::/u.test(newText)) {
    throw codedError("STRINGLINK_TEXT_WRITE_UNVERIFIED", "StringLink 显示文本必须修改其真实字符串资源；当前仍保持只读。");
  }
  const previousValue = directBacktickValue(previousText);
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
  const occurrenceCount = countOccurrences(sourceText, previousText);
  if (occurrenceCount !== 1) {
    throw codedError("CN_TEXT_OCCURRENCE_UNSAFE", `中文原文必须在目标文件中精确出现一次，当前为 ${occurrenceCount} 次。`);
  }
  const tokenOffset = sourceText.indexOf(previousText);
  if (isInsideStringLinkToken(sourceText, tokenOffset, previousText.length)) {
    throw codedError("STRINGLINK_TEXT_WRITE_UNVERIFIED", "StringLink 显示文本必须修改其真实字符串资源；当前仍保持只读。");
  }
  const parentTag = immediateParentTag(sourceText, tokenOffset);
  if (!parentTag || !ALLOWED_VISIBLE_TEXT_TAGS.has(parentTag)) {
    throw codedError(
      "CN_TEXT_PARENT_TAG_UNSUPPORTED",
      `当前只开放已确认的名称、说明和消息字段；目标字段 ${parentTag ? `[${parentTag}]` : "无法识别"} 未获允许。`,
      { parentTag },
    );
  }
  const encodedPreviousValue = encodeLegacyText(previousValue, encoding);
  const encodedNewValue = encodeLegacyText(newValue, encoding);
  return {
    allowed: true,
    noOp: false,
    mode,
    encoding,
    parentTag,
    previousValue,
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

function buildVerifiedInlineTextPatch(input = {}) {
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
  let currentTag = null;
  const candidates = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 5) {
      const section = String(stringTable.get(token.value) || "");
      currentTag = section.startsWith("[/") ? null : normalizeTag(section);
      continue;
    }
    if (token.type === 7 && currentTag === analysis.parentTag && stringTable.get(token.value) === analysis.previousValue) {
      candidates.push({ tokenIndex: index, originalStringIndex: token.value });
    }
  }
  if (candidates.length !== 1) {
    throw codedError(
      "CN_TEXT_RAW_TOKEN_UNSAFE",
      `原始脚本中必须精确找到一个对应文本 token，当前为 ${candidates.length} 个。`,
      { parentTag: analysis.parentTag, candidateCount: candidates.length },
    );
  }
  const candidate = candidates[0];
  const alternateEncoding = alternateChineseEncoding(analysis.encoding);
  const alternateStringTable = StringTable.parse(stringTableBytes, alternateEncoding);
  const alternateValue = alternateStringTable.get(candidate.originalStringIndex);
  const encodingComparison = compareChineseEncodingCandidates(
    analysis.previousValue,
    alternateValue,
    analysis.encoding,
    alternateEncoding,
  );
  if (encodingComparison.requestedLooksMojibake === true) {
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
  const encodingEvidence = {
    kind: containsNonAscii(analysis.previousValue) ? "target-token" : "same-script-references",
    requestedEncoding: analysis.encoding,
    alternateEncoding,
    requestedSupportCount: 0,
    alternateSupportCount: 0,
    ambiguousReferenceCount: 0,
  };
  if (containsNonAscii(analysis.previousValue)) {
    encodingEvidence.requestedSupportCount = 1;
  } else if (containsNonAscii(analysis.newValue)) {
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
  const appended = appendStringTableEntry(stringTableBytes, analysis.encodedNewValue);
  const patchedScriptBytes = Buffer.from(scriptBytes);
  patchedScriptBytes.writeUInt32LE(appended.newIndex, 3 + candidate.tokenIndex * 5);
  return {
    noOp: false,
    analysis,
    stringTableBytes: appended.bytes,
    scriptBytes: patchedScriptBytes,
    proof: {
      mode: analysis.mode,
      encoding: analysis.encoding,
      parentTag: analysis.parentTag,
      targetTokenIndex: candidate.tokenIndex,
      originalStringIndex: candidate.originalStringIndex,
      newStringIndex: appended.newIndex,
      originalStringCount: appended.originalCount,
      outputStringCount: appended.outputCount,
      existingStringEntriesPreserved: appended.originalSequenceSha256 === appended.preservedSequenceSha256,
      existingStringEntriesSha256: appended.originalSequenceSha256,
      sourceEncodingCheckedAgainst: alternateEncoding,
      sourceEncodingMismatchSuspected: false,
      sourceEncodingComparison: compactEncodingComparison(encodingComparison),
      sourceEncodingEvidence: encodingEvidence,
      encodedNewValueSha256: analysis.encodedNewValueSha256,
      scriptBeforeSha256: sha256(scriptBytes),
      scriptAfterSha256: sha256(patchedScriptBytes),
      stringTableBeforeSha256: sha256(stringTableBytes),
      stringTableAfterSha256: sha256(appended.bytes),
    },
  };
}

function buildVerifiedInlineCnPatch(input = {}) {
  return buildVerifiedInlineTextPatch(input);
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

function verifiedInlineTextSelfTest() {
  const checks = [];
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

function verifiedInlineCnTextSelfTest() {
  return verifiedInlineTextSelfTest();
}

module.exports = {
  ALLOWED_VISIBLE_TEXT_TAGS,
  ALLOWED_INLINE_TEXT_EXTENSIONS,
  MAX_INLINE_TEXT_CHARACTERS,
  SUPPORTED_INLINE_TEXT_ENCODINGS,
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  analyzeVerifiedInlineTextChange,
  analyzeVerifiedInlineCnTextChange,
  buildVerifiedInlineTextPatch,
  buildVerifiedInlineCnPatch,
  encodeLegacyText,
  encodeGbkText,
  isVerifiedInlineTextMode,
  verifiedInlineTextSelfTest,
  verifiedInlineCnTextSelfTest,
};
