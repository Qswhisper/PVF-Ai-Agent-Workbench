# Quest / Drop / Reward / Ticket 受控修改流程

状态：默认可用

默认动作仍是只读。本流程只在用户明确要求修改实验 PVF 时使用；正式源 PVF 和客户端不得直接写。

所有写出都必须确认记录中的源/输出/客户端路径没有乱码。触达中文或 StringLink 文件时，读回之后还需要客户端 UI 文本 smoke check，不能只凭 PVF 读回判断安全。

## 新增块 / 新增任务的通用门禁

1. 新增标签块或完整 `.qst` / `.stk` 文件前，先在目标 PVF 同目录、同扩展名、同用途样本中找最近邻对照。
2. 最近邻对照重点看块位置、是否有闭合标签、列数、tab、空列和配套字段；默认窄范围抽样，不做无必要全库扫描。
3. 复制目标 PVF 中可运行样本的结构，再最小替换 ID、数量、概率或文本；不要凭字段名自行补闭合标签或列。
4. 新增任务如果实机出现同名重复，检查是否同时被 `.qst` 自动扫描和 `quest.lst` 注册加载；同一任务不要无确认地走两条加载路径。

## 改任务奖励

1. 建立实验 PVF，并保留源 PVF 不变。
2. 用 `n_quest/quest.lst` 解析任务 ID 到 `.qst`。
3. 读取 `[reward type]`，确认要改的是固定奖励 `[reward int data]` 还是可选奖励 `[reward selection int data]`。
4. 新奖励 ID 必须先按 `stackable/stackable.lst` 或 `equipment/equipment.lst` 闭合。
5. 只改对应块内最小列，不改无关任务文本、NPC、等级或前置。
6. 保存实验 PVF 后回读同一 `.qst`，确认块闭合和列形未破坏。

## 隐藏或恢复任务显示

1. 先确认任务仍由 `n_quest/quest.lst` 登记，并读回目标 `.qst`；“保留任务但隐藏”和“移除任务身份”是两种不同需求。
2. 同时读取 `[npc index]`、`[complete npc index]`、`[exposed by npc]`、`[first exposed by npc]`、grade/event 和前置任务。不要把任一字段裸值当作完整显隐开关。
3. `[npc index] -1` 只改变该字段的边界语义，不删除登记，也不能保证列表隐藏。历史目标实机曾出现改为 `-1` 后任务仍暴露到非预期 NPC 的失败形态。
4. 从当前目标同 grade、同任务生命周期的正样本复制最小可见性字段组合；不要把另一个版本的 `0/1` 组合直接套入。
5. 回读后必须实机检查：新角色/未完成前置、前置完成后、原接取 NPC、完成 NPC、非预期 NPC、重登和换频道/换角色。只测一个 NPC 页面不能判定隐藏完成。

## 改任务收集物或掉任务物

1. 先确认 `[type]` / `[sub type]`，再解释 `[int data]`。
2. 如果涉及 `[monster reward item]`，先找目标 PVF 中同地区、同 grade、同 type/subtype 或同循环收集用途的任务样本，对照列形和 tab。
3. `[monster reward item]` 只在该任务上下文中解释怪物、任务物和数量/概率列，不和普通 `.mob` 掉落或独立掉落混写。
4. 任务物 ID 必须闭合到 `stackable`，并优先使用 `[stackable type] [quest]` 或同类任务物结构；普通 `[material]` 类型作为任务怪物奖励物有崩溃风险样本，不能默认使用。
5. `[int data]` 收集目标要和 `[monster reward item]` 的任务物 ID、数量口径一致；不要把同号任务 ID、怪物 ID 或材料 ID 混用。
6. 回读任务文件，确认 `[monster reward item]`、`[int data]` 与奖励块各自闭合。

## 改门票或入场等级

1. 用 `dungeon/dungeon.lst` 定位目标 `dungeon/*.dgn`。
2. 修改 `[required item]` 前先解析门票/材料 ID，确认是目标上下文可用的 `stackable`。
3. 修改 `[minimum required level]` 只代表静态最低等级，不代表服务端最终放行规则。
5. 回读 `.dgn`，确认地图、maze、boss map 等无关块未被改动。

## 改独立掉落或清算翻牌

1. 独立掉落先从 `etc/independentdrop.lst` 找到目标表，再改 `[list]`。
2. 清算翻牌只改 `etc/itemdropinfo_clearreward.etc` 中明确目标块，不把它和任务奖励或 NPC 商店混写。
3. 候选 ID 必须逐个按正确 registry 解析。
5. `[basis level]` 可影响怪物强度和付费翻牌费用选行，不应作为单纯清算费用字段使用。
6. 静态权重修改后仍需实机或服务端环境验证，不能在 Workbench 写成真实概率。

## 必测

- 回读改动文件，确认目标块闭合。
- 运行知识包和工作区健康检查。
- 实机测试要单列：接取任务、完成条件、奖励领取、背包空间、门票扣除、副本入场、掉落/翻牌展示、服务端日志。

## 禁止

- 不覆盖源 PVF。
- 不把源 PVF、客户端、缓存、运行产物放进 Workbench。
- 不用教程、社区注释或 GM 工具字段直接写结论。
- 不把静态配置写成实机成功、扣费成功、UI 正常或服务端放行。
