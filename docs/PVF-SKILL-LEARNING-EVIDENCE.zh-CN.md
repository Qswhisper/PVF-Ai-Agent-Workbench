# 当前学习字段与引用的只读取证

该命令在同一只读会话中重新核验完整角色／技能登记关系，再读取角色及已登记技能的原始字节。它提供后续语义审计的材料，不计算可玩职业、候选技能或最终可学等级，不修改任何 PVF 或客户端资源。

```bat
workbench.bat pvf-read skill-learning-audit --pvf "D:\TaskInput\Script.pvf" --out "D:\TaskEvidence\learning.json"
```

首次定位仍遵守 AGENTS.md 的路由。命令内部在读取前后核验完整源 SHA256；任务要求的首次及最终 fingerprint 仍须执行。输出只能是新的外部文件，不能覆盖输入目录、工作台或既有报告。

## 取证范围

- 先从当前 `character/character.lst`、`skill/skilllist.lst` 建立登记身份，再读全部登记的 `.chr`、职业 `.lst`、`.skl`。登记覆盖及限制与 `PVF-SKILL-IDENTITY.zh-CN.md` 相同。
- 角色侧保留 `[growtype name]`、`[awakening name]`、`[skill]`、`[awakening skill]` 的全部出现位置，并记录前面最近出现的成长／觉醒标签。这里的父上下文仅表示文本顺序，不是运行时枚举映射。
- 技能侧保留 `[type]`、`[skill class]`、`[required level]`、`[required level range]`、`[purchase cost]`、`[special purchase cost]`、`[maximum level]`、`[growtype maximum level]`、`[skill fitness growtype]`、`[pre required skill]`、`[feature skill index]`。
- 只把原始 type-5 token 视为标签。每次出现保留字节范围、下一标签、值的原始类型和位模式；说明文字内的同名文本不产生字段。
- 字符串保留原始条目哈希和长度；只有可确定的 ASCII 才显示文字。非 ASCII 名称不猜编码或推导职业关系。
- 未出现的字段记录为缺失；重复字段全部保留，不取第一项或最后一项覆盖。部分字段本来是可选的，所以“缺失”不自动等于文件损坏。重复可能涉及不同模式，当前不合并或解释模式作用域。

默认／觉醒／前置技能字段仅在完整闭合、整数成对的情况下解析引用；特性技能索引必须恰好一个整数。每个 ID 只在所属角色的当前技能登记表中查找。完整引用保留来源偏移、声明等级及目标路径／原始哈希；不授权迁移或修改引用。问题条目的 `ownerSkillId` 是引用来源技能，`skillId` 是被引用的目标，不得混淆。

## 如何理解结果

`observationComplete` 表示该范围的字段取证完成；不等于全部引用闭合，更不等于技能可学。`ok` 只有在取证完整且没有登记／引用问题时为 true，其含义仍仅限本命令范围。任何情况下 `semanticContractReady` 和 `authorizesPvfGeneration` 都是 false。

问题按完整明细保留在外部报告；命令输出最多展示 50 项，并显式标记是否截断。任一登记、读取或引用问题使退出码非零，但不会丢弃已经取得的其他证据。错误 ID 不会跨职业找同号替代，格式无法解释时不部分接受。

登记读回与字段观察之间还会逐文件比较原始哈希，字符串表也必须相同。源漂移、读取不完整或未知格式不会作为成功。

## 尚未证明

- 成长块编号、名称列表序号、技能适配值和上限数组列位之间的运行时映射。
- 转职是否开放、角色是否可创建、技能是否实际可学习或默认获得。
- 实际等级上限、学习点数与前置条件是否在客户端／服务端生效。
- 技能树、AutoSkill、PVP 规则、装备加成及运行授予链。它们不能由本报告相互替代。
- 气息参数列含义、正向维度、装备部位、武器适用关系与池分配。

不得把 `[maximum level]`、数组容量或参数表末行直接当成可玩契约上限。缺少上下文时保留 unresolved；不能为获得通过而删除疑点、猜转职枚举或沿用历史答案。本检查尚未接入修改生成的语义门禁。

新一轮重建不得读取或复用任何旧职业、旧技能、旧参数或旧池资料作为答案。当前原始字段也是待解释证据，不是气息候选表。

## 维护验证

```bat
workbench.bat pvf-read skill-learning-self-test
workbench.bat pvf-read skill-identity-self-test
workbench.bat fallback-self-test
```

专用测试使用虚构内容和真实格式的合成 PVF，覆盖职业隔离、缺失／重复／空字段、字面伪标签、引用形状和目标缺失、来源与目标 ID 区分、原始位模式、源漂移以及公开 CLI。真实 PVF、测试产物和机器路径均不进入工作台。
