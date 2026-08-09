# 统一依赖 Planner 只读任务卡

状态：默认可用

## 先读

- `dictionaries/dependency-planner-boundary-quick.zh-CN.md`
- `workflows/unified-dependency-planner.zh-CN.md`
- `safety/README.zh-CN.md`

## 执行

1. 确认目标 PVF、domain、唯一选择器和外部输出目录。
   APC 的 domain 写 `apc`；`aicharacter/aicharacter.lst` 是 registry，不把 `aicharacter` 填进 `--domain`。
2. 运行 `workbench.bat dependency-plan plan`。
3. 用一次窄 `knowledge-query planner --report ... --limit 20` 核对唯一 root、读错误、resolved edge 与 unresolved。
4. 数字 root 用一次 `pvf-read resolve-lst` 独立核对 registry；再用一次 `pvf-read read-batch --max-chars-per-file 3000 --max-total-chars 6000 --raw` 同时读 root 与一个直接依赖。
5. 将客户端资源引用标为 candidate，不作存在性或运行时结论。
6. 若要改动，停止 planner 流程并切换到受控 change-set；不能直接 apply 本报告。

精确 ID/path 正常时只生成一次报告；不要用 `--force` 重跑，也不要在普通预览中阅读 planner 实现源码。若报告混入模糊搜索噪声，按工具缺陷处理。

planner 会自行创建外部输出目录，不先运行 `Test-Path` 或通用 shell 预检。
命令返回的 `DEPENDENCY-PLAN.json` 已是完整生成报告，直接使用 `reportPath`；不运行 `Get-Item`，不用 `Set-Content` / `Out-File` 另写 Markdown 或 JSON 摘要。上述命令形态已经完整，不运行 `dependency-plan ... --help` 或 `knowledge-query --help`。完整报告仍不是最终运行证据、导入计划或补丁。

## 禁止

- 不静默忽略未闭合引用。
- 不把外部工具的方法体、界面、认证或限制逻辑复制进实现。
- 不写 PVF、NPK、IMG 或客户端文件。
- 不把 planner 报告称为导入计划、补丁或实机 PASS。
