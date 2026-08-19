# LST Registry 生命周期流程

状态：默认可用

## 目标

对任意目标 `.lst` 做只读导出、候选登记、冲突预览和引用闭合。流程不局限于某几个硬编码 registry。

## 只读导出

1. 明确目标 PVF SHA、registry 路径和用途。
2. 逐行解析 code / path；名称从对应目标脚本读取，作为单独显示列。
3. 保留注释、空行、malformed row、重复 ID、重复路径和读取失败。
4. 导出表只用于导航；名称和导出顺序不改变 registry 身份。

## 候选输入

1. 接受 `ID + TAB + relative path` 的明确记录；仅在用户声明时接受逗号拆列。
2. 忽略空行、`#` 和 `//` 注释行，但在 preview 中报告忽略数量。
3. 数字必须符合目标 registry 的约定；通常要求正整数，特殊 0 值以目标样本为准。
4. 规范化斜杠只用于比较，最终写回保持目标原格式。

## 冲突预览

对每条候选分类：

- exact-existing：同 ID 同路径，复用。
- id-conflict：同 ID 不同路径，阻断。
- path-conflict：同路径不同 ID，阻断或由用户明确选择迁移策略。
- missing-target-file：目标脚本不存在，阻断登记。
- malformed / ambiguous：无法唯一解析，阻断。
- clean-add：没有冲突，但仍需审阅引用方和近邻格式。

## 原子登记

1. 创建新脚本、registry 行和所有引用方组成同一个计划。
2. 先读取约 3 个目标同类样本，确认脚本块形和 registry 行格式。
3. 对引用数字说明它应由哪个 registry 解析；不能仅因数字唯一就跳过父块。
4. 输出新增路径、ID、引用入边、客户端资源候选和 unresolved。

## 受控写入

用户明确授权后，分别从目标 raw no-simplified registry 和引用文件建立精确 change-set。dry-run 必须同时覆盖脚本、registry 和引用方；任一文件阻断则整个原子计划不 apply。

新增完整 `.lst` 或给既有 `.lst` 加行时，使用 `task-cards/pvf-high-risk-new-file-controlled-change.zh-CN.md` 的 `registry-lifecycle` 证明。既有 registry 只允许 `action=add`；去掉证明的新行后，最终文本必须与原文逐字一致，不能顺带修改或重排旧行。

## 验收

- 任意 `.lst` 都可按目标格式处理，不依赖硬编码四类 registry。
- 重复与冲突在写前可见，不静默覆盖。
- 新脚本、登记和引用闭合同时审阅。
- 导出名称未被当作实体主键。
