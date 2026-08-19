# cli

PVF 命令行入口。

```bat
workbench.bat profile status
workbench.bat profile init --name main-local --workspace "D:\MyDNFWork" --source-pvf "D:\MyDNFWork\Script.pvf" --output "D:\MyDNFWork\pvf-lab" --set-active
workbench.bat pvf-read list-files --pvf "D:\MyDNFWork\Script.pvf" --prefix itemshop --limit 20
rem 自然语言实体名先走默认 SearchName；它会安全做字面包含、跨行名称和常见全角/半角标点匹配，已知类别就立即限制目录
workbench.bat pvf-read search --pvf "D:\MyDNFWork\Script.pvf" --keyword "叹息之塔" --search-path dungeon --limit 20
rem 多个实体一次提交；一个 --search-path 可共用，也可像下面这样与每个 --name 按顺序配对，整批只打开一次 PVF
workbench.bat pvf-read search-batch --pvf "D:\MyDNFWork\Script.pvf" --name "叹息之塔" --search-path dungeon --name "迷你宠物" --search-path creature --limit 20
rem search-script 只用于精确脚本符号或已缩小范围的正文观察
workbench.bat pvf-read search-script --pvf "D:\MyDNFWork\Script.pvf" --keyword sq_GetSkillLevel --search-path script --limit 50
workbench.bat pvf-read read --pvf "D:\MyDNFWork\Script.pvf" --path itemshop/itemshop.lst --max-chars 2000
rem 普通 read 是便于阅读的显示结果，不可复制为修改原文；准备 change-set 时对同一路径加 --raw，并采用返回的实际编码
workbench.bat pvf-read read --pvf "D:\MyDNFWork\Script.pvf" --path itemshop/test.shp --pvf-encoding Tw --raw --max-chars 30000
rem 用户要求完整 SHA256、源保持不变或最终确认源未变化时才运行；它紧跟任务规定的第一条命令且早于任何 pvf-change，多份 PVF 可重复 --pvf，最终原样重跑
workbench.bat pvf-read fingerprint --pvf "D:\MyDNFWork\Script.pvf" --pvf "D:\MyDNFWork\another\Script.pvf"
workbench.bat pvf-read resolve-lst --pvf "D:\MyDNFWork\Script.pvf" --lst itemshop/itemshop.lst --id 1
rem 同一登记表的多个 ID 一次解析；quest/dungeon 等领域名可直接作 registry 别名，按返回的 agentHandoff.nextCommandOnly 一次读回
workbench.bat pvf-read resolve-lst-batch --pvf "D:\MyDNFWork\Script.pvf" --lst quest --id 9707 --id 350
rem 只有尚未由名称搜索自动确认的多个路径才需要批量反查；不要把已确认路径再逐项 resolve
workbench.bat pvf-read resolve-path-batch --pvf "D:\MyDNFWork\Script.pvf" --registry quest --path n_quest/title/titlebook_70_despair1.8.qst --path n_quest/common/albert_condition_2.qst
workbench.bat pvf-index build --pvf "D:\MyDNFWork\Script.pvf" --scope itemshop --prefix itemshop --limit 1000
rem 同一路径的多项中文与参数改动放在同一个 changes 数组；validate 会返回机器可读的下一步和禁止绕路提示
workbench.bat pvf-change validate --file workspaces\examples\change-set.verified-cn-text.example.json
workbench.bat pvf-change dry-run --file "D:\MyDNFWork\changes\round-1.json" --pvf "D:\MyDNFWork\Script.pvf" --out "D:\MyDNFWork\pvf-lab\round-1-preview"
rem 从上一条 JSON 输出中复制 manifestPath 和 approvalCode；下面的 --out 是独立成品目录
workbench.bat pvf-change apply --file "D:\MyDNFWork\changes\round-1.json" --pvf "D:\MyDNFWork\Script.pvf" --dry-run-manifest "D:\MyDNFWork\pvf-lab\round-1-preview\DRY-RUN-MANIFEST.json" --authorize-apply <approvalCode> --out "D:\MyDNFWork\pvf-lab\round-1-output"
rem 生成后会自动重新检查；需要人工复核具体字段时，再对 APPLY-MANIFEST.json 返回的 outputPvf 执行 pvf-read read --raw
workbench.bat absorb new --id KV-XX --title "Runtime validation" --domain itemshop --status PASS
```

被阻止的预演会同时把命令输出和核验记录内部的 `approvalCode` 置空，并标记 `authorizationWithheld=true`；不要从绑定哈希推算或尝试正式生成。

`pvf-read fingerprint` 分块读取完整文件并返回 SHA256，只在要求完整哈希、源保持不变、最终确认源未变化或其他前后身份依据时使用；它可以一次处理最多 20 个不同 PVF，并在哈希期间文件大小或修改时间变化时停止。基线必须是任务规定第一条工作台命令之后的下一条命令，并早于任何 `pvf-change`；不能在 validate 或预演之后首次补做。全部成品读回后原样再运行一次并逐项比较。普通搜索和读取不会默认增加整份大 PVF 的哈希负担；不要查询帮助、adapter-info 或调用通用 shell 哈希工具。

未阻止的预演会返回 `agentHandoff.nextCommandOnly`，其中已经填好变更集、预演记录和许可，只留下一个外部成品目录占位符。只替换这个占位符；不要再运行 `pvf-change --help`、扫描预演目录、打开 schema 或 grep 文档来重新猜 apply 语法。被阻止时该字段为 `null`。

名称搜索目录映射：任务 `n_quest`，副本 `dungeon`，装备 `equipment`，消耗品/材料 `stackable`，NPC `npc`，怪物 `monster`，APC `aicharacter`，技能 `skill`，宠物 `creature`，城镇 `town`，世界地图 `worldmap`；还支持 `region`、`map`、`itemshop`、`cashshop`、`character`、`appendage`、`passiveobject`、`pvp_mission`、`aura` 等 registry-aware 路由。常用别名 `quest`、`material`、`apc`、`shop` 会自动转为实际 PVF 前缀。默认 `SearchName + Like` 由适配层安全转义为字面包含搜索，覆盖名称前后缀、跨行 token 及常见全角/半角标点，不把用户文字直接当正则。未显式给 `--pvf-encoding` 的中文名称还会在同一会话内只读检查 Cn/Tw，并在 `automaticEncodingSelection` 中公开候选命中数和选择；这个搜索结果不能替代写入前的 `--raw` 编码确认。固定 registry 领域的返回项会在同一会话中自动附带 `registryIdentity`；`allReturnedPathsConfirmed=true` 时直接读回，不再运行 `resolve-path` 或搜索路径片段。宽泛结果被截断时优先用同批更具体的词，确需缩小时只用用户原话再缩小一次，不逐条打开整批。零命中仍不证明不存在；先区分分类描述和实际名称。不要改用 `search-script` 重扫简体、繁体或标点变体。

只要任务是按自然语言寻找实体，即使同时出现地图号、层号或猜测 ID，也必须先用 `SearchName`；只有用户明确给出数字 ID/登记路径作为选择器时才可先 `resolve-lst`/`resolve-path`。

纯数字/英文的完整原始 token 参数路线已覆盖 `.cre`、`.npc`、`.msn`、`.wdm`、`.twn`、`.rgn` 和 `.mm`。既有 `.co`、`.lst`、NUT、`.sqr`、`.str` 仍受保护；新增这些高风险文件只能提交匹配的 `writeProof`，通过格式/登记冲突、脚本结构、临时写出或编码往返和独立读回。新增 `.wdm` 还必须把 worldmap registry、UI、dungeon、town/region 入口作为一个原子闭合组审阅。这不替代客户端资源或实机验证。

直接给出 `--pvf` 时不需要先检查或创建 profile。本机 profile 写入工作台外的 `PVF-Agent-Workbench-State/profiles/<workbench-id>/`。

下一轮只写本轮差异时，change-set 保持 `target.sourcePvf` 为最初受保护源，并增加：

```json
"baseline": {
  "applyManifest": "D:\\pvf-lab\\previous\\APPLY-MANIFEST.json"
}
```

然后仍执行上面的 `dry-run` 与 `apply`。预演时优先按 `validate.agentHandoff.nextCommandOnly` 原样执行，不要自行补一个指向最初源的 `--pvf`。可以省略第二轮命令中的 `--pvf`；若显式填写，它必须是上一轮 `APPLY-MANIFEST.json` 记录的 `outputPvf`，不能再填最初源 PVF。
完整第二轮格式见 `workspaces\examples\change-set.cumulative-second-round.example.json`。不要把上一轮输出直接写成新的 `target.sourcePvf`，也不要把同一文件的多项改动拆成多个临时“新源”。

同文件若必须先把完整中文清空、再删除其所在结构，请把安全文字变化写在前、只含数字/英文/常见符号的结构删除写在后。工作台会保留这条依赖顺序，同时仍把该文件的全部安全文字合为一批验证。可直接参考 `workspaces\examples\change-set.verified-cn-text.example.json` 末尾的三步删除链，不需要阅读执行器或自测源码来猜格式。

若多个部位的正文和相邻上下文完全相同，让该部位的每条文字、删除和重编号变化共用 `scope.startText`、`scope.endText`、`scope.expectedRanges`。三个值必须逐字来自同一次 `--raw` 读回；范围只负责缩小匹配，边界不能改写。完整格式见 `workspaces\examples\change-set.exact-scope.example.json`。`validate` 会拒绝 `scopePart` 等未知字段，避免字段看似通过却在执行时被忽略。

普通 `read`/`read-batch` 返回 `textUsage.safeForChangeSetSource=false`，因为中文可能已转成简体，换行与 Tab 也可能只是阅读布局。`--raw` 才返回修改校验使用的规范 token；未显式填写 `--pvf-encoding` 时，工作台会只读比较 Cn/Tw 并选择明显更干净的一种，在 `textUsage.automaticEncodingSelection` 中公开结果。若两种都不明显更好则保持声明/默认编码，不猜字、不混合写入。若预演零命中同时返回 `DISPLAY_TEXT_USED_AS_CHANGE_SOURCE` 或 `CHANGE_TEXT_ENCODING_MISMATCH`，按其中的路径和编码重新 `--raw` 读取并重建 change-set；工作台不会自动改繁简或跨编码写入。
