"use strict";

const fs = require("fs");
const path = require("path");
const {
  hardForbiddenReason,
  listFilesRecursive,
  normalizeRel,
  runNode,
  sha256File,
  timestamp,
  writeJson,
} = require("../lib/release-utils");
const { runtimePath } = require("../lib/runtime-state");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = args[0] || "check";

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function main() {
  if (command !== "check") throw new Error("Usage: workbench.bat release gate2 [--out <dir>] [--details]");
  const outRoot = path.resolve(option("--out", runtimePath(workbenchRoot, "release-runs", timestamp(), "gate2")));
  const packageRun = runNode(workbenchRoot, "core/pvf-agent-core/scripts/portable-package-dry-run.js", ["check", "--out", path.join(outRoot, "gate1"), "--details"], 180000);
  const errors = [];
  const warnings = [];
  if (!packageRun.ok || packageRun.parsed?.summary?.ok !== true) errors.push("Release Gate 1 failed.");

  const stageDir = path.join(outRoot, "stage");
  const copiedFiles = [];
  if (errors.length === 0) {
    if (fs.existsSync(stageDir)) throw new Error(`Stage already exists: ${stageDir}`);
    for (const item of packageRun.parsed.includedFiles) {
      const relPath = normalizeRel(item.path);
      const source = path.join(workbenchRoot, relPath);
      const target = path.join(stageDir, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      const stat = fs.statSync(target);
      const sha256 = sha256File(target);
      if (stat.size !== item.bytes) errors.push(`Size mismatch: ${relPath}`);
      if (sha256 !== item.sha256) errors.push(`SHA-256 mismatch: ${relPath}`);
      copiedFiles.push({ path: relPath, bytes: stat.size, sha256 });
    }
  }

  const forbidden = [];
  let copiedBytes = 0;
  if (fs.existsSync(stageDir)) {
    for (const file of listFilesRecursive(stageDir)) {
      copiedBytes += fs.statSync(file).size;
      const relPath = normalizeRel(path.relative(stageDir, file));
      const reason = hardForbiddenReason(relPath);
      if (reason) forbidden.push({ path: relPath, reason });
    }
  }
  if (forbidden.length > 0) errors.push(`Stage contains ${forbidden.length} forbidden file(s).`);
  const expectedCount = packageRun.parsed?.summary?.includedFileCount || 0;
  const expectedBytes = packageRun.parsed?.summary?.includedBytes || 0;
  if (copiedFiles.length !== expectedCount) errors.push(`Copied file count mismatch: ${copiedFiles.length} != ${expectedCount}`);
  if (copiedBytes !== expectedBytes) errors.push(`Copied byte count mismatch: ${copiedBytes} != ${expectedBytes}`);

  const reportPath = path.join(outRoot, "PORTABLE-STAGE-COPY-DRY-RUN-REPORT.json");
  const report = {
    schemaVersion: "1.0",
    phase: "release-gate-2-stage-copy-dry-run",
    generatedAt: new Date().toISOString(),
    dryRunOnly: true,
    workbenchRoot,
    outRoot,
    stageDir,
    reportPath,
    gate1ReportPath: packageRun.parsed?.reportPath || null,
    summary: {
      ok: errors.length === 0,
      packageDryRunOk: packageRun.ok,
      copiedFileCount: copiedFiles.length,
      copiedBytes,
      forbiddenStagedFileCount: forbidden.length,
      errorCount: errors.length,
      warningCount: warnings.length,
    },
    forbidden,
    copiedFiles,
    errors,
    warnings,
  };
  writeJson(reportPath, report);
  const visible = flag("--details") ? report : {
    schemaVersion: report.schemaVersion,
    phase: report.phase,
    stageDir,
    reportPath,
    gate1ReportPath: report.gate1ReportPath,
    summary: report.summary,
    errors,
    warnings,
  };
  process.stdout.write(`${JSON.stringify(visible, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
