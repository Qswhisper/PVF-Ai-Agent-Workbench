"use strict";

type DecodeTextOptions = Readonly<{ trimNull?: boolean }>;

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

module.exports = {
  createChecksum,
  decodeFileName,
  decodeText,
  decrypt,
  encrypt,
  normalizeEncoding,
};
