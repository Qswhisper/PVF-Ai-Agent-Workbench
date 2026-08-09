# Text / StringLink / Localization 文件类型

状态：默认可用

## 用途

PVF 文本可以出现在普通脚本文本字段、StringLink 样 token、名称表、`.str` 文件和二进制字符串表候选中。本页说明这些文件和字段的静态边界。

## 常见承载位置

| 位置 | 例子 | 用法 |
| --- | --- | --- |
| 普通文本字段 | `[name]`、`[explain]`、`[flavor text]`、`[message]` | 名称、说明、提示、描述 |
| StringLink 样 token | `<13::...\`...\`>`、`<9::...\`...\`>` 等 | 链接样文本或本地化 key |
| 名称表 | `itemname.lst`、`monstername.lst`、`npcname.lst`、`skillname*.lst` | ID 到名称/文本 |
| `.str` 文件 | 多目录 `.kor.str`、`.jpn.str`、`.chn.str` | 本地化字符串资源候选 |
| 字符串入口 | `n_string.lst` | 字符串资源候选入口 |
| 二进制字符串表 | `stringtable.bin` | 二进制字符串表候选 |

## 核心规则

- 文本字段存在，不等于 UI 实际显示。
- StringLink 样 token 不是普通 registry ID。
- 名称表不是文件路径 registry。
- `.str` 文件存在，不等于客户端一定加载。
- `stringtable.bin` 当前只作为候选存在性记录，不做二进制写入。
- Tw 解码下可读，不等于其他编码也正确。
- replacement char 命中表示编码/反编译风险，不能直接猜原文。

## 写入边界

Workbench 会自动为 `Cn` 的 `.str`、StringLink、非 ASCII 脚本与正文搜索选择语义安全读取，不要求用户配置 backend。

改文本前必须确认：

1. 目标文件和字段。
2. 文本是直接字段、StringLink 内嵌文本、名称表、`.str` 还是二进制字符串表。
3. 输出 PVF 不是源 PVF。
4. 保存后重新打开读回。
5. 实机检查 UI 是否显示、是否乱码、是否换行正常、是否溢出。

本页不授权直接写中文文本，也不证明任何文本写入流程已经可生产使用。
当前受控通道会明确阻止 `Cn .str` 和直接非 ASCII 文本写入；数字或 ASCII 最小替换仍需输出新 PVF、读回和客户端文本 smoke check。
