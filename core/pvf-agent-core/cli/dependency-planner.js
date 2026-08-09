"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { assertExternalOutput, pathInside, readJson, safeId, sha256, sha256File, timestamp, writeJsonAtomic } = require("../lib/research-store");

const DOMAINS = ["dungeon", "town", "monster", "passiveobject", "apc", "ani", "equipment", "stackable", "package", "orb", "quest", "set"];
const ITEM_DOMAINS = new Set(["equipment", "stackable", "package", "orb", "set"]);
const ROOT_TYPES = {
  dungeon: ["dungeon"],
  town: ["town"],
  monster: ["monster"],
  passiveobject: ["passiveobject"],
  apc: ["aicharacter"],
  ani: ["ani"],
  equipment: ["equipment"],
  stackable: ["stackable"],
  package: ["stackable"],
  orb: ["stackable"],
  quest: ["quest"],
  set: ["equipment"],
};
const DOMAIN_REGISTRY = {
  dungeon: "dungeon",
  town: "town",
  monster: "monster",
  passiveobject: "passiveobject",
  apc: "aicharacter",
  quest: "quest",
};
const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = String(args[0] || "help").toLowerCase();

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) {
  return args.includes(name);
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function numberOption(name, fallback, max = 5000) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return value;
}

function usage() {
  return `Usage:
  workbench.bat dependency-plan plan --pvf <Script.pvf> --domain <${DOMAINS.join("|")}> (--id <number> | --path <pvf-path> | --query <text> | --sample-kind equipment|stackable) [--sample-keyword <text>] [--depth 2] [--limit 40] [--encoding Cn] [--out <external-dir>] [--force]
  workbench.bat dependency-plan batch --profile <PRIVATE-DEPENDENCY-PLANNER-PROFILE.json> [--out <external-dir>] [--reuse-raw] [--force]
  workbench.bat dependency-plan self-test

All domains are read-only preview planners. They output nodes, registry-resolved edges, unresolved references, client-asset candidates, risks, and a controlled-write handoff boundary. They never write PVF/NPK/IMG or generate an apply patch.
`;
}

function domainExpand(domain) {
  return ({ dungeon: "dungeon", town: "town", monster: "monster", passiveobject: "passiveobject", apc: "monster", ani: "file", quest: "quest" })[domain] || "file";
}

function domainType(domain) {
  return domain === "equipment" || domain === "set" ? "equipment" : "stackable";
}

function planRequestFromArgs() {
  return {
    id: option("--plan-id", option("--domain", "plan")),
    pvf: path.resolve(required("--pvf")),
    domain: String(required("--domain")).toLowerCase(),
    idValue: option("--id") === undefined ? null : Number(option("--id")),
    path: option("--path", ""),
    query: option("--query", ""),
    sampleKind: option("--sample-kind", ""),
    sampleKeyword: option("--sample-keyword", ""),
    depth: numberOption("--depth", 2, 5),
    limit: numberOption("--limit", 40, 300),
    maxNodes: numberOption("--max-nodes", 800, 5000),
    encoding: option("--encoding", "Cn"),
  };
}

function validateRequest(request) {
  if (!DOMAINS.includes(request.domain)) throw new Error(`Unsupported dependency planner domain: ${request.domain}`);
  if (!fs.existsSync(request.pvf) || !fs.statSync(request.pvf).isFile()) throw new Error(`PVF does not exist: ${request.pvf}`);
  const selectorCount = [request.idValue !== null, Boolean(request.path), Boolean(request.query), Boolean(request.sampleKind)].filter(Boolean).length;
  if (selectorCount !== 1) throw new Error("Provide exactly one selector: --id, --path, --query, or --sample-kind.");
  if (request.idValue !== null && (!Number.isSafeInteger(request.idValue) || request.idValue < 0)) throw new Error("--id must be a non-negative safe integer.");
  if (request.idValue !== null && !ITEM_DOMAINS.has(request.domain) && !DOMAIN_REGISTRY[request.domain]) {
    throw new Error(`--id is not registry-backed for domain ${request.domain}; use --path or --query.`);
  }
  if (request.sampleKind && !["equipment", "stackable"].includes(request.sampleKind)) throw new Error("--sample-kind must be equipment or stackable.");
  if (request.sampleKind && !ITEM_DOMAINS.has(request.domain)) throw new Error("--sample-kind is only available for item planner domains.");
  if (request.sampleKind && domainType(request.domain) !== request.sampleKind) throw new Error(`--sample-kind=${request.sampleKind} does not match domain ${request.domain}.`);
}

function canonicalRequest(request, pvfSha256) {
  return {
    pvfSha256,
    domain: request.domain,
    idValue: request.idValue,
    path: request.path,
    query: request.query,
    sampleKind: request.sampleKind,
    sampleKeyword: request.sampleKeyword,
    depth: request.depth,
    limit: request.limit,
    maxNodes: request.maxNodes,
    encoding: request.encoding,
  };
}

function requestFingerprint(request, pvfSha256) {
  return sha256(JSON.stringify(canonicalRequest(request, pvfSha256)));
}

function invoke(script, scriptArgs, timeoutMs = 300000) {
  const result = childProcess.spawnSync(process.execPath, [path.join(workbenchRoot, script), ...scriptArgs], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.status}): ${result.stderr || result.stdout}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function rawPlannerArgs(request, rawPath, rawMdPath) {
  if (ITEM_DOMAINS.has(request.domain)) {
    const result = [
      `--pvf=${request.pvf}`,
      `--encoding=${request.encoding}`,
      `--type=${domainType(request.domain)}`,
      `--depth=${request.depth}`,
      `--limit=${request.limit}`,
      `--max-nodes=${request.maxNodes}`,
      `--out=${rawPath}`,
      `--md-out=${rawMdPath}`,
    ];
    if (request.idValue !== null) result.push(`--id=${request.idValue}`);
    if (request.path) result.push(`--path=${request.path}`);
    if (request.query) result.push(`--query=${request.query}`);
    if (request.sampleKind) result.push(`--sample-kind=${request.sampleKind}`);
    if (request.sampleKeyword) result.push(`--sample-keyword=${request.sampleKeyword}`);
    return { script: "tools/pvf-bridge/plan-item-stackable-dependencies.js", args: result, lane: "item-stackable-clean-room" };
  }
  const query = request.path || (request.idValue !== null ? String(request.idValue) : request.query);
  const selectorArgs = request.idValue !== null
    ? ["--selector-mode=registry-id", `--selector-registry=${DOMAIN_REGISTRY[request.domain]}`]
    : request.path
      ? ["--selector-mode=exact-path"]
      : ["--selector-mode=query"];
  return {
    script: "tools/pvf-bridge/pvf-scope-planner.js",
    args: [
      `--pvf=${request.pvf}`,
      `--encoding=${request.encoding}`,
      `--query=${query}`,
      `--expand=${domainExpand(request.domain)}`,
      `--depth=${request.depth}`,
      `--limit=${request.limit}`,
      `--out=${rawPath}`,
      `--md-out=${rawMdPath}`,
      ...selectorArgs,
    ],
    lane: "scope-clean-room",
  };
}

function edgeKey(edge) {
  return `${edge.relationKind || edge.kind || "relation"}:${edge.source?.pvfPath || ""}:${edge.target?.pvfPath || edge.target?.id || ""}`;
}

function normalizeArtifact(domain, request, raw, sourcePvfSha256, lane) {
  const nodes = (raw.candidates || []).map((item) => ({
    type: item.type || "file",
    id: item.id ?? null,
    pvfPath: item.pvfPath || "",
    registryPath: item.registryPath || null,
    exists: item.exists !== false,
    confidence: item.confidence || (item.root ? "high" : "medium"),
    root: Boolean(item.root),
    reasons: item.reasons || [],
  }));
  if (!nodes.some((item) => item.root)) {
    const requestedPath = String(request.path || "").replace(/\\/g, "/").toLowerCase();
    let inferred = requestedPath ? nodes.find((item) => item.pvfPath.replace(/\\/g, "/").toLowerCase() === requestedPath) : null;
    const expectedTypes = ROOT_TYPES[domain] || [];
    if (!inferred && request.idValue !== null && request.idValue !== undefined) {
      inferred = nodes.find((item) => item.id === Number(request.idValue) && expectedTypes.includes(item.type));
    }
    if (!inferred && request.query && nodes.filter((item) => expectedTypes.includes(item.type)).length === 1) {
      inferred = nodes.find((item) => expectedTypes.includes(item.type));
    }
    if (!inferred && nodes.length === 1) inferred = nodes[0];
    if (inferred) inferred.root = true;
  }
  const edges = (raw.relations || []).map((item) => ({
    edgeId: edgeKey(item),
    relationKind: item.relationKind || "relation",
    source: item.source || {},
    target: item.target || {},
    resolved: Boolean(item.resolved),
    evidence: item.evidence || "",
    confidence: item.confidence || (item.resolved ? "high" : "low"),
  }));
  const unresolved = edges.filter((item) => !item.resolved);
  for (const item of raw.unresolvedReferences || []) {
    const normalized = { edgeId: edgeKey(item), relationKind: item.relationKind || "unresolved", source: item.source || {}, target: item.target || {}, resolved: false, evidence: item.evidence || "", confidence: "low" };
    if (!unresolved.some((edge) => edge.edgeId === normalized.edgeId)) unresolved.push(normalized);
  }
  const clientAssets = raw.externalAssetRefs || edges.filter((item) => item.target?.type === "external_img").map((item) => ({ imgPath: item.target.pvfPath, sources: [item.source] }));
  const registryEvidence = nodes.filter((item) => item.registryPath && item.id !== null).map((item) => ({ registryPath: item.registryPath, id: item.id, pvfPath: item.pvfPath, exists: item.exists }));
  const roots = nodes.filter((item) => item.root);
  const risks = [];
  if (unresolved.length) risks.push({ level: "high", code: "unresolved-dependency", count: unresolved.length, action: "Read back the source and correct registry before any change-set." });
  if (clientAssets.length) risks.push({ level: "high", code: "client-assets-unverified", count: clientAssets.length, action: "Use a separate authorized read-only ImagePacks2/NPK preview." });
  if ((raw.readErrors || []).length) risks.push({ level: "high", code: "read-error", count: raw.readErrors.length, action: "Planner is incomplete until the read error is resolved." });
  if (roots.length !== 1) risks.push({ level: "medium", code: "root-not-unique", count: roots.length, action: "Use an exact domain-backed ID or PVF path." });
  if (roots.some((item) => item.exists === false)) risks.push({ level: "high", code: "root-path-missing", count: roots.filter((item) => item.exists === false).length, action: "The selected registry row does not resolve to a readable target PVF file." });
  return {
    schemaVersion: "1.0",
    phase: "clean-room-dependency-plan",
    generatedAt: new Date().toISOString(),
    planner: { id: "workbench-unified-dependency-planner", version: "1.2.0", domain, lane, commercialSourceMethodsCopied: false, sourceInstructionsExecuted: false },
    input: { ...request, pvfSha256: sourcePvfSha256 },
    safety: { readOnly: true, sourcePvfModified: false, pvfWritten: false, clientWritten: false, npkWritten: false, generatedApplyPatch: false, outputExternalOnly: true, rawNoSimplifiedReadback: true },
    summary: { rootCount: roots.length, nodeCount: nodes.length, edgeCount: edges.length, unresolvedCount: unresolved.length, clientAssetCandidateCount: clientAssets.length, registryEvidenceCount: registryEvidence.length, readErrorCount: (raw.readErrors || []).length, riskCount: risks.length },
    nodes,
    edges,
    unresolved,
    clientAssetCandidates: clientAssets,
    registryEvidence,
    equipmentPartSetBlocks: raw.equipmentPartSetBlocks || [],
    attackPayloads: raw.attackPayloads || [],
    risks,
    agentHandoff: {
      reportJsonIsCompleteDeliverable: true,
      reportJsonIsFinalRuntimeEvidence: false,
      additionalSummaryFileRequired: false,
      outputDirectoryProbeRequired: false,
      useReturnedReportPathDirectly: true,
      prohibitedFollowUp: [
        "Test-Path",
        "Get-Item",
        "Set-Content",
        "Out-File",
        "write another Markdown or JSON summary",
      ],
      nextReadOnlySteps: [
        "query the returned reportPath with workbench.bat knowledge-query planner",
        "resolve a numeric root through its domain registry",
        "read back the root and one direct dependency with workbench.bat pvf-read read-batch",
      ],
    },
    controlledWriteHandoff: { allowedDirectly: false, requiredLane: "workbench.bat pvf-change", requirements: ["target PVF raw text", "nearest-neighbor shape", "matching unblocked dry-run manifest", "approval code", "explicit output", "backup", "readback", "manifest"] },
    underlyingSummary: raw.summary || {},
    underlyingWarnings: raw.warnings || [],
    readErrors: raw.readErrors || [],
  };
}

async function runPlan(request, outRoot, force, reuseRaw = false) {
  validateRequest(request);
  const runDir = assertExternalOutput(workbenchRoot, path.join(outRoot, safeId(request.id || `${request.domain}-${request.idValue ?? request.path ?? request.query}`)));
  const rawPath = path.join(runDir, "RAW-PLANNER-ARTIFACT.json");
  const rawMdPath = path.join(runDir, "RAW-PLANNER-ARTIFACT.zh-CN.md");
  const rawMetaPath = path.join(runDir, "RAW-PLANNER-META.json");
  const reportPath = path.join(runDir, "DEPENDENCY-PLAN.json");
  if (fs.existsSync(reportPath) && !force) throw new Error(`Dependency plan already exists: ${reportPath}`);
  const beforeSha256 = sha256File(request.pvf);
  const lane = rawPlannerArgs(request, rawPath, rawMdPath);
  const expectedRawMeta = {
    schemaVersion: "1.0",
    phase: "dependency-planner-raw-cache-binding",
    requestFingerprint: requestFingerprint(request, beforeSha256),
    request: canonicalRequest(request, beforeSha256),
    lane: { id: lane.lane, script: lane.script },
  };
  let invocation;
  let reusedRaw = false;
  if (reuseRaw) {
    if (!fs.existsSync(rawPath) || !fs.existsSync(rawMetaPath)) throw new Error(`Cannot reuse raw planner output without both artifact and binding metadata: ${runDir}`);
    const existingMeta = readJson(rawMetaPath);
    if (existingMeta.requestFingerprint !== expectedRawMeta.requestFingerprint || existingMeta.lane?.script !== lane.script) {
      throw new Error(`Raw planner cache does not match the current PVF SHA/request: ${runDir}`);
    }
    invocation = { stdout: JSON.stringify({ ok: true, reusedRaw: true }), stderr: "" };
    reusedRaw = true;
  } else {
    invocation = invoke(lane.script, lane.args);
    writeJsonAtomic(rawMetaPath, expectedRawMeta);
  }
  const afterSha256 = sha256File(request.pvf);
  if (beforeSha256 !== afterSha256) throw new Error("PVF changed during read-only dependency planning.");
  const raw = readJson(rawPath);
  const report = normalizeArtifact(request.domain, request, raw, beforeSha256, lane.lane);
  report.underlying = { script: lane.script, rawArtifactPath: rawPath, rawArtifactSha256: sha256File(rawPath), rawBindingPath: rawMetaPath, rawBindingSha256: sha256File(rawMetaPath), reusedRaw, markdownPath: rawMdPath, stdout: invocation.stdout.trim(), stderr: invocation.stderr.trim() };
  writeJsonAtomic(reportPath, report);
  return { id: request.id, domain: request.domain, reportPath, reportSha256: sha256File(reportPath), summary: report.summary, agentHandoff: report.agentHandoff };
}

async function plan() {
  const request = planRequestFromArgs();
  const outRoot = assertExternalOutput(workbenchRoot, option("--out", runtimePath(workbenchRoot, "dependency-plans", timestamp())));
  const result = await runPlan(request, outRoot, flag("--force"));
  process.stdout.write(`${JSON.stringify({ ok: true, command: "plan", ...result }, null, 2)}\n`);
}

async function batch() {
  const profilePath = path.resolve(required("--profile"));
  const profile = readJson(profilePath);
  if (!profile || !Array.isArray(profile.plans) || profile.plans.length === 0) throw new Error("Batch profile must contain a non-empty plans array.");
  if (!/^[a-f0-9]{64}$/i.test(String(profile.pvfSha256 || ""))) throw new Error("Batch profile must lock the source with a full pvfSha256.");
  const pvf = path.resolve(profile.pvf);
  if (!fs.existsSync(pvf) || !fs.statSync(pvf).isFile()) throw new Error(`Profile PVF does not exist: ${pvf}`);
  const profilePvfSha256 = sha256File(pvf);
  if (profile.pvfSha256.toLowerCase() !== profilePvfSha256.toLowerCase()) throw new Error(`Profile PVF SHA mismatch: expected ${profile.pvfSha256}, actual ${profilePvfSha256}`);
  const outRoot = assertExternalOutput(workbenchRoot, option("--out", runtimePath(workbenchRoot, "dependency-plan-batches", safeId(profile.profileId || "batch"), timestamp())));
  const results = [];
  for (const [index, item] of (profile.plans || []).entries()) {
    process.stderr.write(`dependency plan ${index + 1}/${profile.plans.length}: ${item.id}\n`);
    if (Object.prototype.hasOwnProperty.call(item, "pvf")) throw new Error(`Plan ${item.id || index + 1} must not override the profile PVF.`);
    results.push(await runPlan({ encoding: profile.encoding || "Cn", depth: item.depth || 2, limit: item.limit || 40, maxNodes: item.maxNodes || 800, idValue: item.idValue ?? null, path: item.path || "", query: item.query || "", sampleKind: item.sampleKind || "", sampleKeyword: item.sampleKeyword || "", ...item, pvf }, outRoot, flag("--force"), flag("--reuse-raw")));
  }
  const invalidRootCount = results.filter((item) => item.summary.rootCount !== 1).length;
  const readErrorCount = results.reduce((sum, item) => sum + item.summary.readErrorCount, 0);
  const report = {
    schemaVersion: "1.0",
    phase: "clean-room-dependency-plan-batch",
    generatedAt: new Date().toISOString(),
    profile: { path: profilePath, sha256: sha256File(profilePath), profileId: profile.profileId },
    pvf: { path: pvf, sha256: profilePvfSha256 },
    safety: { readOnly: true, pvfWritten: false, clientWritten: false, outputExternalOnly: true },
    summary: { ok: results.length === (profile.plans || []).length && invalidRootCount === 0 && readErrorCount === 0, planCount: results.length, domainCount: new Set(results.map((item) => item.domain)).size, unresolvedPlanCount: results.filter((item) => item.summary.unresolvedCount > 0).length, invalidRootCount, readErrorCount },
    agentHandoff: {
      reportJsonIsCompleteDeliverable: true,
      reportJsonIsFinalRuntimeEvidence: false,
      additionalSummaryFileRequired: false,
      outputDirectoryProbeRequired: false,
      useReturnedReportPathDirectly: true,
      prohibitedFollowUp: ["Test-Path", "Get-Item", "Set-Content", "Out-File", "write another Markdown or JSON summary"],
    },
    results,
  };
  const reportPath = path.join(outRoot, "DEPENDENCY-PLAN-BATCH.json");
  writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ ok: report.summary.ok, command: "batch", reportPath, reportSha256: sha256File(reportPath), summary: report.summary, agentHandoff: report.agentHandoff, results }, null, 2)}\n`);
}

function selfTest() {
  const checks = [];
  for (const domain of DOMAINS) {
    const raw = {
      candidates: [{ type: domain, id: 1, pvfPath: `${domain}/root.fixture`, registryPath: `${domain}/${domain}.lst`, exists: true, root: true }],
      relations: [
        { relationKind: `${domain}.resolved`, source: { pvfPath: `${domain}/root.fixture` }, target: { pvfPath: `${domain}/child.fixture`, id: 2 }, resolved: true },
        { relationKind: `${domain}.missing`, source: { pvfPath: `${domain}/root.fixture` }, target: { pvfPath: `${domain}/missing.fixture`, id: 999 }, resolved: false },
      ],
      unresolvedReferences: [],
      externalAssetRefs: [{ imgPath: `Asset/${domain}.img`, sources: [] }],
      readErrors: [],
      summary: {},
    };
    const report = normalizeArtifact(domain, { pvf: "fixture.pvf", domain }, raw, "a".repeat(64), "fixture");
    checks.push({ id: `${domain}-contract`, ok: report.safety.readOnly && !report.safety.pvfWritten && report.summary.unresolvedCount === 1 && report.summary.clientAssetCandidateCount === 1 && report.controlledWriteHandoff.allowedDirectly === false });
    checks.push({
      id: `${domain}-agent-handoff-stops-extra-probes`,
      ok:
        report.agentHandoff.reportJsonIsCompleteDeliverable === true &&
        report.agentHandoff.reportJsonIsFinalRuntimeEvidence === false &&
        report.agentHandoff.additionalSummaryFileRequired === false &&
        report.agentHandoff.outputDirectoryProbeRequired === false &&
        ["Test-Path", "Get-Item", "Set-Content"].every((name) => report.agentHandoff.prohibitedFollowUp.includes(name)),
    });
  }
  const numericRoot = normalizeArtifact("dungeon", { pvf: "fixture.pvf", domain: "dungeon", idValue: 1, path: "", query: "" }, {
    candidates: [
      { type: "equipment", id: 1, pvfPath: "equipment/wrong.equ" },
      { type: "dungeon", id: 1, pvfPath: "dungeon/right.dgn", registryPath: "dungeon/dungeon.lst" },
    ],
    relations: [], unresolvedReferences: [], externalAssetRefs: [], readErrors: [], summary: {},
  }, "a".repeat(64), "fixture");
  checks.push({ id: "registry-aware-numeric-root", ok: numericRoot.nodes.find((item) => item.root)?.pvfPath === "dungeon/right.dgn" });
  const numericLane = rawPlannerArgs({ domain: "monster", idValue: 1, path: "", query: "", depth: 2, limit: 40, encoding: "Cn" }, "raw.json", "raw.md");
  checks.push({ id: "registry-id-selector-is-exact", ok: numericLane.args.includes("--selector-mode=registry-id") && numericLane.args.includes("--selector-registry=monster") });
  const apcLane = rawPlannerArgs({ domain: "apc", idValue: 1, path: "", query: "", depth: 2, limit: 40, encoding: "Cn" }, "raw.json", "raw.md");
  checks.push({ id: "apc-id-uses-aicharacter-registry", ok: apcLane.args.includes("--selector-registry=aicharacter") });
  const pathLane = rawPlannerArgs({ domain: "monster", idValue: null, path: "monster/goblin/goblin.mob", query: "", depth: 2, limit: 40, encoding: "Cn" }, "raw.json", "raw.md");
  checks.push({ id: "path-selector-is-exact", ok: pathLane.args.includes("--selector-mode=exact-path") });
  const fingerprintA = requestFingerprint({ domain: "dungeon", idValue: 1, path: "", query: "", sampleKind: "", sampleKeyword: "", depth: 2, limit: 40, maxNodes: 800, encoding: "Cn" }, "a".repeat(64));
  const fingerprintB = requestFingerprint({ domain: "dungeon", idValue: 2, path: "", query: "", sampleKind: "", sampleKeyword: "", depth: 2, limit: 40, maxNodes: 800, encoding: "Cn" }, "a".repeat(64));
  checks.push({ id: "raw-cache-request-binding", ok: fingerprintA !== fingerprintB });
  const report = { schemaVersion: "1.0", phase: "dependency-planner-self-test", summary: { ok: checks.every((item) => item.ok), checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length, domainCount: DOMAINS.length }, checks };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

async function main() {
  if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else if (command === "plan") await plan();
  else if (command === "batch") await batch();
  else if (command === "self-test") selfTest();
  else throw new Error(`Unknown dependency-plan command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`ERROR ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
