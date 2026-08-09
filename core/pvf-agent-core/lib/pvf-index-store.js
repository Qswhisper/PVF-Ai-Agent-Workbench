"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { resolveSourcePvf } = require("./workspace-profiles");
const { runtimePath } = require("./runtime-state");

function safeName(value) {
  return String(value || "pvf")
    .replace(/^[A-Za-z]:[\\/]/, "")
    .replace(/[\\/:\s]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "pvf";
}

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

function sourceSampleHash(file) {
  const stat = fs.statSync(file);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const sampleSize = 1024 * 1024;
  try {
    for (const offset of [0, Math.max(0, Math.floor(stat.size / 2) - sampleSize / 2), Math.max(0, stat.size - sampleSize)]) {
      const length = Math.min(sampleSize, Math.max(0, stat.size - offset));
      if (length <= 0) {
        continue;
      }
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, offset);
      hash.update(buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
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

function sourceIndexName(sourcePvf) {
  const resolved = path.resolve(sourcePvf);
  const pathIdentity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const pathHash = crypto.createHash("sha256").update(pathIdentity, "utf8").digest("hex").slice(0, 12);
  return `${safeName(path.basename(resolved, path.extname(resolved)))}-${pathHash}`;
}

function preferCurrentOrLegacy(currentPath, legacyPath) {
  if (fs.existsSync(currentPath) || !fs.existsSync(legacyPath)) return currentPath;
  return legacyPath;
}

function resolveIndexDir(workbenchRoot, options = {}) {
  if (options.indexDir) {
    return path.resolve(options.indexDir);
  }
  const scope = options.scope ? safeName(options.scope) : null;
  if (options.profile) {
    return scope
      ? runtimePath(workbenchRoot, "indexes", safeName(options.profile), "scopes", scope)
      : runtimePath(workbenchRoot, "indexes", safeName(options.profile), "latest");
  }
  if (options.pvf) {
    const currentRoot = sourceIndexName(options.pvf);
    const legacyRoot = safeName(path.basename(options.pvf, path.extname(options.pvf)));
    const current = scope
      ? runtimePath(workbenchRoot, "indexes", currentRoot, "scopes", scope)
      : runtimePath(workbenchRoot, "indexes", currentRoot, "latest");
    const legacy = scope
      ? runtimePath(workbenchRoot, "indexes", legacyRoot, "scopes", scope)
      : runtimePath(workbenchRoot, "indexes", legacyRoot, "latest");
    return preferCurrentOrLegacy(current, legacy);
  }
  const resolved = resolveSourcePvf(workbenchRoot, null, null);
  const indexName = safeName(resolved.profile?.name || path.basename(resolved.sourcePvf, path.extname(resolved.sourcePvf)));
  return path.join(
    runtimePath(workbenchRoot,
    "indexes",
    indexName,
    ...(scope ? ["scopes", scope] : ["latest"]))
  );
}

function resolveCatalogPath(workbenchRoot, options = {}) {
  if (options.catalogPath) {
    return path.resolve(options.catalogPath);
  }
  if (options.profile) {
    return runtimePath(workbenchRoot, "indexes", safeName(options.profile), "CATALOG.json");
  }
  if (options.pvf) {
    const current = runtimePath(workbenchRoot, "indexes", sourceIndexName(options.pvf), "CATALOG.json");
    const legacy = runtimePath(workbenchRoot, "indexes", safeName(path.basename(options.pvf, path.extname(options.pvf))), "CATALOG.json");
    return options.preferCurrentNaming ? current : preferCurrentOrLegacy(current, legacy);
  }
  const resolved = resolveSourcePvf(workbenchRoot, null, null);
  return runtimePath(
    workbenchRoot,
    "indexes",
    safeName(resolved.profile?.name || path.basename(resolved.sourcePvf, path.extname(resolved.sourcePvf))),
    "CATALOG.json"
  );
}

function loadIndexManifest(indexDir) {
  const manifestPath = path.join(indexDir, "INDEX-MANIFEST.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Index manifest does not exist: ${manifestPath}`);
  }
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  };
}

function resolveStatusSource(workbenchRoot, manifest, options = {}) {
  if (options.profile) {
    return resolveSourcePvf(workbenchRoot, options.profile, null).sourcePvf;
  }
  if (options.pvf) {
    return path.resolve(options.pvf);
  }
  return manifest.source?.sourcePvf;
}

function indexStatus(workbenchRoot, options = {}) {
  const indexDir = resolveIndexDir(workbenchRoot, options);
  const loaded = loadIndexManifest(indexDir);
  const sourcePvf = resolveStatusSource(workbenchRoot, loaded.manifest, options);
  const result = {
    ok: true,
    indexDir,
    manifestPath: loaded.manifestPath,
    sourcePvf,
    exists: false,
    fresh: false,
    checks: {
      sourcePathMatches: sourcePvf === loaded.manifest.source?.sourcePvf,
      sourceExists: false,
      sizeMatches: false,
      mtimeMatches: false,
      sampleHashMatches: false,
      fullHashMatches: null,
    },
    manifest: {
      generatedAt: loaded.manifest.generatedAt,
      phase: loaded.manifest.phase,
      mode: loaded.manifest.mode,
      scope: loaded.manifest.scope,
      summary: loaded.manifest.summary,
      safety: loaded.manifest.safety,
    },
  };
  if (!sourcePvf || !fs.existsSync(sourcePvf)) {
    return result;
  }

  const stat = fs.statSync(sourcePvf);
  const currentSampleHash = options.skipSampleHash ? null : sourceSampleHash(sourcePvf);
  const currentFullHash = options.verifyFullSha ? sha256File(sourcePvf) : null;
  result.exists = true;
  result.currentSource = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256Sample: currentSampleHash,
    sha256: currentFullHash,
  };
  result.checks.sourceExists = true;
  result.checks.sizeMatches = stat.size === loaded.manifest.source?.sourceSize;
  result.checks.mtimeMatches = Math.abs(stat.mtimeMs - Number(loaded.manifest.source?.sourceMtimeMs || 0)) < 2;
  result.checks.sampleHashMatches = options.skipSampleHash
    ? null
    : currentSampleHash === loaded.manifest.source?.sourceSha256Sample;
  result.checks.fullHashMatches = options.verifyFullSha
    ? Boolean(loaded.manifest.source?.sourceSha256) && currentFullHash === loaded.manifest.source.sourceSha256
    : null;
  result.verification = {
    mode: options.verifyFullSha ? "full-sha256" : "fast-metadata-sample",
    fullSha256Recorded: Boolean(loaded.manifest.source?.sourceSha256),
  };
  result.fresh =
    result.checks.sourcePathMatches &&
    result.checks.sourceExists &&
    result.checks.sizeMatches &&
    result.checks.mtimeMatches &&
    (options.skipSampleHash || result.checks.sampleHashMatches === true) &&
    (!options.verifyFullSha || result.checks.fullHashMatches === true);
  return result;
}

async function scanJsonl(file, predicate, limit) {
  if (!fs.existsSync(file)) {
    throw new Error(`Index artifact does not exist: ${file}`);
  }
  const matches = [];
  let scanned = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    scanned += 1;
    const item = JSON.parse(line);
    if (predicate(item)) {
      matches.push(item);
      if (matches.length >= limit) {
        rl.close();
        break;
      }
    }
  }
  return { scanned, matches };
}

function summarizeIndex(workbenchRoot, options = {}) {
  const indexDir = resolveIndexDir(workbenchRoot, options);
  const loaded = loadIndexManifest(indexDir);
  return {
    ok: true,
    command: "summary",
    indexDir,
    manifestPath: loaded.manifestPath,
    phase: loaded.manifest.phase,
    mode: loaded.manifest.mode,
    source: loaded.manifest.source,
    scope: loaded.manifest.scope,
    summary: loaded.manifest.summary,
    safety: loaded.manifest.safety,
  };
}

function loadIndexCatalog(workbenchRoot, options = {}) {
  const catalogPath = resolveCatalogPath(workbenchRoot, options);
  if (!fs.existsSync(catalogPath)) {
    return {
      ok: true,
      command: "catalog",
      catalogPath,
      exists: false,
      entries: [],
    };
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  return {
    ok: true,
    command: "catalog",
    catalogPath,
    exists: true,
    profile: catalog.profile,
    sourcePvf: catalog.sourcePvf,
    generatedAt: catalog.generatedAt,
    entries: catalog.entries || [],
  };
}

function updateIndexCatalog(workbenchRoot, options = {}) {
  const catalogPath = resolveCatalogPath(workbenchRoot, { ...options, preferCurrentNaming: true });
  const manifestPath = options.manifestPath;
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error("manifestPath is required to update the index catalog.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const catalog = fs.existsSync(catalogPath)
    ? JSON.parse(fs.readFileSync(catalogPath, "utf8"))
    : {
        schemaVersion: "1.0",
        phase: "phase-4-readonly-session-index",
        generatedAt: new Date().toISOString(),
        profile: manifest.source?.profile || null,
        sourcePvf: manifest.source?.sourcePvf || null,
        entries: [],
      };
  catalog.generatedAt = new Date().toISOString();
  catalog.profile = manifest.source?.profile || catalog.profile || null;
  catalog.sourcePvf = manifest.source?.sourcePvf || catalog.sourcePvf || null;

  const scopeKey = safeName(options.scope || manifest.scope?.scopeName || "latest");
  const entry = {
    scopeKey,
    scopeName: options.scope || manifest.scope?.scopeName || "latest",
    indexDir: path.dirname(manifestPath),
    manifestPath,
    generatedAt: manifest.generatedAt,
    sourceSha256: manifest.source?.sourceSha256 || null,
    scope: manifest.scope,
    summary: manifest.summary,
    safety: manifest.safety,
  };
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  const existing = entries.findIndex((item) => item.scopeKey === scopeKey);
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  entries.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
  catalog.entries = entries;
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return {
    ok: true,
    command: "catalog-update",
    catalogPath,
    entry,
    entryCount: entries.length,
  };
}

async function queryPathIndex(workbenchRoot, options = {}) {
  const indexDir = resolveIndexDir(workbenchRoot, options);
  const loaded = loadIndexManifest(indexDir);
  const limit = options.limit || 20;
  const normalizedPrefix = options.prefix ? toPosix(options.prefix).toLowerCase() : null;
  const normalizedContains = options.contains ? toPosix(options.contains).toLowerCase() : null;
  const normalizedExt = options.ext ? String(options.ext).toLowerCase() : null;
  const result = await scanJsonl(
    path.join(indexDir, "paths.jsonl"),
    (item) => {
      const fileName = toPosix(item.fileName || "").toLowerCase();
      if (normalizedPrefix && !fileName.startsWith(normalizedPrefix)) {
        return false;
      }
      if (normalizedContains && !fileName.includes(normalizedContains)) {
        return false;
      }
      if (normalizedExt && path.posix.extname(fileName) !== normalizedExt) {
        return false;
      }
      return true;
    },
    limit
  );
  return {
    ok: true,
    command: "path",
    indexDir,
    manifestPath: loaded.manifestPath,
    query: {
      prefix: options.prefix || null,
      contains: options.contains || null,
      ext: options.ext || null,
      limit,
    },
    scanned: result.scanned,
    returnedCount: result.matches.length,
    items: result.matches,
    scope: loaded.manifest.scope,
  };
}

async function resolveLstIndex(workbenchRoot, options = {}) {
  const indexDir = resolveIndexDir(workbenchRoot, options);
  const loaded = loadIndexManifest(indexDir);
  const lstPath = toPosix(options.lstPath || "").toLowerCase();
  if (!lstPath) {
    throw new Error("lstPath is required.");
  }
  const id = Number(options.id);
  if (!Number.isInteger(id)) {
    throw new Error("id must be an integer.");
  }
  const limit = options.limit || 20;
  const result = await scanJsonl(
    path.join(indexDir, "lst-index.jsonl"),
    (item) => toPosix(item.registryPath || "").toLowerCase() === lstPath && Number(item.id) === id,
    limit
  );
  return {
    ok: true,
    command: "resolve-lst",
    indexDir,
    manifestPath: loaded.manifestPath,
    query: { lstPath, id, limit },
    scanned: result.scanned,
    found: result.matches.length > 0,
    returnedCount: result.matches.length,
    items: result.matches,
    scope: loaded.manifest.scope,
  };
}

module.exports = {
  indexStatus,
  loadIndexCatalog,
  queryPathIndex,
  resolveIndexDir,
  resolveLstIndex,
  safeName,
  sha256File,
  sourceIndexName,
  sourceSampleHash,
  summarizeIndex,
  toPosix,
  updateIndexCatalog,
};
