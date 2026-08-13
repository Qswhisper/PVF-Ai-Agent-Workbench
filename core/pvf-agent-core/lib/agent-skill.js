"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_NAME = "dnf-pvf-xpilot";
const INSTALL_MARKER = ".workbench-skill-install.json";

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name !== INSTALL_MARKER) files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function hashSkillDirectory(skillDir) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(skillDir)) {
    const relative = path.relative(skillDir, file).replace(/\\/g, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(hashFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-z][a-z0-9-]*):\s*(.+)$/);
    if (field) fields[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return { fields, body: text.slice(match[0].length) };
}

function bundledSkillDir(workbenchRoot) {
  return path.join(path.resolve(workbenchRoot), ".agents", "skills", SKILL_NAME);
}

function validateBundledSkill(workbenchRoot) {
  const root = path.resolve(workbenchRoot);
  const skillDir = bundledSkillDir(root);
  const errors = [];
  const required = ["SKILL.md", path.join("agents", "openai.yaml")];
  for (const relative of required) {
    if (!fs.existsSync(path.join(skillDir, relative))) errors.push(`Missing skill file: ${relative}`);
  }
  if (!fs.existsSync(path.join(root, "release", "AGENT-WORKSPACE-MANIFEST.json"))) {
    errors.push("Workbench root is missing release/AGENT-WORKSPACE-MANIFEST.json.");
  }

  const skillFile = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(skillFile)) {
    const text = fs.readFileSync(skillFile, "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) {
      errors.push("SKILL.md frontmatter is missing or malformed.");
    } else {
      const keys = Object.keys(parsed.fields).sort();
      if (keys.join(",") !== "description,name") errors.push("SKILL.md frontmatter must contain only name and description.");
      if (parsed.fields.name !== SKILL_NAME) errors.push(`SKILL.md name must be ${SKILL_NAME}.`);
      if (!parsed.fields.description || parsed.fields.description.length > 1024) errors.push("SKILL.md description must be 1-1024 characters.");
      for (const requiredText of ["release/AGENT-WORKSPACE-MANIFEST.json", "AGENTS.md", "knowledge-pack/indexes/knowledge-index.json", "pvf-read read --raw", "independent canonical token layout", "content-addressed source backup", "readback", "dry-run manifest and approval code", "Workbench-bundled native backend", "bundled TypeScript read-only backend", "without npm or a build step", "READ_ONLY_FALLBACK", "self-contained", "knowledge-query bookmark", "workbench.bat research", "external claim store", "workbench.bat client-pvf", "rollback-preview", "技术详情（通常不用看）"]) {
        if (!parsed.body.includes(requiredText)) errors.push(`SKILL.md is missing required routing or safety text: ${requiredText}`);
      }
    }
    if (/\bTODO\b/.test(text)) errors.push("SKILL.md still contains TODO text.");
    if (/[A-Za-z]:\\/.test(text)) errors.push("SKILL.md must not contain machine-specific absolute Windows paths.");
  }

  const openaiFile = path.join(skillDir, "agents", "openai.yaml");
  if (fs.existsSync(openaiFile)) {
    const text = fs.readFileSync(openaiFile, "utf8");
    if (!/default_prompt:\s*"[^"]*\$dnf-pvf-xpilot/.test(text)) errors.push("agents/openai.yaml default_prompt must mention $dnf-pvf-xpilot.");
    if (/[A-Za-z]:\\/.test(text)) errors.push("agents/openai.yaml must not contain machine-specific absolute Windows paths.");
  }

  return {
    ok: errors.length === 0,
    skillName: SKILL_NAME,
    skillDir,
    sourceHash: fs.existsSync(skillFile) ? hashSkillDirectory(skillDir) : null,
    errors,
  };
}

function defaultSkillsRoot(client) {
  const home = os.homedir();
  if (client === "agents") return path.join(home, ".agents", "skills");
  if (client === "codex") return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills");
  throw new Error(`Unsupported client: ${client}. Use codex or agents.`);
}

function resolveTarget(client, targetRoot) {
  const skillsRoot = path.resolve(targetRoot || defaultSkillsRoot(client));
  const targetDir = path.join(skillsRoot, SKILL_NAME);
  if (!pathInside(skillsRoot, targetDir) || path.basename(targetDir) !== SKILL_NAME) {
    throw new Error(`Unsafe skill target: ${targetDir}`);
  }
  return { skillsRoot, targetDir };
}

function readInstallMarker(targetDir) {
  const markerFile = path.join(targetDir, INSTALL_MARKER);
  if (!fs.existsSync(markerFile)) return null;
  try {
    return readJson(markerFile);
  } catch {
    return null;
  }
}

function skillStatus(workbenchRoot, options = {}) {
  const client = options.client || "codex";
  const source = validateBundledSkill(workbenchRoot);
  const { skillsRoot, targetDir } = resolveTarget(client, options.targetRoot);
  const exists = fs.existsSync(targetDir);
  const marker = exists ? readInstallMarker(targetDir) : null;
  const managed = marker?.manager === "PVF-Agent-Workbench" && marker?.skillName === SKILL_NAME;
  const installedHash = exists && fs.statSync(targetDir).isDirectory() ? hashSkillDirectory(targetDir) : null;
  return {
    ok: source.ok,
    client,
    skillsRoot,
    targetDir,
    exists,
    managed,
    packageVersion: marker?.packageVersion || null,
    sourceWorkbenchRoot: marker?.sourceWorkbenchRoot || null,
    installedHash,
    expectedHash: source.sourceHash,
    upToDate: managed && installedHash === source.sourceHash,
    sourceErrors: source.errors,
  };
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === INSTALL_MARKER) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
  }
}

function removeVerifiedDirectory(parent, target) {
  if (!pathInside(parent, target) || path.resolve(parent) === path.resolve(target)) {
    throw new Error(`Refusing to remove unsafe directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function installSkill(workbenchRoot, options = {}) {
  const root = path.resolve(workbenchRoot);
  const client = options.client || "codex";
  const validation = validateBundledSkill(root);
  if (!validation.ok) throw new Error(`Bundled skill validation failed:\n${validation.errors.join("\n")}`);
  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
  const { skillsRoot, targetDir } = resolveTarget(client, options.targetRoot);
  fs.mkdirSync(skillsRoot, { recursive: true });

  const targetExists = fs.existsSync(targetDir);
  const existingMarker = targetExists ? readInstallMarker(targetDir) : null;
  const managed = existingMarker?.manager === "PVF-Agent-Workbench" && existingMarker?.skillName === SKILL_NAME;
  if (targetExists && !managed && options.force !== true) {
    throw new Error(`Refusing to overwrite an unmanaged skill at ${targetDir}. Re-run with --force to preserve it as a timestamped backup.`);
  }

  const stageDir = path.join(skillsRoot, `.${SKILL_NAME}.install-${process.pid}-${Date.now()}`);
  const backupDir = targetExists ? path.join(skillsRoot, `${SKILL_NAME}.backup-${timestamp()}`) : null;
  if (fs.existsSync(stageDir)) removeVerifiedDirectory(skillsRoot, stageDir);
  copyDirectory(validation.skillDir, stageDir);
  writeJson(path.join(stageDir, INSTALL_MARKER), {
    schemaVersion: "1.0",
    manager: "PVF-Agent-Workbench",
    skillName: SKILL_NAME,
    packageVersion: version,
    sourceWorkbenchRoot: root,
    sourceHash: validation.sourceHash,
    installedAt: new Date().toISOString(),
  });

  let movedExisting = false;
  try {
    if (targetExists) {
      if (fs.existsSync(backupDir)) throw new Error(`Backup target already exists: ${backupDir}`);
      fs.renameSync(targetDir, backupDir);
      movedExisting = true;
    }
    fs.renameSync(stageDir, targetDir);
  } catch (error) {
    if (fs.existsSync(stageDir)) removeVerifiedDirectory(skillsRoot, stageDir);
    if (movedExisting && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
    throw error;
  }

  let retainedBackup = backupDir;
  if (managed && backupDir && fs.existsSync(backupDir)) {
    removeVerifiedDirectory(skillsRoot, backupDir);
    retainedBackup = null;
  }

  return {
    ok: true,
    client,
    targetDir,
    packageVersion: version,
    sourceHash: validation.sourceHash,
    replacedManagedInstall: managed,
    retainedBackup,
  };
}

function selfTest(workbenchRoot) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-agent-skill-self-test-"));
  const checks = [];
  try {
    const skillsRoot = path.join(tempRoot, "skills");
    const validation = validateBundledSkill(workbenchRoot);
    checks.push({ id: "validate-bundled-skill", ok: validation.ok });

    installSkill(workbenchRoot, { client: "codex", targetRoot: skillsRoot });
    let status = skillStatus(workbenchRoot, { client: "codex", targetRoot: skillsRoot });
    checks.push({ id: "fresh-install-managed", ok: status.managed && status.upToDate });

    fs.appendFileSync(path.join(status.targetDir, "SKILL.md"), "\n", "utf8");
    status = skillStatus(workbenchRoot, { client: "codex", targetRoot: skillsRoot });
    checks.push({ id: "drift-detected", ok: status.managed && !status.upToDate });

    installSkill(workbenchRoot, { client: "codex", targetRoot: skillsRoot });
    status = skillStatus(workbenchRoot, { client: "codex", targetRoot: skillsRoot });
    checks.push({ id: "managed-update-restored", ok: status.managed && status.upToDate });

    const foreignRoot = path.join(tempRoot, "foreign-skills");
    const foreignTarget = path.join(foreignRoot, SKILL_NAME);
    fs.mkdirSync(foreignTarget, { recursive: true });
    fs.writeFileSync(path.join(foreignTarget, "SKILL.md"), "foreign\n", "utf8");
    let conflictRejected = false;
    try {
      installSkill(workbenchRoot, { client: "codex", targetRoot: foreignRoot });
    } catch (error) {
      conflictRejected = /Refusing to overwrite an unmanaged skill/.test(String(error.message));
    }
    checks.push({ id: "foreign-conflict-rejected", ok: conflictRejected });
  } finally {
    removeVerifiedDirectory(os.tmpdir(), tempRoot);
  }
  return {
    schemaVersion: "1.0",
    phase: "agent-skill-installer-self-test",
    generatedAt: new Date().toISOString(),
    summary: {
      ok: checks.every((check) => check.ok),
      checkCount: checks.length,
      failedChecks: checks.filter((check) => !check.ok).length,
    },
    checks,
  };
}

module.exports = {
  INSTALL_MARKER,
  SKILL_NAME,
  bundledSkillDir,
  hashSkillDirectory,
  installSkill,
  selfTest,
  skillStatus,
  validateBundledSkill,
};
