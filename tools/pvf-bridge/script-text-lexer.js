"use strict";
function codedError(code,message){return Object.assign(new Error(message),{code});}
function lexDecompiledScript(text) {
  const source = String(text || "");
  const atoms = [];
  let offset = 0;
  while (offset < source.length) {
    if (source.startsWith("#PVF_File", offset)) {
      offset += "#PVF_File".length;
      continue;
    }
    if (/\s/u.test(source[offset])) {
      offset += 1;
      continue;
    }
    const start = offset;
    if (source[offset] === "<") {
      const match = /^<(-?\d+)::([^>`]{1,512})`([^`]*)`>/u.exec(source.slice(offset));
      if (!match) throw codedError("RAW_ASCII_SCRIPT_LEX_FAILED", `无法解析 StringLink，位置 ${offset}。`);
      offset += match[0].length;
      atoms.push({ kind: "stringlink", namespace: Number(match[1]), key: match[2], display: match[3], start, end: offset });
      continue;
    }
    if (source[offset] === "`") {
      const end = source.indexOf("`", offset + 1);
      if (end < 0) throw codedError("RAW_ASCII_SCRIPT_LEX_FAILED", `反引号 token 未闭合，位置 ${offset}。`);
      offset = end + 1;
      atoms.push({ kind: "string", value: source.slice(start + 1, end), start, end: offset });
      continue;
    }
    if (source[offset] === "{") {
      const typedString = /^\{(\d+)=`([^`]*)`\}/u.exec(source.slice(offset));
      if (typedString) {
        offset += typedString[0].length;
        atoms.push({ kind: "typed-string", type: Number(typedString[1]), value: typedString[2], start, end: offset });
        continue;
      }
      const typedNumber = /^\{(\d+)=(-?\d+)\}/u.exec(source.slice(offset));
      if (typedNumber) {
        offset += typedNumber[0].length;
        atoms.push({ kind: "typed-number", type: Number(typedNumber[1]), valueText: typedNumber[2], start, end: offset });
        continue;
      }
      throw codedError("RAW_ASCII_SCRIPT_LEX_FAILED", `无法解析带类型 token，位置 ${offset}。`);
    }
    if (source[offset] === "[") {
      const end = source.indexOf("]", offset + 1);
      if (end < 0 || /[\r\n]/u.test(source.slice(offset, end + 1))) {
        throw codedError("RAW_ASCII_SCRIPT_LEX_FAILED", `Section 标签未闭合，位置 ${offset}。`);
      }
      offset = end + 1;
      atoms.push({ kind: "section", value: source.slice(start, offset), start, end: offset });
      continue;
    }
    const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)/u.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      atoms.push({ kind: "number", valueText: number[0], start, end: offset });
      continue;
    }
    throw codedError("RAW_ASCII_SCRIPT_LEX_FAILED", `无法解析脚本文本字符 ${JSON.stringify(source[offset])}，位置 ${offset}。`);
  }
  return atoms;
}


module.exports={lexDecompiledScript};
