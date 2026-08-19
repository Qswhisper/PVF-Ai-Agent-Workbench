"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BackendStdioClient, parseBackendTextResult } = require("../lib/backend-stdio-client");
const { runtimePath } = require("../lib/runtime-state");
const workbenchRoot = path.resolve(__dirname, "../../..");
const readonlyContractFile = path.join(workbenchRoot, "core", "pvf-agent-core", "contracts", "typescript-readonly-backend-contract.v1.json");
const readonlyContract = JSON.parse(fs.readFileSync(readonlyContractFile, "utf8"));
const typescriptEntry = require.resolve("../../../tools/pvf-bridge/fallback/pvf-readonly-backend.ts");
const { createChecksum, encrypt } = require("../../../tools/pvf-bridge/fallback/codec.ts");
const {
  resolvePvfPathInside,
  validatePvfEntryPath,
  validateWindowsMaterializationPath,
} = require("../../../tools/pvf-bridge/fallback/path-safety.ts");
const { StringTable, StringView, parseTokens } = require("../../../tools/pvf-bridge/fallback/script.ts");
const fallback = require(typescriptEntry);
const { loadPvfBackend } = require("../../../tools/pvf-bridge/native-backend");
const {
  automaticChineseNameSearchPlan,
  containsStringLinkToken,
  chooseSemanticReadCandidate,
  directReadReason,
  directSearchReason,
  retryReadReason,
  retrySearchReason,
  semanticWriteSafety,
  VERIFIED_INLINE_TEXT_MODE,
  VERIFIED_INLINE_CN_TEXT_MODE,
  isVerifiedInlineTextMode,
} = require("../lib/semantic-read-guard");
const { encodeLegacyText } = require("../../../tools/pvf-bridge/verified-inline-cn-text");

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sameStringSet(left, right) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function fileNameHash(bytes) {
  let value = 0x1505;
  for (const byte of bytes) value = ((Math.imul(value, 0x21) >>> 0) + byte) >>> 0;
  return Math.imul(value, 0x21) >>> 0;
}

function createStringTable(values, encoding = "Utf8") {
  const parts = values.map((value) => new Set(["Cn", "Tw"]).has(encoding)
    ? encodeLegacyText(value, encoding)
    : Buffer.from(value, "utf8"));
  const headerLength = 4 + (parts.length + 1) * 4;
  const output = Buffer.alloc(headerLength + parts.reduce((sum, part) => sum + part.length, 0));
  output.writeInt32LE(parts.length, 0);
  let cursor = headerLength - 4;
  for (let index = 0; index < parts.length; index += 1) {
    output.writeUInt32LE(cursor, 4 + index * 4);
    cursor += parts[index].length;
  }
  output.writeUInt32LE(cursor, 4 + parts.length * 4);
  let dataOffset = headerLength;
  for (const part of parts) {
    part.copy(output, dataOffset);
    dataOffset += part.length;
  }
  return output;
}

function createScript(tokens) {
  const output = Buffer.alloc(2 + tokens.length * 5);
  output[0] = 0xb0;
  output[1] = 0xd0;
  for (let index = 0; index < tokens.length; index += 1) {
    output[2 + index * 5] = tokens[index][0];
    output.writeUInt32LE(tokens[index][1] >>> 0, 3 + index * 5);
  }
  return output;
}

function createBinaryAni() {
  const output = Buffer.alloc(20);
  let cursor = 0;
  output.writeUInt16LE(1, cursor); cursor += 2; // frame count
  output.writeUInt16LE(0, cursor); cursor += 2; // image count
  output.writeUInt16LE(0, cursor); cursor += 2; // overall ANI properties
  output.writeUInt16LE(0, cursor); cursor += 2; // frame box count
  output.writeInt16LE(-1, cursor); cursor += 2; // no image
  output.writeInt32LE(0, cursor); cursor += 4; // x
  output.writeInt32LE(0, cursor); cursor += 4; // y
  output.writeUInt16LE(0, cursor); // frame property count
  return output;
}

function createFixturePvf(targetPath, options = {}) {
  const strings = [
    "stringview/fixture.str",
    "test.shp",
    "[name]",
    options.initialName || "fallback-fixture",
    "[message]",
    "message_1",
    "[/message]",
    "Swordman/Swordman.chr",
    "[job]",
    "[swordman]",
    "SwordmanSkill.lst",
    "Swordman/MomentarySlashEx.skl",
    "fixture skill",
    "[name2]",
    "Fixture Skill",
    "[type]",
    "[active]",
    "second-fixture",
    "[value]",
  ];
  const cnAnchorSectionIndex = options.cnLocalized ? strings.length : null;
  if (options.cnLocalized) strings.push("[description]", "装备强化增幅");
  const cnAnchorValueIndex = options.cnLocalized ? cnAnchorSectionIndex + 1 : null;
  const scopedStringIndexes = options.cnLocalized
    ? {
      check: strings.length,
      coat: strings.length + 1,
      support: strings.length + 2,
      ring: strings.length + 3,
      skill: strings.length + 4,
      explain: strings.length + 5,
      sameExplain: strings.length + 6,
      retainedExplain: strings.length + 7,
      checkEnd: strings.length + 8,
    }
    : null;
  if (options.cnLocalized) {
    strings.push("[check]", "coat", "support", "ring", "[skill]", "[explain]", "相同说明", "保留说明", "[/check]");
  }
  const worldmapStringIndexes = {
    dungeon: strings.length,
    dungeonEnd: strings.length + 1,
    name: strings.length + 2,
  };
  strings.push("[dungeon]", "[/dungeon]", "亡者峽谷");
  const creatureStringIndexes = {
    path: strings.length,
    name: strings.length + 1,
  };
  strings.push("test.cre", "測試寵物");
  const dungeonPathIndex = strings.length;
  const dungeonNameIndex = strings.length + 1;
  strings.push("towers/towerofsighs.dgn", options.dungeonName || options.initialName || "fallback-fixture");
  const questPathIndex = strings.length;
  const questNameIndex = strings.length + 1;
  const albertQuestPathIndex = strings.length + 2;
  const albertQuestNameIndex = strings.length + 3;
  const traditionalFixture = options.stringTableEncoding === "Tw";
  strings.push(
    "title/titlebook_70_despair1.8.qst",
    traditionalFixture ? "[挑戰]\r\n最終副本(一)" : "[挑战]\r\n最终副本(一)",
    "common/albert_condition_2.qst",
    traditionalFixture ? "阿爾伯特的條件 (2/7)" : "阿尔伯特的条件 (2/7)",
  );
  const testScriptTokens = [[5, 2], [7, 3], [5, 4], [9, 0], [10, 5], [5, 6], [5, 18], [2, 10]];
  const secondScriptTokens = [[5, 2], [7, 17]];
  if (options.cnLocalized) {
    testScriptTokens.push([5, cnAnchorSectionIndex], [7, cnAnchorValueIndex]);
    secondScriptTokens.push([5, cnAnchorSectionIndex], [7, cnAnchorValueIndex]);
  }
  const scopedScriptTokens = [];
  if (scopedStringIndexes) {
    for (const partIndex of [scopedStringIndexes.coat, scopedStringIndexes.support, scopedStringIndexes.ring]) {
      scopedScriptTokens.push(
        [5, scopedStringIndexes.check], [2, 0], [2, 1], [7, partIndex],
        [5, scopedStringIndexes.skill], [2, 0], [2, 7],
        [5, scopedStringIndexes.explain], [7, scopedStringIndexes.sameExplain],
        [5, scopedStringIndexes.skill], [2, 1], [2, 8],
        [5, scopedStringIndexes.explain], [7, scopedStringIndexes.retainedExplain],
        [5, scopedStringIndexes.checkEnd],
      );
    }
  }
  const localizedStringView = options.cnLocalized
    ? Buffer.concat([
      Buffer.from("message_1>", "ascii"),
      Buffer.from("d6d0cec4b1a3bba4", "hex"),
      Buffer.from("\r\n", "ascii"),
    ])
    : Buffer.from("message_1>只读备用后端\r\n", "utf8");
  const sourceFiles = [
    { fileName: "stringtable.bin", data: createStringTable(strings, options.stringTableEncoding || "Utf8") },
    { fileName: "n_string.lst", data: createScript([[2, 0], [7, 0]]) },
    { fileName: "stringview/fixture.str", data: localizedStringView },
    { fileName: "itemshop/itemshop.lst", data: createScript([[2, 1], [7, 1]]) },
    {
      fileName: "itemshop/test.shp",
      data: createScript(testScriptTokens),
    },
    { fileName: "itemshop/second.shp", data: createScript(secondScriptTokens) },
    ...(scopedStringIndexes
      ? [{ fileName: "stackable/scoped.stk", data: createScript(scopedScriptTokens) }]
      : []),
    {
      fileName: "worldmap/towers.wdm",
      data: createScript([
        [5, worldmapStringIndexes.dungeon],
        [2, 11000], [2, -1], [2, 11001], [2, -1], [2, 323], [2, -1],
        [5, worldmapStringIndexes.dungeonEnd],
        [5, 2], [7, worldmapStringIndexes.name],
      ]),
    },
    { fileName: "creature/creature.lst", data: createScript([[2, 1], [7, creatureStringIndexes.path]]) },
    { fileName: "creature/test.cre", data: createScript([[5, 2], [7, creatureStringIndexes.name]]) },
    { fileName: "dungeon/dungeon.lst", data: createScript([[2, 323], [7, dungeonPathIndex]]) },
    { fileName: "dungeon/towers/towerofsighs.dgn", data: createScript([[5, 2], [7, dungeonNameIndex]]) },
    {
      fileName: "n_quest/quest.lst",
      data: createScript([[2, 9707], [7, questPathIndex], [2, 350], [7, albertQuestPathIndex]]),
    },
    { fileName: "n_quest/title/titlebook_70_despair1.8.qst", data: createScript([[5, 2], [7, questNameIndex]]) },
    { fileName: "n_quest/common/albert_condition_2.qst", data: createScript([[5, 2], [7, albertQuestNameIndex]]) },
    { fileName: "etc/numeric.etc", data: createScript([[5, 18], [2, 10]]) },
    { fileName: "etc/numeric-sequence.etc", data: createScript([[5, 18], [2, 10]]) },
    { fileName: "character/character.lst", data: createScript([[2, 0], [7, 7]]) },
    { fileName: "character/Swordman/Swordman.chr", data: createScript([[5, 8], [7, 9]]) },
    { fileName: "skill/skilllist.lst", data: createScript([[2, 0], [7, 10]]) },
    { fileName: "skill/SwordmanSkill.lst", data: createScript([[2, 97], [7, 11]]) },
    {
      fileName: "skill/Swordman/MomentarySlashEx.skl",
      data: createScript([[5, 2], [7, 12], [5, 13], [7, 14], [5, 15], [7, 16]]),
    },
    { fileName: "script/fallback_fixture.nut", data: Buffer.from('function fallback_fixture() { return "needle"; }\r\n', "utf8") },
    { fileName: "sprite/fallback_fixture.ani", data: createBinaryAni() },
    { fileName: "raw/fixture.bin", data: Buffer.from([0, 1, 2, 3, 254, 255]) },
    { fileName: "raw/corrupt.txt", data: Buffer.from("corrupt encrypted fixture\r\n", "utf8"), corruptEncrypted: true },
  ];
  for (let index = 1; index < readonlyContract.resourceLimits.maxReportedSearchErrors + 2; index += 1) {
    sourceFiles.push({
      fileName: `raw/corrupt-${String(index).padStart(2, "0")}.txt`,
      data: Buffer.from(`corrupt encrypted fixture ${index}\r\n`, "utf8"),
      corruptEncrypted: true,
    });
  }
  for (let index = 0; index < 3; index += 1) {
    sourceFiles.push({ fileName: `bulk/match-${index}.txt`, data: Buffer.from("bulk match fixture\r\n", "utf8") });
  }
  if (options.duplicatePath) {
    sourceFiles.push({ fileName: "RAW/fixture.bin", data: Buffer.from("duplicate normalized path", "utf8") });
  }
  if (options.extraFileName) {
    sourceFiles.push({ fileName: options.extraFileName, data: Buffer.from("unsafe path fixture", "utf8") });
  }
  const files = sourceFiles.map((item) => {
    const fileNameBytes = Buffer.from(item.fileName, "ascii");
    const fileNameChecksum = fileNameHash(fileNameBytes);
    const padded = Buffer.alloc((item.data.length + 3) & ~3);
    item.data.copy(padded);
    const checksum = createChecksum(padded, padded.length, fileNameChecksum);
    return { ...item, fileNameBytes, fileNameChecksum, padded, checksum };
  }).sort((left, right) => left.fileNameChecksum - right.fileNameChecksum);

  const treeLength = (files.reduce((sum, item) => sum + 20 + item.fileNameBytes.length, 0) + 3) & ~3;
  const tree = Buffer.alloc(treeLength);
  let treeOffset = 0;
  let dataOffset = 0;
  for (const item of files) {
    tree.writeUInt32LE(item.fileNameChecksum, treeOffset); treeOffset += 4;
    tree.writeUInt32LE(item.fileNameBytes.length, treeOffset); treeOffset += 4;
    item.fileNameBytes.copy(tree, treeOffset); treeOffset += item.fileNameBytes.length;
    tree.writeInt32LE(item.data.length, treeOffset); treeOffset += 4;
    tree.writeUInt32LE(item.checksum, treeOffset); treeOffset += 4;
    tree.writeInt32LE(dataOffset, treeOffset); treeOffset += 4;
    dataOffset += item.padded.length;
  }
  const treeChecksum = createChecksum(tree, tree.length, files.length);
  const encryptedTree = encrypt(tree, treeChecksum);
  const guid = Buffer.from("PVF-READONLY-FALLBACK-FIXTURE", "ascii");
  const header = Buffer.alloc(4 + guid.length + 16);
  let headerOffset = 0;
  header.writeInt32LE(guid.length, headerOffset); headerOffset += 4;
  guid.copy(header, headerOffset); headerOffset += guid.length;
  header.writeInt32LE(2, headerOffset); headerOffset += 4;
  header.writeInt32LE(encryptedTree.length, headerOffset); headerOffset += 4;
  header.writeUInt32LE(treeChecksum, headerOffset); headerOffset += 4;
  header.writeInt32LE(files.length, headerOffset);
  fs.writeFileSync(targetPath, Buffer.concat([
    header,
    encryptedTree,
    ...files.map((item) => {
      const encrypted = encrypt(item.padded, item.checksum);
      if (item.corruptEncrypted && encrypted.length > 0) encrypted[0] ^= 0xff;
      return encrypted;
    }),
    Buffer.from("\0PVF fallback self-test fixture", "ascii"),
  ]));
  return new Map(files.map((item) => [item.fileName, item.data]));
}

async function rejectsReadonly(operation) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error && error.code === "READ_ONLY_FALLBACK";
  }
}

async function rejectsCode(operation, code) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error && error.code === code;
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-readonly-fallback-"));
  const fixturePath = path.join(tempRoot, "Script.pvf");
  const cnFixturePath = path.join(tempRoot, "Script-cn.pvf");
  const twFixturePath = path.join(tempRoot, "Script-tw.pvf");
  const checks = [];
  const add = (id, ok, details) => checks.push({ id, ok: Boolean(ok), ...(details ? { details } : {}) });
  let fallbackSessionId;
  let cnFallbackSessionId;
  const extraFallbackSessionIds = [];
  let nativeSessionId;
  let serverClient;
  let nativeServerClient;
  let controlledServerClient;
  let nativeAvailable = false;
  try {
    const expectedFiles = createFixturePvf(fixturePath);
    createFixturePvf(cnFixturePath, { cnLocalized: true, stringTableEncoding: "Cn", dungeonName: "叹息之塔" });
    createFixturePvf(twFixturePath, { stringTableEncoding: "Tw", initialName: "太陽", dungeonName: "太陽" });
    const sourceSha = sha256File(fixturePath);
    const cnSourceSha = sha256File(cnFixturePath);
    const twSourceSha = sha256File(twFixturePath);
    const fallbackHealth = fallback.health();
    const contractSourceFiles = readonlyContract.sourceFiles.map((file) => path.join(workbenchRoot, file));
    const fallbackDirectoryFiles = fs.readdirSync(path.dirname(typescriptEntry)).sort();
    const sourceText = contractSourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    add(
      "readonly-contract-identity",
      readonlyContract.schemaVersion === "1.0" &&
        readonlyContract.contractId === "typescript-readonly-backend-contract.v1" &&
        readonlyContract.backendSource === fallbackHealth.backend &&
        readonlyContract.sourceLanguage === fallbackHealth.sourceLanguage,
    );
    add(
      "readonly-contract-source-closure",
      contractSourceFiles.every((file) => file.endsWith(".ts") && fs.existsSync(file) && fs.statSync(file).isFile()) &&
        fallbackDirectoryFiles.every((file) => file.endsWith(".ts")) &&
        sameStringSet(fallbackDirectoryFiles.map((file) => `tools/pvf-bridge/fallback/${file}`), readonlyContract.sourceFiles),
    );
    add(
      "readonly-contract-no-runtime-dependencies",
      readonlyContract.runtime.npmRequired === false &&
        readonlyContract.runtime.networkRequired === false &&
        readonlyContract.runtime.buildStepRequired === false &&
        readonlyContract.runtime.externalRuntimeDependencies.length === 0 &&
        !/(?:child_process|node:child_process|\brequire\(["'](?:https?|net|tls|dgram|worker_threads)["']\)|\bfetch\s*\(|\beval\s*\()/i.test(sourceText),
    );
    add(
      "readonly-contract-no-filesystem-mutators",
      !/(?:\bfs(?:\.promises)?\.(?:write|writeFile|appendFile|copyFile|rename|rm|unlink|mkdir|truncate|createWriteStream|openSync)\s*\(|\bcreateWriteStream\s*\()/i.test(sourceText) &&
        sourceText.includes('fs.promises.open(this.sourcePath, "r")'),
    );
    add(
      "readonly-contract-resource-limits",
      JSON.stringify(fallbackHealth.resourceLimits) === JSON.stringify(readonlyContract.resourceLimits),
    );
    add(
      "semantic-read-guard-policy",
      directReadReason("itemshop/itemshop.kor.str", { pvfEncoding: "Cn" }, "Tw") === "cn-localization-file" &&
        directReadReason("itemshop/birken.shp", { pvfEncoding: "Cn", autoConvertStringLink: true }, "Tw") === "cn-stringlink-conversion" &&
        directReadReason("n_quest/title/fixture.qst", { pvfEncoding: "Tw", semanticVerificationRead: true }, "Tw") === "verified-text-readback" &&
        directReadReason("itemshop/itemshop.kor.str", { pvfEncoding: "Tw" }, "Tw") === null &&
        directSearchReason({ keyword: "中文", searchType: "SearchScript", pvfEncoding: "Cn" }, "Tw") === "cn-semantic-search" &&
        directSearchReason({ keyword: "中文", searchType: "SearchName", pvfEncoding: "Cn" }, "Tw") === "cn-semantic-search" &&
        directSearchReason({ keyword: "中文", searchType: "SearchStrings", pvfEncoding: "Cn" }, "Tw") === "cn-semantic-search" &&
        directSearchReason({ keyword: "9990001", searchType: "SearchScript", pvfEncoding: "Cn" }, "Tw") === null &&
        directSearchReason({ searchType: "SearchFileName", pvfEncoding: "Cn" }, "Tw") === null &&
        automaticChineseNameSearchPlan({ keyword: "叹息之塔", searchType: "SearchName", pvfEncoding: "Cn" }, "Cn")?.alternateEncoding === "Tw" &&
        automaticChineseNameSearchPlan({ keyword: "叹息之塔", searchType: "SearchName", pvfEncoding: "Cn", encodingExplicit: true }, "Cn") === null &&
        automaticChineseNameSearchPlan({ keyword: "12345", searchType: "SearchName", pvfEncoding: "Cn" }, "Cn") === null &&
        automaticChineseNameSearchPlan({ keyword: "叹息之塔", searchType: "SearchScript", pvfEncoding: "Cn" }, "Cn") === null &&
        containsStringLinkToken("<5::message_520`中文保护`>") &&
        retryReadReason({ isScriptFile: true, textContent: "<5::message_520`中文保护`>" }, { pvfEncoding: "Cn" }, "Tw") === "cn-stringlink-detected" &&
        retryReadReason({ isScriptFile: true, textContent: "[name]\r\n`中文保护`" }, { pvfEncoding: "Cn" }, "Tw") === "cn-nonascii-script-detected" &&
        retrySearchReason({ items: [{ preview: "[name] 中文保护" }] }, { keyword: "name", searchType: "SearchScript", pvfEncoding: "Cn" }, "Tw") === "cn-nonascii-search-preview-detected" &&
        [".co", ".lst", ".nut", ".sqr", ".str", ".wdm"].every((extension) =>
          semanticWriteSafety({
            kind: "write-file",
            pvfPath: `new/high-risk${extension}`,
            pvfEncoding: "Tw",
            textContent: "#PVF_File\r\n",
          }).code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED",
        ),
    );
    const encodingConflictChoice = chooseSemanticReadCandidate(
      { isScriptFile: true, textContent: "[name]\r\n`太陽`\r\n" },
      { isScriptFile: true, textContent: "[name]\r\n`び锭`\r\n" },
      { pvfEncoding: "Cn" },
      "Tw",
      "cn-nonascii-script-detected",
    );
    add(
      "semantic-read-guard-prefers-clean-session-encoding-over-obvious-mojibake",
      encodingConflictChoice.file?.textContent?.includes("太陽") &&
        encodingConflictChoice.semanticReadGuard?.reason === "text-encoding-mismatch-session-preferred" &&
        encodingConflictChoice.semanticReadGuard?.requestedEncoding === "Cn" &&
        encodingConflictChoice.semanticReadGuard?.selectedEncoding === "Tw",
      encodingConflictChoice,
    );
    add(
      "pvf-path-validator-accepts-legitimate-double-dot-name",
      validatePvfEntryPath("safe/name..atk") === "safe/name..atk",
    );
    const safeMaterializedPath = resolvePvfPathInside(tempRoot, "safe/name..atk");
    add(
      "pvf-materialization-path-stays-contained",
      pathInside(tempRoot, safeMaterializedPath) &&
        ["CON.txt", "safe/trailing. ", "safe/file?.txt"].every((candidate) => {
          try {
            validateWindowsMaterializationPath(candidate);
            return false;
          } catch (error) {
            return error?.code === "UNSAFE_PVF_ENTRY_PATH";
          }
        }),
    );
    const oversizedStringTable = Buffer.alloc(8);
    oversizedStringTable.writeInt32LE(readonlyContract.resourceLimits.maxStringTableEntries + 1, 0);
    add(
      "fallback-stringtable-entry-limit",
      await rejectsCode(() => StringTable.parse(oversizedStringTable, "Utf8"), "READ_ONLY_RESOURCE_LIMIT"),
    );
    const oversizedScript = Buffer.alloc(2 + (readonlyContract.resourceLimits.maxScriptTokens + 1) * 5);
    oversizedScript[0] = 0xb0;
    oversizedScript[1] = 0xd0;
    add(
      "fallback-script-token-limit",
      await rejectsCode(() => parseTokens(oversizedScript), "READ_ONLY_RESOURCE_LIMIT"),
    );
    const oversizedStringView = Buffer.alloc(2 + (readonlyContract.resourceLimits.maxStringViewFiles + 1) * 10);
    oversizedStringView[0] = 0xb0;
    oversizedStringView[1] = 0xd0;
    add(
      "fallback-stringview-file-limit",
      await rejectsCode(
        () => StringView.load({ entry: () => ({}), readDecrypted: async () => oversizedStringView }, { get: () => "" }, "Utf8"),
        "READ_ONLY_RESOURCE_LIMIT",
      ),
    );
    let lazyStringViewReads = 0;
    const lazyStringView = await StringView.load({
      entry: (fileName) => ({ fileName }),
      readDecrypted: async (entry) => {
        lazyStringViewReads += 1;
        return entry.fileName === "n_string.lst"
          ? createScript([[2, 0], [7, 0]])
          : Buffer.from("message_1>lazy string view\r\n", "utf8");
      },
    }, { get: () => "stringview/lazy.str" }, "Utf8");
    const stringViewStayedLazy = lazyStringViewReads === 1;
    await lazyStringView.ensure([0]);
    add(
      "fallback-stringview-loads-referenced-id-only",
      stringViewStayedLazy && lazyStringViewReads === 2 && lazyStringView.get(0, "message_1") === "lazy string view",
    );
    add(
      "fallback-typescript-runtime",
      typescriptEntry.endsWith(".ts") &&
        process.features?.typescript === "strip" &&
        fallbackHealth.sourceLanguage === "typescript" &&
        fallbackHealth.runtimeTypeStripping === "strip",
    );
    add(
      "fallback-health",
      fallbackHealth.readOnly === true &&
        fallbackHealth.backend === "typescript-readonly-fallback" &&
        fallback.__workbenchBackend?.readOnly === true &&
        fallback.__workbenchBackend?.sourceLanguage === "typescript" &&
        Object.isFrozen(fallback),
    );

    const opened = await fallback.openSession(fixturePath, "Utf8");
    fallbackSessionId = opened.sessionId;
    add("fallback-open", opened.fileCount === expectedFiles.size && opened.readOnly === true);
    const listed = await fallback.listFiles(fallbackSessionId);
    add("fallback-list", listed.length === expectedFiles.size && expectedFiles.size === new Set(listed.map((item) => item.fileName)).size);

    for (let index = 1; index < readonlyContract.resourceLimits.maxSessions; index += 1) {
      const extra = await fallback.openSession(fixturePath, "Utf8");
      extraFallbackSessionIds.push(extra.sessionId);
    }
    add(
      "fallback-session-limit",
      await rejectsCode(() => fallback.openSession(fixturePath, "Utf8"), "READ_ONLY_SESSION_LIMIT"),
    );
    while (extraFallbackSessionIds.length > 0) await fallback.closeSession(extraFallbackSessionIds.pop());

    const duplicatePath = path.join(tempRoot, "duplicate-path.pvf");
    createFixturePvf(duplicatePath, { duplicatePath: true });
    let duplicateRejected = false;
    try {
      await fallback.openSession(duplicatePath, "Utf8");
    } catch (error) {
      duplicateRejected = /duplicate normalized path/i.test(error.message || "");
    }
    add("fallback-rejects-duplicate-normalized-path", duplicateRejected);

    const unsafeEntryPaths = [
      "../escape.txt",
      "safe/../../escape.txt",
      "/absolute.txt",
      "C:/escape.txt",
      "\\\\server\\share\\escape.txt",
      "safe//empty.txt",
      "safe/./dot.txt",
      "safe/file.txt:stream",
      `safe/null-${String.fromCharCode(0)}.txt`,
    ];
    let unsafeRejectedCount = 0;
    for (const [index, unsafeEntryPath] of unsafeEntryPaths.entries()) {
      const unsafeFixturePath = path.join(tempRoot, `unsafe-path-${index}.pvf`);
      createFixturePvf(unsafeFixturePath, { extraFileName: unsafeEntryPath });
      try {
        await fallback.openSession(unsafeFixturePath, "Utf8");
      } catch (error) {
        if (error?.code === "UNSAFE_PVF_ENTRY_PATH") unsafeRejectedCount += 1;
      }
    }
    add(
      "fallback-rejects-unsafe-entry-paths",
      unsafeRejectedCount === unsafeEntryPaths.length,
      { tested: unsafeEntryPaths.length, rejected: unsafeRejectedCount },
    );

    const corruptTreePath = path.join(tempRoot, "corrupt-tree.pvf");
    const corruptTree = Buffer.from(fs.readFileSync(fixturePath));
    const guidLength = corruptTree.readInt32LE(0);
    corruptTree[4 + guidLength + 16] ^= 0xff;
    fs.writeFileSync(corruptTreePath, corruptTree);
    let corruptTreeRejected = false;
    try {
      await fallback.openSession(corruptTreePath, "Utf8");
    } catch (error) {
      corruptTreeRejected = /file-tree checksum validation failed/i.test(error.message || "");
    }
    add("fallback-rejects-corrupt-file-tree", corruptTreeRejected);

    const lst = await fallback.readFile(fallbackSessionId, "itemshop/itemshop.lst", { pvfEncoding: "Utf8" });
    add(
      "fallback-lst-preserves-relative-display-path",
      /1\s+`test\.shp`/.test(lst.textContent || "") && !(lst.textContent || "").includes("`itemshop/test.shp`"),
    );
    const scriptRaw = await fallback.readFile(fallbackSessionId, "itemshop/test.shp", { pvfEncoding: "Utf8", autoConvertStringLink: false });
    add("fallback-script-stringlink-raw", (scriptRaw.textContent || "").includes("<0::message_1`只读备用后端`>"));
    const scriptFriendly = await fallback.readFile(fallbackSessionId, "itemshop/test.shp", { pvfEncoding: "Utf8", autoConvertStringLink: true });
    add("fallback-script-stringlink-friendly", (scriptFriendly.textContent || "").includes("`只读备用后端`"));
    const cnOpened = await fallback.openSession(cnFixturePath, "Tw");
    cnFallbackSessionId = cnOpened.sessionId;
    const cnStringView = await fallback.readFile(cnFallbackSessionId, "stringview/fixture.str", { pvfEncoding: "Cn" });
    const cnScript = await fallback.readFile(cnFallbackSessionId, "itemshop/test.shp", {
      pvfEncoding: "Cn",
      autoConvertStringLink: false,
    });
    const cnSearch = await fallback.searchFiles(cnFallbackSessionId, {
      keyword: "中文保护",
      searchPath: "itemshop",
      searchType: "SearchScript",
      matchMode: "Like",
      pvfEncoding: "Cn",
    });
    add(
      "fallback-cn-semantic-read-and-search",
      (cnStringView.textContent || "").includes("中文保护") &&
        (cnScript.textContent || "").includes("<0::message_1`中文保护`>") &&
        cnSearch.items.some((item) => item.fileName === "itemshop/test.shp"),
    );
    const raw = await fallback.readFile(fallbackSessionId, "itemshop/test.shp", { decompileScript: false });
    add("fallback-raw-bytes", Buffer.from(raw.base64Content || "", "base64").equals(expectedFiles.get("itemshop/test.shp")));
    let corruptFileRejected = false;
    try {
      await fallback.readFile(fallbackSessionId, "raw/corrupt.txt", { pvfEncoding: "Utf8" });
    } catch (error) {
      corruptFileRejected = /file checksum validation failed/i.test(error.message || "");
    }
    add("fallback-rejects-corrupt-file-data", corruptFileRejected);
    const nut = await fallback.readFile(fallbackSessionId, "script/fallback_fixture.nut", { pvfEncoding: "Utf8" });
    add("fallback-nut", (nut.textContent || "").includes("needle"));
    const ani = await fallback.readFile(fallbackSessionId, "sprite/fallback_fixture.ani", {});
    add("fallback-binary-ani", (ani.textContent || "").includes("[FRAME MAX]") && (ani.textContent || "").includes("[FRAME000]"));

    const filenameSearch = await fallback.searchFiles(fallbackSessionId, { keyword: "test.shp", searchType: "SearchFileName", matchMode: "Like" });
    add("fallback-search-filename", filenameSearch.items.some((item) => item.fileName === "itemshop/test.shp"));
    const scriptSearch = await fallback.searchFiles(fallbackSessionId, { keyword: "fallback-fixture", searchType: "SearchScript", matchMode: "Like", pvfEncoding: "Utf8" });
    add(
      "fallback-search-script",
      scriptSearch.items.some((item) => item.fileName === "itemshop/test.shp") &&
        scriptSearch.searchedCount < expectedFiles.size,
    );
    const worldmapNameSearch = await fallback.searchFiles(fallbackSessionId, {
      keyword: "亡者峽谷",
      searchPath: "worldmap",
      searchType: "SearchName",
      matchMode: "Like",
      pvfEncoding: "Utf8",
    });
    add(
      "fallback-search-name-includes-audited-worldmap-script-types",
      worldmapNameSearch.items.some((item) => item.fileName === "worldmap/towers.wdm") &&
        worldmapNameSearch.searchedCount === 1,
    );
    const creatureNameSearch = await fallback.searchFiles(fallbackSessionId, {
      keyword: "測試寵物",
      searchPath: "creature",
      searchType: "SearchName",
      matchMode: "Like",
      pvfEncoding: "Utf8",
    });
    add(
      "fallback-search-name-includes-creature-domain",
      creatureNameSearch.items.some((item) => item.fileName === "creature/test.cre") &&
        creatureNameSearch.searchedCount === 2,
    );
    const multilineQuestNameSearch = await fallback.searchFiles(fallbackSessionId, {
      keyword: "最终副本",
      searchPath: "n_quest",
      searchType: "SearchName",
      matchMode: "Like",
      pvfEncoding: "Utf8",
    });
    const partialAlbertNameSearch = await fallback.searchFiles(fallbackSessionId, {
      keyword: "阿尔伯特",
      searchPath: "n_quest",
      searchType: "SearchName",
      matchMode: "Like",
      pvfEncoding: "Utf8",
    });
    add(
      "fallback-search-name-supports-multiline-and-partial-name-tokens",
      multilineQuestNameSearch.items.some((item) =>
        item.fileName === "n_quest/title/titlebook_70_despair1.8.qst" &&
        item.displayName === "[挑战] 最终副本(一)") &&
        partialAlbertNameSearch.items.some((item) => item.fileName === "n_quest/common/albert_condition_2.qst"),
      { multilineQuestNameSearch, partialAlbertNameSearch },
    );
    const stringSearch = await fallback.searchFiles(fallbackSessionId, { keyword: "fallback-fixture", searchType: "SearchStrings", matchMode: "Like" });
    add(
      "fallback-search-strings",
      stringSearch.items.some((item) => item.fileName === "itemshop/test.shp") &&
        stringSearch.searchedCount < expectedFiles.size,
    );
    const absentStringSearch = await fallback.searchFiles(fallbackSessionId, {
      keyword: "definitely-absent-string-table-value",
      searchType: "SearchStrings",
      matchMode: "Like",
    });
    add(
      "fallback-search-strings-zero-index-short-circuit",
      absentStringSearch.matchedCount === 0 &&
        absentStringSearch.searchedCount === 0 &&
        absentStringSearch.shortCircuited === true &&
        absentStringSearch.stringTableMatchedCount === 0 &&
        absentStringSearch.candidateCount < expectedFiles.size,
    );
    const resolveSkillCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "resolve-skill",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--job", "swordman",
        "--id", "97",
        "--raw",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let resolveSkillResult = null;
    try {
      resolveSkillResult = JSON.parse(resolveSkillCli.stdout || "null");
    } catch {
      // The assertion below records malformed CLI output without hiding it.
    }
    add(
      "cli-resolve-skill-target-registry-chain",
      resolveSkillCli.status === 0 &&
        resolveSkillResult?.result?.route?.character?.jobToken === "swordman" &&
        resolveSkillResult?.result?.route?.skillRegistryPath?.toLowerCase() === "skill/swordmanskill.lst" &&
        resolveSkillResult?.result?.skill?.entry?.pvfPath?.toLowerCase() === "skill/swordman/momentaryslashex.skl" &&
        resolveSkillResult?.result?.agentHandoff?.additionalDiscoveryRequired === false,
      resolveSkillCli.status === 0 ? undefined : { stderr: resolveSkillCli.stderr },
    );
    const resolveLstAliasCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "resolve-lst",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--lst", "dungeon",
        "--id", "323",
        "--no-summary",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let resolveLstAliasResult = null;
    try { resolveLstAliasResult = JSON.parse(resolveLstAliasCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-resolve-lst-expands-domain-alias",
      resolveLstAliasCli.status === 0 &&
        resolveLstAliasResult?.result?.registry?.path === "dungeon/dungeon.lst" &&
        resolveLstAliasResult?.result?.entry?.pvfPath === "dungeon/towers/towerofsighs.dgn" &&
        resolveLstAliasResult?.agentHandoff?.registryIdResolutionComplete === true &&
        resolveLstAliasResult?.agentHandoff?.naturalLanguageNameMustUseSearchNameFirst === true &&
        resolveLstAliasResult?.agentHandoff?.directRegistryResolutionAllowedFirstOnlyForExplicitSelector === true &&
        resolveLstAliasResult?.agentHandoff?.guessedIdOrPathCannotAuthorizeFirstResolution === true &&
        resolveLstAliasResult?.agentHandoff?.returnedPathOrStemSearchRequired === false,
      resolveLstAliasResult || { stderr: resolveLstAliasCli.stderr },
    );
    const searchScriptCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search-script",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--keyword", "fallback-fixture",
        "--raw",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let searchScriptResult = null;
    try {
      searchScriptResult = JSON.parse(searchScriptCli.stdout || "null");
    } catch {
      // The assertion below records malformed CLI output without hiding it.
    }
    add(
      "cli-search-script-exact-handoff",
      searchScriptCli.status === 0 &&
        searchScriptResult?.result?.items?.some((item) => item.fileName === "itemshop/test.shp") &&
        searchScriptResult?.agentHandoff?.exactScriptSearchComplete === true &&
        searchScriptResult?.agentHandoff?.exactScriptSymbolsOnly === true &&
        searchScriptResult?.agentHandoff?.naturalLanguageNameSearchRequired === false &&
        searchScriptResult?.agentHandoff?.zeroMatchesProveRuntimeAbsence === false,
      searchScriptCli.status === 0 ? undefined : { stderr: searchScriptCli.stderr },
    );
    const searchNameCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--keyword", "fallback-fixture",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let searchNameResult = null;
    try { searchNameResult = JSON.parse(searchNameCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-natural-language-search-name-handoff",
      searchNameCli.status === 0 &&
        searchNameResult?.result?.items?.some((item) => item.fileName === "itemshop/test.shp") &&
        searchNameResult?.agentHandoff?.naturalLanguageNameSearchComplete === true &&
        searchNameResult?.agentHandoff?.simplifiedTraditionalRetryRequired === false &&
        searchNameResult?.agentHandoff?.automaticFullScriptRescanRequired === false &&
        searchNameResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.finalUnchangedClaimIsBeforeAfterProof === true &&
        searchNameResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineMustBeNextWorkbenchCommandAfterRequiredFirstCommand === true &&
        searchNameResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineMustRunBeforeFirstPvfChange === true &&
        searchNameResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineIsInvalidIfFirstRunAfterAnyPvfChange === true &&
        searchNameResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.doNotDeferBaselineUntilValidateDryRunOrApply === true &&
        searchNameResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.finalOnlyFingerprintProvesUnchanged === false &&
        searchNameResult?.agentHandoff?.nextAction?.includes("the next Workbench command now must be one pvf-read fingerprint") &&
        searchNameResult?.agentHandoff?.nextAction?.includes("before any pvf-change command") &&
        searchNameResult?.agentHandoff?.writeCapabilityPreflight?.routineEnvironmentCheckRequired === false &&
        searchNameResult?.agentHandoff?.writeCapabilityPreflight?.controlledDryRunDiagnosesWriteCapability === true,
      searchNameCli.status === 0 ? undefined : { stderr: searchNameCli.stderr },
    );
    const naturalSubstringNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--keyword", "最终副本（一）",
        "--search-path", "n_quest",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let naturalSubstringNameSearchResult = null;
    try { naturalSubstringNameSearchResult = JSON.parse(naturalSubstringNameSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-search-name-default-is-safe-literal-substring-with-width-folding",
      naturalSubstringNameSearchCli.status === 0 &&
        naturalSubstringNameSearchResult?.result?.items?.some((item) =>
          item.fileName === "n_quest/title/titlebook_70_despair1.8.qst" &&
          item.displayName === "[挑战] 最终副本(一)" &&
          item.registryIdentity?.confirmed === true &&
          item.registryIdentity?.entries?.some((entry) => entry.id === 9707)) &&
        naturalSubstringNameSearchResult?.result?.registryResolution?.automatic === true &&
        naturalSubstringNameSearchResult?.result?.registryResolution?.allReturnedPathsConfirmed === true &&
        naturalSubstringNameSearchResult?.result?.nameSearch?.mode === "literal-substring" &&
        naturalSubstringNameSearchResult?.result?.nameSearch?.safeLiteralEscaping === true &&
        naturalSubstringNameSearchResult?.agentHandoff?.literalSubstringMatchApplied === true &&
        naturalSubstringNameSearchResult?.agentHandoff?.multilineNameTokenSupported === true &&
        naturalSubstringNameSearchResult?.agentHandoff?.widthAndPunctuationVariantsSupported === true &&
        naturalSubstringNameSearchResult?.agentHandoff?.returnedRegistryIdentityAutomaticallyChecked === true &&
        naturalSubstringNameSearchResult?.agentHandoff?.allReturnedPathsRegistryConfirmed === true &&
        naturalSubstringNameSearchResult?.agentHandoff?.additionalResolvePathCommandsRequired === false &&
        naturalSubstringNameSearchResult?.agentHandoff?.returnedPathOrStemSecondSearchRequired === false,
      naturalSubstringNameSearchResult || { stderr: naturalSubstringNameSearchCli.stderr },
    );
    const autoCnNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search",
        "--pvf", cnFixturePath,
        "--encoding", "Tw",
        "--keyword", "叹息之塔",
        "--search-path", "dungeon",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let autoCnNameSearchResult = null;
    try { autoCnNameSearchResult = JSON.parse(autoCnNameSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-search-name-auto-checks-cn-and-tw-selects-cn",
      autoCnNameSearchCli.status === 0 &&
        autoCnNameSearchResult?.result?.items?.some((item) =>
          item.fileName === "dungeon/towers/towerofsighs.dgn" &&
          item.registryIdentity?.entries?.some((entry) => entry.id === 323)) &&
        autoCnNameSearchResult?.result?.automaticEncodingSelection?.selectedEncoding === "Cn" &&
        autoCnNameSearchResult?.result?.automaticEncodingSelection?.checkedEncodings?.join(",") === "Cn,Tw" &&
        autoCnNameSearchResult?.result?.automaticEncodingSelection?.safeForWriteEncodingSelection === false &&
        autoCnNameSearchResult?.result?.domainRoute?.registryPath === "dungeon/dungeon.lst" &&
        autoCnNameSearchResult?.agentHandoff?.cnTwEncodingRetryRequired === false &&
        autoCnNameSearchResult?.agentHandoff?.searchEncodingMayAuthorizeWrite === false,
      autoCnNameSearchResult || { stderr: autoCnNameSearchCli.stderr },
    );
    const autoTwNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search",
        "--pvf", twFixturePath,
        "--encoding", "Tw",
        "--keyword", "太陽",
        "--search-path", "dungeon",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let autoTwNameSearchResult = null;
    try { autoTwNameSearchResult = JSON.parse(autoTwNameSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-search-name-auto-checks-cn-and-tw-selects-tw",
      autoTwNameSearchCli.status === 0 &&
        autoTwNameSearchResult?.result?.items?.some((item) => item.fileName === "dungeon/towers/towerofsighs.dgn") &&
        autoTwNameSearchResult?.result?.automaticEncodingSelection?.selectedEncoding === "Tw" &&
        autoTwNameSearchResult?.result?.automaticEncodingSelection?.selectionMode === "alternate-only-match" &&
        autoTwNameSearchResult?.agentHandoff?.automaticCnTwEncodingChecked === true,
      autoTwNameSearchResult || { stderr: autoTwNameSearchCli.stderr },
    );
    const explicitTwNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search",
        "--pvf", twFixturePath,
        "--encoding", "Tw",
        "--pvf-encoding", "Tw",
        "--keyword", "太陽",
        "--search-path", "dungeon",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let explicitTwNameSearchResult = null;
    try { explicitTwNameSearchResult = JSON.parse(explicitTwNameSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-search-name-explicit-encoding-remains-single-pass",
      explicitTwNameSearchCli.status === 0 &&
        explicitTwNameSearchResult?.result?.items?.some((item) => item.fileName === "dungeon/towers/towerofsighs.dgn") &&
        explicitTwNameSearchResult?.result?.automaticEncodingSelection === undefined &&
        explicitTwNameSearchResult?.result?.searchPassCount === undefined,
      explicitTwNameSearchResult || { stderr: explicitTwNameSearchCli.stderr },
    );
    const autoZeroNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search",
        "--pvf", twFixturePath,
        "--encoding", "Tw",
        "--keyword", "不存在的副本",
        "--search-path", "dungeon",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let autoZeroNameSearchResult = null;
    try { autoZeroNameSearchResult = JSON.parse(autoZeroNameSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-search-name-zero-match-confirms-both-encodings-without-retry",
      autoZeroNameSearchCli.status === 0 &&
        autoZeroNameSearchResult?.result?.matchedCount === 0 &&
        autoZeroNameSearchResult?.result?.automaticEncodingSelection?.selectionMode === "no-match-both-checked" &&
        autoZeroNameSearchResult?.agentHandoff?.cnTwEncodingRetryRequired === false &&
        autoZeroNameSearchResult?.agentHandoff?.zeroMatchesProveTargetAbsence === false,
      autoZeroNameSearchResult || { stderr: autoZeroNameSearchCli.stderr },
    );
    const batchNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search-batch",
        "--pvf", twFixturePath,
        "--encoding", "Tw",
        "--name", "太陽",
        "--search-path", "dungeon",
        "--name", "測試寵物",
        "--search-path", "creature",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let batchNameSearchResult = null;
    try { batchNameSearchResult = JSON.parse(batchNameSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-search-batch-reuses-session-and-routes-creature-registry",
      batchNameSearchCli.status === 0 &&
        batchNameSearchResult?.result?.requestedCount === 2 &&
        batchNameSearchResult?.result?.matchedRequestCount === 2 &&
        batchNameSearchResult?.result?.sessionReuse?.openedSessionCount === 1 &&
        batchNameSearchResult?.result?.items?.[0]?.result?.automaticEncodingSelection?.selectedEncoding === "Tw" &&
        batchNameSearchResult?.result?.items?.[0]?.result?.registryResolution?.allReturnedPathsConfirmed === true &&
        batchNameSearchResult?.result?.items?.[1]?.result?.items?.some((item) => item.fileName === "creature/test.cre") &&
        batchNameSearchResult?.result?.items?.[1]?.result?.items?.some((item) =>
          item.registryIdentity?.entries?.some((entry) => entry.id === 1)) &&
        batchNameSearchResult?.result?.items?.[1]?.domainRoute?.registryPath === "creature/creature.lst" &&
        batchNameSearchResult?.agentHandoff?.naturalLanguageBatchSearchComplete === true &&
        batchNameSearchResult?.agentHandoff?.onePvfSessionUsed === true &&
        batchNameSearchResult?.agentHandoff?.returnedRegistryIdentityAutomaticallyChecked === true &&
        batchNameSearchResult?.agentHandoff?.allReturnedRegistryPathsConfirmed === true &&
        batchNameSearchResult?.agentHandoff?.additionalResolvePathCommandsRequired === false &&
        batchNameSearchResult?.agentHandoff?.returnedPathOrStemSecondSearchRequired === false &&
        batchNameSearchResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineMustBeNextWorkbenchCommandAfterRequiredFirstCommand === true &&
        batchNameSearchResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.runBaselineNowBeforeAnyDryRun === true &&
        batchNameSearchResult?.agentHandoff?.nextAction?.includes("the next Workbench command now must be one pvf-read fingerprint") &&
        batchNameSearchResult?.agentHandoff?.writeCapabilityPreflight?.checkBeforeRawReadRequired === false,
      batchNameSearchResult || { stderr: batchNameSearchCli.stderr },
    );
    const invalidBatchNameSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search-batch",
        "--pvf", twFixturePath,
        "--encoding", "Tw",
        "--name", "太陽",
        "--name", "測試寵物",
        "--search-path", "dungeon",
        "--search-path", "creature",
        "--search-path", "npc",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    add(
      "cli-search-batch-path-count-mismatch-stops-safely",
      invalidBatchNameSearchCli.status === 1 &&
        /one shared --search-path or exactly one --search-path for every --name/i.test(invalidBatchNameSearchCli.stderr || "") &&
        sha256File(twFixturePath) === twSourceSha,
      { status: invalidBatchNameSearchCli.status, stderr: invalidBatchNameSearchCli.stderr },
    );
    const resolveLstBatchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "resolve-lst-batch",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--lst", "quest",
        "--id", "9707",
        "--id", "350",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let resolveLstBatchResult = null;
    try { resolveLstBatchResult = JSON.parse(resolveLstBatchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-resolve-lst-batch-expands-domain-alias-and-reuses-session",
      resolveLstBatchCli.status === 0 &&
        resolveLstBatchResult?.result?.registryPath === "n_quest/quest.lst" &&
        resolveLstBatchResult?.result?.requestedCount === 2 &&
        resolveLstBatchResult?.result?.foundCount === 2 &&
        resolveLstBatchResult?.result?.onePvfSessionUsed === true &&
        resolveLstBatchResult?.result?.items?.[0]?.result?.entry?.pvfPath === "n_quest/title/titlebook_70_despair1.8.qst" &&
        resolveLstBatchResult?.result?.items?.[1]?.result?.entry?.pvfPath === "n_quest/common/albert_condition_2.qst" &&
        resolveLstBatchResult?.result?.recommendedReadBatchCommand?.includes("pvf-read read-batch") &&
        resolveLstBatchResult?.agentHandoff?.batchRegistryIdResolutionComplete === true &&
        resolveLstBatchResult?.agentHandoff?.naturalLanguageNameMustUseSearchNameFirst === true &&
        resolveLstBatchResult?.agentHandoff?.directRegistryResolutionAllowedFirstOnlyForExplicitSelector === true &&
        resolveLstBatchResult?.agentHandoff?.guessedIdOrPathCannotAuthorizeFirstResolution === true &&
        resolveLstBatchResult?.agentHandoff?.additionalPerIdResolveRequired === false &&
        resolveLstBatchResult?.agentHandoff?.returnedPathOrStemSearchRequired === false &&
        resolveLstBatchResult?.agentHandoff?.nextCommandOnly === resolveLstBatchResult?.result?.recommendedReadBatchCommand,
      resolveLstBatchResult || { stderr: resolveLstBatchCli.stderr },
    );
    const resolvePathBatchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "resolve-path-batch",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--registry", "quest",
        "--path", "n_quest/title/titlebook_70_despair1.8.qst",
        "--path", "n_quest/common/albert_condition_2.qst",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let resolvePathBatchResult = null;
    try { resolvePathBatchResult = JSON.parse(resolvePathBatchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-resolve-path-batch-expands-domain-alias-and-reuses-session",
      resolvePathBatchCli.status === 0 &&
        resolvePathBatchResult?.result?.registryPaths?.join(",") === "n_quest/quest.lst" &&
        resolvePathBatchResult?.result?.requestedCount === 2 &&
        resolvePathBatchResult?.result?.confirmedCount === 2 &&
        resolvePathBatchResult?.result?.onePvfSessionUsed === true &&
        resolvePathBatchResult?.result?.items?.every((item) => item.result?.matchedCount === 1) &&
        resolvePathBatchResult?.agentHandoff?.batchRegistryPathResolutionComplete === true &&
        resolvePathBatchResult?.agentHandoff?.additionalPerPathResolveRequired === false &&
        resolvePathBatchResult?.agentHandoff?.returnedPathOrStemSearchRequired === false,
      resolvePathBatchResult || { stderr: resolvePathBatchCli.stderr },
    );
    const duplicateResolveLstBatchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "resolve-lst-batch",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--lst", "quest",
        "--id", "350",
        "--id", "350",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    add(
      "cli-resolve-lst-batch-duplicate-id-stops-safely",
      duplicateResolveLstBatchCli.status === 1 &&
        /does not accept duplicate --id/i.test(duplicateResolveLstBatchCli.stderr || "") &&
        sha256File(fixturePath) === sourceSha,
      { status: duplicateResolveLstBatchCli.status, stderr: duplicateResolveLstBatchCli.stderr },
    );
    const oneIdResolveLstBatchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "resolve-lst-batch",
        "--pvf", fixturePath,
        "--lst", "quest",
        "--id", "350",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    add(
      "cli-resolve-lst-batch-single-id-stops-before-open",
      oneIdResolveLstBatchCli.status === 1 &&
        /requires at least two --id values/i.test(oneIdResolveLstBatchCli.stderr || "") &&
        sha256File(fixturePath) === sourceSha,
      { status: oneIdResolveLstBatchCli.status, stderr: oneIdResolveLstBatchCli.stderr },
    );
    const fingerprintCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "fingerprint",
        "--pvf", fixturePath,
        "--pvf", twFixturePath,
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let fingerprintResult = null;
    try { fingerprintResult = JSON.parse(fingerprintCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-fingerprint-hashes-multiple-sources-without-backend-or-help",
      fingerprintCli.status === 0 &&
        fingerprintResult?.result?.requestedCount === 2 &&
        fingerprintResult?.result?.completedCount === 2 &&
        fingerprintResult?.result?.hashAlgorithm === "SHA256" &&
        fingerprintResult?.result?.fullFileHash === true &&
        fingerprintResult?.result?.items?.[0]?.sourcePvfSha256 === sourceSha &&
        fingerprintResult?.result?.items?.[1]?.sourcePvfSha256 === twSourceSha &&
        fingerprintResult?.result?.items?.every((item) => item.stableDuringFingerprint === true) &&
        fingerprintResult?.agentHandoff?.repeatExactCommandAtFinalVerification === true &&
        fingerprintResult?.agentHandoff?.beforeAfterProofRequiresTwoMatchingCommandResults === true &&
        fingerprintResult?.agentHandoff?.baselineMustPrecedeFirstPvfChange === true &&
        fingerprintResult?.agentHandoff?.baselineTimingMustBeCheckedAgainstCommandOrder === true &&
        fingerprintResult?.agentHandoff?.firstFingerprintAfterAnyPvfChangeCannotProveStartingState === true &&
        fingerprintResult?.agentHandoff?.additionalHashCommandRequired === false &&
        fingerprintResult?.agentHandoff?.helpProbeRequired === false,
      fingerprintResult || { stderr: fingerprintCli.stderr },
    );
    const duplicateFingerprintCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "fingerprint",
        "--pvf", fixturePath,
        "--pvf", fixturePath,
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    add(
      "cli-fingerprint-duplicate-source-stops-before-hashing",
      duplicateFingerprintCli.status === 1 &&
        /same PVF more than once/i.test(duplicateFingerprintCli.stderr || "") &&
        sha256File(fixturePath) === sourceSha,
      { status: duplicateFingerprintCli.status, stderr: duplicateFingerprintCli.stderr },
    );
    const chineseMisroutedSearchCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "search-script",
        "--pvf", cnFixturePath,
        "--encoding", "Tw",
        "--pvf-encoding", "Cn",
        "--keyword", "不存在的中文实体",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let chineseMisroutedSearchResult = null;
    try { chineseMisroutedSearchResult = JSON.parse(chineseMisroutedSearchCli.stdout || "null"); } catch { /* assertion below */ }
    add(
      "cli-chinese-search-script-zero-routes-to-name-search-once",
      chineseMisroutedSearchCli.status === 0 &&
        chineseMisroutedSearchResult?.result?.matchedCount === 0 &&
        chineseMisroutedSearchResult?.agentHandoff?.naturalLanguageNameSearchRequired === true &&
        chineseMisroutedSearchResult?.agentHandoff?.repeatSimplifiedTraditionalScriptSearchRequired === false &&
        chineseMisroutedSearchResult?.agentHandoff?.nextCommandOnly?.includes("pvf-read search") &&
        chineseMisroutedSearchResult?.agentHandoff?.nextCommandOnly?.includes("不存在的中文实体"),
      chineseMisroutedSearchCli.status === 0 ? undefined : { stderr: chineseMisroutedSearchCli.stderr },
    );
    const rawReadCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "read",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--path", "itemshop/test.shp",
        "--raw",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let rawReadResult = null;
    try {
      rawReadResult = JSON.parse(rawReadCli.stdout || "null");
    } catch {
      // The assertion below records malformed CLI output without hiding it.
    }
    add(
      "cli-raw-read-uses-change-set-canonical-layout",
      rawReadCli.status === 0 &&
        (rawReadResult?.result?.textContent || "").includes("[value]\r\n10") &&
        rawReadResult?.textUsage?.mode === "canonical-change-source" &&
        rawReadResult?.textUsage?.safeForChangeSetSource === true &&
        rawReadResult?.textUsage?.canonicalTokenLayout === true &&
        rawReadResult?.textUsage?.automaticEncodingSelection === undefined &&
        rawReadResult?.agentHandoff?.changeSetFormatExamples?.linkedVerifiedTextAndParameters ===
          "workspaces/examples/change-set.verified-cn-text.example.json" &&
        rawReadResult?.agentHandoff?.changeSetFormatExamples?.exactHomomorphicBlockScope ===
          "workspaces/examples/change-set.exact-scope.example.json" &&
        rawReadResult?.agentHandoff?.changeSetFormatExamples?.cumulativeSecondRound ===
          "workspaces/examples/change-set.cumulative-second-round.example.json" &&
        rawReadResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineCommandOnly?.includes("pvf-read fingerprint") &&
        rawReadResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineMustBeNextWorkbenchCommandAfterRequiredFirstCommand === true &&
        rawReadResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineMustRunBeforeFirstPvfChange === true &&
        rawReadResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.baselineIsInvalidIfFirstRunAfterAnyPvfChange === true &&
        rawReadResult?.agentHandoff?.sourceIdentityWhenExplicitlyRequired?.finalOnlyFingerprintProvesUnchanged === false &&
        rawReadResult?.agentHandoff?.writeCapabilityPreflight?.checkBeforeValidateRequired === false &&
        rawReadResult?.agentHandoff?.writeCapabilityPreflight?.runCheckOnlyAfterExplicitReadOnlyFallbackOrUnavailableCommand === true &&
        rawReadResult?.agentHandoff?.schemaLookupRequired === false &&
        rawReadResult?.agentHandoff?.examplesDirectoryScanRequired === false &&
        rawReadResult?.agentHandoff?.helpProbeRequired === false,
      rawReadCli.status === 0 ? { result: rawReadResult } : { stderr: rawReadCli.stderr },
    );

    const autoTwRawReadCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "read",
        "--pvf", twFixturePath,
        "--encoding", "Tw",
        "--path", "itemshop/test.shp",
        "--raw",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let autoTwRawReadResult = null;
    try {
      autoTwRawReadResult = JSON.parse(autoTwRawReadCli.stdout || "null");
    } catch {
      // The assertion below records malformed CLI output without hiding it.
    }
    add(
      "cli-raw-read-auto-selects-clearly-cleaner-tw-encoding",
      autoTwRawReadCli.status === 0 &&
        /\[name\]\s*`太陽`/u.test(autoTwRawReadResult?.result?.textContent || "") &&
        autoTwRawReadResult?.textUsage?.safeForChangeSetSource === true &&
        autoTwRawReadResult?.textUsage?.selectedEncodings?.[0] === "Tw" &&
        autoTwRawReadResult?.textUsage?.automaticEncodingSelection?.automatic === true &&
        autoTwRawReadResult?.textUsage?.automaticEncodingSelection?.perFile?.[0]?.requestedEncoding === "Cn" &&
        autoTwRawReadResult?.textUsage?.automaticEncodingSelection?.perFile?.[0]?.selectedEncoding === "Tw",
      autoTwRawReadResult,
    );
    const ordinaryReadCli = childProcess.spawnSync(
      process.execPath,
      [
        path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-readonly.js"),
        "--root", workbenchRoot,
        "read",
        "--pvf", fixturePath,
        "--encoding", "Utf8",
        "--pvf-encoding", "Utf8",
        "--path", "itemshop/test.shp",
      ],
      {
        cwd: workbenchRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PVF_WORKBENCH_BACKEND: "typescript-readonly" },
      },
    );
    let ordinaryReadResult = null;
    try {
      ordinaryReadResult = JSON.parse(ordinaryReadCli.stdout || "null");
    } catch {
      // The assertion below records malformed CLI output without hiding it.
    }
    add(
      "cli-ordinary-read-marked-reader-friendly-not-change-source",
      ordinaryReadCli.status === 0 &&
        ordinaryReadResult?.textUsage?.mode === "reader-friendly-display" &&
        ordinaryReadResult?.textUsage?.safeForChangeSetSource === false &&
        ordinaryReadResult?.textUsage?.requiredActionBeforeChangeSet?.rerunSameTargetWithRaw === true &&
        ordinaryReadResult?.textUsage?.requiredActionBeforeChangeSet?.requiredFlags?.includes("--raw"),
      ordinaryReadCli.status === 0 ? { result: ordinaryReadResult } : { stderr: ordinaryReadCli.stderr },
    );
    const errorSearch = await fallback.searchFiles(fallbackSessionId, { keyword: "not-present", searchType: "SearchScript", matchMode: "Like", pvfEncoding: "Utf8" });
    add(
      "fallback-search-read-errors-visible",
      errorSearch.errorCount === readonlyContract.resourceLimits.maxReportedSearchErrors + 2 &&
        errorSearch.errors.length === readonlyContract.resourceLimits.maxReportedSearchErrors &&
        errorSearch.errorsTruncated === true &&
        errorSearch.errors.some((item) => item.fileName === "raw/corrupt-01.txt" && /checksum/i.test(item.error || "")),
    );
    add(
      "fallback-search-keyword-limit",
      await rejectsCode(
        () => fallback.searchFiles(fallbackSessionId, { keyword: "x".repeat(readonlyContract.resourceLimits.maxSearchKeywordChars + 1), searchType: "SearchFileName" }),
        "READ_ONLY_RESOURCE_LIMIT",
      ),
    );
    const metadata = await fallback.getFileMetadata(fallbackSessionId, "raw/fixture.bin");
    add("fallback-metadata", metadata.dataLength === expectedFiles.get("raw/fixture.bin").length);
    await fallback.releaseMemory(fallbackSessionId);

    const writeOperations = {
      saveSession: () => fallback.saveSession(fallbackSessionId, path.join(tempRoot, "blocked.pvf")),
      upsertFile: () => fallback.upsertFile(fallbackSessionId, "blocked.bin", Buffer.alloc(0)),
      upsertTextFileRaw: () => fallback.upsertTextFileRaw(fallbackSessionId, "blocked.etc", Buffer.alloc(0)),
      deleteEntries: () => fallback.deleteEntries(fallbackSessionId, ["raw/fixture.bin"]),
      renameEntries: () => fallback.renameEntries(fallbackSessionId, []),
      importDirectory: () => fallback.importDirectory(fallbackSessionId, tempRoot),
      extractEntries: () => fallback.extractEntries(fallbackSessionId, ["raw/fixture.bin"], tempRoot),
    };
    add("readonly-contract-blocked-api-closure", sameStringSet(Object.keys(writeOperations), readonlyContract.blockedApiMethods));
    for (const name of readonlyContract.blockedApiMethods) add(`fallback-blocks-${name}`, await rejectsReadonly(writeOperations[name]));
    add("fixture-unchanged", sha256File(fixturePath) === sourceSha && !fs.existsSync(path.join(tempRoot, "blocked.pvf")));

    serverClient = new BackendStdioClient({
      command: process.execPath,
      args: [path.join(__dirname, "../../../tools/pvf-bridge/server.js")],
      cwd: path.resolve(__dirname, "../../.."),
      env: { PVF_WORKBENCH_BACKEND: "typescript-readonly" },
    });
    await serverClient.start();
    const advertisedTools = await serverClient.listTools();
    const advertisedNames = new Set(advertisedTools.map((tool) => tool.name));
    add(
      "server-advertises-readonly-tools-only",
      sameStringSet([...advertisedNames], readonlyContract.advertisedTools) &&
        readonlyContract.blockedTools.every((name) => !advertisedNames.has(name)),
    );
    const initialized = await serverClient.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fallback-self-test", version: "1.0.0" },
    });
    add("server-advertises-readonly-fallback", initialized?.serverInfo?.readOnly === true && initialized?.serverInfo?.backend === "typescript-readonly-fallback");
    const serverOpened = parseBackendTextResult(await serverClient.callTool("pvf_open", { path: fixturePath, encoding: "Utf8" }));
    const serverSessionId = serverOpened?.session?.sessionId;
    add("server-opens-with-fallback", serverOpened?.ok === true && serverOpened?.session?.readOnly === true && Boolean(serverSessionId));
    const serverRead = parseBackendTextResult(await serverClient.callTool("pvf_read_file", {
      sessionId: serverSessionId,
      pvfPath: "itemshop/test.shp",
      pvfEncoding: "Utf8",
      autoConvertStringLink: false,
      convertToSimplifiedChinese: false,
    }));
    add("server-reads-with-fallback", (serverRead?.textContent || "").includes("<0::message_1`只读备用后端`>"));
    const serverResolvedLst = parseBackendTextResult(await serverClient.callTool("pvf_resolve_lst_id", {
      sessionId: serverSessionId,
      lstPath: "itemshop/itemshop.lst",
      id: 1,
      includeFileSummary: false,
      pvfEncoding: "Utf8",
    }));
    add(
      "server-resolves-relative-lst-path",
      serverResolvedLst?.ok === true &&
        serverResolvedLst?.found === true &&
        serverResolvedLst?.entry?.pvfPath === "itemshop/test.shp",
    );
    const serverResolvedRootLst = parseBackendTextResult(await serverClient.callTool("pvf_resolve_lst_id", {
      sessionId: serverSessionId,
      lstPath: "n_string.lst",
      id: 0,
      includeFileSummary: false,
      pvfEncoding: "Utf8",
    }));
    add(
      "server-resolves-root-lst-path-without-dot-prefix",
      serverResolvedRootLst?.ok === true &&
        serverResolvedRootLst?.found === true &&
        serverResolvedRootLst?.entry?.pvfPath === "stringview/fixture.str",
    );
    const serverSearch = parseBackendTextResult(await serverClient.callTool("pvf_search", {
      sessionId: serverSessionId,
      keyword: "not-present",
      searchType: "SearchScript",
      matchMode: "Like",
      pvfEncoding: "Utf8",
      limit: 10,
    }));
    add(
      "server-search-read-errors-visible",
      serverSearch?.ok === true &&
        serverSearch?.truncated === false &&
        serverSearch?.errorCount === readonlyContract.resourceLimits.maxReportedSearchErrors + 2 &&
        serverSearch?.errors?.length === readonlyContract.resourceLimits.maxReportedSearchErrors &&
        serverSearch?.errorsTruncated === true &&
        serverSearch?.errors?.some((item) => item.fileName === "raw/corrupt-01.txt" && /checksum/i.test(item.error || "")),
    );
    const serverTruncatedSearch = parseBackendTextResult(await serverClient.callTool("pvf_search", {
      sessionId: serverSessionId,
      keyword: "bulk/",
      searchType: "SearchFileName",
      matchMode: "Like",
      limit: 1,
    }));
    add(
      "server-search-truncation-visible",
      serverTruncatedSearch?.ok === true &&
        serverTruncatedSearch?.matchedCount === 3 &&
        serverTruncatedSearch?.returnedCount === 1 &&
        serverTruncatedSearch?.truncated === true,
    );
    const serverDryRun = parseBackendTextResult(await serverClient.callTool("pvf_replace_text", {
      sessionId: serverSessionId,
      pvfPath: "itemshop/test.shp",
      previousText: "fallback-fixture",
      newText: "fallback-preview",
      dryRun: true,
      pvfEncoding: "Utf8",
    }));
    add("server-allows-readonly-replace-preview", serverDryRun?.ok === true && serverDryRun?.dryRun === true && sha256File(fixturePath) === sourceSha);

    const blockedServerCalls = {
      pvf_backup: { path: fixturePath, targetPath: path.join(tempRoot, "server-blocked.bak") },
      pvf_replace_text: { sessionId: serverSessionId, pvfPath: "itemshop/test.shp", previousText: "fallback-fixture", newText: "blocked" },
      pvf_write_file: { sessionId: serverSessionId, pvfPath: "blocked.etc", textContent: "blocked" },
      pvf_save: { sessionId: serverSessionId, targetPath: path.join(tempRoot, "server-blocked.pvf") },
    };
    add("readonly-contract-blocked-tool-closure", sameStringSet(Object.keys(blockedServerCalls), readonlyContract.blockedTools));
    for (const name of readonlyContract.blockedTools) {
      const args = blockedServerCalls[name];
      const blocked = parseBackendTextResult(await serverClient.callTool(name, args));
      add(`server-blocks-${name}`, blocked?.data?.code === "READ_ONLY_FALLBACK" && /read-only/i.test(blocked?.error || ""));
    }
    add(
      "server-write-created-no-output",
      !fs.existsSync(path.join(tempRoot, "server-blocked.pvf")) &&
        !fs.existsSync(path.join(tempRoot, "server-blocked.bak")) &&
        sha256File(fixturePath) === sourceSha,
    );

    try {
      const native = loadPvfBackend({ mode: "native" }).api;
      nativeAvailable = true;
      const nativeOpened = await native.openSession(fixturePath, "Utf8");
      nativeSessionId = nativeOpened.sessionId || nativeOpened;
      const nativeListed = await native.listFiles(nativeSessionId);
      const nativeRaw = await native.readFile(nativeSessionId, "itemshop/test.shp", {
        decompileScript: false,
        decompileBinaryAni: false,
        autoConvertStringLink: false,
        convertToSimplifiedChinese: false,
        pvfEncoding: "Utf8",
      });
      add("native-independent-fixture-read", nativeListed.length === expectedFiles.size && Buffer.from(nativeRaw.base64Content || "", "base64").equals(expectedFiles.get("itemshop/test.shp")));

      nativeServerClient = new BackendStdioClient({
        command: process.execPath,
        args: [path.join(__dirname, "../../../tools/pvf-bridge/server.js")],
        cwd: workbenchRoot,
        env: { PVF_WORKBENCH_BACKEND: "native" },
      });
      const ordinaryTools = await nativeServerClient.listTools();
      const ordinaryToolNames = new Set(ordinaryTools.map((tool) => tool.name));
      add(
        "native-server-defaults-to-readonly-capability",
        readonlyContract.blockedTools.every((name) => !ordinaryToolNames.has(name)),
      );
      const ordinaryOpened = parseBackendTextResult(await nativeServerClient.callTool("pvf_open", { path: fixturePath, encoding: "Utf8" }));
      const ordinarySessionId = ordinaryOpened?.session?.sessionId;
      const ordinaryOutput = path.join(tempRoot, "ordinary-server-blocked.pvf");
      const ordinarySave = parseBackendTextResult(await nativeServerClient.callTool("pvf_save", {
        sessionId: ordinarySessionId,
        targetPath: ordinaryOutput,
      }));
      add(
        "native-server-default-blocks-direct-save",
        ordinarySave?.data?.code === "CONTROLLED_WRITE_CAPABILITY_REQUIRED" &&
          !fs.existsSync(ordinaryOutput) &&
          sha256File(fixturePath) === sourceSha,
      );
      await nativeServerClient.callTool("pvf_close", { sessionId: ordinarySessionId });

      const semanticOpened = parseBackendTextResult(await nativeServerClient.callTool("pvf_open", {
        path: cnFixturePath,
        encoding: "Tw",
      }));
      const semanticSessionId = semanticOpened?.session?.sessionId;
      const semanticStrRead = parseBackendTextResult(await nativeServerClient.callTool("pvf_read_file", {
        sessionId: semanticSessionId,
        pvfPath: "stringview/fixture.str",
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      }));
      const semanticScriptRead = parseBackendTextResult(await nativeServerClient.callTool("pvf_read_file", {
        sessionId: semanticSessionId,
        pvfPath: "itemshop/test.shp",
        pvfEncoding: "Cn",
        autoConvertStringLink: false,
        convertToSimplifiedChinese: false,
      }));
      const semanticSearch = parseBackendTextResult(await nativeServerClient.callTool("pvf_search", {
        sessionId: semanticSessionId,
        keyword: "中文保护",
        searchPath: "itemshop",
        searchType: "SearchScript",
        matchMode: "Like",
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
        limit: 10,
      }));
      add(
        "native-server-automatic-cn-semantic-guard",
        (semanticStrRead?.textContent || "").includes("中文保护") &&
          semanticStrRead?.semanticReadGuard?.reason === "cn-localization-file" &&
          (semanticScriptRead?.textContent || "").includes("<0::message_1`中文保护`>") &&
          semanticScriptRead?.semanticReadGuard?.reason === "cn-stringlink-detected" &&
          semanticSearch?.items?.some((item) => item.fileName === "itemshop/test.shp") &&
          semanticSearch?.semanticReadGuard?.reason === "cn-semantic-search" &&
          sha256File(cnFixturePath) === cnSourceSha,
      );
      await nativeServerClient.callTool("pvf_close", { sessionId: semanticSessionId });
      nativeServerClient.stop();
      nativeServerClient = null;

      controlledServerClient = new BackendStdioClient({
        command: process.execPath,
        args: [path.join(__dirname, "../../../tools/pvf-bridge/server.js")],
        cwd: workbenchRoot,
        env: {
          PVF_WORKBENCH_BACKEND: "native",
          PVF_WORKBENCH_SERVER_MODE: "controlled-write",
        },
      });
      const controlledTools = await controlledServerClient.listTools();
      const controlledToolNames = new Set(controlledTools.map((tool) => tool.name));
      add(
        "controlled-server-advertises-write-tools",
        ["pvf_replace_text", "pvf_apply_text_plan", "pvf_apply_verified_text_plan", "pvf_write_file", "pvf_save"].every((name) => controlledToolNames.has(name)) &&
          !controlledToolNames.has("pvf_backup"),
      );
      const deprecatedBackup = parseBackendTextResult(await controlledServerClient.callTool("pvf_backup", {
        path: fixturePath,
        targetPath: path.join(tempRoot, "controlled-deprecated-backup.pvf"),
      }));
      add(
        "controlled-server-rejects-retired-standalone-backup-tool",
        deprecatedBackup?.data?.code === "BACKUP_TOOL_DEPRECATED" &&
          !fs.existsSync(path.join(tempRoot, "controlled-deprecated-backup.pvf")),
      );
      const controlledOpened = parseBackendTextResult(await controlledServerClient.callTool("pvf_open", { path: fixturePath, encoding: "Utf8" }));
      const controlledSessionId = controlledOpened?.session?.sessionId;
      const sourceOverwrite = parseBackendTextResult(await controlledServerClient.callTool("pvf_save", {
        sessionId: controlledSessionId,
        targetPath: fixturePath,
        allowOverwriteSource: true,
      }));
      add(
        "controlled-server-blocks-explicit-source-overwrite",
        sourceOverwrite?.data?.code === "SOURCE_PVF_OVERWRITE_BLOCKED" && sha256File(fixturePath) === sourceSha,
      );
      const controlledOutput = path.join(tempRoot, "controlled-output.pvf");
      const controlledSave = parseBackendTextResult(await controlledServerClient.callTool("pvf_save", {
        sessionId: controlledSessionId,
        targetPath: controlledOutput,
        allowOverwriteSource: false,
      }));
      const repeatedSave = parseBackendTextResult(await controlledServerClient.callTool("pvf_save", {
        sessionId: controlledSessionId,
        targetPath: controlledOutput,
        allowOverwriteSource: false,
      }));
      add(
        "controlled-server-saves-new-output-only",
        controlledSave?.ok === true &&
          fs.existsSync(controlledOutput) &&
          repeatedSave?.data?.code === "OUTPUT_PVF_ALREADY_EXISTS" &&
          sha256File(fixturePath) === sourceSha,
      );
      await controlledServerClient.callTool("pvf_close", { sessionId: controlledSessionId });

      const controlledPlanOpened = parseBackendTextResult(await controlledServerClient.callTool("pvf_open", {
        path: fixturePath,
        encoding: "Utf8",
      }));
      const controlledPlanSessionId = controlledPlanOpened?.session?.sessionId;
      const controlledCanonicalRead = parseBackendTextResult(await controlledServerClient.callTool("pvf_read_file", {
        sessionId: controlledPlanSessionId,
        pvfPath: "itemshop/test.shp",
        pvfEncoding: "Utf8",
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
      }));
      const canonicalParameterBlock = "[value]\r\n10";
      const controlledCanonicalPlan = parseBackendTextResult(await controlledServerClient.callTool("pvf_apply_text_plan", {
        sessionId: controlledPlanSessionId,
        pvfPath: "itemshop/test.shp",
        pvfEncoding: "Utf8",
        dryRun: true,
        changes: [{
          id: "canonical-parameter-layout",
          previousText: canonicalParameterBlock,
          newText: "[value]\r\n11",
          replaceAll: false,
          expectedOccurrences: 1,
        }],
      }));
      add(
        "controlled-plan-reuses-independent-canonical-layout",
        (controlledCanonicalRead?.textContent || "").includes(canonicalParameterBlock) &&
          controlledCanonicalRead?.semanticReadGuard?.reason === "verified-text-readback" &&
          controlledCanonicalPlan?.ok === true &&
          controlledCanonicalPlan?.results?.[0]?.occurrenceCount === 1 &&
          controlledCanonicalPlan?.results?.[0]?.exactIndependentTextReadback === true,
        controlledCanonicalPlan?.ok === true ? undefined : {
          canonicalRead: controlledCanonicalRead,
          canonicalPlan: controlledCanonicalPlan,
        },
      );

      const controlledRegistryRead = parseBackendTextResult(await controlledServerClient.callTool("pvf_read_file", {
        sessionId: controlledPlanSessionId,
        pvfPath: "itemshop/itemshop.lst",
        pvfEncoding: "Utf8",
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
      }));
      const controlledRegistryText = String(controlledRegistryRead?.textContent || "");
      const controlledRegistryRow = controlledRegistryText
        .match(/(?:^|\r?\n)(-?\d+[\t ]+`test\.shp`[\t ]*)(?=\r?\n|$)/u)?.[1] || "";
      const controlledRegistryNewline = controlledRegistryText.includes("\r\n") ? "\r\n" : "\n";
      const controlledRegistryProof = {
        mode: "registry-lifecycle",
        allowExistingRegistryEdit: true,
        registry: {
          lstPath: "itemshop/itemshop.lst",
          id: 2,
          expectedPvfPath: "itemshop/new.shp",
          action: "add",
        },
      };
      const controlledRegistryRewrite = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledPlanSessionId,
        pvfPath: "itemshop/itemshop.lst",
        previousText: controlledRegistryRow,
        newText: `99\t\`rewritten.shp\`${controlledRegistryNewline}2\t\`new.shp\``,
        replaceAll: false,
        expectedOccurrences: 1,
        dryRun: false,
        pvfEncoding: "Utf8",
        convertToSimplifiedChinese: false,
        writeProof: controlledRegistryProof,
      }));
      const controlledRegistryMisroute = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledPlanSessionId,
        pvfPath: "itemshop/test.shp",
        previousText: "fallback-fixture",
        newText: "fallback-preview",
        replaceAll: false,
        expectedOccurrences: 1,
        dryRun: false,
        pvfEncoding: "Utf8",
        convertToSimplifiedChinese: false,
        writeProof: {
          ...controlledRegistryProof,
          registry: { ...controlledRegistryProof.registry, lstPath: "itemshop/test.shp" },
        },
      }));
      const controlledRegistryAdd = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledPlanSessionId,
        pvfPath: "itemshop/itemshop.lst",
        previousText: controlledRegistryRow,
        newText: `${controlledRegistryRow}${controlledRegistryNewline}2\t\`new.shp\``,
        replaceAll: false,
        expectedOccurrences: 1,
        dryRun: false,
        pvfEncoding: "Utf8",
        convertToSimplifiedChinese: false,
        writeProof: controlledRegistryProof,
      }));
      add(
        "controlled-single-registry-route-is-add-only",
        controlledRegistryRow.length > 0 &&
          controlledRegistryRewrite?.data?.code === "REGISTRY_LIFECYCLE_NOT_ADD_ONLY" &&
          controlledRegistryMisroute?.data?.code === "REGISTRY_PLAN_SHAPE_INVALID" &&
          controlledRegistryAdd?.ok === true &&
          controlledRegistryAdd?.writeProof?.id === 2 &&
          controlledRegistryAdd?.proof?.mode === "registry-lifecycle" &&
          controlledRegistryAdd?.proof?.addOnly === true &&
          controlledRegistryAdd?.proof?.transitionProof?.ok === true &&
          sha256File(fixturePath) === sourceSha,
        {
          registryRead: controlledRegistryRead,
          rewrite: controlledRegistryRewrite,
          misroute: controlledRegistryMisroute,
          add: controlledRegistryAdd,
        },
      );
      await controlledServerClient.callTool("pvf_close", { sessionId: controlledPlanSessionId });

      const controlledCnOpened = parseBackendTextResult(await controlledServerClient.callTool("pvf_open", {
        path: cnFixturePath,
        encoding: "Tw",
      }));
      const controlledCnSessionId = controlledCnOpened?.session?.sessionId;
      const controlledCnStrReplace = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledCnSessionId,
        pvfPath: "stringview/fixture.str",
        previousText: "中文保护",
        newText: "中文保护已验证",
        dryRun: false,
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      }));
      const controlledCnScriptReplace = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledCnSessionId,
        pvfPath: "itemshop/test.shp",
        previousText: "fallback-fixture",
        newText: "fallback-fixture-checked",
        dryRun: true,
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      }));
      const controlledDirectChineseReplace = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledCnSessionId,
        pvfPath: "itemshop/test.shp",
        previousText: "`fallback-fixture`",
        newText: "`中文直写`",
        dryRun: false,
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      }));
      const controlledVerifiedChineseReplace = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledCnSessionId,
        pvfPath: "itemshop/test.shp",
        previousText: "`fallback-fixture`",
        newText: "`中文直写`",
        replaceAll: false,
        dryRun: false,
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
        textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
      }));
      const controlledProtectedFileCreate = parseBackendTextResult(await controlledServerClient.callTool("pvf_write_file", {
        sessionId: controlledCnSessionId,
        pvfPath: "new/blocked.lst",
        textContent: "#PVF_File\r\n",
        pvfEncoding: "Tw",
      }));
      const controlledProtectedWorldmapCreate = parseBackendTextResult(await controlledServerClient.callTool("pvf_write_file", {
        sessionId: controlledCnSessionId,
        pvfPath: "worldmap/blocked.wdm",
        textContent: "#PVF_File\r\n[map image]\r\n`WorldMap/Towers.img`\t0\r\n",
        pvfEncoding: "Tw",
      }));
      const controlledCnOutput = path.join(tempRoot, "controlled-cn-output.pvf");
      const controlledCnSave = parseBackendTextResult(await controlledServerClient.callTool("pvf_save", {
        sessionId: controlledCnSessionId,
        targetPath: controlledCnOutput,
      }));
      await controlledServerClient.callTool("pvf_close", { sessionId: controlledCnSessionId });

      const controlledCnReadbackOpened = parseBackendTextResult(await controlledServerClient.callTool("pvf_open", {
        path: controlledCnOutput,
        encoding: "Tw",
      }));
      const controlledCnReadbackSessionId = controlledCnReadbackOpened?.session?.sessionId;
      const controlledCnStrReadback = parseBackendTextResult(await controlledServerClient.callTool("pvf_read_file", {
        sessionId: controlledCnReadbackSessionId,
        pvfPath: "stringview/fixture.str",
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      }));
      const controlledCnScriptReadback = parseBackendTextResult(await controlledServerClient.callTool("pvf_read_file", {
        sessionId: controlledCnReadbackSessionId,
        pvfPath: "itemshop/test.shp",
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
        autoConvertStringLink: false,
        semanticVerificationRead: true,
      }));
      const controlledCnWriteOk =
        controlledCnStrReplace?.data?.code === "CN_LOCALIZATION_WRITE_UNVERIFIED" &&
        controlledCnScriptReplace?.ok === true &&
        controlledCnScriptReplace?.semanticReadGuard?.reason === "verified-text-readback" &&
        controlledDirectChineseReplace?.data?.code === "NON_ASCII_TEXT_WRITE_UNVERIFIED" &&
        controlledProtectedFileCreate?.data?.code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED" &&
        controlledProtectedWorldmapCreate?.data?.code === "PROTECTED_FILE_TYPE_WRITE_BLOCKED" &&
        (controlledProtectedWorldmapCreate?.error || "").includes("worldmap.lst") &&
        controlledVerifiedChineseReplace?.ok === true &&
        controlledVerifiedChineseReplace?.writeResult?.proof?.existingStringEntriesPreserved === true &&
        controlledCnSave?.ok === true &&
        (controlledCnStrReadback?.textContent || "").includes("中文保护") &&
        !(controlledCnStrReadback?.textContent || "").includes("已验证") &&
        (controlledCnScriptReadback?.textContent || "").includes("`中文直写`") &&
        !(controlledCnScriptReadback?.textContent || "").includes("&#") &&
        (controlledCnScriptReadback?.textContent || "").includes("<0::message_1`中文保护`>") &&
        controlledCnScriptReadback?.semanticReadGuard?.reason === "verified-text-readback" &&
        controlledCnScriptReadback?.semanticReadGuard?.backend === "typescript-readonly-fallback" &&
        sha256File(cnFixturePath) === cnSourceSha;
      add(
        "controlled-server-preserves-cn-semantics-on-write",
        controlledCnWriteOk,
        controlledCnWriteOk ? undefined : {
          strReplace: controlledCnStrReplace,
          scriptReplace: controlledCnScriptReplace,
          directChineseReplace: controlledDirectChineseReplace,
          protectedFileCreate: controlledProtectedFileCreate,
          protectedWorldmapCreate: controlledProtectedWorldmapCreate,
          verifiedChineseReplace: controlledVerifiedChineseReplace,
          save: controlledCnSave,
          strReadbackText: controlledCnStrReadback?.textContent,
          scriptReadbackText: controlledCnScriptReadback?.textContent,
          sourceUnchanged: sha256File(cnFixturePath) === cnSourceSha,
        },
      );
      await controlledServerClient.callTool("pvf_close", { sessionId: controlledCnReadbackSessionId });
      controlledServerClient.stop();
      controlledServerClient = null;

      const changeSetFile = path.join(tempRoot, "verified-inline-cn-change-set.json");
      const dryRunRoot = path.join(tempRoot, "verified-inline-cn-dry-run");
      const applyRoot = path.join(tempRoot, "verified-inline-cn-apply");
      const reuseApplyRoot = path.join(tempRoot, "verified-inline-cn-apply-reuse");
      fs.writeFileSync(changeSetFile, `${JSON.stringify({
        schemaVersion: "1.0",
        mode: "dry-run-only",
        description: "Fallback regression fixture for verified inline Chinese text.",
        target: {
          sourcePvf: cnFixturePath,
          pvfOpenEncoding: "Tw",
          pvfReadEncoding: "Cn",
        },
        changes: [
          {
            id: "ascii-numeric-input-first",
            type: "replace-text",
            pvfPath: "etc/numeric.etc",
            previousText: "10",
            newText: "11",
            replaceAll: false,
            pvfEncoding: "Cn",
          },
          {
            id: "worldmap-wdm-dungeon-list-extension",
            type: "replace-text",
            pvfPath: "worldmap/towers.wdm",
            previousText: "11000\t-1\t11001\t-1\t323\t-1",
            newText: "11000\t-1\t11001\t-1\t323\t-1\t120\t-1\t121\t-1",
            replaceAll: false,
            pvfEncoding: "Cn",
          },
          {
            id: "verified-cn-name",
            type: "replace-text",
            pvfPath: "itemshop/test.shp",
            previousText: "`fallback-fixture`",
            newText: "`中文端到端`",
            replaceAll: false,
            textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
            pvfEncoding: "Cn",
          },
          {
            id: "same-file-numeric-after-text-in-change-set",
            type: "replace-text",
            pvfPath: "itemshop/test.shp",
            previousText: "[value]\r\n10",
            newText: "[value]\r\n11",
            replaceAll: false,
            pvfEncoding: "Cn",
          },
          {
            id: "verified-cn-description-same-file-batch",
            type: "replace-text",
            pvfPath: "itemshop/test.shp",
            previousText: "`装备强化增幅`",
            newText: "`批量说明验证`",
            replaceAll: false,
            textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
            pvfEncoding: "Cn",
          },
          {
            id: "verified-cn-description-delete-first",
            type: "replace-text",
            pvfPath: "itemshop/second.shp",
            previousText: "`装备强化增幅`",
            newText: "``",
            replaceAll: false,
            textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
            pvfEncoding: "Cn",
          },
          {
            id: "ordinary-description-delete-after-text",
            type: "replace-text",
            pvfPath: "itemshop/second.shp",
            previousText: "\r\n[description]\r\n``\r\n",
            newText: "",
            replaceAll: false,
            pvfEncoding: "Cn",
          },
          {
            id: "verified-cn-skill-name",
            type: "replace-text",
            pvfPath: "itemshop/second.shp",
            previousText: "`second-fixture`",
            newText: "`中文技能名称`",
            replaceAll: false,
            textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
            pvfEncoding: "Cn",
          },
          {
            id: "scoped-cn-delete-explain-first",
            type: "replace-text",
            pvfPath: "stackable/scoped.stk",
            previousText: "`相同说明`",
            newText: "``",
            scope: {
              startText: "[check]\r\n0\t1\r\n`coat`\r\n",
              endText: "[/check]",
              expectedRanges: 1,
            },
            replaceAll: false,
            textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
            pvfEncoding: "Cn",
          },
          {
            id: "scoped-delete-structure-second",
            type: "replace-text",
            pvfPath: "stackable/scoped.stk",
            previousText: "[skill]\r\n0\t7\r\n\r\n[explain]\r\n``\r\n\r\n",
            newText: "",
            scope: {
              startText: "[check]\r\n0\t1\r\n`coat`\r\n",
              endText: "[/check]",
              expectedRanges: 1,
            },
            replaceAll: false,
            pvfEncoding: "Cn",
          },
          {
            id: "scoped-renumber-third",
            type: "replace-text",
            pvfPath: "stackable/scoped.stk",
            previousText: "[skill]\r\n1\t8\r\n",
            newText: "[skill]\r\n0\t8\r\n",
            scope: {
              startText: "[check]\r\n0\t1\r\n`coat`\r\n",
              endText: "[/check]",
              expectedRanges: 1,
            },
            replaceAll: false,
            pvfEncoding: "Cn",
          },
        ],
        safety: {
          writeModeEnabled: false,
          requiresBackupBeforeApply: true,
          requiresExplicitOutputPath: true,
          requiresReadback: true,
        },
      }, null, 2)}\n`, "utf8");
      const pvfChangeCli = path.join(workbenchRoot, "core", "pvf-agent-core", "cli", "pvf-change-set.js");
      const cliEnv = { ...process.env, PVF_WORKBENCH_BACKEND: "native" };
      const dryRunProcess = childProcess.spawnSync(process.execPath, [
        pvfChangeCli,
        "--root", workbenchRoot,
        "dry-run",
        "--file", changeSetFile,
        "--out", dryRunRoot,
      ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv });
      let dryRunResult = null;
      try { dryRunResult = JSON.parse(dryRunProcess.stdout || "null"); } catch { /* recorded below */ }
      const dryRunManifest = dryRunResult?.manifestPath && fs.existsSync(dryRunResult.manifestPath)
        ? JSON.parse(fs.readFileSync(dryRunResult.manifestPath, "utf8"))
        : null;
      const applyProcess = dryRunProcess.status === 0 && dryRunResult?.approvalCode
        ? childProcess.spawnSync(process.execPath, [
          pvfChangeCli,
          "--root", workbenchRoot,
          "apply",
          "--file", changeSetFile,
          "--dry-run-manifest", dryRunResult.manifestPath,
          "--authorize-apply", dryRunResult.approvalCode,
          "--out", applyRoot,
        ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv })
        : null;
      let applyResult = null;
      try { applyResult = JSON.parse(applyProcess?.stdout || "null"); } catch { /* recorded below */ }
      const applyManifest = applyResult?.manifestPath && fs.existsSync(applyResult.manifestPath)
        ? JSON.parse(fs.readFileSync(applyResult.manifestPath, "utf8"))
        : null;
      const reuseApplyProcess = applyProcess?.status === 0
        ? childProcess.spawnSync(process.execPath, [
          pvfChangeCli,
          "--root", workbenchRoot,
          "apply",
          "--file", changeSetFile,
          "--dry-run-manifest", dryRunResult.manifestPath,
          "--authorize-apply", dryRunResult.approvalCode,
          "--out", reuseApplyRoot,
        ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv })
        : null;
      let reuseApplyResult = null;
      try { reuseApplyResult = JSON.parse(reuseApplyProcess?.stdout || "null"); } catch { /* recorded below */ }
      const reuseApplyManifest = reuseApplyResult?.manifestPath && fs.existsSync(reuseApplyResult.manifestPath)
        ? JSON.parse(fs.readFileSync(reuseApplyResult.manifestPath, "utf8"))
        : null;
      let endToEndText = null;
      let endToEndSkillText = null;
      let endToEndNumericText = null;
      let endToEndScopedText = null;
      let endToEndWdmText = null;
      let endToEndGuard = null;
      if (applyManifest?.outputPvf && fs.existsSync(applyManifest.outputPvf)) {
        const endToEndOpened = await fallback.openSession(applyManifest.outputPvf, "Tw");
        try {
          const endToEndRead = await fallback.readFile(endToEndOpened.sessionId, "itemshop/test.shp", {
            pvfEncoding: "Cn",
            autoConvertStringLink: false,
          });
          endToEndText = endToEndRead.textContent;
          const endToEndSkillRead = await fallback.readFile(endToEndOpened.sessionId, "itemshop/second.shp", {
            pvfEncoding: "Cn",
            autoConvertStringLink: false,
          });
          endToEndSkillText = endToEndSkillRead.textContent;
          const endToEndNumericRead = await fallback.readFile(endToEndOpened.sessionId, "etc/numeric.etc", {
            pvfEncoding: "Cn",
            autoConvertStringLink: false,
          });
          endToEndNumericText = endToEndNumericRead.textContent;
          const endToEndScopedRead = await fallback.readFile(endToEndOpened.sessionId, "stackable/scoped.stk", {
            pvfEncoding: "Cn",
            autoConvertStringLink: false,
          });
          endToEndScopedText = endToEndScopedRead.textContent;
          const endToEndWdmRead = await fallback.readFile(endToEndOpened.sessionId, "worldmap/towers.wdm", {
            pvfEncoding: "Cn",
            autoConvertStringLink: false,
          });
          endToEndWdmText = endToEndWdmRead.textContent;
          endToEndGuard = applyManifest.readback?.find((item) => item.verifiedInlineText)?.semanticReadGuard || null;
        } finally {
          await fallback.closeSession(endToEndOpened.sessionId);
        }
      }
      const scopedPartBlock = (source, part) => {
        const text = String(source || "");
        const partOffset = text.indexOf(`\`${part}\``);
        const startOffset = partOffset < 0 ? -1 : text.lastIndexOf("[check]", partOffset);
        const endMarkerOffset = partOffset < 0 ? -1 : text.indexOf("[/check]", partOffset);
        return startOffset < 0 || endMarkerOffset < 0
          ? null
          : text.slice(startOffset, endMarkerOffset + "[/check]".length);
      };
      const scopedCoatText = scopedPartBlock(endToEndScopedText, "coat");
      const scopedSupportText = scopedPartBlock(endToEndScopedText, "support");
      const scopedRingText = scopedPartBlock(endToEndScopedText, "ring");
      const endToEndOk =
        dryRunProcess.status === 0 &&
        dryRunResult?.summary?.blockedCount === 0 &&
        typeof dryRunResult?.approvalCode === "string" &&
        applyProcess?.status === 0 &&
        applyManifest?.safety?.sourceUnchanged === true &&
        applyManifest?.safety?.verifiedInlineTextRequiresExactIndependentReadback === true &&
        applyManifest?.safety?.sameFileChangesPlannedAsOneFinalText === true &&
        applyManifest?.safety?.sameFileChangeOrderPreservedWhenRequired === true &&
        applyManifest?.safety?.exactRangeScopeAllowed === true &&
        applyManifest?.safety?.scopeBoundaryRewriteAllowed === false &&
        applyManifest?.safety?.scopeEvidenceBoundToDryRunAndApply === true &&
        applyManifest?.safety?.backupContentAddressed === true &&
        applyManifest?.safety?.backupCreatedThisRun === true &&
        applyManifest?.safety?.backupReused === false &&
        applyManifest?.safety?.backupSha256Verified === true &&
        applyManifest?.summary?.changedCount === 11 &&
        applyManifest?.cumulative?.enabled === false &&
        applyManifest?.cumulative?.chainDepth === 0 &&
        applyManifest?.cumulative?.previousChangeCount === 0 &&
        applyManifest?.cumulative?.currentChangeCount === 11 &&
        applyManifest?.cumulative?.totalChangeCount === 11 &&
        applyManifest?.readback?.length === 5 &&
        applyManifest?.readback?.find((item) => item.pvfPath === "itemshop/test.shp")?.changeIds?.length === 3 &&
        applyManifest?.readback?.find((item) => item.pvfPath === "itemshop/second.shp")?.changeIds?.length === 3 &&
        applyManifest?.readback?.find((item) => item.pvfPath === "stackable/scoped.stk")?.changeIds?.length === 3 &&
        applyManifest?.readback?.find((item) => item.pvfPath === "worldmap/towers.wdm")?.changeIds?.length === 1 &&
        applyManifest?.results?.find((item) => item.id === "verified-cn-name")?.applyResult?.batch?.changeCount === 2 &&
        applyManifest?.results?.find((item) => item.id === "scoped-cn-delete-explain-first")?.contextAnchor?.scope?.rangeCount === 1 &&
        typeof applyManifest?.results?.find((item) => item.id === "scoped-cn-delete-explain-first")?.contextAnchor?.scope?.ranges?.[0]?.contentSha256 === "string" &&
        applyManifest.readback.every((item) => item.ok === true) &&
        applyManifest.readback.filter((item) => item.verifiedInlineText).every((item) => item.exactTextOk === true && item.independentSemanticRead === true) &&
        reuseApplyProcess?.status === 0 &&
        reuseApplyManifest?.safety?.sourceUnchanged === true &&
        reuseApplyManifest?.safety?.backupCreatedThisRun === false &&
        reuseApplyManifest?.safety?.backupReused === true &&
        reuseApplyManifest?.safety?.backupSha256Verified === true &&
        reuseApplyManifest?.backupPath === applyManifest?.backupPath &&
        reuseApplyManifest?.readback?.every((item) => item.ok === true) &&
        endToEndGuard?.backend === "typescript-readonly-fallback" &&
        (endToEndText || "").includes("`中文端到端`") &&
        (endToEndText || "").includes("`批量说明验证`") &&
        !(endToEndText || "").includes("&#") &&
        (endToEndText || "").includes("<0::message_1`中文保护`>") &&
        (endToEndText || "").includes("[value]\r\n11") &&
        (endToEndSkillText || "").includes("`中文技能名称`") &&
        !(endToEndSkillText || "").includes("[description]") &&
        !(endToEndSkillText || "").includes("装备强化增幅") &&
        !(endToEndSkillText || "").includes("&#") &&
        scopedCoatText ===
          "[check]\r\n0\t1\r\n`coat`\r\n\r\n[skill]\r\n0\t8\r\n\r\n[explain]\r\n`保留说明`\r\n[/check]" &&
        scopedSupportText ===
          "[check]\r\n0\t1\r\n`support`\r\n\r\n[skill]\r\n0\t7\r\n\r\n[explain]\r\n`相同说明`\r\n\r\n[skill]\r\n1\t8\r\n\r\n[explain]\r\n`保留说明`\r\n[/check]" &&
        scopedRingText ===
          "[check]\r\n0\t1\r\n`ring`\r\n\r\n[skill]\r\n0\t7\r\n\r\n[explain]\r\n`相同说明`\r\n\r\n[skill]\r\n1\t8\r\n\r\n[explain]\r\n`保留说明`\r\n[/check]" &&
        (endToEndWdmText || "").includes("11000\t-1\t11001\t-1\t323\t-1\t120\t-1\t121\t-1") &&
        (endToEndWdmText || "").includes("`亡者峽谷`") &&
        /\b11\b/.test(endToEndNumericText || "") &&
        sha256File(cnFixturePath) === cnSourceSha;
      add("pvf-change-verified-inline-text-cn-end-to-end", endToEndOk, endToEndOk ? undefined : {
        dryRunStatus: dryRunProcess.status,
        dryRunStdout: dryRunProcess.stdout,
        dryRunStderr: dryRunProcess.stderr,
        dryRunManifest,
        applyStatus: applyProcess?.status,
        applyStdout: applyProcess?.stdout,
        applyStderr: applyProcess?.stderr,
        applyManifest,
        reuseApplyStatus: reuseApplyProcess?.status,
        reuseApplyStdout: reuseApplyProcess?.stdout,
        reuseApplyStderr: reuseApplyProcess?.stderr,
        reuseApplyManifest,
        endToEndText,
        endToEndSkillText,
        endToEndNumericText,
        endToEndScopedText,
        endToEndWdmText,
        scopedCoatText,
        scopedSupportText,
        scopedRingText,
        sourceUnchanged: sha256File(cnFixturePath) === cnSourceSha,
      });

      const scopeMismatchChangeSetFile = path.join(tempRoot, "exact-scope-count-mismatch-change-set.json");
      const scopeMismatchDryRunRoot = path.join(tempRoot, "exact-scope-count-mismatch-dry-run");
      fs.writeFileSync(scopeMismatchChangeSetFile, `${JSON.stringify({
        schemaVersion: "1.0",
        mode: "dry-run-only",
        description: "Exact scope count mismatch must withhold authorization.",
        target: { sourcePvf: cnFixturePath, pvfOpenEncoding: "Tw", pvfReadEncoding: "Cn" },
        changes: [{
          id: "scope-count-mismatch",
          type: "replace-text",
          pvfPath: "stackable/scoped.stk",
          previousText: "`相同说明`",
          newText: "`不得写入`",
          scope: {
            startText: "[check]\r\n0\t1\r\n`coat`\r\n",
            endText: "[/check]",
            expectedRanges: 2,
          },
          replaceAll: false,
          textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
          pvfEncoding: "Cn",
        }],
        safety: {
          writeModeEnabled: false,
          requiresBackupBeforeApply: true,
          requiresExplicitOutputPath: true,
          requiresReadback: true,
        },
      }, null, 2)}\n`, "utf8");
      const scopeMismatchDryRun = childProcess.spawnSync(process.execPath, [
        pvfChangeCli, "--root", workbenchRoot, "dry-run", "--file", scopeMismatchChangeSetFile, "--out", scopeMismatchDryRunRoot,
      ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv });
      let scopeMismatchResult = null;
      try { scopeMismatchResult = JSON.parse(scopeMismatchDryRun.stdout || "null"); } catch { /* recorded below */ }
      const scopeMismatchManifest = scopeMismatchResult?.manifestPath && fs.existsSync(scopeMismatchResult.manifestPath)
        ? JSON.parse(fs.readFileSync(scopeMismatchResult.manifestPath, "utf8"))
        : null;
      add(
        "pvf-change-exact-scope-count-mismatch-withholds-approval",
        scopeMismatchDryRun.status === 2 &&
          scopeMismatchResult?.approvalCode === null &&
          scopeMismatchResult?.summary?.blockedCount === 1 &&
          scopeMismatchResult?.blockedChanges?.[0]?.code === "SCOPE_RANGE_COUNT_MISMATCH" &&
          scopeMismatchManifest?.binding?.approvalCode === null &&
          scopeMismatchManifest?.binding?.authorizationWithheld === true &&
          scopeMismatchManifest?.binding?.authorizationWithheldReason === "BLOCKED_DRY_RUN" &&
          sha256File(cnFixturePath) === cnSourceSha,
        scopeMismatchResult,
      );

      const cumulativeChangeSetFile = path.join(tempRoot, "cumulative-second-round-change-set.json");
      const cumulativeDryRunRoot = path.join(tempRoot, "cumulative-second-round-dry-run");
      const cumulativeApplyRoot = path.join(tempRoot, "cumulative-second-round-apply");
      fs.writeFileSync(cumulativeChangeSetFile, `${JSON.stringify({
        schemaVersion: "1.0",
        mode: "dry-run-only",
        description: "Second-round delta that must inherit the first output.",
        baseline: { applyManifest: applyResult?.manifestPath },
        target: {
          sourcePvf: cnFixturePath,
          pvfOpenEncoding: "Tw",
          pvfReadEncoding: "Cn",
        },
        changes: [{
          id: "cumulative-second-round-only",
          type: "replace-text",
          pvfPath: "etc/numeric-sequence.etc",
          previousText: "10",
          newText: "12",
          replaceAll: false,
          pvfEncoding: "Cn",
        }],
        safety: {
          writeModeEnabled: false,
          requiresBackupBeforeApply: true,
          requiresExplicitOutputPath: true,
          requiresReadback: true,
        },
      }, null, 2)}\n`, "utf8");
      const cumulativeDryRunProcess = applyProcess?.status === 0
        ? childProcess.spawnSync(process.execPath, [
          pvfChangeCli, "--root", workbenchRoot, "dry-run", "--file", cumulativeChangeSetFile, "--out", cumulativeDryRunRoot,
        ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv })
        : null;
      let cumulativeDryRunResult = null;
      try { cumulativeDryRunResult = JSON.parse(cumulativeDryRunProcess?.stdout || "null"); } catch { /* recorded below */ }
      const cumulativeApplyProcess = cumulativeDryRunProcess?.status === 0 && cumulativeDryRunResult?.approvalCode
        ? childProcess.spawnSync(process.execPath, [
          pvfChangeCli, "--root", workbenchRoot, "apply", "--file", cumulativeChangeSetFile,
          "--dry-run-manifest", cumulativeDryRunResult.manifestPath,
          "--authorize-apply", cumulativeDryRunResult.approvalCode,
          "--out", cumulativeApplyRoot,
        ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv })
        : null;
      let cumulativeApplyResult = null;
      try { cumulativeApplyResult = JSON.parse(cumulativeApplyProcess?.stdout || "null"); } catch { /* recorded below */ }
      const cumulativeApplyManifest = cumulativeApplyResult?.manifestPath && fs.existsSync(cumulativeApplyResult.manifestPath)
        ? JSON.parse(fs.readFileSync(cumulativeApplyResult.manifestPath, "utf8"))
        : null;
      let cumulativeInheritedText = null;
      let cumulativeSecondRoundText = null;
      if (cumulativeApplyManifest?.outputPvf && fs.existsSync(cumulativeApplyManifest.outputPvf)) {
        const cumulativeOpened = await fallback.openSession(cumulativeApplyManifest.outputPvf, "Tw");
        try {
          cumulativeInheritedText = (await fallback.readFile(cumulativeOpened.sessionId, "itemshop/test.shp", {
            pvfEncoding: "Cn", autoConvertStringLink: false,
          })).textContent;
          cumulativeSecondRoundText = (await fallback.readFile(cumulativeOpened.sessionId, "etc/numeric-sequence.etc", {
            pvfEncoding: "Cn", autoConvertStringLink: false,
          })).textContent;
        } finally {
          await fallback.closeSession(cumulativeOpened.sessionId);
        }
      }
      const cumulativeEndToEndOk =
        cumulativeDryRunProcess?.status === 0 &&
        cumulativeApplyProcess?.status === 0 &&
        cumulativeApplyManifest?.cumulative?.enabled === true &&
        cumulativeApplyManifest?.cumulative?.chainDepth === 1 &&
        cumulativeApplyManifest?.cumulative?.previousChangeCount === 11 &&
        cumulativeApplyManifest?.cumulative?.currentChangeCount === 1 &&
        cumulativeApplyManifest?.cumulative?.totalChangeCount === 12 &&
        typeof cumulativeApplyManifest?.cumulative?.previousApplyManifestSha256 === "string" &&
        cumulativeApplyManifest?.cumulative?.previousApplyManifestSha256 === sha256File(applyResult.manifestPath) &&
        typeof cumulativeDryRunResult?.manifestPath === "string" &&
        (() => {
          const manifest = JSON.parse(fs.readFileSync(cumulativeDryRunResult.manifestPath, "utf8"));
          return typeof manifest.cumulativeBaselineSha256 === "string" &&
            manifest.cumulativeBaselineSha256 === crypto.createHash("sha256")
              .update(JSON.stringify(manifest.cumulativeBaseline))
              .digest("hex");
        })() &&
        cumulativeApplyManifest?.protectedSourcePvf === cnFixturePath &&
        cumulativeApplyManifest?.sourcePvf === applyManifest?.outputPvf &&
        cumulativeApplyManifest?.safety?.sourceUnchanged === true &&
        cumulativeApplyManifest?.safety?.protectedSourceUnchanged === true &&
        (cumulativeInheritedText || "").includes("`中文端到端`") &&
        (cumulativeInheritedText || "").includes("`批量说明验证`") &&
        /\b12\b/.test(cumulativeSecondRoundText || "") &&
        sha256File(cnFixturePath) === cnSourceSha;
      add("pvf-change-cumulative-second-round-preserves-first-round", cumulativeEndToEndOk, cumulativeEndToEndOk ? undefined : {
        dryRunStatus: cumulativeDryRunProcess?.status,
        dryRunStdout: cumulativeDryRunProcess?.stdout,
        dryRunStderr: cumulativeDryRunProcess?.stderr,
        applyStatus: cumulativeApplyProcess?.status,
        applyStdout: cumulativeApplyProcess?.stdout,
        applyStderr: cumulativeApplyProcess?.stderr,
        applyManifest: cumulativeApplyManifest,
        cumulativeInheritedText,
        cumulativeSecondRoundText,
      });

      const twChangeSetFile = path.join(tempRoot, "verified-inline-tw-change-set.json");
      const twDryRunRoot = path.join(tempRoot, "verified-inline-tw-dry-run");
      const twApplyRoot = path.join(tempRoot, "verified-inline-tw-apply");
      fs.writeFileSync(twChangeSetFile, `${JSON.stringify({
        schemaVersion: "1.0",
        mode: "dry-run-only",
        description: "Fallback regression fixture for verified inline Traditional Chinese text.",
        target: {
          sourcePvf: twFixturePath,
          pvfOpenEncoding: "Tw",
          pvfReadEncoding: "Tw",
        },
        changes: [{
          id: "verified-tw-name",
          type: "replace-text",
          pvfPath: "itemshop/test.shp",
          previousText: "`太陽`",
          newText: "`繁體文字驗證`",
          replaceAll: false,
          textWriteMode: VERIFIED_INLINE_TEXT_MODE,
          pvfEncoding: "Tw",
        }],
        safety: {
          writeModeEnabled: false,
          requiresBackupBeforeApply: true,
          requiresExplicitOutputPath: true,
          requiresReadback: true,
        },
      }, null, 2)}\n`, "utf8");
      const twDryRunProcess = childProcess.spawnSync(process.execPath, [
        pvfChangeCli,
        "--root", workbenchRoot,
        "dry-run",
        "--file", twChangeSetFile,
        "--out", twDryRunRoot,
      ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv });
      let twDryRunResult = null;
      try { twDryRunResult = JSON.parse(twDryRunProcess.stdout || "null"); } catch { /* recorded below */ }
      const twApplyProcess = twDryRunProcess.status === 0 && twDryRunResult?.approvalCode
        ? childProcess.spawnSync(process.execPath, [
          pvfChangeCli,
          "--root", workbenchRoot,
          "apply",
          "--file", twChangeSetFile,
          "--dry-run-manifest", twDryRunResult.manifestPath,
          "--authorize-apply", twDryRunResult.approvalCode,
          "--out", twApplyRoot,
        ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv })
        : null;
      let twApplyResult = null;
      try { twApplyResult = JSON.parse(twApplyProcess?.stdout || "null"); } catch { /* recorded below */ }
      const twApplyManifest = twApplyResult?.manifestPath && fs.existsSync(twApplyResult.manifestPath)
        ? JSON.parse(fs.readFileSync(twApplyResult.manifestPath, "utf8"))
        : null;
      let twOutputText = null;
      if (twApplyManifest?.outputPvf && fs.existsSync(twApplyManifest.outputPvf)) {
        const twOutputOpened = await fallback.openSession(twApplyManifest.outputPvf, "Tw");
        try {
          twOutputText = (await fallback.readFile(twOutputOpened.sessionId, "itemshop/test.shp", {
            pvfEncoding: "Tw",
            autoConvertStringLink: false,
          })).textContent;
        } finally {
          await fallback.closeSession(twOutputOpened.sessionId);
        }
      }
      const twEndToEndOk =
        twDryRunProcess.status === 0 &&
        twDryRunResult?.summary?.blockedCount === 0 &&
        twApplyProcess?.status === 0 &&
        twApplyManifest?.safety?.sourceUnchanged === true &&
        twApplyManifest?.summary?.verifiedInlineTextByEncoding?.Tw === 1 &&
        twApplyManifest?.readback?.length === 1 &&
        twApplyManifest.readback[0]?.verifiedInlineText === true &&
        twApplyManifest.readback[0]?.verifiedInlineCn === false &&
        twApplyManifest.readback[0]?.independentSemanticRead === true &&
        twApplyManifest.readback[0]?.semanticReadGuard?.selectedEncoding === "Tw" &&
        /\[name\]\s*`繁體文字驗證`/u.test(twOutputText || "") &&
        sha256File(twFixturePath) === twSourceSha;
      add("pvf-change-verified-inline-text-tw-end-to-end", twEndToEndOk, twEndToEndOk ? undefined : {
        dryRunStatus: twDryRunProcess.status,
        dryRunStdout: twDryRunProcess.stdout,
        dryRunStderr: twDryRunProcess.stderr,
        applyStatus: twApplyProcess?.status,
        applyStdout: twApplyProcess?.stdout,
        applyStderr: twApplyProcess?.stderr,
        applyManifest: twApplyManifest,
        twOutputText,
        sourceUnchanged: sha256File(twFixturePath) === twSourceSha,
      });

      const displayTextMisuseChangeSetFile = path.join(tempRoot, "display-text-misuse-tw-change-set.json");
      fs.writeFileSync(displayTextMisuseChangeSetFile, `${JSON.stringify({
        schemaVersion: "1.0",
        mode: "dry-run-only",
        description: "Reader-friendly simplified display text must be diagnosed and safely blocked.",
        target: {
          sourcePvf: twFixturePath,
          pvfOpenEncoding: "Tw",
          pvfReadEncoding: "Tw",
        },
        changes: [{
          id: "simplified-display-text-is-not-raw-source",
          type: "replace-text",
          pvfPath: "itemshop/test.shp",
          previousText: "`太阳`",
          newText: "`显示文本误用不得写入`",
          replaceAll: false,
          textWriteMode: VERIFIED_INLINE_TEXT_MODE,
          pvfEncoding: "Tw",
        }],
        safety: {
          writeModeEnabled: false,
          requiresBackupBeforeApply: true,
          requiresExplicitOutputPath: true,
          requiresReadback: true,
        },
      }, null, 2)}\n`, "utf8");
      const displayTextMisuseDryRun = childProcess.spawnSync(process.execPath, [
        pvfChangeCli,
        "--root", workbenchRoot,
        "dry-run",
        "--file", displayTextMisuseChangeSetFile,
        "--out", path.join(tempRoot, "display-text-misuse-tw-dry-run"),
      ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv });
      let displayTextMisuseResult = null;
      try { displayTextMisuseResult = JSON.parse(displayTextMisuseDryRun.stdout || "null"); } catch { /* recorded below */ }
      const displayTextMisuseManifest = displayTextMisuseResult?.manifestPath && fs.existsSync(displayTextMisuseResult.manifestPath)
        ? JSON.parse(fs.readFileSync(displayTextMisuseResult.manifestPath, "utf8"))
        : null;
      add(
        "pvf-change-reader-friendly-display-text-zero-match-diagnosed-and-blocked",
        displayTextMisuseDryRun.status === 2 &&
          displayTextMisuseResult?.approvalCode === null &&
          displayTextMisuseResult?.summary?.blockedCount === 1 &&
          displayTextMisuseResult?.blockedChanges?.[0]?.code === "OCCURRENCE_COUNT_MISMATCH" &&
          displayTextMisuseResult?.blockedChanges?.[0]?.diagnosis?.code === "DISPLAY_TEXT_USED_AS_CHANGE_SOURCE" &&
          displayTextMisuseResult?.blockedChanges?.[0]?.diagnosis?.displayOccurrenceCount === 1 &&
          displayTextMisuseResult?.blockedChanges?.[0]?.diagnosis?.recovery?.command === "pvf-read read --raw" &&
          displayTextMisuseResult?.blockedChanges?.[0]?.diagnosis?.recovery?.pvfEncoding === "Tw" &&
          displayTextMisuseResult?.blockedChanges?.[0]?.diagnosis?.automaticRewriteAttempted === false &&
          displayTextMisuseManifest?.binding?.approvalCode === null &&
          displayTextMisuseManifest?.binding?.authorizationWithheld === true &&
          displayTextMisuseManifest?.binding?.authorizationWithheldReason === "BLOCKED_DRY_RUN" &&
          displayTextMisuseManifest?.results?.[0]?.blockDetails?.sourceTextDiagnosis?.code === "DISPLAY_TEXT_USED_AS_CHANGE_SOURCE" &&
          sha256File(twFixturePath) === twSourceSha,
        displayTextMisuseResult,
      );

      const wrongTwReadOpened = await fallback.openSession(twFixturePath, "Tw");
      let wrongTwName = null;
      try {
        const wrongTwRead = await fallback.readFile(wrongTwReadOpened.sessionId, "itemshop/test.shp", {
          pvfEncoding: "Cn",
          autoConvertStringLink: false,
        });
        wrongTwName = /\[name\]\s*`([^`]*)`/u.exec(String(wrongTwRead.textContent || ""))?.[1] || null;
      } finally {
        await fallback.closeSession(wrongTwReadOpened.sessionId);
      }
      const wrongEncodingChangeSetFile = path.join(tempRoot, "wrong-cn-on-tw-change-set.json");
      fs.writeFileSync(wrongEncodingChangeSetFile, `${JSON.stringify({
        schemaVersion: "1.0",
        mode: "dry-run-only",
        description: "A Big5 string misread as GBK must never receive approval.",
        target: { sourcePvf: twFixturePath, pvfOpenEncoding: "Tw", pvfReadEncoding: "Cn" },
        changes: [{
          id: "wrong-cn-on-tw-name",
          type: "replace-text",
          pvfPath: "itemshop/test.shp",
          previousText: `\`${wrongTwName}\``,
          newText: "`中文错误写入`",
          replaceAll: false,
          textWriteMode: VERIFIED_INLINE_CN_TEXT_MODE,
          pvfEncoding: "Cn",
        }],
        safety: {
          writeModeEnabled: false,
          requiresBackupBeforeApply: true,
          requiresExplicitOutputPath: true,
          requiresReadback: true,
        },
      }, null, 2)}\n`, "utf8");
      const wrongEncodingDryRun = childProcess.spawnSync(process.execPath, [
        pvfChangeCli,
        "--root", workbenchRoot,
        "dry-run",
        "--file", wrongEncodingChangeSetFile,
        "--out", path.join(tempRoot, "wrong-cn-on-tw-dry-run"),
      ], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: cliEnv });
      let wrongEncodingResult = null;
      try { wrongEncodingResult = JSON.parse(wrongEncodingDryRun.stdout || "null"); } catch { /* recorded below */ }
      add(
        "pvf-change-big5-misread-as-gbk-has-no-approval",
        wrongEncodingResult?.approvalCode === null &&
          wrongEncodingResult?.blockedChanges?.[0]?.code === "TEXT_ENCODING_MISMATCH_SUSPECTED" &&
          sha256File(twFixturePath) === twSourceSha,
        wrongEncodingResult,
      );

    } catch (error) {
      if (nativeAvailable) {
        add("native-server-write-boundary-unexpected-error", false, { error: error.message });
      } else {
        add("native-independent-fixture-read", true, { skipped: true, reason: error.message });
      }
    }
  } finally {
    if (serverClient) serverClient.stop();
    if (nativeServerClient) nativeServerClient.stop();
    if (controlledServerClient) controlledServerClient.stop();
    while (extraFallbackSessionIds.length > 0) {
      try { await fallback.closeSession(extraFallbackSessionIds.pop()); } catch { /* best effort */ }
    }
    if (nativeSessionId) {
      try { await loadPvfBackend({ mode: "native" }).api.closeSession(nativeSessionId); } catch { /* best effort */ }
    }
    if (fallbackSessionId) {
      try { await fallback.closeSession(fallbackSessionId); } catch { /* best effort */ }
    }
    if (cnFallbackSessionId) {
      try { await fallback.closeSession(cnFallbackSessionId); } catch { /* best effort */ }
    }
    if (!pathInside(os.tmpdir(), tempRoot)) throw new Error(`Unsafe fallback self-test path: ${tempRoot}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: "1.0",
    phase: "typescript-readonly-fallback-self-test",
    summary: {
      ok: checks.every((check) => check.ok),
      checkCount: checks.length,
      failedChecks: checks.filter((check) => !check.ok).length,
    },
    checks,
  };
  const reportDir = runtimePath(workbenchRoot, "self-tests", "fallback");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `FALLBACK-SELF-TEST-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  report.reportPath = reportPath;
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const visible = process.argv.includes("--details")
    ? report
    : {
      schemaVersion: report.schemaVersion,
      phase: report.phase,
      reportPath,
      summary: report.summary,
      failedChecks: checks.filter((check) => !check.ok),
    };
  process.stdout.write(`${JSON.stringify(visible, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
