"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeRel(value) {
  return toPosix(value).replace(/^\/+/, "").replace(/\/+/g, "/");
}

function pathInside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function listFilesRecursive(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile()) files.push(full);
    }
  }
  return files.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

function globToRegex(pattern) {
  const escaped = normalizeRel(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function releaseReadmeException(relPath) {
  return /^workspaces\/(absorption-checklists|agent-eval-runs|doctor-runs|indexes|package-dry-runs|planner-runs|release-runs)\/README\.zh-CN\.md$/i.test(normalizeRel(relPath));
}

function hardForbiddenReason(relPath) {
  const value = normalizeRel(relPath);
  if (releaseReadmeException(value)) return null;
  if (/(^|\/)(?:node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.idea|\.vscode|\.vs|\.cache)(?:\/|$)/i.test(value)) {
    return "dependency, IDE, or cache directory";
  }
  if (/^config\/(providers\.local\.json|workspace-profiles\.local\.json)$/i.test(value)) return "local private config";
  if (/^config\/.*\.secret\.json$/i.test(value)) return "local secret config";
  if (/^workspaces\/(dry-runs|apply-runs|backend-contract-runs|backend-fixture-runs|first-run-reports|real-task-runs|real-task-checks|absorption-checklists|agent-eval-runs|agent-workspace-stages|runtime-overlay-dry-runs|runtime-overlay-stages|stage-copy-dry-runs|cold-start-dry-runs|doctor-runs|planner-runs|package-dry-runs|release-runs|indexes)\//i.test(value)) {
    return "generated workspace output";
  }
  if (/(^|\/)(?:\.env(?:\..*)?|\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(value)) return "secret or OS metadata file";
  if (/\.(pvf|bak|npk|img|map|zip|7z|rar|db|sqlite|sqlite3|log|tmp|pem|key|pfx|p12)$/i.test(value)) return "private, generated, or source artifact";
  if (/\.(exe|dll|node)$/i.test(value) && !/^(?:runtime\/node\/node\.exe|tools\/pvf-bridge\/native\/pvf_rust_core\.node)$/i.test(value)) {
    return "unexpected executable binary";
  }
  return null;
}

function listTreeEntries(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const relPath = normalizeRel(path.relative(root, full));
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relPath, file: full, type: "symbolic-link", bytes: stat.size });
      } else if (stat.isDirectory()) {
        entries.push({ path: relPath, file: full, type: "directory", bytes: 0 });
        stack.push(full);
      } else if (stat.isFile()) {
        entries.push({ path: relPath, file: full, type: "file", bytes: stat.size });
      } else {
        entries.push({ path: relPath, file: full, type: "special", bytes: stat.size });
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function windowsPathIssue(relPath) {
  const parts = normalizeRel(relPath).split("/");
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  for (const part of parts) {
    if (!part || /[. ]$/.test(part)) return "empty segment or trailing dot/space";
    if (reserved.test(part)) return `Windows reserved name: ${part}`;
  }
  return null;
}

function scanTextForReleaseRisks(file, relPath) {
  const findings = [];
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) {
    findings.push({ path: relPath, kind: "unexpected-binary-content" });
    return findings;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    findings.push({ path: relPath, kind: "invalid-utf8" });
    return findings;
  }

  const rules = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["github-token", /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
    ["api-secret", /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/],
    ["research-output-path", /[A-Za-z]:[\\/]+[^\r\n"'<>]*[\\/]+(?:workbench-research|release-validation|runtime-runs)(?:[\\/]|$)/i],
    ["user-profile-path", /[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|$))[^\\/\r\n"'<>%{}]+[\\/]/i],
  ];
  for (const [kind, regex] of rules) {
    if (regex.test(text)) findings.push({ path: relPath, kind });
  }
  return findings;
}

function auditReleaseTree(workbenchRoot, includedFiles) {
  const errors = [];
  const warnings = [];
  const forbiddenFiles = [];
  const unlistedFiles = [];
  const unlistedDirectories = [];
  const specialEntries = [];
  const textFindings = [];
  const windowsPathIssues = [];
  const caseCollisions = [];
  const included = new Set((includedFiles || []).map((item) => normalizeRel(item.path).toLowerCase()));
  // The staged package contains files plus their parent directories. Git and
  // file-only inventories cannot reveal unrelated empty directory leftovers.
  const includedDirectories = new Set();
  for (const file of included) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      includedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const caseMap = new Map();
  let fileCount = 0;
  let totalBytes = 0;
  let maxRelativePathLength = 0;

  for (const entry of listTreeEntries(workbenchRoot)) {
    maxRelativePathLength = Math.max(maxRelativePathLength, entry.path.length);
    const pathIssue = windowsPathIssue(entry.path);
    if (pathIssue) windowsPathIssues.push({ path: entry.path, reason: pathIssue });
    const folded = entry.path.toLowerCase();
    const existingCase = caseMap.get(folded);
    if (existingCase && existingCase !== entry.path) caseCollisions.push([existingCase, entry.path]);
    caseMap.set(folded, entry.path);

    if (entry.type !== "file") {
      if (entry.type === "directory") {
        if (!includedDirectories.has(folded)) unlistedDirectories.push(entry.path);
      } else specialEntries.push({ path: entry.path, type: entry.type });
      continue;
    }
    fileCount += 1;
    totalBytes += entry.bytes;
    const reason = hardForbiddenReason(entry.path);
    if (reason) forbiddenFiles.push({ path: entry.path, reason });
    if (!included.has(folded)) unlistedFiles.push(entry.path);

    const isAllowedBinary = /^(?:runtime\/node\/node\.exe|tools\/pvf-bridge\/native\/pvf_rust_core\.node)$/i.test(entry.path);
    if (!isAllowedBinary) textFindings.push(...scanTextForReleaseRisks(entry.file, entry.path));
    if (entry.bytes > 100 * 1024 * 1024) errors.push(`GitHub rejects files larger than 100 MiB: ${entry.path}`);
    else if (entry.bytes > 50 * 1024 * 1024) warnings.push(`GitHub will warn for a file larger than 50 MiB: ${entry.path}`);
  }

  if (forbiddenFiles.length > 0) errors.push(`Release tree contains ${forbiddenFiles.length} forbidden file(s).`);
  if (unlistedFiles.length > 0) errors.push(`Release tree contains ${unlistedFiles.length} file(s) outside the portable manifest.`);
  if (unlistedDirectories.length > 0) errors.push(`Release tree contains ${unlistedDirectories.length} directory/directories not used by portable files (including empty leftovers).`);
  if (specialEntries.length > 0) errors.push(`Release tree contains ${specialEntries.length} symbolic link or special file(s).`);
  if (textFindings.length > 0) errors.push(`Release tree contains ${textFindings.length} text purity finding(s).`);
  if (windowsPathIssues.length > 0) errors.push(`Release tree contains ${windowsPathIssues.length} Windows-incompatible path(s).`);
  if (caseCollisions.length > 0) errors.push(`Release tree contains ${caseCollisions.length} case-insensitive path collision(s).`);
  if (maxRelativePathLength > 180) warnings.push(`Longest relative path is ${maxRelativePathLength} characters; extract near a drive root on legacy Windows.`);

  return {
    errors,
    warnings,
    summary: {
      fileCount,
      totalBytes,
      maxRelativePathLength,
      forbiddenFileCount: forbiddenFiles.length,
      unlistedFileCount: unlistedFiles.length,
      unlistedDirectoryCount: unlistedDirectories.length,
      specialEntryCount: specialEntries.length,
      textFindingCount: textFindings.length,
      windowsPathIssueCount: windowsPathIssues.length,
      caseCollisionCount: caseCollisions.length,
    },
    forbiddenFiles,
    unlistedFiles,
    unlistedDirectories,
    specialEntries,
    textFindings,
    windowsPathIssues,
    caseCollisions,
  };
}

function releaseAuditSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-release-audit-"));
  const checks = [];
  try {
    fs.writeFileSync(path.join(tempRoot, "README.md"), "clean fixture\n", "utf8");
    const clean = auditReleaseTree(tempRoot, [{ path: "README.md" }]);
    checks.push({ id: "clean-tree-accepted", ok: clean.errors.length === 0 });

    fs.mkdirSync(path.join(tempRoot, "docs", "nested"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "docs", "nested", "guide.md"), "clean nested fixture\n", "utf8");
    const included = [{ path: "README.md" }, { path: "docs/nested/guide.md" }];
    const nestedClean = auditReleaseTree(tempRoot, included);
    checks.push({ id: "portable-parent-directories-accepted", ok: nestedClean.errors.length === 0 && nestedClean.summary.unlistedDirectoryCount === 0 });
    for (const directory of [".zcode/plans", "%SystemDrive%/ProgramData", "docs/empty-leftover", ".git/objects"]) {
      fs.mkdirSync(path.join(tempRoot, directory), { recursive: true });
    }
    const emptyLeftovers = auditReleaseTree(tempRoot, included);
    checks.push({ id: "empty-directory-leftovers-rejected", ok: emptyLeftovers.errors.length > 0 &&
      emptyLeftovers.summary.unlistedDirectoryCount === 5 && emptyLeftovers.summary.unlistedFileCount === 0 });
    checks.push({ id: "git-metadata-remains-excluded", ok: !emptyLeftovers.unlistedDirectories.some(dir => dir.startsWith(".git")) });

    fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "config", "workspace-profiles.local.json"), "{}\n", "utf8");
    const fakeToken = ["sk", "releaseAuditFixtureOnly1234567890"].join("-");
    const fakePrivatePath = ["C:", "Users", "release-audit-user", "private", "Script.pvf"].join("\\");
    fs.writeFileSync(path.join(tempRoot, ".env"), `TOKEN=${fakeToken}\n`, "utf8");
    fs.writeFileSync(path.join(tempRoot, "leaked-path.md"), `${fakePrivatePath}\n`, "utf8");
    const dirty = auditReleaseTree(tempRoot, included);
    checks.push({ id: "private-files-rejected", ok: dirty.summary.forbiddenFileCount === 2 });
    checks.push({ id: "unlisted-files-rejected", ok: dirty.summary.unlistedFileCount === 3 });
    checks.push({ id: "secrets-and-machine-paths-rejected", ok: dirty.summary.textFindingCount >= 2 });
  } finally {
    if (!pathInside(os.tmpdir(), tempRoot)) throw new Error(`Unsafe release audit temp path: ${tempRoot}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

function makeExcludeRules(manifest) {
  const patterns = [
    ...(manifest.exclude?.localPrivate || []),
    ...(manifest.exclude?.generatedOutputs || []),
    ...(manifest.exclude?.heavyArtifacts || []),
  ];
  return patterns.map((raw) => {
    const pattern = normalizeRel(raw);
    if (pattern.endsWith("/")) return { pattern, type: "prefix" };
    if (pattern.includes("*")) return { pattern, type: "glob", regex: globToRegex(pattern) };
    return { pattern, type: "exact" };
  });
}

function excludedReason(relPath, rules) {
  if (releaseReadmeException(relPath)) return null;
  const hard = hardForbiddenReason(relPath);
  if (hard) return hard;
  const value = normalizeRel(relPath);
  for (const rule of rules) {
    if (rule.type === "prefix" && value.toLowerCase().startsWith(rule.pattern.toLowerCase())) return `manifest exclude: ${rule.pattern}`;
    if (rule.type === "glob" && rule.regex.test(value)) return `manifest exclude: ${rule.pattern}`;
    if (rule.type === "exact" && value.toLowerCase() === rule.pattern.toLowerCase()) return `manifest exclude: ${rule.pattern}`;
  }
  return null;
}

function collectReleaseFiles(workbenchRoot, manifest) {
  const errors = [];
  const excludedCandidates = [];
  const rules = makeExcludeRules(manifest);
  const included = new Map();
  for (const rawEntry of manifest.portableCore?.include || []) {
    const entry = normalizeRel(rawEntry);
    if (!entry || path.isAbsolute(entry) || entry.includes("..")) {
      errors.push(`Unsafe include path: ${rawEntry}`);
      continue;
    }
    const absolute = path.join(workbenchRoot, entry);
    if (!fs.existsSync(absolute)) {
      errors.push(`Included path does not exist: ${entry}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    const files = stat.isDirectory() ? listFilesRecursive(absolute) : [absolute];
    for (const file of files) {
      const relPath = normalizeRel(path.relative(workbenchRoot, file));
      const reason = excludedReason(relPath, rules);
      if (reason) {
        excludedCandidates.push({ path: relPath, reason });
      } else {
        included.set(relPath, file);
      }
    }
  }
  const includedFiles = [];
  let includedBytes = 0;
  for (const [relPath, file] of [...included.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const stat = fs.statSync(file);
    includedBytes += stat.size;
    includedFiles.push({ path: relPath, bytes: stat.size, sha256: sha256File(file) });
  }
  return { errors, excludedCandidates, includedFiles, includedBytes };
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
}

function runNode(root, scriptRelativePath, scriptArgs = [], timeoutMs = 120000) {
  const script = path.join(root, scriptRelativePath);
  const node = path.join(root, "runtime", "node", "node.exe");
  const executable = fs.existsSync(node) ? node : process.execPath;
  const result = childProcess.spawnSync(executable, [script, "--root", root, ...scriptArgs], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    ok: result.status === 0,
    parsed: parseJsonOutput(result.stdout),
  };
}

module.exports = {
  auditReleaseTree,
  collectReleaseFiles,
  hardForbiddenReason,
  listFilesRecursive,
  normalizeRel,
  parseJsonOutput,
  pathInside,
  readJson,
  releaseAuditSelfTest,
  runNode,
  sha256File,
  timestamp,
  toPosix,
  writeJson,
};
