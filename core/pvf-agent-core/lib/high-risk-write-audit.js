"use strict";

const crypto = require("crypto");
const path = require("path");

// These are deliberately narrow modes.  A caller cannot turn a protected
// extension into a generic write by merely setting a boolean; the controlled
// runner still performs the target-PVF checks in pvf-change-set.js.
const HIGH_RISK_NEW_FILE_MODES = Object.freeze({
  ".wdm": "worldmap-lifecycle",
  ".lst": "registry-lifecycle",
  ".co": "script-new-file",
  ".nut": "script-new-file",
  ".sqr": "script-new-file",
  ".str": "localization-new-file",
});

const EXISTING_NUT_CONTROLLED_MODE = "existing-nut-controlled-edit";

const PROTECTED_EXISTING_FILE_EXTENSIONS = new Set([
  ".co", ".lst", ".nut", ".sqr", ".str",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function extensionOf(pvfPath) {
  return path.posix.extname(normalizePvfPath(pvfPath).toLowerCase());
}

function resolveRegistryEntryPath(lstPath, rawPath) {
  const registry = normalizePvfPath(lstPath);
  const raw = normalizePvfPath(rawPath);
  const directory = path.posix.dirname(registry);
  if (!directory || directory === "." || raw.toLowerCase().startsWith(`${directory.toLowerCase()}/`)) return raw;
  return normalizePvfPath(`${directory}/${raw}`);
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sectionBody(text, tag) {
  const escaped = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = String(text || "");
  const closed = new RegExp(`\\[${escaped}\\][\\t ]*(?:\\r?\\n)?([\\s\\S]*?)\\[\\/${escaped}\\]`, "iu").exec(source);
  if (closed) return closed[1];
  // Scalar PVF tags such as [map image], [ui path] and [name] are commonly
  // left unclosed.  Bound their value by the next section marker instead of
  // treating the whole tail of the file as the value.
  const scalar = new RegExp(`\\[${escaped}\\][\\t ]*(?:\\r?\\n)?([\\s\\S]*?)(?=\\r?\\n\\s*\\[[^\\r\\n]+\\]|$)`, "iu").exec(source);
  return scalar ? scalar[1] : null;
}

function firstBacktick(value) {
  return String(value || "").match(/`([^`]*)`/u)?.[1] || null;
}

function allNumbers(value) {
  return (String(value || "").match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
}

/**
 * Parse a registry while retaining malformed lines.  This is intentionally
 * less permissive than a generic text search: an authorised registry change
 * must prove that every non-comment row has an unambiguous numeric key and a
 * complete backtick path.
 */
function parseRegistryRows(text) {
  const rows = [];
  const malformed = [];
  const lines = normalizeText(text).split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "#PVF_File" || trimmed.startsWith("#") || trimmed.startsWith("//")) return;
    const match = /^\s*(-?\d+)[\t ]+`([^`]+)`[\t ]*$/u.exec(line);
    if (!match) {
      malformed.push({ line: index + 1, text: line });
      return;
    }
    rows.push({
      id: Number(match[1]),
      pvfPath: normalizePvfPath(match[2]),
      rawPath: match[2],
      line: index + 1,
      text: line,
    });
  });
  const byId = new Map();
  const byPath = new Map();
  const duplicateIds = [];
  const duplicatePaths = [];
  for (const row of rows) {
    if (byId.has(row.id)) duplicateIds.push({ id: row.id, first: byId.get(row.id), second: row });
    else byId.set(row.id, row);
    const key = row.pvfPath.toLowerCase();
    if (byPath.has(key)) duplicatePaths.push({ pvfPath: row.pvfPath, first: byPath.get(key), second: row });
    else byPath.set(key, row);
  }
  return {
    rows,
    malformed,
    duplicateIds,
    duplicatePaths,
    byId,
    byPath,
    headerPresent: /^#PVF_File(?:\r?\n|$)/u.test(String(text || "")),
  };
}

function parsedRegistryRows(value) {
  return value && typeof value === "object" && Array.isArray(value.rows) && value.byId instanceof Map && value.byPath instanceof Map
    ? value
    : parseRegistryRows(value);
}

function countRegistryKeys(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function duplicateRegistrySummary(registry, sampleLimit = 20) {
  const idCounts = countRegistryKeys(registry.rows, (row) => String(row.id));
  const pathCounts = countRegistryKeys(registry.rows, (row) => row.pvfPath.toLowerCase());
  const idGroups = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id: Number(id), count }));
  const pathGroups = [...pathCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([pvfPath, count]) => ({ pvfPath, count }));
  return {
    duplicateIdGroupCount: idGroups.length,
    duplicatePathGroupCount: pathGroups.length,
    duplicateIds: idGroups.slice(0, sampleLimit),
    duplicatePaths: pathGroups.slice(0, sampleLimit),
    sampleLimit,
    truncated: idGroups.length > sampleLimit || pathGroups.length > sampleLimit,
  };
}

function duplicateRegistryExpansions(before, after) {
  const beforeIdCounts = countRegistryKeys(before.rows, (row) => String(row.id));
  const afterIdCounts = countRegistryKeys(after.rows, (row) => String(row.id));
  const beforePathCounts = countRegistryKeys(before.rows, (row) => row.pvfPath.toLowerCase());
  const afterPathCounts = countRegistryKeys(after.rows, (row) => row.pvfPath.toLowerCase());
  const expansions = [];
  for (const [id, afterCount] of afterIdCounts.entries()) {
    const beforeCount = beforeIdCounts.get(id) || 0;
    if (afterCount > 1 && afterCount > beforeCount) {
      expansions.push({ kind: "id", value: Number(id), beforeCount, afterCount });
    }
  }
  for (const [pvfPath, afterCount] of afterPathCounts.entries()) {
    const beforeCount = beforePathCounts.get(pvfPath) || 0;
    if (afterCount > 1 && afterCount > beforeCount) {
      expansions.push({ kind: "path", value: pvfPath, beforeCount, afterCount });
    }
  }
  return expansions;
}

function parseWorldmapText(text) {
  const dungeonBody = sectionBody(text, "dungeon");
  const dungeonTokens = allNumbers(dungeonBody || "");
  // Worldmap dungeon records are observed as ID/condition pairs.  Preserve
  // the complete token list, but expose only the ID positions for closure.
  const dungeonIds = [];
  for (let index = 0; index < dungeonTokens.length; index += 2) dungeonIds.push(dungeonTokens[index]);
  return {
    mapImage: firstBacktick(sectionBody(text, "map image")),
    uiPath: firstBacktick(sectionBody(text, "ui path")),
    dungeonIds: dungeonIds.filter((id) => Number.isInteger(id) && id >= 0),
    dungeonTokens,
    name: firstBacktick(sectionBody(text, "name")),
    hasDungeonSection: dungeonBody !== null,
  };
}

function parseWorldmapUiButtons(text) {
  const blocks = normalizeText(text).match(/\[ui controls\][\s\S]*?\[\/ui controls\]/giu) || [];
  const buttons = [];
  for (const block of blocks) {
    if (!/\[balloon\]/iu.test(block)) continue;
    const control = /`(IDC_WORLDMAP_BUTTON[^`]*)`[\t ]+([^\r\n]+)/iu.exec(block);
    if (!control) continue;
    const image = /`[^`]+\.img`[\t ]+([^\r\n]+)/iu.exec(block);
    const numbers = allNumbers(image?.[1] || "");
    const dungeonId = numbers.length ? numbers[numbers.length - 1] : null;
    buttons.push({
      controlId: control[1],
      controlParameters: control[2].trim(),
      dungeonId: Number.isInteger(dungeonId) ? dungeonId : null,
      hasImageBinding: Boolean(image),
    });
  }
  return buttons;
}

function parseTownWorldmapGates(text) {
  const values = [];
  const source = normalizeText(text);
  const re = /`?\[dungeon gate\]`?[\t ]*(?:\n[\t ]*)?([-+]?\d+)/giu;
  let match;
  while ((match = re.exec(source))) values.push(Number(match[1]));
  return values.filter(Number.isInteger);
}

function parseRegionTownIds(text) {
  return allNumbers(sectionBody(text, "towns") || "").filter(Number.isInteger);
}

function scanBalancedScript(text, options = {}) {
  const source = String(text || "");
  const errors = [];
  if (!source.trim()) errors.push("empty-source");
  if (source.includes("\0")) errors.push("nul-byte");
  if (options.requireHeader !== false && !/^#PVF_File(?:\r?\n|$)/u.test(source)) errors.push("missing-pvf-header");
  let quote = false;
  let escaped = false;
  const stack = [];
  const pairs = new Map([["}", "{"], ["]", "["], [")", "("]]);
  const openers = new Set(["{", "[", "("]);
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "`") quote = false;
      continue;
    }
    if (ch === "`") { quote = true; continue; }
    if (openers.has(ch)) stack.push({ ch, index });
    else if (pairs.has(ch)) {
      const top = stack.pop();
      if (!top || top.ch !== pairs.get(ch)) errors.push(`unbalanced-${ch}@${index}`);
    }
  }
  if (quote) errors.push("unclosed-backtick");
  if (stack.length) errors.push("unclosed-delimiter");
  return { ok: errors.length === 0, errors };
}

function safeAsciiScriptText(value) {
  return typeof value === "string" && /^[\x09\x0a\x0d\x20-\x7e]*$/u.test(value);
}

function identifierPattern(value) {
  return /^[A-Za-z_][A-Za-z0-9_.:]*$/u.test(String(value || ""));
}

function containsExactIdentifier(text, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = maskSquirrelNonCode(text).masked;
  return escaped.length > 0 && new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "u").test(code);
}

function squirrelFunctionCallRanges(text, name) {
  const source = String(text || "");
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped.length) return [];
  const code = maskSquirrelNonCode(source).masked;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escaped})\\s*\\(`, "gu");
  const ranges = [];
  let match;
  while ((match = pattern.exec(code))) {
    const nameStart = match.index + match[1].length;
    const declarationPrefix = code.slice(Math.max(0, nameStart - 64), nameStart);
    if (/\bfunction\s+[A-Za-z0-9_.:]*$/u.test(declarationPrefix)) continue;
    const parenStart = code.indexOf("(", nameStart + match[2].length);
    const parenEnd = matchingDelimiter(code, parenStart, "(", ")");
    if (parenStart >= 0 && parenEnd >= 0) ranges.push({ nameStart, parenStart, parenEnd });
  }
  return ranges;
}

function containsExactFunctionCall(text, name) {
  return squirrelFunctionCallRanges(text, name).length > 0;
}

function containsExactIntegerInFunctionCall(text, name, value) {
  const source = String(text || "");
  return squirrelFunctionCallRanges(source, name).some((range) =>
    containsExactInteger(source.slice(range.parenStart + 1, range.parenEnd), value));
}

function containsExactInteger(text, value) {
  const token = String(value);
  const code = maskSquirrelNonCode(text).masked;
  return new RegExp(`(^|[^A-Za-z0-9_.+\\-])${token}(?=$|[^A-Za-z0-9_.])`, "u").test(code);
}

function maskSquirrelComments(text) {
  const source = String(text || "");
  const chars = source.split("");
  let state = "code";
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (ch === "\n" || ch === "\r") state = "code";
      else chars[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (ch !== "\n" && ch !== "\r") chars[index] = " ";
      continue;
    }
    if (["single-quote", "double-quote", "backtick"].includes(state)) {
      const closing = state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === closing) state = "code";
      continue;
    }
    if (ch === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "line-comment";
    } else if (ch === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "block-comment";
    } else if (ch === "'") {
      state = "single-quote";
      escaped = false;
    } else if (ch === '"') {
      state = "double-quote";
      escaped = false;
    } else if (ch === "`") {
      state = "backtick";
      escaped = false;
    }
  }
  return chars.join("");
}

function maskSquirrelNonCode(text) {
  const source = String(text || "");
  const chars = source.split("");
  let state = "code";
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (ch === "\n" || ch === "\r") state = "code";
      else chars[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (ch !== "\n" && ch !== "\r") chars[index] = " ";
      continue;
    }
    if (["single-quote", "double-quote", "backtick"].includes(state)) {
      const closing = state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";
      if (ch !== "\n" && ch !== "\r") chars[index] = " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === closing) state = "code";
      continue;
    }
    if (ch === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "line-comment";
    } else if (ch === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "block-comment";
    } else if (ch === "'") {
      chars[index] = " ";
      state = "single-quote";
      escaped = false;
    } else if (ch === '"') {
      chars[index] = " ";
      state = "double-quote";
      escaped = false;
    } else if (ch === "`") {
      chars[index] = " ";
      state = "backtick";
      escaped = false;
    }
  }
  return {
    masked: chars.join(""),
    terminalState: state,
    ok: state === "code" || state === "line-comment",
  };
}

function containsExecutableFragment(text, fragment) {
  const source = String(text || "");
  const needle = String(fragment || "");
  const anchorOffset = needle.search(/\S/u);
  if (!needle.length || anchorOffset < 0) return false;
  const code = maskSquirrelNonCode(source).masked;
  const commentsRemoved = maskSquirrelComments(source);
  let offset = source.indexOf(needle);
  while (offset >= 0) {
    const anchor = offset + anchorOffset;
    const entirelyOutsideComments = [...needle].every((character, index) =>
      /\s/u.test(character) || commentsRemoved[offset + index] === source[offset + index]);
    if (entirelyOutsideComments && code[anchor] === source[anchor]) return true;
    offset = source.indexOf(needle, offset + 1);
  }
  return false;
}

function matchingDelimiter(masked, start, opener, closer) {
  if (masked[start] !== opener) return -1;
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === opener) depth += 1;
    else if (masked[index] === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function scanSquirrelStructure(text) {
  const source = String(text || "");
  const lexical = maskSquirrelNonCode(source);
  const errors = [];
  if (!source.trim()) errors.push("empty-source");
  if (source.includes("\0")) errors.push("nul-byte");
  if (!lexical.ok) errors.push(`unterminated-${lexical.terminalState}`);
  const pairs = new Map([["}", "{"], ["]", "["], [")", "("]]);
  const openers = new Set(["{", "[", "("]);
  const stack = [];
  for (let index = 0; index < lexical.masked.length; index += 1) {
    const ch = lexical.masked[index];
    if (openers.has(ch)) stack.push({ ch, index });
    else if (pairs.has(ch)) {
      const top = stack.pop();
      if (!top || top.ch !== pairs.get(ch)) errors.push(`unbalanced-${ch}@${index}`);
    }
  }
  if (stack.length) errors.push("unclosed-delimiter");

  const candidates = [];
  const patterns = [
    /\bfunction\s+([A-Za-z_][A-Za-z0-9_.:]*)\s*\(/gu,
    /\b([A-Za-z_][A-Za-z0-9_.:]*)\s*(?:<-|=)\s*function\s*\(/gu,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(lexical.masked))) {
      const parenStart = lexical.masked.indexOf("(", match.index);
      const parenEnd = matchingDelimiter(lexical.masked, parenStart, "(", ")");
      if (parenEnd < 0) {
        errors.push(`function-parameters-unclosed:${match[1]}`);
        continue;
      }
      let bodyStart = parenEnd + 1;
      while (/\s/u.test(lexical.masked[bodyStart] || "")) bodyStart += 1;
      if (lexical.masked[bodyStart] !== "{") {
        errors.push(`function-body-missing:${match[1]}`);
        continue;
      }
      const bodyEnd = matchingDelimiter(lexical.masked, bodyStart, "{", "}");
      if (bodyEnd < 0) {
        errors.push(`function-body-unclosed:${match[1]}`);
        continue;
      }
      candidates.push({
        name: match[1],
        start: match.index,
        bodyStart,
        end: bodyEnd + 1,
        text: source.slice(match.index, bodyEnd + 1),
      });
    }
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const functions = [];
  for (const candidate of candidates) {
    const overlapping = functions.find((item) => candidate.start < item.end && candidate.end > item.start);
    if (overlapping) {
      if (candidate.start !== overlapping.start || candidate.end !== overlapping.end) {
        errors.push(`nested-or-overlapping-function:${candidate.name}`);
      }
      continue;
    }
    functions.push(candidate);
  }
  const counts = new Map();
  for (const fn of functions) counts.set(fn.name, (counts.get(fn.name) || 0) + 1);
  for (const [name, count] of counts) if (count !== 1) errors.push(`duplicate-function:${name}`);
  return { ok: errors.length === 0, errors, functions, masked: lexical.masked };
}

function normalizedPathMention(text, pvfPath) {
  const haystack = normalizePvfPath(text).toLowerCase();
  const target = normalizePvfPath(pvfPath).toLowerCase();
  const withoutSqr = target.startsWith("sqr/") ? target.slice(4) : target;
  return Boolean(target) && (haystack.includes(target) || (withoutSqr && haystack.includes(withoutSqr)));
}

function pathMentionInsideFunctionCall(text, pvfPath) {
  const source = String(text || "");
  const target = normalizePvfPath(pvfPath).toLowerCase();
  const variants = [target, target.startsWith("sqr/") ? target.slice(4) : target].filter(Boolean);
  if (!variants.length) return false;
  const code = maskSquirrelNonCode(source).masked;
  const commentsRemoved = maskSquirrelComments(source).toLowerCase();
  const pattern = /(^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.:]*)\s*\(/gu;
  let match;
  while ((match = pattern.exec(code))) {
    const nameStart = match.index + match[1].length;
    const declarationPrefix = code.slice(Math.max(0, nameStart - 64), nameStart);
    if (/\bfunction\s+[A-Za-z0-9_.:]*$/u.test(declarationPrefix)) continue;
    const parenStart = code.indexOf("(", nameStart + match[2].length);
    const parenEnd = matchingDelimiter(code, parenStart, "(", ")");
    if (parenStart < 0 || parenEnd < 0) continue;
    const argumentsWithoutComments = commentsRemoved.slice(parenStart + 1, parenEnd);
    if (variants.some((candidate) => argumentsWithoutComments.includes(candidate))) return true;
  }
  return false;
}

// Explicit opt-in. No arbitrary loader call, dynamic path, or cross-job registration.
function directStateRegistration(link) {
  const source = String(link?.requiredText || "").trim();
  const match = /^IRDSQRCharacter\.pushState\(\s*(ENUM_CHARACTERJOB_[A-Z_]+)\s*,\s*"([A-Za-z0-9_/]+\.nut)"\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*(STATE_[A-Z0-9_]+)\s*,\s*(SKILL_[A-Z0-9_]+)\s*\);$/u.exec(source);
  const loader = /^sqr\/character\/([a-z0-9]+)_load_state\.nut$/u.exec(normalizePvfPath(link?.fromPvfPath).toLowerCase());
  if (!match || !loader) return null;
  const target = normalizePvfPath(link?.toPvfPath).toLowerCase();
  if (match[1].slice("ENUM_CHARACTERJOB_".length).replaceAll("_", "").toLowerCase() !== loader[1] ||
      target !== `sqr/${match[2].toLowerCase()}` ||
      !target.startsWith(`sqr/character/${loader[1]}/`)) return null;
  return { callbackSuffix: match[3], jobSymbol: match[1], stateSymbol: match[4], skillSymbol: match[5] };
}

function directStateReferencePresent(text, link) {
  return directRegistrationReferencePresent(text, link, directStateRegistration);
}

// Only the existing skill-use hooks in the same character's canonical common file.
function directSkillUseRegistration(link) {
  const loader = /^sqr\/character\/([a-z0-9]+)_load_state\.nut$/u.exec(normalizePvfPath(link?.fromPvfPath).toLowerCase());
  const match = /^IRDSQRCharacter\.pushScriptFiles\(\s*"(Character\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)_common\.nut)"\s*\);$/iu.exec(String(link?.requiredText || "").trim());
  if (!loader || !match || !String(link.requiredText).trim().startsWith("IRDSQRCharacter.pushScriptFiles(")) return null;
  if (match[2].toLowerCase() !== loader[1] || match[3].toLowerCase() !== loader[1] ||
      normalizePvfPath(link.toPvfPath).toLowerCase() !== `sqr/${match[1].toLowerCase()}`) return null;
  return { job: loader[1] };
}

function directSkillUseReferencePresent(text, link) {
  return directRegistrationReferencePresent(text, link, directSkillUseRegistration);
}

// A single existing skill proc, reached unconditionally from the same-job dispatcher.
function directSkillProcRegistration(proof) {
  const common = directSkillUseRegistration(proof?.loadChain?.[0]);
  const evidence = proof?.skillProc;
  const state = directStateRegistration(evidence?.stateRegistration);
  if (!common || !state || !evidence) return null;
  const loader = normalizePvfPath(proof.loadChain[0].fromPvfPath).toLowerCase();
  const header = evidence.headerRegistration;
  const headerMatch = /^IRDSQRCharacter\.pushScriptFiles\(\s*"(Character\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)_header\.nut)"\s*\);$/u.exec(String(header?.requiredText || "").trim());
  if (normalizePvfPath(evidence.stateRegistration.fromPvfPath).toLowerCase() !== loader ||
      normalizePvfPath(header?.fromPvfPath).toLowerCase() !== loader || !headerMatch ||
      headerMatch[2].toLowerCase() !== common.job || headerMatch[3].toLowerCase() !== common.job ||
      normalizePvfPath(header.toPvfPath).toLowerCase() !== `sqr/${headerMatch[1].toLowerCase()}` ||
      normalizePvfPath(evidence.skillRegistryPath).toLowerCase() !== `skill/${common.job}skill.lst` ||
      !new RegExp(`^skill/${common.job}/[a-z0-9_/]+\\.skl$`, "u").test(normalizePvfPath(evidence.skillPvfPath).toLowerCase()) ||
      !Number.isSafeInteger(evidence.skillId) || evidence.skillId < 0 || evidence.skillId > 2147483647 ||
      !/^procSkill_[A-Za-z0-9]+$/u.test(String(evidence.dispatcher || "")) ||
      evidence.dispatcher.slice("procSkill_".length).toLowerCase() !== common.job ||
      evidence.requiredCall !== `procSkill_${state.callbackSuffix}(obj);`) return null;
  return { job: common.job, ...state, callee: `procSkill_${state.callbackSuffix}`, dispatcher: evidence.dispatcher };
}

function directSkillProcEvidence(proof, { commonText, loaderText, headerText, registryText, skillText, stateText }) {
  const errors = [];
  const registration = directSkillProcRegistration(proof);
  if (!registration) return { ok: false, errors: ["invalid direct-character-skill-proc registration"] };
  const evidence = proof.skillProc;
  if (!directSkillUseReferencePresent(loaderText, proof.loadChain[0]) ||
      !directStateReferencePresent(loaderText, evidence.stateRegistration) ||
      !directRegistrationReferencePresent(loaderText, evidence.headerRegistration, () => registration)) errors.push("skill-proc loader evidence is not executable top-level registration");
  const structure = scanSquirrelStructure(commonText);
  const dispatchers = structure.functions.filter((fn) => fn.name === registration.dispatcher);
  const callees = structure.functions.filter((fn) => fn.name === registration.callee);
  if (dispatchers.length !== 1 || callees.length !== 1) errors.push("skill-proc dispatcher and callee must already exist exactly once");
  else {
    const fn = dispatchers[0];
    const body = structure.masked.slice(fn.bodyStart + 1, fn.end - 1);
    const calls = [...body.matchAll(/\bprocSkill_[A-Za-z0-9_]+\s*\(\s*obj\s*\)\s*;/gu)];
    if (body.replace(/\bprocSkill_[A-Za-z0-9_]+\s*\(\s*obj\s*\)\s*;/gu, "").trim() ||
        calls.filter((item) => item[0].replace(/\s/gu, "") === evidence.requiredCall).length !== 1 ||
        !/^function\s+\w+\s*\(\s*obj\s*\)\s*\{/u.test(fn.text)) errors.push("skill-proc dispatcher must contain only unconditional standalone obj calls, including the declared callee once");
    const calleeCode = maskSquirrelNonCode(callees[0].text).masked;
    if (!new RegExp(`\\bsq_Get(?:LevelData|IntData|SkillLevel)\\s*\\(\\s*(?:obj\\s*,\\s*)?${registration.skillSymbol}\\b`, "u").test(calleeCode)) errors.push("skill-proc callee lacks an existing skill-data API call using the registered skill symbol");
  }
  const headerCode = maskSquirrelNonCode(headerText).masked;
  const declaration = new RegExp(`^\\s*${registration.skillSymbol}[ \\t]*<-[ \\t]*${evidence.skillId}[ \\t]*;?[ \\t]*$`, "mu").exec(headerCode);
  if ([...headerCode.matchAll(new RegExp(`\\b${registration.skillSymbol}\\b`, "gu"))].length !== 1 || !declaration ||
      /[{}()]/u.test(headerCode.slice(0, declaration?.index || 0))) errors.push("skill-proc header must contain one top-level literal skill ID declaration");
  const registry = parseRegistryRows(registryText);
  const rows = registry.rows.filter((row) => row.id === evidence.skillId);
  if (!registry.headerPresent || registry.malformed.length || rows.length !== 1 ||
      resolveRegistryEntryPath(evidence.skillRegistryPath, rows[0]?.rawPath || "").toLowerCase() !== normalizePvfPath(evidence.skillPvfPath).toLowerCase()) errors.push("skill-proc skill registry ID/path evidence does not match");
  if (!String(skillText || "").startsWith("#PVF_File") || !/\[name\]/u.test(skillText)) errors.push("skill-proc registered skill must be read back");
  if (!scanSquirrelStructure(stateText).functions.some((fn) => fn.name.endsWith(`_${registration.callbackSuffix}`))) errors.push("skill-proc registered state script lacks its callback");
  return { ok: errors.length === 0, errors, ...registration, skillId: evidence.skillId };
}

function directRegistrationReferencePresent(text, link, parseRegistration) {
  if (!parseRegistration(link) || !containsExecutableFragment(text, link.requiredText)) return false;
  const needle = String(link.requiredText);
  const source = String(text);
  const offset = source.indexOf(needle);
  if (offset < 0 || source.indexOf(needle, offset + 1) >= 0) return false;
  const code = maskSquirrelNonCode(source).masked;
  // Registration must be a standalone top-level statement, never a conditional body,
  // function, loop, assignment, or expression hidden behind an executable prefix.
  const prefix = code.slice(0, offset);
  if (/[{}()\[\]]/u.test(prefix.replace(/[^{}()\[\]]/gu, ""))) {
    const stack = [];
    for (const ch of prefix) {
      if ("{([".includes(ch)) stack.push(ch);
      else if ("})]".includes(ch) && stack.pop() !== ({"}": "{", ")": "(", "]": "["})[ch]) return false;
    }
    if (stack.length) return false;
  }
  const priorStatement = prefix.slice(Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("}")) + 1);
  return !priorStatement.trim();
}

function validateExistingNutWriteProofShape(pvfPath, proof) {
  const errors = [];
  const normalizedTarget = normalizePvfPath(pvfPath);
  if (extensionOf(normalizedTarget) !== ".nut") errors.push(`${EXISTING_NUT_CONTROLLED_MODE} requires an existing .nut pvfPath`);
  if (!normalizedTarget.toLowerCase().startsWith("sqr/")) errors.push(`${EXISTING_NUT_CONTROLLED_MODE} is limited to runtime scripts under sqr/`);
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    return { ok: false, expectedMode: EXISTING_NUT_CONTROLLED_MODE, errors: [`existing .nut requires writeProof.mode=${EXISTING_NUT_CONTROLLED_MODE}`] };
  }
  if (proof.mode !== EXISTING_NUT_CONTROLLED_MODE) errors.push(`writeProof.mode must be ${EXISTING_NUT_CONTROLLED_MODE}`);
  if (!/^[a-f0-9]{64}$/iu.test(String(proof.sourceTextSha256 || ""))) errors.push("writeProof.sourceTextSha256 must be a SHA256 hex string");
  for (const field of ["structureCheckRequired", "temporaryRoundTripRequired", "runtimeValidationRequired"]) {
    if (proof[field] !== true) errors.push(`writeProof.${field} must be true`);
  }
  const loadChain = Array.isArray(proof.loadChain) ? proof.loadChain : [];
  const directState = proof.loadChainKind === "direct-character-state";
  const directSkillUse = proof.loadChainKind === "direct-character-skill-use";
  const directSkillProc = proof.loadChainKind === "direct-character-skill-proc";
  if (proof.loadChainKind !== undefined && !["appendage", "direct-character-state", "direct-character-skill-use", "direct-character-skill-proc"].includes(proof.loadChainKind)) errors.push("unknown writeProof.loadChainKind");
  if ((directState || directSkillUse || directSkillProc) ? loadChain.length !== 1 : loadChain.length < 2) errors.push("writeProof.loadChain has invalid length for its declared kind");
  const skillProcRegistration = directSkillProc ? directSkillProcRegistration(proof) : null;
  if (directSkillProc && !skillProcRegistration) errors.push("direct-character-skill-proc requires same-job common, state, header and skill registry evidence");
  if (!directSkillProc && proof.skillProc !== undefined) errors.push("writeProof.skillProc requires direct-character-skill-proc");
  const registration = directState ? directStateRegistration(loadChain[0]) : null;
  const skillUseRegistration = directSkillUse ? directSkillUseRegistration(loadChain[0]) : null;
  if (directSkillUse && !skillUseRegistration) errors.push("direct-character-skill-use requires a literal same-job canonical common-file registration");
  if (directState && !registration) errors.push("direct-character-state requires a literal same-job IRDSQRCharacter.pushState registration");
  for (const [index, link] of loadChain.entries()) {
    const fromPvfPath = normalizePvfPath(link?.fromPvfPath);
    const toPvfPath = normalizePvfPath(link?.toPvfPath);
    if (!fromPvfPath || extensionOf(fromPvfPath) !== ".nut") errors.push(`writeProof.loadChain[${index}].fromPvfPath must be a .nut path`);
    if (!toPvfPath || extensionOf(toPvfPath) !== ".nut") errors.push(`writeProof.loadChain[${index}].toPvfPath must be a .nut path`);
    if ((fromPvfPath && !fromPvfPath.toLowerCase().startsWith("sqr/")) || (toPvfPath && !toPvfPath.toLowerCase().startsWith("sqr/"))) {
      errors.push(`writeProof.loadChain[${index}] paths must stay under sqr/`);
    }
    if (typeof link?.requiredText !== "string" || !link.requiredText.length || !safeAsciiScriptText(link.requiredText)) {
      errors.push(`writeProof.loadChain[${index}].requiredText must be non-empty ASCII source text`);
    } else if (!normalizedPathMention(link.requiredText, toPvfPath) || !pathMentionInsideFunctionCall(link.requiredText, toPvfPath)) {
      errors.push(`writeProof.loadChain[${index}].requiredText must pass toPvfPath as an executable function-call argument`);
    }
    if (index > 0 && normalizePvfPath(loadChain[index - 1]?.toPvfPath).toLowerCase() !== fromPvfPath.toLowerCase()) {
      errors.push(`writeProof.loadChain[${index}] is not continuous with the previous link`);
    }
  }
  const firstFrom = normalizePvfPath(loadChain[0]?.fromPvfPath).toLowerCase();
  if (loadChain.length && !/(?:^|\/)\w*_?load_state\.nut$/u.test(firstFrom)) errors.push("writeProof.loadChain must start from a load_state .nut");
  if (!directState && !directSkillUse && !directSkillProc && loadChain.length && !loadChain.some((link) => /(?:^|\/)passive_skill_[^/]+\.nut$/u.test(normalizePvfPath(link?.fromPvfPath).toLowerCase()))) {
    errors.push("writeProof.loadChain must include a passive_skill_*.nut source link");
  }
  const finalTo = normalizePvfPath(loadChain[loadChain.length - 1]?.toPvfPath).toLowerCase();
  if (loadChain.length && finalTo !== normalizedTarget.toLowerCase()) errors.push("writeProof.loadChain must end at the edited .nut path");

  const touchedFunctions = Array.isArray(proof.touchedFunctions) ? proof.touchedFunctions : [];
  if (!touchedFunctions.length) errors.push("writeProof.touchedFunctions must name every added or modified function");
  if (touchedFunctions.some((name) => !identifierPattern(name))) errors.push("writeProof.touchedFunctions contains an invalid function name");
  if (new Set(touchedFunctions).size !== touchedFunctions.length) errors.push("writeProof.touchedFunctions contains duplicates");
  if (skillProcRegistration && (touchedFunctions.length !== 1 || touchedFunctions[0] !== skillProcRegistration.callee)) errors.push("direct-character-skill-proc may only edit the one registered existing proc callee");
  if (registration && touchedFunctions.some((name) => !name.endsWith(`_${registration.callbackSuffix}`))) errors.push("direct-character-state may only edit registered callback functions");
  if (skillUseRegistration && touchedFunctions.some((name) => {
    const match = /^useSkill_(before|after)_([A-Za-z0-9]+)$/u.exec(name);
    return !match || match[2].toLowerCase() !== skillUseRegistration.job;
  })) errors.push("direct-character-skill-use may only edit same-job useSkill_before/after hooks");

  const apiSymbols = Array.isArray(proof.apiSymbols) ? proof.apiSymbols : [];
  if (!apiSymbols.length) errors.push("writeProof.apiSymbols must contain at least one DNF API or constant");
  const apiSymbolKeys = apiSymbols.map((symbol) => `${String(symbol?.kind || "")}\0${String(symbol?.name || "")}`);
  if (new Set(apiSymbolKeys).size !== apiSymbolKeys.length) errors.push("writeProof.apiSymbols contains duplicates");
  for (const [index, symbol] of apiSymbols.entries()) {
    if (!identifierPattern(symbol?.name)) errors.push(`writeProof.apiSymbols[${index}].name is invalid`);
    if (!new Set(["function", "constant"]).has(symbol?.kind)) errors.push(`writeProof.apiSymbols[${index}].kind must be function or constant`);
    if (!Array.isArray(symbol?.targetEvidencePaths) || symbol.targetEvidencePaths.length === 0) {
      errors.push(`writeProof.apiSymbols[${index}].targetEvidencePaths must contain at least one target-PVF script`);
    } else if (symbol.targetEvidencePaths.some((candidate) =>
      !new Set([".nut", ".sqr"]).has(extensionOf(candidate)) || !normalizePvfPath(candidate).toLowerCase().startsWith("sqr/"))) {
      errors.push(`writeProof.apiSymbols[${index}].targetEvidencePaths must contain only .nut/.sqr paths under sqr/`);
    }
  }

  const apidPlan = proof.apidPlan;
  if (!apidPlan || typeof apidPlan !== "object" || Array.isArray(apidPlan)) errors.push("writeProof.apidPlan is required");
  else {
    if (!/^[A-Za-z0-9._-]+$/u.test(String(apidPlan.namespace || ""))) errors.push("writeProof.apidPlan.namespace must be stable ASCII");
    if (!Array.isArray(apidPlan.ids)) errors.push("writeProof.apidPlan.ids must be an array (use [] when no new APID is introduced)");
    else {
      if (apidPlan.ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) errors.push("writeProof.apidPlan.ids must contain positive 32-bit safe integers");
      if (new Set(apidPlan.ids).size !== apidPlan.ids.length) errors.push("writeProof.apidPlan.ids contains duplicates");
    }
    if (apidPlan.conflictSearchRequired !== true) errors.push("writeProof.apidPlan.conflictSearchRequired must be true");
  }
  return { ok: errors.length === 0, expectedMode: EXISTING_NUT_CONTROLLED_MODE, errors };
}

function stripFunctionBodiesForTransition(text, functions) {
  const source = String(text || "");
  let cursor = 0;
  const parts = [];
  for (const fn of [...functions].sort((left, right) => left.start - right.start)) {
    parts.push(source.slice(cursor, fn.start));
    cursor = fn.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("").replace(/\s+/gu, "");
}

function validateExistingNutTextTransition(pvfPath, beforeText, afterText, proof, changes = []) {
  const shape = validateExistingNutWriteProofShape(pvfPath, proof);
  const errors = [...shape.errors];
  const before = String(beforeText || "");
  const after = String(afterText || "");
  const beforeSha256 = sha256(Buffer.from(before, "utf8"));
  const afterSha256 = sha256(Buffer.from(after, "utf8"));
  if (shape.ok && String(proof.sourceTextSha256).toLowerCase() !== beforeSha256.toLowerCase()) {
    errors.push("writeProof.sourceTextSha256 does not match the original raw .nut text");
  }
  for (const [index, change] of (Array.isArray(changes) ? changes : []).entries()) {
    if (!safeAsciiScriptText(change?.previousText) || !safeAsciiScriptText(change?.newText)) {
      errors.push(`change[${index}] must contain only ASCII text, Tab, CR and LF`);
    }
    if (/<\s*\d+\s*::[^>`]{1,512}`[^`]*`>/u.test(String(change?.previousText || "")) ||
        /<\s*\d+\s*::[^>`]{1,512}`[^`]*`>/u.test(String(change?.newText || ""))) {
      errors.push(`change[${index}] must not modify StringLink display text`);
    }
  }
  const beforeStructure = scanSquirrelStructure(before);
  const afterStructure = scanSquirrelStructure(after);
  // The skill-use lane may retain legacy duplicate empty stubs, never edit them.
  // Do not let the name-keyed maps below hide a changed or newly added duplicate.
  const retainedEmptyDuplicates = [];
  if (shape.ok && ["direct-character-skill-use", "direct-character-skill-proc"].includes(proof.loadChainKind)) {
    for (const issue of beforeStructure.errors) {
      if (!issue.startsWith("duplicate-function:")) continue;
      const name = issue.slice("duplicate-function:".length);
      const oldFns = beforeStructure.functions.filter((fn) => fn.name === name);
      const newFns = afterStructure.functions.filter((fn) => fn.name === name);
      const oldOrder = beforeStructure.functions.map((fn) => fn.name);
      const newOrder = afterStructure.functions.map((fn) => fn.name);
      if (!proof.touchedFunctions.includes(name) && oldFns.length > 1 &&
          oldFns.length === newFns.length && JSON.stringify(oldOrder) === JSON.stringify(newOrder) &&
          oldFns.every((fn, index) => /^\s*$/u.test(before.slice(fn.bodyStart + 1, fn.end - 1)) && fn.text === newFns[index].text)) {
        retainedEmptyDuplicates.push(name);
      }
    }
  }
  const retainedIssue = (item) => retainedEmptyDuplicates.some((name) => item === `duplicate-function:${name}`);
  const sourceErrors = beforeStructure.errors.filter((item) => !retainedIssue(item));
  const finalErrors = afterStructure.errors.filter((item) => !retainedIssue(item));
  errors.push(...sourceErrors.map((item) => `source:${item}`), ...finalErrors.map((item) => `final:${item}`));
  const beforeFunctions = new Map(beforeStructure.functions.map((fn) => [fn.name, fn]));
  const afterFunctions = new Map(afterStructure.functions.map((fn) => [fn.name, fn]));
  const touched = new Set(Array.isArray(proof?.touchedFunctions) ? proof.touchedFunctions : []);
  const changedFunctions = [];
  const addedFunctions = [];
  for (const [name, sourceFn] of beforeFunctions) {
    const finalFn = afterFunctions.get(name);
    if (!finalFn) {
      errors.push(`existing function was removed: ${name}`);
      continue;
    }
    if (sourceFn.text !== finalFn.text) {
      changedFunctions.push(name);
      if (!touched.has(name)) errors.push(`modified function is missing from writeProof.touchedFunctions: ${name}`);
    }
  }
  for (const [name] of afterFunctions) {
    if (!beforeFunctions.has(name)) {
      addedFunctions.push(name);
      if (!touched.has(name)) errors.push(`added function is missing from writeProof.touchedFunctions: ${name}`);
    }
  }
  for (const name of touched) {
    if (["direct-character-skill-use", "direct-character-skill-proc"].includes(proof?.loadChainKind) && !beforeFunctions.has(name)) errors.push(`common hook must already exist: ${name}`);
    if (!afterFunctions.has(name)) errors.push(`declared touched function is missing from final script: ${name}`);
    else if (!changedFunctions.includes(name) && !addedFunctions.includes(name)) errors.push(`declared touched function did not change: ${name}`);
  }
  if (stripFunctionBodiesForTransition(before, beforeStructure.functions) !== stripFunctionBodiesForTransition(after, afterStructure.functions)) {
    errors.push("existing NUT route cannot change non-function top-level code");
  }
  for (const symbol of Array.isArray(proof?.apiSymbols) ? proof.apiSymbols : []) {
    const used = symbol?.kind === "function"
      ? containsExactFunctionCall(after, symbol?.name)
      : containsExactIdentifier(after, symbol?.name);
    if (!used) errors.push(`declared API/constant is not used by final script: ${symbol?.name}`);
  }
  for (const id of Array.isArray(proof?.apidPlan?.ids) ? proof.apidPlan.ids : []) {
    if (containsExactInteger(before, id)) errors.push(`new APID already occurs in the original target script: ${id}`);
    const apiFunctions = (Array.isArray(proof?.apiSymbols) ? proof.apiSymbols : [])
      .filter((symbol) => symbol?.kind === "function")
      .map((symbol) => symbol.name);
    if (!apiFunctions.some((name) => containsExactIntegerInFunctionCall(after, name, id))) {
      errors.push(`declared APID is not used by a declared API call in the final target script: ${id}`);
    }
  }
  return {
    ok: errors.length === 0,
    mode: EXISTING_NUT_CONTROLLED_MODE,
    errors,
    sourceTextSha256: beforeSha256,
    finalTextSha256: afterSha256,
    sourceStructureOk: sourceErrors.length === 0,
    finalStructureOk: finalErrors.length === 0,
    retainedEmptyDuplicates,
    sourceFunctionCount: beforeStructure.functions.length,
    finalFunctionCount: afterStructure.functions.length,
    changedFunctions,
    addedFunctions,
    touchedFunctions: [...touched],
    apids: Array.isArray(proof?.apidPlan?.ids) ? [...proof.apidPlan.ids] : [],
  };
}

function validateNewFileText(pvfPath, text, proof = {}) {
  const ext = extensionOf(pvfPath);
  const errors = [];
  const source = String(text || "");
  if (source.includes("\0")) errors.push("NUL byte is not allowed");
  if (proof.sourceTextSha256 && proof.sourceTextSha256.toLowerCase() !== sha256(Buffer.from(source, "utf8")).toLowerCase()) {
    errors.push("writeProof.sourceTextSha256 does not match source text");
  }
  if (ext === ".lst") {
    const registry = parseRegistryRows(source);
    if (!registry.headerPresent) errors.push("registry must begin with #PVF_File");
    if (!registry.rows.length) errors.push("registry must contain at least one ID/path row");
    if (registry.malformed.length) errors.push(`registry has ${registry.malformed.length} malformed row(s)`);
    if (registry.duplicateIds.length) errors.push("registry contains duplicate IDs");
    if (registry.duplicatePaths.length) errors.push("registry contains duplicate paths");
  } else if (ext === ".str") {
    if (!source.trim()) errors.push("localization source must not be empty");
    if (/\uFFFD/u.test(source)) errors.push("replacement character is not allowed");
    if (proof.encodingRoundTripRequired !== true) errors.push("localization write requires encodingRoundTripRequired=true");
  } else {
    const balanced = scanBalancedScript(source, { requireHeader: ![".nut", ".sqr"].includes(ext) });
    errors.push(...balanced.errors);
    if (ext === ".wdm") {
      const worldmap = parseWorldmapText(source);
      if (!worldmap.mapImage) errors.push("worldmap is missing [map image]");
      if (!worldmap.uiPath) errors.push("worldmap is missing [ui path]");
      if (!worldmap.hasDungeonSection || !worldmap.dungeonIds.length) errors.push("worldmap must contain at least one [dungeon] ID");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    extension: ext,
    sourceSha256: sha256(Buffer.from(source, "utf8")),
    normalizedTextSha256: sha256(normalizeText(source)),
  };
}

function expectedNewFileMode(pvfPath) {
  return HIGH_RISK_NEW_FILE_MODES[extensionOf(pvfPath)] || null;
}

function isProtectedExistingExtension(pvfPath) {
  return PROTECTED_EXISTING_FILE_EXTENSIONS.has(extensionOf(pvfPath));
}

function validateWriteProofShape(pvfPath, proof) {
  const expected = expectedNewFileMode(pvfPath);
  if (!expected) return { ok: true, expectedMode: null, errors: [] };
  const errors = [];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    return { ok: false, expectedMode: expected, errors: [`${extensionOf(pvfPath)} requires writeProof.mode=${expected}`] };
  }
  if (proof.mode !== expected) errors.push(`writeProof.mode must be ${expected}`);
  if (expected === "worldmap-lifecycle") {
    if (!proof.registry || typeof proof.registry !== "object") errors.push("worldmap proof requires registry");
    const registry = proof.registry || {};
    if (normalizePvfPath(registry.lstPath).toLowerCase() !== "worldmap/worldmap.lst") errors.push("worldmap proof registry.lstPath must be worldmap/worldmap.lst");
    if (!Number.isSafeInteger(Number(registry.id)) || Number(registry.id) < 0) errors.push("worldmap proof registry.id must be a non-negative integer");
    if (normalizePvfPath(registry.expectedPvfPath).toLowerCase() !== normalizePvfPath(pvfPath).toLowerCase()) errors.push("worldmap proof registry.expectedPvfPath must match the new .wdm path");
    if (registry.action !== "add") errors.push("new worldmap registry action must be add");
    if (!Array.isArray(proof.pairedEntries) || proof.pairedEntries.length === 0) errors.push("worldmap proof requires pairedEntries");
    const paired = Array.isArray(proof.pairedEntries) ? proof.pairedEntries : [];
    if (!paired.some((entry) => entry?.kind === "ui")) errors.push("worldmap proof requires a ui pairedEntry");
    if (!paired.some((entry) => entry?.kind === "town-gate")) errors.push("worldmap proof requires a town-gate pairedEntry");
    if (!paired.some((entry) => entry?.kind === "region-town")) errors.push("worldmap proof requires a region-town pairedEntry");
  } else if (expected === "registry-lifecycle") {
    if (!proof.registry || typeof proof.registry !== "object") errors.push("registry proof requires registry");
  } else if (expected === "script-new-file") {
    if (proof.compileRequired !== true) errors.push("script proof requires compileRequired=true");
    if (!Array.isArray(proof.referencePaths) || proof.referencePaths.length === 0) errors.push("script proof requires at least one same-extension referencePaths sample");
  } else if (expected === "localization-new-file") {
    if (!new Set(["Cn", "Tw"]).has(String(proof.pvfEncoding || ""))) errors.push("localization proof requires pvfEncoding Cn or Tw");
    if (proof.encodingRoundTripRequired !== true) errors.push("localization proof requires encodingRoundTripRequired=true");
    if (!Array.isArray(proof.referencePaths) || proof.referencePaths.length === 0) errors.push("localization proof requires at least one .str referencePaths sample");
  }
  return { ok: errors.length === 0, expectedMode: expected, errors };
}

function validateRegistryRowProof(proof, registryText, pendingPath = null) {
  const errors = [];
  const registry = parsedRegistryRows(registryText);
  const preExistingDuplicateSummary = duplicateRegistrySummary(registry);
  if (!registry.headerPresent) errors.push("target registry is missing #PVF_File");
  if (registry.malformed.length) errors.push("target registry contains malformed rows");
  const row = proof?.registry || {};
  const id = Number(row.id);
  const registryPath = normalizePvfPath(row.lstPath || proof?.registry?.lstPath || "");
  const expectedPath = normalizePvfPath(row.expectedPvfPath || row.pvfPath);
  if (!Number.isSafeInteger(id) || id < 0) errors.push("registry.id must be a non-negative integer");
  if (!expectedPath) errors.push("registry.expectedPvfPath is required");
  const existingById = registry.byId.get(id);
  const existingByPath = registry.rows.find((candidate) =>
    resolveRegistryEntryPath(registryPath, candidate.pvfPath).toLowerCase() === expectedPath.toLowerCase()) || null;
  const existingByIdResolvedPath = existingById
    ? resolveRegistryEntryPath(registryPath, existingById.pvfPath)
    : null;
  const existingByPathResolvedPath = existingByPath
    ? resolveRegistryEntryPath(registryPath, existingByPath.pvfPath)
    : null;
  if (existingById && existingByIdResolvedPath.toLowerCase() !== expectedPath.toLowerCase()) {
    errors.push(`registry ID ${id} is already registered at line ${existingById.line}: ${existingByIdResolvedPath}`);
  }
  if (existingByPath && existingByPath.id !== id) {
    errors.push(
      `registry path is already registered as ID ${existingByPath.id} at line ${existingByPath.line}: ${existingByPathResolvedPath}; reuse the existing ID instead of adding a duplicate row`,
    );
  }
  if (pendingPath && expectedPath.toLowerCase() !== normalizePvfPath(pendingPath).toLowerCase()) errors.push("registry row does not point at the new file");
  return {
    ok: errors.length === 0,
    errors,
    id,
    expectedPvfPath: expectedPath,
    existingById,
    existingByIdResolvedPath,
    existingByPath,
    existingByPathResolvedPath,
    conflicts: {
      id: Boolean(existingById && existingByIdResolvedPath.toLowerCase() !== expectedPath.toLowerCase()),
      path: Boolean(existingByPath && existingByPath.id !== id),
      exactExisting: Boolean(existingByPath && existingByPath.id === id),
    },
    preExistingDuplicateSummary,
    preExistingDuplicatesPresent:
      preExistingDuplicateSummary.duplicateIdGroupCount > 0 ||
      preExistingDuplicateSummary.duplicatePathGroupCount > 0,
    preExistingDuplicatesIgnoredForAddOnly:
      preExistingDuplicateSummary.duplicateIdGroupCount > 0 ||
      preExistingDuplicateSummary.duplicatePathGroupCount > 0,
    registry,
    registryPath,
  };
}

/**
 * Prove that an existing registry changed only by adding the rows named in
 * the lifecycle proofs. Presence-only checks are insufficient: without this
 * transition audit a replacement could silently rewrite an old ID/path while
 * also adding one otherwise valid row.
 */
function validateRegistryLifecycleTransition(beforeText, afterText, proofs, pvfPath) {
  const errors = [];
  const registryPath = normalizePvfPath(pvfPath);
  const before = parseRegistryRows(beforeText);
  const after = parseRegistryRows(afterText);
  const proofList = Array.isArray(proofs) ? proofs : [];

  if (!before.headerPresent || !after.headerPresent) errors.push("registry header must remain #PVF_File");
  if (before.malformed.length || after.malformed.length) errors.push("registry lifecycle cannot contain malformed rows");
  if (!proofList.length) errors.push("registry lifecycle requires at least one explicit row-add proof");
  const preExistingDuplicateSummary = duplicateRegistrySummary(before);
  const finalDuplicateSummary = duplicateRegistrySummary(after);
  const duplicateExpansions = duplicateRegistryExpansions(before, after);
  for (const expansion of duplicateExpansions) {
    errors.push(
      `registry lifecycle introduced or expanded duplicate ${expansion.kind} ${expansion.value}: ${expansion.beforeCount} -> ${expansion.afterCount}`,
    );
  }

  const additions = [];
  const proofIds = new Set();
  const proofPaths = new Set();
  for (const proof of proofList) {
    const row = proof?.registry || {};
    const id = Number(row.id);
    const expectedPvfPath = normalizePvfPath(row.expectedPvfPath || row.pvfPath);
    const declaredRegistry = normalizePvfPath(row.lstPath || "");
    if (proof?.mode !== "registry-lifecycle" || proof?.allowExistingRegistryEdit !== true) {
      errors.push("existing registry changes require registry-lifecycle with allowExistingRegistryEdit=true");
    }
    if (row.action !== "add") errors.push("existing registry lifecycle supports action=add only");
    if (!declaredRegistry || declaredRegistry.toLowerCase() !== registryPath.toLowerCase()) {
      errors.push("registry proof lstPath must match the edited .lst path");
    }
    if (!Number.isSafeInteger(id) || id < 0 || !expectedPvfPath) {
      errors.push("registry row proof requires a non-negative id and expectedPvfPath");
      continue;
    }
    const pathKey = expectedPvfPath.toLowerCase();
    if (proofIds.has(id)) errors.push(`duplicate row-add proof id: ${id}`);
    if (proofPaths.has(pathKey)) errors.push(`duplicate row-add proof path: ${expectedPvfPath}`);
    proofIds.add(id);
    proofPaths.add(pathKey);
    additions.push({ id, expectedPvfPath });
    if (before.byId.has(id)) errors.push(`row-add proof id already exists: ${id}`);
    if (before.rows.some((candidate) =>
      resolveRegistryEntryPath(registryPath, candidate.pvfPath).toLowerCase() === pathKey)) {
      errors.push(`row-add proof path already exists: ${expectedPvfPath}`);
    }
  }

  const additionKeys = new Set(additions.map((addition) => `${addition.id}\u0000${addition.expectedPvfPath.toLowerCase()}`));
  const addedKeyCounts = new Map();
  for (const row of after.rows) {
    const key = `${row.id}\u0000${resolveRegistryEntryPath(registryPath, row.pvfPath).toLowerCase()}`;
    if (additionKeys.has(key)) addedKeyCounts.set(key, (addedKeyCounts.get(key) || 0) + 1);
  }
  for (const addition of additions) {
    const row = after.byId.get(addition.id);
    if (!row || resolveRegistryEntryPath(registryPath, row.pvfPath).toLowerCase() !== addition.expectedPvfPath.toLowerCase()) {
      errors.push(`proved registry row missing from final text: ${addition.id} -> ${addition.expectedPvfPath}`);
    }
    const key = `${addition.id}\u0000${addition.expectedPvfPath.toLowerCase()}`;
    const addedCount = addedKeyCounts.get(key) || 0;
    if (addedCount !== 1) {
      errors.push(`proved registry row must appear exactly once in final text: ${addition.id} -> ${addition.expectedPvfPath}; found ${addedCount}`);
    }
  }

  const strippedAfter = normalizeText(afterText).split("\n").filter((line) => {
    const match = /^\s*(-?\d+)[\t ]+`([^`]+)`[\t ]*$/u.exec(line);
    if (!match) return true;
    const key = `${Number(match[1])}\u0000${resolveRegistryEntryPath(registryPath, match[2]).toLowerCase()}`;
    return !additionKeys.has(key);
  }).join("\n");
  if (strippedAfter !== normalizeText(beforeText)) {
    errors.push("registry lifecycle changed content other than the proved new row(s)");
  }

  return {
    ok: errors.length === 0,
    errors,
    registryPath,
    originalRowCount: before.rows.length,
    finalRowCount: after.rows.length,
    addedRows: additions,
    preExistingDuplicateSummary,
    finalDuplicateSummary,
    duplicateExpansions,
    preExistingDuplicatesIgnoredForAddOnly:
      preExistingDuplicateSummary.duplicateIdGroupCount > 0 ||
      preExistingDuplicateSummary.duplicatePathGroupCount > 0,
    originalTextSha256: sha256(normalizeText(beforeText)),
    finalTextSha256: sha256(normalizeText(afterText)),
  };
}

module.exports = {
  EXISTING_NUT_CONTROLLED_MODE,
  HIGH_RISK_NEW_FILE_MODES,
  PROTECTED_EXISTING_FILE_EXTENSIONS,
  extensionOf,
  expectedNewFileMode,
  isProtectedExistingExtension,
  normalizePvfPath,
  resolveRegistryEntryPath,
  normalizeText,
  parseRegistryRows,
  parseRegionTownIds,
  parseTownWorldmapGates,
  parseWorldmapUiButtons,
  parseWorldmapText,
  scanBalancedScript,
  scanSquirrelStructure,
  safeAsciiScriptText,
  sha256,
  containsExactIdentifier,
  containsExactFunctionCall,
  containsExactInteger,
  containsExactIntegerInFunctionCall,
  containsExecutableFragment,
  directStateRegistration,
  directStateReferencePresent,
  directSkillUseRegistration,
  directSkillUseReferencePresent,
  directSkillProcRegistration,
  directSkillProcEvidence,
  validateExistingNutTextTransition,
  validateExistingNutWriteProofShape,
  validateNewFileText,
  validateRegistryLifecycleTransition,
  validateRegistryRowProof,
  validateWriteProofShape,
};
