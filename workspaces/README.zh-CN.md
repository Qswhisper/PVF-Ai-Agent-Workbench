# workspaces

这里仅保留目录说明和示例。运行产物默认写到 Workbench 外部：如果上级工作区已有 `derived/`，则写入其下的运行报告目录；否则使用本机用户状态目录。可通过 `PVF_WORKBENCH_RUNS_ROOT` 显式覆盖。

- `examples/`: 示例 profile、change-set 和任务报告模板。
- 其余目录中的 README 只说明对应的外部运行产物类型，不应保存真实报告、索引或 stage。
