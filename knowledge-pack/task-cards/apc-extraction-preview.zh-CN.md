# APC 提取预览任务卡

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `encyclopedia/pvf-file-types/apc-ai-key-stream.zh-CN.md`
- `workflows/apc-extraction-planner.zh-CN.md`
- `indexes/apc-extraction-boundary.zh-CN.md`
- `indexes/extraction-capability-router.zh-CN.md`

## 执行

1. 确认 root APC 来源：aicharacter ID、`.aic` path、名称，或副本提取目录。
2. 按 `aicharacter/aicharacter.lst` 解析 root。
3. 收集 `.aic/.ai/.key` 和相关 registry。
4. 解析技能、装备、快捷道具引用。
5. 运行 APC 分析器或等价只读分析。
6. 输出 APC 依赖摘要、unresolved、字段不确定项。

## 验收

- `.aic -> .ai -> .key` 链路可追踪。
- skill/equipment/stackable 没有混用 registry。
- 未闭合引用已列出。
- 报告明确未写 PVF、未部署客户端。

## 禁止

- 不把 key stream 静态存在写成技能实机释放成功。
- 不把 APC 静态闭合写成副本事件或 Boss 门控成功。
- 不吸收外部工具中的授权、群验证或 NUT/SQR 混淆能力。
