# 装备与道具受控修改

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `task-cards/equipment-stackable-readonly-audit.zh-CN.md`

## 执行

1. 先完成只读核查，并列出目标 registry、目标 `.equ` 或 `.stk` 文件。
2. 用户明确授权写 PVF。
3. 明确源 PVF、备份位置和输出 PVF；输出 PVF 不能是源 PVF。
4. 确认 change-set、manifest 或运行记录里的源/输出/客户端路径没有乱码。
5. 只改目标字段，不做顺手批量重排。
6. 含中文字符串或 StringLink 的文件，数字字段最小替换必须使用目标确认的 `Cn` 或 `Tw` 安全编码路线；普通脚本的单个完整中文名称/描述可走 `verified-inline-text` 专项验证，StringLink 与 `.str` 显示文本仍保持只读。
7. 保存到显式输出 PVF。
8. 重新打开输出 PVF 读回目标文件和被引用的材料文件。
9. 生成 manifest 或等价变更清单。

## 验收

- 源 PVF 没有被覆盖。
- 有备份和显式输出 PVF。
- 读回内容与计划一致。
- 如果改了价格或材料，说明要进游戏测试购买或兑换。
- 如果改了等级、职业限制或战斗效果，说明必须进游戏测试穿戴、使用或战斗表现。
- 如果触达中文字符串或 StringLink 文件，部署验收必须包含客户端道具名、说明或相关 UI 文本 smoke check。
