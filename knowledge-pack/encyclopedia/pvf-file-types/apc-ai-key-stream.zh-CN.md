# APC / AI / Key Stream

状态：默认可用

## 用途

APC 使用 `.aic` 定义角色、技能、装备、AI pattern 和 key stream。AI 文件决定行为分支，key 文件模拟按键输入。

`.aic` 也承载 APC 战斗面板。用户提出“提升伤害、提高输出、打得更快、加强战斗力、硬度、坦度、生存能力或更抗打”时，不能等用户逐个点名字段。先按 `task-cards/apc-combat-attribute-intent-readonly-audit.zh-CN.md` 拆分伤害、节奏与生存意图，联合审阅 `[additional character status]`、`[character status rate]`、独立攻击侧标签、技能和装备；生存问题再进入 `task-cards/apc-character-status-hardness-readonly-audit.zh-CN.md`。位置映射见 `dictionaries/apc-character-status-fields.zh-CN.md`。

固定首发 Buff、姿态、召唤或开场技能进入 `task-cards/apc-opening-action-single-execution-readonly-audit.zh-CN.md`。必须把首发事件和普通 AI 对同一逻辑动作的再次选择放在一起审计。

## 常见路径

- `aicharacter/aicharacter.lst`
- `aicharacter/**/*.aic`
- `aicharacter/**/*.ai`
- `aicharacter/**/*.key`
- `skill/**/*.lst`
- `skill/**/*.skl`

## 基本闭环

```text
aicharacter.lst
-> .aic
-> [ai pattern] .ai
-> [key stream] action name -> .key
-> [quick skill] / [skill]
-> skill registry -> .skl
```

## 规则

- `.aic` 中的 skill ID 必须通过目标职业 skill registry 解析。
- key stream 的动作名要回到 `.aic` 映射，不要只看 `.ai` 返回值。
- 固定首发动作若也在普通 AI 候选中，可能再次切换持续状态、提前改变形态或重复召唤；静态存在和超长冷却都不能替代实机单次性验证。
- 相邻目录的 APC 不能当作同一个 APC。
- `.aic` 数值列含义不清时要标为需验证。
- `[additional character status]` 与 `[character status rate]` 的位置不完全对齐；禁止把同一列号当成同一属性。

## 战斗状态机与 key 串边界

- APC 连招不能只由“选中了起手技能”决定。可复用的审计顺序是：立回与轴线策略 -> 骚扰或起手 -> 命中确认 -> 目标状态分流 -> 短 key 串 -> 条件失效即退出并复位。
- 未命中、错轴、目标恢复站立、技能不可用或离开有效范围时，固定长 key 串继续播放容易产生空打和失控；优先用可中断短链，并逐段验证退出条件。
- 远近职业、抓取与非抓取职业的轴线和距离策略不能直接共用。静态技能、装备、动作帧、冷却和 key 时序任一漂移，都可能让跨版本 APC 原型失效。
- 一个历史目标样本中，`[hit]` 只在 APC 已经受击后触发反应，不能据此证明它能防住第一击。这是目标版负例，不是全版本枚举语义；任何精确 AI 条件名都要在当前目标重新查询、闭合调用位置并做实机 A/B。

## 写入边界

APC 行为改动要闭合 `.aic -> .ai -> .key -> skill`。涉及战斗表现时需要游戏内验证。
