"use strict";

const fs = require("fs");
const path = require("path");
const { isPathInside, resolvePvfPathInside } = require("./fallback/path-safety.ts");
const crypto = require("crypto");
const { loadPvfBackend } = require("./native-backend");

const native = loadPvfBackend().api;

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizePvfPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

function normalizeKey(value) {
  return normalizePvfPath(value).toLowerCase();
}

function resolveInsideWorkspace(targetPath, label) {
  const resolved = path.resolve(targetPath || "");
  const cwd = process.cwd();
  if (!targetPath || !isPathInside(cwd, resolved)) {
    throw new Error(`Refusing ${label || "path"} outside workspace: ${resolved}`);
  }
  return resolved;
}

function localPath(extractDir, pvfPath) {
  return resolvePvfPathInside(extractDir, pvfPath, "Extracted PVF entry path");
}

function listedFileName(item) {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item.fileName === "string") {
    return item.fileName;
  }
  return String(item || "");
}

function readExtractedFiles(extractDir) {
  const listPath = path.join(extractDir, "extracted-files.txt");
  if (!fs.existsSync(listPath)) {
    throw new Error(`Extracted file list was not found: ${listPath}`);
  }
  return fs
    .readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map(normalizePvfPath)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function decodeNumericEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function textDiffHint(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) {
    index += 1;
  }
  return {
    firstDifferentOffset: index,
    sourceSnippet: a.slice(Math.max(0, index - 80), index + 160),
    targetSnippet: b.slice(Math.max(0, index - 80), index + 160),
  };
}

async function readPvfFile(sessionId, pvfPath) {
  return native.readFile(sessionId, pvfPath, {
    pvfEncoding: "Tw",
    decompileScript: true,
    decompileBinaryAni: true,
    autoConvertStringLink: true,
    useCompatibleDecompiler: true,
    convertToSimplifiedChinese: true,
  });
}

async function main() {
  const extractDir = resolveInsideWorkspace(argValue("extract-dir", ""), "extract-dir");
  const targetPvf = resolveInsideWorkspace(argValue("target-pvf", ""), "target-pvf");
  const reportPath = argValue("report", "");
  const limit = Number(argValue("limit", "0"));
  const normalizeEntities = hasFlag("decode-numeric-entities") || hasFlag("normalize-html-entities");

  const extractedFiles = readExtractedFiles(extractDir);
  const session = await native.openSession(targetPvf, "Tw");
  try {
    const targetFiles = new Set((await native.listFiles(session.sessionId)).map((item) => normalizeKey(listedFileName(item))));
    const commonFiles = extractedFiles.filter((pvfPath) => targetFiles.has(normalizeKey(pvfPath)));
    const missingFromTarget = extractedFiles.filter((pvfPath) => !targetFiles.has(normalizeKey(pvfPath)));
    const compared = [];
    const different = [];
    const unreadable = [];
    let rawDifferentCount = 0;
    let entityOnlyDifferenceCount = 0;

    for (const pvfPath of commonFiles) {
      if (limit > 0 && compared.length >= limit) {
        break;
      }
      const diskPath = localPath(extractDir, pvfPath);
      if (!fs.existsSync(diskPath)) {
        unreadable.push({ pvfPath, side: "source", error: "local extracted file is missing" });
        continue;
      }

      try {
        const sourceBytes = fs.readFileSync(diskPath);
        const target = await readPvfFile(session.sessionId, pvfPath);
        const item = { pvfPath };

        if (typeof target.textContent === "string") {
          const sourceText = sourceBytes.toString("utf8");
          const sourceRaw = normalizeText(sourceText);
          const targetRaw = normalizeText(target.textContent);
          const sourceComparable = normalizeEntities ? normalizeText(decodeNumericEntities(sourceText)) : sourceRaw;
          const targetComparable = normalizeEntities ? normalizeText(decodeNumericEntities(target.textContent)) : targetRaw;
          const rawSame = sourceRaw === targetRaw;
          const same = sourceComparable === targetComparable;
          item.kind = "text";
          item.same = same;
          item.rawSame = rawSame;
          item.sourceSha256 = sha256(Buffer.from(sourceComparable, "utf8"));
          item.targetSha256 = sha256(Buffer.from(targetComparable, "utf8"));
          if (!rawSame) {
            rawDifferentCount += 1;
          }
          if (same && !rawSame && normalizeEntities) {
            item.entityOnlyDifference = true;
            entityOnlyDifferenceCount += 1;
          }
          if (!same) {
            item.sourceLength = sourceComparable.length;
            item.targetLength = targetComparable.length;
            Object.assign(item, textDiffHint(sourceComparable, targetComparable));
            different.push(item);
          }
        } else if (target.base64Content) {
          const targetBytes = Buffer.from(target.base64Content, "base64");
          const same = sourceBytes.equals(targetBytes);
          item.kind = "binary";
          item.same = same;
          item.sourceSha256 = sha256(sourceBytes);
          item.targetSha256 = sha256(targetBytes);
          if (!same) {
            rawDifferentCount += 1;
          }
          if (!same) {
            item.sourceLength = sourceBytes.length;
            item.targetLength = targetBytes.length;
            different.push(item);
          }
        } else {
          unreadable.push({ pvfPath, side: "target", error: "target read returned neither text nor base64 content" });
          continue;
        }

        compared.push(item);
      } catch (error) {
        unreadable.push({ pvfPath, side: "target", error: error && error.message ? error.message : String(error) });
      }
    }

    const result = {
      ok: different.length === 0 && unreadable.length === 0,
      targetPvf,
      extractDir,
      extractedFileCount: extractedFiles.length,
      commonFileCount: commonFiles.length,
      missingFromTargetCount: missingFromTarget.length,
      comparedCount: compared.length,
      sameCount: compared.filter((item) => item.same).length,
      differentCount: different.length,
      rawDifferentCount,
      entityOnlyDifferenceCount,
      normalizedNumericEntities: normalizeEntities,
      unreadableCount: unreadable.length,
      different: different.slice(0, 200),
      unreadable: unreadable.slice(0, 200),
      missingFromTarget: missingFromTarget.slice(0, 200),
    };

    if (reportPath) {
      const resolvedReportPath = resolveInsideWorkspace(reportPath, "report");
      fs.mkdirSync(path.dirname(resolvedReportPath), { recursive: true });
      fs.writeFileSync(resolvedReportPath, JSON.stringify(result, null, 2), "utf8");
    }

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await native.closeSession(session.sessionId);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
