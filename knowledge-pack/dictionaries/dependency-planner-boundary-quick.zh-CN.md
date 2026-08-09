# 统一依赖 Planner 快速边界

状态：默认可用

## 用途

`workbench.bat dependency-plan` 只读展开一个明确 root 的跨文件依赖，统一覆盖：副本、城镇、怪物、PassiveObject、APC、ANI、装备、stackable、礼包、宝珠、任务和套装。

## 最小 contract

- 输入必须明确目标 `Script.pvf`、domain，以及 ID、PVF path、query 或受支持 sample 中恰好一个选择器。
- 数字 ID 必须在 domain 对应 registry 中解析；`apc` 使用 `aicharacter/aicharacter.lst`，不同 registry 的同号 ID 不能合并。
- 正常可交接的只读结果要求 `rootCount == 1` 且 `readErrorCount == 0`。
- `nodes` 是候选节点，`edges` 是可解释引用边，`unresolved` 是未闭合依赖，`clientAssetCandidates` 只是客户端资源候选。
- 未闭合依赖可以保留在预览中，但不能静默删除、假定无关或写成已闭合。

## 不可越界解释

- planner 报告不是导入计划，也不是 change-set，不能直接 apply。
- PVF 中出现 IMG、ANI、UI、音频或 NPK 线索，不证明目标客户端资源存在，更不证明运行时显示、播放或行为正确。
- 外部资料或工具只提供类别线索；其方法体、界面、认证和破坏性写入逻辑不进入实现或知识包。
- NPK/IMG 只允许另行授权的只读路径或存在性预览；本 planner 不写、删、合并、替换客户端资源。

## 写入交接

确需形成 PVF 改动时，重新读取目标 PVF 的 raw no-simplified 文本和最近邻样本，再进入 `workbench.bat pvf-change` 的同源同 change-set dry-run、approval code、显式 output、backup、readback 与 manifest 通道。
