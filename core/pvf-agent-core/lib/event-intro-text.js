"use strict";

// Only the paired plain-text description in the existing event-list popup
// format is eligible. Tokenize before inspecting structure: brackets inside
// strings or comments must never become container boundaries.
function inspectEventIntroText(sourceText, tokenOffset, tokenLength, pvfPath) {
  if (pvfPath !== "event/eventlistwindow.evt") return null;
  const text = String(sourceText);
  const lexer = /\s+|\/\/[^\r\n]*|#PVF_File\b|<\d+::[^>`]*`[^`]*`>|`[^`]*`|\[[^\]\r\n]+\]|-?\d+/gy;
  const tokens = [];
  let cursor = 0;
  while (cursor < text.length) {
    lexer.lastIndex = cursor;
    const match = lexer.exec(text);
    if (!match) return null;
    cursor = lexer.lastIndex;
    if (/^\s|^\/\//u.test(match[0])) continue;
    if (match[0] === "#PVF_File") {
      if (tokens.length) return null;
      continue;
    }
    tokens.push({ value: match[0], offset: match.index });
  }
  const selected = tokens.findIndex(t => t.offset === tokenOffset && t.value.length === tokenLength);
  if (selected < 0) return null;
  let start = -1;
  let end = -1;
  let open = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === "[entry]") {
      if (open !== -1) return null;
      open = i;
    } else if (tokens[i].value === "[/entry]") {
      if (open === -1) return null;
      if (selected > open && selected < i) { start = open; end = i; }
      open = -1;
    } else if (open === -1) return null;
  }
  if (open !== -1 || start < 0) return null;
  const entry = tokens.slice(start, end + 1);
  let i = 0;
  const literal = value => entry[i++]?.value === value;
  const take = pattern => {
    const token = entry[i++];
    return token && pattern.test(token.value) ? token : null;
  };
  if (!literal("[entry]") || !literal("[event info]")) return null;
  const id = take(/^-?\d+$/u), group = take(/^\d+$/u), type = take(/^\d+$/u);
  const code = take(/^`[A-Za-z0-9_ -]+(?:[\r\n\t]+[A-Za-z0-9_ -]+)*`$/u);
  const name = take(/^`[^`\r\n]+`$/u);
  const from = take(/^`\d{8}`$/u), to = take(/^`\d{8}`$/u);
  const summary = take(/^`[^`]+`$/u);
  if (!id || !group || !type || !code || !name || !from || !to || !summary) return null;
  if (!literal("[/event info]") || !literal("[popupwindow design]") || !literal("[title]")) return null;
  const title = take(/^`[^`\r\n]+`$/u);
  if (!title || title.value !== name.value || !literal("[explain]")) return null;
  const body = take(/^`[^`]+`$/u), width = take(/^\d+$/u);
  if (!body || !width || Number(width.value) < 1 || Number(width.value) > 4096 || body.value !== summary.value) return null;
  if (entry[i]?.value === "[url hyperlink]") {
    i++;
    if (!take(/^`[^`\r\n]*`$/u) || !take(/^`[^`\r\n]*`$/u)) return null;
  }
  if (!literal("[using ok button]") || !take(/^[01]$/u) ||
      !literal("[/popupwindow design]") || !literal("[/entry]") || i !== entry.length) return null;
  const isTitle = tokenOffset === name.offset || tokenOffset === title.offset;
  if (!isTitle && tokenOffset !== summary.offset && tokenOffset !== body.offset) return null;
  // A URL is an action destination, not a plain description.
  if (/https?:\/\/|[<>]/iu.test(body.value)) return null;
  return {
    role: isTitle ? (tokenOffset === name.offset ? "event-title" : "popup-title") : (tokenOffset === summary.offset ? "event-summary" : "popup-explain"),
    eventId: id.value, eventGroup: group.value, eventType: type.value,
    eventCode: code.value, eventTitle: title.value,
    startDate: from.value, endDate: to.value, width: Number(width.value),
    pairedDescription: true,
    entryEndOffset: tokens[end].offset + tokens[end].value.length,
    pairedTokenOffset: isTitle ? (tokenOffset === name.offset ? title.offset : name.offset) : (tokenOffset === summary.offset ? body.offset : summary.offset),
  };
}

function eventIntroTextSelfTest(classify) {
  const fixture = "#PVF_File\r\n[entry]\r\n[event info]\r\n-1 2 4\r\n`fixture event`\r\n`介紹`\r\n`20260101`\r\n`20261231`\r\n`舊說明\r\n第二行`\r\n[/event info]\r\n[popupwindow design]\r\n[title]\r\n`介紹`\r\n[explain]\r\n`舊說明\r\n第二行`\t230\r\n[using ok button]\r\n1\r\n[/popupwindow design]\r\n[/entry]\r\n";
  const target = "`舊說明\r\n第二行`";
  const check = (source, token = target, pvfPath = "event/eventlistwindow.evt", last = false) => classify({
    pvfPath, sourceText: source, tokenOffset: last ? source.lastIndexOf(token) : source.indexOf(token), tokenLength: token.length,
  });
  const cases = [
    ["summary", check(fixture).allowed === true],
    ["popup", check(fixture, target, undefined, true).proof?.role === "popup-explain"],
    ["other-path", check(fixture, target, "event/other.evt").allowed === false],
    ["generic-tag", check("[explain]\n" + target).allowed === false],
    ["title", check(fixture, "`介紹`").proof?.role === "event-title"],
    ["date", check(fixture, "`20260101`").allowed === false],
    ["code", check(fixture, "`fixture event`").allowed === false],
    ["multiline-code", check(fixture.replace("`fixture event`", "`fixture\r\nevent`")).allowed === true],
    ["code-tag-injection", check(fixture.replace("`fixture event`", "`fixture\r\n[entry]`")).allowed === false],
    ["missing-close", check(fixture.replace("[/popupwindow design]", "")).allowed === false],
    ["wrong-width", check(fixture.replace("\t230", "\t-1")).allowed === false],
    ["mismatched-pair", check(fixture.replace(target, "`其他`"), target).allowed === false],
    ["extra-field", check(fixture.replace("[using ok button]", "[unknown]\n1\n[using ok button]")).allowed === false],
    ["nested-entry", check(fixture.replace("[explain]", "[entry]\n[explain]")).allowed === false],
    ["comment-spoof", check("// " + target + "\n" + fixture).allowed === false],
    ["stringlink", check(fixture.replaceAll(target, "<20::key" + target + ">"), target).allowed === false],
    ["partial", check(fixture, "舊說明").allowed === false],
  ];
  const suffix = "[/entry]\r\n";
  const added = fixture.slice(fixture.indexOf("[entry]")).replaceAll("`介紹`", "`New title`").replaceAll(target, "`New body`");
  const append = source => inspectStaticEventAppend({ pvfPath: "event/eventlistwindow.evt",
    sourceText: source, previousText: suffix, newText: suffix + added }, [source.lastIndexOf(suffix)]);
  cases.push(["append-final-entry-must-be-eligible", append(fixture + "[entry]\r\n[unknown]\r\n1\r\n[/entry]\r\n") === null]);
  return cases.map(([id, ok]) => ({ id: "event-intro-" + id, ok }));
}

// Append exactly one static information popup after the final entry. The
// target's final static popup supplies all non-visible metadata; nothing in
// the original text may change. ASCII placeholders are localized separately.
function inspectStaticEventAppend(input, occurrenceOffsets) {
  const source = String(input.sourceText || "");
  const previous = String(input.previousText || "");
  const replacement = String(input.newText || "");
  if (input.pvfPath !== "event/eventlistwindow.evt" || occurrenceOffsets.length !== 1 ||
      !previous || !replacement.startsWith(previous) || /[^\x00-\x7f]/u.test(previous + replacement) ||
      occurrenceOffsets[0] + previous.length < source.trimEnd().length ||
      occurrenceOffsets[0] + previous.length > source.length) return null;
  const added = replacement.slice(previous.length);
  // This grammar deliberately excludes links, comments, extra entries and
  // activation fields. Every literal is a complete standalone token.
  const pattern = /^\s*\[entry\]\s*\[event info\]\s*(-1)\s+(2)\s+(4)\s*(`[^`]+`)\s*(`[^`\r\n]+`)\s*(`\d{8}`)\s*(`\d{8}`)\s*(`[^`]+`)\s*\[\/event info\]\s*\[popupwindow design\]\s*\[title\]\s*\5\s*\[explain\]\s*\8\s+(\d+)\s*\[using ok button\]\s*1\s*\[\/popupwindow design\]\s*\[\/entry\]\s*$/u;
  const match = pattern.exec(added);
  if (!match || /https?:\/\/|[<>\[\]]/iu.test(match[5] + match[8]) || source.includes(match[5]) || source.includes(match[8])) return null;
  const newProof = inspectEventIntroText(added, added.indexOf(match[8]), match[8].length, input.pvfPath);
  // Locate the final title through lexed whole-file inspection, not a tag
  // substring inside a comment or string.
  const proofs = [...source.matchAll(/`[^`]*`/gu)].map(m => inspectEventIntroText(source, m.index, m[0].length, input.pvfPath)).filter(Boolean);
  const oldProof = proofs.at(-1);
  if (!oldProof || !newProof || oldProof.entryEndOffset !== source.trimEnd().length || oldProof.eventId !== "-1" || oldProof.eventGroup !== "2" || oldProof.eventType !== "4" ||
      !["eventId", "eventGroup", "eventType", "eventCode", "startDate", "endDate", "width"].every(k => oldProof[k] === newProof[k])) return null;
  return { route: "static-event-popup-append", appendedEntries: 1, originalTextPreserved: true, metadataMirrorsFinalEntry: true, eventCode: newProof.eventCode, width: newProof.width, runtimeVisibilityUnverified: true };
}

module.exports = { inspectEventIntroText, eventIntroTextSelfTest, inspectStaticEventAppend };
