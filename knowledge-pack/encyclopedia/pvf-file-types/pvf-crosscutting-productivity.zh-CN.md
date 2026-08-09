# PVF 横向生产力能力

状态：默认可用

## 是什么

PVF 工作不只有“某个标签是什么意思”和“某类任务怎么改”。当任务扩大到全包或批量内容时，还需要一层横向能力，把许多文件组织成可审计、可比较、可预览的工作集。

Workbench 将这层能力分成七条路线：

1. 全包脚本与 registry 质量审计。
2. 双 PVF 语义对比、结果集集合运算、StringTable / Section 频次分析。
3. `.lst` 注册、导出、重复、交集和引用闭合的完整生命周期。
4. 独立掉落池规范化与英雄档候选补全。
5. 从任务、掉落、商店、礼包和配方反查物品来源。
6. 技能树 SP / TP 布局与多职业合并安全审计。
7. 任务、礼盒、徽章和装备复制等多文件原子内容生成。

## 默认路由

| 任务 | 入口 |
| --- | --- |
| 全包脚本、SQR、ACT、LST 与 registry 质量审计 | `task-cards/pvf-package-quality-audit-readonly.zh-CN.md` |
| 双 PVF 语义对比、结果集与集合运算 | `task-cards/pvf-semantic-compare-workset-readonly.zh-CN.md` |
| `.lst` 新增、查重、导出与引用闭合 | `task-cards/lst-registry-lifecycle-readonly-plan.zh-CN.md` |
| 独立掉落整理与英雄档候选补全 | `task-cards/independent-drop-normalization-readonly-plan.zh-CN.md` |
| 任务、掉落、商店、礼包和配方来源反查 | `task-cards/item-source-graph-readonly.zh-CN.md` |
| 技能树布局与多职业合并 | `task-cards/skill-tree-layout-merge-readonly-plan.zh-CN.md` |
| 任务、礼盒、徽章和装备复制等原子内容计划 | `task-cards/atomic-content-generation-readonly-plan.zh-CN.md` |

普通商店、装备、技能、任务、副本、APC 和客户端资源问题继续使用 `indexes/knowledge-index.json` 中的具体主题，不需要先经过本入口。

## 为什么单独成层

- 字段词典回答“这个块可能表示什么”，横向路线回答“一次操作跨哪些文件、如何判冲突、怎样报告遗漏”。
- 单项 workflow 回答“一类需求怎么做”，横向路线还要处理集合、批量、重复、截断、原子性和失败项。
- 自动化结果只是候选索引。最终结论仍来自目标 PVF 的 raw readback、正确 registry 和必要的客户端 / 实机分层验证。

## 统一输出形状

每条横向路线至少输出：

- 目标 PVF 完整 SHA256；双包任务还要分别记录双方角色。
- 任务范围、筛选器和是否发生截断。
- 已解析、未解析、读取失败、冲突和被阻断项。
- 具体路径、registry、ID 与引用方向。
- preview 差异，而不是笼统“可一键处理”。
- 是否生成输出 PVF、是否修改客户端、哪些行为仍需实机。

## 写入边界

横向能力默认只读。即使预览没有冲突，也不能直接把生成索引或外部结果写回。任何授权改动都要从目标 raw no-simplified 文本重建最小 change-set，并通过 `pvf-change` 的 dry-run manifest、approval code、显式输出、备份和 readback。
