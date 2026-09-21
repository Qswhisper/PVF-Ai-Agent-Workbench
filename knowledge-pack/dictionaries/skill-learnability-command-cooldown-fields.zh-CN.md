# Skill Learnability / Command / Cooldown 字段边界

状态：默认可用


## 总规则

- 技能 ID 必须先确定父入口和职业 registry，再解析到 `.skl`；同一个数字可以在不同 registry 中指向不同技能。
- `.skl` 的学习字段、技能树入口、角色默认技能、自动技能表、PVP 技能表、取消技能表分别是不同层，不要互相替代。
- 能学会不等于能释放；能释放不等于命中、伤害、冷却 UI、服务端一致性或 PVP 规则成立。

## Registry 与入口字段

| 入口 | 当前边界 |
| --- | --- |
| `skill/skilllist.lst` | 职业序号到职业 skill registry 的总入口；只负责路由到哪个 `.lst`。 |
| `skill/*skill.lst` / 特定职业 `.lst` | 技能 ID 到 `.skl` 的注册表；解释任何技能数字前必须先确认这里。 |
| `skill/autoskill.lst` | 职业序号到 AutoSkill 文件的入口；它不是普通 `.skl` 学习字段。 |
| `clientonly/commonskilllist.co` | 公共技能显示或例外入口；`[common]` 不是独立 skill registry。 |
| `clientonly/cancelskilllist.co` | 取消技能列表线索；不是学习来源，也不证明强制释放成功。 |

## `.skl` 学习字段

| 字段 | 当前可用含义 | 边界 |
| --- | --- | --- |
| `[name]` / `[name2]` | 技能显示名和英文/备用名。 | 名字不能反推技能效果或 registry。 |
| `[type]` | 技能类型，例如 `[active]`、`[passive]`。 | 被动不等于默认已学；主动不等于一定可释放。 |
| `[purchase cost]` | 学习购买消耗字段。 | 不单独证明最终 SP/TP 扣费、UI显示或服务端校验。 |
| `[special purchase cost]` | TP/EX/强化类技能文件中的特殊购买消耗线索。 | 不要和普通 `[purchase cost]` 混写；也不要从 TP 树图标位置直接推断。 |
| `[pre required skill]` | 技能文件中的前置技能线索；需按当前职业 registry 解释技能 ID。 | 不要和 SP 树 `[next skill]` 或装备 `[required skill]` 混写。 |
| `[required level]` | 技能文件中的需求等级字段。 | 不等于技能树一定显示，也不等于角色默认获得。 |
| `[required level range]` | 与需求等级相邻的范围/步进字段。 | 具体 UI 规则和服务端校验需运行或同族专项验证。 |
| `[skill class]` | 技能分类字段。 | 当前只作为静态分类线索，不直接等于技能树页签或可学状态。 |
| `[maximum level]` | `.skl` 基础等级上限字段。 | 不等于角色实际可点到该等级；还受 growtype、树、PVP、服务端影响。 |
| `[growtype maximum level]` | 按 growtype 列出的等级上限形状。 | 列数和 growtype 映射必须按当前职业上下文确认。 |
| `[skill fitness growtype]` | 技能适配 growtype 列表。 | 适配不等于自动获得；仍需技能树、默认技能或运行授予入口。只增加技能树显示节点不能作为 learnability 已扩大的证据。 |
| `[feature skill index]` | 指向特性/扩展技能 ID 的静态字段；与派生技能 `[pre required skill]` 反向一致时，可形成同职业双向映射候选。 | 必须回到同职业 registry 解析，不跨职业借 ID；双向静态关系仍不自动授权迁移装备加成。 |

## 命令与可释放状态

| 字段 | 当前可用含义 | 边界 |
| --- | --- | --- |
| `[command]` | 静态输入序列，常见方向键、技能键、BUFF 键等 token。 | 不证明键盘输入一定成功、快捷栏释放成功或取消窗口成立。 |
| `[command key explain]` | UI 文本说明用的操作指令。 | 是说明文本，不能替代 `[command]` token。 |
| `[executable states]` | `.skl` 中列出的可释放 state 线索。 | 不证明强制、柔化、派生或脚本最终放行；NUT 可继续收窄。 |
| `[active seal enable]` | 需在当前目标 PVF 中只读确认 | 具体 UI 和服务端行为未静态证明。 |

## 冷却、消耗与施放时间

| 字段 | 当前可用含义 | 边界 |
| --- | --- | --- |
| `[consume MP]` | `.skl` 静态 MP 消耗字段。 | 不证明最终扣蓝、失败释放回滚或装备修正后结果。 |
| `[cool time]` | `.skl` 静态冷却字段。 | 需在当前目标 PVF 中只读确认 |
| `[start cool time]` | `.skl` 中可见的起始冷却字段。 | 不能和 `[cool time]` 合并解释。 |
| `[auto cooltime apply]` | 自动冷却应用线索。 | 当前只按静态标签保留，不证明引擎具体时机。 |
| `[casting time]` | `.skl` 静态施放时间字段。 | 需在当前目标 PVF 中只读确认 |
| `[consume item]` | 技能消耗道具字段。 | 道具 ID 需按对应 item registry 解析，不靠数字猜。 |
| `[durability decrease rate]` | 耐久消耗相关静态字段。 | 不证明最终耐久扣减表现。 |
| `startSkillCoolTime` | 跨版本候选；需在当前目标 PVF 中复核 | 需在当前目标 PVF 中只读确认 |

## 技能树、默认技能和 PVP 入口

| 入口 | 当前可用含义 | 边界 |
| --- | --- | --- |
| `clientonly/skilltree/*_sp.co` | SP 技能树显示/前置链入口，按 `[character job]`、`[skill info]`、`[index]`、`[icon pos]`、`[next skill]` 观察。 | 偏客户端显示和可点线索，不单独证明服务端授予。 |
| `clientonly/skilltree/*_tp.co` | TP 技能树显示入口。 | 不能和 SP 树混用。 |
| `etc/pvpskilltree/*.etc` | PVP 技能表，按 `[level]`、`[job index]`、`[grow type index]`、`[skill]`、`[static basic skill]` 分层观察。 | PVP 表不能直接覆盖 dungeon/SP 规则。 |
| `character/**/*.chr` 的 `[skill]` | 角色基础或 growtype 默认技能线索。 | 只证明 PVF 可见默认授予字段，不证明外部服务端最终状态。 |
| `character/**/*.chr` 的 `[awakening skill]` | 觉醒段默认技能线索。 | 只按当前 `.chr` 父块解释。 |
| `AutoSkill` 文件 | 等级、技能 ID、技能等级的密集表线索。 | 当前只确认存在和分段，不强解全部列。 |
| 装备侧 `[skill levelup]` | 装备、套装、avatar/aura 等上下文中的技能等级变化线索。 | 不是技能学习来源，不证明技能树显示或最终技能等级。 |
