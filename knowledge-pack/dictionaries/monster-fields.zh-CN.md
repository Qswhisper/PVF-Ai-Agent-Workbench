# Monster 怪物字段词典

本文件只写 monster `.mob` 的纯字段入口。字段出现已经过目标 PVF 只读观察；字段数值效果、AI 行为、攻击伤害、掉落概率和客户端表现仍需目标文件闭合与游戏内验证。

## Registry 与文件边界

### `monster/monster.lst`

状态：默认可用

含义：怪物 ID 注册表。表内数字 ID 指向 `monster/` 下的 `.mob` 文件。

注意：任何怪物 ID 都必须通过此 registry 解析；不能用全局搜索或文件名猜 ID。

### `.mob` 未注册文件

状态：需验证

含义：`monster/` 下可能存在未被 `monster/monster.lst` 直接注册的 `.mob` 文件。

注意：未注册 `.mob` 不能直接当 monster ID 使用；必须继续查 map、dungeon、action、passiveobject、脚本或其他引用链。

## 基础身份与显示

### `[name]`

状态：需验证

含义：怪物名称文本引用入口。

注意：改名字后需要读回和游戏内显示确认。

### `[level]`

状态：需验证

含义：怪物等级字段入口。

注意：等级可能影响面板、难度或其他系统计算；不要只凭数字判断实际战斗强度。

### `[category]`

状态：需验证

含义：怪物类别块。常见内部 token 包括种族、攻击距离、元素或移动/状态分类。

注意：类别 token 是观察到的结构入口，不等于已验证的运行语义。

### `[face image]`

状态：需验证

含义：怪物头像或脸图资源引用入口。

注意：PVF 引用不证明客户端 IMG/NPK 资源存在。

### `[weight]`

状态：需验证

含义：怪物重量字段入口。

注意：实际影响击退、抓取、浮空或碰撞时，需要游戏内验证。

### `[floating height]`

状态：需验证

含义：浮空高度或离地表现字段入口。

注意：表现与受击/碰撞可能联动，不能只看字段名下结论。

## 能力与速度

### `[ability category]`

状态：需验证

含义：怪物能力值块。常见内部 token 包括 `[HP MAX]`、`[EQUIPMENT_PHYSICAL_ATTACK]`、`[EQUIPMENT_MAGICAL_ATTACK]`、`[EQUIPMENT_PHYSICAL_DEFENSE]`、`[EQUIPMENT_MAGICAL_DEFENSE]`。

注意：这些内部 token 常以反引号 token 形式出现；改数值前必须确认目标怪物、难度缩放和实机效果。

### `[ability table]`

状态：需验证

含义：能力表引用或能力表类型入口。

注意：具体表编号含义需要同类样本或实机验证。

### `[attack speed]`

状态：需验证

含义：攻击速度字段入口。

注意：实际攻击节奏还可能受 action、AI、cooltime、attack delay 影响。

### `[cast speed]`

状态：需验证

含义：施放速度字段入口。

注意：是否影响具体技能释放，需要目标怪物攻击链验证。

### `[move speed]`

状态：需验证

含义：移动速度字段入口。

注意：实际移动还可能受 AI、移动 action、目标距离和地图限制影响。

### `[hit recovery]`

状态：需验证

含义：受击恢复或硬直相关字段入口。

注意：手感和受击表现必须游戏内验证。

## AI 与行为

### `[ai pattern]`

状态：需验证

含义：怪物 AI 模式块入口。

注意：只能作为定位 AI/行为的入口；不能从块名直接推断攻击逻辑。

### `[think term]`

状态：需验证

含义：怪物思考间隔或 AI tick 相关字段入口。

注意：实际行为频率需实机验证。

### `[vision]` / `[sight]`

状态：需验证

含义：视野或索敌范围字段入口。

注意：索敌还受 AI、目标选择、地图状态影响。

### `[warlike]`

状态：需验证

含义：好战性或主动性字段入口。

注意：教程解释只能作线索，实际追击和攻击仍需目标样本验证。

### `[attack delay]`

状态：需验证

含义：攻击延迟字段入口。

注意：攻击间隔还可能受 cooltime、action、AI pattern 影响。

### 行为节奏字段的历史目标样本

状态：目标版本已观察，跨版本需验证

含义：一个历史目标客户端的单变量实机记录中，降低既有 `[attack delay]` 后，样本怪物的贴脸散步和攻击间隔减少；缩短 `[think term]` 后长期发呆减少，而放大该值曾出现长期站立。

注意：这只保留字段方向与症状的目标样本，不构成通用倍率、下限或批量配方。攻击 action、技能冷却、AI pattern、地图距离和职业行为仍可能主导结果。批量调节前应从当前 `map / dungeon -> monster` 引用图重新枚举影响面，把共享怪物和特殊机制副本单列；未知上下文保持 unresolved。

### `[targeting nearest]` / `[targeting time term]`

状态：需验证

含义：目标选择或目标确认时间字段入口。

注意：不要单独改这类字段来断言怪物 AI 已改变。

### `[waiting action]` / `[move action]`

状态：需验证

含义：等待、移动 action 引用入口。

注意：action 文件和动画资源需要分别闭合。

## 攻击与动作链

### `[attack info]`

状态：需验证

含义：怪物攻击信息入口，通常用于继续闭合到 `.atk`。

注意：`.atk` 才是后续攻击 payload 的重点；`.mob` 中出现该块不等于已证明伤害。

### `[attack action]`

状态：需验证

含义：攻击 action 引用入口。

注意：需要继续读取 `.act/.ani/.atk` 链；客户端资源也要单独确认。

### `[attack motion]`

状态：需验证

含义：攻击动作或动画配置入口。

注意：动作存在不证明攻击盒或伤害存在。

### `[attack kind]`

状态：需验证

含义：攻击类型字段入口。

注意：类型枚举和运行效果需样本或实机确认。

### `[action list]`

状态：需验证

含义：动作列表块入口。

注意：列表内 action 路径必须逐项闭合。

### `[etc action]` / `[etc attack info]`

状态：需验证

含义：额外动作或额外攻击信息入口。

注意：常用于特殊怪物行为；不要当作通用攻击规则。

### `[superarmor on attack]`

状态：需验证

含义：攻击时霸体或抗打断线索。

注意：实际霸体表现必须游戏内验证。

## 难度、精英与掉落

### `[easy]` / `[medium]` / `[hard]` / `[hero]` / `[ultimate]`

状态：需验证

含义：难度分支或难度参数块入口。

注意：不同 PVF 版本也可能出现 `[normal]`、`[expert]`、`[master]`、`[king]` 等难度标签；不要跨版本硬套。

### `[common champion drop item]`

状态：需验证

含义：普通精英或 champion 掉落相关入口。

注意：掉落物 ID 必须按 equipment/stackable 等正确 registry 解析；掉率需要专项验证。

### `[common champion elemental property]`

状态：需验证

含义：普通精英元素属性相关入口。

注意：元素实际表现需目标样本和实机确认。

### `[level of difficulty]`

状态：需验证

含义：难度等级或难度分支入口。

注意：不等同于 map/dungeon 难度最终规则。

## 音效与表现

### `[damage sound]` / `[die sound]`

状态：需验证

含义：受击和死亡音效资源引用入口。

注意：音效资源属于客户端资源边界。

### `[die effect]`

状态：需验证

含义：死亡效果字段入口。

注意：死亡碎块、特效和表现层需要游戏内确认。

### `[damage action 1]` / `[damage action 2]`

状态：需验证

含义：受击动作引用入口。

注意：动作资源缺失可能导致表现异常。

## 只作补充观察的字段

### 仅补充样本出现的后期字段

状态：需验证

含义：部分后期 PVF 样本存在状态抗性、Boss UI、特殊动作条件和表现类字段。

## AI、召唤、出生与掉落主线

- AI 结构与表达式：见 `dictionaries/monster-ai-fields.zh-CN.md`、`indexes/monster-ai-observed-tag-router.zh-CN.md`、`indexes/monster-ai-expression-router.zh-CN.md`。
- 未注册 `.mob`、召唤、map/dungeon 出生和掉落：见 `indexes/monster-entry-link-router.zh-CN.md`。
- 执行入口：见 `task-cards/monster-ai-summon-spawn-drop-readonly-audit.zh-CN.md`。
- registry 未命中、缺失引用和未观察到入边只作为静态边界记录，不自动修复。
