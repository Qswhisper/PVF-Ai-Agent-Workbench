# NPC 商店受控修改

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `task-cards/npc-shop-readonly-audit.zh-CN.md`
- `workflows/npc-shop-edit.zh-CN.md`

## 执行

1. 先完成只读核查，并列出目标 `.npc`、`.shp` 和商品文件。
2. 用户明确授权写 PVF。
3. 明确源 PVF、备份位置和输出 PVF；输出 PVF 不能是源 PVF。
4. 确认 change-set、manifest 或运行记录里的源/输出/客户端路径没有乱码。
5. 只做目标字段的最小改动。
6. 如果商品文件含中文字符串或 StringLink，数字字段最小替换必须使用目标确认的 `Cn` 或 `Tw` 安全编码路线；普通脚本的单个完整中文名称/描述可走 `verified-inline-text` 专项验证，StringLink 与 `.str` 显示文本仍保持只读。
7. 保存到显式输出 PVF。
8. 重新打开输出 PVF 读回目标 `.npc`、`.shp` 和商品文件。
9. 生成 manifest 或等价变更清单。

## 验收

- 源 PVF 没有被覆盖。
- 有备份。
- 有显式输出 PVF。
- 读回内容与计划一致。
- 报告中说明是否需要进游戏确认商品显示、价格、材料扣除和购买结果。
- 如果触达中文字符串或 StringLink 商品文件，部署验收必须包含商店、道具名和道具说明文本 smoke check。
