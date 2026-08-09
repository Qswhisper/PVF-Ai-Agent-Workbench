"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fallback = require("../../../tools/pvf-bridge/fallback/pvf-readonly-backend.ts");
const { loadPvfBackend } = require("../../../tools/pvf-bridge/native-backend");
const {
  directReadReason,
  directSearchReason,
  retryReadReason,
} = require("../lib/semantic-read-guard");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");

function repeated(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) values.push(args[++index]);
    else if (args[index].startsWith(`--${name}=`)) values.push(args[index].slice(name.length + 3));
  }
  return values;
}

function option(name, fallbackValue) {
  const values = repeated(name);
  return values.length > 0 ? values[values.length - 1] : fallbackValue;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function listedPath(item) {
  return String(typeof item === "string" ? item : item?.fileName || "").replace(/\\/g, "/").toLowerCase();
}

function normalizedText(result) {
  return String(result?.textContent || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function rawBuffer(result) {
  return typeof result?.base64Content === "string" ? Buffer.from(result.base64Content, "base64") : null;
}

function searchPaths(result) {
  return (Array.isArray(result?.items) ? result.items : []).map(listedPath).filter(Boolean).sort();
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function inspectOne(pvfPath, label, native) {
  const checks = [];
  const add = (id, ok, details) => checks.push({ id, ok: Boolean(ok), ...(details ? { details } : {}) });
  let fallbackSession;
  let nativeSession;
  try {
    process.stderr.write(`fallback differential: ${label}\n`);
    const fallbackOpened = await fallback.openSession(pvfPath, "Tw");
    fallbackSession = fallbackOpened.sessionId;
    const nativeOpened = await native.openSession(pvfPath, "Tw");
    nativeSession = nativeOpened.sessionId || nativeOpened;
    const [fallbackFiles, nativeFiles] = await Promise.all([
      fallback.listFiles(fallbackSession),
      native.listFiles(nativeSession),
    ]);
    const fallbackPaths = fallbackFiles.map(listedPath).sort();
    const nativePaths = nativeFiles.map(listedPath).sort();
    add("file-count", fallbackPaths.length === nativePaths.length, { fallback: fallbackPaths.length, native: nativePaths.length });
    add("path-set", sameArray(fallbackPaths, nativePaths), {
      fallbackSha256: sha256(`${fallbackPaths.join("\n")}\n`),
      nativeSha256: sha256(`${nativePaths.join("\n")}\n`),
    });

    const available = new Set(fallbackPaths);
    const fixed = [
      "itemshop/itemshop.lst",
      "itemshop/birken.shp",
      "skill/swordmanskill.lst",
    ].filter((candidate) => available.has(candidate));
    const nut = fallbackFiles
      .filter((item) => listedPath(item).endsWith(".nut") && Number(item.dataLength || 0) > 0 && Number(item.dataLength || 0) < 1024 * 1024)
      .map(listedPath)
      .sort()[0];
    const ani = fallbackFiles
      .filter((item) => listedPath(item).endsWith(".ani") && Number(item.dataLength || 0) >= 20 && Number(item.dataLength || 0) < 1024 * 1024)
      .map(listedPath)
      .sort()[0];
    const selected = [...fixed, ...(nut ? [nut] : []), ...(ani ? [ani] : [])];

    for (const pvfFile of selected) {
      const options = {
        decompileScript: false,
        decompileBinaryAni: false,
        autoConvertStringLink: false,
        convertToSimplifiedChinese: false,
        pvfEncoding: pvfFile.endsWith(".nut") ? "Kr" : "Tw",
      };
      const [fallbackRead, nativeRead] = await Promise.all([
        fallback.readFile(fallbackSession, pvfFile, options),
        native.readFile(nativeSession, pvfFile, options),
      ]);
      const fallbackRaw = rawBuffer(fallbackRead);
      const nativeRaw = rawBuffer(nativeRead);
      if (fallbackRaw && nativeRaw) {
        add(`raw:${pvfFile}`, fallbackRaw.equals(nativeRaw), {
          bytes: fallbackRaw.length,
          fallbackSha256: sha256(fallbackRaw),
          nativeSha256: sha256(nativeRaw),
        });
      } else {
        const fallbackText = normalizedText(fallbackRead);
        const nativeText = normalizedText(nativeRead);
        const equal = fallbackText === nativeText;
        const asciiStructureEqual = pvfFile.endsWith(".nut") && fallbackText.replace(/[^\x00-\x7f]/g, "") === nativeText.replace(/[^\x00-\x7f]/g, "");
        add(`text:${pvfFile}`, equal || asciiStructureEqual, {
          fallbackSha256: sha256(fallbackText),
          nativeSha256: sha256(nativeText),
          decodeDifferenceAccepted: !equal && asciiStructureEqual,
        });
      }
    }

    for (const pvfFile of fixed.filter((candidate) => candidate.endsWith(".lst"))) {
      const options = { decompileScript: true, autoConvertStringLink: false, convertToSimplifiedChinese: false, pvfEncoding: "Tw" };
      const [fallbackRead, nativeRead] = await Promise.all([
        fallback.readFile(fallbackSession, pvfFile, options),
        native.readFile(nativeSession, pvfFile, options),
      ]);
      const fallbackText = normalizedText(fallbackRead);
      const nativeText = normalizedText(nativeRead);
      add(`decompile:${pvfFile}`, fallbackText === nativeText, {
        fallbackSha256: sha256(fallbackText),
        nativeSha256: sha256(nativeText),
      });
    }

    const semanticPaths = [
      "itemshop/birken.shp",
      "itemshop/itemshop.kor.str",
    ].filter((candidate) => available.has(candidate));
    const semanticFallbackText = new Map();
    for (const pvfFile of semanticPaths) {
      const options = {
        decompileScript: true,
        decompileBinaryAni: false,
        autoConvertStringLink: false,
        convertToSimplifiedChinese: false,
        pvfEncoding: "Cn",
      };
      const [fallbackRead, nativeRead] = await Promise.all([
        fallback.readFile(fallbackSession, pvfFile, options),
        native.readFile(nativeSession, pvfFile, options),
      ]);
      const fallbackText = normalizedText(fallbackRead);
      const nativeText = normalizedText(nativeRead);
      semanticFallbackText.set(pvfFile, fallbackText);
      const guardReason = directReadReason(pvfFile, options, "Tw") || retryReadReason(nativeRead, options, "Tw");
      add(`semantic-cn-guard:${pvfFile}`, nativeText === fallbackText || Boolean(guardReason), {
        nativeSemanticEqual: nativeText === fallbackText,
        guardReason,
        fallbackSha256: sha256(fallbackText),
        nativeSha256: sha256(nativeText),
      });
    }

    const birkenCnText = semanticFallbackText.get("itemshop/birken.shp") || "";
    const chineseNeedle = birkenCnText.match(/[\u3400-\u9fff]{2,}/)?.[0];
    if (chineseNeedle) {
      const query = {
        keyword: chineseNeedle,
        searchPath: "itemshop",
        isStartMatch: false,
        isUseLikeSearchPath: false,
        searchType: "SearchScript",
        matchMode: "Like",
        sourceFiles: ["itemshop/birken.shp"],
        pvfEncoding: "Cn",
        convertToSimplifiedChinese: false,
      };
      const [fallbackResult, nativeResult] = await Promise.all([
        fallback.searchFiles(fallbackSession, query),
        native.searchFiles(nativeSession, query),
      ]);
      const fallbackMatches = searchPaths(fallbackResult);
      const nativeMatches = searchPaths(nativeResult);
      const guardReason = directSearchReason(query, "Tw");
      add("search:cn-semantic-guard", fallbackMatches.includes("itemshop/birken.shp") && Boolean(guardReason), {
        keywordSha256: sha256(chineseNeedle),
        nativeSemanticEqual: sameArray(fallbackMatches, nativeMatches),
        guardReason,
        fallbackMatches,
        nativeMatches,
      });
    }

    const searchCases = [];
    if (available.has("itemshop/birken.shp")) {
      searchCases.push({
        id: "filename",
        query: { keyword: "birken.shp", searchType: "SearchFileName", matchMode: "Like" },
      });
      searchCases.push({
        id: "script",
        query: { keyword: "9990001", searchType: "SearchScript", matchMode: "Like", sourceFiles: ["itemshop/birken.shp"], pvfEncoding: "Tw" },
      });
    }
    if (available.has("itemshop/itemshop.lst")) {
      searchCases.push({
        id: "strings",
        query: { keyword: "birken.shp", searchType: "SearchStrings", matchMode: "Like", sourceFiles: ["itemshop/itemshop.lst"] },
      });
    }
    for (const searchCase of searchCases) {
      const query = {
        searchPath: "",
        isStartMatch: false,
        isUseLikeSearchPath: false,
        convertToSimplifiedChinese: false,
        sourceFiles: undefined,
        ...searchCase.query,
      };
      const [fallbackResult, nativeResult] = await Promise.all([
        fallback.searchFiles(fallbackSession, query),
        native.searchFiles(nativeSession, query),
      ]);
      const fallbackMatches = searchPaths(fallbackResult);
      const nativeMatches = searchPaths(nativeResult);
      add(`search:${searchCase.id}`, sameArray(fallbackMatches, nativeMatches), {
        fallbackMatchedCount: fallbackResult.matchedCount,
        nativeMatchedCount: nativeResult.matchedCount,
        fallbackPaths: fallbackMatches,
        nativePaths: nativeMatches,
      });
    }

    return {
      label,
      pvfPath,
      pvfBytes: fs.statSync(pvfPath).size,
      pvfSha256: sha256File(pvfPath),
      selectedPaths: selected,
      summary: { ok: checks.every((check) => check.ok), checkCount: checks.length, failedChecks: checks.filter((check) => !check.ok).length },
      checks,
    };
  } finally {
    if (fallbackSession) await fallback.closeSession(fallbackSession).catch(() => {});
    if (nativeSession) await native.closeSession(nativeSession).catch(() => {});
  }
}

async function main() {
  const pvfs = repeated("pvf").map((value) => path.resolve(value));
  const labels = repeated("label");
  if (pvfs.length === 0) throw new Error("Use --pvf <Script.pvf> at least once; repeat --pvf and --label for multiple targets.");
  for (const pvf of pvfs) {
    if (!fs.existsSync(pvf) || !fs.statSync(pvf).isFile()) throw new Error(`PVF does not exist: ${pvf}`);
  }
  const out = option("out", "") ? path.resolve(option("out", "")) : null;
  if (out && pathInside(workbenchRoot, out)) throw new Error(`Differential report must stay outside the clean Workbench: ${out}`);
  const native = loadPvfBackend({ mode: "native" }).api;
  const targets = [];
  for (let index = 0; index < pvfs.length; index += 1) {
    targets.push(await inspectOne(pvfs[index], labels[index] || `target-${index + 1}`, native));
  }
  const report = {
    schemaVersion: "1.0",
    phase: "typescript-readonly-fallback-native-differential",
    generatedAt: new Date().toISOString(),
    summary: {
      ok: targets.every((target) => target.summary.ok),
      targetCount: targets.length,
      checkCount: targets.reduce((sum, target) => sum + target.summary.checkCount, 0),
      failedChecks: targets.reduce((sum, target) => sum + target.summary.failedChecks, 0),
    },
    targets,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, output, "utf8");
  }
  const visible = out && !args.includes("--details")
    ? {
      schemaVersion: report.schemaVersion,
      phase: report.phase,
      reportPath: out,
      summary: report.summary,
      targets: report.targets.map((target) => ({
        label: target.label,
        pvfSha256: target.pvfSha256,
        fileCount: target.checks.find((check) => check.id === "file-count")?.details?.fallback,
        summary: target.summary,
        failedChecks: target.checks.filter((check) => !check.ok),
      })),
    }
    : report;
  process.stdout.write(`${JSON.stringify(visible, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
