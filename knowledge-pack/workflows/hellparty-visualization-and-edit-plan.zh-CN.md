# 深渊组可视化与编辑计划流程

状态：默认可用

## 目标

从一个 dungeon 根开始，只读展开深渊开启线索、封印门地图、深渊柱、组权重/波次和组成员，并在需要时形成最小编辑计划。流程本身不写 PVF。

## 输入

- 目标 PVF。
- dungeon ID 或 `.dgn` 路径。
- 可选输出筛选：只看 unresolved、指定 group、指定 wave 或指定成员。

## 阶段一：副本到 hell map

1. dungeon ID 通过 `dungeon/dungeon.lst` 解析。
2. 读取 `.dgn [hell dungeon]`、`[seal door map index]`、`[escape hell]` 和相邻条件块。
3. `[seal door map index]` 通过 `map/map.lst` 解析。
4. 没有显式 map ID 时，只提出同目录 `hell_<stem>.map` 等候选，状态为 candidate；用 `.map [dungeon]`、目标邻居和引用关系继续复核。
5. 无法唯一定位时停止自动展开，不任意选一个 hell map。

## 阶段二：深渊柱与组引用

1. 在 hell map 中读取 `[special passive object]` 和 `[hellparty]`。
2. 对疑似深渊柱 object ID 使用 `passiveobject/passiveobject.lst` 解析；保留 X/Y/Z 和生成数量候选。
3. 按目标已确认的三元组形状读取 `group_id / weight / wave`。
4. 重复 group、非法或未知 wave、残缺三元组均保留为异常；不自动修正。

## 阶段三：组定义闭合

1. 读取 `etc/hellparty.etc` 的 `[difficulty]`、`[hellparty monster group]`、`[group index]` 和 `[group]`。
2. 从当前目标的实际 map/group 引用建立成员范围，不从历史变更集、设计名单或旧守卫清单恢复范围。旧清单只用于找差集。
3. 每个 map group ID 必须在 `[group index]` 闭合。
4. 组成员按 `member_id / kind` 二元组读取。
5. kind `0` 通过 `monster/monster.lst` 解析；kind `1` 通过 `aicharacter/aicharacter.lst` 解析。
6. 其他 kind、缺 registry、缺定义或重复定义全部标记 unresolved，不把 APC ID 当 monster ID。
7. A-E 等档位标签原样显示；未知列只显示 raw 值和位置，不替 Agent 猜语义。

## 输出视图

建议同时提供三种视图：

1. dungeon 视图：入口形状、hell map、柱对象和总体异常。
2. wave 视图：每个 `group_id / weight / wave` 与相对权重，明确“权重不是实机概率”。
3. group 视图：档位、成员、kind、registry 路径和未解析项。

报告必须保留完整目标 PVF SHA、读取路径和 registry；不能只给名称或图形。

## 实机名称回填

1. 测试者只需记录可见名称、第一轮 / 第二轮等实际顺序、同名敌人大致数量和是否卡波；不要要求测试者辨认 group 或成员 ID。
2. Agent 从 hell map 中筛出该 wave 的 group 候选，再展开每个 `[group]` 的完整成员组合。
3. kind `0` 只在 `monster/monster.lst` 反查，kind `1` 只在 `aicharacter/aicharacter.lst` 反查；继续读取目标成员文件的名称 token 和路径佐证。
4. 只有“波次 + 成员数 / 重复形状 + 可见名称组合”唯一匹配时，才把实机观察绑定到 group；多组仍可解释时保持 ambiguous。
5. 对重复同一成员的组，分别记录静态重复条数和实机实际计数或观察下界。“至少 5 个”不能改写为“实机确认 7 个”。
6. 一次抽中的组只能证明该组在当前 SHA 样本可生成和推进，不证明其他候选组、选择概率、掉落、经验或 A-E 档位列义。

## 编辑计划

### 调整权重或波次

只在目标 hell map 的已确认三元组中做最小替换，不改 group ID。wave 范围由目标邻居确认。

### 调整组成员

同时审阅 `[group index]`、对应 `[group]`、成员 kind 和 registry。新增 APC 必须写 kind `1` 并通过 AIC registry 闭合；新增 monster 写 kind `0`。

### 新增组

把唯一 group ID、`[group index]` 登记、完整组定义、档位、成员 registry 和至少一个 map 引用作为原子计划。未确认目标闭合格式时禁止凭模板新增。

## 受控写出与实机

任何写出都从目标 raw no-simplified 文本重建 change-set，经过 dry-run manifest、approval code、显式新输出、备份和读回。实机批次可同时检查多个副本的深渊入口、柱位置、开柱、波次数、monster/APC 身份、清算和掉落；掉落/经验等仍需单独证据，不能从组静态列推断。
