"use strict";

type DecodeTextOptions = Readonly<{ trimNull?: boolean }>;

type TextEncodingRisk = Readonly<{
  score: number;
  replacementCount: number;
  controlCount: number;
  privateUseCount: number;
  kanaCount: number;
  greekOrCyrillicCount: number;
  cjkCount: number;
  reasons: string[];
}>;

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function rotr32(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

const checksumTable = (() => {
  const table = new Uint32Array(256);
  let value = 1 >>> 0;
  for (let bit = 128; bit > 0; bit >>>= 1) {
    value = ((value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320)) >>> 0;
    for (let source = 0, target = bit; source < 256; source += bit * 2, target += bit * 2) {
      table[target] = (table[source] ^ value) >>> 0;
    }
  }
  return table;
})();

function createChecksum(source: Buffer, trueLength: number, seed: number): number {
  if (trueLength % 4 !== 0 || trueLength > source.length) throw new Error("PVF checksum input must be four-byte aligned.");
  let value = (~seed) >>> 0;
  for (let offset = 0; offset < trueLength; offset += 4) {
    for (let index = 0; index < 4; index += 1) {
      const byte = (source[offset + index] ^ value) & 0xff;
      value = ((value >>> 8) ^ checksumTable[byte]) >>> 0;
    }
  }
  return (~value) >>> 0;
}

function decrypt(source: Buffer, checksum: number): Buffer {
  if (source.length % 4 !== 0) throw new Error("Encrypted PVF blocks must be four-byte aligned.");
  const output = Buffer.allocUnsafe(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    const encrypted = source.readUInt32LE(offset);
    output.writeUInt32LE(rotr32((encrypted ^ 0x81a79011 ^ checksum) >>> 0, 6), offset);
  }
  return output;
}

function encrypt(source: Buffer, checksum: number): Buffer {
  const length = (source.length + 3) & ~3;
  const input = Buffer.alloc(length);
  source.copy(input);
  const output = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length; offset += 4) {
    const plain = input.readUInt32LE(offset);
    output.writeUInt32LE((rotl32(plain, 6) ^ checksum ^ 0x81a79011) >>> 0, offset);
  }
  return output;
}

function normalizeEncoding(value: unknown, fallback = "Tw"): string {
  const raw = String(value || fallback).trim().toLowerCase();
  const aliases = new Map([
    ["tw", "Tw"], ["big5", "Tw"], ["cp950", "Tw"],
    ["cn", "Cn"], ["gbk", "Cn"], ["gb18030", "Cn"], ["cp936", "Cn"],
    ["kr", "Kr"], ["cp949", "Kr"], ["euc-kr", "Kr"],
    ["jp", "Jp"], ["shift_jis", "Jp"], ["shift-jis", "Jp"], ["cp932", "Jp"],
    ["utf8", "Utf8"], ["utf-8", "Utf8"],
    ["unicode", "Unicode"], ["utf16le", "Unicode"], ["utf-16le", "Unicode"],
  ]);
  return aliases.get(raw) || fallback;
}

function decoderLabel(value: unknown): string {
  const encoding = normalizeEncoding(value);
  return {
    Tw: "big5",
    Cn: "gb18030",
    Kr: "euc-kr",
    Jp: "shift_jis",
    Utf8: "utf-8",
    Unicode: "utf-16le",
  }[encoding];
}

function decodeText(source: Uint8Array, encoding: unknown, options: DecodeTextOptions = {}): string {
  const text = new TextDecoder(decoderLabel(encoding), { fatal: false }).decode(source);
  return options.trimNull === false ? text : text.replace(/\0+$/g, "");
}

function decodeFileName(source: Uint8Array): string {
  return decodeText(source, "Kr").replace(/\\/g, "/");
}

function textEncodingRisk(value: unknown): TextEncodingRisk {
  const text = String(value || "");
  let score = 0;
  let replacementCount = 0;
  let controlCount = 0;
  let privateUseCount = 0;
  let kanaCount = 0;
  let greekOrCyrillicCount = 0;
  let cjkCount = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) || 0;
    if (codePoint === 0xfffd) {
      replacementCount += 1;
      score += 100;
      continue;
    }
    if ((codePoint >= 0 && codePoint < 0x20 && !new Set([0x09, 0x0a, 0x0d]).has(codePoint)) || codePoint === 0x7f) {
      controlCount += 1;
      score += 50;
      continue;
    }
    if ((codePoint >= 0xe000 && codePoint <= 0xf8ff) || (codePoint >= 0xf0000 && codePoint <= 0xffffd) || (codePoint >= 0x100000 && codePoint <= 0x10fffd)) {
      privateUseCount += 1;
      score += 20;
      continue;
    }
    if ((codePoint >= 0x3040 && codePoint <= 0x30ff) || (codePoint >= 0x31f0 && codePoint <= 0x31ff) || (codePoint >= 0xff61 && codePoint <= 0xff9f)) {
      kanaCount += 1;
      score += 5;
      continue;
    }
    if ((codePoint >= 0x0370 && codePoint <= 0x052f) || (codePoint >= 0x1f00 && codePoint <= 0x1fff)) {
      greekOrCyrillicCount += 1;
      score += 2;
      continue;
    }
    if (
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x323af)
    ) {
      cjkCount += 1;
    }
  }
  const reasons = [];
  if (replacementCount) reasons.push("replacement-character");
  if (controlCount) reasons.push("unexpected-control-character");
  if (privateUseCount) reasons.push("private-use-character");
  if (kanaCount) reasons.push("kana-in-chinese-text-candidate");
  if (greekOrCyrillicCount) reasons.push("greek-or-cyrillic-in-chinese-text-candidate");
  return {
    score,
    replacementCount,
    controlCount,
    privateUseCount,
    kanaCount,
    greekOrCyrillicCount,
    cjkCount,
    reasons,
  };
}

function compareChineseEncodingCandidates(
  requestedText: unknown,
  alternateText: unknown,
  requestedEncoding: unknown,
  alternateEncoding: unknown,
): Record<string, unknown> {
  const requested = textEncodingRisk(requestedText);
  const alternate = textEncodingRisk(alternateText);
  const different = String(requestedText || "") !== String(alternateText || "");
  const strongRequestedRisk =
    requested.replacementCount > 0 ||
    requested.controlCount > 0 ||
    requested.privateUseCount > 0 ||
    (requested.kanaCount > 0 && alternate.kanaCount === 0 && alternate.cjkCount > 0);
  const requestedLooksMojibake = different && strongRequestedRisk && requested.score >= alternate.score + 4;
  const strongAlternateRisk =
    alternate.replacementCount > 0 ||
    alternate.controlCount > 0 ||
    alternate.privateUseCount > 0 ||
    (alternate.kanaCount > 0 && requested.kanaCount === 0 && requested.cjkCount > 0);
  const alternateLooksMojibake = different && strongAlternateRisk && alternate.score >= requested.score + 4;
  return {
    different,
    requestedEncoding: normalizeEncoding(requestedEncoding),
    alternateEncoding: normalizeEncoding(alternateEncoding),
    requested,
    alternate,
    requestedLooksMojibake,
    alternateLooksMojibake,
    preferredEncoding: requestedLooksMojibake
      ? normalizeEncoding(alternateEncoding)
      : (alternateLooksMojibake ? normalizeEncoding(requestedEncoding) : null),
  };
}

module.exports = {
  compareChineseEncodingCandidates,
  createChecksum,
  decodeFileName,
  decodeText,
  decrypt,
  encrypt,
  normalizeEncoding,
  textEncodingRisk,
};
