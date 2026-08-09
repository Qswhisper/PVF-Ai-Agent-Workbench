"use strict";

const fs = require("fs");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { sha256File } = require("../lib/release-utils");

const rawArgs = process.argv.slice(2);
const rootArgIndex = rawArgs.indexOf("--root");
const workbenchRoot =
  rootArgIndex >= 0 && rawArgs[rootArgIndex + 1]
    ? path.resolve(rawArgs[rootArgIndex + 1])
    : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0] || "check";

function usage() {
  return `Usage:
  workbench.bat real-task-check check [--runs <dir>] [--out <dir>] [--strict] [--strict-encoding]
`;
}

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function rel(file) {
  return toPosix(path.relative(workbenchRoot, file));
}

function exists(value) {
  return value && fs.existsSync(path.resolve(value));
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  return [value];
}

function getPathValue(object, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), object);
}

function pushIfBooleanTrue(errors, warnings, summary, dottedPath, message) {
  const value = getPathValue(summary, dottedPath);
  if (value === true) {
    errors.push(message || `${dottedPath} must not be true.`);
  } else if (value !== undefined && value !== false && value !== null && value !== "not-applicable") {
    warnings.push(`${dottedPath} is present but not a clear false/null value: ${JSON.stringify(value)}`);
  }
}

function pathInside(root, file) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function reportPathExists(errors, warnings, label, value, required) {
  if (!value) {
    if (required) {
      errors.push(`${label} is required.`);
    }
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${label} must be a string path.`);
    return;
  }
  if (!path.isAbsolute(value)) {
    warnings.push(`${label} is not absolute: ${value}`);
  }
  if (!exists(value)) {
    errors.push(`${label} does not exist: ${value}`);
  }
}

function containsMojibake(value) {
  return /[�]|娓呴|鏋佺函|瀹㈡埛|绔痋|鐨|鍐|杈圭晫|闂幆|閫氳繃|璺緞|楠岃瘉|钀藉湴|浠诲姟|缁撹/.test(value);
}

function findSuspiciousEncoding(value, trail = "$", findings = []) {
  if (typeof value === "string") {
    if (containsMojibake(value)) {
      findings.push({ path: trail, value });
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSuspiciousEncoding(item, `${trail}[${index}]`, findings));
    return findings;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      findSuspiciousEncoding(item, `${trail}.${key}`, findings);
    }
  }
  return findings;
}

function sourceStateEntries(summary) {
  return [
    ...asArray(summary.sourcePvfFinal),
    ...asArray(summary.sourcePvfFinalState),
    ...asArray(summary.sourcePvfUnchanged),
  ].filter(isObject);
}

function sourceInitialEntries(summary) {
  return [
    ...asArray(summary.sourcePvfInitial),
    ...asArray(summary.sourcePvfInitialState),
  ].filter(isObject);
}

function validateSourceStates(errors, warnings, summary) {
  const finals = sourceStateEntries(summary);
  if (finals.length === 0) {
    warnings.push("No source PVF final-state entries were recorded.");
    return;
  }
  for (const [index, entry] of finals.entries()) {
    if (!entry.path) {
      warnings.push(`source final entry ${index} has no path.`);
    }
    if (entry.unchanged === false) {
      errors.push(`source final entry ${index} is marked unchanged=false.`);
    }
    if (entry.unchanged === undefined && summary.mode !== "read-only") {
      warnings.push(`source final entry ${index} has no unchanged flag.`);
    }
  }
}

function validateReadOnlyRun(errors, warnings, summary) {
  pushIfBooleanTrue(errors, warnings, summary, "sourcePvfWrite", "Read-only run must not set sourcePvfWrite=true.");
  pushIfBooleanTrue(errors, warnings, summary, "clientResourceWrite", "Read-only run must not set clientResourceWrite=true.");
  pushIfBooleanTrue(errors, warnings, summary, "write.authorized", "Read-only run must not authorize write.");
  pushIfBooleanTrue(errors, warnings, summary, "write.sourceOverwritten", "Read-only run must not overwrite source PVF.");
  pushIfBooleanTrue(errors, warnings, summary, "write.clientResourceWrite", "Read-only run must not write client resources.");
  pushIfBooleanTrue(errors, warnings, summary, "writeState.writeAuthorized", "Read-only run must not authorize write.");
  pushIfBooleanTrue(errors, warnings, summary, "writeState.sourceOverwritten", "Read-only run must not overwrite source PVF.");
  pushIfBooleanTrue(errors, warnings, summary, "writeState.clientResourceWrite", "Read-only run must not write client resources.");
  validateSourceStates(errors, warnings, summary);
}

function loadManifest(errors, label, file) {
  if (!file || typeof file !== "string") {
    errors.push(`${label} path is required.`);
    return null;
  }
  if (!fs.existsSync(path.resolve(file))) {
    errors.push(`${label} does not exist: ${file}`);
    return null;
  }
  try {
    return readJson(path.resolve(file));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function validateControlledOutputRun(errors, warnings, summary) {
  if (!isObject(summary.safety)) {
    errors.push("controlled-output run requires safety object.");
  } else {
    if (summary.safety.sourceOverwriteAllowed !== false) {
      errors.push("safety.sourceOverwriteAllowed must be false.");
    }
    if (summary.safety.sourceOverwritten !== false) {
      errors.push("safety.sourceOverwritten must be false.");
    }
    if (summary.safety.backupCreated !== true) {
      errors.push("safety.backupCreated must be true.");
    }
    if (summary.safety.explicitOutputPath !== true) {
      errors.push("safety.explicitOutputPath must be true.");
    }
    if (summary.safety.readbackExecuted !== true || summary.safety.readbackOk !== true) {
      errors.push("safety.readbackExecuted and safety.readbackOk must be true.");
    }
    if (summary.safety.clientResourceWrite !== false) {
      errors.push("safety.clientResourceWrite must be false.");
    }
  }

  reportPathExists(errors, warnings, "changeSet", summary.changeSet, true);
  reportPathExists(errors, warnings, "dryRunManifest", summary.dryRunManifest, true);
  reportPathExists(errors, warnings, "applyManifest", summary.applyManifest, true);
  reportPathExists(errors, warnings, "backupPath", summary.backupPath, true);
  reportPathExists(errors, warnings, "outputPvf", summary.outputPvf, true);

  const dryRun = loadManifest(errors, "dryRunManifest", summary.dryRunManifest);
  if (dryRun) {
    if (!["dry-run", "dry-run-only"].includes(dryRun.mode)) {
      warnings.push(`dryRunManifest.mode is ${JSON.stringify(dryRun.mode)}; expected dry-run or dry-run-only.`);
    }
    if (dryRun.writeOperationsExecuted !== false) {
      errors.push("dryRunManifest.writeOperationsExecuted must be false.");
    }
    if (dryRun.summary?.blockedCount !== 0) {
      errors.push("dryRunManifest.summary.blockedCount must be 0.");
    }
  }

  const apply = loadManifest(errors, "applyManifest", summary.applyManifest);
  if (apply) {
    if (!["apply", "controlled-output-only"].includes(apply.mode)) {
      warnings.push(`applyManifest.mode is ${JSON.stringify(apply.mode)}; expected apply or controlled-output-only.`);
    }
    if (apply.writeOperationsExecuted !== true) {
      errors.push("applyManifest.writeOperationsExecuted must be true.");
    }
    if (apply.safety?.sourceOverwriteAllowed !== false || apply.safety?.sourceOverwritten !== false) {
      errors.push("applyManifest safety must keep sourceOverwriteAllowed=false and sourceOverwritten=false.");
    }
    if (apply.safety?.clientResourceWrite !== false) {
      errors.push("applyManifest safety must keep clientResourceWrite=false.");
    }
    if (apply.summary?.outputExists !== true || apply.summary?.backupExists !== true || apply.summary?.readbackOk !== true) {
      errors.push("applyManifest summary must confirm outputExists, backupExists, and readbackOk.");
    }
    if (
      apply.safety?.outputSha256Bound !== true ||
      apply.summary?.outputSha256Verified !== true ||
      !/^[a-f0-9]{64}$/i.test(String(apply.outputPvfSha256 || ""))
    ) {
      errors.push("applyManifest must bind and verify the final outputPvfSha256.");
    } else if (apply.outputPvf && fs.existsSync(path.resolve(apply.outputPvf))) {
      if (sha256File(path.resolve(apply.outputPvf)) !== apply.outputPvfSha256) {
        errors.push("applyManifest outputPvfSha256 no longer matches the output PVF.");
      }
    }
  }

  const sourcePath = summary.profile?.sourcePvf || summary.sourcePvf || summary.target?.sourcePvf;
  if (summary.outputPvf && sourcePath && path.resolve(summary.outputPvf).toLowerCase() === path.resolve(sourcePath).toLowerCase()) {
    errors.push("outputPvf must not equal sourcePvf.");
  }
  validateSourceStates(errors, warnings, summary);
}

function validateRun(runDir) {
  const summaryFile = path.join(runDir, "SUMMARY.json");
  const readmeFile = path.join(runDir, "README.zh-CN.md");
  const result = {
    runId: path.basename(runDir),
    runDir,
    summaryPath: summaryFile,
    ok: true,
    warnings: [],
    errors: [],
    mode: null,
    taskId: null,
  };

  if (!fs.existsSync(summaryFile)) {
    result.errors.push("Missing SUMMARY.json.");
    result.ok = false;
    return result;
  }
  if (!fs.existsSync(readmeFile)) {
    result.warnings.push("Missing README.zh-CN.md.");
  }

  let summary;
  try {
    summary = readJson(summaryFile);
  } catch (error) {
    result.errors.push(`SUMMARY.json is not valid JSON: ${error.message}`);
    result.ok = false;
    return result;
  }

  result.mode = summary.mode || null;
  result.taskId = summary.taskId || null;
  if (summary.schemaVersion !== "1.0") {
    result.errors.push("schemaVersion must be 1.0.");
  }
  if (!summary.taskId || typeof summary.taskId !== "string") {
    result.errors.push("taskId is required.");
  }
  if (!["read-only", "controlled-output"].includes(summary.mode)) {
    result.errors.push("mode must be read-only or controlled-output.");
  }

  if (!Array.isArray(summary.limitations) && !Array.isArray(summary.risks)) {
    result.warnings.push("No limitations or risks array was recorded.");
  }
  if (sourceInitialEntries(summary).length === 0) {
    result.warnings.push("No source PVF initial-state entries were recorded.");
  }

  const encodingFindings = findSuspiciousEncoding(summary).slice(0, 10);
  if (encodingFindings.length > 0) {
    result.warnings.push(`Suspicious mojibake-like text found in ${encodingFindings.length} field(s).`);
    result.encodingFindings = encodingFindings;
  }

  if (summary.mode === "read-only") {
    validateReadOnlyRun(result.errors, result.warnings, summary);
  } else if (summary.mode === "controlled-output") {
    validateControlledOutputRun(result.errors, result.warnings, summary);
  }

  result.ok = result.errors.length === 0;
  return result;
}

function listRunDirs(runsRoot) {
  if (!fs.existsSync(runsRoot)) {
    throw new Error(`Real task runs directory does not exist: ${runsRoot}`);
  }
  return fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name))
    .sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

function runCheck() {
  const strict = flag("--strict");
  const strictEncoding = flag("--strict-encoding");
  const runsRoot = path.resolve(option("--runs", runtimePath(workbenchRoot, "real-task-runs")));
  const outRoot = path.resolve(option("--out", runtimePath(workbenchRoot, "real-task-checks", timestamp())));

  const runDirs = listRunDirs(runsRoot);
  const runs = runDirs.map(validateRun);
  if (strictEncoding) {
    for (const run of runs) {
      if (run.encodingFindings && run.encodingFindings.length > 0) {
        run.errors.push("Suspicious encoding findings are errors under --strict-encoding.");
        run.ok = false;
      }
    }
  }
  if (strict) {
    for (const run of runs) {
      if (run.warnings.length > 0) {
        run.errors.push("Warnings are errors under --strict.");
        run.ok = false;
      }
    }
  }

  const failed = runs.filter((run) => !run.ok).length;
  const warningCount = runs.reduce((total, run) => total + run.warnings.length, 0);
  const report = {
    schemaVersion: "1.0",
    phase: "phase-6-real-task-validation",
    generatedAt: new Date().toISOString(),
    workbenchRoot,
    runsRoot,
    reportPath: path.join(outRoot, "REAL-TASK-RUNS-CHECK-REPORT.json"),
    strict,
    strictEncoding,
    summary: {
      ok: failed === 0,
      runCount: runs.length,
      passed: runs.length - failed,
      failed,
      warnings: warningCount,
    },
    runs,
  };

  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.reportPath = rel(report.reportPath);
  return report;
}

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command !== "check") {
    throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
  const report = runCheck();
  output(report);
  if (!report.summary.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
