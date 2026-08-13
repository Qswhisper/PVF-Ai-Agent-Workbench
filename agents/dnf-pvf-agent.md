# DNF PVF Agent Instructions

You are working inside a clean PVF-Agent-Workbench folder. This is a task workspace, not the development roadmap workspace.

## Default Workflow

1. Read `AGENTS.md`.
2. Read `README.zh-CN.md`.
3. Read `knowledge-pack/README.zh-CN.md`.
4. Read `knowledge-pack/safety/README.zh-CN.md`.
5. Read `knowledge-pack/indexes/knowledge-index.json`.
6. Use the bundled `workbench.bat` lane; it is the complete ordinary-task runtime.
7. Open only the routed task card, dictionary, workflow, or encyclopedia entry named by the knowledge index.
8. Inspect the target PVF with read-only commands before proposing edits.
9. For write tasks, produce a controlled-output plan before any apply.

## Beginner-Facing Answers

Assume the user does not code. Keep every safety check, but put the plain-language result first: can it proceed, what will change, what can go wrong, and what the user must do next. Say “预演（先检查；中文改动会用临时文件验证并立即清理）”, “生成独立 PVF”, “生成后复查”, and “普通脚本里的完整中文名称/描述（包括多行）可验证修改；批量需先核对准确数量；`.str` 和 StringLink 仍不能直接改” in the main answer. Put ASCII, non-ASCII, backend, binding, manifest, approval code, readback, SHA details, and exact commands under `技术详情（通常不用看）` unless the user explicitly asks for them.

## Capability Lane

Use `workbench.bat pvf-read`, `workbench.bat pvf-index`, and `workbench.bat pvf-change`. The Workbench carries both its preferred native backend and a dependency-free TypeScript read-only fallback, so ordinary inspection is self-contained. The bundled Node.js runtime executes the `.ts` sources directly without npm or a build step. If a session reports `readOnly: true`, continue only with reads and dry-runs that need no temporary write; block backup/apply/write until `workbench.bat check` confirms native is available. `verified-inline-text` dry-run also requires native for its isolated temporary-output proof and returns no approval code in fallback. Use bundled `knowledge-query nut`, `knowledge-query tag`, and `knowledge-query bookmark` for foundational knowledge.

After a successful controlled apply, `workbench.bat client-pvf` may install the verified independent output into the `Script.pvf` at a local profile's client root. This is a separate user authorization: preview first, bind the output and current client hashes, confirm the client and launcher are closed, back up the current client PVF, verify after deployment, and use a separately previewed rollback when requested. Source/output/client paths must be distinct. It does not authorize NPK, IMG, UI, or another client file.

When a task explicitly supplies a source/claim artifact, lineage, dependency report, or client matrix, use `workbench.bat knowledge-query` for narrow lookups. Preserve artifact SHA and evidence boundaries; zero matches are not proof of absence.

## Allowed By Default

- Check this folder with `workbench.bat check`.
- Read, list, search, and resolve `.lst` IDs in a user-provided PVF.
- Build local read-only indexes in the external Workbench runtime directory.
- Validate and dry-run change-sets.
- Summarize exact target files, IDs, risks, and remaining in-game tests.

## Not Allowed By Default

- Do not overwrite source PVF files.
- Do not modify client files.
- Do not copy API keys, real PVFs, clients, indexes, or reports into this folder.
- Do not use tutorial numbers or community notes as write authority without target-PVF verification.
- Do not read all evidence or candidate files by default.

## Write Requirements

PVF writes require explicit user authorization and must use the controlled-output path:

- Confirm the exact target PVF.
- Resolve relevant IDs through the correct `.lst`.
- Build exact replacement text from target raw no-simplified readback and make the smallest edit.
- For a complete visible inline Cn or Tw text token, including real multiline content, require `verified-inline-text`, the target-confirmed encoding, an isolated temporary-output round trip, preservation of all existing string-table entries, and exact independent TypeScript readback. When identical complete text repeats, exact adjacent `contextBefore`/`contextAfter` from the same raw target readback may select the intended occurrence; bind the selector and selected location and do not relax any text safety rule. Batch replacement requires an exact `expectedOccurrences`. Split parameter/structure and Chinese into separate same-path changes so the Workbench can verify one final file; apply all verified changes on that path in one string-table/script batch. Block obvious mojibake. Keep `.str`, StringLink display text, partial Chinese tokens, occurrence-index selection, uncounted bulk, unencodable characters, and other unverified non-ASCII writes blocked.
- Require a matching unblocked dry-run manifest for the same source PVF and same change-set, plus its approval code.
- Create or reuse a SHA256-verified content-addressed source backup; recheck the hash before reuse.
- Save to an explicit output PVF that is not the source.
- Reopen/read back the output.
- Produce a manifest and concise change summary.

Client resource writes require a separate explicit authorization and are outside normal PVF write permission. The controlled `client-pvf` lane covers only deployment and rollback of the profiled client-root `Script.pvf`; all other client resources remain outside it.
