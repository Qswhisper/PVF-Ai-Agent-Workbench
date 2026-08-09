# 统一知识查询快速边界

状态：默认可用

## 用途

`workbench.bat knowledge-query` 用同一只读 envelope 按需查询八类知识：

- `source`：完整来源清单。
- `claims`：结构化 claim store。
- `nut`：随包 NUT API / 常量紧凑事实。
- `tag`：随包 `community`、`official-original` 与 `tool-extension` 分层事实。
- `bookmark`：随包商城、爆率、registry、职业、副本、APC、UI 等常用 PVF 路径导航。
- `lineage`：完整 PVF SHA 锁定的语义谱系。
- `planner`：依赖计划或 batch 报告。
- `client`：客户端 / PVF 兼容矩阵。

## 统一 envelope

每次返回 `kind`、portable 或 task-supplied artifact 标识与完整 SHA256、query、match/return/truncated 摘要、`results` 数组、证据/写入边界和必要的底层 delegated 元数据。NUT 与 planner 还返回机器可读 `agentHandoff`：NUT 指向唯一的目标 `search-script` 步骤；planner 明确报告已完整，无需目录探测或另写摘要。

## 固定边界

- 只按任务路由查询，不默认加载全部来源、数千条 tag 或完整目录。
- artifact 和索引不是最终证据；涉及目标 PVF 时仍要 raw readback 和正确 registry。
- 0 命中不证明字段、API、文件或资源不存在。
- 书签只负责快速定位；路径是否存在、文件含义和目标版本差异仍由目标 PVF readback 决定。
- NUT 声明版本不等于目标运行时；tag 原文/翻译/工具扩展保持分层；谱系行为 PASS 不跨 SHA 自动继承。
- planner JSON 是本次预览的完整生成报告，但不是最终运行证据或导入计划；直接使用返回的 `reportPath`，不以 `Test-Path` / `Get-Item` 探测，也不另写 Markdown/JSON 摘要。unresolved 不得静默忽略；client `custom-only` 不代表官方，资源 present 不代表实机正确。
- 查询通道不直接写 PVF 或客户端。PVF 改动只能重新取目标 raw no-simplified 文本并进入 `workbench.bat pvf-change`；客户端写入需要另行授权且不在本通道。
