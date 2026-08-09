# PVF Registry / LST Topology 只读审计任务卡

状态：默认可用


## 快速结论

- 同一个数字可在不同 registry 中指向完全不同对象；裸数字不是全局事实。
- `itemname.lst`、`monstername.lst`、`skillname*.lst`、`n_quest/epicquest.lst` 等属于名称/数值表，不能拿来判断文件路径缺失。

## 默认处理

1. 问数字 ID、`.lst`、registry、未注册文件、孤儿风险时，先读本任务卡。
2. 需要术语口径时，读 `dictionaries/pvf-registry-lst-topology-fields.zh-CN.md`。
3. 需要缺失 registry、重复路径和跨 registry ID 风险时，读 `indexes/pvf-registry-lst-topology-orphan-boundary.zh-CN.md`。
4. 需要解释 `.lst` 文件类型时，读 `encyclopedia/pvf-file-types/lst-registry-topology.zh-CN.md`。

## 精确 ID 最短路径

目标 PVF、registry 和 ID 已明确时，直接按以下顺序执行：

1. `pvf-read resolve-lst`，取得 ID、内部路径、registry 行号、文件存在性和短摘要。
2. `pvf-read read`，读回该目标文件的必要小段。
3. 只有用户要求反向闭环时才运行 `pvf-read resolve-path`。

这一路径的第一条 shell 动作就是 `pvf-read resolve-lst`，不需要预先运行 `Test-Path`、`Get-Item`、`open`、`list-files`、`check`、书签查询或读取完整知识索引；只有直接命令失败时才诊断返回错误。

常用 domain 与 registry 的固定路由如下；它们只负责选表，最终事实仍以目标 PVF 的 resolve/readback 为准：

| domain | registry |
| --- | --- |
| NPC 商店 | `itemshop/itemshop.lst` |
| 怪物 | `monster/monster.lst` |
| 副本 | `dungeon/dungeon.lst` |
| 地图 | `map/map.lst` |
| APC | `aicharacter/aicharacter.lst` |
| 装备 | `equipment/equipment.lst` |
| 消耗品/材料 | `stackable/stackable.lst` |
| 任务 | `n_quest/quest.lst` |
| 城镇 | `town/town.lst` |

## 不能直接下结论

- 不能把裸数字 ID 当作全局对象 ID；必须先确认父块、字段和正确 registry。
- 不能把名称/数值表当成文件路径 registry。
- 不能把未注册文件直接写成无效孤儿或可删除文件。
- 不能把注册路径存在写成实机加载成功、UI 正常、客户端资源完整或服务端放行。

## 下一步测试建议

本主题不需要实机测试。后续如果进入生产改动，最小验证顺序是：

1. 确认目标字段所属父块。
2. 按父块选择正确 `.lst` registry。
3. 解析 ID 到 PVF 内部路径。
4. 读取目标文件确认存在和块结构。
5. 写入实验时再走备份、最小改动、保存到显式输出、读回和实机验收。
