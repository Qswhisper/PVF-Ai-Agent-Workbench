# NPC 商店编辑流程

状态：默认可用

## 适用

读取或修改 NPC 商店、售卖物、兑换材料、商品列表。

## 先读

- `safety/README.zh-CN.md`
- `encyclopedia/pvf-file-types/itemshop-shp.zh-CN.md`
- `dictionaries/npc-shop-fields.zh-CN.md`

## 只读闭合

1. 确认目标 PVF。
2. 在 `npc/npc.lst` 中定位 NPC ID 和 `.npc` 文件。
3. 读取 `.npc` 的 `[role]`，确认商店相关 role 字符串。
4. 用 `itemshop/itemshop.lst` 解析商店相关 role 后面的 ID。
5. 读取目标 `.shp`。
6. 读取 `[NPC]`、`[type]`、`[sell item]`、可选 `[tab name]` 和 `[message]`。
7. 每日商店读取 `[one a day start time]` 和 `[one a day item]`；日志结构只记录为特殊入口，不当普通售卖列表。
8. 跳过 `-1`、`-2` 等负数控制值。
9. 对正数商品 ID 按上下文解析 equipment / stackable 等 registry。
10. 读取商品文件，确认名称、类型、价格或材料字段。
11. 输出只读核查表：NPC 文件、商店 role、商店文件、商品文件、支付字段和仍需验证项。

## 写入流程

1. 用户明确授权写 PVF。
2. 明确源 PVF 和输出 PVF。
3. 备份源 PVF。
4. 确认记录中的源/输出/客户端路径没有乱码。
5. 做最小改动。
6. 商品文件中的数字仍按目标确认的 `Cn` 或 `Tw` 做最小替换；普通脚本的完整中文名称/描述（可多行，批量需精确计数）可走 `verified-inline-text` 专项验证，StringLink 与 `.str` 显示文本仍保持只读。
7. 保存到输出 PVF。
8. 重新打开输出 PVF 读回 `.npc`、`.shp` 和商品文件。
9. 输出变更清单。

## 字段判断

- 添加或移除商品：先看 `.shp` 的 `[sell item]`。
- 每日轮换商品：先看 `.shp` 的 `[one a day item]`，再做实机刷新/领取验证。
- 改金币价格：看商品文件的 `[price]`。
- 改点券价格：看商品文件的 `[cash]`。
- 改材料兑换：看商品文件的 `[need material]`，并解析材料 ID。
- 改胜点价格：看装备商品文件的 `[medal]`。
- 如果同名字段出现在其他文件族，不要直接套用本流程的商店语义。
- `[secret shop]`、活动商店和生产类商店要额外确认触发入口，不能只凭 `.shp` 存在判断实机可用。

## 游戏内验证

- 找到目标 NPC。
- 打开商店。
- 确认商品是否出现。
- 确认价格或材料消耗是否符合预期。
- 尝试购买或兑换。
- 如果触达中文或 StringLink 商品文件，检查商店、道具名和道具说明是否乱码。
- 点券商品还要确认余额不足或扣费提示是否符合预期。
- 胜点商品还要确认胜点不足或扣除提示是否符合预期。
