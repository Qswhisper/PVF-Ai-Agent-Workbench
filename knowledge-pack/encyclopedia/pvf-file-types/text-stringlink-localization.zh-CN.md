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
- `stringtable.bin` 不允许人工直接编辑；验证模式只为普通脚本的单个内联中文追加新条目，并强制证明旧条目未变。
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

普通脚本中允许标签下的一个完整反引号名称/描述，可以使用 `textWriteMode: "verified-inline-text"` 和目标确认的 `Cn` 或 `Tw`。预演会先按同一编码生成并清理隔离临时输出，只有独立 TypeScript 解析器精确读回、旧字符串表条目保持不变且没有更可信的另一编码时，才给出正式生成许可。正式输出仍需备份、独立读回和客户端文本 smoke check。

这不授权 `.str`、StringLink 显示文本、名称表、部分 token、批量中文替换或无法无损编码的字符；这些路线继续失败关闭。PVF 读回也不代替游戏内的字体、换行、溢出和乱码检查。
