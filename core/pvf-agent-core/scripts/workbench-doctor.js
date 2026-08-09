"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadWorkspaceProfiles, resolveProfile } = require("../lib/workspace-profiles");
const indexStore = require("../lib/pvf-index-store");
const { runtimePath } = require("../lib/runtime-state");

const rawArgs = process.argv.slice(2);
const rootArgIndex = rawArgs.indexOf("--root");
const workbenchRoot =
  rootArgIndex >= 0 && rawArgs[rootArgIndex + 1]
    ? path.resolve(rawArgs[rootArgIndex + 1])
    : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0] || "check";

const REQUIRED_PLANNER_SCRIPTS = [
  "tools/pvf-bridge/dungeon-workflow.js",
  "tools/pvf-bridge/native-backend.js",
  "tools/pvf-bridge/extract-dungeon.js",
  "tools/pvf-bridge/import-dungeon-extract.js",
  "tools/pvf-bridge/package-dungeon-assets.js",
  "tools/pvf-bridge/compare-existing-dependencies.js",
  "tools/pvf-bridge/analyze-apc.js",
  "tools/pvf-bridge/plan-item-stackable-dependencies.js",
  "tools/pvf-bridge/pvf_graph_common.js",
  "tools/pvf-bridge/pvf-scope-planner.js",
  "tools/pvf-bridge/compare-dungeon-extracts.js",
  "tools/pvf-bridge/clean-client-compatible-extract.js",
  "tools/pvf-bridge/materialize-dungeon-preset.js",
];

const OPTIONAL_PLANNER_SCRIPTS = [];

function usage() {
  return `Usage:
  workbench.bat doctor check [--profile <name> | --all-profiles | --skip-profiles] [--scope itemshop] [--out <dir>] [--include-write-smoke] [--skip-release-gates] [--details]
  workbench.bat doctor release-manifest
  workbench.bat doctor package-dry-run
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function safeName(value) {
  return indexStore.safeName(value);
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function rel(file) {
  return toPosix(path.relative(workbenchRoot, file));
}

function exists(relativePath) {
  return fs.existsSync(path.join(workbenchRoot, relativePath));
}

function pathDetails(relativePaths) {
  return relativePaths.map((item) => ({ path: item, exists: exists(item) }));
}

function capabilityLevel(relativePaths) {
  const present = relativePaths.filter((item) => exists(item)).length;
  if (present === relativePaths.length) {
    return "PASS";
  }
  if (present > 0) {
    return "PARTIAL";
  }
  return "MISSING";
}

function buildCapabilityLevels() {
  const laneDefs = [
    {
      id: "cli-basic-lane",
      label: "CLI basic lane",
      required: true,
      files: [
        "runtime/node/node.exe",
        "workbench.bat",
        "core/pvf-agent-core/scripts/workbench.js",
        "core/pvf-agent-core/cli/pvf-readonly.js",
        "core/pvf-agent-core/cli/pvf-index.js",
        "core/pvf-agent-core/cli/pvf-change-set.js",
      ],
    },
    {
      id: "bundled-pvf-backend",
      label: "Bundled PVF backend",
      required: true,
      files: [
        "config/pvf-adapter.json",
        "tools/pvf-bridge/server.js",
        "tools/pvf-bridge/native-backend.js",
        "tools/pvf-bridge/native/pvf_rust_core.node",
        "tools/pvf-bridge/fallback/codec.ts",
        "tools/pvf-bridge/fallback/script.ts",
        "tools/pvf-bridge/fallback/ani.ts",
        "tools/pvf-bridge/fallback/pvf-readonly-backend.ts",
        "core/pvf-agent-core/contracts/typescript-readonly-backend-contract.v1.json",
        "core/pvf-agent-core/schemas/typescript-readonly-backend-contract.schema.json",
        "core/pvf-agent-core/scripts/fallback-backend-self-test.js",
      ],
      note: "Self-contained backend used by workbench.bat.",
    },
    {
      id: "bundled-domain-knowledge",
      label: "Bundled NUT, tag, and bookmark facts",
      required: true,
      files: [
        "knowledge-pack/indexes/nut-api-facts.compact.json",
        "knowledge-pack/indexes/pvf-tag-facts.compact.json",
        "knowledge-pack/indexes/pvf-task-bookmarks.compact.json",
      ],
    },
    {
      id: "controlled-write-lane",
      label: "Controlled write lane",
      required: true,
      files: [
        "workbench.bat",
        "config/write-policy.json",
        "core/pvf-agent-core/cli/pvf-change-set.js",
        "core/pvf-agent-core/schemas/pvf-change-set.schema.json",
      ],
    },
  ];
  const lanes = laneDefs.map((lane) => ({
    ...lane,
    level: capabilityLevel(lane.files),
    files: pathDetails(lane.files),
  }));
  lanes.push({
    id: "xpilot-planner-scripts",
    label: "X-Pilot planner scripts",
    required: true,
    level: capabilityLevel(REQUIRED_PLANNER_SCRIPTS),
    files: pathDetails(REQUIRED_PLANNER_SCRIPTS),
    optionalFiles: pathDetails(OPTIONAL_PLANNER_SCRIPTS),
    note: "Portable X-Pilot planner cohort carried by this Workbench. These scripts are helpers; PVF writes still go through the controlled write lane.",
  });
  return {
    lanes,
    summary: {
      pass: lanes.filter((lane) => lane.level === "PASS").length,
      partial: lanes.filter((lane) => lane.level === "PARTIAL").length,
      missing: lanes.filter((lane) => lane.level === "MISSING").length,
      external: lanes.filter((lane) => /EXTERNAL$/.test(lane.level)).length,
    },
  };
}

function isAgentWorkspaceMode() {
  return exists("release/AGENT-WORKSPACE-MANIFEST.json");
}

function warning(details) {
  return { ...details, ok: true, warning: true };
}

function runNodeScript(scriptRelativePath, scriptArgs = [], timeoutMs = 120000) {
  const script = path.join(workbenchRoot, scriptRelativePath);
  const result = childProcess.spawnSync(process.execPath, [script, "--root", workbenchRoot, ...scriptArgs], {
    cwd: workbenchRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    command: `node ${scriptRelativePath}`,
    exitCode: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    ok: result.status === 0,
  };
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function record(checks, id, fn) {
  try {
    const details = await fn();
    checks.push({ id, ok: true, details: details || {} });
  } catch (error) {
    checks.push({ id, ok: false, error: error && error.stack ? error.stack : String(error) });
  }
}

function selectProfiles() {
  const registry = loadWorkspaceProfiles(workbenchRoot);
  const requested = option("--profile");
  if (requested) {
    return [resolveProfile(workbenchRoot, requested)];
  }
  if (flag("--all-profiles")) {
    return registry.profiles.filter((profile) => profile.enabled === true);
  }
  if (registry.activeProfile) {
    return [resolveProfile(workbenchRoot, registry.activeProfile)];
  }
  return registry.profiles.filter((profile) => profile.enabled === true);
}

function validateProfile(profile) {
  const errors = [];
  const warnings = [];
  if (!profile) {
    errors.push("Profile is missing.");
    return { errors, warnings };
  }
  if (profile.enabled !== true) {
    warnings.push("Profile is not enabled.");
  }
  if (!profile.sourcePvf || !fs.existsSync(path.resolve(profile.sourcePvf))) {
    errors.push(`sourcePvf does not exist: ${profile.sourcePvf}`);
  }
  if (!profile.output) {
    errors.push("output is required.");
  } else if (!fs.existsSync(path.resolve(profile.output))) {
    warnings.push(`output directory does not exist yet: ${profile.output}`);
  }
  if (profile.materials) {
    const materials = Array.isArray(profile.materials) ? profile.materials : [profile.materials];
    for (const materialPath of materials) {
      if (materialPath && !fs.existsSync(path.resolve(materialPath))) {
        warnings.push(`materials path does not exist: ${materialPath}`);
      }
    }
  }
  if (profile.client && !fs.existsSync(path.resolve(profile.client))) {
    warnings.push(`client path does not exist: ${profile.client}`);
  }
  if (profile.safety?.defaultMode !== "read-only") {
    errors.push("safety.defaultMode must be read-only.");
  }
  if (profile.safety?.writeMode?.enabled !== false) {
    errors.push("safety.writeMode.enabled must remain false for portable cold-start.");
  }
  if (profile.safety?.clientWrite?.enabled !== false) {
    errors.push("safety.clientWrite.enabled must remain false for portable cold-start.");
  }
  return { errors, warnings };
}

function loadReleaseManifest() {
  const file = path.join(workbenchRoot, "release", "PORTABLE-RELEASE-MANIFEST.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Missing PORTABLE-RELEASE-MANIFEST.json: ${file}`);
  }
  return { file, manifest: readJson(file) };
}

function validateReleaseManifest() {
  const loaded = loadReleaseManifest();
  const manifest = loaded.manifest;
  const errors = [];
  const warnings = [];
  if (manifest.schemaVersion !== "1.0") {
    errors.push("schemaVersion must be 1.0.");
  }
  if (manifest.phase !== "agent-workspace-portable-release") {
    errors.push("phase must be agent-workspace-portable-release.");
  }
  const version = fs.readFileSync(path.join(workbenchRoot, "VERSION"), "utf8").trim();
  if (manifest.packageVersion !== version) {
    errors.push(`packageVersion must match VERSION: ${manifest.packageVersion} != ${version}`);
  }
  const include = manifest.portableCore?.include || [];
  if (!Array.isArray(include) || include.length === 0) {
    errors.push("portableCore.include must not be empty.");
  }
  const forbiddenIncludePattern = /(^|\/)(config\/providers\.local\.json|config\/workspace-profiles\.local\.json|workspaces\/(dry-runs|apply-runs|backend-contract-runs|backend-fixture-runs|first-run-reports|real-task-runs|real-task-checks|absorption-checklists|agent-eval-runs|agent-workspace-stages|runtime-overlay-dry-runs|runtime-overlay-stages|stage-copy-dry-runs|cold-start-dry-runs|doctor-runs|planner-runs|package-dry-runs|release-runs|indexes)\/)|\.(pvf|bak|npk|img|zip|7z|rar)$/i;
  const generatedReadmeExceptionPattern = /^workspaces\/(absorption-checklists|agent-eval-runs|doctor-runs|planner-runs|package-dry-runs|release-runs|indexes)\/README\.zh-CN\.md$/i;
  for (const item of include) {
    if (path.isAbsolute(item) || String(item).includes("..")) {
      errors.push(`portableCore.include must be relative and safe: ${item}`);
      continue;
    }
    if (forbiddenIncludePattern.test(toPosix(item)) && !generatedReadmeExceptionPattern.test(toPosix(item))) {
      errors.push(`portableCore.include contains local/generated/heavy artifact: ${item}`);
    }
    if (!exists(item)) {
      errors.push(`portableCore.include path is missing: ${item}`);
    }
  }
  const excluded = [
    ...(manifest.exclude?.localPrivate || []),
    ...(manifest.exclude?.generatedOutputs || []),
    ...(manifest.exclude?.mountedUserData || []),
    ...(manifest.exclude?.heavyArtifacts || []),
  ];
  for (const required of ["config/providers.local.json", "config/workspace-profiles.local.json", "workspaces/backend-contract-runs/", "workspaces/backend-fixture-runs/", "workspaces/first-run-reports/", "workspaces/real-task-runs/", "workspaces/real-task-checks/", "workspaces/agent-eval-runs/", "workspaces/agent-workspace-stages/", "workspaces/runtime-overlay-dry-runs/", "workspaces/runtime-overlay-stages/", "workspaces/stage-copy-dry-runs/", "workspaces/cold-start-dry-runs/", "workspaces/planner-runs/", "workspaces/package-dry-runs/", "workspaces/release-runs/", "*.pvf"]) {
    if (!excluded.includes(required)) {
      warnings.push(`release manifest does not explicitly exclude ${required}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return {
    manifestPath: loaded.file,
    includeCount: include.length,
    excludeCount: excluded.length,
    warnings,
  };
}

function indexCatalogSummary(profile) {
  const catalog = indexStore.loadIndexCatalog(workbenchRoot, { profile: profile.name });
  const entries = catalog.entries || [];
  const statuses = [];
  for (const entry of entries) {
    try {
      const status = indexStore.indexStatus(workbenchRoot, {
        profile: profile.name,
        scope: entry.scopeName === "latest" ? undefined : entry.scopeName,
      });
      statuses.push({
        scopeName: entry.scopeName,
        indexDir: status.indexDir,
        fresh: status.fresh,
        checks: status.checks,
      });
    } catch (error) {
      statuses.push({
        scopeName: entry.scopeName,
        fresh: false,
        error: error.message,
      });
    }
  }
  return {
    exists: catalog.exists,
    entryCount: entries.length,
    entries: statuses,
  };
}

function runBackendContract(profile, runRoot, scope, includeWriteSmoke, skipIndex) {
  const outDir = path.join(runRoot, "backend-contract", safeName(profile.name));
  const contractArgs = ["check", "--profile", profile.name, "--scope", scope, "--out", outDir];
  if (skipIndex) {
    contractArgs.push("--skip-index");
  }
  if (includeWriteSmoke) {
    contractArgs.push("--include-write-smoke");
  }
  const result = runNodeScript("core/pvf-agent-core/cli/pvf-backend-contract.js", contractArgs, includeWriteSmoke ? 10 * 60 * 1000 : 180000);
  const parsed = parseJsonOutput(result.stdout);
  const summary = {
    ok: result.ok && parsed?.summary?.ok === true,
    exitCode: result.exitCode,
    reportPath: parsed?.reportPath || null,
    summary: parsed?.summary || null,
  };
  if (!summary.ok) {
    summary.stdoutTail = result.stdout.slice(-2000);
    summary.stderr = result.stderr;
  }
  return summary;
}

function catalogHasScopeIndex(catalogSummary, scope) {
  if (!catalogSummary?.exists) {
    return false;
  }
  return (catalogSummary.entries || []).some((entry) => entry.scopeName === scope && !entry.error);
}

function runPackageDryRun(runRoot) {
  const outDir = path.join(runRoot, "package-dry-run");
  const result = runNodeScript("core/pvf-agent-core/scripts/portable-package-dry-run.js", ["check", "--out", outDir]);
  const parsed = parseJsonOutput(result.stdout);
  const summary = {
    ok: result.ok && parsed?.summary?.ok === true,
    exitCode: result.exitCode,
    reportPath: parsed?.reportPath || null,
    summary: parsed?.summary || null,
  };
  if (!summary.ok) {
    summary.stdoutTail = result.stdout.slice(-2000);
    summary.stderr = result.stderr;
  }
  return summary;
}

function runAgentEvalSelfTest(runRoot) {
  const outDir = path.join(runRoot, "agent-eval-self-test");
  const result = runNodeScript("core/pvf-agent-core/scripts/agent-eval.js", ["self-test", "--out", outDir]);
  const parsed = parseJsonOutput(result.stdout);
  return {
    ok: result.ok && parsed?.summary?.ok === true,
    exitCode: result.exitCode,
    reportPath: parsed?.reportPath || null,
    summary: parsed?.summary || null,
    stdoutTail: result.ok ? undefined : result.stdout.slice(-2000),
    stderr: result.stderr || undefined,
  };
}

function runAgentSkillSelfTest() {
  const result = runNodeScript("core/pvf-agent-core/scripts/install-agent-skill.js", ["self-test"]);
  const parsed = parseJsonOutput(result.stdout);
  return {
    ok: result.ok && parsed?.summary?.ok === true,
    exitCode: result.exitCode,
    summary: parsed?.summary || null,
    checks: parsed?.checks || null,
    stdoutTail: result.ok ? undefined : result.stdout.slice(-2000),
    stderr: result.stderr || undefined,
  };
}

function runFallbackSelfTest() {
  const result = runNodeScript("core/pvf-agent-core/scripts/fallback-backend-self-test.js", []);
  const parsed = parseJsonOutput(result.stdout);
  return {
    ok: result.ok && parsed?.summary?.ok === true,
    exitCode: result.exitCode,
    summary: parsed?.summary || null,
    checks: parsed?.checks || null,
    stdoutTail: result.ok ? undefined : result.stdout.slice(-2000),
    stderr: result.stderr || undefined,
  };
}

async function runCheck() {
  const runRoot = option("--out")
    ? path.resolve(option("--out"))
    : runtimePath(workbenchRoot, "doctor-runs", timestamp());
  fs.mkdirSync(runRoot, { recursive: true });

  const scope = option("--scope", "itemshop");
  const includeWriteSmoke = flag("--include-write-smoke");
  const skipProfiles = flag("--skip-profiles");
  const skipReleaseGates = flag("--skip-release-gates");
  const agentWorkspaceMode = isAgentWorkspaceMode();
  const checks = [];

  await record(checks, agentWorkspaceMode ? "agent-workspace.required-files" : "phase5.required-files", async () => {
    const required = agentWorkspaceMode
      ? [
          "release/AGENT-WORKSPACE-MANIFEST.json",
          ".gitattributes",
          "AGENTS.md",
          "LICENSE",
          "LICENSE-KNOWLEDGE-CC0.md",
          "README.md",
          "README.zh-CN.md",
          "docs/CLEAN-COPY.zh-CN.md",
          "docs/READONLY-FALLBACK.zh-CN.md",
          "VERSION",
          "CHANGELOG.zh-CN.md",
          "release/PORTABLE-RELEASE-MANIFEST.json",
          "docs/release/RELEASE-GATE-1.zh-CN.md",
          "docs/release/RELEASE-GATE-2.zh-CN.md",
          "docs/release/RELEASE-GATE-3.zh-CN.md",
          "workbench.bat",
          "commands/agent-eval.bat",
          "commands/install-agent-skill.bat",
          "commands/portable-package-dry-run.bat",
          "commands/portable-stage-copy-dry-run.bat",
          "commands/portable-cold-start-dry-run.bat",
          "commands/workbench-doctor.bat",
          "commands/check-env.bat",
          "commands/check-real-task-runs.bat",
          "commands/check-backend-fixtures.bat",
          "commands/workbench-profile.bat",
          "commands/runtime-absorb-checklist.bat",
          "commands/pvf-readonly.bat",
          "commands/pvf-change-set.bat",
          "commands/pvf-index.bat",
          "commands/pvf-backend-contract.bat",
          "runtime/node/node.exe",
          "config/pvf-adapter.json",
          "knowledge-pack/indexes/nut-api-facts.compact.json",
          "knowledge-pack/indexes/pvf-tag-facts.compact.json",
          "knowledge-pack/indexes/pvf-task-bookmarks.compact.json",
          "tools/pvf-bridge/server.js",
          "tools/pvf-bridge/native-backend.js",
          "tools/pvf-bridge/native/pvf_rust_core.node",
          "tools/pvf-bridge/fallback/codec.ts",
          "tools/pvf-bridge/fallback/script.ts",
          "tools/pvf-bridge/fallback/ani.ts",
          "tools/pvf-bridge/fallback/pvf-readonly-backend.ts",
          ".agents/skills/dnf-pvf-xpilot/SKILL.md",
          ".agents/skills/dnf-pvf-xpilot/agents/openai.yaml",
          ...REQUIRED_PLANNER_SCRIPTS,
          "core/pvf-agent-core/scripts/workbench-doctor.js",
          "core/pvf-agent-core/scripts/workbench.js",
          "core/pvf-agent-core/scripts/workbench-profile.js",
          "core/pvf-agent-core/scripts/runtime-absorb-checklist.js",
          "core/pvf-agent-core/scripts/resolve-node.bat",
          "core/pvf-agent-core/scripts/check-real-task-runs.js",
          "core/pvf-agent-core/scripts/check-backend-fixtures.js",
          "core/pvf-agent-core/scripts/agent-eval.js",
          "core/pvf-agent-core/scripts/install-agent-skill.js",
          "core/pvf-agent-core/scripts/portable-package-dry-run.js",
          "core/pvf-agent-core/scripts/portable-stage-copy-dry-run.js",
          "core/pvf-agent-core/scripts/portable-cold-start-dry-run.js",
          "core/pvf-agent-core/scripts/fallback-backend-self-test.js",
          "core/pvf-agent-core/scripts/fallback-backend-differential.js",
          "core/pvf-agent-core/lib/release-utils.js",
          "core/pvf-agent-core/lib/runtime-state.js",
          "core/pvf-agent-core/lib/agent-skill.js",
          "core/pvf-agent-core/schemas/workbench-doctor-report.schema.json",
          "core/pvf-agent-core/schemas/real-task-runs-check-report.schema.json",
          "core/pvf-agent-core/schemas/backend-fixtures-check-report.schema.json",
          "core/pvf-agent-core/schemas/agent-eval-suite.schema.json",
          "core/pvf-agent-core/schemas/agent-eval-report.schema.json",
          "core/pvf-agent-core/schemas/portable-release-manifest.schema.json",
          "core/pvf-agent-core/schemas/portable-package-dry-run-report.schema.json",
          "core/pvf-agent-core/schemas/portable-stage-copy-dry-run-report.schema.json",
          "core/pvf-agent-core/schemas/portable-cold-start-dry-run-report.schema.json",
          "core/pvf-agent-core/contracts/pvf-backend-contract.v1.json",
          "core/pvf-agent-core/contracts/typescript-readonly-backend-contract.v1.json",
          "core/pvf-agent-core/schemas/typescript-readonly-backend-contract.schema.json",
          "core/pvf-agent-core/contracts/fixtures/apc-swordman-gsd.fixture.json",
          "core/pvf-agent-core/contracts/fixtures/itemshop-birken.fixture.json",
          "core/pvf-agent-core/contracts/fixtures/skill-swordman-bloodyrave.fixture.json",
          "core/pvf-agent-core/contracts/fixtures/dungeon-draconiantower.fixture.json",
          "workspaces/planner-runs/README.zh-CN.md",
          "workspaces/agent-eval-runs/README.zh-CN.md",
          "workspaces/release-runs/README.zh-CN.md",
          "evals/agent/README.zh-CN.md",
          "evals/agent/suite.json",
        ]
      : [
          "workbench-doctor.bat",
          "portable-package-dry-run.bat",
          "COLD-START.zh-CN.md",
          "PORTABLE-RELEASE-MANIFEST.json",
          "RELEASE-GATE-1.zh-CN.md",
          "RELEASE-GATE-2.zh-CN.md",
          "RELEASE-GATE-3.zh-CN.md",
          "start-here.bat",
          "portable-stage-copy-dry-run.bat",
          "portable-cold-start-dry-run.bat",
          "portable-runtime-overlay-dry-run.bat",
          "portable-runtime-overlay-stage.bat",
          "check-real-task-runs.bat",
          "check-backend-fixtures.bat",
          "core/pvf-agent-core/scripts/workbench-doctor.js",
          "core/pvf-agent-core/scripts/first-run.js",
          "core/pvf-agent-core/scripts/resolve-node.bat",
          "core/pvf-agent-core/scripts/portable-package-dry-run.js",
          "core/pvf-agent-core/scripts/portable-stage-copy-dry-run.js",
          "core/pvf-agent-core/scripts/portable-cold-start-dry-run.js",
          "core/pvf-agent-core/scripts/portable-runtime-overlay.js",
          "core/pvf-agent-core/scripts/check-real-task-runs.js",
          "core/pvf-agent-core/scripts/check-backend-fixtures.js",
          "core/pvf-agent-core/schemas/workbench-doctor-report.schema.json",
          "core/pvf-agent-core/schemas/portable-release-manifest.schema.json",
          "core/pvf-agent-core/schemas/portable-package-dry-run-report.schema.json",
          "core/pvf-agent-core/schemas/portable-stage-copy-dry-run-report.schema.json",
          "core/pvf-agent-core/schemas/portable-cold-start-dry-run-report.schema.json",
          "core/pvf-agent-core/schemas/portable-runtime-overlay-report.schema.json",
          "core/pvf-agent-core/schemas/real-task-runs-check-report.schema.json",
          "core/pvf-agent-core/schemas/backend-fixtures-check-report.schema.json",
          "core/pvf-agent-core/schemas/typescript-readonly-backend-contract.schema.json",
          "core/pvf-agent-core/contracts/pvf-backend-contract.v1.json",
          "core/pvf-agent-core/contracts/typescript-readonly-backend-contract.v1.json",
          "core/pvf-agent-core/contracts/fixtures/apc-swordman-gsd.fixture.json",
          "core/pvf-agent-core/contracts/fixtures/itemshop-birken.fixture.json",
          "core/pvf-agent-core/contracts/fixtures/skill-swordman-bloodyrave.fixture.json",
          "core/pvf-agent-core/contracts/fixtures/dungeon-draconiantower.fixture.json",
        ];
    const missing = required.filter((item) => !exists(item));
    if (missing.length > 0) {
      throw new Error(`Missing required file(s): ${missing.join(", ")}`);
    }
    return { requiredCount: required.length };
  });

  await record(checks, "env.check", async () => {
    const result = runNodeScript("core/pvf-agent-core/scripts/check-env.js");
    if (!result.ok) {
      throw new Error(`${result.stderr}\n${result.stdout}`);
    }
    return {
      exitCode: result.exitCode,
      warnings: result.stdout.split(/\r?\n/).filter((line) => line.startsWith("WARN ")),
      passLine: result.stdout.split(/\r?\n/).find((line) => line.startsWith("PASS ")),
    };
  });

  await record(checks, "knowledge-pack.check", async () => {
    const result = runNodeScript("core/pvf-agent-core/scripts/check-knowledge-pack.js");
    if (!result.ok) {
      throw new Error(`${result.stderr}\n${result.stdout}`);
    }
    return {
      exitCode: result.exitCode,
      warnings: result.stdout.split(/\r?\n/).filter((line) => line.startsWith("WARN ")),
      passLine: result.stdout.split(/\r?\n/).find((line) => line.startsWith("PASS ")),
    };
  });

  await record(checks, "capability-levels", async () => {
    const levels = buildCapabilityLevels();
    const blocking = levels.lanes.filter((lane) => lane.required === true && lane.level !== "PASS");
    if (blocking.length > 0) {
      throw new Error(
        `Required capability lane(s) are not PASS: ${blocking
          .map((lane) => `${lane.id}=${lane.level}`)
          .join(", ")}`
      );
    }
    return levels;
  });

  if (!skipReleaseGates) {
    await record(checks, "release-manifest.check", async () => validateReleaseManifest());

    await record(checks, "release-gate.package-dry-run", async () => {
      const result = runPackageDryRun(runRoot);
      if (!result.ok) {
        throw new Error(`Portable package dry-run failed.\n${result.stderr}\n${result.stdoutTail}`);
      }
      return result;
    });
  }

  await record(checks, "agent-skill.self-test", async () => {
    const result = runAgentSkillSelfTest();
    if (!result.ok) {
      throw new Error(`Agent Skill self-test failed.\n${result.stderr}\n${result.stdoutTail}`);
    }
    return result;
  });

  await record(checks, "readonly-fallback.self-test", async () => {
    const result = runFallbackSelfTest();
    if (!result.ok) {
      throw new Error(`Read-only fallback self-test failed.\n${result.stderr || ""}\n${result.stdoutTail || ""}`);
    }
    return result;
  });

  await record(checks, "agent-eval.self-test", async () => {
    const result = runAgentEvalSelfTest(runRoot);
    if (!result.ok) {
      throw new Error(`Agent eval self-test failed.\n${result.stderr}\n${result.stdoutTail}`);
    }
    return result;
  });

  const profiles = skipProfiles ? [] : selectProfiles();
  await record(checks, "workspace-profiles.select", async () => {
    if (skipProfiles) {
      return warning({
        selectedProfiles: [],
        skipped: true,
        warnings: ["Profile and PVF backend-contract checks were skipped by --skip-profiles."],
      });
    }
    if (profiles.length === 0) {
      if (agentWorkspaceMode) {
        return warning({
          selectedProfiles: [],
          warnings: ["No enabled/selected workspace profiles were found; direct --pvf commands can still be used."],
        });
      }
      throw new Error("No enabled/selected workspace profiles were found.");
    }
    return {
      selectedProfiles: profiles.map((profile) => ({
        name: profile.name,
        source: profile.profileSource,
        sourcePvf: profile.sourcePvf,
      })),
    };
  });

  for (const profile of profiles) {
    await record(checks, `profile.${profile.name}.safety-paths`, async () => {
      const validation = validateProfile(profile);
      if (validation.errors.length > 0) {
        throw new Error(validation.errors.join("\n"));
      }
      return {
        sourcePvf: profile.sourcePvf,
        output: profile.output,
        warnings: validation.warnings,
      };
    });

    const catalogSummary = indexCatalogSummary(profile);
    const skipIndexContract = !catalogHasScopeIndex(catalogSummary, scope);

    await record(checks, `profile.${profile.name}.index-catalog`, async () => catalogSummary);

    await record(checks, `profile.${profile.name}.backend-contract`, async () => {
      const result = runBackendContract(profile, runRoot, scope, includeWriteSmoke, skipIndexContract);
      if (!result.ok) {
        throw new Error(`Backend contract failed for ${profile.name}\n${result.stderr}\n${result.stdoutTail}`);
      }
      return {
        ...result,
        skipIndex: skipIndexContract,
        warnings: skipIndexContract
          ? [`No local index for scope "${scope}"; backend contract ran with --skip-index. Build one with workbench.bat pvf-index build --profile ${profile.name} --scope ${scope} --prefix ${scope}.`]
          : [],
      };
    });
  }

  const failed = checks.filter((check) => !check.ok).length;
  const warningCount = checks.reduce((sum, check) => {
    const detailsWarnings = Array.isArray(check.details?.warnings) ? check.details.warnings.length : 0;
    return sum + (check.warning ? 1 : 0) + detailsWarnings;
  }, 0);
  const reportPath = path.join(runRoot, "WORKBENCH-DOCTOR-REPORT.json");
  const report = {
    schemaVersion: "1.0",
    phase: agentWorkspaceMode ? "agent-workspace" : "phase-5-portable-cold-start",
    generatedAt: new Date().toISOString(),
    workbenchRoot,
    reportPath,
    scope,
    includeWriteSmoke,
    skipProfiles,
    skipReleaseGates,
    summary: {
      ok: failed === 0,
      passed: checks.filter((check) => check.ok).length,
      failed,
      warnings: warningCount,
      profileCount: profiles.length,
    },
    checks,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  output(flag("--details") ? report : {
    schemaVersion: report.schemaVersion,
    phase: report.phase,
    reportPath,
    summary: report.summary,
    failedChecks: checks.filter((check) => !check.ok),
    warningChecks: checks
      .filter((check) => check.warning === true || check.details?.warning === true)
      .map((check) => ({ id: check.id, warnings: check.details?.warnings || [] })),
  });
  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  if (command === "help" || command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "release-manifest") {
    output({
      ok: true,
      releaseManifest: validateReleaseManifest(),
    });
    return;
  }
  if (command === "package-dry-run") {
    const runRoot = option("--out")
      ? path.resolve(option("--out"))
      : runtimePath(workbenchRoot, "doctor-runs", timestamp());
    fs.mkdirSync(runRoot, { recursive: true });
    output({
      ok: true,
      packageDryRun: runPackageDryRun(runRoot),
    });
    return;
  }
  if (command === "check") {
    await runCheck();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
