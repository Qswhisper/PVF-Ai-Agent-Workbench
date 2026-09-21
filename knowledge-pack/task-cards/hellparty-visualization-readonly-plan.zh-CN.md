# 深渊组可视化只读计划

状态：默认可用

用途：从一个副本展开深渊入口、封印门地图、深渊柱、组权重/波次和 monster/APC 成员。

## 先读

- `safety/README.zh-CN.md`
- `dictionaries/hellparty-visualization-fields.zh-CN.md`
- `workflows/hellparty-visualization-and-edit-plan.zh-CN.md`

## 执行

1. dungeon ID 通过 `dungeon/dungeon.lst` 解析 `.dgn`。
2. `[seal door map index]` 通过 `map/map.lst` 解析；没有显式 ID 时只提出 hell map 候选。
3. 深渊柱 object ID 通过 `passiveobject/passiveobject.lst` 解析。
4. `[hellparty]` 按目标确认的 `group_id / weight / wave` 三元组读取。
5. group ID 在 `etc/hellparty.etc [group index]` 闭合。
6. 组成员 kind `0` 走 `monster/monster.lst`，kind `1` 走 `aicharacter/aicharacter.lst`；其他 kind 保持 unknown。
7. 守卫或成员审计范围由当前 `hellparty.etc` 的实际组引用和 kind 反解；历史变更集、设计花名册或旧成员清单只能作差异对照，不能替代当前引用图。
8. 输出 dungeon、wave、group 三种视图及全部 unresolved。
9. 实机只看到名称时，由 Agent 用波次候选、完整成员组合、kind 对应 registry 和目标 AIC / monster 名称 token 反查；测试者不需要提供代码。重复同名成员同时报告静态条数与实机观察下界。

## 必须汇报

- 深渊地图是 resolved 还是 candidate。
- 柱对象 ID、路径和坐标。
- 完整 group/weight/wave。
- 每个成员使用的 registry 与解析路径。
- 权重不等于实机概率，静态组不等于掉落/经验/波次行为通过。
- 可见名称反查是否唯一；静态重复条数不能冒充实机精确计数。
- 本次是否写出 PVF、修改客户端或消耗实机测试。

## 禁止

- 把 APC ID 当 monster ID。
- 把 `1-9` 设成无目标样本的全版本 wave 硬限制。
- 把同目录 `hell_*.map` 候选写成已解析事实。
- 依据界面列名猜 `[difficulty]` 或 A-E 档位的通用语义。
