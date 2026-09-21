# 实机验证 PASS 吸收任务卡

状态：默认可用

先读：

- `safety/README.zh-CN.md`
- `workflows/runtime-validation-absorption.zh-CN.md`
- `indexes/knowledge-index.json`

执行：

1. 确认当前任务只是知识吸收；不要写 PVF，不要部署客户端。
2. 运行或参考 `workbench.bat absorb new --id <run-id> --title "<title>" --domain <domain> --status PASS`。
3. 先确认该 run 有规范的原始结果记录，逐项写明目标身份、状态和实际观察；准备文档、计划、生成式 checklist 或最终汇总不能替代它。原始记录仍为“待测”、未勾选或与摘要冲突时保持 `unresolved / not-run`。
4. 把 PASS 结论写成“示例已验证”，并明确没有覆盖的边界。
5. 批量或累计任务先确认候选全集来自当前 registry/引用图，并对最终容器复查整体不变量；历史清单、词典、ID 段和已通过的 manifest 不能单独证明无漏项。
6. 记录 `pass / warning / unresolved / not-run`。必查项未执行、warning 未裁定、解析异常或范围未知时，只能吸收局部 PASS，不能写“全部通过”。
7. 同步更新字段词典、边界索引、任务卡、workflow、安全护栏和完成状态中受影响的最小文件集。
8. 如果涉及中文/StringLink 文件，只能写“需客户端 UI 文本 smoke check”或“已完成 smoke check”，不要只凭 PVF 读回下结论。
9. 更新 `knowledge-pack/MANIFEST.json`。
10. 运行 `workbench.bat knowledge-check` 和 `workbench.bat doctor check`。

验收：

- clean pack 中没有真实 PVF、客户端、实验输出或报告绝对路径。
- 没有把单一样本扩大成全局规则。
- 自检通过，最终回复说明已吸收项和仍未证明项。
