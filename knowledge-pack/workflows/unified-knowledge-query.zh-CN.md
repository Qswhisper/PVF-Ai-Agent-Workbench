# 统一知识查询流程

状态：默认可用

## 路由

1. 先从轻量 `knowledge-index.json` 判断任务领域。
2. NUT、tag、bookmark 直接使用 `workbench.bat knowledge-query <kind>`；明确 NUT 符号时随后只运行一次目标 `pvf-read search-script`。source、claims、lineage、planner、client 只在任务明确提供对应 artifact 时查询。
3. 只返回当前任务需要的结果数，记录 artifact SHA 和 query。
4. 根据 kind 保留专项边界：版本、来源层、registry、unresolved、客户端资源或时间对齐状态。
5. 作 PVF 结论前读回目标 raw 文件并解析正确 `.lst`；作运行时结论前使用已有 SHA 绑定 PASS 或安排高收益实机验证。

Planner 查询直接使用 `dependency-plan` 返回的 `reportPath`。该 JSON 已是完整生成报告，不运行目录探测，也不另写摘要；“完整报告”仍不等于最终运行证据。

## 示例

```bat
workbench.bat knowledge-query nut --name sq_GetSkillLevel --kind function --group dnf --exact
workbench.bat knowledge-query tag --tag duration --exact
workbench.bat knowledge-query bookmark --text 爆率
workbench.bat knowledge-query source --manifest "D:\research\SOURCE-MANIFEST.json" --text maintenance-topic --limit 20
workbench.bat knowledge-query lineage --catalog "D:\research\PVF-LINEAGE-CATALOG.json" --golden blood-sword-tp-derivative
workbench.bat knowledge-query planner --report "D:\research\DEPENDENCY-PLAN.json" --unresolved-only
workbench.bat knowledge-query client --matrix "D:\research\CLIENT-COMPATIBILITY-MATRIX.json" --status divergent
```

## 写入交接

统一结果只能形成调查结论或修改意图。真正写 PVF 时重新读取目标 PVF 的 raw no-simplified 精确文本和最近邻样本，建立受控 change-set，并完成同源同 change-set dry-run、approval code、显式 output、backup、readback 与 manifest。
