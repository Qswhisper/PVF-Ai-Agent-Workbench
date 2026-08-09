# 副本提取预览任务卡

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `workflows/dungeon-extraction-planner.zh-CN.md`
- `indexes/dungeon-extraction-boundary.zh-CN.md`
- `indexes/extraction-capability-router.zh-CN.md`

## 执行

1. 确认源 PVF 和输出目录。
2. 用 dungeon ID、path 或 name 定位 root。
3. 运行副本 extract workflow。
4. 审阅 manifest、missing refs、read errors。
5. 若提供客户端资源目录，审阅 asset manifest。
6. 输出 preview index 和风险摘要。

## 验收

- root 唯一。
- 读取错误为 0，或已逐项解释。
- 未闭合引用已分类。
- 报告明确未写 PVF、未改客户端。

## 禁止

- 不把提取结果直接当作导入成功。
- 不用外部资料中的旧 ID 覆盖目标 PVF 解析结果。
- 不把实机行为写成静态提取结论。
