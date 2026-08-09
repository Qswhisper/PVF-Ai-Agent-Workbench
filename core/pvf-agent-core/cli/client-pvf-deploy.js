"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveProfile } = require("../lib/workspace-profiles");
const {
  pathInside,
  readJson,
  sha256File,
  timestamp,
  writeJson,
} = require("../lib/release-utils");
const { runtimePath } = require("../lib/runtime-state");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot =
  rootIndex >= 0 && rawArgs[rootIndex + 1]
    ? path.resolve(rawArgs[rootIndex + 1])
    : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = String(args[0] || "help").toLowerCase();

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  workbench.bat client-pvf preview --profile <name> --apply-manifest <APPLY-MANIFEST.json> [--out <dir>]",
    "  workbench.bat client-pvf deploy --preview-manifest <CLIENT-PVF-DEPLOY-PREVIEW.json> --authorize-deploy <code> --confirm-client-closed",
    "  workbench.bat client-pvf rollback-preview --deployment-manifest <CLIENT-PVF-DEPLOYMENT-MANIFEST.json> [--out <dir>]",
    "  workbench.bat client-pvf rollback --preview-manifest <CLIENT-PVF-ROLLBACK-PREVIEW.json> --authorize-rollback <code> --confirm-client-closed",
    "  workbench.bat client-pvf self-test [--out <dir>]",
    "",
    "This lane only installs a verified output Script.pvf into the client root recorded by a local profile.",
    "It never writes NPK, IMG, UI, or another client resource, and it never overwrites the source PVF.",
    "",
  ].join("\n");
}

function requireOption(name) {
  const value = option(name);
  if (!value) throw new Error(name + " is required.");
  return value;
}

function safeName(value) {
  const normalized = String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "profile";
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function assertCondition(condition, message, code) {
  if (condition) return;
  const error = new Error(message);
  if (code) error.code = code;
  throw error;
}

function prospectiveRealPath(candidate) {
  const resolved = path.resolve(candidate);
  let cursor = resolved;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    assertCondition(parent !== cursor, "Cannot resolve path ancestry: " + resolved);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realPath(cursor), ...suffix);
}

function assertOutsideWorkbench(candidate, label) {
  const resolved = path.resolve(candidate);
  const workbenchRealPath = realPath(workbenchRoot);
  const candidateRealPath = prospectiveRealPath(resolved);
  assertCondition(
    !pathInside(workbenchRoot, resolved) && !pathInside(workbenchRealPath, candidateRealPath),
    label + " must stay outside the Workbench: " + resolved,
    "WORKBENCH_OUTPUT_BOUNDARY",
  );
}

function assertRegularFile(file, label) {
  const resolved = path.resolve(file);
  assertCondition(fs.existsSync(resolved), label + " does not exist: " + resolved, "FILE_NOT_FOUND");
  const lstat = fs.lstatSync(resolved);
  assertCondition(!lstat.isSymbolicLink(), label + " must not be a symbolic link: " + resolved, "SYMLINK_BLOCKED");
  assertCondition(lstat.isFile(), label + " must be a regular file: " + resolved, "NOT_A_FILE");
  return resolved;
}

function assertDirectory(directory, label) {
  const resolved = path.resolve(directory);
  assertCondition(fs.existsSync(resolved), label + " does not exist: " + resolved, "DIRECTORY_NOT_FOUND");
  const lstat = fs.lstatSync(resolved);
  assertCondition(!lstat.isSymbolicLink(), label + " must not be a symbolic link: " + resolved, "SYMLINK_BLOCKED");
  assertCondition(lstat.isDirectory(), label + " must be a directory: " + resolved, "NOT_A_DIRECTORY");
  return resolved;
}

function realPath(file) {
  return fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file);
}

function fileInfo(file) {
  const resolved = assertRegularFile(file, "File");
  const stat = fs.statSync(resolved);
  return {
    path: resolved,
    realPath: realPath(resolved),
    bytes: stat.size,
    sha256: sha256File(resolved),
  };
}

function loadPolicy() {
  const policyPath = path.join(workbenchRoot, "config", "client-pvf-deploy-policy.json");
  const policy = readJson(policyPath);
  assertCondition(policy.schemaVersion === "1.0", "client-pvf deploy policy schemaVersion must be 1.0.");
  assertCondition(policy.phase === "controlled-client-pvf-deployment", "Unexpected client-pvf deploy policy phase.");
  assertCondition(
    policy.mode === "explicit-preview-authorize-deploy-rollback",
    "Unexpected client-pvf deploy policy mode.",
  );
  assertCondition(policy.controlledDeployEnabled === true, "Controlled client PVF deployment is disabled.");
  assertCondition(policy.defaultClientWriteEnabled === false, "Default client writes must remain disabled.");
  assertCondition(policy.targetFileName === "Script.pvf", "The controlled deployment target must remain Script.pvf.");
  assertCondition(policy.permissionModel?.profileClientRootRequired === true, "A profile client root must be required.");
  assertCondition(policy.permissionModel?.directClientPathAllowed === false, "Direct unprofiled client paths must remain blocked.");
  assertCondition(policy.permissionModel?.sourcePvfOverwriteAllowed === false, "Source PVF overwrite must remain blocked.");
  assertCondition(policy.permissionModel?.applyOutputMutationAllowed === false, "Apply output mutation must remain blocked.");
  assertCondition(
    policy.permissionModel?.nonPvfClientResourceWriteAllowed === false,
    "Non-PVF client resource writes must remain blocked.",
  );
  return policy;
}

function ensureExternalRunRoot(requested, clientRoot) {
  const runRoot = path.resolve(requested);
  assertOutsideWorkbench(runRoot, "Deployment report directory");
  assertCondition(
    !pathInside(clientRoot, runRoot),
    "Deployment reports must stay outside the client directory: " + runRoot,
    "CLIENT_OUTPUT_BOUNDARY",
  );
  if (fs.existsSync(runRoot)) {
    assertDirectory(runRoot, "Deployment report directory");
  } else {
    fs.mkdirSync(runRoot, { recursive: true });
    assertDirectory(runRoot, "Deployment report directory");
  }
  const runRootRealPath = realPath(runRoot);
  const clientRootRealPath = realPath(clientRoot);
  assertCondition(
    !pathInside(clientRootRealPath, runRootRealPath),
    "Deployment reports resolved inside the client directory: " + runRootRealPath,
    "CLIENT_OUTPUT_BOUNDARY",
  );
  assertOutsideWorkbench(runRootRealPath, "Deployment report directory");
  return runRoot;
}

function resolveClientContext(profile, policy) {
  assertCondition(profile && typeof profile === "object", "A workspace profile is required.");
  assertCondition(profile.enabled === true, "The selected workspace profile is disabled: " + profile.name);
  assertCondition(typeof profile.client === "string" && profile.client.trim(), "The profile does not define a client root.");
  assertCondition(typeof profile.output === "string" && profile.output.trim(), "The profile does not define an output directory.");
  assertCondition(
    profile.safety?.clientWrite?.requiresSeparateAuthorization === true,
    "The profile must require separate client authorization.",
  );
  assertCondition(
    profile.safety?.clientWrite?.enabled === false,
    "Default profile client writes must remain disabled; use this separately authorized lane.",
  );

  const clientRoot = assertDirectory(profile.client, "Profile client root");
  const clientRootRealPath = realPath(clientRoot);
  const clientPvf = path.join(clientRoot, policy.targetFileName);
  const clientPvfInfo = fileInfo(clientPvf);
  assertCondition(
    path.basename(clientPvfInfo.path).toLowerCase() === policy.targetFileName.toLowerCase(),
    "The client deployment target must be Script.pvf.",
  );
  assertCondition(
    pathInside(clientRootRealPath, clientPvfInfo.realPath),
    "The resolved client Script.pvf escaped the configured client root.",
    "CLIENT_TARGET_ESCAPE",
  );

  const profileOutput = path.resolve(profile.output);
  if (fs.existsSync(profileOutput)) assertDirectory(profileOutput, "Profile output directory");
  const profileOutputRealPath = prospectiveRealPath(profileOutput);
  assertOutsideWorkbench(profileOutput, "Profile output directory");
  assertCondition(
    !pathInside(clientRoot, profileOutput) && !pathInside(clientRootRealPath, profileOutputRealPath),
    "Profile output and backups must stay outside the client directory.",
    "CLIENT_OUTPUT_BOUNDARY",
  );

  return {
    profileName: profile.name,
    clientRoot,
    clientRootRealPath,
    clientPvf: clientPvfInfo.path,
    clientPvfRealPath: clientPvfInfo.realPath,
    clientPvfBytes: clientPvfInfo.bytes,
    clientPvfSha256: clientPvfInfo.sha256,
    profileOutput,
    profileOutputRealPath,
  };
}

function validateApplyManifest(manifestFile) {
  const manifestPath = assertRegularFile(manifestFile, "Apply manifest");
  assertOutsideWorkbench(manifestPath, "Apply manifest");
  const manifest = readJson(manifestPath);
  assertCondition(manifest.schemaVersion === "1.0", "Apply manifest schemaVersion must be 1.0.");
  assertCondition(manifest.phase === "phase-3-controlled-output-apply", "Unexpected apply manifest phase.");
  assertCondition(manifest.mode === "controlled-output-only", "Unexpected apply manifest mode.");
  assertCondition(manifest.safety?.sourceOverwritten === false, "Apply manifest does not prove source preservation.");
  assertCondition(manifest.safety?.backupCreated === true, "Apply manifest does not prove source backup.");
  assertCondition(manifest.safety?.matchingDryRunVerified === true, "Apply manifest does not prove matching preview.");
  assertCondition(
    manifest.safety?.explicitUserAuthorizationVerified === true,
    "Apply manifest does not prove explicit output authorization.",
  );
  assertCondition(manifest.safety?.readbackOk === true, "Apply manifest readback is not successful.");
  assertCondition(manifest.safety?.clientResourceWrite === false, "Apply manifest unexpectedly includes a client write.");
  assertCondition(
    manifest.safety?.outputSha256Bound === true,
    "This apply manifest predates output SHA binding. Regenerate the output PVF before client deployment.",
    "APPLY_OUTPUT_SHA_UNBOUND",
  );
  assertCondition(manifest.summary?.outputExists === true, "Apply output was not recorded as present.");
  assertCondition(manifest.summary?.readbackOk === true, "Apply output readback was not recorded as successful.");
  assertCondition(
    manifest.summary?.outputSha256Verified === true,
    "Apply output SHA was not recorded as verified.",
    "APPLY_OUTPUT_SHA_UNBOUND",
  );

  const outputPvf = assertRegularFile(manifest.outputPvf, "Apply output PVF");
  const sourcePvf = assertRegularFile(manifest.sourcePvf, "Apply source PVF");
  assertCondition(sourcePvf && !samePath(sourcePvf, outputPvf), "Apply output must remain separate from the source PVF.");
  const sourceInfo = fileInfo(sourcePvf);
  assertCondition(isSha256(manifest.sourcePvfSha256), "Apply manifest sourcePvfSha256 is missing or invalid.");
  assertCondition(
    sourceInfo.sha256.toLowerCase() === String(manifest.sourcePvfSha256).toLowerCase(),
    "Apply source PVF changed after its output was generated. Regenerate the output and deployment preview.",
    "APPLY_SOURCE_CHANGED",
  );
  assertOutsideWorkbench(outputPvf, "Apply output PVF");
  assertOutsideWorkbench(sourcePvf, "Apply source PVF");
  assertCondition(isSha256(manifest.outputPvfSha256), "Apply manifest outputPvfSha256 is missing or invalid.");
  const outputInfo = fileInfo(outputPvf);
  assertCondition(
    outputInfo.sha256.toLowerCase() === String(manifest.outputPvfSha256).toLowerCase(),
    "Apply output PVF changed after its readback manifest was created.",
    "APPLY_OUTPUT_CHANGED",
  );
  assertCondition(
    Number.isInteger(manifest.outputPvfBytes) && manifest.outputPvfBytes === outputInfo.bytes,
    "Apply output PVF size no longer matches its manifest.",
    "APPLY_OUTPUT_CHANGED",
  );

  return {
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    manifest,
    sourcePvf: sourceInfo.path,
    sourcePvfRealPath: sourceInfo.realPath,
    sourcePvfSha256: sourceInfo.sha256,
    outputPvf: outputInfo.path,
    outputPvfRealPath: outputInfo.realPath,
    outputPvfSha256: outputInfo.sha256,
    outputPvfBytes: outputInfo.bytes,
  };
}

function backupPathFor(clientContext, clientSha256, policy) {
  const directory = String(policy.outputs?.backupDirectoryName || "client-pvf-backups/sha256");
  const backupPath = path.resolve(clientContext.profileOutput, directory, clientSha256.toLowerCase() + ".Script.pvf");
  assertCondition(
    pathInside(clientContext.profileOutput, backupPath) &&
      pathInside(clientContext.profileOutputRealPath, prospectiveRealPath(backupPath)),
    "Calculated backup path escaped the profile output directory.",
    "BACKUP_PATH_ESCAPE",
  );
  assertCondition(
    !pathInside(clientContext.clientRoot, backupPath),
    "Client backups must stay outside the client directory.",
    "CLIENT_OUTPUT_BOUNDARY",
  );
  assertOutsideWorkbench(backupPath, "Client PVF backup");
  return backupPath;
}

function makeBinding(prefix, inputs) {
  const bindingSha256 = sha256Json(inputs);
  return {
    inputs,
    bindingSha256,
    approvalCode: prefix + "-" + bindingSha256.toUpperCase(),
  };
}

function validateBinding(binding, prefix, label) {
  assertCondition(binding && typeof binding === "object", label + " binding is missing.");
  const expected = makeBinding(prefix, binding.inputs);
  assertCondition(expected.bindingSha256 === binding.bindingSha256, label + " binding hash is invalid.");
  assertCondition(expected.approvalCode === binding.approvalCode, label + " approval code is invalid.");
  return expected;
}

function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    "." + path.basename(resolved) + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp",
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    const fd = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(resolved)) fs.rmSync(resolved);
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function createDeployPreview(options) {
  const policy = options.policy || loadPolicy();
  const profile = options.profile;
  const client = resolveClientContext(profile, policy);
  const apply = validateApplyManifest(options.applyManifestPath);
  assertCondition(
    !samePath(client.clientPvf, apply.sourcePvf) &&
      !samePath(client.clientPvfRealPath, apply.sourcePvfRealPath),
    "The client Script.pvf is also the source PVF. Keep an independent protected source and deploy to a separate test client.",
    "SOURCE_CLIENT_COLLISION",
  );
  assertCondition(
    !samePath(client.clientPvf, apply.outputPvf) &&
      !samePath(client.clientPvfRealPath, apply.outputPvfRealPath),
    "The apply output PVF is already the client target; controlled deployment requires an independent output.",
    "OUTPUT_CLIENT_COLLISION",
  );
  assertCondition(
    !pathInside(client.clientRoot, apply.outputPvf) && !pathInside(client.clientRootRealPath, apply.outputPvfRealPath),
    "The verified apply output must stay outside the client directory.",
    "OUTPUT_INSIDE_CLIENT",
  );
  assertCondition(
    typeof profile.sourcePvf === "string" &&
      (samePath(profile.sourcePvf, apply.sourcePvf) ||
        samePath(prospectiveRealPath(profile.sourcePvf), apply.sourcePvfRealPath)),
    "The deployment profile sourcePvf does not match the source recorded by the apply manifest.",
    "PROFILE_APPLY_SOURCE_MISMATCH",
  );

  const runRoot = ensureExternalRunRoot(options.outRoot, client.clientRoot);
  const previewManifestPath = path.join(
    runRoot,
    policy.outputs?.deployPreviewFileName || "CLIENT-PVF-DEPLOY-PREVIEW.json",
  );
  const deploymentManifestPath = path.join(
    runRoot,
    policy.outputs?.deploymentManifestFileName || "CLIENT-PVF-DEPLOYMENT-MANIFEST.json",
  );
  assertCondition(!fs.existsSync(previewManifestPath), "Refusing to overwrite an existing deployment preview: " + previewManifestPath);
  assertCondition(!fs.existsSync(deploymentManifestPath), "Refusing to reuse a deployment run that already has a manifest: " + deploymentManifestPath);

  const noChange = client.clientPvfSha256.toLowerCase() === apply.outputPvfSha256.toLowerCase();
  const backupPath = backupPathFor(client, client.clientPvfSha256, policy);
  const bindingInputs = {
    schemaVersion: "1.0",
    operation: "deploy-client-script-pvf",
    profileName: profile.name,
    applyManifest: apply.manifestPath,
    applyManifestSha256: apply.manifestSha256,
    sourcePvf: apply.sourcePvf,
    sourcePvfSha256: apply.sourcePvfSha256,
    outputPvf: apply.outputPvf,
    outputPvfSha256: apply.outputPvfSha256,
    outputPvfBytes: apply.outputPvfBytes,
    clientRoot: client.clientRoot,
    clientRootRealPath: client.clientRootRealPath,
    clientPvf: client.clientPvf,
    clientPvfRealPath: client.clientPvfRealPath,
    clientPvfSha256Before: client.clientPvfSha256,
    clientPvfBytesBefore: client.clientPvfBytes,
    backupPath,
    deploymentManifestPath,
  };
  const binding = noChange ? null : makeBinding("DEPLOY", bindingInputs);
  const preview = {
    schemaVersion: "1.0",
    phase: "client-pvf-deploy-preview",
    generatedAt: new Date().toISOString(),
    mode: "preview-only",
    ready: !noChange,
    noChange,
    profileName: profile.name,
    previewManifestPath,
    deploymentManifestPath,
    applyManifest: apply.manifestPath,
    sourcePvf: apply.sourcePvf,
    outputPvf: apply.outputPvf,
    outputPvfSha256: apply.outputPvfSha256,
    outputPvfBytes: apply.outputPvfBytes,
    clientRoot: client.clientRoot,
    clientPvf: client.clientPvf,
    clientPvfSha256Before: client.clientPvfSha256,
    clientPvfBytesBefore: client.clientPvfBytes,
    backupPath,
    binding,
    safety: {
      writeOperationsExecuted: false,
      clientWritten: false,
      sourcePvfModified: false,
      applyOutputModified: false,
      applyManifestVerified: true,
      applyOutputSha256Verified: true,
      clientTargetSha256Bound: true,
      sourceClientPathsDistinct: true,
      outputClientPathsDistinct: true,
      profileClientRootRequired: true,
      explicitAuthorizationRequired: true,
      clientClosedConfirmationRequired: true,
      backupRequiredBeforeDeploy: true,
      rollbackAvailableAfterDeploy: true,
      nonPvfClientResourceWrite: false,
    },
    summary: {
      ready: !noChange,
      noChange,
      message: noChange
        ? "客户端已经是这个版本，没有执行部署。"
        : "部署预览已完成，客户端尚未修改。关闭客户端和启动器并明确确认后才能继续。",
    },
  };
  writeJson(previewManifestPath, preview);
  return preview;
}

function validateDeployPreview(previewFile) {
  const previewManifestPath = assertRegularFile(previewFile, "Deployment preview manifest");
  assertOutsideWorkbench(previewManifestPath, "Deployment preview manifest");
  const preview = readJson(previewManifestPath);
  assertCondition(preview.schemaVersion === "1.0", "Deployment preview schemaVersion must be 1.0.");
  assertCondition(preview.phase === "client-pvf-deploy-preview", "Unexpected deployment preview phase.");
  assertCondition(preview.mode === "preview-only", "Unexpected deployment preview mode.");
  assertCondition(preview.ready === true && preview.noChange === false, "Deployment preview is not ready.");
  assertCondition(preview.safety?.writeOperationsExecuted === false, "Deployment preview unexpectedly records writes.");
  assertCondition(preview.safety?.clientWritten === false, "Deployment preview unexpectedly records a client write.");
  const binding = validateBinding(preview.binding, "DEPLOY", "Deployment preview");
  const inputs = binding.inputs;
  assertCondition(samePath(inputs.deploymentManifestPath, preview.deploymentManifestPath), "Deployment manifest path was altered.");
  assertCondition(samePath(inputs.clientPvf, preview.clientPvf), "Deployment client target was altered.");
  assertCondition(String(inputs.outputPvfSha256).toLowerCase() === String(preview.outputPvfSha256).toLowerCase(), "Deployment candidate hash was altered.");
  return {
    previewManifestPath,
    previewManifestSha256: sha256File(previewManifestPath),
    preview,
    binding,
    inputs,
  };
}

function syncFile(file) {
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function copyVerifiedExclusive(source, destination, expectedSha256) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  syncFile(destination);
  const actual = sha256File(destination);
  assertCondition(actual.toLowerCase() === expectedSha256.toLowerCase(), "Copied file SHA256 verification failed.");
  return actual;
}

function ensureContentAddressedBackup(source, backupPath, expectedSha256) {
  const destination = path.resolve(backupPath);
  if (fs.existsSync(destination)) {
    assertRegularFile(destination, "Existing client PVF backup");
    const actual = sha256File(destination);
    assertCondition(
      actual.toLowerCase() === expectedSha256.toLowerCase(),
      "Refusing to reuse a content-addressed backup whose content does not match its name.",
      "BACKUP_HASH_MISMATCH",
    );
    return { path: destination, sha256: actual, created: false, reused: true };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    "." + path.basename(destination) + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp",
  );
  try {
    copyVerifiedExclusive(source, temporary, expectedSha256);
    if (fs.existsSync(destination)) {
      const existingSha = sha256File(assertRegularFile(destination, "Existing client PVF backup"));
      assertCondition(existingSha.toLowerCase() === expectedSha256.toLowerCase(), "Concurrent backup content mismatch.");
      fs.rmSync(temporary, { force: true });
      return { path: destination, sha256: existingSha, created: false, reused: true };
    }
    fs.renameSync(temporary, destination);
    return { path: destination, sha256: sha256File(destination), created: true, reused: false };
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function replacementPaths(target, operation) {
  const suffix = operation + "-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  return {
    stagePath: path.join(path.dirname(target), ".pvf-workbench-stage-" + suffix + ".tmp"),
    previousPath: path.join(path.dirname(target), ".pvf-workbench-previous-" + suffix + ".tmp"),
  };
}

function stagedReplace(source, target, expectedSourceSha256, expectedTargetSha256, paths) {
  assertCondition(!fs.existsSync(paths.stagePath), "Staging file already exists: " + paths.stagePath);
  assertCondition(!fs.existsSync(paths.previousPath), "Previous-file staging path already exists: " + paths.previousPath);
  copyVerifiedExclusive(source, paths.stagePath, expectedSourceSha256);
  const currentTargetSha = sha256File(assertRegularFile(target, "Client Script.pvf"));
  assertCondition(
    currentTargetSha.toLowerCase() === expectedTargetSha256.toLowerCase(),
    "Client Script.pvf changed immediately before replacement.",
    "STALE_CLIENT_TARGET",
  );

  let previousMoved = false;
  let newMoved = false;
  try {
    fs.renameSync(target, paths.previousPath);
    previousMoved = true;
    const movedPreviousSha = sha256File(assertRegularFile(paths.previousPath, "Staged previous client Script.pvf"));
    assertCondition(
      movedPreviousSha.toLowerCase() === expectedTargetSha256.toLowerCase(),
      "Client Script.pvf changed during replacement. The moved file will be restored.",
      "STALE_CLIENT_TARGET",
    );
    fs.renameSync(paths.stagePath, target);
    newMoved = true;
    const actual = sha256File(assertRegularFile(target, "Deployed client Script.pvf"));
    assertCondition(actual.toLowerCase() === expectedSourceSha256.toLowerCase(), "Client Script.pvf readback hash failed.");
    fs.rmSync(paths.previousPath);
    previousMoved = false;
    return { targetPath: target, sha256: actual, readbackOk: true };
  } catch (originalError) {
    let restored = false;
    let recoveryError = null;
    try {
      if (previousMoved && fs.existsSync(paths.previousPath)) {
        if (newMoved && fs.existsSync(target)) fs.rmSync(target);
        if (!fs.existsSync(target)) fs.renameSync(paths.previousPath, target);
        restored =
          fs.existsSync(target) &&
          sha256File(target).toLowerCase() === expectedTargetSha256.toLowerCase();
        previousMoved = !restored;
      } else {
        restored =
          fs.existsSync(target) &&
          sha256File(target).toLowerCase() === expectedTargetSha256.toLowerCase();
      }
    } catch (error) {
      recoveryError = error;
    }
    if (fs.existsSync(paths.stagePath)) {
      try {
        fs.rmSync(paths.stagePath, { force: true });
      } catch {
        // Leave the path in the transaction manifest for recovery.
      }
    }
    const wrapped = new Error(
      "Client PVF replacement failed" +
        (restored ? " and the original client PVF was restored." : "; automatic restoration needs attention.") +
        " Cause: " +
        originalError.message +
        (recoveryError ? " Recovery error: " + recoveryError.message : ""),
    );
    wrapped.code = restored ? "CLIENT_PVF_REPLACEMENT_RESTORED" : "CLIENT_PVF_RECOVERY_REQUIRED";
    wrapped.recovery = {
      restored,
      targetExists: fs.existsSync(target),
      stageExists: fs.existsSync(paths.stagePath),
      previousExists: fs.existsSync(paths.previousPath),
      stagePath: paths.stagePath,
      previousPath: paths.previousPath,
    };
    throw wrapped;
  } finally {
    if (!previousMoved && fs.existsSync(paths.previousPath)) {
      try {
        fs.rmSync(paths.previousPath, { force: true });
      } catch {
        // A successful target readback is already recorded; retain unexpected leftovers for manual inspection.
      }
    }
    if (fs.existsSync(paths.stagePath)) {
      try {
        fs.rmSync(paths.stagePath, { force: true });
      } catch {
        // Retain unexpected leftovers for manual inspection.
      }
    }
  }
}

function appendState(manifest, status, details) {
  const now = new Date().toISOString();
  manifest.status = status;
  manifest.updatedAt = now;
  manifest.history = [...(manifest.history || []), { status, at: now }];
  if (details && typeof details === "object") Object.assign(manifest, details);
  writeJsonAtomic(manifest.manifestPath, manifest);
}

function executeDeploy(options) {
  const policy = options.policy || loadPolicy();
  const loaded = validateDeployPreview(options.previewManifestPath);
  assertCondition(
    options.authorizationCode === loaded.binding.approvalCode,
    "Deployment authorization code does not match this output PVF and client target.",
    "DEPLOY_AUTHORIZATION_MISMATCH",
  );
  assertCondition(
    options.clientClosedConfirmed === true,
    "Close the client and launcher, then pass --confirm-client-closed.",
    "CLIENT_CLOSE_CONFIRMATION_REQUIRED",
  );
  const profile = options.profile;
  assertCondition(profile?.name === loaded.inputs.profileName, "The selected profile no longer matches the deployment preview.");
  const client = resolveClientContext(profile, policy);
  const apply = validateApplyManifest(loaded.inputs.applyManifest);
  assertCondition(
    typeof profile.sourcePvf === "string" &&
      (samePath(profile.sourcePvf, apply.sourcePvf) ||
        samePath(prospectiveRealPath(profile.sourcePvf), apply.sourcePvfRealPath)),
    "The deployment profile sourcePvf changed or no longer matches the apply manifest.",
    "PROFILE_APPLY_SOURCE_MISMATCH",
  );
  assertCondition(
    apply.manifestSha256 === loaded.inputs.applyManifestSha256,
    "Apply manifest changed after deployment preview.",
    "STALE_DEPLOY_PREVIEW",
  );
  assertCondition(samePath(apply.outputPvf, loaded.inputs.outputPvf), "Apply output path changed after deployment preview.");
  assertCondition(apply.outputPvfSha256 === loaded.inputs.outputPvfSha256, "Apply output changed after deployment preview.");
  assertCondition(samePath(client.clientRootRealPath, loaded.inputs.clientRootRealPath), "Profile client root changed after deployment preview.");
  assertCondition(samePath(client.clientPvf, loaded.inputs.clientPvf), "Profile client target changed after deployment preview.");
  assertCondition(
    client.clientPvfSha256 === loaded.inputs.clientPvfSha256Before,
    "Client Script.pvf changed after deployment preview. Create a new preview.",
    "STALE_CLIENT_TARGET",
  );
  assertCondition(!samePath(client.clientPvf, apply.sourcePvf), "Refusing to overwrite the source PVF during client deployment.");
  assertCondition(
    !samePath(client.clientPvfRealPath, apply.sourcePvfRealPath),
    "Refusing to overwrite the resolved source PVF during client deployment.",
  );
  assertCondition(!samePath(client.clientPvf, apply.outputPvf), "Refusing to deploy over the independent apply output.");
  assertCondition(
    !samePath(client.clientPvfRealPath, apply.outputPvfRealPath),
    "Refusing to deploy over the resolved independent apply output.",
  );
  const expectedBackupPath = backupPathFor(client, client.clientPvfSha256, policy);
  assertCondition(samePath(expectedBackupPath, loaded.inputs.backupPath), "Client backup path changed after deployment preview.");

  const manifestPath = path.resolve(loaded.inputs.deploymentManifestPath);
  assertOutsideWorkbench(manifestPath, "Deployment manifest");
  assertCondition(!fs.existsSync(manifestPath), "Refusing to overwrite an existing deployment manifest: " + manifestPath);
  const replacePaths = replacementPaths(client.clientPvf, "deploy");
  const manifest = {
    schemaVersion: "1.0",
    phase: "client-pvf-deployment",
    generatedAt: new Date().toISOString(),
    updatedAt: null,
    status: "initializing",
    manifestPath,
    profileName: profile.name,
    previewManifest: loaded.previewManifestPath,
    previewManifestSha256: loaded.previewManifestSha256,
    previewBindingSha256: loaded.binding.bindingSha256,
    applyManifest: apply.manifestPath,
    applyManifestSha256: apply.manifestSha256,
    sourcePvf: apply.sourcePvf,
    sourcePvfSha256: apply.sourcePvfSha256,
    outputPvf: apply.outputPvf,
    outputPvfSha256: apply.outputPvfSha256,
    clientRoot: client.clientRoot,
    clientPvf: client.clientPvf,
    clientPvfSha256Before: client.clientPvfSha256,
    clientPvfSha256After: apply.outputPvfSha256,
    backupPath: expectedBackupPath,
    backup: null,
    replacement: {
      ...replacePaths,
      sameDirectoryStaging: true,
      readbackOk: false,
    },
    completionBinding: null,
    safety: {
      separateClientAuthorizationVerified: true,
      clientClosedConfirmed: true,
      sourcePvfModified: false,
      applyOutputModified: false,
      clientPvfWritten: false,
      nonPvfClientResourceWrite: false,
      backupVerifiedBeforeReplace: false,
      currentClientSha256Bound: true,
      postDeploySha256Readback: false,
      rollbackAvailable: false,
    },
    history: [],
  };
  appendState(manifest, "prepared");

  try {
    const backup = ensureContentAddressedBackup(client.clientPvf, expectedBackupPath, client.clientPvfSha256);
    manifest.backup = backup;
    manifest.safety.backupVerifiedBeforeReplace = true;
    appendState(manifest, "backup-ready");

    const replacement = stagedReplace(
      apply.outputPvf,
      client.clientPvf,
      apply.outputPvfSha256,
      client.clientPvfSha256,
      replacePaths,
    );
    manifest.replacement = { ...manifest.replacement, ...replacement };
    manifest.safety.clientPvfWritten = true;
    manifest.safety.postDeploySha256Readback = true;
    manifest.safety.rollbackAvailable = true;
    const completionInputs = {
      schemaVersion: "1.0",
      operation: "completed-client-script-pvf-deploy",
      profileName: profile.name,
      previewBindingSha256: loaded.binding.bindingSha256,
      applyManifestSha256: apply.manifestSha256,
      outputPvfSha256: apply.outputPvfSha256,
      clientPvf: client.clientPvf,
      clientPvfSha256Before: client.clientPvfSha256,
      clientPvfSha256After: apply.outputPvfSha256,
      backupPath: backup.path,
      backupSha256: backup.sha256,
    };
    manifest.completionBinding = {
      inputs: completionInputs,
      bindingSha256: sha256Json(completionInputs),
    };
    appendState(manifest, "deployed", { completedAt: new Date().toISOString() });
    return manifest;
  } catch (error) {
    const actualTargetSha256 = fs.existsSync(client.clientPvf) ? sha256File(client.clientPvf) : null;
    const restored = actualTargetSha256 === client.clientPvfSha256;
    manifest.failure = {
      code: error.code || "CLIENT_PVF_DEPLOY_FAILED",
      message: error.message,
      actualTargetSha256,
      recovery: error.recovery || null,
    };
    manifest.safety.clientPvfWritten = actualTargetSha256 === apply.outputPvfSha256;
    manifest.safety.postDeploySha256Readback = actualTargetSha256 === apply.outputPvfSha256;
    manifest.safety.rollbackAvailable = Boolean(manifest.backup?.sha256 === client.clientPvfSha256);
    appendState(manifest, restored ? "failed-restored" : "recovery-required");
    error.manifestPath = manifestPath;
    throw error;
  }
}

function validateDeploymentManifest(manifestFile) {
  const manifestPath = assertRegularFile(manifestFile, "Deployment manifest");
  assertOutsideWorkbench(manifestPath, "Deployment manifest");
  const manifest = readJson(manifestPath);
  assertCondition(manifest.schemaVersion === "1.0", "Deployment manifest schemaVersion must be 1.0.");
  assertCondition(manifest.phase === "client-pvf-deployment", "Unexpected deployment manifest phase.");
  assertCondition(manifest.status === "deployed", "Deployment manifest is not in deployed state.");
  assertCondition(manifest.safety?.sourcePvfModified === false, "Deployment manifest does not preserve the source PVF.");
  assertCondition(manifest.safety?.applyOutputModified === false, "Deployment manifest does not preserve the apply output.");
  assertCondition(manifest.safety?.nonPvfClientResourceWrite === false, "Deployment manifest includes unsupported client resources.");
  assertCondition(manifest.safety?.backupVerifiedBeforeReplace === true, "Deployment backup was not verified.");
  assertCondition(manifest.safety?.postDeploySha256Readback === true, "Deployment target readback was not verified.");
  assertCondition(manifest.safety?.rollbackAvailable === true, "Deployment manifest does not provide rollback.");
  assertCondition(manifest.completionBinding?.inputs, "Deployment completion binding is missing.");
  const completionSha = sha256Json(manifest.completionBinding.inputs);
  assertCondition(completionSha === manifest.completionBinding.bindingSha256, "Deployment completion binding is invalid.");
  const inputs = manifest.completionBinding.inputs;
  assertCondition(samePath(inputs.clientPvf, manifest.clientPvf), "Deployment target differs from its completion binding.");
  assertCondition(inputs.clientPvfSha256Before === manifest.clientPvfSha256Before, "Deployment before-hash differs from its binding.");
  assertCondition(inputs.clientPvfSha256After === manifest.clientPvfSha256After, "Deployment after-hash differs from its binding.");
  assertCondition(samePath(inputs.backupPath, manifest.backupPath), "Deployment backup differs from its binding.");
  assertCondition(inputs.backupSha256 === manifest.backup?.sha256, "Deployment backup hash differs from its binding.");
  return {
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    manifest,
    inputs,
  };
}

function createRollbackPreview(options) {
  const policy = options.policy || loadPolicy();
  const deployment = validateDeploymentManifest(options.deploymentManifestPath);
  const profile = options.profile;
  assertCondition(profile?.name === deployment.manifest.profileName, "The selected profile does not match the deployment.");
  const client = resolveClientContext(profile, policy);
  assertCondition(samePath(client.clientPvf, deployment.manifest.clientPvf), "Profile client target no longer matches the deployment.");
  const backupPath = assertRegularFile(deployment.manifest.backupPath, "Deployment client PVF backup");
  const backupSha256 = sha256File(backupPath);
  assertCondition(
    backupSha256 === deployment.manifest.clientPvfSha256Before,
    "Deployment backup content no longer matches the original client PVF.",
    "BACKUP_HASH_MISMATCH",
  );

  const alreadyRolledBack = client.clientPvfSha256 === deployment.manifest.clientPvfSha256Before;
  if (!alreadyRolledBack) {
    assertCondition(
      client.clientPvfSha256 === deployment.manifest.clientPvfSha256After,
      "Client Script.pvf changed after deployment. Refusing to overwrite an unknown version during rollback.",
      "DIVERGENT_CLIENT_TARGET",
    );
  }

  const runRoot = ensureExternalRunRoot(options.outRoot, client.clientRoot);
  const previewManifestPath = path.join(
    runRoot,
    policy.outputs?.rollbackPreviewFileName || "CLIENT-PVF-ROLLBACK-PREVIEW.json",
  );
  const rollbackManifestPath = path.join(
    runRoot,
    policy.outputs?.rollbackManifestFileName || "CLIENT-PVF-ROLLBACK-MANIFEST.json",
  );
  assertCondition(!fs.existsSync(previewManifestPath), "Refusing to overwrite an existing rollback preview: " + previewManifestPath);
  assertCondition(!fs.existsSync(rollbackManifestPath), "Refusing to reuse a rollback run that already has a manifest: " + rollbackManifestPath);

  const bindingInputs = {
    schemaVersion: "1.0",
    operation: "rollback-client-script-pvf",
    profileName: profile.name,
    deploymentManifest: deployment.manifestPath,
    deploymentManifestSha256: deployment.manifestSha256,
    deploymentCompletionBindingSha256: deployment.manifest.completionBinding.bindingSha256,
    clientRoot: client.clientRoot,
    clientRootRealPath: client.clientRootRealPath,
    clientPvf: client.clientPvf,
    clientPvfSha256Current: client.clientPvfSha256,
    restoreFromBackup: backupPath,
    restoreSha256: backupSha256,
    rollbackManifestPath,
  };
  const binding = alreadyRolledBack ? null : makeBinding("ROLLBACK", bindingInputs);
  const preview = {
    schemaVersion: "1.0",
    phase: "client-pvf-rollback-preview",
    generatedAt: new Date().toISOString(),
    mode: "preview-only",
    ready: !alreadyRolledBack,
    noChange: alreadyRolledBack,
    profileName: profile.name,
    previewManifestPath,
    rollbackManifestPath,
    deploymentManifest: deployment.manifestPath,
    clientRoot: client.clientRoot,
    clientPvf: client.clientPvf,
    clientPvfSha256Current: client.clientPvfSha256,
    restoreFromBackup: backupPath,
    restoreSha256: backupSha256,
    binding,
    safety: {
      writeOperationsExecuted: false,
      clientWritten: false,
      deploymentManifestVerified: true,
      currentClientSha256Bound: true,
      backupSha256Verified: true,
      explicitAuthorizationRequired: true,
      clientClosedConfirmationRequired: true,
      nonPvfClientResourceWrite: false,
    },
    summary: {
      ready: !alreadyRolledBack,
      noChange: alreadyRolledBack,
      message: alreadyRolledBack
        ? "客户端已经恢复到部署前版本，没有执行操作。"
        : "恢复预览已完成，客户端尚未修改。关闭客户端和启动器并明确确认后才能继续。",
    },
  };
  writeJson(previewManifestPath, preview);
  return preview;
}

function validateRollbackPreview(previewFile) {
  const previewManifestPath = assertRegularFile(previewFile, "Rollback preview manifest");
  assertOutsideWorkbench(previewManifestPath, "Rollback preview manifest");
  const preview = readJson(previewManifestPath);
  assertCondition(preview.schemaVersion === "1.0", "Rollback preview schemaVersion must be 1.0.");
  assertCondition(preview.phase === "client-pvf-rollback-preview", "Unexpected rollback preview phase.");
  assertCondition(preview.mode === "preview-only", "Unexpected rollback preview mode.");
  assertCondition(preview.ready === true && preview.noChange === false, "Rollback preview is not ready.");
  assertCondition(preview.safety?.writeOperationsExecuted === false, "Rollback preview unexpectedly records writes.");
  const binding = validateBinding(preview.binding, "ROLLBACK", "Rollback preview");
  return {
    previewManifestPath,
    previewManifestSha256: sha256File(previewManifestPath),
    preview,
    binding,
    inputs: binding.inputs,
  };
}

function executeRollback(options) {
  const policy = options.policy || loadPolicy();
  const loaded = validateRollbackPreview(options.previewManifestPath);
  assertCondition(
    options.authorizationCode === loaded.binding.approvalCode,
    "Rollback authorization code does not match this deployment and client target.",
    "ROLLBACK_AUTHORIZATION_MISMATCH",
  );
  assertCondition(
    options.clientClosedConfirmed === true,
    "Close the client and launcher, then pass --confirm-client-closed.",
    "CLIENT_CLOSE_CONFIRMATION_REQUIRED",
  );
  const profile = options.profile;
  assertCondition(profile?.name === loaded.inputs.profileName, "The selected profile no longer matches the rollback preview.");
  const client = resolveClientContext(profile, policy);
  const deployment = validateDeploymentManifest(loaded.inputs.deploymentManifest);
  assertCondition(
    deployment.manifestSha256 === loaded.inputs.deploymentManifestSha256,
    "Deployment manifest changed after rollback preview.",
    "STALE_ROLLBACK_PREVIEW",
  );
  assertCondition(samePath(client.clientPvf, loaded.inputs.clientPvf), "Profile client target changed after rollback preview.");
  assertCondition(
    client.clientPvfSha256 === loaded.inputs.clientPvfSha256Current,
    "Client Script.pvf changed after rollback preview. Create a new rollback preview.",
    "STALE_CLIENT_TARGET",
  );
  const restoreFromBackup = assertRegularFile(loaded.inputs.restoreFromBackup, "Rollback source backup");
  const restoreSha256 = sha256File(restoreFromBackup);
  assertCondition(restoreSha256 === loaded.inputs.restoreSha256, "Rollback backup changed after preview.");
  const safetyBackupPath = backupPathFor(client, client.clientPvfSha256, policy);
  const manifestPath = path.resolve(loaded.inputs.rollbackManifestPath);
  assertOutsideWorkbench(manifestPath, "Rollback manifest");
  assertCondition(!fs.existsSync(manifestPath), "Refusing to overwrite an existing rollback manifest: " + manifestPath);
  const replacePaths = replacementPaths(client.clientPvf, "rollback");
  const manifest = {
    schemaVersion: "1.0",
    phase: "client-pvf-rollback",
    generatedAt: new Date().toISOString(),
    updatedAt: null,
    status: "initializing",
    manifestPath,
    profileName: profile.name,
    previewManifest: loaded.previewManifestPath,
    previewManifestSha256: loaded.previewManifestSha256,
    rollbackBindingSha256: loaded.binding.bindingSha256,
    deploymentManifest: deployment.manifestPath,
    deploymentManifestSha256: deployment.manifestSha256,
    clientPvf: client.clientPvf,
    clientPvfSha256BeforeRollback: client.clientPvfSha256,
    clientPvfSha256AfterRollback: restoreSha256,
    restoreFromBackup,
    safetyBackupPath,
    safetyBackup: null,
    replacement: {
      ...replacePaths,
      sameDirectoryStaging: true,
      readbackOk: false,
    },
    completionBinding: null,
    safety: {
      separateRollbackAuthorizationVerified: true,
      clientClosedConfirmed: true,
      sourcePvfModified: false,
      applyOutputModified: false,
      clientPvfWritten: false,
      nonPvfClientResourceWrite: false,
      currentClientBackedUpBeforeRollback: false,
      postRollbackSha256Readback: false,
    },
    history: [],
  };
  appendState(manifest, "prepared");

  try {
    const safetyBackup = ensureContentAddressedBackup(
      client.clientPvf,
      safetyBackupPath,
      client.clientPvfSha256,
    );
    manifest.safetyBackup = safetyBackup;
    manifest.safety.currentClientBackedUpBeforeRollback = true;
    appendState(manifest, "backup-ready");

    const replacement = stagedReplace(
      restoreFromBackup,
      client.clientPvf,
      restoreSha256,
      client.clientPvfSha256,
      replacePaths,
    );
    manifest.replacement = { ...manifest.replacement, ...replacement };
    manifest.safety.clientPvfWritten = true;
    manifest.safety.postRollbackSha256Readback = true;
    const completionInputs = {
      schemaVersion: "1.0",
      operation: "completed-client-script-pvf-rollback",
      profileName: profile.name,
      rollbackBindingSha256: loaded.binding.bindingSha256,
      deploymentManifestSha256: deployment.manifestSha256,
      clientPvf: client.clientPvf,
      clientPvfSha256BeforeRollback: client.clientPvfSha256,
      clientPvfSha256AfterRollback: restoreSha256,
      safetyBackupPath: safetyBackup.path,
      safetyBackupSha256: safetyBackup.sha256,
    };
    manifest.completionBinding = {
      inputs: completionInputs,
      bindingSha256: sha256Json(completionInputs),
    };
    appendState(manifest, "rolled-back", { completedAt: new Date().toISOString() });
    return manifest;
  } catch (error) {
    const actualTargetSha256 = fs.existsSync(client.clientPvf) ? sha256File(client.clientPvf) : null;
    const restored = actualTargetSha256 === client.clientPvfSha256;
    manifest.failure = {
      code: error.code || "CLIENT_PVF_ROLLBACK_FAILED",
      message: error.message,
      actualTargetSha256,
      recovery: error.recovery || null,
    };
    manifest.safety.clientPvfWritten = actualTargetSha256 === restoreSha256;
    manifest.safety.postRollbackSha256Readback = actualTargetSha256 === restoreSha256;
    appendState(manifest, restored ? "failed-restored" : "recovery-required");
    error.manifestPath = manifestPath;
    throw error;
  }
}

function visibleDeployPreview(preview) {
  return {
    schemaVersion: preview.schemaVersion,
    phase: preview.phase,
    previewManifestPath: preview.previewManifestPath,
    ready: preview.ready,
    noChange: preview.noChange,
    message: preview.summary.message,
    profileName: preview.profileName,
    clientPvf: preview.clientPvf,
    currentClientSha256: preview.clientPvfSha256Before,
    outputPvf: preview.outputPvf,
    outputPvfSha256: preview.outputPvfSha256,
    backupPath: preview.backupPath,
    approvalCode: preview.binding?.approvalCode || null,
    nextStep: preview.ready
      ? "关闭客户端和启动器，获得用户明确确认后执行 client-pvf deploy。"
      : "无需部署。",
  };
}

function visibleDeployment(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    phase: manifest.phase,
    status: manifest.status,
    manifestPath: manifest.manifestPath,
    message: "客户端 Script.pvf 已部署并核对，原版本可恢复。现在可以进游戏测试。",
    profileName: manifest.profileName,
    clientPvf: manifest.clientPvf,
    beforeSha256: manifest.clientPvfSha256Before,
    afterSha256: manifest.clientPvfSha256After,
    backupPath: manifest.backupPath,
    backupReused: manifest.backup?.reused || false,
    nonPvfClientResourcesWritten: false,
  };
}

function visibleRollbackPreview(preview) {
  return {
    schemaVersion: preview.schemaVersion,
    phase: preview.phase,
    previewManifestPath: preview.previewManifestPath,
    ready: preview.ready,
    noChange: preview.noChange,
    message: preview.summary.message,
    profileName: preview.profileName,
    clientPvf: preview.clientPvf,
    currentClientSha256: preview.clientPvfSha256Current,
    restoreSha256: preview.restoreSha256,
    approvalCode: preview.binding?.approvalCode || null,
    nextStep: preview.ready
      ? "关闭客户端和启动器，获得用户明确确认后执行 client-pvf rollback。"
      : "无需恢复。",
  };
}

function visibleRollback(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    phase: manifest.phase,
    status: manifest.status,
    manifestPath: manifest.manifestPath,
    message: "客户端 Script.pvf 已恢复到部署前版本并核对。",
    profileName: manifest.profileName,
    clientPvf: manifest.clientPvf,
    beforeSha256: manifest.clientPvfSha256BeforeRollback,
    afterSha256: manifest.clientPvfSha256AfterRollback,
    nonPvfClientResourcesWritten: false,
  };
}

function expectFailure(checks, id, fn, expectedCode) {
  try {
    fn();
    checks.push({ id, ok: false, reason: "operation unexpectedly succeeded" });
  } catch (error) {
    checks.push({
      id,
      ok: expectedCode ? error.code === expectedCode : true,
      code: error.code || null,
      expectedCode: expectedCode || null,
    });
  }
}

function selfTest(options) {
  const policy = loadPolicy();
  const outRoot = path.resolve(
    options.outRoot || runtimePath(workbenchRoot, "client-pvf-deployments", timestamp(), "self-test"),
  );
  assertOutsideWorkbench(outRoot, "Client PVF deployment self-test output");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-client-deploy-self-test-"));
  const checks = [];
  try {
    const sourceDir = path.join(tempRoot, "source");
    const applyDir = path.join(tempRoot, "apply");
    const clientRoot = path.join(tempRoot, "client");
    const profileOutput = path.join(tempRoot, "profile-output");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(applyDir, { recursive: true });
    fs.mkdirSync(clientRoot, { recursive: true });
    fs.mkdirSync(profileOutput, { recursive: true });

    const sourcePvf = path.join(sourceDir, "Script.pvf");
    const outputPvf = path.join(applyDir, "Script.pvf");
    const clientPvf = path.join(clientRoot, "Script.pvf");
    const markerNpk = path.join(clientRoot, "marker.npk");
    fs.writeFileSync(sourcePvf, "source-pvf-fixture-v1\n", "utf8");
    fs.writeFileSync(outputPvf, "output-pvf-fixture-v2\n", "utf8");
    fs.writeFileSync(clientPvf, "client-pvf-fixture-v1\n", "utf8");
    fs.writeFileSync(markerNpk, "npk-marker-must-not-change\n", "utf8");
    const sourceSha = sha256File(sourcePvf);
    const outputSha = sha256File(outputPvf);
    const originalClientSha = sha256File(clientPvf);
    const markerSha = sha256File(markerNpk);

    const applyManifestPath = path.join(applyDir, "APPLY-MANIFEST.json");
    const applyManifest = {
      schemaVersion: "1.0",
      phase: "phase-3-controlled-output-apply",
      mode: "controlled-output-only",
      sourcePvf,
      outputPvf,
      sourcePvfSha256: sourceSha,
      outputPvfSha256: outputSha,
      outputPvfBytes: fs.statSync(outputPvf).size,
      safety: {
        sourceOverwritten: false,
        backupCreated: true,
        matchingDryRunVerified: true,
        explicitUserAuthorizationVerified: true,
        readbackOk: true,
        outputSha256Bound: true,
        clientResourceWrite: false,
      },
      summary: {
        outputExists: true,
        readbackOk: true,
        outputSha256Verified: true,
      },
    };
    writeJson(applyManifestPath, applyManifest);
    const profile = {
      name: "fixture-client",
      enabled: true,
      sourcePvf,
      output: profileOutput,
      client: clientRoot,
      safety: {
        defaultMode: "read-only",
        writeMode: { enabled: false },
        clientWrite: { enabled: false, requiresSeparateAuthorization: true },
      },
    };

    const deployRun1 = path.join(tempRoot, "runs", "deploy-1");
    const preview = createDeployPreview({
      policy,
      profile,
      applyManifestPath,
      outRoot: deployRun1,
    });
    checks.push({
      id: "preview-does-not-write-client",
      ok: preview.ready === true && sha256File(clientPvf) === originalClientSha && sha256File(markerNpk) === markerSha,
    });
    expectFailure(
      checks,
      "wrong-deploy-code-rejected",
      () =>
        executeDeploy({
          policy,
          profile,
          previewManifestPath: preview.previewManifestPath,
          authorizationCode: "DEPLOY-WRONG",
          clientClosedConfirmed: true,
        }),
      "DEPLOY_AUTHORIZATION_MISMATCH",
    );
    expectFailure(
      checks,
      "missing-client-close-confirmation-rejected",
      () =>
        executeDeploy({
          policy,
          profile,
          previewManifestPath: preview.previewManifestPath,
          authorizationCode: preview.binding.approvalCode,
          clientClosedConfirmed: false,
        }),
      "CLIENT_CLOSE_CONFIRMATION_REQUIRED",
    );
    fs.writeFileSync(clientPvf, "client-pvf-stale-change\n", "utf8");
    expectFailure(
      checks,
      "stale-client-target-rejected",
      () =>
        executeDeploy({
          policy,
          profile,
          previewManifestPath: preview.previewManifestPath,
          authorizationCode: preview.binding.approvalCode,
          clientClosedConfirmed: true,
        }),
      "STALE_CLIENT_TARGET",
    );
    fs.writeFileSync(clientPvf, "client-pvf-fixture-v1\n", "utf8");

    const deployment = executeDeploy({
      policy,
      profile,
      previewManifestPath: preview.previewManifestPath,
      authorizationCode: preview.binding.approvalCode,
      clientClosedConfirmed: true,
    });
    checks.push({
      id: "deploy-backed-up-and-read-back",
      ok:
        deployment.status === "deployed" &&
        sha256File(clientPvf) === outputSha &&
        sha256File(deployment.backupPath) === originalClientSha &&
        deployment.safety.postDeploySha256Readback === true,
    });
    checks.push({
      id: "source-output-and-npk-untouched",
      ok: sha256File(sourcePvf) === sourceSha && sha256File(outputPvf) === outputSha && sha256File(markerNpk) === markerSha,
    });

    const noChangePreview = createDeployPreview({
      policy,
      profile,
      applyManifestPath,
      outRoot: path.join(tempRoot, "runs", "no-change"),
    });
    checks.push({
      id: "already-deployed-is-no-op",
      ok: noChangePreview.ready === false && noChangePreview.noChange === true && noChangePreview.binding === null,
    });

    const rollbackPreview = createRollbackPreview({
      policy,
      profile,
      deploymentManifestPath: deployment.manifestPath,
      outRoot: path.join(tempRoot, "runs", "rollback-1"),
    });
    checks.push({
      id: "rollback-preview-does-not-write-client",
      ok: rollbackPreview.ready === true && sha256File(clientPvf) === outputSha,
    });
    expectFailure(
      checks,
      "wrong-rollback-code-rejected",
      () =>
        executeRollback({
          policy,
          profile,
          previewManifestPath: rollbackPreview.previewManifestPath,
          authorizationCode: "ROLLBACK-WRONG",
          clientClosedConfirmed: true,
        }),
      "ROLLBACK_AUTHORIZATION_MISMATCH",
    );
    const rollback = executeRollback({
      policy,
      profile,
      previewManifestPath: rollbackPreview.previewManifestPath,
      authorizationCode: rollbackPreview.binding.approvalCode,
      clientClosedConfirmed: true,
    });
    checks.push({
      id: "rollback-restores-exact-client-version",
      ok:
        rollback.status === "rolled-back" &&
        sha256File(clientPvf) === originalClientSha &&
        rollback.safety.postRollbackSha256Readback === true,
    });

    const deployRun2 = path.join(tempRoot, "runs", "deploy-2");
    const preview2 = createDeployPreview({ policy, profile, applyManifestPath, outRoot: deployRun2 });
    const deployment2 = executeDeploy({
      policy,
      profile,
      previewManifestPath: preview2.previewManifestPath,
      authorizationCode: preview2.binding.approvalCode,
      clientClosedConfirmed: true,
    });
    checks.push({
      id: "identical-original-backup-is-deduplicated",
      ok: deployment2.backup.reused === true && deployment2.backup.created === false,
    });
    const rollbackPreview2 = createRollbackPreview({
      policy,
      profile,
      deploymentManifestPath: deployment2.manifestPath,
      outRoot: path.join(tempRoot, "runs", "rollback-2"),
    });
    executeRollback({
      policy,
      profile,
      previewManifestPath: rollbackPreview2.previewManifestPath,
      authorizationCode: rollbackPreview2.binding.approvalCode,
      clientClosedConfirmed: true,
    });
    checks.push({
      id: "repeat-cycle-ends-at-original",
      ok: sha256File(clientPvf) === originalClientSha && sha256File(markerNpk) === markerSha,
    });

    const legacyManifestPath = path.join(applyDir, "LEGACY-APPLY-MANIFEST.json");
    const legacyManifest = JSON.parse(JSON.stringify(applyManifest));
    delete legacyManifest.outputPvfSha256;
    delete legacyManifest.outputPvfBytes;
    delete legacyManifest.safety.outputSha256Bound;
    delete legacyManifest.summary.outputSha256Verified;
    writeJson(legacyManifestPath, legacyManifest);
    expectFailure(
      checks,
      "legacy-unbound-apply-manifest-rejected",
      () =>
        createDeployPreview({
          policy,
          profile,
          applyManifestPath: legacyManifestPath,
          outRoot: path.join(tempRoot, "runs", "legacy"),
        }),
      "APPLY_OUTPUT_SHA_UNBOUND",
    );

    fs.writeFileSync(sourcePvf, "source-pvf-fixture-changed\n", "utf8");
    expectFailure(
      checks,
      "changed-apply-source-rejected",
      () =>
        createDeployPreview({
          policy,
          profile,
          applyManifestPath,
          outRoot: path.join(tempRoot, "runs", "changed-source"),
        }),
      "APPLY_SOURCE_CHANGED",
    );
    fs.writeFileSync(sourcePvf, "source-pvf-fixture-v1\n", "utf8");

    const otherSourcePvf = path.join(sourceDir, "Other-Script.pvf");
    fs.writeFileSync(otherSourcePvf, "other-source-pvf\n", "utf8");
    expectFailure(
      checks,
      "profile-apply-source-mismatch-rejected",
      () =>
        createDeployPreview({
          policy,
          profile: { ...profile, sourcePvf: otherSourcePvf },
          applyManifestPath,
          outRoot: path.join(tempRoot, "runs", "profile-source-mismatch"),
        }),
      "PROFILE_APPLY_SOURCE_MISMATCH",
    );
    expectFailure(
      checks,
      "backup-output-inside-client-rejected",
      () =>
        createDeployPreview({
          policy,
          profile: { ...profile, output: path.join(clientRoot, "unsafe-backups") },
          applyManifestPath,
          outRoot: path.join(tempRoot, "runs", "unsafe-backup-root"),
        }),
      "CLIENT_OUTPUT_BOUNDARY",
    );

    const collisionManifestPath = path.join(applyDir, "COLLISION-APPLY-MANIFEST.json");
    const collisionManifest = {
      ...applyManifest,
      sourcePvf: clientPvf,
      sourcePvfSha256: originalClientSha,
    };
    writeJson(collisionManifestPath, collisionManifest);
    expectFailure(
      checks,
      "source-client-collision-rejected",
      () =>
        createDeployPreview({
          policy,
          profile,
          applyManifestPath: collisionManifestPath,
          outRoot: path.join(tempRoot, "runs", "collision"),
        }),
      "SOURCE_CLIENT_COLLISION",
    );
  } finally {
    assertCondition(pathInside(os.tmpdir(), tempRoot), "Unsafe client deployment self-test cleanup path.");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const reportPath = path.join(outRoot, "CLIENT-PVF-DEPLOYMENT-SELF-TEST.json");
  const report = {
    schemaVersion: "1.0",
    phase: "client-pvf-deployment-self-test",
    generatedAt: new Date().toISOString(),
    reportPath,
    safety: {
      fixtureOnly: true,
      realPvfRequired: false,
      realClientRequired: false,
      sourcePvfModified: false,
      nonPvfClientResourceWrite: false,
    },
    summary: {
      ok: checks.every((check) => check.ok),
      checkCount: checks.length,
      passedChecks: checks.filter((check) => check.ok).length,
      failedChecks: checks.filter((check) => !check.ok).length,
    },
    checks,
  };
  writeJson(reportPath, report);
  return report;
}

function resolveNamedProfile(name) {
  const profile = resolveProfile(workbenchRoot, name);
  assertCondition(profile, "Provide --profile or select an active workspace profile.");
  return profile;
}

function main() {
  if (command === "help" || command === "--help" || command === "-h" || flag("--help") || flag("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (command === "preview") {
    const profile = resolveNamedProfile(option("--profile"));
    const outRoot = path.resolve(
      option(
        "--out",
        runtimePath(workbenchRoot, "client-pvf-deployments", timestamp(), safeName(profile.name), "deploy"),
      ),
    );
    const preview = createDeployPreview({
      profile,
      applyManifestPath: requireOption("--apply-manifest"),
      outRoot,
    });
    process.stdout.write(JSON.stringify(visibleDeployPreview(preview), null, 2) + "\n");
    return;
  }
  if (command === "deploy") {
    const loaded = validateDeployPreview(requireOption("--preview-manifest"));
    const profile = resolveNamedProfile(loaded.inputs.profileName);
    const manifest = executeDeploy({
      profile,
      previewManifestPath: loaded.previewManifestPath,
      authorizationCode: requireOption("--authorize-deploy"),
      clientClosedConfirmed: flag("--confirm-client-closed"),
    });
    process.stdout.write(JSON.stringify(visibleDeployment(manifest), null, 2) + "\n");
    return;
  }
  if (command === "rollback-preview") {
    const deployment = validateDeploymentManifest(requireOption("--deployment-manifest"));
    const profile = resolveNamedProfile(deployment.manifest.profileName);
    const outRoot = path.resolve(
      option(
        "--out",
        runtimePath(workbenchRoot, "client-pvf-deployments", timestamp(), safeName(profile.name), "rollback"),
      ),
    );
    const preview = createRollbackPreview({
      profile,
      deploymentManifestPath: deployment.manifestPath,
      outRoot,
    });
    process.stdout.write(JSON.stringify(visibleRollbackPreview(preview), null, 2) + "\n");
    return;
  }
  if (command === "rollback") {
    const loaded = validateRollbackPreview(requireOption("--preview-manifest"));
    const profile = resolveNamedProfile(loaded.inputs.profileName);
    const manifest = executeRollback({
      profile,
      previewManifestPath: loaded.previewManifestPath,
      authorizationCode: requireOption("--authorize-rollback"),
      clientClosedConfirmed: flag("--confirm-client-closed"),
    });
    process.stdout.write(JSON.stringify(visibleRollback(manifest), null, 2) + "\n");
    return;
  }
  if (command === "self-test") {
    const report = selfTest({ outRoot: option("--out") });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.summary.ok) process.exitCode = 1;
    return;
  }
  throw new Error(usage());
}

try {
  main();
} catch (error) {
  const details = {
    ok: false,
    command,
    code: error.code || "CLIENT_PVF_ERROR",
    message: error.message,
    manifestPath: error.manifestPath || null,
  };
  process.stderr.write(JSON.stringify(details, null, 2) + "\n");
  process.exitCode = 1;
}
