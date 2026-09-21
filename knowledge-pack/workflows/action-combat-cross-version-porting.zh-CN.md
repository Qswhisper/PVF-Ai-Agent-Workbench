# DNF动作游戏现代化改造跨版本复刻流程

状态：默认可用

用途：把“主动顶招 / 拼刀奖励 / 相杀反馈 / protection-only 顶招 / 不屈意志读条保护”复刻到其他 DNF PVF 版本，并为破招专题提供边界判断。目标是在原版职业、技能、霸体、抓取、读条和 appendage 体系内补一层现代化反馈，不把 DNF 改成另一套动作游戏规则。

## 输入

1. 目标 `Script.pvf`。
2. 要覆盖的职业分支和代表技能。
3. 是否允许输出新 PVF。
4. 是否可做实机验证。

没有明确输出授权时，只做只读评估和方案。

## 总原则

- 优先按名称在目标职业 skill registry 中解析 `基础精通 / BasicAttackUp`，并读回实际 `.skl`；不把任何版本的常见数字 ID 当搜索或迁移事实。目标没有同一入口时保持 unresolved，并从实际加载链重新选择锚点。
- 只有目标 registry、职业 passive 与加载链共同证明入口稳定时，才把它作为该目标的挂载锚点；短期存在、隐藏、派生或版本限定技能不作为体系基础。
- 拼刀奖励必须分成两段：受击保护阶段只记录候选，玩家技能命中确认后才执行控制或奖励。
- 近身主动来源才允许反制；远程、脱手、召唤、残留和长距离弹体只保护玩家。
- 长演出、抓取、大范围压制、全屏或无清晰近身相杀点的技能默认只加保护，不加控怪。
- APC 默认不控。PVP、APC 或服务端同步规则需要单独任务验证。
- 减伤上限必须从目标已有实现、设计要求和实机结果确定；历史目标数值不进入跨版本起点。
- protection-only 预算必须按目标动作和回调节奏测定；普通与慢启动技能可以分组，但每组都从本目标单变量实测起步。
- 不屈意志读条保护只在 buff 存在且当前处于读条 / 投掷态时生效；尾窗余量从目标时钟口径和实机结果确定，不迁移固定毫秒数。
- 普通 / 精英 / Boss 的反制状态时间默认先统一，稳定后再考虑细分。
- 静态攻击包 hitstun 字段不能视为统一硬直方案；硬直若无法跨怪物稳定控制，应退回统一状态时间。

## 四类改造

| 类型 | 默认处理 |
| --- | --- |
| 普通相杀 / 拼刀 | 玩家有效窗口受击时只记录候选；玩家命中确认后才控近身非 APC 来源。 |
| protection-only 顶招 | 只给短预算减伤，不记录反制候选，不控怪。 |
| 不屈意志读条保护 | 不屈 buff 期间，读条 / 投掷态被攻击时减伤；非不屈或非读条不生效。 |
| 破招专题 | 只有可靠敌方攻击态证据时才实现；否则记录为专题暂缓。 |

## 只读定位

1. 读取 `character/character.lst`，确认职业 token 和分支。
2. 读取 `skill/skilllist.lst`，找到该职业的 skill registry。
3. 在职业 skill registry 中解析 `基础精通 / BasicAttackUp`，记录 ID、路径、`[name]`、`[name2]`、`[type]`。
4. 读取该职业 `load_state`，确认 `passive_skill_<job>.nut` 和 appendage 脚本是否会被加载。
5. 读取职业 passive 文件，确认 `ProcPassiveSkill_<job>` 或同等被动入口。
6. 读取候选主动技能的 `.skl`、state/substate、NUT 入口和攻击判定链。
7. 若需要控制怪物，先确认目标 PVF 中已有可用控制 API 或同职业样本；没有 内置 NUT API 事实目录 或目标脚本证据时不要发明函数名。

## 调用形态与回调可达性

1. 对精确 API / 回调名先查内置声明，再查目标脚本。内置签名只说明候选形状，不证明目标对象上可调用。
2. `search-script` 0 命中不等于 `.nut` 中不存在该符号。只有当 `load_state`、回调注册、依赖链或已建账来源给出精确路径时，才直接读取该路径；否则保持 unresolved，不猜文件名。
3. 沿 `load_state -> passive_skill -> appendage` 闭合加载链，并在 appendage 内同时读取 `sq_AddFunctionName` 注册和对应函数定义。参数个数、顺序和对象类型以目标定义为准。
4. 类静态调用、对象实例调用和同名 helper 是不同调用形态。目标先例与内置声明不一致时，不靠 try/catch 吞错猜测；用一个变量一轮的实机 A/B 裁定。
5. “脚本已加载”不等于“每个状态都触发同一回调”。按普通动作、攻击类读条、buff 类读条、长演出、死亡 / 换图等任务相关状态建立回调可达性矩阵；只把实际测过的格子写成 PASS。
6. 回调与调用形态的 PASS 绑定目标 PVF SHA、客户端和前置状态。迁移版本时重新闭合，不把一次目标实测写成引擎通则。

## 挂载形态

优先使用职业 passive 入口按 `基础精通` 挂载 appendage。示例只表达结构，函数名和 helper 必须换成目标 PVF 已存在写法：

```nut
function ProcPassiveSkill_<job>(obj, skillIndex, skillLevel)
{
    if (!obj) return;

    if (skillIndex == BASIC_ATTACK_UP_ID)
    {
        attachOrRefreshActionClashAppendage(obj, skillLevel);
    }
}
```

如果目标职业的 passive 刷新时机不足，才在主动技能使用入口补挂。补挂只解决 appendage 存在性，不把主动技能入口写成反制成功条件：

```nut
function onUseSkill_<job>(obj, skillIndex, consumeMp, consumeItem, oldSkillMpRate)
{
    if (!obj) return false;

    if (isActionClashCandidateSkill(skillIndex))
    {
        attachOrRefreshActionClashAppendage(obj, getBasicAttackUpLevel(obj));
    }

    return false;
}
```

## Appendage 状态模型

appendage 至少拆成四类状态：

| 状态 | 含义 |
| --- | --- |
| `protectWindow` | 当前技能帧允许保护或减伤。 |
| `counterWindow` | 当前技能帧允许记录近身主动来源。 |
| `pendingSource` | 最近一次合格攻击来源，只是候选，不是控制对象。 |
| `hitConfirmTtl` | 候选等待玩家命中的短时限，过期即清。 |

不要把“玩家被打到”直接等同于“怪物被控”。受击回调只能记录候选和保护，真正奖励必须由玩家命中确认触发。

稳定实现还可以增加这些状态：

| 状态 | 含义 |
| --- | --- |
| `longProtectWindow` | protection-only 短减伤窗口。 |
| `superArmorOnCastWindow` | 不屈意志 buff 检测窗口。 |
| `entryActive` | 防止按下技能瞬间重复开窗。 |
| `packetCooldown` | 反制包冷却，避免同一瞬间重复发包。 |

## 保护与候选

受击阶段的伪代码仅表达语义；回调名、参数个数和顺序必须复制目标注册与函数定义，不能照抄占位签名：

```nut
function <registered_damage_callback>(<target_verified_parameters>)
{
    if (!isEffectiveProtectionWindow(appendage))
    {
        return <target_damage_rate>;
    }

    local protectedRate = calcProtectedDamageRate(<target_damage_rate>);

    if (!isNearActiveNonApcSource(appendage, attacker))
    {
        return protectedRate;
    }

    rememberPendingSource(appendage, attacker, getCurrentTick() + HIT_CONFIRM_TTL);
    return protectedRate;
}
```

判断 `isNearActiveNonApcSource` 时，至少包含：

- 攻击来源仍存在。
- 来源不是 APC。
- 来源与玩家距离在近身阈值内。
- 当前攻击不是远程弹体、脱手对象、召唤物或残留场。
- 当前玩家技能帧允许相杀候选，不是全技能常开。

减伤形态示意；上限必须由目标证据提供：

```nut
function calcProtectedDamageRate(damageRate, targetVerifiedRateCap)
{
    if (damageRate > targetVerifiedRateCap) return targetVerifiedRateCap;
    return damageRate;
}
```

常规 protection-only：

```nut
if (isLongProtectWindow(appendage))
{
    return calcProtectedDamageRate(damageRate);
}
```

protection-only 分支不得继续打开普通反制窗口。

## 命中确认

玩家命中阶段的伪代码：

```nut
function onAttackParent(appendage, attacker, damager, boundingBox, isStuck)
{
    if (isStuck) return;
    if (!isPlayerSkillHitConfirmed(appendage, attacker, damager)) return;

    local source = consumePendingSource(appendage);
    if (!source) return;
    if (!canApplyActionClashReward(appendage, source)) return;

    applyActionClashReward(appendage, source);
}
```

`isPlayerSkillHitConfirmed` 必须来自目标 PVF 的实际命中入口或同等可证明链路。不能用按键、进入 state、进入保护帧、播放动画或创建 passiveobject 代替命中确认。

如果当前处于 protection-only 或不屈读条保护，应直接返回，不触发反制：

```nut
if (isProtectionOnlyWindow(appendage)) return;
if (isSuperArmorOnCastCastingWindow(appendage)) return;
```

## 不屈意志读条保护

默认步骤：

1. 按名称在目标职业 registry 中解析 `不屈意志 / SuperArmorOnCast / Great Willpower`，不得使用其他版本的数字 ID。
2. 读回对应 `.skl`、技能树和默认入口，结合 `[maximum level]`、`[growtype maximum level]` 确认本目标的实际可达等级；不得强制改成历史等级。
3. 在职业 appendage 中检测 buff state 与读条 / 投掷态。
4. 只在不屈 buff 存在时，对当前读条技能按目标确认的 `castTime + 尾窗余量` 收口；尾窗余量必须在本目标重测。
5. 在 `getImmuneTypeDamageRate` 中只做减伤，不控怪。

伪代码：

```nut
function isSuperArmorOnCastCastingWindow(obj)
{
    if (!hasSuperArmorOnCastBuff(obj)) return false;

    local skillIndex = getCurrentCastSkillIndex(obj);
    if (skillIndex <= 0) return false;
    if (skillIndex == SUPERARMORONCAST_SKILL_ID) return false;

    local skillLevel = sq_GetSkillLevel(obj, skillIndex);
    if (skillLevel <= 0) return false;

    local castTime = sq_GetCastTime(obj, skillIndex, skillLevel);
    if (castTime <= 0) return false;

    local tailMargin = getTargetVerifiedCastTailMargin(obj, skillIndex);
    return getStateTimer(obj) <= castTime + tailMargin;
}
```

不要把不屈 buff 持续时间当成所有技能的全程减伤时间。

## 技能分类

| 类型 | 默认处理 |
| --- | --- |
| 短前摇近身主动技能 | 可做拼刀奖励候选。 |
| 位移突进但攻击点贴身 | 可做候选，但要限制有效帧和距离。 |
| 远程弹体 | 保护玩家，不控远处来源。 |
| 脱手对象 / 召唤物 / 地面残留 | 保护玩家，不控来源。 |
| 长演出 / 抓取 / 大范围压制 | 默认 `protection-only`。 |
| APC 参与 | 默认不控，另开专项。 |
| 慢启动但有明确准备动作 | 可给短 protection-only；预算按目标动作节奏实测，不继承历史数值。 |
| 不屈期间读条 | 只给读条减伤，不控怪。 |
| 短破招抓取 | 若无法可靠检测敌人攻击态，专题暂缓。 |

## 推荐推进顺序

1. 只读审计一个职业分支，确认 `基础精通`、passive 入口、appendage 加载和一个近身代表技能。
2. 做一个最小输出 PVF，只覆盖该职业一个近身代表技能。
3. 实机验证近身成功、空顶、远程来源、APC 或等价排除项。
4. 第二步扩到同职业另一个技能类型，确认 `protection-only` 边界。
5. 再扩到其他职业分支，每个分支先一个代表样本。
6. 全职业代表样本都通过后，进入“职业内批处理”：每轮围绕一个职业扫描全技能，按真实霸体帧、攻击帧、近身来源、远程/脱手、抓取/强控、长演出分类；证据清楚且同类型的技能可以同包落地，便于实机一次性测试该职业。
7. 跨职业不要一次性混包。一个职业批处理通过后，再换下一个职业。
8. 全职业稳定后，再引入不屈意志读条保护，并独立测试 buff 期间 / 非 buff 期间 / 读条 / 非读条边界。
9. 最后才考虑批量统一反馈、震屏、音效或数值。

## 职业内批处理

适用前提：目标版本已经完成全职业或目标职业集合的代表样本验证，且核心规则已经通过实机回归。

职业内批处理的目标不是“把该职业所有技能都改成反制”，而是让玩家可以用一个职业集中测试这一轮所有新增候选。

批处理时按技能分层：

| 分层 | 默认处理 |
| --- | --- |
| 短前摇、近身、真实霸体帧与攻击帧重叠 | 可同包加入普通拼刀候选。 |
| 位移突进、攻击点贴身、真实霸体帧清楚 | 可同包加入，但限制有效帧和距离。 |
| 蓄满释放型 | 只保护释放攻击段，不保护按下技能和蓄力等待。 |
| 长演出、大范围压制、强控、抓取 | 默认 `protection-only` 或专题，不混入普通反制。 |
| 远程弹体、脱手对象、召唤、地面残留 | 只保护玩家，不控远处来源。 |
| 无真实霸体证据或共享 state 无法区分 | 暂缓，不写入。 |

批处理测试预算：

- 覆盖分母来自目标版本中玩家当前实际可达的技能集，不从 registry 总数或历史清单推导。报告分别列出 `passed / failed / unreachable / deferred / not-run`；已注册但当前不可学、不可触发或不可进入的技能既不算 PASS，也不算 FAIL。
- 每个新增普通反制技能至少测“近身顶招并命中”和“顶住但未命中/打空”。
- 远程/脱手隔离、APC 不控、长演出 protection-only 可以按同职业包抽代表回归，不必每个新增技能重复全套。
- 任何一个技能出现共享 state 误判、空顶也控、远程反控、长演出强控，应只回退该技能或该类型，不要回退整个职业分支。
- 单技能 PASS 必须能回到该技能的规范原始运行观察；汇总覆盖表不能替代这份记录，也不能把 `unreachable / deferred / not-run` 折算为通过。

## 低测试量验收组合

每个新职业分支最少覆盖：

- 近身主动命中：玩家受保护，命中确认后触发奖励。
- 空顶：进入保护窗口但未命中，不控怪。
- 远程或脱手来源：玩家受保护，不控远处来源。
- 长演出样本：只保护，不新增强控。
- APC 或等价排除对象：不被控。
- protection-only 样本：只减伤，不控怪。
- 不屈读条样本：buff 期间读条减伤，非 buff 或非读条不减伤。

如果目标版本没有合适 APC 或远程样本，可记录为未覆盖，不能写成已验证。

## 运行证据复用边界

任何行为结论只绑定记录中的 PVF SHA、职业、技能、客户端和前置条件。迁移到新目标时必须重新闭合 `基础精通`、职业 passive、appendage、技能窗口和 API 使用点；远程 / 脱手、APC、不屈读条、PVP、同步和客户端资源没有对应证据时保持未覆盖。

## 破招专题边界

短破招技能常见问题是：技能本身如果没有霸体，敌人先命中玩家会打断技能；为了实现破招而给技能硬加霸体，会改变原版设定。

只有同时满足以下条件才进入实现：

- 能可靠证明敌人当前处于攻击态。
- 该判断不会把 idle / 非攻击目标误判为破招成功。
- 技能原设定允许在目标攻击中完成接触或抓取。
- 奖励不依赖给原本非霸体技能硬加霸体。

如果只能在命中回调中读到不可靠的 `getAttackIndex`、`isMeleeAttack`、`getCurrentSkillIndex` 等线索，应记录为诊断失败或专题暂缓，不进入稳定包。

## 常见失败

- 把 `基础精通` 的常见数字当成全局事实，没有通过目标 registry 读回。
- 依赖短期隐藏或派生技能，导致其他版本没有入口。
- 在受击回调里直接控怪，造成空顶也控。
- 用进入 state 代替命中确认，造成打空也奖励。
- 远程弹体反向控制施法者，破坏原版远程技能逻辑。
- 把 long animation 全部改成强反制，导致原版演出和副本节奏失真。
- 未区分 `atgunner`、`atmage`、`atfighter` 等独立分支。
- 把 protection-only 误判为相杀失败。
- 把不屈 buff 持续时间误写成所有技能全程减伤。
- 把攻击包 hitstun 字段当成统一硬直方案。
- 在没有可靠敌方攻击态证据时强做破招。
- 为破招给原本非霸体技能硬加霸体。

## 输出规则

允许写入时，必须：

1. 使用受控 change-set。
2. dry-run 确认全部命中且无阻塞。
3. 输出到新 PVF，不覆盖源 PVF。
4. 创建备份和 manifest。
5. 读回目标文件，确认 appendage、passive、主动入口与中文文本未损坏。
6. 把仍需实机验证的项目明确列出。
