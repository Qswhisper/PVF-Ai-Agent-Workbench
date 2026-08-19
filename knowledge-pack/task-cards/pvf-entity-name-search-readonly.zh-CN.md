# PVF 实体名称最短搜索路线

状态：默认可用

用途：用户给出任务、副本、装备、道具、NPC 等自然语言名称时，先按名称直接定位目标文件，避免把实体名误送到脚本正文搜索后反复全包扫描。

## 名称优先级

只要用户是在寻找一个自然语言实体，名称搜索就是第一条 Workbench 命令。即使用户同时提到地图号、层号、文件名片段，或 Agent 在推理中猜到了数字 ID，也不能先运行 `resolve-lst`、`resolve-lst-batch`、`resolve-path`、`list-files` 或 `search-script`。只有用户明确把数字 ID 或已登记路径作为选择器时，才直接走 Registry ID/路径路线；名称搜索之后得到的 ID 不能倒过来授权更早的直接解析。

## 第一条命令

使用 `pvf-read search`。它默认走 `SearchName`，对目标脚本的完整 `[name]` 字段做安全的字面包含搜索：任务名前后还有“[挑战]”“传奇 -”等文字、名称 token 内含换行，或用户与目标使用全角/半角括号、冒号等常见标点时，都不需要手工改写查询，更不需要自己拼正则。中文编码保护和简繁显示匹配由工作台自动处理。未显式填写 `--pvf-encoding` 时，中文名称会在同一 PVF 会话内只读检查 Cn/Tw，并在 `result.automaticEncodingSelection` 中公开两边命中数、选中的搜索编码或歧义。这个结果只帮助定位，不能替代写入前对目标路径的 `--raw` 编码确认。即使同一任务后面还要生成修改版，它也仍是第一条 shell 命令，不先运行 `check`。

如果用户同时要求源 PVF 保持不变、最后确认源文件没有变化或提供完整 SHA256 前后依据，名称搜索之后的下一条（第二条）工作台命令必须是一次覆盖全部已给 PVF 的 `pvf-read fingerprint`。它要早于任何 `pvf-change`，不能拖到 validate、预演或正式生成前才首次执行；建立一次基线后，只在全部成品读回完成后原样复查。

已知类别时立即加最窄 `--search-path`：

- 任务：`n_quest`
- 副本：`dungeon`
- 装备：`equipment`
- 消耗品、材料、礼包：`stackable`
- NPC：`npc`
- 怪物：`monster`
- APC：`aicharacter`
- 技能：`skill`
- 宠物：`creature`
- 城镇：`town`
- 世界地图：`worldmap`

较少见但已有 registry 路由的类别还包括 `region`、`map`、`itemshop`、`cashshop`、`character`、`appendage`、`passiveobject`、`pvp_mission`、`aura`、`pet`、`chatemoticon` 和 `stagemap`。`quest`、`material`、`apc`、`shop` 等常用别名会被转换成实际 PVF 前缀；返回的 `domainRoute` 会给出目标 registry 或技能专用解析路线。对有固定 registry 的领域，工作台还会在同一 PVF 会话里自动反查每个返回路径，并把 ID、registry 路径和登记行放入该命中的 `registryIdentity`。

示例：

```bat
.\workbench.bat pvf-read search --pvf "D:\Target\Script.pvf" --keyword "叹息之塔" --search-path dungeon --limit 20
```

## 多名称一次搜索

同一任务需要定位多个具体名称时，使用一次 `search-batch`，避免 Agent 为每个实体重新打开 PVF：

```bat
.\workbench.bat pvf-read search-batch --pvf "D:\Target\Script.pvf" --name "叹息之塔" --search-path dungeon --name "迷你宠物" --search-path creature --limit 20
```

一个 `--search-path` 可以供全部名称共用；否则其数量必须和 `--name` 完全相等并按顺序配对。数量不符会安全停止。整批仍逐项返回命中、Cn/Tw 选择、registry 路由和已确认的登记 ID，但只打开一次 PVF 会话。

每次工具调用只运行这一条裸命令。用户要求记录耗时时，使用宿主工具返回的耗时或粗略墙钟时间；不要在前后添加秒表、分号、输出命令或管道，否则安全权限会把复合命令拒绝并造成重复搜索。

## 命中后

1. 只读取返回的路径，不枚举同目录或猜英文文件名。
2. 先看 `registryResolution` 和每项 `registryIdentity`。若 `allReturnedPathsConfirmed=true`，登记 ID 已由目标 `.lst` 自动确认，不再运行 `resolve-path`；只有结果明确留下未确认路径时，才用返回的 registry 路由补查，多个路径用一次 `resolve-path-batch`。
3. 修改前仍对目标路径执行原始读回，并遵守受控生成流程。
4. 登记身份和返回的目标文件已经读回后，身份定位就结束。不要再逐项 `resolve-path`，也不要把登记路径、目录名或路径片段送入 `search-script` 做第二次确认；它们不会增加登记身份证据。只有用户明确要求观察某个精确正文符号或引用，而且 registry / dependency 证据无法回答时，才进入下节限定的正文观察。
5. 若宽泛名称的结果被截断，优先使用同一批里更具体的成功关键词。例如“阿尔伯特”很宽而“偷学”已精确命中时，只读“偷学”的结果；确实仍需宽泛项时，最多用用户原话中另一个具体短语缩小一次，不要把整批候选全部打开。

## 零命中

- 不证明实体不存在。
- 若 `automaticEncodingSelection.selectionMode` 是 `no-match-both-checked`，表示 Cn/Tw 已经自动检查；不要再人工切换编码。
- 先判断用户说的是实际名称，还是“最终副本（一）”这类任务分组、分类或描述。
- 对同一领域只允许把查询缩短一次到最小具体名称，例如从“叹息之塔的成就任务”缩成“叹息之塔”。
- 已经知道另一个实体时，从其 registry ID、目标文件引用或依赖关系继续，不切换到全包正文盲搜。
- 不轮流尝试简体、繁体、空格和标点变体；工作台会自动处理可安全统一的显示差异。

## `search-script` 的边界

`search-script` 只用于精确 NUT/API 符号，或用户确实要求且登记/依赖证据不能回答的窄范围脚本正文观察。它不是任务、副本、装备、道具或 NPC 名称的第一搜索入口，也不是登记行和目标文件读回后的二次确认工具。中文名称被误送到 `search-script` 且零命中时，应只执行返回的 `agentHandoff.nextCommandOnly` 名称搜索，不继续目录探测、帮助查询或简繁重扫。
