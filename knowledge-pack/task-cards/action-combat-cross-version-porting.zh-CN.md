# DNF动作游戏现代化改造任务卡

状态：默认可用

用途：当目标是在原版 DNF 体系内加入“主动顶招 / 拼刀奖励 / protection-only 顶招 / 不屈意志读条保护 / 破招专题评估”时使用。本文是短入口；具体实现顺序和代码形态见 `workflows/action-combat-cross-version-porting.zh-CN.md`。

## 先读

1. `safety/README.zh-CN.md`
2. `task-cards/pvf-registry-lst-topology-readonly-audit.zh-CN.md`
3. `task-cards/skill-state-nut-runtime-readonly-audit.zh-CN.md`
4. `dictionaries/skill-learnability-command-cooldown-fields.zh-CN.md`
5. `dictionaries/nut-runtime-api-boundary-quick.zh-CN.md`
6. `workflows/action-combat-cross-version-porting.zh-CN.md`

## 默认策略

- 优先按名称在目标职业 skill registry 中解析 `基础精通 / BasicAttackUp`，再读回实际 `.skl`、`[name]` 和 `[name2]`；不保存或迁移任何版本的常见数字 ID。目标没有同一入口时保持 unresolved，并从实际加载链重新选择锚点。
- 不把短期存在、已隐藏、派生或版本限定技能作为体系基础；这类技能最多作为目标 PVF 的历史线索。
- 优先在职业 passive 入口挂载常驻 appendage；只有主动技能释放时机确实需要补挂，才在 `onUseSkill` 或同等入口做最小补充。
- 先做代表样本，不做全职业一次性铺开。每个职业分支先选短前摇、近身、主动命中清楚的技能验证。
- 代表样本全部通过后，改为按职业批处理：每轮集中一个职业，扫描该职业全技能，证据清楚且同类型的候选可以同包落地，方便实机一次性测试该职业；跨职业仍分批。
- 已验证收束后的默认四类改造是：普通相杀 / 拼刀、protection-only 顶招、不屈意志读条减伤、破招专题边界。
- 减伤上限、protection-only 预算和慢启动余量都是目标版本调参项；从目标已有实现、动作节奏和单变量实机结果确定，不继承历史目标数值。
- 不屈意志先闭合目标技能树、默认入口和实际可达等级；只在 buff 存在且当前读条 / 投掷态成立时提供减伤，读条尾窗按目标时钟口径实测，不强制某个等级或固定毫秒数。
- 普通 / 精英 / Boss 被反制后的状态时间默认先统一，不急于细分；静态攻击包 hitstun 字段不能当作统一硬直方案。

## 核心规则

- 有效霸体或保护窗口内只先给玩家保护和减伤，不在受击瞬间直接控怪。
- 只有近身、主动、非 APC 的攻击来源可以进入反制候选。
- 必须玩家技能命中确认后，才允许把候选来源转成控制或奖励。
- 远程、脱手、召唤、地面残留、长距离弹体默认只保护玩家，不控制远处发起者。
- 空顶、打空、只进入保护窗口但玩家没有命中，不触发控制奖励。
- APC 默认不被控；如果目标版本需要 PVP / APC 行为，必须另开专项验证。
- 长演出、抓取、大范围或无清晰近身相杀点的技能默认 `protection-only`。
- protection-only 只减伤，不打开命中确认反制窗口，不发送反制控制包。
- 不屈意志读条保护只减伤，不属于相杀，不控怪。
- 破招奖励只有在能可靠证明敌人处于攻击态时才进入实现；不能为了实现而给原本非霸体的抓取 / 破招技能硬加霸体。

## 只读闭合

1. 确认目标 PVF、是否允许输出新 PVF、是否有实机验证。
2. 解析 `character/character.lst`、`skill/skilllist.lst` 和目标职业 skill registry。
3. 解析并读回 `基础精通 / BasicAttackUp` 的 `.skl`，不要只相信数字。
4. 闭合目标职业的 `load_state`、`passive_skill_<job>.nut`、appendage 脚本和候选主动技能入口。
5. 查目标 PVF 是否已有 appendage helper、对象查找、距离、阵营、APC 判断、hit confirm 或控制 API；没有 内置 NUT API 事实目录 或目标脚本证据时不要补 API 名。

## 写入边界

- 写 PVF 必须使用受控 change-set、显式输出、备份、manifest 和读回。
- 修改既有 appendage `.nut` 时只使用 `pvf-existing-nut-controlled-change.zh-CN.md`；原文 SHA256、目标路径作为函数调用参数的 load_state/passive/appendage 加载链、目标 API、函数/APID、临时与最终独立文本/原始字节 SHA256 读回缺一项即停止。静态通过不证明状态抗性数值或时序正确。
- 不覆盖源 PVF。
- 不改客户端资源，除非用户单独授权。
- 不把当前项目路径、历史报告、运行输出或证据链写进 clean knowledge。

## 最小验收

- registry 已确认 `基础精通 / BasicAttackUp`。
- appendage 确认由目标职业实际加载。
- 近身主动命中可触发保护和奖励。
- 空顶不控。
- 远程 / 脱手只保护不控远处来源。
- APC 不控。
- 长演出技能没有被误改成强控。
- protection-only 技能只减伤不控怪。
- 不屈意志 buff 期间读条减伤，非不屈或非读条不减伤。
- 破招专题如果无法可靠区分敌人攻击态，应记录为专题暂缓，不进入稳定包。
- 进入职业内批处理后，每个新增普通反制技能至少验证近身命中与打空边界；远程/脱手、APC、长演出 protection-only 可按同职业包抽代表回归。

## 反馈吸收分类

后续收到实机反馈时，先分类再行动：

| 分类 | 处理 |
| --- | --- |
| PASS 登记 | 记录通过，不要求重复测试。 |
| 测试卡口径问题 | 修正文档或测试项，不改 PVF。 |
| 技能栏不可达 | 记录为不可达，不算失败。 |
| protection-only 正常表现 | 说明这是只减伤不控怪，不算普通相杀失败。 |
| PVF 行为错误 | 只回退或修正对应技能 / 类型，不轻易回退整个职业分支。 |
| 信息不足 | 先要求最小补充信息，不默认要求整轮重测。 |
