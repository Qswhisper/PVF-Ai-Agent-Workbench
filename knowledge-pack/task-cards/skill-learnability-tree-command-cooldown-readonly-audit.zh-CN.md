# Skill Learnability / Tree / Command / Cooldown 只读审计卡

状态：默认可用

用途：当问题是“技能为什么能学/不能学、技能树是否显示、命令和冷却从哪里来”时使用。不要用本卡重开 Skill / State / NUT Runtime Boundary。

## 先读

1. `safety/README.zh-CN.md`
2. `indexes/skill-registry-routing.zh-CN.md`
3. `dictionaries/skill-learnability-command-cooldown-fields.zh-CN.md`
4. `indexes/skill-learnability-tree-command-cooldown-boundary.zh-CN.md`
5. `indexes/skill-tree-default-pvp-entry-boundary.zh-CN.md`
6. `indexes/skill-learnability-cost-sp-tp-ui-boundary.zh-CN.md`
7. `workflows/skill-tree-layout-and-merge-safety.zh-CN.md`

## 只读步骤

1. 确认父入口：问题来自 `.skl`、装备技能加成、技能树、`.chr` 默认技能、AutoSkill、PVP 表，还是 NUT。
2. 明确目标职业和技能 ID 时运行 `pvf-read resolve-skill`，再读取返回的 `.skl`；这一步已经从目标 `.chr` 和 `skill/skilllist.lst` 选择正确职业 registry，不再猜路径或枚举目录。
3. 读取目标 `.skl`：记录 `[name]`、`[name2]`、`[type]`、`[required level]`、`[purchase cost]`、`[maximum level]`、`[growtype maximum level]`、`[skill fitness growtype]`。
4. 若后续要读取某等级参数，先用这些上限字段和技能树/默认/装备入口确定实际可达等级；`[maximum level]` 与 `[level info]` 末行都不能单独充当角色当前等级。
5. 若问技能树：读取对应 SP/TP 技能树，记录 `[character job]`、`[index]`、`[icon pos]`、`[next skill]`。
6. 若问默认学会：读取对应 `.chr` 的基础、growtype 和 awakening 技能字段；必要时再查 AutoSkill。
7. 若问 PVP：读取 PVP 技能树，不把 SP/TP 结论直接迁移到 PVP。
8. 若问命令：同时记录 `[command]` 和 `[command key explain]`，不要只看说明文本。
9. 若问可释放状态：记录 `[executable states]`，并标明它不能证明强制、柔化或脚本最终放行。
10. 若问冷却/消耗：区分 `[cool time]`、`[start cool time]`、`[auto cooltime apply]`、`[consume MP]`、`[casting time]` 和装备侧 `[skill data up]`。
11. 若问学习扣点：普通技能读 `.skl [purchase cost]`；TP/EX 强化技能读强化 `.skl [special purchase cost]`；不要从 SP/TP 树图标列表推断扣点。
12. 若问前置技能：分开记录技能树 `[next skill]` 和 `.skl [pre required skill]`，不要互相替代。
13. 若问装备加技能等级：走装备侧 `[skill levelup]` 三列组和外层装备上下文，不写成学习来源。
14. 若装备仍给单级 TP/EX/派生技能加等级，先按三列组中的职业 registry 解析派生 `.skl`；`[pre required skill]` 只产生同职业基础技能候选，再读取基础 `.skl [feature skill index]` 做反向闭合。缺一边、多前置或映射冲突时保持 unresolved，不能按名称或数字猜。
15. 批量核查装备加成时从 `equipment/equipment.lst` 遍历全部登记 `.equ` 并完整解析每个 `[skill levelup]`，分别报告已读、读取失败、未解析、截断和重复；不得按文件名前缀、ID 段或系列抽样后宣称全覆盖。
16. 若问动态冷却 API：使用一次精确 `knowledge-query nut` 加一次目标 `pvf-read search-script`；没有命中时，不沿用旧 Runtime 样本当目标事实。

## 单级派生技能的装备加成诊断

- 派生 `.skl [maximum level] 1` 只能说明静态上限线索，不能单独证明装备加等级必然无效。
- `[pre required skill]` 表示前置技能关系，不自动授权把装备加成转移给该技能；设计意图必须单独确认。
- 当目标同时存在“派生 `[pre required skill] -> 基础技能”和“基础 `[feature skill index] -> 派生技能”的同职业双向关系时，可把基础技能列为高置信替代候选。
- 映射和加成幅度分开决策；历史项目的具体 `+N` 不是通用值。
- 最终需穿戴/卸下 A/B：技能面板等级、相关说明、实际伤害/范围/冷却或该技能真正受影响的行为分别核查。

## 输出格式

汇报时按下面顺序：

1. 技能 ID 通过哪个职业 registry 解析到哪个 `.skl`。
2. `.skl` 学习字段说明了什么。
3. 技能树、默认技能、AutoSkill、PVP 表分别有没有可见入口。
4. 命令、可释放状态、冷却、MP、施放时间分别来自哪个静态字段。
5. 哪些问题必须实机测试。

## 不要做

- 不要把 `.skl` 存在写成“玩家已经学会”。
- 不要把 `[required level]` 写成“技能树一定显示”。
- 不要把 `[maximum level]` 或 `[level info]` 末行写成角色实际可达等级。
- 不要把 `[skill fitness growtype]` 写成“该转职自动获得”。
- 不要把 `[command key explain]` 当作唯一命令来源。
- 不要把 `[executable states]` 写成强制、柔化或取消窗口。
- 不要把 SP、TP、PVP、AutoSkill、`.chr` 默认技能互相替代。
- 不要把 `[pre required skill]` 单向关系写成已授权的装备加成迁移，也不要用 ID 段抽样代替 registry 全覆盖。

## 下一步测试建议

- 界面测试：建对应职业和转职，确认技能树是否显示、等级门槛、学习消耗、最高等级。
- 输入测试：用命令输入和快捷栏分别释放，确认 `[command]` 与 UI 说明是否一致。
- 冷却测试：记录释放成功、释放失败、PVP、装备冷却加成后的实际冷却表现。
- 默认技能测试：新建角色、转职、觉醒后分别截图或记录技能列表，确认 `.chr` / AutoSkill 线索是否生效。
