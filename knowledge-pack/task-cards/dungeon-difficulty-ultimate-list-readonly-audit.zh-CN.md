# 副本难度系数与地狱名单只读核查

状态：默认可用

用途：核查 `.dgn -> 难度 / revision .tbl` 和 `ultimatedungeonlist.etc -> dungeon.lst` 两条独立链。

## 先读

- `safety/README.zh-CN.md`
- `dictionaries/dungeon-difficulty-ultimate-list-fields.zh-CN.md`
- `workflows/dungeon-difficulty-and-ultimate-list-audit.zh-CN.md`

## 执行

1. 目标 dungeon ID 先通过 `dungeon/dungeon.lst` 解析。
2. 从目标 `.dgn` 实际存在的 `[monsterapc diff table]` 或 `[revision table]` 读取显式 `.tbl` 路径；不得因为另一副本使用某一标签就补写或假定目标也相同。
3. 记录 `.tbl` 完整块、`type`、等级/难度行和行列形状；结构不同时停止套表。
4. 读取 `etc/ultimatedungeonlist.etc [apply ultimate]`，按原顺序逐项解析 dungeon ID。
5. 重复名单项保留并标 duplicate，不静默去重。
6. 分开汇报“难度表静态结论”和“名单静态结论”。

## 必须汇报

- dungeon、实际引用标签与 `.tbl` 解析结果或 fallback-candidate。
- `.tbl` 的块、行列和未识别字段边界。
- 地狱名单的顺序、重复和 unresolved。
- 名单不等于倍率，静态表不等于实机难度。
- 未生成输出 PVF、未修改客户端，或完整列明受控写出状态。

## 禁止

- 按固定数值数量重建 `.tbl`。
- 因名单重复而自动去重。
- 用地狱名单解释怪物/APC 倍率。
- 用 `.tbl` 存在证明地狱难度 UI 或服务端放行。
