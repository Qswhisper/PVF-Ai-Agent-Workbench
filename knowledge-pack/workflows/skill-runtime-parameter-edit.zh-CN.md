# 技能运行参数受控修改流程

状态：需验证

用途：处理技能伤害段数、发射速度、持续时间、最大次数、爆炸次数、按键延长、TP/特性覆盖等运行参数修改。本文只写流程，不写实验来源。

## 入口

1. 先确认目标 PVF、输出 PVF 和编码策略。
2. 按角色入口解析：`character/character.lst` -> `.chr [job]` -> `skill/skilllist.lst` -> 具体职业技能 `.lst`。
3. `at` 前缀按独立角色/分支 token 处理，例如 `atgunner`、`atmage`、`atfighter` 不等于 `gunner`、`mage`、`fighter` 的觉醒阶段。
4. 只用技能名搜索作为定位线索；最终路径以目标 PVF registry 闭合为准。

## 读数

1. 读取基础 `.skl` 的 `[static data]`、`[level info]`、`[level property]`、`[special level up]`。
2. 同时读取 `[maximum level]`、`[growtype maximum level]`、`[skill fitness growtype]` 与实际技能树/默认入口，确定玩家在目标构建中的可达等级。`[level info]` 末行只是表中数据，不能自动作为修改基准。
3. 查知识包的结构化参数事实，定位候选列；候选列必须在目标 `.skl` 中实际存在，并确认运行参数读取 `[static data]` 还是当前等级的 `[level info]`。
4. 如果存在 TP/特性/Ex 对应技能，继续读取对应 `*ex.skl` 或技能树指向的特性技能。
5. 如果参数影响 passiveobject、attackinfo、ANI/ATK、NUT state/substate，继续闭合到对应文件，不只改 `.skl`。

## 修改

1. 优先做最小改动：只改已定位字段，不重排整段表。
2. 基础技能与 TP/特性技能需要同一手感或同一效果时，同步修改对应 Ex/TP 文件。
3. PVF 文本替换必须使用原始读取文本：不使用简体显示转换文本，不写 `&#数字;` HTML 实体。
4. dry-run 后再 apply；保存到明确输出 PVF，不覆盖源 PVF。
5. `.skl` 中已确认可见文字标签的 ` ex` 备用变体自动继承同一权限，例如 `[explain ex]`、`[basic explain ex]` 和以后同构的 `[skill explain ex]`；未知基础标签不会仅凭后缀获准。每次仍只把一个完整可见反引号 token 改为另一个完整 token，并使用目标 raw 读回确认的 `Cn` 或 `Tw` 与 `verified-inline-text`。相同完整文字出现多次时必须 `replaceAll=true` 加精确 `expectedOccurrences`，并通过临时独立 PVF 往返；非 `.skl`、部分 token、StringLink 或未计数重复仍保持阻断。

## 验证

1. 把三种验收分开记录：写入/读回是否闭合、玩家可感知的设计目标是否达成、实机效果是否成立。技术链 PASS 不能自动写成设计或运行 PASS。
2. 涉及段数、tick、频率、持续时间或对象数量时，用单段倍率、理论有效段数/轮数和命中覆盖先做总量筛查预算；首尾 tick、取整、重叠命中与命中率变化仍须 A/B 实机确认，不能由公式直接宣布总伤害或手感结果。
3. 写后读回目标文件，确认目标列值和中文文本均未乱码。
4. 实机至少覆盖：不点 TP、点 TP、普通按键、按住或连按键。
5. 视觉类修改要额外确认模型、特效、爆炸、范围表现；PVF 数值变化不等于客户端视觉变化。
6. 手感类修改要确认动作速度、前后摇、最大次数、连击段数和异常状态是否符合预期。

## 禁止

- 不把 `*ex.skl` 当觉醒文件；它通常是 TP/特性或扩展技能候选，具体含义以目标 PVF 为准。
- 不把 `at` 角色目录当觉醒目录。
- 不从显示说明直接推断字段真实运行效果。
- 不把某个技能样本的列义外推到同职业全部技能。
