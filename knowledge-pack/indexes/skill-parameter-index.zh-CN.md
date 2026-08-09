# 技能参数列查询入口

状态：需验证

## 用途

本入口用于查询技能 `.skl` 中 `[static data]`、`[level info]`、`[level property]` 的候选列含义。它只帮助定位参数列，不证明运行效果，也不授权直接写 PVF。

知识包内置结构化事实表 `indexes/skill-parameter-facts.compact.json`。它以 `.skl` 路径为主键，提供职业目录、技能名、静态/动态列号、列说明和倍率线索。这些信息只负责定位；目标版本是否存在该结构、列数是否一致以及运行效果，仍以目标 `.skl` 读回和必要实机验证为准。

## 查询顺序

1. 确认目标 PVF 和目标职业。
2. 已给技能 ID 时用 `pvf-read resolve-skill` 通过目标 `.chr` 与职业 skill registry 一次解析 `.skl` 路径；成功后不再猜路径或枚举目录。
3. 用技能名、职业目录或 `.skl` 路径查内置结构化事实表。
4. 读取目标 PVF 中对应 `.skl`，核对 `[static data]`、`[level info]` 或 `[level property]` 是否存在。
5. 核对列数、列顺序和技能上下文；列数不一致时只记录为线索。
6. 写 PVF 前仍走 PVF 安全写入流程、显式输出和读回。

## 可用信息

- 技能名和职业目录。
- 技能 `.skl` 路径线索。
- `[static data]` 的列号和说明线索。
- `[level info]` 的列号和说明线索。
- `[level property]` 中引用的静态列或动态列线索。

## 机器查询示例

`千手奥义` 的发射速度查询应能只依赖 knowledge-pack 完成：

```text
indexes/skill-parameter-facts.compact.json
lookup.bySkillName["千手奥义"] -> ["skill/atfighter/1000hands1000eyes.skl"]
entriesByPath["skill/atfighter/1000hands1000eyes.skl"].level.meanings[1] -> column 1 / 发射速度增加 / %%
```

这表示候选修改点在目标 `.skl` 的 `[level info]` 第 `1` 列；仍需回目标 PVF 读取该技能实际列数和上下文。

## 边界

- 本结构化事实表只表示候选字段含义和列位置，默认状态为 `需验证`。
- 技能名、路径或列说明不能单独证明目标 PVF 的真实运行行为。
- 不同 PVF、不同版本、不同职业分支的列数可能不同。
- `[level property]` 中的“静态 n / 动态 n”只能作为候选映射，必须回目标 `.skl` 复核。
- 实机结论仍以目标 PVF 写入、读回和游戏内验证为准。

## 相关入口

- `task-cards/skill-parameter-current-value-readonly-query.zh-CN.md`
- `indexes/skill-parameter-routes.json`
- `indexes/skill-parameter-facts.compact.json`
- `dictionaries/skill-static-level-parameter-columns.zh-CN.md`
- `task-cards/skill-state-nut-runtime-readonly-audit.zh-CN.md`
- `workflows/skill-derivative-and-cancel.zh-CN.md`
- `workflows/skill-runtime-parameter-edit.zh-CN.md`
- `dictionaries/skill-static-level-parameter-columns.zh-CN.md`
