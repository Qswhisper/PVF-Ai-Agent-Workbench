# 统一依赖 Planner 只读任务卡

状态：默认可用

## 先读

- `dictionaries/dependency-planner-boundary-quick.zh-CN.md`
- `workflows/unified-dependency-planner.zh-CN.md`
- `safety/README.zh-CN.md`

## 执行

1. 确认目标 PVF、domain、唯一选择器和外部输出目录。
2. 运行 `workbench.bat dependency-plan plan`。
3. 核对唯一 root、正确 registry、读错误、resolved edge 与 unresolved。
4. 将客户端资源引用标为 candidate，不作存在性或运行时结论。
5. 若要改动，停止 planner 流程并切换到受控 change-set；不能直接 apply 本报告。

## 禁止

- 不静默忽略未闭合引用。
- 不把外部工具的方法体、界面、认证或限制逻辑复制进实现。
- 不写 PVF、NPK、IMG 或客户端文件。
- 不把 planner 报告称为导入计划、补丁或实机 PASS。
