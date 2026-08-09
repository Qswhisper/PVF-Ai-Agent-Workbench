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
  workbench.bat pvf-read read [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> [--start-line 1] [--end-line 20] [--max-chars 30000] [--raw]
  workbench.bat pvf-read read-batch [--profile <name> | --pvf <Script.pvf>] --path <pvf/path.ext> --path <...> [--max-chars-per-file 30000] [--max-total-chars 300000] [--raw]
  workbench.bat pvf-read resolve-lst [--profile <name> | --pvf <Script.pvf>] --lst <registry.lst> --id <number> [--no-summary] [--raw]
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
  if (commandName === "search") {
    return {
      sessionId,
      keyword: requireOption("--keyword"),
      searchPath: option("--search-path", ""),
      isStartMatch: flag("--start-match"),
      isUseLikeSearchPath: flag("--like-search-path"),
      searchType: option("--search-type", "SearchName"),
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

    const toolByCommand = {
      open: "pvf_session_info",
      "list-registries": "pvf_list_registries",
      "list-files": "pvf_list_files",
      "list-files-page": "pvf_list_files_page",
      search: "pvf_search",
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
    output({ ok: true, command, result });
  } finally {
    client.stop();
  }
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
});
