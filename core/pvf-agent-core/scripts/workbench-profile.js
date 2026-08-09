"use strict";

const fs = require("fs");
const path = require("path");
const { loadWorkspaceProfiles, resolveProfile } = require("../lib/workspace-profiles");

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

Notes:
  Local profiles are written to config/workspace-profiles.local.json.
  That file is machine-specific and ignored by git/packages.
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
  return path.join(workbenchRoot, "config", "workspace-profiles.local.json");
}

function readLocalConfig() {
  const file = localProfilesPath();
  if (!fs.existsSync(file)) {
    return {
      $schema: "../core/pvf-agent-core/schemas/workspace-profiles.schema.json",
      schemaVersion: "1.0",
      activeProfile: null,
      profiles: [],
    };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeLocalConfig(config) {
  const file = localProfilesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
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
    localProfilesPath: localProfilesPath(),
    localProfilesExists: fs.existsSync(localProfilesPath()),
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
      "Machine-local profile. Keep config/workspace-profiles.local.json private.",
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
  throw new Error(`Unsupported command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
}
