# Equipment Effect Fields 索引

## 用途

本索引用于只读判断 equipment `.equ` 中套装、成长、技能加成、触发条件和触发效果类字段。它只整理字段边界、相邻关系和最低验证要求，不授权直接写 PVF。

## 总规则

- 本索引字段默认状态为 `需验证`；只有明确标为 `禁用` 的字段不可作为快捷入口。
- 块结构必须读取闭合标签；缺少闭合确认时不能按完整块改写。
- 数字 ID 必须按字段上下文选择 registry；技能 ID 走对应职业 skill registry，装备 ID 走 equipment registry，副本或对象 ID 不可混用。
- `[if]` / `[then]`、`[set ability]`、`[pvp]` 等容器块内的字段必须按块内位置解释，不要脱离容器单独套用。
- 触发效果字段的运行表现通常需要同类样本和实机验证；目标 PVF 只读只能证明结构存在。

## 套装与成长容器

| 字段 | 状态 | 读取边界 |
| --- | --- | --- |
| `[set name]` | 需验证 | 套装名字；文本不证明套装效果生效。 |
| `[set item]` | 需验证 | 套装物品 ID 列表；必须检查 `[/set item]`，ID 走 equipment registry。 |
| `[set ability]` | 需验证 | 套装能力容器；必须检查 `[/set ability]`，块内字段逐项读取。 |
| `[set item master]` | 需验证 | 套装主件或关联装备 ID 线索；数字走 equipment registry。该字段不能单独证明只有一件“主件”承载全部定义，必须与 `[set item]`、`[part set index]` 和实际成员文件拓扑联合读取。 |
| `[part set index]` | 需验证 | 单值零件套装关联号；不是闭合块。先用数值匹配 `etc/equipmentpartset.etc` 中 `[equipment part set]` 记录的首列，再把该记录的 `character/partset/*.equ` 路径按 `equipment/` 根读取。不要和 `[effect part set index]`、`[set item]` 混用。调整某一装扮等级的套装能力时，应先确认真正的 partset 能力 owner，再把相邻普通、稀有、克隆或其他等级 owner 作为负对照；生成后全部读回，并分别选代表实机，防止目标档调整误伤其他档。 |
| `[piece set ability]` | 需验证 | 按套装件数生效的能力块；目标样本首值为所需件数，后续可包含属性、技能或触发效果字段。正常形态以 `[/piece set ability]` 闭合；目标包存在少量缺失闭合的残缺样本，不能据此省略结束标签。一个历史目标实机负例表明，高件数阈值不能自动视为继承全部低件数效果；应读取每个阈值，并按精确穿戴件数分别验证。 |
| `[parameter basic explain]` | 需验证 | 通常位于 `[piece set ability]` 内的非闭合反引号说明文本；只负责描述，不证明同块效果实际生效。 |
| `[fullset explain]` | 需验证 | `[set ability]` 内的非闭合套装说明文本；不能代替真实效果字段。 |
| `[fullset basic explain]` | 需验证 | 非闭合的套装基础说明文本；目标样本多数位于 `[set ability]` 内，也存在根级样本，必须按实际位置读取。 |
| `[fullset detail explain]` | 需验证 | `[set ability]` 内的非闭合套装详细说明文本；不能从文字反推运行机制。 |
| `[effect part set index]` | 需验证 | 单值效果套装关联号，不是闭合块。优先匹配效果套装映射记录，再读取其 partset 效果文件；效果文件可通过 `[additional effect index]` 继续关联附加效果定义。目标包有部分数值未在现有映射中找到，未解析值不得臆造路径。 |
| `[reference effect part set index]` | 需验证 | 与 `[effect part set index]` 相邻出现的单值参考关联号，不是闭合块。目标只读观察不能证明其冲突、覆盖或优先级语义，写入前必须结合同组样本和实机验证。 |
| `[dynamic part set index]` | 需验证 | 根级闭合数字列表；目标样本均为 5 个整数。示例值未能通过 equipment registry 或当前套装映射表解析，不能把各列直接命名为装备 ID 或固定套装 ID。 |
| `[level linear ability]` | 需验证 | 线性成长能力块；块内同名字段按成长上下文解释。 |
| `[level section ability]` | 需验证 | 等级分段能力块；按等级段、块内字段和 `[/level section ability]` 整体验证。 |
| `[maximum level]` | 需验证 | 成长或等级相关上限线索；不等同于角色等级上限。 |
| `[room list move speed rate]` | 需验证 | 移动速度率类字段线索；运行语义未定性。 |
| `[required skill]` | 需验证 | 装备需求或限制类技能字段；无显式职业列时结合路径、`[usable job]` 和同类样本选 skill registry。 |
| `[emancipate]` | 需验证 | 解放或改造类闭合块；必须检查 `[/emancipate]`，内部 `[input]`、`[output]` 和说明文本需分开读取。 |
| `[input]` | 需验证 | `[emancipate]` 内的闭合输入列表；目标样本为连续的“数字 ID、数量”对，可有 1、2 或 4 对。材料 ID 常走 stackable registry，但每个 ID 都必须实际解析，不能按位置直接定类。 |
| `[output]` | 需验证 | `[emancipate]` 内的输出块；目标绝大多数样本为“装备 ID、数量”，也存在单值样本和一个缺失 `[/output]` 的残缺样本。必须按目标文件原形读取并通过 equipment registry 验证可解析的产物 ID。 |
| `[emancipate explain]` | 需验证 | `[emancipate]` 内的非闭合多行说明文本；目标样本通常为一个反引号字符串。它只描述改造结果，不证明 `[output]` 装备的实际属性，不能当作独立效果块。 |

## 技能加成与技能数据

| 字段 | 状态 | 读取边界 |
| --- | --- | --- |
| `[skill levelup]` | 需验证 | 连续多组“职业 token、技能 ID、等级变化量”；详细见 `indexes/skill-levelup.zh-CN.md`。 |
| `[all skill item]` | 需验证 | 全技能或范围技能等级加成块；必须检查 `[/all skill item]`，块内条件一起读取。 |
| `[item growtype]` | 需验证 | 技能加成块内的职业或成长类型限定；职业 token 和数字列需同类样本确认。 |
| `[skill apply condition]` | 需验证 | 技能加成适用条件块；必须检查 `[/skill apply condition]`。 |
| `[skill group]` | 需验证 | 技能组线索；`[all]` 只说明样本形态，不自动等于全职业全技能。 |
| `[lower bound level]` / `[upper bound level]` | 需验证 | 技能等级范围下限 / 上限；需结合技能加成块解释。 |
| `[extra condition]` | 需验证 | 技能加成块内额外过滤条件；必须检查 `[/extra condition]`。 |
| `[skill phase]` | 需验证 | 技能适用阶段线索；不要当作职业或技能组字段。 |
| `[skill data up]` | 需验证 | 成组修改指定技能数据；详细数据类型见 `indexes/skill-data-up-types.zh-CN.md`。 |
| `[skill cooltime reset]` | 需验证 | 技能冷却重置效果线索；参数列、技能范围、剩余冷却限制和排除规则需专项验证。 |
| `[perform skill]` | 需验证 | 触发后施放指定技能；职业 token、技能 ID、等级和附加列均需解析，高风险，需实机验证。 |
| `[end skill]` | 需验证 | 触发后结束指定技能；命中较少，职业 token 和技能 ID 必须走 skill registry。 |

## 触发容器与通用参数

| 字段 | 状态 | 读取边界 |
| --- | --- | --- |
| `[if]` / `[then]` | 需验证 | 条件 / 效果容器；必须同时检查 `[/if]` 和 `[/then]`，不能把整个块当作单一机制复制。 |
| `[multiple then]` | 需验证 | 多分支效果容器，内部包含多个完整 `[then] ... [/then]` 分支并以 `[/multiple then]` 结束。目标包有 4 个缺失闭合的残缺出现，正常写法仍必须闭合。 |
| `[then probability]` | 需验证 | `[multiple then]` 各 `[then]` 分支内的单数值权重或二次选择参数；目标值为数字，可见小数。它不替代分支内 `[probability]`，两者需分别保留。 |
| `[module]` | 需验证 | 闭合的适用模块 token 列表，常位于 `[if]`，也可位于外观 `[effect]`。必须读取 `[/module]`；目标 token 包括 `[dungeon type]`、`[pvp type]`、`[room list]` 等，不能从某一样本补齐不存在的模块。 |
| `[target]` | 需验证 | 效果目标选择；只说明作用对象，不说明效果本身。 |
| `[probability]` | 需验证 | 概率或触发概率参数；单位、判定时机、PVP 修正需验证。 |
| `[duration]` | 需验证 | 持续时间参数；单位、刷新、叠加、PVP 修正需验证。 |
| `[equipment duration]` | 需验证 | 装备效果持续时间类字段；不要直接等同于 `[duration]`。 |
| `[cool time]` / `[cooltime]` | 需验证 | 两种拼写同时存在，不能互换；`[cool time]` 可见于装备主段，`[cooltime]` 可见于触发条件块。 |
| `[start cooltime]` | 需验证 | `[if]` 内单整数初始冷却参数；目标样本和官方结构指向毫秒，但具体重置时机仍需实机确认。不要与 `[cooltime]` 合并。 |
| `[pvp]` | 需验证 | PVP 修正或覆盖块；必须检查 `[/pvp]`，块内效果不能直接套用到普通地下城。 |
| `[command]` | 需验证 | 闭合的输入命令显示序列，目标块由方向、分隔符和动作宏组成，必须原样保存并读取 `[/command]`。它不是 `[use command]` 条件的数字参数。 |

注意：字符串属性名 `skill cool time` 可作为属性名出现，但不要误当成括号标签 `[skill cool time]`。

## 触发条件字段

| 字段 | 状态 | 读取边界 |
| --- | --- | --- |
| `[attack success]` | 需验证 | 攻击成功触发条件；常见于 `[if]`，样本数值不授权直接套用。 |
| `[event attack success]` | 需验证 | 事件型攻击成功触发条件；不要和 `[attack success]` 互换。 |
| `[attack condition]` | 需验证 | 攻击条件限定，例如破招、背击等；需和攻击触发字段组合读取。 |
| `[hit]` | 需验证 | 被击或受击触发条件；触发后内容继续读 `[then]`。 |
| `[casting]` | 需验证 | 施放或施法触发条件；不要和 `[cast speed]` 混淆。 |
| `[use skill]` | 需验证 | 使用指定技能触发条件；检查 `[/use skill]`，职业 token 和技能 ID 走 skill registry。 |
| `[event use skill]` | 需验证 | 事件型使用技能触发条件；多组“职业 token + 技能 ID”连续列形需逐组解析。 |
| `[use command]` | 需验证 | 输入命令或使用指令触发条件；命令编号和时机需确认。 |
| `[time]` | 需验证 | `[if]` 内固定三整数时间条件。目标结构与官方注释均指向“间隔、是否循环、初始等待”，时间量纲按毫秒处理；循环和首次触发时机仍需实机确认。 |
| `[set my state]` | 需验证 | `[if]` 内单整数状态变化事件标记，目标样本均为 `1`；它表示条件侧事件，不是把角色设置为某个状态的效果。 |
| `[my state]` | 需验证 | `[if]` 内自身动作状态 token 条件，可见 `attack`、`dash`、`jump attack`、`down`、`die` 等；不是异常状态。 |
| `[target state]` | 需验证 | `[if]` 内目标动作状态 token 条件，可见 `down`、`jump`、`jump attack`、`attack`；不要与 `[target active status]` 混用。 |
| `[target type]` | 需验证 | `[if]` 内目标种族或类型 token；目标值与列形见 `indexes/equipment-conditional-stat-fields.zh-CN.md`。 |
| `[target grade]` | 需验证 | `[if]` 内目标等级类别 token；不要按数字等级解释。 |
| `[party count]` | 需验证 | `[if]` 内比较符与人数；目标可见 `= 1` 至 `= 4`。 |
| `[attacker]` | 需验证 | `[if]` 内攻击来源 token 与整数；目标样本均为 `character -1`，第二列语义未定性。 |
| `[element]` | 需验证 | `[if]` 内攻击元素条件；不要与效果侧 `[elemental weapon]` 混用。 |
| `[stat change]` | 需验证 | 条件侧属性、比较符、单位、数值；目标闭合形态混合，详细见条件属性索引。 |
| `[target stat]` | 需验证 | 条件侧目标属性比较记录；不要与效果侧 `[stat]` 混用。 |
| `[is stat]` | 需验证 | 指定对象属性比较；目标存在非常规比较符拼写，必须原样读取。 |
| `[equipment upgrade]` | 需验证 | 强化或增幅等级条件闭合块；每组四参数，详细见 `indexes/equipment-upgrade-profession-fields.zh-CN.md`。 |
| `[skill]` | 需验证 | 闭合的职业 token 与技能 ID 对列表，常位于 `[if]`。每个 ID 必须按紧邻职业 token 选择 skill registry，并读取 `[/skill]`。 |
| `[my appendage]` | 需验证 | `[if]` 内单整数 appendage 条件；ID 走 `appendage/appendage.lst`。不要因相同数字也存在于技能或物品 registry 而跨表借义。 |
| `[after attack]` | 需验证 | 攻击后触发条件；常与 `[combo]`、`[cooltime]` 组合出现。 |
| `[combo]` | 需验证 | 连击数条件；计数范围、重置和触发时机需实机确认。 |
| `[change status]` | 需验证 | 状态或数值比较条件；不要和异常状态效果 `[active status]` 混淆。 |
| `[dungeon check]` | 需验证 | 副本条件检查块；必须检查 `[/dungeon check]`，副本数字走 dungeon/map 相关 registry 和样本闭合验证。 |
| `[target active status]` | 需验证 | 目标处于指定异常状态的条件；不是施加异常状态效果。 |
| `[my active status]` | 需验证 | 自身处于指定异常状态的条件；不是施加异常状态效果。 |
| `[my active status on]` | 需验证 | 自身刚获得或触发指定异常状态时的事件条件；触发瞬间和刷新规则需验证。 |

## 触发效果字段

| 字段 | 状态 | 读取边界 |
| --- | --- | --- |
| `[buff]` | 需验证 | 触发效果中的 buff 字段；buff 名称或枚举需按同类样本和实机确认。 |
| `[active status]` | 需验证 | 施加异常状态或相关效果；状态名不同，后续参数列可能不同。 |
| `[active status control info]` | 需验证 | 异常状态控制或强化信息；不要和效果侧 `[active status]` 互换。 |
| `[restore]` | 需验证 | 恢复或变更 HP/MP 等数值；正负值形态都可能出现。 |
| `[stat]` | 需验证 | 属性修改字段；常见形态是属性名、运算符和值，需结合 `[target]`、`[duration]`、`[probability]`。 |
| `[stat by condition]` | 需验证 | 按条件生效的属性修改；不要直接等同于 `[stat]`。 |
| `[stat change by stat]` | 需验证 | 按来源属性换算目标属性的八逻辑值效果记录；详细见 `indexes/equipment-conditional-stat-fields.zh-CN.md`。 |
| `[add stat at once]` | 需验证 | 效果侧属性、运算符、数值；字段名不能单独证明只执行一次。 |
| `[variable stat]` | 需验证 | 根级重复八值动态属性闭合块；必须读取 `[/variable stat]`。 |
| `[elemental weapon]` | 需验证 | 效果侧单元素 token，必须结合目标和持续时间读取。 |
| `[weakness]` | 需验证 | 效果侧单数值；HP 削减公式、目标等级缩放和 PVP 行为需实机确认。 |
| `[increase damage]` | 需验证 | 伤害增加字段；不要和 `[add absolute damage]` 互换。 |
| `[add absolute damage]` | 需验证 | 附加绝对伤害字段；公式和叠加规则需实机验证。 |
| `[add absolute defense]` | 需验证 | 绝对防御增加字段；不能只按字段名判断减伤、无敌或防御表现。 |
| `[increase critical damage]` | 需验证 | 效果侧 `%` token 与数值；主要位于 `[then]` 或 `[pvp]` 内，公式和叠加需实机确认。 |
| `[add absolute defense percent]` | 需验证 | 效果侧目标 token 与数值；目标可见 `all` 及正负数，必须结合目标、持续时间和父级读取。 |
| `[reduce duration at pvp module]` | 需验证 | PVP 持续时间缩减参数；与同一效果分支的 `[duration]` 一起读取，不等于 `human armor` 版本。 |
| `[reduce probability at pvp module]` | 需验证 | PVP 概率缩减参数；与同一效果分支的 `[probability]` 一起读取，不等于 `human armor` 版本。 |
| `[reduce duration to human armor at pvp module]` | 需验证 | PVP 中减少对人形护甲目标影响持续时间；需和原始 `[duration]`、目标类型、PVP 语境一起验证。 |
| `[reduce probability to human armor at pvp module]` | 需验证 | PVP 中减少对人形护甲目标影响概率；需和原始 `[probability]`、目标类型、PVP 语境一起验证。 |
| `[appendage]` | 需验证 | 附加状态 / APD 引用线索；ID 必须通过 appendage registry 或目标上下文解析。 |
| `[consume item]` | 需验证 | 效果侧两个整数，按“stackable ID、数量”读取；首列必须通过 `stackable/stackable.lst` 解析。它表示效果执行时的消耗线索，失败条件和实际扣除时机需实机确认。 |
| `[summon monster]` | 需验证 | 效果侧三个整数；目标样本首列通过 `monster/monster.lst` 解析，后两列观察为等级与数量形态。字段语境决定走 monster registry，即使同号也存在于其他表。 |
| `[attack success effect animation]` | 需验证 | 条件侧动画列表，首整数为后续动画条目数，之后重复“`.ani` 路径、X、Y”三列组。路径可含空格，必须按反引号字符串读取，不能按空白切词。 |
| `[rebirth]` | 需验证 | 单一样本确认的闭合效果容器，内部组合 `[probability]`、`[consume item]`、`[hp recovery]`、`[mp recovery]` 和 `[cooltime]`；详细边界见 `indexes/equipment-resistance-stats.zh-CN.md`。 |

## 运行时触发与低频字段路由

- 事件条件、职业和技能过滤、范围属性变化、APC 召唤、发言、驱散、技能霸体和状态转换：见 `indexes/equipment-runtime-trigger-fields.zh-CN.md`。
- 反伤、耐久减少、击退、旧式冰冻或诅咒光环、硬编码参数、过滤器和宠物蓄力修正：见 `indexes/equipment-hardcoded-legacy-fields.zh-CN.md`。
- 这两类字段仍属于 `[if]` / `[then]` 或根级装备机制的一部分；专题索引用于降低本文件密度，不改变父块和 registry 验证要求。

## 禁用入口

| 字段 | 状态 | 读取边界 |
| --- | --- | --- |
| `[passive object]` | 禁用 | 不作为装备效果快速入口；必须专项验证字段语境、registry、被动对象文件、攻击信息和运行表现后才能处理。 |

## 最低验证清单

1. 先确认所在文件是 equipment `.equ`，并读取 `[equipment type]`、`[usable job]` 和相邻块。
2. 对所有容器块，先找闭合标签，再读块体。
3. 对技能相关字段，按职业 token 选择 skill registry；遇到 `[common]` 按专题索引处理。
4. 对装备 ID、技能 ID、副本 ID、appendage ID，不跨 registry 借义。
5. 对 `[if]` / `[then]`，先分清条件侧和效果侧。
6. 对 PVP 修正字段，不外推到普通地下城语境。
7. 对触发效果字段，不只按字段名定性实际表现；需要同类样本或实机验证。
