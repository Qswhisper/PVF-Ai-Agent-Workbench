# Quest / Drop / Reward / Ticket Boundary

状态：默认可用


重要边界：本文不是全量任务类型矩阵。`[type]`、`[sub type]`、`[int data]` 只整理“必须合读、不能裸猜”的路由原则和少量代表样本；计数、破招、连击、限时、评分、特定动作等任务条件类型仍需单独建立 `Quest Type / Condition Int Data Matrix`。

## 默认读法

1. `safety/README.zh-CN.md`
2. `dictionaries/quest-drop-reward-ticket-fields.zh-CN.md`
3. `task-cards/quest-drop-reward-ticket-readonly-audit.zh-CN.md`
4. 本矩阵
5. 需要闭合售卖物或奖励物时，再读 `encyclopedia/pvf-file-types/equipment-stackable.zh-CN.md`


| 桶 | 目标核验 | 边界 |
| --- | --- | --- |
| 任务 registry | 需在当前目标 PVF 中只读确认 | 任务事实以 `quest.lst` 注册为入口，不能只靠目录文件存在。 |
| 任务基础字段 | 需在当前目标 PVF 中只读确认 | 当前只整理字段存在和合读原则；尚未整理全量任务类型枚举与每类 `[int data]` 列义。 |
| 任务链 | 需在当前目标 PVF 中只读确认 | 需在当前目标 PVF 中只读确认 |
| 任务关联副本 | 需在当前目标 PVF 中只读确认 | 任务关联副本不等于副本入场条件。 |
| 固定奖励 | 需在当前目标 PVF 中只读确认 | 不先读 `[reward type]` 就不能解释 `[reward int data]` 裸数字。 |
| 可选奖励 | 需在当前目标 PVF 中只读确认 | 静态候选不证明实机 UI 可选、服务端发放或客户端资源完整。 |
| 任务怪物奖励物 | 需在当前目标 PVF 中只读确认 | 需在当前目标 PVF 中只读确认 |
| 副本门票/入场 | 需在当前目标 PVF 中只读确认 | 需在当前目标 PVF 中只读确认 |
| 独立掉落 | 需在当前目标 PVF 中只读确认 | 静态权重不能直接写成实机概率，也不等同任务奖励。 |
| 清算翻牌 | 需在当前目标 PVF 中只读确认 | 需在当前目标 PVF 中只读确认 |

## 代表链路

| 类型 | 链路 | 可复用结论 |
| --- | --- | --- |
| 任务定位 | 任务 ID -> `n_quest/quest.lst` -> `n_quest/*.qst`。 | 任务文件路径和大小写不能替代 registry。 |
| 接取、完成与列表可见性 | `.qst [npc index]` / `[complete npc index]` -> `npc/npc.lst`，并与 `[exposed by npc]` / `[first exposed by npc]`、登记和前置链合读。 | `-1` 不解析为 NPC，也不是删除/隐藏指令；NPC 列表可见性需要多状态实机确认。 |
| 任务前置 | `.qst [pre required quest]` -> `n_quest/quest.lst`。 | 多个前置块要逐块读，不要合并成一个裸列表。 |
| 任务收集物 | `.qst [type]` 为 `` `[seeking]` `` 时，`[int data]` 样本可按物品 ID/数量读取。 | 该解释只在对应父块上下文成立。 |
| 任务固定奖励 | `.qst [reward type]` -> `[reward int data]` -> `stackable` 或 `equipment`。 | 同一数字在多 registry 命中时，以父块和奖励类型决定。 |
| 任务可选奖励 | `.qst [reward selection int data]` -> 候选 ID/数量 -> 商品 registry。 | 可选候选存在不证明实机可选择或发放。 |
| 任务怪物掉任务物 | `.qst [monster reward item]` -> 怪物/控制值/任务物 ID/数量；任务物 ID -> `stackable`，并核查 `[stackable type] [quest]` 或同类任务物结构。 | 不把它并入普通 `.mob` 掉落整理主线；非 quest 类型任务物必须有目标 PVF 同类正样本和实机验证。 |
| 副本门票 | `dungeon/dungeon.lst` -> `dungeon/*.dgn [required item]` -> `stackable` 门票/材料。 | 需在当前目标 PVF 中只读确认 |
| 独立掉落 | `etc/independentdrop.lst` -> `etc/independentdrop/*.etc [list]` -> 候选 ID/权重。 | 不证明实机概率和调用场景。 |
| 清算翻牌 | `etc/itemdropinfo_clearreward.etc` -> gold card / pcroom / ref table 块。 | 单列清算系统，不混入任务或商店。 |

## 代表 ID 闭合

| 观察 | 目标核验 |
| --- | --- |
| `3062` | 需在当前目标 PVF 中只读确认 |
| `4109` | 需在当前目标 PVF 中只读确认 |
| `4254` / `4253` | 需在当前目标 PVF 中只读确认 |
| `26607` | 需在当前目标 PVF 中只读确认 |
| `2654025` / `2654030` | 需在当前目标 PVF 中只读确认 |
| `3340` | 需在当前目标 PVF 中只读确认 |
| `2651400` / `690060026` | 需在当前目标 PVF 中只读确认 |
| `7279` / `7454` / `7455` | 需在当前目标 PVF 中只读确认 |

## 字段边界

| 字段 | 静态可见含义 | 不可静态证明 |
| --- | --- | --- |
| `[level]` | 任务等级区间。 | 副本入场等级或服务端最终等级规则。 |
| `[pre required quest]` | 前置任务 ID 块。 | 需在当前目标 PVF 中只读确认 |
| `[int data]` | 任务目标数据，依赖 `[type]` / `[sub type]`。 | 任意裸数字固定代表物品、NPC、怪物或副本。 |
| `[dungeon info]` | 任务关联副本线索。 | 入场消耗、地图资源或实机可进入。 |
| `[monster reward item]` | 任务上下文怪物掉任务物配置；任务物 ID 要和任务 `[int data]` 收集目标保持一致。 | 需在当前目标 PVF 中只读确认 |
| `[reward int data]` | 固定奖励数据块。 | 需在当前目标 PVF 中只读确认 |
| `[reward selection int data]` | 可选奖励候选块。 | 实机选择、发放和客户端资源完整。 |
| `[required item]` | 副本入场消耗/门票静态字段。 | 需在当前目标 PVF 中只读确认 |
| `[minimum required level]` | 副本静态最低等级。 | 需在当前目标 PVF 中只读确认 |
| `independentdrop [list]` | 独立掉落候选 ID/权重或数值。 | 实机概率和调用场景。 |
| `clearreward gold card` | 结算翻牌相关成本、候选和引用表。 | 需在当前目标 PVF 中只读确认 |


## 使用检查

- 能从任务 ID 闭合到 `quest.lst` 和 `.qst`。
- 能解释 `[int data]` 为什么必须依赖父块上下文。
- 能明确说明本文不能支持全量任务类型编辑；任务条件类型矩阵仍是待补主线。
- 能区分任务固定奖励、任务可选奖励、任务怪物掉任务物、独立掉落、清算翻牌和副本门票。
- 能把奖励或掉落候选 ID 按正确 registry 闭合到 `equipment` 或 `stackable`。
- 能说明任务怪物奖励物是否为 quest 类 stackable，并知道非 quest 类型不能默认生产使用。
- 新增完整任务时，能排查 `.qst` 自动扫描和 `quest.lst` 注册双加载导致同名重复的风险。
- 能明确说出静态只读不能证明任务可接、奖励发放、门票扣除、副本入场、掉落概率、清算翻牌或服务端放行。
