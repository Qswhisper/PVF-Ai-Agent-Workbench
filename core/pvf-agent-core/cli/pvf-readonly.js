"use strict";

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

const rawArgs = process.argv.slice(2);
const workbenchRoot = resolveWorkbenchRoot(rawArgs, path.resolve(__dirname, "../../.."));
const args = rawArgs.filter((item, index) => !(item === "--root" || rawArgs[index - 1] === "--root"));
const command = args[0];

function usage() {
  return `Usage:
  workbench.bat pvf-read adapter-info
  workbench.bat pvf-read profiles
  workbench.bat pvf-read tools
  workbench.bat pvf-read open [--profile <name> | --pvf <Script.pvf>] [--encoding Tw]
  workbench.bat pvf-read list-registries [--profile <name> | --pvf <Script.pvf>] [--include-counts] [--raw]
  workbench.bat pvf-read list-files [--profile <name> | --pvf <Script.pvf>] [--prefix itemshop] [--contains shp] [--limit 20]
  workbench.bat pvf-read list-files-page [--profile <name> | --pvf <Script.pvf>] [--prefix itemshop] [--contains shp] [--offset 0] [--limit 2000]
  workbench.bat pvf-read search [--profile <name> | --pvf <Script.pvf>] --keyword <text> [--search-type SearchFileName] [--search-path itemshop] [--pvf-encoding Cn] [--limit 20] [--raw]
  workbench.bat pvf-read search-script [--profile <name> | --pvf <Script.pvf>] --keyword <symbol> [--search-path script] [--limit 50] [--raw]
  workbench.bat pvf-read read [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> [--start-line 1] [--end-line 20] [--max-chars 30000] [--raw]
  workbench.bat pvf-read read-batch [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> --path <...> [--max-chars-per-file 30000] [--max-total-chars 300000] [--raw]
  workbench.bat pvf-read resolve-lst [--profile <name> | --pvf <Script.pvf>] --lst <registry.lst> --id <number> [--no-summary] [--raw]
  workbench.bat pvf-read resolve-skill [--profile <name> | --pvf <Script.pvf>] (--job <job-token> | --character-id <number>) --id <skill-id> [--raw]
  workbench.bat pvf-read resolve-path [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> [--registry <registry.lst>]... [--include-secondary] [--include-errors] [--raw]

Raw text:
  --raw is the write-preparation display mode. It disables simplified-Chinese
  conversion and StringLink auto-conversion. --no-simplified remains supported.
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

function normalizePvfPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
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
    return {
      sessionId,
      keyword: requireOption("--keyword"),
      searchPath: option("--search-path", ""),
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
    return {
      sessionId,
      pvfPath: requireOption("--path"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      decompileScript: !flag("--no-decompile-script"),
      decompileBinaryAni: !flag("--no-decompile-ani"),
      autoConvertStringLink: flag("--string-link") && !rawDisplayMode(),
      useCompatibleDecompiler: !flag("--no-compatible-decompiler"),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
      startLine: numberOption("--start-line"),
      endLine: numberOption("--end-line"),
      maxChars: numberOption("--max-chars", config.defaults.maxReadChars),
    };
  }
  if (commandName === "read-batch") {
    const pvfPaths = options("--path");
    if (!pvfPaths.length) throw new Error("read-batch requires at least one --path.");
    return {
      sessionId,
      pvfPaths,
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      decompileScript: !flag("--no-decompile-script"),
      decompileBinaryAni: !flag("--no-decompile-ani"),
      autoConvertStringLink: flag("--string-link") && !rawDisplayMode(),
      useCompatibleDecompiler: !flag("--no-compatible-decompiler"),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
      startLine: numberOption("--start-line"),
      endLine: numberOption("--end-line"),
      maxCharsPerFile: numberOption("--max-chars-per-file", config.defaults.maxReadChars),
      maxTotalChars: numberOption("--max-total-chars", 300000),
    };
  }
  if (commandName === "resolve-lst") {
    return {
      sessionId,
      lstPath: requireOption("--lst"),
      id: numberOption("--id"),
      includeFileSummary: !flag("--no-summary"),
      pvfEncoding: option("--pvf-encoding", config.defaults.pvfReadEncoding),
      convertToSimplifiedChinese: !(flag("--no-simplified") || rawDisplayMode()),
    };
  }
  if (commandName === "resolve-path") {
    const registryPaths = options("--registry");
    return {
      sessionId,
      pvfPath: requireOption("--path"),
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

  const client = new BackendStdioClient(upstreamLaunchOptions(config));
  try {
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
      "search-script": "pvf_search",
      read: "pvf_read_file",
      "read-batch": "pvf_read_files",
      "resolve-lst": "pvf_resolve_lst_id",
      "resolve-path": "pvf_resolve_path",
    };
    const toolName = toolByCommand[command];
    if (!toolName) {
      throw new Error(`Unsupported command: ${command}`);
    }
    if (!config.allowedToolsSet.has(toolName)) {
      throw new Error(`Tool is not allowed by read-only adapter: ${toolName}`);
    }

  const result = await withOpenSession(config, client, async (sessionId, opened) => {
      if (command === "open") {
        const sessionInfo = await callAndParse(client, "pvf_session_info", { sessionId });
        return { opened, sessionInfo };
      }
      const commandArgs = toolArgsFor(command, config, sessionId);
      const primary = await callAndParse(client, toolName, commandArgs);
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
      return primary;
    });
    output({
      ok: true,
      command,
      result,
      ...(command === "search-script"
        ? {
            agentHandoff: {
              exactScriptSearchComplete: true,
              additionalGenericSearchRequired: false,
              helpProbeRequired: false,
              zeroMatchesProveRuntimeAbsence: false,
              prohibitedFollowUp: ["Test-Path", "Get-Item", "help probe", "generic filename guessing"],
            },
          }
        : {}),
    });
  } finally {
    client.stop();
  }
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
});
