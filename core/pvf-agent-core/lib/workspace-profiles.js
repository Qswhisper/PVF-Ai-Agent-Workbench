"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizedWorkbenchIdentity(workbenchRoot) {
  const resolved = path.resolve(workbenchRoot).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceProfilesPaths(workbenchRoot) {
  const root = path.resolve(workbenchRoot);
  const stateBase = process.env.PVF_WORKBENCH_PROFILE_STATE_ROOT
    ? path.resolve(process.env.PVF_WORKBENCH_PROFILE_STATE_ROOT)
    : path.join(
      process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
      "PVF-Agent-Workbench-State",
      "profiles",
    );
  const workbenchId = crypto
    .createHash("sha256")
    .update(normalizedWorkbenchIdentity(root))
    .digest("hex")
    .slice(0, 24);
  return {
    basePath: path.join(root, "config", "workspace-profiles.json"),
    legacyLocalPath: path.join(root, "config", "workspace-profiles.local.json"),
    stateRoot: path.join(stateBase, workbenchId),
    stateLocalPath: path.join(stateBase, workbenchId, "workspace-profiles.local.json"),
    workbenchId,
  };
}

function selectedLocalProfilesConfig(workbenchRoot) {
  const paths = workspaceProfilesPaths(workbenchRoot);
  const stateData = readJsonIfExists(paths.stateLocalPath);
  if (stateData) {
    return { kind: "state", path: paths.stateLocalPath, data: stateData, paths };
  }
  const legacyData = readJsonIfExists(paths.legacyLocalPath);
  if (legacyData) {
    return { kind: "legacy-local", path: paths.legacyLocalPath, data: legacyData, paths };
  }
  return { kind: null, path: paths.stateLocalPath, data: null, paths };
}

function selectedLocalProfilesMetadata(workbenchRoot) {
  const paths = workspaceProfilesPaths(workbenchRoot);
  if (fs.existsSync(paths.stateLocalPath)) {
    return { kind: "state", path: paths.stateLocalPath, paths };
  }
  if (fs.existsSync(paths.legacyLocalPath)) {
    return { kind: "legacy-local", path: paths.legacyLocalPath, paths };
  }
  return { kind: null, path: paths.stateLocalPath, paths };
}

function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const descriptor = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(resolved)) {
      // Windows cannot rename over an existing destination. Keep the old
      // profile recoverable until the replacement is durably staged, then
      // use a same-directory rollback slot instead of deleting first.
      const previous = path.join(
        path.dirname(resolved),
        `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.previous`,
      );
      let previousMoved = false;
      try {
        fs.renameSync(resolved, previous);
        previousMoved = true;
        fs.renameSync(temporary, resolved);
        fs.rmSync(previous, { force: true });
        previousMoved = false;
      } catch (error) {
        if (previousMoved && fs.existsSync(previous)) {
          if (fs.existsSync(resolved)) {
            try { fs.rmSync(resolved, { force: true }); } catch { /* recovery below reports failure */ }
          }
          if (!fs.existsSync(resolved)) {
            fs.renameSync(previous, resolved);
            previousMoved = false;
          }
        }
        throw error;
      } finally {
        if (!previousMoved && fs.existsSync(previous)) fs.rmSync(previous, { force: true });
      }
    } else {
      fs.renameSync(temporary, resolved);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return resolved;
}

function ensureWorkspaceProfilesState(workbenchRoot) {
  const selected = selectedLocalProfilesConfig(workbenchRoot);
  if (selected.kind === "state") {
    return {
      path: selected.path,
      data: selected.data,
      migrated: false,
      migratedFrom: null,
      paths: selected.paths,
    };
  }
  if (selected.kind === "legacy-local") {
    writeJsonAtomic(selected.paths.stateLocalPath, selected.data);
    return {
      path: selected.paths.stateLocalPath,
      data: selected.data,
      migrated: true,
      migratedFrom: selected.paths.legacyLocalPath,
      paths: selected.paths,
    };
  }
  return {
    path: selected.paths.stateLocalPath,
    data: null,
    migrated: false,
    migratedFrom: null,
    paths: selected.paths,
  };
}

function writeLocalWorkspaceProfiles(workbenchRoot, config) {
  const paths = workspaceProfilesPaths(workbenchRoot);
  return writeJsonAtomic(paths.stateLocalPath, config);
}

function loadWorkspaceProfiles(workbenchRoot) {
  const root = path.resolve(workbenchRoot);
  // First use of a legacy in-tree private profile copies it atomically to the
  // external state store. The legacy file is deliberately left untouched so
  // migration is recoverable and never destroys user data.
  const ensured = ensureWorkspaceProfilesState(root);
  const local = ensured.data
    ? { kind: ensured.migrated ? "state" : selectedLocalProfilesConfig(root).kind, path: ensured.path, data: ensured.data, paths: ensured.paths }
    : selectedLocalProfilesConfig(root);
  const configs = [
    { kind: "base", path: local.paths.basePath, data: readJsonIfExists(local.paths.basePath) },
    local.data ? { kind: local.kind, path: local.path, data: local.data } : null,
  ].filter(Boolean).filter((item) => item.data);

  const profiles = new Map();
  let activeProfile = null;
  for (const config of configs) {
    if (config.data.activeProfile) {
      activeProfile = config.data.activeProfile;
    }
    for (const profile of config.data.profiles || []) {
      profiles.set(profile.name, { ...profile, profileSource: config.kind, profileSourcePath: config.path });
    }
  }

  return {
    activeProfile,
    profiles: [...profiles.values()],
    localProfilesPath: local.path,
    localProfilesSource: local.kind,
    stateLocalProfilesPath: local.paths.stateLocalPath,
    legacyLocalProfilesPath: local.paths.legacyLocalPath,
    get(name) {
      return profiles.get(name);
    },
  };
}

function resolveProfile(workbenchRoot, requestedName) {
  const registry = loadWorkspaceProfiles(workbenchRoot);
  const name = requestedName || registry.activeProfile;
  if (!name) {
    return null;
  }
  const profile = registry.get(name);
  if (!profile) {
    throw new Error(`Unknown workspace profile: ${name}`);
  }
  return profile;
}

function resolveSourcePvf(workbenchRoot, requestedProfile, explicitPvf) {
  if (explicitPvf) {
    return {
      sourcePvf: path.resolve(explicitPvf),
      profile: requestedProfile ? resolveProfile(workbenchRoot, requestedProfile) : null,
      source: explicitPvf ? "--pvf" : "profile",
    };
  }
  const profile = resolveProfile(workbenchRoot, requestedProfile);
  if (!profile) {
    throw new Error("Provide --pvf or configure/select a workspace profile.");
  }
  return {
    sourcePvf: path.resolve(profile.sourcePvf),
    profile,
    source: "profile",
  };
}

module.exports = {
  ensureWorkspaceProfilesState,
  loadWorkspaceProfiles,
  resolveProfile,
  resolveSourcePvf,
  selectedLocalProfilesConfig,
  selectedLocalProfilesMetadata,
  workspaceProfilesPaths,
  writeLocalWorkspaceProfiles,
};
