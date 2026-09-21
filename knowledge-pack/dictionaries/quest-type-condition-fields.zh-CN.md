# Quest Type / Condition 字段字典

状态：默认可用


## 总规则

- 任务入口以 `n_quest/quest.lst` 为准；注册表没有挂到的 `.qst` 不能默认当作可接任务。
- `-1` 只能按所在字段解释为边界值，不能当作“删除任务”或“保证隐藏”。只要 `.qst` 仍在 `quest.lst` 登记，任务身份就仍然存在；NPC 归属与列表可见性要分开核查。
- `[type]` 决定 `[int data]` 的解释域；不能把 `[int data]` 裸数字直接猜成物品、NPC、怪物或副本。
- `[sub type]` 只在同一个 `[type]` 下解释；不同 `[type]` 下相同数字不共享语义。
- 静态只读只能证明文件写了条件、引用和候选目标；不能证明任务可接、可完成、UI 正常、服务端放行或计数器实机生效。
- 条件物品已从正确 registry 移除、无法解析或没有当前可获得来源时，只能标记“静态不可达候选”，不能仅凭文件存在写成可完成任务。删除或退役物品前要反向审计所有活跃 `[seeking]` / `[use item]` 条件，不能只查商店、礼包、奖励和掉落。修复或改型审计要把 `[type]`、`[sub type]`、`[int data]`、`[check count]`、`[limit showing msg]`、`[condition message]` 和 `[condition data]` 当作一个字段族；优先同时参考官方同登记任务与目标版本同类型正样本，再用客户端进度显示、实际计数与奖励发放闭环。

## 入口字段

| 字段 | 静态含义 | registry / 上下文 | 边界 |
| --- | --- | --- | --- |
| `n_quest/quest.lst` | 任务 ID 到 `.qst` 的注册入口 | `n_quest/quest.lst` | 需在当前目标 PVF 中只读确认 |
| `.qst` 未注册文件 | 任务目录里的非注册文件 | `n_quest/**/*.qst` | 需在当前目标 PVF 中只读确认 |
| `[grade]` | 任务大类标记 | 字符串枚举 | 需在当前目标 PVF 中只读确认 |
| `[type]` | 任务条件类型 | 见 type 矩阵 | 需在当前目标 PVF 中只读确认 |
| `[sub type]` | 条件子类型 | 只在当前 `[type]` 下解释 | 需在当前目标 PVF 中只读确认 |
| `[int data]` | 条件参数 | 父块由 `[type]` + `[sub type]` 决定 | 必须按矩阵解释，禁止裸数字外推。 |

## 链路与限制字段

| 字段 | 静态含义 | registry / 上下文 | 目标核验 |
| --- | --- | --- | --- |
| `[npc index]` | 接任务/展示 NPC 候选 | `npc/npc.lst` | 需在当前目标 PVF 中只读确认 |
| `[complete npc index]` | 完成任务 NPC 候选；`-1` 可表示非指定完成 NPC / 非 NPC 完成边界 | `npc/npc.lst` | 需在当前目标 PVF 中只读确认 |
| `[exposed by npc]` | 是否在 NPC 任务界面暴露的静态候选；目标与官方样本可见 `0` | 与 `[npc index]`、任务 grade/event 和目标客户端共同解释 | 不能由静态 `0/1` 单独证明最终 UI 行为；目标实机已出现只改 NPC 为 `-1` 仍未隐藏的负样本。 |
| `[first exposed by npc]` | 首次暴露/初始显示的静态候选；目标样本可见与 `[exposed by npc]` 成对使用 | 同一 `.qst` 可见性上下文 | 不等于删除登记；需接取前、前置完成后和重登分别实机。 |
| `[show npc on clear]` | 清除后显示 NPC 候选 | `npc/npc.lst` | 需在当前目标 PVF 中只读确认 |
| `[pre required quest]` | 前置任务 ID 列表 | `n_quest/quest.lst` | 需在当前目标 PVF 中只读确认 |
| `[level]` | 等级区间 | 数字区间 | 需在当前目标 PVF 中只读确认 |
| `[job]` | 职业限制 | 字符串枚举，如 `[all]` | 需在当前目标 PVF 中只读确认 |
| `[grow type]` | 成长/转职限制候选 | 数字 | 需在当前目标 PVF 中只读确认 |
| `[target character]` | 多职业目标块 | 职业字符串 + 数值列 | 需在当前目标 PVF 中只读确认 |
| `[difficulty]` | 任务显示/要求难度标记 | 字符串，如 `B`、`D`、`F`、`W`、`Y` | 需在当前目标 PVF 中只读确认 |
| `[gold multiple]` | 金币/奖励倍率候选字段 | 数字 | 需在当前目标 PVF 中只读确认 |
| `[quest point]` | 任务点字段 | 数字 | 需在当前目标 PVF 中只读确认 |
| `[event]` | 活动标记 | 数字 | 需在当前目标 PVF 中只读确认 |
| `[cant giveup]` | 放弃限制标记 | 数字 | 需在当前目标 PVF 中只读确认 |
| `[check count]` | 称号簿/累计类计数阈值 | 当前任务上下文 | 需在当前目标 PVF 中只读确认 |
| `[limit showing msg]` | 计数提示显示阈值 | 当前任务上下文 | 需在当前目标 PVF 中只读确认 |
| `[condition data]` | 条件 UI 文本格式 | 文本格式参数 | 需在当前目标 PVF 中只读确认 |

## 奖励与任务掉落字段

| 字段 | 静态含义 | registry / 上下文 | 边界 |
| --- | --- | --- | --- |
| `[reward type]` | 奖励类型 | 见奖励边界索引 | 固定奖励、称号、转职/成长等奖励类型已在奖励/掉落/门票边界整理；不要在本文重写奖励系统。 |
| `[reward int data]` | 固定奖励参数 | 由 `[reward type]` 决定 | 不能一律按物品 ID/数量对解释。 |
| `[reward selection int data]` | 可选奖励参数 | 由奖励字段上下文决定 | 静态只读不证明 UI 选择和发放成功。 |
| `[monster reward item]` | 接任务后的任务物品掉落候选 | 7 列一组：怪物/目标 ID、副本 ID、难度、物品 ID、数量、概率候选、限制候选 | 静态只读只能证明任务内候选掉落配置，不证明实机掉率、生效条件或服务端放行。 |

## 任务类型总表

| 注册 `[type]` | 目标核验 | 默认解释入口 |
| --- | ---: | --- |
| `[seeking]` | 需在当前目标 PVF 中只读确认 | `[int data]` 物品 ID/数量对；任务物品可闭合到物品 registry。 |
| `[condition under clear]` | 需在当前目标 PVF 中只读确认 | 第一列是副本 ID；`[sub type]` 决定通关条件。 |
| `[meet npc]` | 需在当前目标 PVF 中只读确认 | `[int data]` 为 NPC ID。 |
| `[hunt monster]` | 需在当前目标 PVF 中只读确认 | 4 列一组：副本、难度、怪物、数量。 |
| `[hunt enemy]` | 需在当前目标 PVF 中只读确认 | 5 列一组：副本、难度、enemy 目标、数量/控制列。enemy 目标可落到 monster / aicharacter / passiveobject。 |
| `[clear quest]` | 需在当前目标 PVF 中只读确认 | `[int data]` 为任务 ID。 |
| `[clear map]` | 需在当前目标 PVF 中只读确认 | `[int data]` 为 map ID。 |
| `[use item]` | 需在当前目标 PVF 中只读确认 | 称号簿/累计使用类；物品 ID 可闭合到物品 registry。 |
| `[custom quest]` | 需在当前目标 PVF 中只读确认 | 自定义/称号条件；只能按样本和条件文本解释。 |
| `[equipped item]` | 需在当前目标 PVF 中只读确认 | 穿戴条件；列按装备部位/稀有度/阈值样式出现。 |
| `[amplify item]` | 需在当前目标 PVF 中只读确认 | 增幅类称号条件；静态不证明增幅动作计数生效。 |
| `[get score]` | 需在当前目标 PVF 中只读确认 | 得分/伤害类称号条件；需看条件文本。 |
| `[check time]` | 需在当前目标 PVF 中只读确认 | 在线/停留计时类称号条件。 |
| `[disjoint item]` | 需在当前目标 PVF 中只读确认 | 分解装备获得物品/累计次数类条件。 |
| `[pvp rank]` | 需在当前目标 PVF 中只读确认 | PVP 段位/等级条件；静态不证明 PVP 规则。 |
| `[seek n meet npc]` | 需在当前目标 PVF 中只读确认 | 物品收集 + NPC 完成组合。 |
| 空 `[type]` | 需在当前目标 PVF 中只读确认 | 异常样本，不能作为可用任务类型。 |

## 未注册风险桶
