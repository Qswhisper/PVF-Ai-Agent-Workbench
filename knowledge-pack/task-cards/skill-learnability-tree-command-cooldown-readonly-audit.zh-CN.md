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
4. 若问技能树：读取对应 SP/TP 技能树，记录 `[character job]`、`[index]`、`[icon pos]`、`[next skill]`。
5. 若问默认学会：读取对应 `.chr` 的基础、growtype 和 awakening 技能字段；必要时再查 AutoSkill。
6. 若问 PVP：读取 PVP 技能树，不把 SP/TP 结论直接迁移到 PVP。
7. 若问命令：同时记录 `[command]` 和 `[command key explain]`，不要只看说明文本。
8. 若问可释放状态：记录 `[executable states]`，并标明它不能证明强制、柔化或脚本最终放行。
9. 若问冷却/消耗：区分 `[cool time]`、`[start cool time]`、`[auto cooltime apply]`、`[consume MP]`、`[casting time]` 和装备侧 `[skill data up]`。
10. 若问学习扣点：普通技能读 `.skl [purchase cost]`；TP/EX 强化技能读强化 `.skl [special purchase cost]`；不要从 SP/TP 树图标列表推断扣点。
11. 若问前置技能：分开记录技能树 `[next skill]` 和 `.skl [pre required skill]`，不要互相替代。
12. 若问装备加技能等级：走装备侧 `[skill levelup]` 三列组和外层装备上下文，不写成学习来源。
13. 若问动态冷却 API：使用一次精确 `knowledge-query nut` 加一次目标 `pvf-read search-script`；没有命中时，不沿用旧 Runtime 样本当目标事实。

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
- 不要把 `[skill fitness growtype]` 写成“该转职自动获得”。
- 不要把 `[command key explain]` 当作唯一命令来源。
- 不要把 `[executable states]` 写成强制、柔化或取消窗口。
- 不要把 SP、TP、PVP、AutoSkill、`.chr` 默认技能互相替代。

## 下一步测试建议

- 界面测试：建对应职业和转职，确认技能树是否显示、等级门槛、学习消耗、最高等级。
- 输入测试：用命令输入和快捷栏分别释放，确认 `[command]` 与 UI 说明是否一致。
- 冷却测试：记录释放成功、释放失败、PVP、装备冷却加成后的实际冷却表现。
- 默认技能测试：新建角色、转职、觉醒后分别截图或记录技能列表，确认 `.chr` / AutoSkill 线索是否生效。
