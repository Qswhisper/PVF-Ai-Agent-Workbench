# Quest / Drop / Reward / Ticket 只读核查

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `dictionaries/quest-drop-reward-ticket-fields.zh-CN.md`
- `indexes/quest-drop-reward-ticket-boundary.zh-CN.md`
- `encyclopedia/pvf-file-types/equipment-stackable.zh-CN.md`

## 执行

1. 确认目标 PVF，只读打开。
2. 通过 `n_quest/quest.lst` 定位任务 ID 到 `n_quest/*.qst`，不要只靠目录文件名。
3. 读取任务文件的 `[type]`、`[sub type]`、`[int data]`、`[level]`、`[pre required quest]` 和可选 `[dungeon info]`。
4. 如果核查任务完成奖励，先读 `[reward type]`，再读 `[reward int data]` 和 `[reward selection int data]`。
5. 将奖励候选 ID 按奖励类型和父块上下文闭合到 `stackable` 或 `equipment`，不要凭数字大小猜。
6. 如果核查任务怪物掉任务物，读取 `[monster reward item]`，把其中的任务物 ID 按 `stackable/stackable.lst` 等正确 registry 解析。
7. 对 `[monster reward item]` 中的任务物，继续读取对应 stackable，确认是否为 `[stackable type] [quest]` 或同类任务物结构；非 quest 类型只能作为风险样本，不能默认生产使用。
8. 如果新增或审计完整任务，检查目标环境是否可能同时通过 `.qst` 自动扫描和 `quest.lst` 注册加载，避免同名任务重复。
9. 如果核查任务显示或隐藏，把 `quest.lst` 登记、`[npc index]`、`[complete npc index]`、`[exposed by npc]`、`[first exposed by npc]` 和前置链作为一个字段族读取。`-1` 不是删除指令，也不能单独证明任务已隐藏。
10. 如果核查副本门票或入场条件，先通过 `dungeon/dungeon.lst` 定位 `dungeon/*.dgn`，再读 `[required item]` 和 `[minimum required level]`。
11. 如果核查独立掉落，先读 `etc/independentdrop.lst`，再读对应 `etc/independentdrop/*.etc` 的 `[list]`。
12. 如果核查清算翻牌，读取 `etc/itemdropinfo_clearreward.etc`；不要和任务奖励或独立掉落混写。

## 验收

- 能说清任务 ID 来自 `n_quest/quest.lst`。
- 能说清 `[int data]` 的含义依赖 `[type]` / `[sub type]`。
- 能区分固定奖励 `[reward int data]` 与可选奖励 `[reward selection int data]`。
- 能把任务奖励 ID 闭合到 `stackable` 或 `equipment`，并说明 registry 依据。
- 能把 `[monster reward item]` 写成任务上下文掉任务物，而不是普通怪物掉落。
- 能说明任务怪物奖励物是否为 quest 类 stackable；非 quest 类型需要目标 PVF 正样本和实机验证。
- 新增任务时能说明是否存在 `.qst` 自动扫描与 `quest.lst` 注册双加载风险。
- 隐藏任务时能说明登记、NPC 归属和列表可见性是三层；不把 `[npc index] -1` 写成删除成功，并列出接取前、前置完成后、重登后的 NPC 列表 smoke。
- 能把 `[required item]` 写成副本入场消耗静态字段，而不是实机扣费成功。
- 能把 `etc/independentdrop.lst` 和 `etc/itemdropinfo_clearreward.etc` 分别写成独立掉落与清算翻牌系统。
- 不生成输出 PVF，不改客户端，不写运行产物进 knowledge-pack。

## 运行边界

静态只读能证明“文件中存在字段、列形和 registry 闭合”。它不能证明任务已显示或隐藏、可接取、可完成、奖励发放成功、背包容量足够、门票扣除成功、副本入场成功、掉落概率实机一致、结算翻牌 UI 正常或服务端放行。
