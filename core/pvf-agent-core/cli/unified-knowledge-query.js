"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { runtimePath } = require("../lib/runtime-state");
const { assertExternalOutput, readJson, safeId, sha256File, timestamp, writeJsonAtomic } = require("../lib/research-store");

const KINDS = ["source", "claims", "nut", "tag", "bookmark", "lineage", "planner", "client"];
const BUILTIN_NUT = path.join("knowledge-pack", "indexes", "nut-api-facts.compact.json");
const BUILTIN_TAG = path.join("knowledge-pack", "indexes", "pvf-tag-facts.compact.json");
const BUILTIN_BOOKMARKS = path.join("knowledge-pack", "indexes", "pvf-task-bookmarks.compact.json");
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
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return value;
}

function usage() {
  return `Usage:
  workbench.bat knowledge-query source --manifest <SOURCE-MANIFEST.json> [--text <text>] [--topic <topic>] [--extension <.ext>] [--limit 50]
  workbench.bat knowledge-query claims --store <CLAIM-STORE.json> [--text <text>] [--domain <domain>] [--status <status>] [--limit 50]
  workbench.bat knowledge-query nut --name <name> [--kind function|constant|class|method] [--group <group>] [--exact]
  workbench.bat knowledge-query tag --tag <tag> [--layer <layer>] [--exact]
  workbench.bat knowledge-query bookmark (--text <text> | --path <pvf-path>) [--limit 50]
  workbench.bat knowledge-query lineage --catalog <PVF-LINEAGE-CATALOG.json> (--path <path> | --symbol <name> | --golden <id>) [--limit 50]
  workbench.bat knowledge-query planner --report <DEPENDENCY-PLAN.json|DEPENDENCY-PLAN-BATCH.json> [--text <text>] [--domain <domain>] [--unresolved-only] [--limit 20]
  workbench.bat knowledge-query client --matrix <CLIENT-COMPATIBILITY-MATRIX.json> [--id <id>] [--status <status>] [--target <target>] [--limit 50]
  workbench.bat knowledge-query profile-check --profile <PRIVATE-UNIFIED-QUERY-REGRESSION.json> [--out <external-dir>]
  workbench.bat knowledge-query self-test

NUT, tag, and bookmark queries use bundled facts by default. Maintenance-only --catalog overrides remain available. Every result uses one read-only envelope with artifact SHA, query, results, and evidence/write boundaries. Zero matches never prove runtime or PVF absence.
`;
}

function bool(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function queryFromArgs(kind) {
  const common = { text: option("--text", ""), limit: numberOption("--limit", kind === "planner" ? 20 : 50) };
  if (kind === "source") return { ...common, file: path.resolve(required("--manifest")), topic: option("--topic", ""), extension: option("--extension", ""), fileKind: option("--file-kind", "") };
  if (kind === "claims") return { ...common, file: path.resolve(required("--store")), domain: option("--domain", ""), status: option("--status", ""), distributionStatus: option("--distribution-status", "") };
  if (kind === "nut") return { ...common, file: path.resolve(option("--catalog", path.join(workbenchRoot, BUILTIN_NUT))), name: required("--name"), declarationKind: option("--kind", ""), group: option("--group", ""), exact: flag("--exact") };
  if (kind === "tag") return { ...common, file: path.resolve(option("--catalog", path.join(workbenchRoot, BUILTIN_TAG))), tag: required("--tag"), layer: option("--layer", ""), exact: flag("--exact") };
  if (kind === "bookmark") {
    const pvfPath = option("--path", "");
    if (!common.text && !pvfPath) throw new Error("Bookmark query requires --text or --path.");
    return { ...common, file: path.resolve(option("--catalog", path.join(workbenchRoot, BUILTIN_BOOKMARKS))), path: pvfPath };
  }
  if (kind === "lineage") return { ...common, file: path.resolve(required("--catalog")), path: option("--path", ""), symbol: option("--symbol", ""), golden: option("--golden", "") };
  if (kind === "planner") return { ...common, file: path.resolve(required("--report")), domain: option("--domain", ""), unresolvedOnly: flag("--unresolved-only") };
  if (kind === "client") return { ...common, file: path.resolve(required("--matrix")), id: option("--id", ""), status: option("--status", ""), target: option("--target", "") };
  throw new Error(`Unsupported unified query kind: ${kind}`);
}

function assertArtifact(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Query artifact does not exist: ${file}`);
}

function invokeJson(script, scriptArgs) {
  const file = path.join(workbenchRoot, script);
  const result = childProcess.spawnSync(process.execPath, [file, "--root", workbenchRoot, ...scriptArgs], { cwd: workbenchRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.status}): ${result.stderr || result.stdout}`);
  return { value: JSON.parse(result.stdout), stderr: result.stderr.trim() };
}

function contains(value, needle) {
  return !needle || JSON.stringify(value).toLowerCase().includes(String(needle).toLowerCase());
}

function publicArtifact(file) {
  const relative = path.relative(workbenchRoot, file);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return { path: `builtin:${relative.replace(/\\/g, "/")}`, scope: "portable-workbench" };
  }
  return { path: file, scope: "task-supplied-external" };
}

function envelope(kind, query, results, delegated = null) {
  const artifactSha256 = sha256File(query.file);
  const limit = Number(query.limit || 50);
  const sliced = results.slice(0, limit);
  const publicQuery = { ...query };
  delete publicQuery.file;
  return {
    schemaVersion: "1.0",
    phase: "unified-workbench-query",
    generatedAt: new Date().toISOString(),
    kind,
    artifact: { ...publicArtifact(query.file), sha256: artifactSha256 },
    query: publicQuery,
    summary: { matchCount: results.length, returnedCount: sliced.length, truncated: results.length > sliced.length },
    results: sliced,
    boundaries: {
      readOnly: true,
      generatedArtifactIsFinalEvidence: false,
      targetPvfReadbackRequiredForPvfConclusion: true,
      zeroMatchesProveAbsence: false,
      directWriteAllowed: false,
      clientWriteAllowed: false,
      requiredPvfWriteLane: "workbench.bat pvf-change",
      outputArtifactsAndMachinePathsExternalOnly: true,
    },
    delegated,
  };
}

function querySource(query) {
  assertArtifact(query.file);
  const manifest = readJson(query.file);
  let results = manifest.files || [];
  if (query.text) results = results.filter((item) => contains([item.relativePath, item.topic, item.kind, item.extension], query.text));
  if (query.topic) results = results.filter((item) => String(item.topic || "").toLowerCase() === query.topic.toLowerCase());
  if (query.extension) results = results.filter((item) => String(item.extension || "").toLowerCase() === query.extension.toLowerCase());
  if (query.fileKind) results = results.filter((item) => String(item.kind || "").toLowerCase() === query.fileKind.toLowerCase());
  return envelope("source", query, results);
}

function queryClaims(query) {
  assertArtifact(query.file);
  const store = readJson(query.file);
  let results = store.claims || [];
  if (query.text) results = results.filter((item) => contains([item.claimId, item.domain, item.subjectType, item.subject, item.statement], query.text));
  if (query.domain) results = results.filter((item) => String(item.domain || "").toLowerCase() === query.domain.toLowerCase());
  if (query.distributionStatus) results = results.filter((item) => String(item.distributionStatus || "").toLowerCase() === query.distributionStatus.toLowerCase());
  return envelope("claims", query, results);
}

function queryNut(query) {
  assertArtifact(query.file);
  const forwarded = ["query", "--catalog", query.file, "--name", query.name];
  if (query.declarationKind) forwarded.push("--kind", query.declarationKind);
  if (query.group) forwarded.push("--group", query.group);
  if (query.exact) forwarded.push("--exact");
  const delegated = invokeJson("core/pvf-agent-core/cli/nut-api.js", forwarded);
  const result = envelope("nut", query, delegated.value.matches || [], { command: "nut-api query", declaredRuntimeVersion: delegated.value.declaredRuntimeVersion, targetRuntimeVerified: delegated.value.targetRuntimeVerified, notFoundProvesUnavailable: delegated.value.notFoundProvesUnavailable, stderr: delegated.stderr });
  result.agentHandoff = {
    exactDeclarationQueryComplete: Boolean(query.exact),
    nextTargetStep: `workbench.bat pvf-read search-script --pvf <target Script.pvf> --keyword ${query.name}`,
    additionalCatalogQueryRequired: false,
    helpProbeRequired: false,
    prohibitedFollowUp: ["Test-Path", "Get-Item", "help probe", "guess another API name"],
  };
  return result;
}

function queryTag(query) {
  assertArtifact(query.file);
  const forwarded = ["query", "--catalog", query.file, "--tag", query.tag];
  if (query.layer) forwarded.push("--layer", query.layer);
  if (query.exact) forwarded.push("--exact");
  const delegated = invokeJson("core/pvf-agent-core/cli/tag-knowledge.js", forwarded);
  const results = [];
  for (const [layer, entries] of Object.entries(delegated.value.result || {})) for (const value of entries || []) results.push({ layer, value });
  for (const value of delegated.value.observationMatches || []) results.push({ layer: "target-pvf-observation", value });
  return envelope("tag", query, results, { command: "tag-knowledge query", translationStatus: delegated.value.translationStatus, generatedIndexIsFinalEvidence: delegated.value.generatedIndexIsFinalEvidence, notFoundProvesTagUnavailable: delegated.value.notFoundProvesTagUnavailable, stderr: delegated.stderr });
}

function queryBookmark(query) {
  assertArtifact(query.file);
  const catalog = readJson(query.file);
  if (catalog.phase !== "builtin-pvf-task-bookmarks" || !Array.isArray(catalog.bookmarks)) throw new Error(`Not a bundled bookmark catalog: ${query.file}`);
  let results = catalog.bookmarks;
  if (query.path) {
    const needle = String(query.path).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    results = results.filter((item) => String(item.path || "").toLowerCase() === needle);
  }
  if (query.text) results = results.filter((item) => contains([item.path, item.labels, item.groups], query.text));
  if (query.status) results = results.filter((item) => String(item.status || "").toLowerCase() === query.status.toLowerCase());
  const result = envelope("bookmark", query, results, {
    command: "bundled bookmark query",
    navigationCandidatesOnly: true,
    targetPvfExistenceCheckRequired: true,
    targetPvfReadbackRequiredForMeaning: true,
  });
  result.boundaries.bookmarkPathProvesTargetExistence = false;
  return result;
}

function queryLineage(query) {
  assertArtifact(query.file);
  const selectorCount = [query.path, query.symbol, query.golden].filter(Boolean).length;
  if (selectorCount !== 1) throw new Error("Lineage unified query requires exactly one path, symbol, or golden selector.");
  const forwarded = ["query", "--catalog", query.file, "--limit", String(query.limit || 50)];
  if (query.path) forwarded.push("--path", query.path);
  if (query.symbol) forwarded.push("--symbol", query.symbol);
  if (query.golden) forwarded.push("--golden", query.golden);
  const delegated = invokeJson("core/pvf-agent-core/cli/pvf-lineage.js", forwarded);
  return envelope("lineage", query, delegated.value.result ? [delegated.value.result] : [], { command: "pvf-lineage query", generatedIndexesAreFinalEvidence: delegated.value.generatedIndexesAreFinalEvidence, stderr: delegated.stderr });
}

function queryPlanner(query) {
  assertArtifact(query.file);
  const report = readJson(query.file);
  let results;
  if (report.phase === "clean-room-dependency-plan-batch") {
    results = (report.results || []).map((item) => ({ type: "plan", ...item }));
  } else if (report.phase === "clean-room-dependency-plan") {
    if (query.unresolvedOnly) results = (report.unresolved || []).map((item) => ({ type: "unresolved", ...item }));
    else results = [
      ...(report.nodes || []).map((item) => ({ type: "node", ...item })),
      ...(report.edges || []).filter((item) => item.resolved !== false).map((item) => ({ type: "edge", ...item })),
      ...(report.unresolved || []).map((item) => ({ type: "unresolved", ...item })),
      ...(report.clientAssetCandidates || []).map((item) => ({ type: "client-asset-candidate", ...item })),
      ...(report.risks || []).map((item) => ({ type: "risk", ...item })),
    ];
  } else throw new Error(`Unsupported dependency planner report phase: ${report.phase}`);
  if (query.domain) results = results.filter((item) => String(item.domain || report.planner?.domain || "").toLowerCase() === query.domain.toLowerCase());
  if (query.text) results = results.filter((item) => contains(item, query.text));
  const result = envelope("planner", query, results, {
    command: "direct dependency report query",
    reportPhase: report.phase,
    reportSummary: report.summary || null,
    reportSafety: report.safety || null,
    selector: report.input ? { domain: report.input.domain, idValue: report.input.idValue, path: report.input.path, query: report.input.query } : null,
    roots: report.phase === "clean-room-dependency-plan" ? (report.nodes || []).filter((item) => item.root).slice(0, 5) : [],
    agentHandoff: report.agentHandoff || null,
    controlledWriteHandoff: report.controlledWriteHandoff || null,
  });
  result.boundaries.plannerOutputIsImportPlan = false;
  result.boundaries.unresolvedMayBeSilentlyIgnored = false;
  result.boundaries.plannerReportJsonIsCompleteDeliverable = report.agentHandoff?.reportJsonIsCompleteDeliverable === true;
  result.boundaries.plannerReportIsFinalRuntimeEvidence = false;
  result.boundaries.additionalSummaryFileRequired = false;
  result.boundaries.outputDirectoryProbeRequired = false;
  result.agentHandoff = report.agentHandoff || {
    reportJsonIsCompleteDeliverable: true,
    reportJsonIsFinalRuntimeEvidence: false,
    additionalSummaryFileRequired: false,
    outputDirectoryProbeRequired: false,
    useReturnedReportPathDirectly: true,
    prohibitedFollowUp: ["Test-Path", "Get-Item", "Set-Content", "Out-File", "write another Markdown or JSON summary"],
  };
  return result;
}

function queryClient(query) {
  assertArtifact(query.file);
  const forwarded = ["query", "--matrix", query.file, "--limit", String(query.limit || 50)];
  if (query.id) forwarded.push("--id", query.id);
  if (query.status) forwarded.push("--status", query.status);
  if (query.target) forwarded.push("--target", query.target);
  const delegated = invokeJson("core/pvf-agent-core/cli/client-compat-matrix.js", forwarded);
  const result = envelope("client", query, delegated.value.rows || [], { command: "client-matrix query", customOnlyMeansOfficial: delegated.value.customOnlyMeansOfficial, generatedMatrixIsFinalRuntimeEvidence: delegated.value.generatedMatrixIsFinalRuntimeEvidence, stderr: delegated.stderr });
  result.boundaries.customOnlyMeansOfficial = false;
  result.boundaries.clientAssetPresenceIsRuntimeProof = false;
  return result;
}

function execute(kind, query) {
  if (kind === "source") return querySource(query);
  if (kind === "claims") return queryClaims(query);
  if (kind === "nut") return queryNut(query);
  if (kind === "tag") return queryTag(query);
  if (kind === "bookmark") return queryBookmark(query);
  if (kind === "lineage") return queryLineage(query);
  if (kind === "planner") return queryPlanner(query);
  if (kind === "client") return queryClient(query);
  throw new Error(`Unsupported unified query kind: ${kind}`);
}

function profileQuery(check) {
  const query = { ...(check.query || {}), file: path.resolve(check.artifact), limit: Number(check.query?.limit || 50) };
  for (const key of ["exact", "unresolvedOnly"]) if (query[key] !== undefined) query[key] = bool(query[key]);
  return query;
}

function profileCheck() {
  const profilePath = path.resolve(required("--profile"));
  const profile = readJson(profilePath);
  if (profile.phase !== "private-unified-query-regression" || !Array.isArray(profile.checks) || profile.checks.length === 0) throw new Error("Invalid private unified query regression profile.");
  const outRoot = assertExternalOutput(workbenchRoot, option("--out", runtimePath(workbenchRoot, "unified-query-regression", safeId(profile.profileId || "profile"), timestamp())));
  const checks = [];
  for (const check of profile.checks) {
    const result = execute(check.kind, profileQuery(check));
    const text = JSON.stringify(result.results);
    const expect = check.expect || {};
    const failures = [];
    if (expect.minMatches !== undefined && result.summary.matchCount < expect.minMatches) failures.push(`matchCount < ${expect.minMatches}`);
    if (expect.maxMatches !== undefined && result.summary.matchCount > expect.maxMatches) failures.push(`matchCount > ${expect.maxMatches}`);
    for (const value of expect.resultTextIncludes || []) if (!text.includes(value)) failures.push(`missing result text: ${value}`);
    for (const value of expect.resultTextExcludes || []) if (text.includes(value)) failures.push(`forbidden result text: ${value}`);
    if (result.boundaries.readOnly !== true || result.boundaries.directWriteAllowed !== false || result.boundaries.zeroMatchesProveAbsence !== false) failures.push("unified safety boundary mismatch");
    checks.push({ id: check.id, kind: check.kind, ok: failures.length === 0, failures, artifactSha256: result.artifact.sha256, summary: result.summary });
  }
  const report = { schemaVersion: "1.0", phase: "private-unified-query-regression-report", generatedAt: new Date().toISOString(), profile: { path: profilePath, sha256: sha256File(profilePath), profileId: profile.profileId }, summary: { ok: checks.every((item) => item.ok), checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length, kindCount: new Set(checks.map((item) => item.kind)).size }, checks, safety: { readOnly: true, sourceArtifactsModified: false, clientWritten: false, outputExternalOnly: true } };
  const reportPath = path.join(outRoot, "UNIFIED-QUERY-REGRESSION-REPORT.json");
  writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ ok: report.summary.ok, command: "profile-check", reportPath, reportSha256: sha256File(reportPath), summary: report.summary, checks }, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

function selfTest() {
  const checks = [];
  const fixtureQuery = { file: __filename, limit: 10 };
  for (const kind of KINDS) {
    const result = envelope(kind, fixtureQuery, [{ id: kind }]);
    checks.push({ id: `${kind}-envelope`, ok: result.kind === kind && result.summary.matchCount === 1 && result.boundaries.readOnly && !result.boundaries.directWriteAllowed && !result.boundaries.zeroMatchesProveAbsence });
  }
  const empty = envelope("source", fixtureQuery, []);
  checks.push({ id: "zero-is-not-absence-proof", ok: empty.summary.matchCount === 0 && empty.boundaries.zeroMatchesProveAbsence === false });
  const builtinNut = queryNut({ file: path.join(workbenchRoot, BUILTIN_NUT), name: "sq_GetSkillLevel", declarationKind: "function", group: "dnf", exact: true, text: "", limit: 10 });
  checks.push({ id: "builtin-nut-default", ok: builtinNut.summary.matchCount > 0 && builtinNut.artifact.scope === "portable-workbench" });
  checks.push({
    id: "builtin-nut-two-command-handoff",
    ok:
      builtinNut.agentHandoff.exactDeclarationQueryComplete === true &&
      builtinNut.agentHandoff.nextTargetStep.includes("pvf-read search-script") &&
      builtinNut.agentHandoff.additionalCatalogQueryRequired === false &&
      builtinNut.agentHandoff.helpProbeRequired === false,
  });
  const builtinTag = queryTag({ file: path.join(workbenchRoot, BUILTIN_TAG), tag: "duration", layer: "", exact: true, text: "", limit: 10 });
  checks.push({ id: "builtin-tag-default", ok: builtinTag.summary.matchCount > 0 && builtinTag.artifact.scope === "portable-workbench" });
  const builtinBookmark = queryBookmark({ file: path.join(workbenchRoot, BUILTIN_BOOKMARKS), text: "商城", path: "", status: "", limit: 10 });
  checks.push({ id: "builtin-bookmark-default", ok: builtinBookmark.summary.matchCount > 0 && builtinBookmark.results.some((item) => item.path === "etc/newcashshop.etc") });
  const plannerFixturePath = path.join(runtimePath(workbenchRoot, "unified-query-self-test"), "DEPENDENCY-PLAN.json");
  fs.mkdirSync(path.dirname(plannerFixturePath), { recursive: true });
  writeJsonAtomic(plannerFixturePath, {
    schemaVersion: "1.0",
    phase: "clean-room-dependency-plan",
    planner: { domain: "dungeon" },
    input: { domain: "dungeon", idValue: 1, path: "", query: "" },
    safety: { readOnly: true },
    summary: { rootCount: 1, readErrorCount: 0 },
    nodes: [{ root: true, pvfPath: "dungeon/fixture.dgn" }],
    edges: [],
    unresolved: [],
    clientAssetCandidates: [],
    risks: [],
    agentHandoff: {
      reportJsonIsCompleteDeliverable: true,
      reportJsonIsFinalRuntimeEvidence: false,
      additionalSummaryFileRequired: false,
      outputDirectoryProbeRequired: false,
      useReturnedReportPathDirectly: true,
      prohibitedFollowUp: ["Test-Path", "Get-Item", "Set-Content", "Out-File", "write another Markdown or JSON summary"],
    },
    controlledWriteHandoff: { allowedDirectly: false },
  });
  const planner = queryPlanner({ file: plannerFixturePath, text: "", domain: "", unresolvedOnly: false, limit: 20 });
  checks.push({
    id: "planner-handoff-stops-extra-probes",
    ok:
      planner.boundaries.plannerReportJsonIsCompleteDeliverable === true &&
      planner.boundaries.plannerReportIsFinalRuntimeEvidence === false &&
      planner.boundaries.additionalSummaryFileRequired === false &&
      planner.boundaries.outputDirectoryProbeRequired === false &&
      ["Test-Path", "Get-Item", "Set-Content"].every((name) => planner.agentHandoff.prohibitedFollowUp.includes(name)),
  });
  const report = { schemaVersion: "1.0", phase: "unified-workbench-query-self-test", summary: { ok: checks.every((item) => item.ok), checkCount: checks.length, failedChecks: checks.filter((item) => !item.ok).length, kindCount: KINDS.length }, checks };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

function main() {
  if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else if (KINDS.includes(command)) process.stdout.write(`${JSON.stringify(execute(command, queryFromArgs(command)), null, 2)}\n`);
  else if (command === "profile-check") profileCheck();
  else if (command === "self-test") selfTest();
  else throw new Error(`Unknown knowledge-query command: ${command}\n\n${usage()}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
