"use strict";

const crypto = require("crypto");

const UPGRADE_TABLE_LEVEL_EDIT_TYPE = "upgrade-table-level-edit";
const UPGRADE_TABLE_WIDTH = 17;
const AMPLIFICATION_CONST_GROUP_WIDTH = 4;
const UPGRADE_TABLE_COLUMNS = Object.freeze(
  Array.from({ length: UPGRADE_TABLE_WIDTH }, (_, index) => String.fromCharCode("B".charCodeAt(0) + index)),
);
const UPGRADE_RARITIES = Object.freeze(["common", "uncommon", "rare", "unique", "epic", "chronicle"]);
const SUPPORTED_PATHS = new Map([
  ["etc/upgrade.etc", { amplification: false }],
  ["etc/amplifyupgrade.etc", { amplification: true }],
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJsonSha256(value) {
  return sha256(canonicalJson(value));
}

function normalizePvfPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//u, "").toLowerCase();
}

function codedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueArray(values) {
  return Array.isArray(values) && new Set(values).size === values.length;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameIntegerSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function exactObjectKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function normalizedNumericToken(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const token = String(value);
  return numericToken(token) ? token : null;
}

function componentStateProof(proof) {
  const state = proof.beforeSha256 === proof.afterSha256 ? "no-op" : "changed";
  return {
    ...proof,
    state,
    declaredValuesVerified: true,
    writerRequired: state === "changed",
  };
}

function normalizeUpgradeTableLevelEdit(change, errors, pathPolicy) {
  const legacyTableFields = ["sourceLevel", "targetLevels", "copyColumns", "preserveColumns"];
  const legacyAmplificationFields = [
    "copyAmplificationConstFromLevel",
    "copyAmplificationConstToLevels",
    "amplificationConstGroupWidth",
    "amplificationConstHasLevelZeroGroup",
  ];
  const hasNestedTable = hasOwn(change, "tableEdit");
  const suppliedLegacyTable = legacyTableFields.filter((field) => hasOwn(change, field));
  const hasNestedAmplification = hasOwn(change, "amplificationConstEdit");
  const suppliedLegacyAmplification = legacyAmplificationFields.filter((field) => hasOwn(change, field));

  if (hasNestedTable && suppliedLegacyTable.length > 0) {
    errors.push(`tableEdit cannot be mixed with legacy table field(s): ${suppliedLegacyTable.join(", ")}.`);
  }
  if (hasNestedAmplification && suppliedLegacyAmplification.length > 0) {
    errors.push(`amplificationConstEdit cannot be mixed with legacy amplification field(s): ${suppliedLegacyAmplification.join(", ")}.`);
  }
  if (hasNestedTable && suppliedLegacyAmplification.length > 0) {
    errors.push("Nested tableEdit cannot be mixed with legacy amplification fields; use amplificationConstEdit.");
  }
  if (!hasNestedTable && hasNestedAmplification) {
    errors.push("Nested amplificationConstEdit requires nested tableEdit; old and new selector forms cannot be mixed.");
  }

  const syntax = hasNestedTable ? "nested-group-selectors" : "legacy-level-fields";
  const rawTable = hasNestedTable ? change.tableEdit : {
    sourceGroup: change.sourceLevel,
    targetGroups: change.targetLevels,
    copyColumns: change.copyColumns,
    preserveColumns: change.preserveColumns,
    setCells: [],
  };
  if (!plainObject(rawTable)) {
    errors.push("tableEdit must be an object when the nested selector form is used.");
  } else if (!exactObjectKeys(rawTable, ["sourceGroup", "targetGroups", "copyColumns", "preserveColumns", "setCells"])) {
    errors.push("tableEdit supports only sourceGroup, targetGroups, copyColumns, preserveColumns, and setCells.");
  }

  const table = plainObject(rawTable) ? rawTable : {};
  const copyFields = ["sourceGroup", "targetGroups", "copyColumns", "preserveColumns"];
  const suppliedCopyFields = copyFields.filter((field) => hasOwn(table, field));
  const hasCopyPlan = suppliedCopyFields.length > 0;
  const setCells = hasOwn(table, "setCells") ? table.setCells : [];
  if (hasCopyPlan && suppliedCopyFields.length !== copyFields.length) {
    errors.push(`tableEdit copy plan must provide all of: ${copyFields.join(", ")}.`);
  }
  if (!hasCopyPlan && (!Array.isArray(setCells) || setCells.length === 0)) {
    errors.push("tableEdit must declare a complete group-copy plan, at least one setCells entry, or both.");
  }
  if (hasCopyPlan) {
    if (!Number.isSafeInteger(table.sourceGroup) || table.sourceGroup < 0) {
      errors.push(`${syntax === "legacy-level-fields" ? "sourceLevel" : "tableEdit.sourceGroup"} must be a non-negative raw group index.`);
    }
    if (!Array.isArray(table.targetGroups) || table.targetGroups.length < 1 ||
        table.targetGroups.some((group) => !Number.isSafeInteger(group) || group < 0) ||
        !uniqueArray(table.targetGroups)) {
      errors.push(`${syntax === "legacy-level-fields" ? "targetLevels" : "tableEdit.targetGroups"} must contain unique non-negative raw group indexes.`);
    } else if (table.targetGroups.includes(table.sourceGroup)) {
      errors.push("table target groups must not contain the source group.");
    }
    for (const field of ["copyColumns", "preserveColumns"]) {
      if (!Array.isArray(table[field]) || !uniqueArray(table[field]) ||
          table[field].some((column) => !UPGRADE_TABLE_COLUMNS.includes(column))) {
        errors.push(`${hasNestedTable ? `tableEdit.${field}` : field} must contain unique column labels from B through R.`);
      }
    }
    if (Array.isArray(table.copyColumns) && table.copyColumns.length < 1) {
      errors.push(`${hasNestedTable ? "tableEdit.copyColumns" : "copyColumns"} must contain at least one declared property column.`);
    }
    if (Array.isArray(table.copyColumns) && Array.isArray(table.preserveColumns)) {
      const overlap = table.copyColumns.filter((column) => table.preserveColumns.includes(column));
      if (overlap.length > 0) errors.push(`copyColumns and preserveColumns overlap: ${overlap.join(", ")}.`);
      if (!sameStringSet([...table.copyColumns, ...table.preserveColumns], UPGRADE_TABLE_COLUMNS)) {
        errors.push("copyColumns and preserveColumns must form an exact B-R partition so no table column is implicit.");
      }
    }
  }

  if (!Array.isArray(setCells) || !uniqueArray((Array.isArray(setCells) ? setCells : []).map((cell) =>
    plainObject(cell) ? `${cell.group}:${cell.column}` : JSON.stringify(cell)))) {
    errors.push("tableEdit.setCells must contain unique cell selectors.");
  } else {
    for (const [index, cell] of setCells.entries()) {
      const label = `tableEdit.setCells[${index}]`;
      if (!exactObjectKeys(cell, ["group", "column", "expectedBefore", "newValue"])) {
        errors.push(`${label} must contain exactly group, column, expectedBefore, and newValue.`);
        continue;
      }
      if (!Number.isSafeInteger(cell.group) || cell.group < 0) errors.push(`${label}.group must be a non-negative raw group index.`);
      if (!UPGRADE_TABLE_COLUMNS.includes(cell.column)) errors.push(`${label}.column must be B through R.`);
      if (normalizedNumericToken(cell.expectedBefore) === null) errors.push(`${label}.expectedBefore must be one complete numeric token.`);
      if (normalizedNumericToken(cell.newValue) === null) errors.push(`${label}.newValue must be one complete numeric token.`);
      if (hasCopyPlan && Array.isArray(table.targetGroups) && Array.isArray(table.copyColumns) &&
          table.targetGroups.includes(cell.group) && table.copyColumns.includes(cell.column)) {
        errors.push(`${label} overlaps the declared group-copy cell; one cell cannot have two writers.`);
      }
    }
  }

  let amplification = null;
  if (pathPolicy?.amplification === true) {
    const rawAmplification = hasNestedTable ? change.amplificationConstEdit : {
      sourceGroup: change.copyAmplificationConstFromLevel,
      targetGroups: change.copyAmplificationConstToLevels,
      groupWidth: change.amplificationConstGroupWidth,
      hasLevelZeroGroup: change.amplificationConstHasLevelZeroGroup,
    };
    if (!plainObject(rawAmplification) ||
        !exactObjectKeys(rawAmplification, ["sourceGroup", "targetGroups", "groupWidth", "hasLevelZeroGroup"])) {
      errors.push("amplificationConstEdit must contain only sourceGroup, targetGroups, groupWidth, and hasLevelZeroGroup.");
    }
    const amp = plainObject(rawAmplification) ? rawAmplification : {};
    if (!Number.isSafeInteger(amp.sourceGroup) || amp.sourceGroup < 0) {
      errors.push("amplification sourceGroup must be a non-negative raw group index.");
    }
    if (!Array.isArray(amp.targetGroups) || amp.targetGroups.length < 1 || !uniqueArray(amp.targetGroups) ||
        amp.targetGroups.some((group) => !Number.isSafeInteger(group) || group < 0)) {
      errors.push("amplification targetGroups must contain unique non-negative raw group indexes.");
    } else if (amp.targetGroups.includes(amp.sourceGroup)) {
      errors.push("amplification targetGroups must not contain sourceGroup.");
    }
    if (amp.groupWidth !== AMPLIFICATION_CONST_GROUP_WIDTH) {
      errors.push(`amplification groupWidth must be ${AMPLIFICATION_CONST_GROUP_WIDTH}.`);
    }
    if (amp.hasLevelZeroGroup !== true) {
      errors.push("amplification hasLevelZeroGroup must be true so raw group indexes bind directly to four-value groups.");
    }
    if (!hasNestedTable && hasCopyPlan && (
      amp.sourceGroup !== table.sourceGroup ||
      !Array.isArray(amp.targetGroups) || !sameIntegerSet(amp.targetGroups, table.targetGroups || [])
    )) {
      errors.push("Legacy amplification selectors must still exactly match sourceLevel/targetLevels; use nested selectors for independent raw groups.");
    }
    amplification = {
      sourceGroup: amp.sourceGroup,
      targetGroups: Array.isArray(amp.targetGroups) ? [...amp.targetGroups] : [],
      groupWidth: amp.groupWidth,
      hasLevelZeroGroup: amp.hasLevelZeroGroup,
    };
  } else if (pathPolicy?.amplification === false) {
    const supplied = [...suppliedLegacyAmplification, ...(hasNestedAmplification ? ["amplificationConstEdit"] : [])];
    if (supplied.length > 0) errors.push(`amplification-only field(s) are not allowed for upgrade.etc: ${supplied.join(", ")}.`);
  }

  return {
    syntax,
    tableEdit: {
      sourceGroup: hasCopyPlan ? table.sourceGroup : null,
      targetGroups: hasCopyPlan && Array.isArray(table.targetGroups) ? [...table.targetGroups] : [],
      copyColumns: hasCopyPlan && Array.isArray(table.copyColumns) ? [...table.copyColumns] : [],
      preserveColumns: hasCopyPlan && Array.isArray(table.preserveColumns) ? [...table.preserveColumns] : [],
      setCells: Array.isArray(setCells) ? setCells.map((cell) => plainObject(cell) ? ({
        group: cell.group,
        column: cell.column,
        expectedBefore: normalizedNumericToken(cell.expectedBefore),
        newValue: normalizedNumericToken(cell.newValue),
      }) : ({ group: null, column: null, expectedBefore: null, newValue: null })) : [],
    },
    amplificationConstEdit: amplification,
  };
}

function validateUpgradeTableLevelEditShape(change = {}) {
  const errors = [];
  const normalizedPath = normalizePvfPath(change.pvfPath);
  const pathPolicy = SUPPORTED_PATHS.get(normalizedPath);
  if (change.type !== UPGRADE_TABLE_LEVEL_EDIT_TYPE) {
    errors.push(`type must be ${UPGRADE_TABLE_LEVEL_EDIT_TYPE}.`);
  }
  if (!pathPolicy) {
    errors.push("pvfPath must be exactly etc/upgrade.etc or etc/amplifyupgrade.etc; etc/upgrade_separate.etc is forging and remains excluded.");
  }
  const normalized = normalizeUpgradeTableLevelEdit(change, errors, pathPolicy);
  if (change.maxLevelByRarity === undefined && normalized.syntax === "nested-group-selectors") {
    // A table-only edit preserves the target's actual rarity section, including
    // official files with fewer than six rows. Never synthesize missing rows.
  } else if (!plainObject(change.maxLevelByRarity)) {
    errors.push("maxLevelByRarity must explicitly list all six supported rarities.");
  } else {
    const keys = Object.keys(change.maxLevelByRarity);
    if (!sameStringSet(keys, UPGRADE_RARITIES)) {
      errors.push(`maxLevelByRarity keys must be exactly: ${UPGRADE_RARITIES.join(", ")}.`);
    }
    for (const rarity of keys) {
      const value = change.maxLevelByRarity[rarity];
      if (!Number.isSafeInteger(value) || value < 0) {
        errors.push(`maxLevelByRarity.${rarity} must be a non-negative integer.`);
      }
    }
  }
  if (change.pvfEncoding !== undefined && !new Set(["Cn", "Tw"]).has(change.pvfEncoding)) {
    errors.push("pvfEncoding must be Cn or Tw when present.");
  }
  return { ok: errors.length === 0, errors, normalizedPath, pathPolicy: pathPolicy || null, normalized };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function findSection(sourceText, tag) {
  const source = String(sourceText || "");
  const escaped = escapeRegExp(tag);
  const openPattern = new RegExp(`^\\[${escaped}\\]\\r?\\n`, "gmu");
  const opens = [...source.matchAll(openPattern)];
  if (opens.length !== 1) {
    throw codedError("UPGRADE_SECTION_COUNT_MISMATCH", `[${tag}] must occur exactly once.`, { tag, count: opens.length });
  }
  const open = opens[0];
  const start = open.index;
  const contentStart = start + open[0].length;
  const closePattern = new RegExp(`^\\[/${escaped}\\](?=\\r?$|\\r?\\n)`, "gmu");
  closePattern.lastIndex = contentStart;
  const closes = [];
  let match;
  while ((match = closePattern.exec(source)) !== null) {
    if (match.index >= contentStart) closes.push(match);
  }
  if (closes.length !== 1) {
    throw codedError("UPGRADE_SECTION_COUNT_MISMATCH", `[/${tag}] must occur exactly once.`, { tag, count: closes.length });
  }
  const close = closes[0];
  if (close.index <= contentStart) throw codedError("UPGRADE_SECTION_ORDER_INVALID", `[${tag}] is empty or closes before its content.`);
  const end = close.index + close[0].length;
  return {
    tag,
    start,
    end,
    contentStart,
    contentEnd: close.index,
    fullText: source.slice(start, end),
    content: source.slice(contentStart, close.index),
  };
}

function tokenizeSection(section) {
  const tokens = [];
  const pattern = /`[^`]*`|[^\s]+/gu;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(section.content)) !== null) {
    if (/\S/u.test(section.content.slice(cursor, match.index))) {
      throw codedError("UPGRADE_SECTION_TOKENIZATION_FAILED", `[${section.tag}] contains an unparsed non-whitespace fragment.`);
    }
    tokens.push({
      text: match[0],
      start: section.contentStart + match.index,
      end: section.contentStart + match.index + match[0].length,
      localStart: match.index,
      localEnd: match.index + match[0].length,
    });
    cursor = match.index + match[0].length;
  }
  if (/\S/u.test(section.content.slice(cursor))) {
    throw codedError("UPGRADE_SECTION_TOKENIZATION_FAILED", `[${section.tag}] contains trailing unparsed content.`);
  }
  return tokens;
}

function numericToken(text) {
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(String(text));
}

function replaceSectionTokens(section, tokens, replacements) {
  let output = section.fullText;
  const localSectionOffset = section.contentStart - section.start;
  const ordered = [...replacements.entries()].sort((left, right) => right[0] - left[0]);
  for (const [tokenIndex, replacement] of ordered) {
    const token = tokens[tokenIndex];
    if (!token) throw codedError("UPGRADE_TOKEN_INDEX_INVALID", `Token index ${tokenIndex} does not exist in [${section.tag}].`);
    const start = localSectionOffset + token.localStart;
    const end = localSectionOffset + token.localEnd;
    output = `${output.slice(0, start)}${replacement}${output.slice(end)}`;
  }
  return output;
}

function replaceExactOnce(sourceText, previousText, newText, label) {
  const first = sourceText.indexOf(previousText);
  const second = first < 0 ? -1 : sourceText.indexOf(previousText, first + previousText.length);
  if (first < 0 || second >= 0) {
    throw codedError("UPGRADE_GENERATED_SELECTOR_MISMATCH", `${label} generated selector must occur exactly once.`, {
      label,
      occurrenceCount: first < 0 ? 0 : 2,
    });
  }
  return `${sourceText.slice(0, first)}${newText}${sourceText.slice(first + previousText.length)}`;
}

function tablePlan(sourceText, change, tableEdit) {
  const section = findSection(sourceText, "table");
  const tokens = tokenizeSection(section);
  if (tokens.length === 0 || tokens.length % UPGRADE_TABLE_WIDTH !== 0) {
    throw codedError("UPGRADE_TABLE_WIDTH_MISMATCH", `[table] token count must be divisible by ${UPGRADE_TABLE_WIDTH}.`, {
      tokenCount: tokens.length,
      width: UPGRADE_TABLE_WIDTH,
    });
  }
  const nonNumeric = tokens.find((token) => !numericToken(token.text));
  if (nonNumeric) {
    throw codedError("UPGRADE_TABLE_NON_NUMERIC_TOKEN", "[table] must contain only numeric tokens for this structured route.", {
      token: nonNumeric.text,
    });
  }
  const levelCount = tokens.length / UPGRADE_TABLE_WIDTH;
  const requestedGroups = [
    ...(tableEdit.sourceGroup === null ? [] : [tableEdit.sourceGroup]),
    ...tableEdit.targetGroups,
    ...tableEdit.setCells.map((cell) => cell.group),
  ];
  const missingGroup = requestedGroups.find((group) => group >= levelCount);
  if (missingGroup !== undefined) {
    throw codedError("UPGRADE_TABLE_GROUP_MISSING", `Raw group ${missingGroup} does not exist in [table].`, {
      component: "table", state: "blocked", groupCount: levelCount,
    });
  }
  for (const [rarity, level] of Object.entries(change.maxLevelByRarity || {})) {
    if (level >= levelCount) {
      throw codedError("UPGRADE_MAX_LEVEL_OUT_OF_TABLE", `maxLevelByRarity.${rarity}=${level} exceeds [table] group range.`, { levelCount });
    }
  }
  const copyIndexes = tableEdit.copyColumns.map((column) => UPGRADE_TABLE_COLUMNS.indexOf(column));
  const preserveIndexes = tableEdit.preserveColumns.map((column) => UPGRADE_TABLE_COLUMNS.indexOf(column));
  const replacements = new Map();
  const cellDiffs = [];
  const preservedCells = [];
  for (const targetGroup of tableEdit.targetGroups) {
    for (const columnIndex of copyIndexes) {
      const sourceToken = tokens[tableEdit.sourceGroup * UPGRADE_TABLE_WIDTH + columnIndex];
      const targetTokenIndex = targetGroup * UPGRADE_TABLE_WIDTH + columnIndex;
      const targetToken = tokens[targetTokenIndex];
      replacements.set(targetTokenIndex, sourceToken.text);
      cellDiffs.push({
        mode: "copy-column",
        group: targetGroup,
        column: UPGRADE_TABLE_COLUMNS[columnIndex],
        sourceGroup: tableEdit.sourceGroup,
        before: targetToken.text,
        after: sourceToken.text,
        changed: targetToken.text !== sourceToken.text,
      });
    }
    for (const columnIndex of preserveIndexes) {
      const targetToken = tokens[targetGroup * UPGRADE_TABLE_WIDTH + columnIndex];
      preservedCells.push({ group: targetGroup, column: UPGRADE_TABLE_COLUMNS[columnIndex], value: targetToken.text });
    }
  }
  for (const cell of tableEdit.setCells) {
    const columnIndex = UPGRADE_TABLE_COLUMNS.indexOf(cell.column);
    const tokenIndex = cell.group * UPGRADE_TABLE_WIDTH + columnIndex;
    const targetToken = tokens[tokenIndex];
    if (targetToken.text !== cell.expectedBefore && targetToken.text !== cell.newValue) {
      throw codedError(
        "UPGRADE_TABLE_SET_CELL_EXPECTED_MISMATCH",
        `setCells expected old value ${cell.expectedBefore} or stable new value ${cell.newValue} at raw group ${cell.group}, column ${cell.column}, but found ${targetToken.text}.`,
        {
          component: "table", state: "blocked", group: cell.group, column: cell.column,
          expectedBefore: cell.expectedBefore, actualBefore: targetToken.text,
        },
      );
    }
    replacements.set(tokenIndex, cell.newValue);
    cellDiffs.push({
      mode: "set-cell",
      group: cell.group,
      column: cell.column,
      expectedBefore: cell.expectedBefore,
      alreadyDesired: targetToken.text === cell.newValue,
      before: targetToken.text,
      after: cell.newValue,
      changed: targetToken.text !== cell.newValue,
    });
  }
  const newFullText = replaceSectionTokens(section, tokens, replacements);
  const declaredTokenIndexes = [...replacements.keys()].sort((a, b) => a - b);
  const actualChangedTokenIndexes = declaredTokenIndexes.filter((index) => tokens[index].text !== replacements.get(index));
  return {
    section,
    tokens,
    newFullText,
    proof: componentStateProof({
      width: UPGRADE_TABLE_WIDTH,
      groupCount: levelCount,
      levelCount,
      levelIndexMode: "zero-based-group-index",
      selectorMeaning: "raw-group-index-not-gameplay-display-level",
      firstColumnIsLevelNumber: false,
      columns: UPGRADE_TABLE_COLUMNS,
      sourceGroup: tableEdit.sourceGroup,
      targetGroups: [...tableEdit.targetGroups],
      copyColumns: [...tableEdit.copyColumns],
      preserveColumns: [...tableEdit.preserveColumns],
      setCells: tableEdit.setCells.map((cell) => ({ ...cell })),
      declaredTokenIndexes,
      actualChangedTokenIndexes,
      nonTargetTokensPreserved: true,
      cellDiffs,
      preservedCells,
      beforeSha256: sha256(section.fullText),
      afterSha256: sha256(newFullText),
    }),
  };
}

function maxLevelPlan(sourceText, change) {
  const section = findSection(sourceText, "max upgrade level by rarity");
  if (change.maxLevelByRarity === undefined) {
    return {
      section,
      newFullText: section.fullText,
      proof: componentStateProof({
        mode: "preserve-existing-section",
        raritiesExplicit: false,
        nonTargetTokensPreserved: true,
        beforeSha256: sha256(section.fullText),
        afterSha256: sha256(section.fullText),
      }),
    };
  }
  const tokens = tokenizeSection(section);
  if (tokens.length !== UPGRADE_RARITIES.length * 2) {
    throw codedError("UPGRADE_RARITY_TABLE_SHAPE_MISMATCH", "[max upgrade level by rarity] must contain exactly six rarity/value pairs.", {
      tokenCount: tokens.length,
    });
  }
  const replacements = new Map();
  const diffs = [];
  const seen = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const rarityMatch = /^`([^`]*)`$/u.exec(tokens[index].text);
    const rarity = rarityMatch?.[1] || null;
    if (!rarity || !UPGRADE_RARITIES.includes(rarity) || seen.includes(rarity)) {
      throw codedError("UPGRADE_RARITY_TABLE_SHAPE_MISMATCH", "[max upgrade level by rarity] contains an unknown or duplicate rarity.", {
        token: tokens[index].text,
      });
    }
    if (!/^\d+$/u.test(tokens[index + 1].text)) {
      throw codedError("UPGRADE_RARITY_LEVEL_INVALID", `Rarity ${rarity} has a non-integer max level.`);
    }
    seen.push(rarity);
    const after = String(change.maxLevelByRarity[rarity]);
    replacements.set(index + 1, after);
    diffs.push({ rarity, before: tokens[index + 1].text, after, changed: tokens[index + 1].text !== after });
  }
  if (!sameStringSet(seen, UPGRADE_RARITIES)) {
    throw codedError("UPGRADE_RARITY_TABLE_SHAPE_MISMATCH", "[max upgrade level by rarity] rarity set is incomplete.");
  }
  const newFullText = replaceSectionTokens(section, tokens, replacements);
  return {
    section,
    newFullText,
    proof: componentStateProof({
      raritiesExplicit: true,
      rarities: seen,
      diffs,
      nonTargetTokensPreserved: true,
      beforeSha256: sha256(section.fullText),
      afterSha256: sha256(newFullText),
    }),
  };
}

function validMaxLevelProof(proof, request) {
  if (request?.maxLevelByRarity === undefined && plainObject(request?.tableEdit)) {
    return proof?.mode === "preserve-existing-section" && proof.raritiesExplicit === false &&
      proof.state === "no-op" && proof.writerRequired === false &&
      proof.declaredValuesVerified === true && proof.nonTargetTokensPreserved === true &&
      /^[a-f0-9]{64}$/u.test(String(proof.beforeSha256 || "")) && proof.beforeSha256 === proof.afterSha256;
  }
  return proof?.raritiesExplicit === true && Array.isArray(proof.rarities) &&
    sameStringSet(proof.rarities, UPGRADE_RARITIES) && proof.nonTargetTokensPreserved === true;
}

function amplificationConstPlan(sourceText, amplificationEdit) {
  const section = findSection(sourceText, "amplification const");
  const tokens = tokenizeSection(section);
  if (tokens.length === 0 || tokens.length % AMPLIFICATION_CONST_GROUP_WIDTH !== 0) {
    throw codedError("AMPLIFICATION_CONST_WIDTH_MISMATCH", `[amplification const] token count must be divisible by ${AMPLIFICATION_CONST_GROUP_WIDTH}.`, {
      tokenCount: tokens.length,
    });
  }
  const nonNumeric = tokens.find((token) => !numericToken(token.text));
  if (nonNumeric) {
    throw codedError("AMPLIFICATION_CONST_NON_NUMERIC_TOKEN", "[amplification const] must contain only numeric tokens for this structured route.");
  }
  const groupCount = tokens.length / AMPLIFICATION_CONST_GROUP_WIDTH;
  const requestedGroups = [amplificationEdit.sourceGroup, ...amplificationEdit.targetGroups];
  const missingGroup = requestedGroups.find((group) => group >= groupCount);
  if (missingGroup !== undefined) {
    throw codedError("AMPLIFICATION_CONST_GROUP_MISSING", `Raw group ${missingGroup} does not exist in [amplification const].`, {
      component: "amplification-const", state: "blocked", groupCount,
    });
  }
  const replacements = new Map();
  const groupDiffs = [];
  const sourceStart = amplificationEdit.sourceGroup * AMPLIFICATION_CONST_GROUP_WIDTH;
  const sourceValues = tokens.slice(sourceStart, sourceStart + AMPLIFICATION_CONST_GROUP_WIDTH).map((token) => token.text);
  for (const targetGroup of amplificationEdit.targetGroups) {
    const targetStart = targetGroup * AMPLIFICATION_CONST_GROUP_WIDTH;
    const before = tokens.slice(targetStart, targetStart + AMPLIFICATION_CONST_GROUP_WIDTH).map((token) => token.text);
    sourceValues.forEach((value, index) => replacements.set(targetStart + index, value));
    groupDiffs.push({
      group: targetGroup,
      sourceGroup: amplificationEdit.sourceGroup,
      before,
      after: [...sourceValues],
      changed: before.some((value, index) => value !== sourceValues[index]),
    });
  }
  const newFullText = replaceSectionTokens(section, tokens, replacements);
  return {
    section,
    newFullText,
    proof: componentStateProof({
      width: AMPLIFICATION_CONST_GROUP_WIDTH,
      groupCount,
      hasLevelZeroGroup: true,
      levelIndexMode: "zero-based-group-index",
      selectorMeaning: "raw-group-index-not-gameplay-display-level",
      valueOrderSemanticsConfirmed: false,
      sourceGroup: amplificationEdit.sourceGroup,
      targetGroups: [...amplificationEdit.targetGroups],
      sourceValues,
      groupDiffs,
      nonTargetTokensPreserved: true,
      beforeSha256: sha256(section.fullText),
      afterSha256: sha256(newFullText),
    }),
  };
}

function expandUpgradeTableLevelEdit(sourceText, change = {}) {
  const shape = validateUpgradeTableLevelEditShape(change);
  if (!shape.ok) {
    throw codedError("UPGRADE_TABLE_EDIT_SHAPE_INVALID", shape.errors.join(" "), { errors: shape.errors });
  }
  const source = String(sourceText || "");
  const normalized = shape.normalized;
  const table = tablePlan(source, change, normalized.tableEdit);
  const maxLevel = maxLevelPlan(source, change);
  const amplification = shape.pathPolicy.amplification
    ? amplificationConstPlan(source, normalized.amplificationConstEdit)
    : null;
  const planProof = {
    mode: UPGRADE_TABLE_LEVEL_EDIT_TYPE,
    pvfPath: shape.normalizedPath,
    requestSyntax: normalized.syntax,
    selectorsAreRawGroupIndexes: true,
    gameplayDisplayLevelMappingInferred: false,
    sourceTextSha256: sha256(source),
    table: table.proof,
    maxLevelByRarity: maxLevel.proof,
    amplificationConst: amplification?.proof || null,
    forgingFileExcluded: true,
    clientWritten: false,
    inGameValidationRequired: true,
    staticChecksProveGameplayBehavior: false,
  };
  planProof.planBindingSha256 = canonicalJsonSha256(planProof);
  const components = [
    { id: change.id, name: "table", plan: table },
    { id: `${change.id}.max-level-by-rarity`, name: "max-level-by-rarity", plan: maxLevel },
  ];
  if (amplification) components.push({ id: `${change.id}.amplification-const`, name: "amplification-const", plan: amplification });
  const generatedChanges = components.map((component) => ({
    id: component.id,
    type: UPGRADE_TABLE_LEVEL_EDIT_TYPE,
    pvfPath: shape.normalizedPath,
    previousText: component.plan.section.fullText,
    newText: component.plan.newFullText,
    replaceAll: false,
    expectedOccurrences: 1,
    pvfEncoding: change.pvfEncoding,
    rationale: change.rationale || "",
    structuredEditParentId: change.id,
    structuredEditComponent: component.name,
    structuredEditRequest: change,
    structuredEditProof: {
      ...planProof,
      component: component.name,
      componentState: component.plan.proof.state,
      declaredValuesVerified: component.plan.proof.declaredValuesVerified,
      writerRequired: component.plan.proof.writerRequired,
      componentBeforeSha256: sha256(component.plan.section.fullText),
      componentAfterSha256: sha256(component.plan.newFullText),
    },
  }));
  let expectedText = source;
  for (const generated of generatedChanges) {
    expectedText = replaceExactOnce(expectedText, generated.previousText, generated.newText, generated.structuredEditComponent);
  }
  return {
    generatedChanges,
    expectedText,
    proof: planProof,
    noChange: generatedChanges.every((item) => item.structuredEditProof.componentState === "no-op"),
    changedComponentCount: generatedChanges.filter((item) => item.structuredEditProof.componentState === "changed").length,
    noOpComponentCount: generatedChanges.filter((item) => item.structuredEditProof.componentState === "no-op").length,
  };
}

function upgradeTableLevelEditSelfTest() {
  const checks = [];
  const rows = Array.from({ length: 20 }, (_, level) =>
    Array.from({ length: UPGRADE_TABLE_WIDTH }, (_, column) => String(level * 100 + column + 1)).join("\t"));
  const rarities = UPGRADE_RARITIES.map((rarity) => `\`${rarity}\`\t13`).join("\r\n");
  const constants = Array.from({ length: 20 }, (_, level) => Array(4).fill(String(level * 10)).join("\t")).join("\t");
  const source = [
    "#PVF_File",
    "[table]", rows.join("\t"), "[/table]", "",
    "[max upgrade level by rarity]", rarities, "[/max upgrade level by rarity]", "",
    "[amplification const]", constants, "[/amplification const]", "",
  ].join("\r\n");
  const maxLevelByRarity = Object.fromEntries(UPGRADE_RARITIES.map((rarity) => [rarity, 15]));
  const change = {
    id: "flatten-13-to-15",
    type: UPGRADE_TABLE_LEVEL_EDIT_TYPE,
    pvfPath: "etc/amplifyupgrade.etc",
    pvfEncoding: "Tw",
    sourceLevel: 13,
    targetLevels: [14, 15],
    copyColumns: ["B", "C", "D", "E", "F", "G", "M", "N", "O", "P", "Q", "R"],
    preserveColumns: ["H", "I", "J", "K", "L"],
    maxLevelByRarity,
    copyAmplificationConstFromLevel: 13,
    copyAmplificationConstToLevels: [14, 15],
    amplificationConstGroupWidth: 4,
    amplificationConstHasLevelZeroGroup: true,
  };
  const expanded = expandUpgradeTableLevelEdit(source, change);
  const fixedPoint = expandUpgradeTableLevelEdit(expanded.expectedText, change);
  const finalTable = tokenizeSection(findSection(expanded.expectedText, "table"));
  const copiedIndexes = change.copyColumns.map((column) => UPGRADE_TABLE_COLUMNS.indexOf(column));
  const preservedIndexes = change.preserveColumns.map((column) => UPGRADE_TABLE_COLUMNS.indexOf(column));
  const copiedOk = change.targetLevels.every((targetLevel) => copiedIndexes.every((column) =>
    finalTable[targetLevel * UPGRADE_TABLE_WIDTH + column].text === finalTable[13 * UPGRADE_TABLE_WIDTH + column].text));
  const preservedOk = change.targetLevels.every((targetLevel) => preservedIndexes.every((column) =>
    finalTable[targetLevel * UPGRADE_TABLE_WIDTH + column].text === String(targetLevel * 100 + column + 1)));
  checks.push({
    id: "amplify-17-column-and-four-value-groups-are-planned-atomically",
    ok:
      expanded.generatedChanges.length === 3 &&
      expanded.proof.table.width === 17 &&
      expanded.proof.table.firstColumnIsLevelNumber === false &&
      expanded.proof.amplificationConst.width === 4 &&
      expanded.proof.amplificationConst.hasLevelZeroGroup === true &&
      copiedOk && preservedOk && fixedPoint.expectedText === expanded.expectedText,
  });
  const finalMax = tokenizeSection(findSection(expanded.expectedText, "max upgrade level by rarity"));
  checks.push({
    id: "all-rarity-max-levels-are-explicit-and-updated",
    ok: finalMax.filter((_, index) => index % 2 === 1).every((token) => token.text === "15"),
  });
  const finalConst = tokenizeSection(findSection(expanded.expectedText, "amplification const"));
  checks.push({
    id: "amplification-target-groups-copy-source-level-with-zero-offset",
    ok: [14, 15].every((level) => Array.from({ length: 4 }, (_, index) =>
      finalConst[level * 4 + index].text === finalConst[13 * 4 + index].text).every(Boolean)),
  });
  const independentChange = {
    id: "independent-raw-groups",
    type: UPGRADE_TABLE_LEVEL_EDIT_TYPE,
    pvfPath: "etc/amplifyupgrade.etc",
    pvfEncoding: "Tw",
    tableEdit: {
      sourceGroup: 12,
      targetGroups: [13, 14],
      copyColumns: [...change.copyColumns],
      preserveColumns: [...change.preserveColumns],
    },
    maxLevelByRarity: Object.fromEntries(UPGRADE_RARITIES.map((rarity) => [rarity, 13])),
    amplificationConstEdit: {
      sourceGroup: 13,
      targetGroups: [14, 15],
      groupWidth: 4,
      hasLevelZeroGroup: true,
    },
  };
  const independent = expandUpgradeTableLevelEdit(source, independentChange);
  const independentFixedPoint = expandUpgradeTableLevelEdit(independent.expectedText, independentChange);
  checks.push({
    id: "nested-table-and-amplification-raw-group-selectors-are-independent",
    ok:
      independent.proof.requestSyntax === "nested-group-selectors" &&
      independent.proof.selectorsAreRawGroupIndexes === true &&
      independent.proof.gameplayDisplayLevelMappingInferred === false &&
      independent.proof.table.sourceGroup === 12 &&
      independent.proof.table.targetGroups.join(",") === "13,14" &&
      independent.proof.amplificationConst.sourceGroup === 13 &&
      independent.proof.amplificationConst.targetGroups.join(",") === "14,15" &&
      independent.proof.table.state === "changed" &&
      independent.proof.maxLevelByRarity.state === "no-op" &&
      independent.proof.amplificationConst.state === "changed" &&
      independentFixedPoint.noChange === true &&
      independentFixedPoint.proof.table.state === "no-op" &&
      independentFixedPoint.proof.maxLevelByRarity.state === "no-op" &&
      independentFixedPoint.proof.amplificationConst.state === "no-op",
  });
  const mixedShape = validateUpgradeTableLevelEditShape({ ...independentChange, sourceLevel: 12 });
  checks.push({
    id: "legacy-and-nested-selectors-cannot-be-mixed",
    ok: mixedShape.ok === false && mixedShape.errors.some((message) => message.includes("cannot be mixed")),
  });
  const independentLegacyShape = validateUpgradeTableLevelEditShape({
    ...change,
    copyAmplificationConstFromLevel: 12,
  });
  checks.push({
    id: "legacy-flat-selector-compatibility-keeps-original-equality-rule",
    ok: independentLegacyShape.ok === false && validateUpgradeTableLevelEditShape(change).ok === true,
  });
  const setCellChange = {
    id: "exact-cell-recovery",
    type: UPGRADE_TABLE_LEVEL_EDIT_TYPE,
    pvfPath: "etc/upgrade.etc",
    pvfEncoding: "Tw",
    tableEdit: {
      setCells: [{ group: 1, column: "B", expectedBefore: "101", newValue: "777" }],
    },
    maxLevelByRarity: Object.fromEntries(UPGRADE_RARITIES.map((rarity) => [rarity, 13])),
  };
  const setCell = expandUpgradeTableLevelEdit(source, setCellChange);
  const setCellFixedPoint = expandUpgradeTableLevelEdit(setCell.expectedText, setCellChange);
  const setCellTokens = tokenizeSection(findSection(setCell.expectedText, "table"));
  checks.push({
    id: "exact-set-cells-verifies-old-value-and-preserves-non-targets",
    ok:
      setCellTokens[UPGRADE_TABLE_WIDTH].text === "777" &&
      setCell.proof.table.cellDiffs.filter((diff) => diff.mode === "set-cell").length === 1 &&
      setCell.proof.table.actualChangedTokenIndexes.length === 1 &&
      setCell.proof.table.nonTargetTokensPreserved === true &&
      setCell.proof.maxLevelByRarity.state === "no-op" &&
      setCellFixedPoint.noChange === true &&
      setCellFixedPoint.proof.table.cellDiffs[0]?.alreadyDesired === true,
  });
  let setCellMismatchCode = null;
  try {
    expandUpgradeTableLevelEdit(source, {
      ...setCellChange,
      tableEdit: { setCells: [{ group: 1, column: "B", expectedBefore: "999", newValue: "777" }] },
    });
  } catch (error) {
    setCellMismatchCode = error.code;
  }
  checks.push({
    id: "exact-set-cells-old-value-drift-is-blocked",
    ok: setCellMismatchCode === "UPGRADE_TABLE_SET_CELL_EXPECTED_MISMATCH",
  });
  const invalidPath = validateUpgradeTableLevelEditShape({ ...change, pvfPath: "etc/upgrade_separate.etc" });
  checks.push({ id: "forging-path-remains-excluded", ok: invalidPath.ok === false });
  const incompleteColumns = validateUpgradeTableLevelEditShape({ ...change, preserveColumns: ["H", "I", "J", "K"] });
  checks.push({ id: "implicit-or-missing-column-remains-blocked", ok: incompleteColumns.ok === false });
  let malformedWidthCode = null;
  try {
    expandUpgradeTableLevelEdit(source.replace(`${rows[0]}\t`, `${rows[0].split("\t").slice(0, 16).join("\t")}\t`), change);
  } catch (error) {
    malformedWidthCode = error.code;
  }
  checks.push({ id: "malformed-table-width-fails-closed", ok: malformedWidthCode === "UPGRADE_TABLE_WIDTH_MISMATCH" });
  const partialRaritySource = source.replace(rarities, "`common`\t50\r\n`uncommon`\t50");
  const preserveRarityChange = {
    id: "preserve-original-rarities", type: UPGRADE_TABLE_LEVEL_EDIT_TYPE,
    pvfPath: "etc/upgrade.etc", tableEdit: { setCells: [{ group: 0, column: "B", expectedBefore: "1", newValue: "2" }] },
  };
  const partialEdit = expandUpgradeTableLevelEdit(partialRaritySource, preserveRarityChange);
  const partialFixedPoint = expandUpgradeTableLevelEdit(partialEdit.expectedText, preserveRarityChange);
  checks.push({ id: "table-only-edit-preserves-partial-rarity-section", ok:
    partialEdit.changedComponentCount === 1 && partialEdit.noOpComponentCount === 1 &&
    partialEdit.expectedText === partialRaritySource.replace("[table]\r\n1\t", "[table]\r\n2\t") &&
    validMaxLevelProof(partialEdit.proof.maxLevelByRarity, preserveRarityChange) && partialFixedPoint.noChange });
  checks.push({ id: "preserved-rarity-proof-rejects-hash-or-mode-drift", ok:
    !validMaxLevelProof({ ...partialEdit.proof.maxLevelByRarity, afterSha256: "0".repeat(64) }, preserveRarityChange) &&
    !validMaxLevelProof({ ...partialEdit.proof.maxLevelByRarity, writerRequired: true }, preserveRarityChange) &&
    !validMaxLevelProof(partialEdit.proof.maxLevelByRarity, { ...preserveRarityChange, maxLevelByRarity }) });
  let explicitPartialCode;
  try { expandUpgradeTableLevelEdit(partialRaritySource, { ...preserveRarityChange, maxLevelByRarity }); }
  catch (error) { explicitPartialCode = error.code; }
  checks.push({ id: "explicit-rarity-edit-still-requires-complete-existing-rows", ok:
    explicitPartialCode === "UPGRADE_RARITY_TABLE_SHAPE_MISMATCH" &&
    !validateUpgradeTableLevelEditShape({ ...preserveRarityChange, maxLevelByRarity: null }).ok });
  return { ok: checks.every((check) => check.ok), checks };
}

module.exports = {
  AMPLIFICATION_CONST_GROUP_WIDTH,
  UPGRADE_RARITIES,
  UPGRADE_TABLE_COLUMNS,
  UPGRADE_TABLE_LEVEL_EDIT_TYPE,
  UPGRADE_TABLE_WIDTH,
  expandUpgradeTableLevelEdit,
  upgradeTableLevelEditSelfTest,
  validateUpgradeTableLevelEditShape,
  validMaxLevelProof,
};
