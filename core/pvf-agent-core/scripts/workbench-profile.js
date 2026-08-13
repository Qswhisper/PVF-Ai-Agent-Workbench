"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ensureWorkspaceProfilesState,
  loadWorkspaceProfiles,
  resolveProfile,
  selectedLocalProfilesConfig,
  writeLocalWorkspaceProfiles,
} = require("../lib/workspace-profiles");

const rawArgs = process.argv.slice(2);
const rootArgIndex = rawArgs.indexOf("--root");
const workbenchRoot =
  rootArgIndex >= 0 && rawArgs[rootArgIndex + 1]
    ? path.resolve(rawArgs[rootArgIndex + 1])
    : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0] || "help";

function usage() {
  return `Usage:
  workbench.bat profile status
  workbench.bat profile list
  workbench.bat profile show [--name <profile>]
  workbench.bat profile select --name <profile>
  workbench.bat profile init --name <profile> --workspace <dir> --source-pvf <Script.pvf> --output <dir> [--client <dir>] [--materials <dir>] [--set-active] [--force]
  workbench.bat profile self-test

Notes:
  Local profiles are written outside the Workbench under PVF-Agent-Workbench-State.
  A legacy config/workspace-profiles.local.json is copied there on the first profile command.
  Use one profile per test client. The client field records the client root containing Script.pvf.
  Client writes remain off by default; workbench.bat client-pvf requires a separate preview and confirmation.
`;
}

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function values(name) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      result.push(args[index + 1]);
      index += 1;
    }
  }
  return result;
}

function flag(name) {
  return args.includes(name);
}

function requireOption(name) {
  const value = option(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function localProfilesPath() {
  return selectedLocalProfilesConfig(workbenchRoot).path;
}

function readLocalConfig() {
  const selected = selectedLocalProfilesConfig(workbenchRoot);
  if (!selected.data) {
    return {
      schemaVersion: "1.0",
      activeProfile: null,
      profiles: [],
    };
  }
  return selected.data;
}

function writeLocalConfig(config) {
  ensureWorkspaceProfilesState(workbenchRoot);
  return writeLocalWorkspaceProfiles(workbenchRoot, config);
}

function normalizePath(value) {
  return path.resolve(String(value || ""));
}

function validateProfileName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Profile name must use only ASCII letters, numbers, dot, underscore, or dash.");
  }
}

function defaultSafety() {
  return {
    defaultMode: "read-only",
    writeMode: {
      enabled: false,
      requiresTargetPvfConfirmation: true,
      requiresTimestampedBackup: true,
      requiresExplicitOutputPath: true,
      requiresReadback: true,
    },
    clientWrite: {
      enabled: false,
      requiresSeparateAuthorization: true,
    },
  };
}

function pathStatus(file) {
  if (!file) {
    return null;
  }
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
  } catch {
    return { path: file, exists: false, kind: null };
  }
}

function summarizeProfile(profile) {
  return {
    name: profile.name,
    enabled: profile.enabled,
    active: false,
    profileSource: profile.profileSource || "local",
    workspace: profile.workspace,
    sourcePvf: profile.sourcePvf,
    output: profile.output,
    client: profile.client || null,
    materials: profile.materials || null,
    pvfEncoding: profile.pvfEncoding,
    pathStatus: {
      workspace: pathStatus(profile.workspace),
      sourcePvf: pathStatus(profile.sourcePvf),
      output: pathStatus(profile.output),
      client: pathStatus(profile.client),
    },
  };
}

function commandStatus() {
  const registry = loadWorkspaceProfiles(workbenchRoot);
  const active = registry.activeProfile ? registry.get(registry.activeProfile) : null;
  printJson({
    ok: true,
    command: "status",
    workbenchRoot,
    localProfilesPath: registry.localProfilesPath,
    localProfilesExists: Boolean(registry.localProfilesSource),
    localProfilesSource: registry.localProfilesSource,
    legacyMigrationPending: registry.localProfilesSource === "legacy-local",
    activeProfile: registry.activeProfile || null,
    activeProfileSource: active?.profileSource || null,
    profileCount: registry.profiles.length,
    enabledProfiles: registry.profiles.filter((profile) => profile.enabled === true).map((profile) => profile.name),
    hint: registry.activeProfile ? null : "Run workbench.bat profile init ... --set-active or workbench.bat profile select --name <profile>.",
  });
}

function commandList() {
  const registry = loadWorkspaceProfiles(workbenchRoot);
  printJson({
    ok: true,
    command: "list",
    activeProfile: registry.activeProfile || null,
    profiles: registry.profiles.map((profile) => ({
      ...summarizeProfile(profile),
      active: profile.name === registry.activeProfile,
    })),
  });
}

function commandShow() {
  const registry = loadWorkspaceProfiles(workbenchRoot);
  const name = option("--name", registry.activeProfile);
  if (!name) {
    throw new Error("No profile selected. Provide --name or select an active profile.");
  }
  const profile = resolveProfile(workbenchRoot, name);
  printJson({
    ok: true,
    command: "show",
    activeProfile: registry.activeProfile || null,
    profile: {
      ...summarizeProfile(profile),
      active: profile.name === registry.activeProfile,
    },
  });
}

function commandSelect() {
  const name = requireOption("--name");
  validateProfileName(name);
  const registry = loadWorkspaceProfiles(workbenchRoot);
  if (!registry.get(name)) {
    throw new Error(`Unknown workspace profile: ${name}`);
  }
  const config = readLocalConfig();
  config.activeProfile = name;
  const file = writeLocalConfig(config);
  printJson({ ok: true, command: "select", activeProfile: name, localProfilesPath: file });
}

function commandInit() {
  const name = requireOption("--name");
  validateProfileName(name);
  const workspace = normalizePath(requireOption("--workspace"));
  const sourcePvf = normalizePath(requireOption("--source-pvf"));
  const output = normalizePath(requireOption("--output"));
  const client = option("--client") ? normalizePath(option("--client")) : null;
  const materialArgs = values("--materials")
    .flatMap((value) => String(value).split(";"))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizePath);
  const materials = materialArgs.length === 0 ? null : materialArgs.length === 1 ? materialArgs[0] : materialArgs;
  const openEncoding = option("--open-encoding", "Tw");
  const readWriteEncoding = option("--read-write-encoding", "Cn");

  const config = readLocalConfig();
  const existingIndex = (config.profiles || []).findIndex((profile) => profile.name === name);
  if (existingIndex >= 0 && !flag("--force")) {
    throw new Error(`Local profile already exists: ${name}. Use --force to replace it.`);
  }

  const profile = {
    name,
    enabled: true,
    workspace,
    sourcePvf,
    materials,
    client,
    output,
    pvfEncoding: {
      open: openEncoding,
      readWrite: readWriteEncoding,
    },
    safety: defaultSafety(),
    notes: [
      "Machine-local profile. Keep the external PVF-Agent-Workbench-State profile store private.",
      "Default write mode remains disabled; use controlled-output change-set apply only after explicit authorization.",
      "The client root is used only by the separately previewed and authorized client-pvf deployment lane.",
    ],
  };

  if (existingIndex >= 0) {
    config.profiles[existingIndex] = profile;
  } else {
    config.profiles = [...(config.profiles || []), profile];
  }
  if (flag("--set-active") || !flag("--no-select")) {
    config.activeProfile = name;
  }

  const file = writeLocalConfig(config);
  printJson({
    ok: true,
    command: "init",
    localProfilesPath: file,
    activeProfile: config.activeProfile,
    profile: summarizeProfile(profile),
  });
}

function commandSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-profile-state-self-test-"));
  const fixtureWorkbench = path.join(tempRoot, "workbench");
  const stateBase = path.join(tempRoot, "external-state");
  const previousStateRoot = process.env.PVF_WORKBENCH_PROFILE_STATE_ROOT;
  const checks = [];
  try {
    fs.mkdirSync(path.join(fixtureWorkbench, "config"), { recursive: true });
    const baseConfig = {
      schemaVersion: "1.0",
      activeProfile: null,
      profiles: [{
        name: "disabled-example", enabled: false,
        workspace: "D:\\Example", sourcePvf: "D:\\Example\\Script.pvf", output: "D:\\Example\\output",
        pvfEncoding: { open: "Tw", readWrite: "Cn" }, safety: defaultSafety(),
      }],
    };
    const legacyConfig = {
      schemaVersion: "1.0",
      activeProfile: "main-local",
      profiles: [{
        name: "main-local", enabled: true,
        workspace: "E:\\Fixture", sourcePvf: "E:\\Fixture\\Script.pvf", output: "E:\\Fixture\\output",
        client: "E:\\Fixture\\client", materials: null,
        pvfEncoding: { open: "Tw", readWrite: "Cn" }, safety: defaultSafety(),
      }],
    };
    fs.writeFileSync(path.join(fixtureWorkbench, "config", "workspace-profiles.json"), `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");
    const legacyPath = path.join(fixtureWorkbench, "config", "workspace-profiles.local.json");
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");
    process.env.PVF_WORKBENCH_PROFILE_STATE_ROOT = stateBase;

    const before = loadWorkspaceProfiles(fixtureWorkbench);
    checks.push({
      id: "legacy-profile-remains-readable-and-auto-migrates",
      ok:
        before.activeProfile === "main-local" && before.localProfilesSource === "state" &&
        before.get("main-local")?.enabled === true && fs.existsSync(before.stateLocalProfilesPath),
    });
    const migration = ensureWorkspaceProfilesState(fixtureWorkbench);
    checks.push({
      id: "external-profile-store-is-stable-after-auto-migration",
      ok:
        migration.migrated === false && migration.migratedFrom === null &&
        fs.existsSync(migration.path) && !path.resolve(migration.path).startsWith(path.resolve(fixtureWorkbench) + path.sep),
    });

    // Simulate a Workbench refresh that replaces the old in-tree private
    // file. The state copy must remain authoritative without searching other
    // drives or importing an unrelated backup.
    fs.rmSync(legacyPath, { force: true });
    const afterRefresh = loadWorkspaceProfiles(fixtureWorkbench);
    checks.push({
      id: "external-profile-survives-workbench-refresh",
      ok:
        afterRefresh.activeProfile === "main-local" && afterRefresh.localProfilesSource === "state" &&
        afterRefresh.get("main-local")?.sourcePvf === "E:\\Fixture\\Script.pvf",
    });

    const updated = JSON.parse(JSON.stringify(legacyConfig));
    updated.profiles[0].output = "E:\\Fixture\\output-v2";
    writeLocalWorkspaceProfiles(fixtureWorkbench, updated);
    const afterWrite = loadWorkspaceProfiles(fixtureWorkbench);
    checks.push({
      id: "profile-writes-stay-in-external-state",
      ok:
        afterWrite.get("main-local")?.output === "E:\\Fixture\\output-v2" &&
        !fs.existsSync(legacyPath) && afterWrite.localProfilesSource === "state",
    });
    const rewritten = JSON.parse(fs.readFileSync(afterWrite.localProfilesPath, "utf8"));
    checks.push({
      id: "existing-external-profile-is-atomically-replaced",
      ok:
        rewritten.profiles?.[0]?.output === "E:\\Fixture\\output-v2" &&
        fs.readdirSync(path.dirname(afterWrite.localProfilesPath)).every((name) => !name.endsWith(".previous") && !name.endsWith(".tmp")),
    });
  } finally {
    if (previousStateRoot === undefined) delete process.env.PVF_WORKBENCH_PROFILE_STATE_ROOT;
    else process.env.PVF_WORKBENCH_PROFILE_STATE_ROOT = previousStateRoot;
    if (!path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error(`Unsafe profile self-test cleanup path: ${tempRoot}`);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: "1.0",
    phase: "workspace-profile-state-self-test",
    summary: {
      ok: checks.every((check) => check.ok),
      checkCount: checks.length,
      failedChecks: checks.filter((check) => !check.ok).length,
    },
    checks,
  };
  printJson(report);
  if (!report.summary.ok) process.exitCode = 1;
}

function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "status") {
    commandStatus();
    return;
  }
  if (command === "list") {
    commandList();
    return;
  }
  if (command === "show") {
    commandShow();
    return;
  }
  if (command === "select") {
    commandSelect();
    return;
  }
  if (command === "init") {
    commandInit();
    return;
  }
  if (command === "self-test") {
    commandSelfTest();
    return;
  }
  throw new Error(`Unsupported command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
}
