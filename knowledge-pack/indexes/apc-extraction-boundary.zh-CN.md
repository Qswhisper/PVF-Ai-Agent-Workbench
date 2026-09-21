# APC 提取输出边界

状态：默认可用

## 可写入报告的结论

- root APC 的 `aicharacter/aicharacter.lst` 解析结果。
- `.aic`、`.ai`、`.key` 文件是否齐全。
- `[ai pattern]`、`[key stream]`、`[quick skill]`、`[skill]`、`[equipment]`、`[quick item]` 的静态引用。
- skill、equipment、stackable 的 registry 解析结果。
- 未闭合引用、读取错误、字段含义不确定项。

## 不可写入为事实的结论

- APC 在实机中会按预期移动、攻击或释放技能。
- AI 分支一定会触发。
- key stream 动作一定与玩家手感或技能时序一致。
- 固定首发动作只会执行一次，或普通 AI 不会再次选择同一逻辑动作。
- APC 被副本事件、门控、Boss 判定或脚本逻辑正确调用。
- `.aic` 数值列的含义在未验证时已确定。

## 升级到写入或导入前必须补齐

1. 目标 PVF 中 APC、skill、equipment、stackable registry 全部读回。
2. 冲突路径和同名文件已列出。
3. 只生成最小变更清单。
4. 写出到显式输出 PVF。
5. 输出 PVF 读回。
6. 涉及战斗表现或副本事件时实机验证。
