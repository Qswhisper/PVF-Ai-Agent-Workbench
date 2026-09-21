"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const { workspaceProfilesPaths, loadWorkspaceProfiles } = require("./workspace-profiles");

const key = p => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
function fail(message) { throw new Error(message); }
function preferencePath(root, profile) {
  const nameHash = crypto.createHash("sha256").update(profile.name).digest("hex");
  return path.join(workspaceProfilesPaths(root).stateRoot, "client-deploy-consent", nameHash + ".json");
}
function identity(profile) {
  if (!profile.client || !profile.sourcePvf) fail("Deployment preference requires a client and source PVF.");
  return { profileName: profile.name, clientRoot: key(profile.client),
    clientRootRealPath: key(fs.realpathSync(profile.client)), sourcePvf: key(profile.sourcePvf) };
}
function readPreference(root, profile) {
  const file = preferencePath(root, profile);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) fail("Deployment preference must not be a symbolic link.");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (saved.enabled !== true) return null;
  const current = identity(profile);
  if (saved.schemaVersion !== "1.0" || saved.scope !== "verified-script-pvf-only" ||
      saved.backupMode !== "client-version-directory" || saved.explicitUserAuthorization !== true ||
      !Object.keys(current).every(k => current[k] === saved[k])) fail("Saved deployment authorization does not match this client/profile; enable it again explicitly.");
  return { ...saved, preferencePath: file };
}
function savePreference(root, profile, enabled) {
  const file = preferencePath(root, profile);
  const value = { schemaVersion: "1.0", ...identity(profile), enabled,
    scope: "verified-script-pvf-only", backupMode: "client-version-directory",
    explicitUserAuthorization: true, updatedAt: new Date().toISOString(),
    backupDirectory: "PVF-Backups" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Invalid or interrupted preference writes fail closed on the next read.
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8" });
  return { ...value, preferencePath: file };
}
function blockingProcesses(clientRoot, rows) {
  const root = key(clientRoot) + path.sep;
  return rows.filter(p => (p.ExecutablePath && key(p.ExecutablePath).startsWith(root)) ||
    /dnf|地下城|launcher/i.test(String(p.Name || "")));
}
function assertClientStopped(clientRoot) {
  if (process.platform !== "win32") fail("Automatic client process verification is supported on Windows only.");
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress";
  const result = cp.spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) fail("Could not verify client/launcher processes; automatic deployment stopped.");
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  const blocked = blockingProcesses(clientRoot, Array.isArray(parsed) ? parsed : [parsed]);
  if (blocked.length) fail("Client or launcher is running; close it and retry automatic deployment: " + blocked.map(p => p.Name).join(", "));
  return { checkedAt: new Date().toISOString(), method: "Win32_Process", closed: true };
}
function autoDeployAfterApply(root, manifestPath, manifest) {
  try {
    const origin = manifest.protectedSourceOriginPvf || manifest.protectedSourcePvf || manifest.sourcePvf;
    const profiles = loadWorkspaceProfiles(root).profiles.filter(p => p.enabled && p.sourcePvf &&
      [origin, manifest.sourcePvf].filter(Boolean).some(s => key(s) === key(p.sourcePvf)) && readPreference(root, p));
    if (!profiles.length) return { status: "not-enabled" };
    if (profiles.length !== 1) fail("Multiple authorized clients match this source; select one with client-pvf auto-deploy --profile.");
    const result = cp.spawnSync(process.execPath, [path.join(root, "core/pvf-agent-core/cli/client-pvf-deploy.js"),
      "--root", root, "auto-deploy", "--profile", profiles[0].name, "--apply-manifest", manifestPath],
      { encoding: "utf8", windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) return { status: "blocked", profileName: profiles[0].name, details: result.stderr || result.stdout,
      retryCommand: `workbench.bat client-pvf auto-deploy --profile "${profiles[0].name}" --apply-manifest "${manifestPath}"` };
    return JSON.parse(result.stdout);
  } catch (error) { return { status: "blocked", message: error.message }; }
}
module.exports = { readPreference, savePreference, preferencePath, blockingProcesses, assertClientStopped, autoDeployAfterApply };
