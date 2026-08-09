"use strict";

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
  containsStringLinkToken,
  directReadReason,
  directSearchReason,
  retryReadReason,
  retrySearchReason,
} = require("../lib/semantic-read-guard");

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

function createStringTable(values) {
  const parts = values.map((value) => Buffer.from(value, "utf8"));
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
    "fallback-fixture",
    "[message]",
    "message_1",
    "[/message]",
  ];
  const localizedStringView = options.cnLocalized
    ? Buffer.concat([
      Buffer.from("message_1>", "ascii"),
      Buffer.from("d6d0cec4b1a3bba4", "hex"),
      Buffer.from("\r\n", "ascii"),
    ])
    : Buffer.from("message_1>只读备用后端\r\n", "utf8");
  const sourceFiles = [
    { fileName: "stringtable.bin", data: createStringTable(strings) },
    { fileName: "n_string.lst", data: createScript([[2, 0], [7, 0]]) },
    { fileName: "stringview/fixture.str", data: localizedStringView },
    { fileName: "itemshop/itemshop.lst", data: createScript([[2, 1], [7, 1]]) },
    {
      fileName: "itemshop/test.shp",
      data: createScript([[5, 2], [7, 3], [5, 4], [9, 0], [10, 5], [5, 6]]),
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
    createFixturePvf(cnFixturePath, { cnLocalized: true });
    const sourceSha = sha256File(fixturePath);
    const cnSourceSha = sha256File(cnFixturePath);
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
        directReadReason("itemshop/itemshop.kor.str", { pvfEncoding: "Tw" }, "Tw") === null &&
        directSearchReason({ keyword: "中文", searchType: "SearchScript", pvfEncoding: "Cn" }, "Tw") === "cn-semantic-search" &&
        directSearchReason({ keyword: "中文", searchType: "SearchStrings", pvfEncoding: "Cn" }, "Tw") === "cn-semantic-search" &&
        directSearchReason({ keyword: "9990001", searchType: "SearchScript", pvfEncoding: "Cn" }, "Tw") === null &&
        directSearchReason({ searchType: "SearchFileName", pvfEncoding: "Cn" }, "Tw") === null &&
        containsStringLinkToken("<5::message_520`中文保护`>") &&
        retryReadReason({ isScriptFile: true, textContent: "<5::message_520`中文保护`>" }, { pvfEncoding: "Cn" }, "Tw") === "cn-stringlink-detected" &&
        retryReadReason({ isScriptFile: true, textContent: "[name]\r\n`中文保护`" }, { pvfEncoding: "Cn" }, "Tw") === "cn-nonascii-script-detected" &&
        retrySearchReason({ items: [{ preview: "[name] 中文保护" }] }, { keyword: "name", searchType: "SearchScript", pvfEncoding: "Cn" }, "Tw") === "cn-nonascii-search-preview-detected",
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
    add("fallback-search-script", scriptSearch.items.some((item) => item.fileName === "itemshop/test.shp"));
    const stringSearch = await fallback.searchFiles(fallbackSessionId, { keyword: "fallback-fixture", searchType: "SearchStrings", matchMode: "Like" });
    add("fallback-search-strings", stringSearch.items.some((item) => item.fileName === "itemshop/test.shp"));
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
        ["pvf_backup", "pvf_replace_text", "pvf_write_file", "pvf_save"].every((name) => controlledToolNames.has(name)),
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
        dryRun: false,
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      }));
      const controlledDirectChineseReplace = parseBackendTextResult(await controlledServerClient.callTool("pvf_replace_text", {
        sessionId: controlledCnSessionId,
        pvfPath: "itemshop/test.shp",
        previousText: "fallback-fixture-checked",
        newText: "中文直写",
        dryRun: false,
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
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
      }));
      const controlledCnWriteOk =
        controlledCnStrReplace?.data?.code === "CN_LOCALIZATION_WRITE_UNVERIFIED" &&
        controlledCnScriptReplace?.ok === true &&
        controlledCnScriptReplace?.semanticReadGuard?.reason === "cn-stringlink-detected" &&
        controlledDirectChineseReplace?.data?.code === "NON_ASCII_TEXT_WRITE_UNVERIFIED" &&
        controlledCnSave?.ok === true &&
        (controlledCnStrReadback?.textContent || "").includes("中文保护") &&
        !(controlledCnStrReadback?.textContent || "").includes("已验证") &&
        (controlledCnScriptReadback?.textContent || "").includes("fallback-fixture-checked") &&
        !(controlledCnScriptReadback?.textContent || "").includes("中文直写") &&
        (controlledCnScriptReadback?.textContent || "").includes("<0::message_1`中文保护`>") &&
        sha256File(cnFixturePath) === cnSourceSha;
      add(
        "controlled-server-preserves-cn-semantics-on-write",
        controlledCnWriteOk,
        controlledCnWriteOk ? undefined : {
          strReplace: controlledCnStrReplace,
          scriptReplace: controlledCnScriptReplace,
          directChineseReplace: controlledDirectChineseReplace,
          save: controlledCnSave,
          strReadbackText: controlledCnStrReadback?.textContent,
          scriptReadbackText: controlledCnScriptReadback?.textContent,
          sourceUnchanged: sha256File(cnFixturePath) === cnSourceSha,
        },
      );
      await controlledServerClient.callTool("pvf_close", { sessionId: controlledCnReadbackSessionId });
      controlledServerClient.stop();
      controlledServerClient = null;
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
