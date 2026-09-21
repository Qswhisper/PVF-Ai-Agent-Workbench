# 强化与增幅等级表结构化受控修改

状态：需验证

## 适用

仅用于目标 PVF 中以下既有文件：

- `etc/upgrade.etc`
- `etc/amplifyupgrade.etc`

`etc/upgrade_separate.etc` 属于锻造路线，不得放进本结构化修改。

## 先读

- `safety/README.zh-CN.md`
- `dictionaries/upgrade-reinforce-amplify-enchant-recipe-fields.zh-CN.md`
- `workspaces/examples/change-set.upgrade-table-level-edit.example.json`

## 已确认的结构边界

- `[table]` 按每 17 个数字 token 分成一个原始组；选择器是从 0 开始的原始组索引，组内第一个 token 不是显式等级号。不得把“游戏显示等级 = 原始组 ± 1”写成全局规则。
- 工作台用 B 到 R 作为 17 个位置列的稳定标签。这些字母只表示位置，不自动证明攻击、费用或概率等玩法含义。
- `copyColumns` 与 `preserveColumns` 必须互不重叠，并且合起来恰好覆盖 B 到 R，不能留隐含列。
- 修改等级上限时，`maxLevelByRarity` 必须显式给出 `common`、`uncommon`、`rare`、`unique`、`epic`、`chronicle` 六项，且源文件已有完整六行；不能用一个标量代替或擅自补行。只修改表格数值时，使用 `tableEdit` 并省略 `maxLevelByRarity`，工作台会逐字保留原有上限段并绑定其哈希；这允许处理原版只有部分稀有度行的文件，不推断缺失行的含义。
- `etc/amplifyupgrade.etc` 的 `[amplification const]` 按每 4 个数字 token 分组，且存在 0 级组；新接口单独声明它的原始源组和目标组，不必与 `[table]` 相同。四个值的玩法顺序尚未由静态证据确认，只允许整组原样复制。

## 执行

1. 对目标文件执行一次 `pvf-read read --raw`；两文件同时改时使用一个 raw `read-batch`。
2. 使用一条 `type: "upgrade-table-level-edit"`。新请求在 `tableEdit` 中填写 `sourceGroup`、`targetGroups`、复制列和保留列；这些数字只表示原始组索引。
3. 增幅文件另用 `amplificationConstEdit` 声明独立的 `sourceGroup`、`targetGroups`、宽度 4 和存在 0 级组。旧平铺字段仍可读取，但沿用旧的同组选取约束；新旧字段不得混用。
4. 若修改上限，六种稀有度逐项填写；若保持原有上限，省略 `maxLevelByRarity`（不是填 `null`）。若只需恢复少量表格单元，可在 `tableEdit.setCells` 逐项声明 `group`、B-R `column`、完整数字旧 token `expectedBefore` 和完整数字 `newValue`；源值命中旧值才写，已等于新值则稳定为 `no-op`，其余值一律阻止。它可单独使用，也可与不重叠的列复制同用。
5. 运行 `pvf-change validate`，再按 `agentHandoff.nextCommandOnly` 执行预演。
6. 预演会给 `[table]`、六稀有度上限和增幅四值组分别记录 `changed` 或 `no-op`、前后哈希、声明值复核和是否需要写入；发生变化的组件才要求写入证明，无变化组件只重新解析复核。
7. 预演会用临时独立 PVF 验证实际变化并立即清理；正式授权后只生成独立的修改版 PVF。若所有组件都是 `no-op`，返回 `noChange`，不发批准码，也不生成空成品。
8. 生成后重新打开输出 PVF，精确读回并再次解析；结果必须成为稳定点，源 PVF 必须保持不变。

## 停止条件

- 路径不是两个精确允许路径，尤其是 `upgrade_separate.etc`。
- `[table]` token 数不能被 17 整除、出现非数字 token、声明原始组不存在，或请求修改上限但六种稀有度不完整。省略上限修改时，原有上限段仍必须唯一且有闭合标签。
- 复制列与保留列重叠、遗漏或越界。
- 新旧字段混用；增幅四值组不能被 4 整除，或零组声明缺失。
- `setCells` 重复/越界、与列复制重叠、值不是完整数字 token，或 `expectedBefore` 与目标原文不完全一致。
- 同一路径混入其他 change，或临时独立读回、重新解析、最终读回任一失败。

## 验收

- 核验记录列出每个目标原始组、每个复制列或精确单元格的前后值，以及明确保留列。
- 每个结构组件都列出 `changed`/`no-op`、前后哈希、`declaredValuesVerified` 和 `writerRequired`；无变化组件没有伪造写入证明。
- 修改的六种稀有度上限逐项读回；保留的上限段前后哈希必须完全相同，且核验记录为 `preserve-existing-section`；增幅四值组整组读回。
- 没有写客户端，没有改 `upgrade_separate.etc`，没有覆盖源 PVF。
- 静态结构通过不证明玩法公式正确；强化、增幅成功率、费用、属性结果和 UI 仍需实机验证。
