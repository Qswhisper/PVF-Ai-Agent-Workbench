"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { BackendStdioClient, parseBackendTextResult } = require("../lib/backend-stdio-client");
const { loadWorkspaceProfiles, resolveSourcePvf } = require("../lib/workspace-profiles");
const {
  adapterInfo,
  assertReadOnlyAdapter,
  loadAdapterConfig,
  resolveWorkbenchRoot,
  upstreamLaunchOptions,
} = require("../lib/adapter-config");
const {
  automaticChineseNameSearchPlan,
  normalizeEncoding,
} = require("../lib/semantic-read-guard");
const {
  compareChineseEncodingCandidates,
} = require("../../../tools/pvf-bridge/fallback/codec.ts");
const { exportEvidence, verifyEvidence, DEFAULT_MAX_CHARS } = require("../lib/pvf-evidence-export");

const rawArgs = process.argv.slice(2);
const workbenchRoot = resolveWorkbenchRoot(rawArgs, path.resolve(__dirname, "../../.."));
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0];

const DOMAIN_SEARCH_ROUTES = [
  { domain: "quest", searchPath: "n_quest", aliases: ["quest"], registryPath: "n_quest/quest.lst", description: "任务" },
  { domain: "dungeon", searchPath: "dungeon", aliases: [], registryPath: "dungeon/dungeon.lst", description: "副本" },
  { domain: "equipment", searchPath: "equipment", aliases: ["equip"], registryPath: "equipment/equipment.lst", description: "装备" },
  { domain: "stackable", searchPath: "stackable", aliases: ["material", "consumable"], registryPath: "stackable/stackable.lst", description: "消耗品/材料" },
  { domain: "npc", searchPath: "npc", aliases: [], registryPath: "npc/npc.lst", description: "NPC" },
  { domain: "monster", searchPath: "monster", aliases: ["mob"], registryPath: "monster/monster.lst", description: "怪物" },
  { domain: "apc", searchPath: "aicharacter", aliases: ["apc"], registryPath: "aicharacter/aicharacter.lst", description: "APC/人偶" },
  {
    domain: "skill",
    searchPath: "skill",
    aliases: [],
    registryPath: null,
    registryStrategy: "character/character.lst -> skill/skilllist.lst -> profession skill registry",
    description: "技能",
  },
  { domain: "town", searchPath: "town", aliases: [], registryPath: "town/town.lst", description: "城镇" },
  { domain: "worldmap", searchPath: "worldmap", aliases: ["world-map"], registryPath: "worldmap/worldmap.lst", description: "世界地图/副本入口" },
  { domain: "creature", searchPath: "creature", aliases: ["pet-creature"], registryPath: "creature/creature.lst", description: "宠物" },
  { domain: "region", searchPath: "region", aliases: [], registryPath: "region/region.lst", description: "区域" },
  { domain: "map", searchPath: "map", aliases: [], registryPath: "map/map.lst", description: "地图" },
  { domain: "itemshop", searchPath: "itemshop", aliases: ["shop", "npc-shop"], registryPath: "itemshop/itemshop.lst", description: "NPC 商店" },
  { domain: "cashshop", searchPath: "cashshop", aliases: ["cash-shop"], registryPath: "cashshop/cashshop.lst", description: "商城" },
  { domain: "character", searchPath: "character", aliases: ["job"], registryPath: "character/character.lst", description: "角色" },
  { domain: "appendage", searchPath: "appendage", aliases: ["apd"], registryPath: "appendage/appendage.lst", description: "状态/APD" },
  { domain: "passiveobject", searchPath: "passiveobject", aliases: ["passive-object"], registryPath: "passiveobject/passiveobject.lst", description: "被动对象" },
  { domain: "pvp_mission", searchPath: "pvp_mission", aliases: ["pvp-mission"], registryPath: "pvp_mission/mission.lst", description: "PVP 任务" },
  { domain: "independentdrop", searchPath: "etc", aliases: ["independent-drop"], registryPath: "etc/independentdrop.lst", description: "独立掉落" },
  { domain: "aura", searchPath: "aura", aliases: [], registryPath: "aura/aura.lst", description: "光环", secondary: true },
  { domain: "pet", searchPath: "pet", aliases: ["legacy-pet"], registryPath: "pet/pet.lst", description: "旧宠物表", secondary: true },
  { domain: "chatemoticon", searchPath: "chatemoticon", aliases: ["chat-emoticon"], registryPath: "chatemoticon/chatemoticon.lst", description: "表情", secondary: true },
  { domain: "stagemap", searchPath: "stagemap", aliases: ["stage-map"], registryPath: "stagemap/stagemap.lst", description: "阶段图", secondary: true },
];

function usage() {
  return `Usage:
  workbench.bat pvf-read adapter-info
  workbench.bat pvf-read profiles
  workbench.bat pvf-read tools
  workbench.bat pvf-read fingerprint [--profile <name> | --pvf <Script.pvf> [--pvf <another Script.pvf>]]
  workbench.bat pvf-read export-evidence --pvf <Script.pvf> --path <known/path.ext> [--path <...>] --out <new-external-dir> --purpose <boundary-only|rebuild-evidence> [--pvf-encoding Cn|Tw] [--max-chars-per-file 16777216]
  workbench.bat pvf-read verify-evidence --pvf <Script.pvf> --manifest <EVIDENCE.json> --manifest-sha256 <recorded-sha256>
  workbench.bat pvf-read evidence-self-test
  workbench.bat pvf-read scope-audit --pvf <Script.pvf> --path <known/script.stk> --section "[exact section]" --out <external-report.json>
  workbench.bat pvf-read scope-compare --pvf <protected-source.pvf> --candidate-pvf <independent-output.pvf> --path <known/script.stk> --section "[exact section]" --out <external-report.json>
  workbench.bat pvf-read scope-self-test
  workbench.bat pvf-read skill-identity-audit --pvf <Script.pvf> --out <external-graph.json>
  workbench.bat pvf-read skill-identity-check --pvf <Script.pvf> --claims <identity-claims.json> --out <external-report.json>
  workbench.bat pvf-read skill-identity-self-test
  workbench.bat pvf-read skill-learning-audit --pvf <Script.pvf> --out <external-learning-evidence.json>
  workbench.bat pvf-read skill-learning-self-test
  workbench.bat pvf-read equipment-eligibility-audit --pvf <Script.pvf> --out <new-external-directory>
  workbench.bat pvf-read equipment-eligibility-self-test
  workbench.bat pvf-read package-compare --pvf <protected-source.pvf> --candidate-pvf <independent-output.pvf> --path <only-changed-script.stk> --section "[exact section]" --out <external-report.json>
  workbench.bat pvf-read open [--profile <name> | --pvf <Script.pvf>] [--encoding Tw]
  workbench.bat pvf-read list-registries [--profile <name> | --pvf <Script.pvf>] [--include-counts] [--raw]
  workbench.bat pvf-read list-files [--profile <name> | --pvf <Script.pvf>] [--prefix itemshop] [--contains shp] [--limit 20]
  workbench.bat pvf-read list-files-page [--profile <name> | --pvf <Script.pvf>] [--prefix itemshop] [--contains shp] [--offset 0] [--limit 2000]
  workbench.bat pvf-read search [--profile <name> | --pvf <Script.pvf>] --keyword <name> [--search-type SearchName] [--search-path dungeon] [--pvf-encoding Cn] [--limit 20] [--raw]
  workbench.bat pvf-read search-batch [--profile <name> | --pvf <Script.pvf>] --name <name> --search-path <domain> [--name <name> --search-path <domain>] [--pvf-encoding Cn] [--limit 20]
  workbench.bat pvf-read search-script [--profile <name> | --pvf <Script.pvf>] --keyword <symbol> [--search-path script] [--limit 50] [--raw]
  workbench.bat pvf-read read [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> [--pvf-encoding Cn] [--start-char 0] [--max-chars 30000] [--offset 0 --limit 30000] [--raw]
  workbench.bat pvf-read read-batch [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> --path <...> [--pvf-encoding Cn] [--start-char 0] [--max-chars-per-file 30000] [--max-total-chars 300000] [--offset 0 --limit 30000] [--raw]
  workbench.bat pvf-read resolve-lst [--profile <name> | --pvf <Script.pvf>] --lst <registry.lst> --id <number> [--no-summary] [--raw]
  workbench.bat pvf-read resolve-lst-batch [--profile <name> | --pvf <Script.pvf>] --lst <registry.lst> --id <number> --id <number> [--include-summary]
  workbench.bat pvf-read resolve-skill [--profile <name> | --pvf <Script.pvf>] (--job <job-token> | --character-id <number>) --id <skill-id> [--raw]
  workbench.bat pvf-read resolve-path [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext | registry-relative/path.ext> [--registry <registry.lst>]... [--include-secondary] [--include-errors] [--raw]
  workbench.bat pvf-read resolve-path-batch [--profile <name> | --pvf <Script.pvf>] --registry <registry.lst> --path <pvf/path.ext | registry-relative/path.ext> --path <...>

Raw text:
  --raw is the write-preparation display mode. It uses the same independent
  canonical token layout as pvf-change, disables simplified-Chinese conversion
  and StringLink auto-conversion. --no-simplified remains supported.
  --pvf-encoding controls script text decoding. --encoding only controls how
  the PVF container is opened and is not a text-encoding alias.
`;
}

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function flag(name) {
  return args.includes(name);
}

function rawDisplayMode() {
  return flag("--raw");
}

function numberOption(name, fallback) {
  const value = option(name);
  if (value === undefined) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a number.`);
  }
  return number;
}

function argumentSchema({ value = [], flag: flags = [], repeatable = [] } = {}) {
  return {
    valueOptions: new Set([...value, ...repeatable]),
    flagOptions: new Set(flags),
    repeatableOptions: new Set(repeatable),
  };
}

const SESSION_VALUE_OPTIONS = ["--profile", "--pvf", "--encoding"];
const TEXT_VALUE_OPTIONS = ["--pvf-encoding"];
const TEXT_FLAGS = ["--raw", "--no-simplified"];
const READ_FLAGS = [
  ...TEXT_FLAGS,
  "--string-link",
  "--no-decompile-script",
  "--no-decompile-ani",
  "--no-compatible-decompiler",
];

const COMMAND_ARGUMENT_SCHEMAS = new Map([
  ["adapter-info", argumentSchema()],
  ["profiles", argumentSchema()],
  ["tools", argumentSchema()],
  ["fingerprint", argumentSchema({ value: ["--profile"], repeatable: ["--pvf"] })],
  ["export-evidence", argumentSchema({
    value: ["--pvf", "--encoding", "--pvf-encoding", "--out", "--purpose", "--max-chars-per-file"], repeatable: ["--path"],
  })],
  ["verify-evidence", argumentSchema({ value: ["--pvf", "--encoding", "--manifest", "--manifest-sha256"] })],
  ["evidence-self-test", argumentSchema()],
  ["scope-audit", argumentSchema({ value: ["--pvf", "--path", "--section", "--out"] })],
  ["scope-compare", argumentSchema({ value: ["--pvf", "--candidate-pvf", "--path", "--section", "--out"] })],
  ["scope-self-test", argumentSchema()],
  ["skill-identity-audit", argumentSchema({ value: ["--pvf", "--out"] })],
  ["skill-identity-check", argumentSchema({ value: ["--pvf", "--claims", "--out"] })],
  ["skill-identity-self-test", argumentSchema()],
  ["skill-learning-audit", argumentSchema({ value: ["--pvf", "--out"] })],
  ["skill-learning-self-test", argumentSchema()],
  ["equipment-eligibility-audit", argumentSchema({ value: ["--pvf", "--out"] })],
  ["equipment-eligibility-self-test", argumentSchema()],
  ["package-compare", argumentSchema({ value: ["--pvf", "--candidate-pvf", "--path", "--section", "--out"] })],
  ["open", argumentSchema({ value: SESSION_VALUE_OPTIONS })],
  ["list-registries", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS],
    flag: ["--include-counts", "--include-secondary", ...TEXT_FLAGS],
  })],
  ["list-files", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, "--prefix", "--contains", "--limit"],
  })],
  ["list-files-page", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, "--prefix", "--contains", "--offset", "--limit"],
  })],
  ["search", argumentSchema({
    value: [
      ...SESSION_VALUE_OPTIONS,
      ...TEXT_VALUE_OPTIONS,
      "--keyword",
      "--search-type",
      "--search-path",
      "--limit",
      "--match-mode",
    ],
    flag: [...TEXT_FLAGS, "--start-match", "--like-search-path"],
  })],
  ["search-batch", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS, "--limit", "--match-mode"],
    flag: [...TEXT_FLAGS, "--start-match", "--like-search-path"],
    repeatable: ["--name", "--search-path"],
  })],
  ["search-script", argumentSchema({
    value: [
      ...SESSION_VALUE_OPTIONS,
      ...TEXT_VALUE_OPTIONS,
      "--keyword",
      "--search-path",
      "--limit",
      "--match-mode",
    ],
    flag: [...TEXT_FLAGS, "--start-match", "--like-search-path"],
  })],
  ["read", argumentSchema({
    value: [
      ...SESSION_VALUE_OPTIONS,
      ...TEXT_VALUE_OPTIONS,
      "--path",
      "--start-char",
      "--max-chars",
      "--offset",
      "--limit",
      "--start-line",
      "--end-line",
    ],
    flag: READ_FLAGS,
  })],
  ["read-batch", argumentSchema({
    value: [
      ...SESSION_VALUE_OPTIONS,
      ...TEXT_VALUE_OPTIONS,
      "--start-char",
      "--max-chars-per-file",
      "--max-total-chars",
      "--offset",
      "--limit",
      "--start-line",
      "--end-line",
    ],
    flag: READ_FLAGS,
    repeatable: ["--path"],
  })],
  ["resolve-lst", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS, "--lst", "--id"],
    flag: ["--no-summary", ...TEXT_FLAGS],
  })],
  ["resolve-lst-batch", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS, "--lst"],
    flag: ["--include-summary", ...TEXT_FLAGS],
    repeatable: ["--id"],
  })],
  ["resolve-skill", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS, "--job", "--character-id", "--id"],
    flag: TEXT_FLAGS,
  })],
  ["resolve-path", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS, "--path"],
    flag: ["--include-secondary", "--include-errors", ...TEXT_FLAGS],
    repeatable: ["--registry"],
  })],
  ["resolve-path-batch", argumentSchema({
    value: [...SESSION_VALUE_OPTIONS, ...TEXT_VALUE_OPTIONS],
    flag: ["--include-secondary", "--include-errors", ...TEXT_FLAGS],
    repeatable: ["--registry", "--path"],
  })],
]);

function unknownOptionMessage(commandName, token) {
  if (token === "--count" && (commandName === "read" || commandName === "read-batch")) {
    const canonical = commandName === "read" ? "--max-chars" : "--max-chars-per-file";
    return `Unknown option for pvf-read ${commandName}: --count. Use ${canonical}, or compatibility alias --limit, for the character limit.`;
  }
  return `Unknown option for pvf-read ${commandName}: ${token}.`;
}

function validateCommandArguments(commandName) {
  const schema = COMMAND_ARGUMENT_SCHEMAS.get(commandName);
  if (!schema) return;
  const seen = new Map();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!String(token).startsWith("--")) {
      throw new Error(`Unexpected positional argument for pvf-read ${commandName}: ${token}. Use named --option value arguments only.`);
    }
    const isValue = schema.valueOptions.has(token);
    const isFlag = schema.flagOptions.has(token);
    if (!isValue && !isFlag) throw new Error(unknownOptionMessage(commandName, token));
    const count = (seen.get(token) || 0) + 1;
    seen.set(token, count);
    if (count > 1 && !schema.repeatableOptions.has(token)) {
      throw new Error(`Option ${token} may appear only once for pvf-read ${commandName}.`);
    }
    if (isValue) {
      const value = args[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`Option ${token} requires an explicit value for pvf-read ${commandName}.`);
      }
      index += 1;
    }
  }
}

function requireOption(name) {
  const value = option(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fingerprintTargets() {
  const explicitPvfs = options("--pvf");
  const requestedProfile = option("--profile");
  if (explicitPvfs.length && requestedProfile) {
    throw new Error("fingerprint accepts either --profile or one or more --pvf values, not both.");
  }
  if (explicitPvfs.length > 20) {
    throw new Error("fingerprint accepts at most 20 --pvf values per call.");
  }
  const requested = explicitPvfs.length
    ? explicitPvfs.map((value) => path.resolve(String(value)))
    : [resolveSourcePvf(workbenchRoot, requestedProfile, undefined).sourcePvf];
  const seen = new Set();
  for (const candidate of requested) {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) throw new Error(`fingerprint received the same PVF more than once: ${candidate}`);
    seen.add(key);
  }
  return requested;
}

function sha256FileStreaming(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fingerprintPvf(file) {
  const sourcePvf = path.resolve(file);
  if (!fs.existsSync(sourcePvf) || !fs.statSync(sourcePvf).isFile()) {
    throw new Error(`PVF file does not exist: ${sourcePvf}`);
  }
  const before = fs.statSync(sourcePvf);
  const sourcePvfSha256 = sha256FileStreaming(sourcePvf);
  const after = fs.statSync(sourcePvf);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`PVF changed while its SHA256 was being calculated: ${sourcePvf}`);
  }
  return {
    sourcePvf,
    sourcePvfSha256,
    sourceSize: after.size,
    sourceMtimeMs: after.mtimeMs,
    stableDuringFingerprint: true,
  };
}

function sourceIdentityAgentHandoff() {
  return {
    baselineCommandOnly: "workbench.bat pvf-read fingerprint --pvf <same Script.pvf> [--pvf <another Script.pvf>]",
    finalUnchangedClaimIsBeforeAfterProof: true,
    baselineMustBeNextWorkbenchCommandAfterRequiredFirstCommand: true,
    baselineMustRunBeforeFirstPvfChange: true,
    baselineIsInvalidIfFirstRunAfterAnyPvfChange: true,
    runBaselineNowBeforeAnyDryRun: true,
    doNotDeferBaselineUntilValidateDryRunOrApply: true,
    runBaselineOnceThenRepeatOnlyAfterFinalReadback: true,
    repeatExactCommandAfterFinalReadback: true,
    compareSourcePvfSha256Exactly: true,
    finalOnlyFingerprintProvesUnchanged: false,
    fullFileSha256: true,
    instruction: "If the user asked for full source SHA256, required the source PVFs to stay unchanged, or asked for final confirmation that they did not change, run one fingerprint covering every supplied PVF as the next Workbench command after the required first command. It must precede every pvf-change command; do not defer it until validate, dry-run, or apply. Repeat it only after final output readback.",
  };
}

function sourceIdentityPriorityNextAction(nextAction) {
  return `If the user asked for full source SHA256, required the source PVFs to stay unchanged, or asked for final confirmation that they did not change, and the baseline is not already established, the next Workbench command now must be one pvf-read fingerprint covering every supplied PVF. Run it before any pvf-change command; do not defer it until validate, dry-run, or apply, and do not repeat it again until after final output readback. Otherwise, ${nextAction}`;
}

function writeCapabilityAgentHandoff() {
  return {
    routineEnvironmentCheckRequired: false,
    checkBeforeRawReadRequired: false,
    checkBeforeValidateRequired: false,
    checkBeforeDryRunRequired: false,
    proceedDirectlyToRawReadThenValidateAndDryRun: true,
    controlledDryRunDiagnosesWriteCapability: true,
    runCheckOnlyAfterExplicitReadOnlyFallbackOrUnavailableCommand: true,
    blockingCodeWhenNativeWriteIsUnavailable: "READ_ONLY_FALLBACK",
  };
}

function rawReadAgentHandoff(result) {
  const bindings = rawTextBindings(result);
  const allComplete = bindings.length > 0 && bindings.every((binding) => binding.complete === true);
  return {
    canonicalChangeSourceReady: allComplete,
    partialCanonicalSegmentsAvailable: bindings.some((binding) => binding.segmentTextSha256),
    fullSourceBindingRequiredBeforeChangeSet: !allComplete,
    readContinuation: readContinuationHandoff(result),
    changeSetFormatExamples: {
      linkedVerifiedTextAndParameters: "workspaces/examples/change-set.verified-cn-text.example.json",
      exactHomomorphicBlockScope: "workspaces/examples/change-set.exact-scope.example.json",
      cumulativeSecondRound: "workspaces/examples/change-set.cumulative-second-round.example.json",
      existingNutControlledEdit: "workspaces/examples/change-set.existing-nut-controlled.example.json",
    },
    completeRawTextSha256AvailableIn: "textUsage.rawTextBindings",
    sourceIdentityWhenExplicitlyRequired: sourceIdentityAgentHandoff(),
    writeCapabilityPreflight: writeCapabilityAgentHandoff(),
    schemaLookupRequired: false,
    examplesDirectoryScanRequired: false,
    helpProbeRequired: false,
    adapterInfoProbeRequired: false,
    externalHashCommandRequired: false,
  };
}

function selectedReadEncodings(result, requestedEncoding) {
  const values = [];
  const add = (value) => {
    const normalized = String(value || "").trim();
    if (normalized && !values.includes(normalized)) values.push(normalized);
  };
  if (command === "read") {
    add(result?.semanticReadGuard?.selectedEncoding);
  } else if (command === "read-batch") {
    for (const item of result?.items || []) add(item?.semanticReadGuard?.selectedEncoding);
  }
  if (values.length === 0) add(requestedEncoding);
  return values;
}

function rawTextBindings(result) {
  const hash = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
  const lineSliceRequested = option("--start-line") !== undefined || option("--end-line") !== undefined;
  const requestedStartChar = Number(option("--start-char", option("--offset", 0)) || 0);
  const bindingFor = (item, fallbackPath) => {
    const textAvailable = typeof item?.textContent === "string";
    const complete =
      !lineSliceRequested &&
      requestedStartChar === 0 &&
      item?.truncated !== true &&
      textAvailable;
    return {
      pvfPath: normalizePvfPath(item?.fileName || item?.pvfPath || fallbackPath || ""),
      complete,
      sourceTextSha256: complete ? hash(item.textContent) : null,
      segmentTextSha256: textAvailable ? hash(item.textContent) : null,
      returnedRange: item?.returnedRange || null,
      sourceCharCount: Number.isSafeInteger(item?.sourceCharCount) ? item.sourceCharCount : null,
      remainingCharCount: Number.isSafeInteger(item?.remainingCharCount) ? item.remainingCharCount : null,
      hasMore: item?.hasMore === true,
      nextStartChar: Number.isSafeInteger(item?.nextStartChar) ? item.nextStartChar : null,
    };
  };
  if (command === "read") {
    return [bindingFor(result, option("--path", ""))];
  }
  if (command === "read-batch") {
    return (result?.items || []).map((item, index) => bindingFor(item, options("--path")[index] || ""));
  }
  return [];
}

function continuationCommandForPage(item, fallbackPath, maxChars) {
  if (item?.hasMore !== true || !Number.isSafeInteger(item?.nextStartChar)) return null;
  const sourceParts = currentSourceCommandParts();
  const pvfPath = quotedCommandArgument(item?.pvfPath || item?.metadata?.fileName || fallbackPath);
  if (!sourceParts || !pvfPath) return null;
  const parts = [
    "workbench.bat", "pvf-read", "read", ...sourceParts,
    "--path", pvfPath,
    "--start-char", String(item.nextStartChar),
    "--max-chars", String(maxChars),
  ];
  const selectedEncoding = option("--pvf-encoding") || item?.semanticReadGuard?.selectedEncoding;
  if (selectedEncoding) parts.push("--pvf-encoding", String(selectedEncoding));
  if (rawDisplayMode()) parts.push("--raw");
  else if (flag("--no-simplified")) parts.push("--no-simplified");
  if (flag("--string-link") && !rawDisplayMode()) parts.push("--string-link");
  if (flag("--no-decompile-script")) parts.push("--no-decompile-script");
  if (flag("--no-decompile-ani")) parts.push("--no-decompile-ani");
  if (flag("--no-compatible-decompiler")) parts.push("--no-compatible-decompiler");
  return parts.join(" ");
}

function readContinuationHandoff(result) {
  const maxChars = command === "read-batch"
    ? readCharacterWindow("--max-chars-per-file", 30000).maxChars
    : readCharacterWindow("--max-chars", 30000).maxChars;
  const sourcePaths = options("--path");
  const pageItems = command === "read-batch" ? (result?.items || []) : [result];
  const pages = pageItems.map((item, index) => ({
    pvfPath: normalizePvfPath(item?.pvfPath || item?.metadata?.fileName || sourcePaths[index] || ""),
    returnedRange: item?.returnedRange || null,
    sourceCharCount: Number.isSafeInteger(item?.sourceCharCount) ? item.sourceCharCount : null,
    remainingCharCount: Number.isSafeInteger(item?.remainingCharCount) ? item.remainingCharCount : null,
    hasMore: item?.hasMore === true,
    nextStartChar: Number.isSafeInteger(item?.nextStartChar) ? item.nextStartChar : null,
    nextCommandOnly: continuationCommandForPage(item, sourcePaths[index], maxChars),
  }));
  const nextCommands = pages.map((page) => page.nextCommandOnly).filter(Boolean);
  return {
    characterPaginationSupported: true,
    argumentSemantics: readArgumentSemantics(),
    aliases: { startChar: "--offset", maxChars: "--limit" },
    pages,
    nextCommandOnly: nextCommands.length === 1 ? nextCommands[0] : null,
    nextCommands,
  };
}

function readArgumentSemantics() {
  const characterLimitOption = command === "read-batch" ? "--max-chars-per-file" : "--max-chars";
  const containerEncodingExplicit = option("--encoding") !== undefined;
  const textEncodingExplicit = option("--pvf-encoding") !== undefined;
  return {
    canonicalPagination: {
      startCharOption: "--start-char",
      characterLimitOption,
    },
    compatibilityAliases: {
      "--offset": "--start-char",
      "--limit": characterLimitOption,
    },
    unsupportedOptions: ["--count"],
    textEncodingOption: "--pvf-encoding",
    containerOpenEncodingOption: "--encoding",
    containerOpenEncodingDoesNotSetTextEncoding: true,
    explicitContainerEncodingWithoutExplicitTextEncoding: containerEncodingExplicit && !textEncodingExplicit,
    correction: containerEncodingExplicit && !textEncodingExplicit
      ? "--encoding 只控制 PVF 容器打开；若要强制正文使用 Cn/Tw，请明确填写 --pvf-encoding Cn 或 --pvf-encoding Tw。"
      : null,
  };
}

function readTextUsage(result, config, readPreparation = null) {
  if (command !== "read" && command !== "read-batch") return null;
  const raw = rawDisplayMode();
  const requestedEncoding = option("--pvf-encoding", config.defaults.pvfReadEncoding);
  const selectedEncodings = selectedReadEncodings(result, requestedEncoding);
  const preferredEncoding = selectedEncodings.length === 1 ? selectedEncodings[0] : null;
  const truncated = command === "read"
    ? result?.truncated === true
    : Boolean(result?.truncatedByTotalLimit || (result?.items || []).some((item) => item?.truncated === true));
  const pagination = readContinuationHandoff(result);
  return {
    mode: raw ? "canonical-change-source" : "reader-friendly-display",
    safeForChangeSetSource: raw,
    canonicalTokenLayout: raw,
    simplifiedChineseDisplayConversion: !raw && !flag("--no-simplified"),
    requestedEncoding,
    selectedEncodings,
    argumentSemantics: readArgumentSemantics(),
    responseTruncated: truncated,
    characterPagination: pagination,
    ...(raw ? { rawTextBindings: rawTextBindings(result) } : {}),
    warning: raw
      ? (truncated
        ? "这是修改校验使用的原始 token 排列，本次只返回一个字符分段；只能复制首尾都完整可见的 token，并按续读命令取得后续内容。"
        : "这是修改校验使用的原始 token 排列；只复制完整 token，并保留原始文字、换行和 Tab。")
      : "这是便于阅读的显示文本，可能已转成简体或整理布局，禁止复制到 change-set 的 previousText/contextBefore/contextAfter。",
    requiredActionBeforeChangeSet: raw
      ? null
      : {
          rerunSameTargetWithRaw: true,
          requiredFlags: ["--raw", `--pvf-encoding ${preferredEncoding || "<selected Cn or Tw>"}`],
          instruction: "对同一 PVF 路径重新运行 pvf-read read/read-batch，并从 --raw 结果复制完整原始 token。",
        },
    ...(raw && readPreparation ? { automaticEncodingSelection: readPreparation } : {}),
  };
}

function selectedCandidateSummary(selection, requestedEncoding, alternateEncoding) {
  const selectedEncoding = selection?.selectedEncoding || requestedEncoding;
  return {
    requestedEncoding,
    alternateEncoding,
    selectedEncoding,
    encodingConflict: selection?.encodingConflict === true,
    warning: selection?.warning || null,
    encodingEvidence: selection?.encodingEvidence || null,
  };
}

function directScriptEncodingEvidence(value) {
  return String(value || "")
    // StringLink display text comes from a separate string-view resource and
    // must not decide the encoding of direct script string-table tokens.
    .replace(/<\s*\d+\s*::[^>`]{1,512}`[^`]*`>/gu, "")
    .replace(/\[[^\]\r\n]+\]/g, "")
    .replace(/[\x00-\x7f]+/g, "");
}

function selectRawChineseCandidate(requestedFile, alternateFile, requestedEncoding, alternateEncoding) {
  const comparison = compareChineseEncodingCandidates(
    directScriptEncodingEvidence(requestedFile?.textContent),
    directScriptEncodingEvidence(alternateFile?.textContent),
    requestedEncoding,
    alternateEncoding,
  );
  const selectAlternate = comparison.requestedLooksMojibake === true;
  const selectedEncoding = selectAlternate ? alternateEncoding : requestedEncoding;
  const selectedFile = selectAlternate ? alternateFile : requestedFile;
  selectedFile.semanticReadGuard = {
    ...(selectedFile?.semanticReadGuard || {}),
    applied: true,
    reason: "raw-change-source-encoding-selection",
    backend: selectedFile?.semanticReadGuard?.backend || selectedFile?.backend || "typescript-readonly-fallback",
    automatic: true,
    requestedEncoding,
    selectedEncoding,
    encodingConflict: comparison.different === true,
    warning: selectAlternate
      ? `按 ${requestedEncoding} 原始读取时出现明显乱码特征，已只读选择更干净的 ${alternateEncoding} 结果。change-set 必须明确使用 ${alternateEncoding}。`
      : null,
  };
  return {
    file: selectedFile,
    selectedEncoding,
    encodingConflict: comparison.different === true,
    warning: selectAlternate
      ? `按 ${requestedEncoding} 原始读取时出现明显乱码特征，已只读选择更干净的 ${alternateEncoding} 结果。change-set 必须明确使用 ${alternateEncoding}。`
      : null,
    encodingEvidence: {
      requestedScore: comparison.requested?.score ?? null,
      alternateScore: comparison.alternate?.score ?? null,
      requestedReasons: comparison.requested?.reasons || [],
      alternateReasons: comparison.alternate?.reasons || [],
      preferredEncoding: comparison.preferredEncoding || null,
      stringLinkDisplayIgnored: true,
    },
  };
}

async function readOneRawAutoEncodingCandidate(client, sessionId, commandArgs, pvfPath, requestedEncoding) {
  const normalizedRequested = normalizeEncoding(requestedEncoding, "Tw");
  if (!["Cn", "Tw"].includes(normalizedRequested)) {
    const file = await callAndParse(client, "pvf_read_file", { ...commandArgs, pvfPath });
    return {
      file,
      selection: {
        requestedEncoding: normalizedRequested,
        alternateEncoding: null,
        selectedEncoding: normalizedRequested,
        encodingConflict: false,
        warning: null,
        encodingEvidence: null,
      },
    };
  }
  const alternateEncoding = normalizedRequested === "Cn" ? "Tw" : "Cn";
  const requestedFile = await callAndParse(client, "pvf_read_file", {
    ...commandArgs,
    pvfPath,
    pvfEncoding: normalizedRequested,
  });
  const alternateFile = await callAndParse(client, "pvf_read_file", {
    ...commandArgs,
    pvfPath,
    pvfEncoding: alternateEncoding,
  });
  const selection = selectRawChineseCandidate(
    requestedFile,
    alternateFile,
    normalizedRequested,
    alternateEncoding,
  );
  return {
    file: selection.file,
    selection: selectedCandidateSummary(selection, normalizedRequested, alternateEncoding),
  };
}

async function readRawWithAutomaticEncoding(client, sessionId, commandArgs) {
  const requestedEncoding = commandArgs.pvfEncoding;
  if (command === "read") {
    const candidate = await readOneRawAutoEncodingCandidate(
      client,
      sessionId,
      commandArgs,
      commandArgs.pvfPath,
      requestedEncoding,
    );
    return {
      result: candidate.file,
      readPreparation: {
        automatic: true,
        perFile: [
          {
            pvfPath: commandArgs.pvfPath,
            ...candidate.selection,
          },
        ],
      },
    };
  }
  const items = [];
  const selections = [];
  let returnedChars = 0;
  let truncatedByTotalLimit = false;
  for (const pvfPath of commandArgs.pvfPaths) {
    if (returnedChars >= commandArgs.maxTotalChars) {
      truncatedByTotalLimit = true;
      break;
    }
    const remainingChars = Math.max(0, commandArgs.maxTotalChars - returnedChars);
    const candidate = await readOneRawAutoEncodingCandidate(
      client,
      sessionId,
      {
        ...commandArgs,
        maxChars: Math.min(commandArgs.maxCharsPerFile, remainingChars),
      },
      pvfPath,
      requestedEncoding,
    );
    items.push({ pvfPath, ok: true, ...candidate.file });
    selections.push({ pvfPath, ...candidate.selection });
    returnedChars += String(candidate.file?.textContent || "").length;
    if (returnedChars >= commandArgs.maxTotalChars && items.length < commandArgs.pvfPaths.length) {
      truncatedByTotalLimit = true;
    }
  }
  return {
    result: {
      ok: items.every((item) => item.ok !== false),
      sessionId,
      items,
      requestedCount: commandArgs.pvfPaths.length,
      returnedCount: items.length,
      returnedChars,
      maxTotalChars: commandArgs.maxTotalChars,
      truncatedByTotalLimit,
    },
    readPreparation: { automatic: true, perFile: selections },
  };
}

function normalizePvfPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function containsNonAscii(value) {
  return /[^\x00-\x7f]/u.test(String(value || ""));
}

const NAME_PUNCTUATION_EQUIVALENTS = new Map([
  ["(", ["(", "（"]], [")", [")", "）"]],
  [":", [":", "："]], [";", [";", "；"]],
  [",", [",", "，", "、"]], [".", [".", "．", "。"]],
  ["!", ["!", "！"]], ["?", ["?", "？"]],
  ["+", ["+", "＋"]], ["-", ["-", "－", "—", "–"]],
  ["/", ["/", "／"]],
  ["[", ["[", "［", "【"]], ["]", ["]", "］", "】"]],
  ["{", ["{", "｛"]], ["}", ["}", "｝"]],
  ["<", ["<", "＜", "《"]], [">", [">", "＞", "》"]],
  ["\"", ["\"", "＂", "“", "”"]], ["'", ["'", "＇", "‘", "’"]],
  ["#", ["#", "＃"]], ["&", ["&", "＆"]],
  ["%", ["%", "％"]], ["@", ["@", "＠"]],
]);

function escapeRegexLiteral(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function naturalLanguageNameRegex(keyword, startMatch = false) {
  const normalized = String(keyword || "").normalize("NFKC").trim();
  if (!normalized) throw new Error("Name search keyword must contain at least one visible character.");
  const parts = [];
  let previousWasWhitespace = false;
  for (const character of normalized) {
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) parts.push("[\\s\\u3000]*");
      previousWasWhitespace = true;
      continue;
    }
    previousWasWhitespace = false;
    const equivalents = NAME_PUNCTUATION_EQUIVALENTS.get(character);
    parts.push(equivalents
      ? `(?:${equivalents.map(escapeRegexLiteral).join("|")})`
      : escapeRegexLiteral(character));
  }
  const body = parts.join("");
  return startMatch ? `^[\\s\\u3000]*${body}[\\s\\S]*` : `[\\s\\S]*${body}[\\s\\S]*`;
}

function prepareNaturalLanguageNameSearch(commandArgs) {
  if (commandArgs.searchType !== "SearchName" || commandArgs.matchMode !== "Like") {
    return { backendArgs: commandArgs, evidence: null };
  }
  return {
    backendArgs: {
      ...commandArgs,
      keyword: naturalLanguageNameRegex(commandArgs.keyword, commandArgs.isStartMatch === true),
      matchMode: "Regex",
      isStartMatch: false,
    },
    evidence: {
      mode: "literal-substring",
      safeLiteralEscaping: true,
      multilineNameTokenSupported: true,
      widthAndPunctuationVariantsSupported: true,
      originalMatchMode: "Like",
      backendMatchMode: "Regex",
    },
  };
}

function normalizedSearchPath(value) {
  return normalizePvfPath(value).replace(/\/+$/g, "").toLowerCase();
}

function domainRouteForSearchPath(value) {
  const requestedSearchPath = normalizedSearchPath(value);
  if (!requestedSearchPath) {
    return {
      known: false,
      requestedSearchPath: "",
      searchPath: "",
      domain: null,
      registryPath: null,
      registryStrategy: null,
      warning: "未限制领域；名称搜索可能扫描更多候选。已知类别时应提供 --search-path。",
    };
  }
  const exact = DOMAIN_SEARCH_ROUTES.find((route) =>
    requestedSearchPath === route.domain ||
    requestedSearchPath === route.searchPath ||
    route.aliases.includes(requestedSearchPath));
  const nested = exact || DOMAIN_SEARCH_ROUTES.find((route) => requestedSearchPath.startsWith(`${route.searchPath}/`));
  if (!nested) {
    return {
      known: false,
      requestedSearchPath,
      searchPath: requestedSearchPath,
      domain: null,
      registryPath: null,
      registryStrategy: null,
      warning: "这是自定义搜索前缀；命中后仍需从目标 PVF 的 registry 证据确认身份。",
    };
  }
  const searchPath = exact && requestedSearchPath !== nested.searchPath
    ? nested.searchPath
    : requestedSearchPath;
  return {
    known: true,
    requestedSearchPath,
    searchPath,
    domain: nested.domain,
    description: nested.description,
    registryPath: nested.registryPath,
    registryStrategy: nested.registryStrategy || (nested.registryPath
      ? "returned paths are automatically reverse-resolved through this target registry"
      : null),
    secondaryRegistry: nested.secondary === true,
  };
}

function normalizedRegistryPath(value) {
  const requested = normalizePvfPath(value).replace(/\/+$/g, "");
  if (!requested || requested.toLowerCase().endsWith(".lst")) return requested;
  const route = domainRouteForSearchPath(requested);
  return route.known && route.registryPath ? route.registryPath : requested;
}

function readCharacterWindow(maxCharsOption, fallbackMaxChars) {
  const canonicalStart = option("--start-char");
  const aliasStart = option("--offset");
  const canonicalLimit = option(maxCharsOption);
  const aliasLimit = option("--limit");
  if (canonicalStart !== undefined && aliasStart !== undefined) {
    throw new Error("Use either --start-char or --offset, not both.");
  }
  if (canonicalLimit !== undefined && aliasLimit !== undefined) {
    throw new Error(`Use either ${maxCharsOption} or --limit, not both.`);
  }
  const startChar = Number(canonicalStart ?? aliasStart ?? 0);
  const maxChars = Number(canonicalLimit ?? aliasLimit ?? fallbackMaxChars);
  if (!Number.isSafeInteger(startChar) || startChar < 0) {
    throw new Error("--start-char/--offset must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error(`${maxCharsOption}/--limit must be a positive safe integer.`);
  }
  const lineSliceRequested = option("--start-line") !== undefined || option("--end-line") !== undefined;
  const characterSliceRequested = canonicalStart !== undefined || aliasStart !== undefined || aliasLimit !== undefined;
  if (lineSliceRequested && characterSliceRequested) {
    throw new Error("Character pagination cannot be combined with --start-line/--end-line in one read.");
  }
  return { startChar, maxChars };
}

function registryQueryPath(value, registryPaths = []) {
  const requestedPvfPath = normalizePvfPath(value);
  const baseDirectories = [...new Set((registryPaths || [])
    .map((registryPath) => path.posix.dirname(normalizePvfPath(registryPath)))
    .filter((directory) => directory && directory !== ".")
    .map((directory) => directory.toLowerCase()))];
  if (baseDirectories.length !== 1) {
    return { requestedPvfPath, pvfPath: requestedPvfPath, registryRelativePathExpanded: false };
  }
  const baseDirectory = baseDirectories[0];
  if (requestedPvfPath.toLowerCase().startsWith(`${baseDirectory}/`)) {
    return { requestedPvfPath, pvfPath: requestedPvfPath, registryRelativePathExpanded: false };
  }
  return {
    requestedPvfPath,
    pvfPath: normalizePvfPath(`${baseDirectory}/${requestedPvfPath}`),
    registryRelativePathExpanded: true,
  };
}

function displayReadAgentHandoff(result) {
  return {
    readerFriendlyDisplayComplete: result?.truncated !== true && result?.truncatedByTotalLimit !== true,
    safeForChangeSetSource: false,
    readContinuation: readContinuationHandoff(result),
    instruction: "显示文本只用于阅读；准备修改时仍须对同一路径使用 --raw。若有下一段，直接执行返回的续读命令。",
  };
}

function searchBatchRequests(config, sessionId) {
  const names = options("--name");
  const searchPaths = options("--search-path");
  if (!names.length) throw new Error("search-batch requires at least one --name.");
  if (names.length > 50) throw new Error("search-batch accepts at most 50 --name values per call.");
  if (names.some((name) => !name || String(name).startsWith("--"))) {
    throw new Error("Every --name must have a non-empty value.");
  }
  if (searchPaths.length !== 1 && searchPaths.length !== names.length) {
    throw new Error("search-batch requires one shared --search-path or exactly one --search-path for every --name.");
  }
  if (searchPaths.some((searchPath) => !searchPath || String(searchPath).startsWith("--"))) {
    throw new Error("Every --search-path must have a non-empty value.");
  }
  const shared = searchPaths.length === 1;
  return names.map((name, index) => {
    const domainRoute = domainRouteForSearchPath(searchPaths[shared ? 0 : index]);
    return {
      index,
      name,
      domainRoute,
      toolArgs: {
        sessionId,
        keyword: name,
        searchPath: domainRoute.searchPath,
        isStartMatch: flag("--start-match"),
        isUseLikeSearchPath: flag("--like-search-path"),
        searchType: "SearchName",
        matchMode: option("--match-mode", "Like"),
        pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
        convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
        limit: numberOption("--limit", config.defaults.searchLimit),
      },
    };
  });
}

function searchItemKey(item) {
  return normalizePvfPath(item?.fileName || item?.pvfPath || "").toLowerCase();
}

function automaticSearchCandidateSummary(encoding, result) {
  return {
    encoding,
    matchedCount: Number(result?.matchedCount || 0),
    returnedCount: Number(result?.returnedCount ?? (result?.items || []).length),
    searchedCount: Number(result?.searchedCount || 0),
    truncated: result?.truncated === true,
    errorCount: Number(result?.errorCount || 0),
  };
}

function mergeAutomaticNameSearchResults(plan, requestedResult, alternateResult, outputLimit) {
  const requestedItems = Array.isArray(requestedResult?.items) ? requestedResult.items : [];
  const alternateItems = Array.isArray(alternateResult?.items) ? alternateResult.items : [];
  const requestedCount = Number(requestedResult?.matchedCount || 0);
  const alternateCount = Number(alternateResult?.matchedCount || 0);
  const requestedFull = requestedResult?.truncated !== true && requestedItems.length === requestedCount;
  const alternateFull = alternateResult?.truncated !== true && alternateItems.length === alternateCount;
  const requestedKeys = new Set(requestedItems.map(searchItemKey).filter(Boolean));
  const alternateKeys = new Set(alternateItems.map(searchItemKey).filter(Boolean));
  const exactEquivalent =
    requestedFull && alternateFull && requestedKeys.size === alternateKeys.size &&
    [...requestedKeys].every((key) => alternateKeys.has(key));

  let selectionMode;
  let selectedEncoding = null;
  let sourceItems;
  let matchedCount;
  let matchedCountExact = true;
  let matchSetsConflict = false;
  if (requestedCount > 0 && alternateCount === 0) {
    selectionMode = "requested-only-match";
    selectedEncoding = plan.requestedEncoding;
    sourceItems = requestedItems;
    matchedCount = requestedCount;
  } else if (alternateCount > 0 && requestedCount === 0) {
    selectionMode = "alternate-only-match";
    selectedEncoding = plan.alternateEncoding;
    sourceItems = alternateItems;
    matchedCount = alternateCount;
  } else if (requestedCount === 0 && alternateCount === 0) {
    selectionMode = "no-match-both-checked";
    sourceItems = [];
    matchedCount = 0;
  } else if (exactEquivalent) {
    selectionMode = "equivalent-match-paths";
    selectedEncoding = plan.requestedEncoding;
    sourceItems = requestedItems;
    matchedCount = requestedCount;
  } else {
    selectionMode = "merged-ambiguous-match-paths";
    matchSetsConflict = true;
    const merged = new Map();
    for (const [encoding, items] of [[plan.requestedEncoding, requestedItems], [plan.alternateEncoding, alternateItems]]) {
      for (const item of items) {
        const key = searchItemKey(item);
        if (!key) continue;
        const previous = merged.get(key);
        if (previous) {
          previous.encodingMatches.push(encoding);
        } else {
          merged.set(key, { ...item, encodingMatches: [encoding] });
        }
      }
    }
    sourceItems = [...merged.values()];
    matchedCountExact = requestedFull && alternateFull;
    matchedCount = sourceItems.length;
  }

  const encodingMatchesFor = (item) => {
    if (Array.isArray(item.encodingMatches)) return item.encodingMatches;
    const key = searchItemKey(item);
    const values = [];
    if (requestedKeys.has(key)) values.push(plan.requestedEncoding);
    if (alternateKeys.has(key)) values.push(plan.alternateEncoding);
    return values;
  };
  const annotatedItems = sourceItems.map((item) => ({ ...item, encodingMatches: encodingMatchesFor(item) }));
  const limit = Math.max(1, Math.min(Number(outputLimit || 50), 500));
  const errors = [
    ...(requestedResult?.errors || []).map((error) => ({ ...error, pvfEncoding: plan.requestedEncoding })),
    ...(alternateResult?.errors || []).map((error) => ({ ...error, pvfEncoding: plan.alternateEncoding })),
  ];
  const automaticEncodingSelection = {
    ...plan,
    selectedEncoding,
    selectionMode,
    matchSetsConflict,
    writeEncodingAuthorized: false,
    candidates: [
      automaticSearchCandidateSummary(plan.requestedEncoding, requestedResult),
      automaticSearchCandidateSummary(plan.alternateEncoding, alternateResult),
    ],
    warning: matchSetsConflict
      ? "两种只读解码返回了不同路径，已合并候选并标记歧义；不得据此决定文字写入编码。"
      : (selectionMode === "no-match-both-checked"
        ? "Cn/Tw 均已自动检查且没有名称命中；不需要人工换编码重搜，但零命中仍不证明目标不存在。"
        : null),
  };
  return {
    ok: true,
    sessionId: requestedResult?.sessionId || alternateResult?.sessionId,
    matchedCount,
    matchedCountExact,
    ...(matchedCountExact ? {} : { matchedCountLowerBound: matchedCount }),
    searchedCount: Math.max(Number(requestedResult?.searchedCount || 0), Number(alternateResult?.searchedCount || 0)),
    searchPassCount: 2,
    candidateFileVisits: Number(requestedResult?.searchedCount || 0) + Number(alternateResult?.searchedCount || 0),
    returnedCount: Math.min(limit, annotatedItems.length),
    truncated: requestedResult?.truncated === true || alternateResult?.truncated === true || annotatedItems.length > limit,
    errorCount: Number(requestedResult?.errorCount || 0) + Number(alternateResult?.errorCount || 0),
    errorsTruncated: requestedResult?.errorsTruncated === true || alternateResult?.errorsTruncated === true,
    errors,
    items: annotatedItems.slice(0, limit),
    semanticReadGuard: {
      applied: true,
      automatic: true,
      reason: "automatic-cn-tw-name-search",
      backend: "combined-read-only-search",
      selectedEncoding,
      encodingConflict: matchSetsConflict,
      writeEncodingAuthorized: false,
    },
    automaticEncodingSelection,
  };
}

function compactRegistryIdentity(resolution, registryPath) {
  const matches = (resolution?.matches || []).map((match) => ({
    id: Number(match?.entry?.id),
    pvfPath: normalizePvfPath(match?.entry?.pvfPath || ""),
    rawPath: match?.entry?.rawPath,
    line: match?.entry?.line,
  })).filter((entry) => Number.isSafeInteger(entry.id) && entry.pvfPath);
  return {
    checked: true,
    confirmed: matches.length > 0,
    registryPath,
    matchedCount: matches.length,
    entries: matches,
  };
}

async function attachSearchRegistryIdentity(client, commandArgs, result, route) {
  if (!route?.known || !route.registryPath || !Array.isArray(result?.items) || result.items.length === 0) {
    return result;
  }
  const registryPath = normalizedRegistryPath(route.registryPath);
  const registryEncoding = result?.automaticEncodingSelection?.selectedEncoding || commandArgs.pvfEncoding;
  const items = [];
  let confirmedCount = 0;
  for (const item of result.items) {
    const pvfPath = normalizePvfPath(item?.fileName || item?.pvfPath || "");
    if (!pvfPath) {
      items.push(item);
      continue;
    }
    const resolution = await callAndParse(client, "pvf_resolve_path", {
      sessionId: commandArgs.sessionId,
      pvfPath,
      registryPaths: [registryPath],
      includeSecondary: false,
      includeErrors: false,
      pvfEncoding: registryEncoding,
      convertToSimplifiedChinese: commandArgs.convertToSimplifiedChinese,
    });
    const registryIdentity = compactRegistryIdentity(resolution, registryPath);
    if (registryIdentity.confirmed) confirmedCount += 1;
    items.push({ ...item, registryIdentity });
  }
  return {
    ...result,
    items,
    registryResolution: {
      automatic: true,
      registryPath,
      returnedPathCount: items.length,
      confirmedCount,
      allReturnedPathsConfirmed: confirmedCount === items.length,
      additionalResolvePathCommandsRequired: confirmedCount !== items.length,
    },
  };
}

async function executeSearch(client, config, commandArgs, encodingExplicit) {
  const route = commandArgs.searchType === "SearchName"
    ? domainRouteForSearchPath(commandArgs.searchPath)
    : null;
  const prepared = prepareNaturalLanguageNameSearch(commandArgs);
  const plan = automaticChineseNameSearchPlan({
    ...commandArgs,
    encodingExplicit,
  }, config.defaults.pvfReadEncoding);
  if (!plan) {
    const result = await callAndParse(client, "pvf_search", prepared.backendArgs);
    return attachSearchRegistryIdentity(client, prepared.backendArgs, {
      ...result,
      ...(prepared.evidence ? { nameSearch: prepared.evidence } : {}),
      ...(route ? { domainRoute: route } : {}),
    }, route);
  }
  const internalLimit = 500;
  const requestedResult = await callAndParse(client, "pvf_search", {
    ...prepared.backendArgs,
    pvfEncoding: plan.requestedEncoding,
    limit: internalLimit,
  });
  const alternateResult = await callAndParse(client, "pvf_search", {
    ...prepared.backendArgs,
    pvfEncoding: plan.alternateEncoding,
    limit: internalLimit,
  });
  return attachSearchRegistryIdentity(client, prepared.backendArgs, {
    ...mergeAutomaticNameSearchResults(plan, requestedResult, alternateResult, commandArgs.limit),
    ...(prepared.evidence ? { nameSearch: prepared.evidence } : {}),
    ...(route ? { domainRoute: route } : {}),
  }, route);
}

function compactBatchSearchResult(result) {
  const selection = result?.automaticEncodingSelection;
  const compactSelection = selection
    ? {
        automatic: true,
        checkedEncodings: selection.checkedEncodings || [],
        selectedEncoding: selection.selectedEncoding ?? null,
        selectionMode: selection.selectionMode,
        matchSetsConflict: selection.matchSetsConflict === true,
        candidateMatchedCounts: Object.fromEntries(
          (selection.candidates || []).map((candidate) => [candidate.encoding, Number(candidate.matchedCount || 0)]),
        ),
        writeEncodingAuthorized: false,
        ...(selection.warning ? { warning: selection.warning } : {}),
      }
    : null;
  return {
    matchedCount: Number(result?.matchedCount || 0),
    matchedCountExact: result?.matchedCountExact !== false,
    searchedCount: Number(result?.searchedCount || 0),
    returnedCount: Number(result?.returnedCount ?? (result?.items || []).length),
    truncated: result?.truncated === true,
    errorCount: Number(result?.errorCount || 0),
    ...(Number(result?.errorCount || 0) > 0 ? {
      errorsTruncated: result?.errorsTruncated === true,
      errors: result?.errors || [],
    } : {}),
    items: result?.items || [],
    ...(result?.nameSearch ? { nameSearch: result.nameSearch } : {}),
    ...(result?.registryResolution ? { registryResolution: result.registryResolution } : {}),
    ...(compactSelection ? { automaticEncodingSelection: compactSelection } : {}),
  };
}

async function executeSearchBatch(client, config, sessionId) {
  const requests = searchBatchRequests(config, sessionId);
  const encodingExplicit = option("--pvf-encoding") !== undefined;
  const items = [];
  for (const request of requests) {
    const searchResult = await executeSearch(client, config, request.toolArgs, encodingExplicit);
    const result = compactBatchSearchResult(searchResult);
    items.push({
      index: request.index,
      name: request.name,
      requestedSearchPath: request.domainRoute.requestedSearchPath,
      searchPath: request.domainRoute.searchPath,
      domainRoute: request.domainRoute,
      result,
    });
  }
  return {
    ok: true,
    sessionId,
    requestedCount: requests.length,
    completedCount: items.length,
    matchedRequestCount: items.filter((item) => Number(item.result?.matchedCount || 0) > 0).length,
    zeroMatchCount: items.filter((item) => Number(item.result?.matchedCount || 0) === 0).length,
    totalMatchedCount: items.reduce((sum, item) => sum + Number(item.result?.matchedCount || 0), 0),
    totalCandidateFilesSearched: items.reduce((sum, item) => sum + Number(item.result?.searchedCount || 0), 0),
    automaticEncodingSearchCount: items.filter((item) => item.result?.automaticEncodingSelection?.automatic === true).length,
    sessionReuse: { openedSessionCount: 1, searchRequestCount: requests.length },
    items,
  };
}

function batchIds() {
  const values = options("--id");
  if (values.length < 2) throw new Error("resolve-lst-batch requires at least two --id values; use resolve-lst for one ID.");
  if (values.length > 100) throw new Error("resolve-lst-batch accepts at most 100 --id values per call.");
  const ids = values.map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    throw new Error("Every --id must be a non-negative safe integer.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("resolve-lst-batch does not accept duplicate --id values.");
  return ids;
}

function batchLstPath() {
  const value = requireOption("--lst");
  if (String(value).startsWith("--")) throw new Error("--lst must have an explicit registry path or domain alias.");
  const lstPath = normalizedRegistryPath(value);
  if (!lstPath) throw new Error("--lst must have an explicit registry path or domain alias.");
  return lstPath;
}

function batchPaths() {
  const values = options("--path").map(normalizePvfPath);
  if (values.length < 2) throw new Error("resolve-path-batch requires at least two --path values; use resolve-path for one path.");
  if (values.length > 100) throw new Error("resolve-path-batch accepts at most 100 --path values per call.");
  if (values.some((value) => !value || value.startsWith("--"))) throw new Error("Every --path must have a non-empty value.");
  const keys = values.map((value) => value.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error("resolve-path-batch does not accept duplicate --path values.");
  return values;
}

function batchRegistryPaths() {
  const values = options("--registry");
  if (!values.length) throw new Error("resolve-path-batch requires at least one explicit --registry.");
  if (values.length > 20) throw new Error("resolve-path-batch accepts at most 20 --registry values per call.");
  if (values.some((value) => !value || String(value).startsWith("--"))) {
    throw new Error("Every --registry must have an explicit registry path or domain alias.");
  }
  const registryPaths = values.map(normalizedRegistryPath);
  const keys = registryPaths.map((value) => value.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    throw new Error("resolve-path-batch does not accept duplicate --registry values.");
  }
  return registryPaths;
}

function currentSourceCommandParts() {
  const profile = option("--profile");
  const pvf = option("--pvf");
  const sourceValue = quotedCommandArgument(profile || pvf);
  return sourceValue ? [profile ? "--profile" : "--pvf", sourceValue] : null;
}

function readBatchNextCommand(pvfPaths) {
  const sourceParts = currentSourceCommandParts();
  if (!sourceParts || !pvfPaths.length || pvfPaths.length > 100) return null;
  const parts = ["workbench.bat", "pvf-read", "read-batch", ...sourceParts];
  for (const pvfPath of pvfPaths) {
    const quoted = quotedCommandArgument(pvfPath);
    if (!quoted) return null;
    parts.push("--path", quoted);
  }
  return parts.join(" ");
}

async function executeResolveLstBatch(client, config, sessionId) {
  const ids = batchIds();
  const lstPath = batchLstPath();
  const includeFileSummary = flag("--include-summary");
  const common = {
    sessionId,
    lstPath,
    includeFileSummary,
    pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
    convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
  };
  const items = [];
  for (const id of ids) {
    const result = await callAndParse(client, "pvf_resolve_lst_id", { ...common, id });
    items.push({ id, result });
  }
  const foundPaths = [];
  const foundPathKeys = new Set();
  for (const item of items) {
    const pvfPath = item.result?.found === true ? normalizePvfPath(item.result.entry?.pvfPath) : "";
    const key = pvfPath.toLowerCase();
    if (!pvfPath || foundPathKeys.has(key)) continue;
    foundPathKeys.add(key);
    foundPaths.push(pvfPath);
  }
  return {
    ok: true,
    sessionId,
    registryPath: lstPath,
    requestedCount: ids.length,
    completedCount: items.length,
    foundCount: items.filter((item) => item.result?.found === true).length,
    uniqueFoundPathCount: foundPaths.length,
    missingIds: items.filter((item) => item.result?.found !== true).map((item) => item.id),
    onePvfSessionUsed: true,
    items,
    recommendedReadBatchCommand: readBatchNextCommand(foundPaths),
  };
}

async function executeResolvePathBatch(client, config, sessionId) {
  const requestedPvfPaths = batchPaths();
  const registryPaths = batchRegistryPaths();
  const common = {
    sessionId,
    registryPaths,
    includeSecondary: flag("--include-secondary"),
    includeErrors: flag("--include-errors"),
    pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
    convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
  };
  const items = [];
  for (const requestedPvfPath of requestedPvfPaths) {
    const query = registryQueryPath(requestedPvfPath, registryPaths);
    const result = await callAndParse(client, "pvf_resolve_path", { ...common, pvfPath: query.pvfPath });
    items.push({
      requestedPvfPath: query.requestedPvfPath,
      pvfPath: query.pvfPath,
      registryRelativePathExpanded: query.registryRelativePathExpanded,
      result,
    });
  }
  return {
    ok: true,
    sessionId,
    registryPaths,
    requestedCount: requestedPvfPaths.length,
    completedCount: items.length,
    confirmedCount: items.filter((item) => Number(item.result?.matchedCount || 0) > 0).length,
    unmatchedPaths: items.filter((item) => Number(item.result?.matchedCount || 0) === 0).map((item) => item.requestedPvfPath),
    onePvfSessionUsed: true,
    items,
  };
}

function quotedCommandArgument(value) {
  const text = String(value || "");
  if (!text || /[\x00\r\n%!?^&|<>"]/u.test(text)) return null;
  return `"${text}"`;
}

function naturalNameSearchCommand(commandArgs) {
  const keyword = quotedCommandArgument(commandArgs.keyword);
  const profile = option("--profile");
  const pvf = option("--pvf");
  const sourceValue = quotedCommandArgument(profile || pvf);
  if (!keyword || !sourceValue) return null;
  const parts = ["workbench.bat", "pvf-read", "search", profile ? "--profile" : "--pvf", sourceValue, "--keyword", keyword];
  if (commandArgs.searchPath) {
    const searchPath = quotedCommandArgument(commandArgs.searchPath);
    if (!searchPath) return null;
    parts.push("--search-path", searchPath);
  }
  parts.push("--limit", String(commandArgs.limit));
  return parts.join(" ");
}

function searchAgentHandoff(commandName, commandArgs, commandResult) {
  const matchedCount = Number(commandResult?.matchedCount || 0);
  if (commandName === "search-script") {
    const naturalLanguageNameSearchRequired =
      matchedCount === 0 && containsNonAscii(commandArgs.keyword);
    return {
      exactScriptSearchComplete: true,
      exactScriptSymbolsOnly: true,
      naturalLanguageNameSearchRequired,
      nextCommandOnly: naturalLanguageNameSearchRequired ? naturalNameSearchCommand(commandArgs) : null,
      repeatSimplifiedTraditionalScriptSearchRequired: false,
      additionalGenericSearchRequired: false,
      helpProbeRequired: false,
      zeroMatchesProveRuntimeAbsence: false,
      instruction: naturalLanguageNameSearchRequired
        ? "中文任务、副本、装备、道具、NPC 等实体名称应改用 SearchName；不要继续用 search-script 轮流尝试简体、繁体或标点变体。"
        : "search-script 只用于目标脚本符号或正文精确观察；0 命中不证明运行时不存在。",
      prohibitedFollowUp: [
        "Test-Path",
        "Get-Item",
        "help probe",
        "generic filename guessing",
        "repeat search-script with simplified/traditional variants",
      ],
    };
  }
  if (commandName === "search" && commandArgs.searchType === "SearchName") {
    const automaticEncodingSelection = commandResult?.automaticEncodingSelection || null;
    const domainRoute = commandResult?.domainRoute || domainRouteForSearchPath(commandArgs.searchPath);
    const broadResultSet = commandResult?.truncated === true;
    const registryResolution = commandResult?.registryResolution || null;
    const returnedRegistryIdentityAutomaticallyChecked = registryResolution?.automatic === true;
    const allReturnedPathsRegistryConfirmed = registryResolution?.allReturnedPathsConfirmed === true;
    return {
      naturalLanguageNameSearchComplete: true,
      matchedCount,
      simplifiedTraditionalRetryRequired: false,
      cnTwEncodingRetryRequired: false,
      automaticCnTwEncodingChecked: automaticEncodingSelection?.automatic === true,
      checkedEncodings: automaticEncodingSelection?.checkedEncodings || [commandArgs.pvfEncoding].filter(Boolean),
      selectedSearchEncoding: automaticEncodingSelection?.selectedEncoding || commandArgs.pvfEncoding || null,
      searchEncodingMayAuthorizeWrite: false,
      automaticFullScriptRescanRequired: false,
      literalSubstringMatchApplied: commandResult?.nameSearch?.mode === "literal-substring",
      multilineNameTokenSupported: commandResult?.nameSearch?.multilineNameTokenSupported === true,
      widthAndPunctuationVariantsSupported: commandResult?.nameSearch?.widthAndPunctuationVariantsSupported === true,
      broadResultSet,
      readEveryBroadCandidateRequired: false,
      zeroMatchesProveTargetAbsence: false,
      domainRoute,
      returnedRegistryIdentityAutomaticallyChecked,
      allReturnedPathsRegistryConfirmed,
      additionalResolvePathCommandsRequired: returnedRegistryIdentityAutomaticallyChecked
        ? registryResolution?.additionalResolvePathCommandsRequired !== false
        : domainRoute?.registryPath != null && matchedCount > 0,
      returnedPathOrStemSecondSearchRequired: false,
      sourceIdentityWhenExplicitlyRequired: sourceIdentityAgentHandoff(),
      writeCapabilityPreflight: writeCapabilityAgentHandoff(),
      nextAction: sourceIdentityPriorityNextAction(matchedCount > 0
        ? (broadResultSet
          ? "the name matched more paths than were returned. Narrow once with the distinctive concrete words already present in the user's request; the narrowed result will attach registry identity automatically. Then read only those specific hits; do not read every broad candidate or switch to search-script."
          : (allReturnedPathsRegistryConfirmed
            ? "the returned paths already include confirmed registry IDs. Read back only those returned paths; do not run resolve-path again and do not search their path, directory, or filename stem for a second confirmation."
            : "read back only the returned paths. If this domain exposes a registry route but automatic identity confirmation is unavailable, resolve only the still-unconfirmed paths through that route before changing anything."))
        : (automaticEncodingSelection?.selectionMode === "no-match-both-checked"
          ? "Cn/Tw have both been checked automatically. Use the shortest concrete entity name once, then follow registry or dependency evidence; do not retry alternate encoding, simplified/traditional spelling, or search-script."
          : "use the shortest concrete entity name and the known domain search path; do not retry the same name through search-script or alternate simplified/traditional spelling.")),
    };
  }
  return null;
}

function searchBatchAgentHandoff(commandResult) {
  const zeroMatchNames = (commandResult?.items || [])
    .filter((item) => Number(item?.result?.matchedCount || 0) === 0)
    .map((item) => item.name);
  const broadMatchNames = (commandResult?.items || [])
    .filter((item) => item?.result?.truncated === true)
    .map((item) => item.name);
  const matchedResults = (commandResult?.items || [])
    .filter((item) => Number(item?.result?.matchedCount || 0) > 0);
  const registryRoutedResults = matchedResults
    .filter((item) => item?.domainRoute?.registryPath);
  const automaticallyResolvedResults = registryRoutedResults
    .filter((item) => item?.result?.registryResolution?.automatic === true);
  const allReturnedRegistryPathsConfirmed = registryRoutedResults.length > 0 &&
    automaticallyResolvedResults.length === registryRoutedResults.length &&
    automaticallyResolvedResults.every((item) => item.result.registryResolution.allReturnedPathsConfirmed === true);
  return {
    naturalLanguageBatchSearchComplete: true,
    requestedCount: Number(commandResult?.requestedCount || 0),
    completedCount: Number(commandResult?.completedCount || 0),
    zeroMatchNames,
    broadMatchNames,
    onePvfSessionUsed: commandResult?.sessionReuse?.openedSessionCount === 1,
    simplifiedTraditionalRetryRequired: false,
    cnTwEncodingRetryRequired: false,
    searchScriptFallbackRequired: false,
    helpProbeRequired: false,
    literalSubstringMatchApplied: (commandResult?.items || []).every((item) => item?.result?.nameSearch?.mode === "literal-substring"),
    multilineNameTokenSupported: true,
    widthAndPunctuationVariantsSupported: true,
    readEveryBroadCandidateRequired: false,
    zeroMatchesProveTargetAbsence: false,
    returnedRegistryIdentityAutomaticallyChecked: automaticallyResolvedResults.length > 0,
    allReturnedRegistryPathsConfirmed,
    additionalResolvePathCommandsRequired: registryRoutedResults.length > 0 && !allReturnedRegistryPathsConfirmed,
    returnedPathOrStemSecondSearchRequired: false,
    sourceIdentityWhenExplicitlyRequired: sourceIdentityAgentHandoff(),
    writeCapabilityPreflight: writeCapabilityAgentHandoff(),
    nextAction: sourceIdentityPriorityNextAction(zeroMatchNames.length === 0
      ? (broadMatchNames.length > 0
        ? "prefer the most specific successful names already included in this batch. If a broad item is still needed, narrow it once with distinctive concrete words from the user's request; do not read every broad candidate or switch to search-script."
        : (allReturnedRegistryPathsConfirmed
          ? "the returned paths already include confirmed registry IDs. Read them in one read-batch where practical; do not run per-path resolve-path commands or search path stems for a second confirmation."
          : "read back only returned paths. Resolve only identities that the result explicitly leaves unconfirmed, using one batch command where practical."))
      : "for zero-match entries, shorten once to the concrete name and then follow registry/dependency evidence; do not launch per-name encoding or search-script loops."),
  };
}

function registrySelectorBoundary() {
  return {
    naturalLanguageNameMustUseSearchNameFirst: true,
    directRegistryResolutionAllowedFirstOnlyForExplicitSelector: true,
    guessedIdOrPathCannotAuthorizeFirstResolution: true,
  };
}

function registryResolutionAgentHandoff(commandName, commandResult) {
  if (commandName === "resolve-lst-batch") {
    return {
      ...registrySelectorBoundary(),
      batchRegistryIdResolutionComplete: true,
      requestedCount: Number(commandResult?.requestedCount || 0),
      foundCount: Number(commandResult?.foundCount || 0),
      missingIds: commandResult?.missingIds || [],
      onePvfSessionUsed: commandResult?.onePvfSessionUsed === true,
      additionalPerIdResolveRequired: false,
      returnedPathOrStemSearchRequired: false,
      nextCommandOnly: commandResult?.recommendedReadBatchCommand || null,
      helpProbeRequired: false,
      instruction: commandResult?.recommendedReadBatchCommand
        ? "IDs were resolved together. Use the supplied read-batch command once; do not repeat resolve-lst per ID or search returned path stems. This route is valid as the first lookup only when the user explicitly supplied these IDs; a natural-language entity must use SearchName first."
        : "IDs were resolved together. Missing IDs remain unresolved evidence; do not guess their paths or search numeric IDs as names. If the task started from a natural-language entity, return to SearchName before using guessed IDs.",
      prohibitedFollowUp: ["per-ID resolve-lst loop", "returned path stem search", "help probe", "filename guessing"],
    };
  }
  if (commandName === "resolve-path-batch") {
    return {
      ...registrySelectorBoundary(),
      batchRegistryPathResolutionComplete: true,
      requestedCount: Number(commandResult?.requestedCount || 0),
      confirmedCount: Number(commandResult?.confirmedCount || 0),
      unmatchedPaths: commandResult?.unmatchedPaths || [],
      onePvfSessionUsed: commandResult?.onePvfSessionUsed === true,
      additionalPerPathResolveRequired: false,
      returnedPathOrStemSearchRequired: false,
      nextCommandOnly: null,
      helpProbeRequired: false,
      instruction: "Paths were checked together against the explicit registry route. Do not repeat resolve-path per file or search path stems merely for a second confirmation. This route is valid as the first lookup only for a user-supplied registered path; a path inferred from a natural-language entity must go through SearchName first.",
      prohibitedFollowUp: ["per-path resolve-path loop", "returned path stem search", "help probe", "filename guessing"],
    };
  }
  if (commandName === "resolve-lst") {
    return {
      ...registrySelectorBoundary(),
      registryIdResolutionComplete: true,
      found: commandResult?.found === true,
      additionalResolveLstRequired: false,
      returnedPathOrStemSearchRequired: false,
      helpProbeRequired: false,
      instruction: "此命令只适用于用户明确提供数字 ID/登记路径的选择器；如果任务是在按自然语言寻找实体，必须先运行对应领域的 SearchName，再使用其登记证据。",
    };
  }
  if (commandName === "resolve-path") {
    return {
      ...registrySelectorBoundary(),
      registryPathResolutionComplete: true,
      confirmed: Number(commandResult?.matchedCount || 0) > 0,
      additionalResolvePathRequired: false,
      returnedPathOrStemSearchRequired: false,
      helpProbeRequired: false,
      instruction: "此命令只适用于用户明确提供登记路径的选择器；如果路径是从自然语言实体推测出来的，先回到对应领域的 SearchName。",
    };
  }
  return null;
}

function parseLstEntries(content, lstPath) {
  const entries = [];
  const normalizedLstPath = normalizePvfPath(lstPath);
  const baseDir = path.posix.dirname(normalizedLstPath);
  const basePrefix = baseDir === "." ? "" : `${baseDir}/`;
  const lines = String(content || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(\d+)\s+`([^`]+)`/);
    if (!match) continue;
    const rawPath = normalizePvfPath(match[2]);
    const pvfPath = !basePrefix || rawPath.toLowerCase().startsWith(basePrefix.toLowerCase())
      ? rawPath
      : path.posix.join(baseDir, rawPath);
    entries.push({ id: Number(match[1]), rawPath, pvfPath: normalizePvfPath(pvfPath), line: index + 1 });
  }
  return entries;
}

function normalizeJobSelector(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`\[\]{}()_\-\s]+/g, "");
}

function extractJobToken(content) {
  const match = String(content || "").match(/\[job\]\s*(?:\r?\n)+\s*`?\[([^\]\r\n]+)\]`?/i);
  return match ? String(match[1]).trim() : "";
}

function normalizedTextContains(content, selector) {
  const needle = normalizeJobSelector(selector);
  if (!needle) return false;
  return normalizeJobSelector(content).includes(needle);
}

function toolArgsFor(commandName, config, sessionId) {
  if (commandName === "list-registries") {
    return {
      sessionId,
      includeCounts: flag("--include-counts"),
      includeSecondary: flag("--include-secondary"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
    };
  }
  if (commandName === "list-files") {
    return {
      sessionId,
      prefix: option("--prefix"),
      contains: option("--contains"),
      limit: numberOption("--limit", config.defaults.listLimit),
    };
  }
  if (commandName === "list-files-page") {
    return {
      sessionId,
      prefix: option("--prefix"),
      contains: option("--contains"),
      offset: numberOption("--offset", 0),
      limit: numberOption("--limit", 2000),
    };
  }
  if (commandName === "search" || commandName === "search-script") {
    const requestedSearchPath = option("--search-path", "");
    const domainRoute = commandName === "search"
      ? domainRouteForSearchPath(requestedSearchPath)
      : null;
    return {
      sessionId,
      keyword: requireOption("--keyword"),
      searchPath: domainRoute ? domainRoute.searchPath : requestedSearchPath,
      isStartMatch: flag("--start-match"),
      isUseLikeSearchPath: flag("--like-search-path"),
      searchType: commandName === "search-script" ? "SearchScript" : option("--search-type", "SearchName"),
      matchMode: option("--match-mode", "Like"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
      limit: numberOption("--limit", config.defaults.searchLimit),
    };
  }
  if (commandName === "read") {
    const characterWindow = readCharacterWindow("--max-chars", config.defaults.maxReadChars);
    return {
      sessionId,
      pvfPath: requireOption("--path"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      decompileScript: !flag("--no-decompile-script"),
      decompileBinaryAni: !flag("--no-decompile-ani"),
      autoConvertStringLink: flag("--string-link") && !rawDisplayMode(),
      useCompatibleDecompiler: !flag("--no-compatible-decompiler"),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
      // A change-set is matched and patched against the independent TypeScript
      // decompiler's canonical token layout.  Raw display must expose that exact
      // layout; otherwise an Agent can copy visually equivalent native output
      // whose tabs/newlines can never match the controlled-write source text.
      semanticVerificationRead: rawDisplayMode(),
      startLine: numberOption("--start-line"),
      endLine: numberOption("--end-line"),
      startChar: characterWindow.startChar,
      maxChars: characterWindow.maxChars,
    };
  }
  if (commandName === "read-batch") {
    const pvfPaths = options("--path");
    if (!pvfPaths.length) throw new Error("read-batch requires at least one --path.");
    const characterWindow = readCharacterWindow("--max-chars-per-file", config.defaults.maxReadChars);
    return {
      sessionId,
      pvfPaths,
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      decompileScript: !flag("--no-decompile-script"),
      decompileBinaryAni: !flag("--no-decompile-ani"),
      autoConvertStringLink: flag("--string-link") && !rawDisplayMode(),
      useCompatibleDecompiler: !flag("--no-compatible-decompiler"),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
      semanticVerificationRead: rawDisplayMode(),
      startLine: numberOption("--start-line"),
      endLine: numberOption("--end-line"),
      startChar: characterWindow.startChar,
      maxCharsPerFile: characterWindow.maxChars,
      maxTotalChars: numberOption("--max-total-chars", 300000),
    };
  }
  if (commandName === "resolve-lst") {
    return {
      sessionId,
      lstPath: normalizedRegistryPath(requireOption("--lst")),
      id: numberOption("--id"),
      includeFileSummary: !flag("--no-summary"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
    };
  }
  if (commandName === "resolve-path") {
    const registryPaths = options("--registry").map(normalizedRegistryPath);
    const query = registryQueryPath(requireOption("--path"), registryPaths);
    return {
      sessionId,
      pvfPath: query.pvfPath,
      registryPaths: registryPaths.length ? registryPaths : undefined,
      includeSecondary: flag("--include-secondary"),
      includeErrors: flag("--include-errors"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
    };
  }
  throw new Error(`Unsupported command: ${commandName}`);
}

async function callAndParse(client, name, toolArgs) {
  const result = await client.callTool(name, toolArgs);
  if (result && result.isError) {
    const parsed = parseBackendTextResult(result);
    throw new Error(parsed.error || parsed.text || JSON.stringify(parsed));
  }
  return parseBackendTextResult(result);
}

async function withOpenSession(config, client, action) {
  const resolved = resolveSourcePvf(workbenchRoot, option("--profile"), option("--pvf"));
  const pvfPath = resolved.sourcePvf;
  if (!fs.existsSync(pvfPath)) {
    throw new Error(`PVF file does not exist: ${pvfPath}`);
  }
  const opened = await callAndParse(client, "pvf_open", {
    path: pvfPath,
    encoding: option("--encoding", resolved.profile?.pvfEncoding?.open || config.defaults.pvfOpenEncoding),
  });
  const sessionId = opened.session?.sessionId;
  if (!sessionId) {
    throw new Error("pvf_open did not return a sessionId.");
  }
  try {
    return await action(sessionId, opened);
  } finally {
    try {
      await callAndParse(client, "pvf_close", { sessionId });
    } catch {
      // The CLI is best-effort about close because the process exits immediately after.
    }
  }
}

async function resolveSkillRoute(client, config, sessionId) {
  const jobSelector = option("--job", "");
  const characterIdRaw = option("--character-id");
  const hasJobSelector = Boolean(jobSelector);
  const hasCharacterId = characterIdRaw !== undefined;
  if (Number(hasJobSelector) + Number(hasCharacterId) !== 1) {
    throw new Error("resolve-skill requires exactly one branch selector: --job or --character-id.");
  }
  const skillId = numberOption("--id");
  if (!Number.isSafeInteger(skillId) || skillId < 0) {
    throw new Error("--id must be a non-negative safe integer.");
  }
  const commonReadArgs = {
    sessionId,
    pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
    convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
  };

  const characterRegistryFile = await callAndParse(client, "pvf_read_file", {
    ...commonReadArgs,
    pvfPath: "character/character.lst",
    decompileScript: true,
    useCompatibleDecompiler: true,
    maxChars: 50000,
  });
  const characterEntries = parseLstEntries(characterRegistryFile.textContent, "character/character.lst");
  if (!characterEntries.length) {
    throw new Error("character/character.lst did not contain any parseable registry entries.");
  }

  const characterReads = await callAndParse(client, "pvf_read_files", {
    ...commonReadArgs,
    pvfPaths: characterEntries.map((entry) => entry.pvfPath),
    decompileScript: true,
    useCompatibleDecompiler: true,
    maxCharsPerFile: 2500,
    maxTotalChars: Math.max(30000, characterEntries.length * 2500),
  });
  const readByPath = new Map(
    (characterReads.items || [])
      .filter((item) => item && item.ok !== false)
      .map((item) => [normalizePvfPath(item.pvfPath).toLowerCase(), item]),
  );
  const profiles = characterEntries.map((entry) => {
    const read = readByPath.get(entry.pvfPath.toLowerCase());
    const jobToken = extractJobToken(read?.textContent);
    const fileStem = path.posix.basename(entry.pvfPath, path.posix.extname(entry.pvfPath));
    return { entry, read, jobToken, fileStem };
  });

  let selectedProfiles;
  let matchBasis;
  if (hasCharacterId) {
    const characterId = Number(characterIdRaw);
    if (!Number.isSafeInteger(characterId) || characterId < 0) {
      throw new Error("--character-id must be a non-negative safe integer.");
    }
    selectedProfiles = profiles.filter((profile) => profile.entry.id === characterId);
    matchBasis = "character-id";
  } else {
    const normalizedSelector = normalizeJobSelector(jobSelector);
    const tokenMatches = profiles.filter((profile) => normalizeJobSelector(profile.jobToken) === normalizedSelector);
    const pathMatches = profiles.filter((profile) => normalizeJobSelector(profile.fileStem) === normalizedSelector);
    const displayMatches = profiles.filter((profile) => normalizedTextContains(profile.read?.textContent, jobSelector));
    selectedProfiles = tokenMatches.length ? tokenMatches : pathMatches.length ? pathMatches : displayMatches;
    matchBasis = tokenMatches.length ? "chr-job-token" : pathMatches.length ? "character-path" : "chr-display-text";
  }

  if (selectedProfiles.length === 0) {
    throw new Error(
      `No target character branch matched ${hasJobSelector ? `--job ${jobSelector}` : `--character-id ${characterIdRaw}`}. ` +
      `Available target job tokens: ${profiles.map((profile) => profile.jobToken || `id:${profile.entry.id}`).join(", ")}`,
    );
  }
  if (selectedProfiles.length > 1) {
    throw new Error(
      `Character branch selector is ambiguous: ${selectedProfiles.map((profile) => `${profile.entry.id}:${profile.jobToken || profile.entry.pvfPath}`).join(", ")}. ` +
      "Use the exact target .chr [job] token or --character-id.",
    );
  }

  const selected = selectedProfiles[0];
  const characterEvidence = await callAndParse(client, "pvf_resolve_lst_id", {
    ...commonReadArgs,
    lstPath: "character/character.lst",
    id: selected.entry.id,
    includeFileSummary: false,
  });
  const skillListEvidence = await callAndParse(client, "pvf_resolve_lst_id", {
    ...commonReadArgs,
    lstPath: "skill/skilllist.lst",
    id: selected.entry.id,
    includeFileSummary: false,
  });
  if (!skillListEvidence.found || !skillListEvidence.entry?.pvfPath) {
    throw new Error(`skill/skilllist.lst has no entry for target character ID ${selected.entry.id}.`);
  }
  const skillRegistryPath = normalizePvfPath(skillListEvidence.entry.pvfPath);
  const skillEvidence = await callAndParse(client, "pvf_resolve_lst_id", {
    ...commonReadArgs,
    lstPath: skillRegistryPath,
    id: skillId,
    includeFileSummary: true,
  });

  return {
    ok: true,
    sessionId,
    found: Boolean(skillEvidence.found),
    selector: {
      requestedJob: hasJobSelector ? jobSelector : null,
      requestedCharacterId: hasCharacterId ? Number(characterIdRaw) : null,
      skillId,
      matchBasis,
    },
    route: {
      characterRegistry: characterEvidence.registry,
      character: {
        id: selected.entry.id,
        entry: characterEvidence.entry,
        jobToken: selected.jobToken,
        readback: selected.read
          ? {
              pvfPath: selected.entry.pvfPath,
              dataLength: selected.read.metadata?.dataLength,
              semanticReadGuard: selected.read.semanticReadGuard,
            }
          : null,
      },
      skillListRegistry: skillListEvidence.registry,
      skillListEntry: skillListEvidence.entry,
      skillRegistryPath,
    },
    skill: {
      id: skillId,
      registry: skillEvidence.registry,
      entry: skillEvidence.entry,
      fileSummary: skillEvidence.fileSummary,
    },
    recommendedReadback: skillEvidence.found
      ? { pvfPath: skillEvidence.entry.pvfPath, command: "pvf-read read", maxChars: 5000 }
      : null,
    agentHandoff: {
      targetSkillRouteClosed: Boolean(skillEvidence.found),
      nextCommandOnly: skillEvidence.found ? "workbench.bat pvf-read read --path <resolved .skl path> --max-chars 5000" : null,
      additionalDiscoveryRequired: false,
      helpProbeRequired: false,
      prohibitedFollowUp: ["list-files path guessing", "bookmark lookup", "generic search", "cross-registry ID guessing"],
    },
    boundaries: {
      skillIdIsGlobal: false,
      targetRegistryAndCharacterReadbackRequired: true,
      staticSkillFileProvesRuntimeLearnabilityOrCooldown: false,
    },
  };
}

async function main() {
  const config = loadAdapterConfig(workbenchRoot);
  assertReadOnlyAdapter(config);

  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }

  validateCommandArguments(command);

  if (command === "evidence-self-test") {
    const result = await require("../scripts/pvf-evidence-self-test").runSelfTest(workbenchRoot);
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "scope-self-test") {
    const result = await require("../scripts/pvf-scope-self-test").runSelfTest(workbenchRoot);
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "equipment-eligibility-self-test") {
    const result = await require("../scripts/pvf-equipment-eligibility-self-test").runSelfTest(workbenchRoot);
    output(result); if (!result.ok) process.exitCode = 1; return;
  }

  if (command === "equipment-eligibility-audit") {
    const result = await require("../lib/pvf-equipment-eligibility").auditEquipment(workbenchRoot, path.resolve(requireOption("--pvf")), requireOption("--out"), fingerprintPvf);
    output({ ok: result.ok, command, reportPath: result.reportPath, reportSha256: result.reportSha256, records: result.records,
      sourcePvfSha256: result.source.sourcePvfSha256, observationComplete: result.observationComplete, summary: result.summary,
      equipmentTypeGroups: result.equipmentTypeGroups, usableJobGroups: result.usableJobGroups,
      issueGroups: result.issueGroups, agentHandoff: { semanticContractReady: false, authorizesPvfGeneration: false,
        instruction: "Preserve every unresolved field and exact job token. Equipment type trailing numbers are not proven slots. Directory names and all-job markers cannot assign gas pools or prove runtime wearability. Never reuse historical pool or parameter answers." } });
    if (!result.ok) process.exitCode = 1; return;
  }

  if (command === "skill-learning-self-test") {
    const result = await require("../scripts/pvf-skill-learning-self-test").runSelfTest(workbenchRoot);
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "skill-learning-audit") {
    const source = path.resolve(requireOption("--pvf"));
    const result = await require("../lib/pvf-skill-learning").auditLearning(source, fingerprintPvf);
    const report = require("../lib/pvf-scope-audit").writeScopeReport(workbenchRoot, [source], requireOption("--out"), result);
    output({ ok: result.ok, command, ...report, sourcePvfSha256: result.source.sourcePvfSha256,
      observationComplete: result.observationComplete, summary: result.summary, issues: result.issues.slice(0, 50), issuesTruncated: result.issues.length > 50,
      agentHandoff: { semanticContractReady: false, authorizesPvfGeneration: false,
        instruction: "Read the retained unresolved fields and references. Lexical growth markers are not runtime growtype IDs; table capacity and declared maximum are not playable maxima. Do not reuse historical skill, parameter or pool answers." } });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "skill-identity-self-test") {
    const result = await require("../scripts/pvf-skill-identity-self-test").runSelfTest(workbenchRoot);
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "skill-identity-audit" || command === "skill-identity-check") {
    const { auditSkillIdentity, checkIdentityClaims } = require("../lib/pvf-skill-identity");
    const { writeScopeReport } = require("../lib/pvf-scope-audit");
    const sourcePvf = path.resolve(requireOption("--pvf"));
    let claims;
    if (command === "skill-identity-check") {
      const file = requireOption("--claims"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Identity claims must be a bounded regular JSON file.");
      claims = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    const graph = await auditSkillIdentity(sourcePvf, fingerprintPvf);
    const result = claims ? checkIdentityClaims(graph, claims) : graph;
    const report = writeScopeReport(workbenchRoot, [sourcePvf], requireOption("--out"), result);
    output({ ok: result.ok, command, ...report, sourcePvfSha256: graph.source.sourcePvfSha256,
      summary: result.summary, graphSummary: graph.summary,
      ...(claims ? { issues: result.issues, results: result.results } : { branches: graph.branches.map((b) => ({ characterId: b.characterId,
        jobToken: b.jobToken, characterPath: b.characterPath, skillRegistry: b.skillRegistry,
        complete: b.complete, registeredSkillCount: b.registeredSkillCount, error: b.error })), issues: graph.issues.slice(0, 50), issuesTruncated: graph.issues.length > 50 }),
      agentHandoff: { authorizesPvfGeneration: false, playableBranchValidation: "not-run", growTypeValidation: "not-run",
        learnabilityValidation: "not-run", equipmentSlotValidation: "not-run", parameterSemanticsValidation: "not-run",
        instruction: "Fresh registry identity is not proof of playable class, learnability, equipment slot or parameter meaning. Never reuse historical candidate, value or pool answers." } });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "scope-audit" || command === "scope-compare" || command === "package-compare") {
    const { runScopeAudit, writeScopeReport } = require("../lib/pvf-scope-audit");
    const sourcePvf = path.resolve(requireOption("--pvf"));
    const candidatePvf = command !== "scope-audit" ? path.resolve(requireOption("--candidate-pvf")) : undefined;
    const reportFile = requireOption("--out");
    const result = await runScopeAudit({ sourcePvf, candidatePvf, pvfPath: requireOption("--path"),
      section: requireOption("--section"), fingerprint: fingerprintPvf, wholePackage: command === "package-compare" });
    const report = writeScopeReport(workbenchRoot, candidatePvf ? [sourcePvf, candidatePvf] : [sourcePvf], reportFile, result);
    output({ ok: result.ok, command, result, ...report, agentHandoff: {
      authorizesPvfGeneration: false, fullPackageCoverage: result.fullPackageCoverage, domainSemanticValidation: "not-run",
      instruction: command === "package-compare"
        ? "Full-package preservation does not prove the selected scope is semantically correct or complete. Domain meaning and gameplay still require separate evidence."
        : "This proves only the selected binary script boundary or outside-body preservation. Other files, domain meaning and gameplay still require separate evidence.",
    } });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "adapter-info") {
    output({ ok: true, adapter: adapterInfo(config) });
    return;
  }

  if (command === "profiles") {
    const profiles = loadWorkspaceProfiles(workbenchRoot);
    output({
      ok: true,
      activeProfile: profiles.activeProfile,
      profiles: profiles.profiles.map((profile) => ({
        name: profile.name,
        enabled: profile.enabled,
        sourcePvf: profile.sourcePvf,
        output: profile.output,
        profileSource: profile.profileSource,
      })),
    });
    return;
  }

  if (command === "fingerprint") {
    const items = fingerprintTargets().map(fingerprintPvf);
    output({
      ok: true,
      command,
      result: {
        requestedCount: items.length,
        completedCount: items.length,
        hashAlgorithm: "SHA256",
        fullFileHash: true,
        readOnly: true,
        items,
      },
      agentHandoff: {
        sourceIdentityComplete: true,
        oneCommandCoveredCount: items.length,
        repeatExactCommandAtFinalVerification: true,
        compareSourcePvfSha256Exactly: true,
        beforeAfterProofRequiresTwoMatchingCommandResults: true,
        baselineMustPrecedeFirstPvfChange: true,
        baselineTimingMustBeCheckedAgainstCommandOrder: true,
        firstFingerprintAfterAnyPvfChangeCannotProveStartingState: true,
        thisResultCannotRetroactivelyCreateAnEarlierBaseline: true,
        additionalHashCommandRequired: false,
        helpProbeRequired: false,
        adapterInfoProbeRequired: false,
        prohibitedFollowUp: ["Get-FileHash", "certutil", "pvf-read --help", "pvf-read adapter-info"],
      },
    });
    return;
  }

  const client = new BackendStdioClient(upstreamLaunchOptions(config));
  try {
    if (command === "export-evidence" || command === "verify-evidence") {
      if (!config.allowedToolsSet.has("pvf_read_file")) throw new Error("Canonical read tool is not allowed by the read-only adapter.");
      const sourcePvf = path.resolve(requireOption("--pvf"));
      // Bind identity before opening the backend session, not after it loaded
      // the container into memory.
      const beforeOpen = fingerprintPvf(sourcePvf);
      let firstFingerprint = true;
      const requestedEncoding = option("--pvf-encoding");
      if (requestedEncoding !== undefined && !["Cn", "Tw"].includes(requestedEncoding)) {
        throw new Error("Evidence text encoding must be Cn or Tw.");
      }
      const result = await withOpenSession(config, client, async (sessionId) => {
        const fingerprint = () => {
          if (firstFingerprint) { firstFingerprint = false; return beforeOpen; }
          return fingerprintPvf(sourcePvf);
        };
        const read = async (pvfPath, pinnedEncoding, maxChars) => {
          const encoding = pinnedEncoding || requestedEncoding;
          const readArgs = { sessionId, pvfPath, pvfEncoding: encoding || config.defaults.pvfReadEncoding,
            decompileScript: true, decompileBinaryAni: true, autoConvertStringLink: false,
            useCompatibleDecompiler: true, convertToSimplifiedChinese: false,
            semanticVerificationRead: true, startChar: 0, maxChars };
          if (encoding) {
            return { file: await callAndParse(client, "pvf_read_file", readArgs), selectedEncoding: encoding };
          }
          const candidate = await readOneRawAutoEncodingCandidate(client, sessionId, readArgs, pvfPath, readArgs.pvfEncoding);
          return { file: candidate.file, selectedEncoding: candidate.selection.selectedEncoding, encodingEvidence: candidate.selection };
        };
        const common = { workbenchRoot, sourcePvf, fingerprint, read };
        return command === "export-evidence"
          ? exportEvidence({ ...common, paths: options("--path"), outputDir: requireOption("--out"),
            purpose: requireOption("--purpose"), maxChars: numberOption("--max-chars-per-file", DEFAULT_MAX_CHARS) })
          : verifyEvidence({ ...common, manifestPath: requireOption("--manifest"), manifestSha256: requireOption("--manifest-sha256") });
      });
      const quoteArg = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
      output({ ok: true, command, result, agentHandoff: {
        ...(command === "export-evidence" ? { nextCommandOnly: `workbench.bat pvf-read verify-evidence --pvf ${quoteArg(sourcePvf)} --manifest ${quoteArg(result.manifestPath)} --manifest-sha256 ${result.manifestSha256}` } : {}),
        canonicalEvidenceComplete: true, semanticValidation: "not-run", authorizesPvfGeneration: false,
        boundaryOnly: result.purpose === "boundary-only",
        instruction: result.purpose === "boundary-only"
          ? "Use only for replacement boundaries and non-target preservation; never reuse historical profession, skill, parameter or pool answers."
          : "Evidence integrity does not establish registry identity, domain semantics, coverage or runtime behavior.",
      } });
      return;
    }
    if (command === "tools") {
      const tools = await client.listTools();
      output({
        ok: true,
        allowedTools: tools
          .filter((tool) => config.allowedToolsSet.has(tool.name))
          .map((tool) => ({ name: tool.name, description: tool.description })),
      });
      return;
    }

    if (command === "resolve-skill") {
      const result = await withOpenSession(config, client, async (sessionId) => resolveSkillRoute(client, config, sessionId));
      output({ ok: true, command, result });
      return;
    }

    const toolByCommand = {
      open: "pvf_session_info",
      "list-registries": "pvf_list_registries",
      "list-files": "pvf_list_files",
      "list-files-page": "pvf_list_files_page",
      search: "pvf_search",
      "search-batch": "pvf_search",
      "search-script": "pvf_search",
      read: "pvf_read_file",
      "read-batch": "pvf_read_files",
      "resolve-lst": "pvf_resolve_lst_id",
      "resolve-lst-batch": "pvf_resolve_lst_id",
      "resolve-path": "pvf_resolve_path",
      "resolve-path-batch": "pvf_resolve_path",
    };
    const toolName = toolByCommand[command];
    if (!toolName) {
      throw new Error(`Unsupported command: ${command}`);
    }
    if (!config.allowedToolsSet.has(toolName)) {
      throw new Error(`Tool is not allowed by read-only adapter: ${toolName}`);
    }
    if (command === "resolve-lst-batch") {
      batchIds();
      batchLstPath();
    }
    if (command === "resolve-path-batch") {
      batchPaths();
      batchRegistryPaths();
    }

    const result = await withOpenSession(config, client, async (sessionId, opened) => {
      if (command === "open") {
        const sessionInfo = await callAndParse(client, "pvf_session_info", { sessionId });
        return { opened, sessionInfo };
      }
      if (command === "search-batch") {
        return { result: await executeSearchBatch(client, config, sessionId), readPreparation: null };
      }
      if (command === "resolve-lst-batch") {
        return { result: await executeResolveLstBatch(client, config, sessionId), readPreparation: null };
      }
      if (command === "resolve-path-batch") {
        return { result: await executeResolvePathBatch(client, config, sessionId), readPreparation: null };
      }
      const commandArgs = toolArgsFor(command, config, sessionId);
      if (rawDisplayMode() && (command === "read" || command === "read-batch") && !option("--pvf-encoding")) {
        return readRawWithAutomaticEncoding(client, sessionId, commandArgs);
      }
      let primary = command === "search"
        ? await executeSearch(client, config, commandArgs, option("--pvf-encoding") !== undefined)
        : await callAndParse(client, toolName, commandArgs);
      if (command === "resolve-path") {
        const query = registryQueryPath(requireOption("--path"), commandArgs.registryPaths || []);
        primary = {
          ...primary,
          requestedPvfPath: query.requestedPvfPath,
          resolvedQueryPvfPath: query.pvfPath,
          registryRelativePathExpanded: query.registryRelativePathExpanded,
        };
      }
      if (
        command === "search" &&
        commandArgs.searchType === "SearchFileName" &&
        Number(primary.matchedCount || 0) === 0 &&
        commandArgs.keyword
      ) {
        const fallback = await callAndParse(client, "pvf_list_files", {
          sessionId,
          prefix: commandArgs.searchPath || undefined,
          contains: commandArgs.keyword,
          limit: commandArgs.limit,
        });
        return {
          ...fallback,
          fallbackFrom: "pvf_search",
          fallbackMode: "pvf_list_files_contains",
          upstreamSearch: primary,
        };
      }
      return { result: primary, readPreparation: null };
    });
    const commandResult = result?.result && Object.prototype.hasOwnProperty.call(result, "readPreparation")
      ? result.result
      : result;
    const readPreparation = result?.result && Object.prototype.hasOwnProperty.call(result, "readPreparation")
      ? result.readPreparation
      : null;
    const textUsage = readTextUsage(commandResult, config, readPreparation);
    const agentHandoff = command === "search-batch"
      ? searchBatchAgentHandoff(commandResult)
      : (command === "search" || command === "search-script"
        ? searchAgentHandoff(command, toolArgsFor(command, config, "handoff-only"), commandResult)
        : ((command === "read" || command === "read-batch")
          ? (rawDisplayMode() ? rawReadAgentHandoff(commandResult) : displayReadAgentHandoff(commandResult))
          : registryResolutionAgentHandoff(command, commandResult)));
    output({
      ok: true,
      command,
      ...(textUsage ? { textUsage } : {}),
      result: commandResult,
      ...(agentHandoff ? { agentHandoff } : {}),
    });
  } finally {
    client.stop();
  }
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
});
