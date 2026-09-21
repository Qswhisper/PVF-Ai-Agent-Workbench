# 副本复活币限制结构族只读核查

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `task-cards/pvf-entity-name-search-readonly.zh-CN.md`
- `task-cards/validated-dungeon-numeric-tuning-readonly.zh-CN.md`
- `task-cards/complex-dungeon-mechanism-shell-readonly-audit.zh-CN.md`
- `dictionaries/hellparty-visualization-fields.zh-CN.md`

## 适用

用于核查 `.dgn` 中的 `[coin limit]`、`[character coin limit]`、`[party member coin limit]`、`[coin info]` 及其实际生效边界。该字段族在普通、组队、塔式或其他特殊副本中可能采用不同机制壳；本卡不把任一组合写成全版本默认模板，也不授权批量插入字段。

## 执行

1. 用户给出副本名称时先走 dungeon `SearchName`，用目标 `dungeon/dungeon.lst` 确认每个返回路径和 ID；同名 event/standard 变体分别保留，不能只读一份。
2. 完整读取目标 `.dgn`，逐项记录 `[coin limit]`、`[character coin limit]`、`[party member coin limit]`、`[coin info]` 的存在性、原始值、块边界和精确出现次数。缺字段、空块和重复标签分别报告。
3. 同时记录可能决定副本结构族的字段，至少包括 `[hell dungeon]`、塔式/竞技/事件相关入口和目标中观察到的其他机制壳。不要只按路径名或等级把副本分组。
4. `[hell dungeon]` 先按“深渊配置静态线索”处理。历史目标曾观察到它与普通副本复活限制生效相关，但该局部实机结果不能把它提升为通用复活开关；无条件新增还可能改变深渊入口、事件怪或客户端流程。
5. 特殊机制壳可能覆盖普通复活字段。历史目标曾观察到 coin 字段可解析且静态存在，但死亡后仍被机制壳禁止复活；这种负例要求先判定副本机制族，不能继续堆同类字段或把解析成功写成生效。
6. 做批量审计时按“已有字段组合 + 机制壳”分类，再为每类选择代表样本；不得给全部 `.dgn` 无条件追加同一段。已有标签必须精确计数，重复标签是停止信号，不是成功覆盖。
7. 静态对照至少分开官方参考与目标成品，并记录完整 PVF 身份。一个版本中的字段相关性不能替代另一个版本的运行证明。

## 实机矩阵

- 单人和组队分别观察限制提示、实际可用次数和失败后的行为。
- 普通副本、深渊配置副本、塔式/特殊副本分别抽代表，不用一个家族代表全部。
- 有难度分支时逐档验证，不从 `[coin info]` 的裸列位猜统一语义。
- 若方案触及 `[hell dungeon]`，同时检查深渊入口、事件怪、地图/UI 和清算是否出现副作用。
- 每次只改变一个结构变量；静态读回正确不能写成复活限制已生效。

## 验收

- 每个副本都通过目标 registry 定位，event/standard 或同名变体没有混并。
- 四类 coin 字段、机制壳字段及各自精确出现次数均已记录。
- 结论按副本结构族表达，没有把 `[hell dungeon]` 固化成全版本开关。
- 重复标签、未知列义和未覆盖结构族保持 unresolved/blocked。
- 没有保存某个项目的副本数量、裸 ID、限制数值或旧部署轮次作为通用默认值。
- 不生成输出 PVF，不改客户端。
