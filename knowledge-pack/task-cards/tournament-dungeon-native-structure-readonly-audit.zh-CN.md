# 武斗大会原生结构只读核查

状态：默认可用

用途：当用户要查找、修复或调整青龙/黄龙一类武斗大会时，先闭合目标版本自己的大会副本、竞技地图和怪物名单，再决定数值或行为改动。本文不把某两张大会、固定 ID、敌人数或项目调参值写成跨版本事实。

## 先读

- `safety/README.zh-CN.md`
- `task-cards/dungeon-map-spawn-entry-clear-resource-readonly-audit.zh-CN.md`
- `task-cards/monster-action-animation-readonly-audit.zh-CN.md`
- `task-cards/pvf-existing-ani-delay-controlled-change.zh-CN.md`
- `task-cards/independent-drop-normalization-readonly-plan.zh-CN.md`

## 原生结构闭合

1. 用户给自然语言大会名时，先在 `dungeon` 域运行一次 SearchName；多个名称用一次 `search-batch`。读取返回且已由 `dungeon/dungeon.lst` 确认的 `.dgn`，不先猜数字或目录。
2. 在 `.dgn` 中分别记录 `[tournament dungeon]`、`[start map]` / `[boss map]`、门票、复活币、指定难度、回合疲劳、结算奖励、`[monsterapc diff table]` 等字段。它们是不同机制层，不能因同处一个文件而一起改。
3. 大会地图必须由 `map/map.lst` 确认。读取地图的 `[dungeon]` 反链、`[tournament start area]`、`[tournament monster]`、出生区、地图资源和 NPC；地图能读取不等于回合逻辑会运行。
4. `[tournament monster]` 的 monster ID 列按当前目标同类块形状识别，再逐个通过 `monster/monster.lst` 解析并读回 `.mob`。相邻数字先保留为未知参数；不能把它们凭外形写成权重、坐标、等级或概率。
5. 覆盖面以“所有已登记大会地图中的已解析名单并集”为准，同时报告重复、未解析、截断和地图读取失败。不要用某个怪物目录的全部文件或一段 ID 区间冒充实际参赛名单。
6. 官方参考与目标成品分开记录：官方说明原生结构，目标说明当前静态状态，实机记录才说明回合、UI、战斗和结算行为。

## 调整层分流

| 诉求 | 优先读取 | 边界 |
| --- | --- | --- |
| 入场、门票、次数、复活 | 目标 `.dgn` 对应完整字段族 | 不顺手改变大会类型或地图。 |
| 参赛者名单 | 目标 `.map [tournament monster]` + `monster.lst` | 目录存在不等于实际参赛。 |
| 血量、攻防、硬直、重量 | 参赛 `.mob` 与目标专属难度表 | 全局表影响面更大；专属表列义和乘算需目标证据。 |
| 倒地或动作时长 | 目标 `.mob` 动作链与对应 `.ani [DELAY]` | `.ani` 只允许既有延迟字段专用路线；时长仍需实机。 |
| 通关奖励 | `.dgn` 结算字段、任务奖励、独立掉落分开 | 三者不是同一系统；静态权重不是实机概率。 |
| 怪物独立掉落 | 实际参赛 monster ID + 独立掉落表/组表 | 替换必须带 monster 上下文，不能裸改共享数字串。 |

## 代理模拟方案的额外门禁

如果提案不是目标原生 `[tournament dungeon] -> tournament map -> monster roster`，而是“怪物外壳 + 可见 APC”或其他代理模型，不得因为能生成、攻击或死亡就判定等价。至少把以下状态分别闭合：

- 生命值归属、UI 血条/名字/头像、受击框与锁定目标。
- 普通抓取、强抓、浮空、倒地、无敌、治疗、护盾和持续伤害。
- 外壳死亡、代理死亡、同时死亡、残留清理和下一回合生成。
- 伤害同步是否单向/双向、是否重复结算、反伤是否递归。

没有目标脚本先例和完整实机矩阵时，代理方案保持实验候选，不替代原生大会结构。

## 验收

- 大会 `.dgn` 已由 dungeon registry 确认。
- 每张大会地图已由 map registry 确认，且 `[dungeon]` 反链正确。
- 实际名单中的每个 monster ID 均已解析；重复、失败与未解析没有被丢弃。
- 数值、动作、奖励和掉落分别落到正确层，没有把项目调参值写成通用默认。
- 实机至少覆盖首轮生成、战斗、胜负、清理、下一轮、最终结算、UI 和一个抓取/控制样本。

## 禁止外推

- 不把某版本的大会数量、地图 ID、monster ID、敌人数或专属难度表数值复制到其他版本。
- 不把 `[tournament monster]` 相邻列裸解释成概率或权重。
- 不把地图名单静态存在写成 EXE 内置回合逻辑已验。
- 不把代理对象“可运行”写成血量、抓取、UI、死亡和回合行为等价。
