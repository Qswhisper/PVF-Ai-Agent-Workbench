# 实机验证结论吸收流程

状态：默认可用

用途：把一次实机 PASS、FAIL 或负例整理进 clean `knowledge-pack`，避免结论散落在报告、对话和实验目录里。

## 原则

- clean pack 只写可复用结论、字段边界、workflow 护栏和任务卡，不写真实路径、长证据链或实验输出。
- 单一样本只能写成“示例证明/否定”，不能写成全局机制。
- 失败样本和负例必须作为边界保留，不能被吸收成默认可用。
- 涉及中文、StringLink、NPC 文本、道具名、描述或副本文本时，PVF 读回正常不等于客户端 UI 文本安全。
- manifest、精确命中和读回只证明声明的改动链闭合，不证明候选范围完整；批量任务必须另记全集来源、未解析和漏项检查。
- 每个实机 run 必须有一份规范的原始结果记录，逐项保存目标身份、明确状态和实际观察。准备文档、测试计划、自动生成的吸收清单和后置汇总都是派生产物；它们不能把原始记录中的“待测”、未勾选或相互矛盾项目覆盖成 PASS。
- 合并任务同时维护正向范围 `approved` 与负向范围 `withdrawn / forbidden`。最终差异和读回既要证明认可项存在，也要证明已撤回或禁止的实验没有被重新带入。
- 组件在旧输出上的 PASS 只绑定该组件当时的容器；多个组件组成新输出后必须重新核验组合结果，不能继承为最终 PASS。

## 操作

1. 生成本机 checklist：

   ```bat
   workbench.bat absorb new --id <run-id> --title "<title>" --domain <domain> --status PASS
   ```

2. 根据 checklist 定位需要更新的 clean pack 文件，通常包括：

   - `dictionaries/`：字段含义和已验证样本边界。
   - `indexes/`：open gap、negative sample、完成状态和专题边界。
   - `task-cards/`：Agent 下次执行同类任务时必须遵守的短入口。
   - `workflows/`：会影响流程顺序、验证步骤或风险处理的规则。
   - `safety/`：新发现的编码、覆盖、部署或客户端污染风险。

3. 若验证来自累计多轮输出，先对最终容器重新枚举候选全集并复查整体不变量。记录 `pass / warning / unresolved / not-run`；必查项未执行、警告未裁定、解析异常或范围未知时不能吸收为全量 PASS。原始结果记录与后置摘要冲突时保持 `unresolved / not-run`，直到补齐该 run 的规范结果记录，不让摘要倒写证据状态。
4. 大规模同构对象的静态解析、范围闭合和最终读回应保持全量；运行测试只有在对象确实属于独立行为组时，才可按组分层抽样并同时检查容器级不变量。抽样结果只能证明所测行为组和样本，不能宣称每个对象均已实机通过。
5. 更新 `knowledge-pack/MANIFEST.json` 的新增条目、bytes、sha256 和 summary。
6. 运行 `workbench.bat knowledge-check`。
7. 运行 `workbench.bat check` 或 `workbench.bat doctor check`。
8. 扫描 clean pack，确认没有误写本机绝对路径、实验 PVF 路径、客户端路径、报告路径或 KV 证据链。

## 验收

- 结论能在词典和边界索引里找到。
- workflow 或 task card 已覆盖下一次 Agent 会踩到的风险。
- 合并输出能同时证明认可项存在、撤回项缺席；历史组件 PASS 没有被当作组合输出 PASS。
- 若使用运行抽样，抽样分组依据、未测对象和结论边界均已明确，静态全量闭合没有被抽样替代。
- manifest 与文件内容一致。
- clean pack 自检通过。
