# Text / StringLink / Encoding 字段字典

状态：默认可用

用途：解释 PVF 文本字段、StringLink 样 token、字符串资源、本地化和编码风险的口径。本文不授权写 PVF。

## 核心术语

| 术语 | 静态含义 | 目标核验 | 边界 |
| --- | --- | --- | --- |
| StringLink 样 token | `<namespace::key\`文本\`>` 或相近形态 | 需在当前目标 PVF 中只读确认 | 只证明脚本文本中有链接样结构 |
| namespace | StringLink 中 `::` 前的数字 | 需在当前目标 PVF 中只读确认 | 只能作为分布提示，不是全局 registry |
| key / head | StringLink 中 `::` 后、反引号前的键 | 需在当前目标 PVF 中只读确认 | 不等同于物品 ID、怪物 ID 或任务 ID |
| 内嵌文本 | StringLink 反引号中的可见文本 | 需在当前目标 PVF 中只读确认 | 不证明 UI 一定显示该文本 |
| 直接文本 | 普通反引号 token 中的文本样内容 | 需在当前目标 PVF 中只读确认 | 可能是说明、枚举、脚本条件、路径或逻辑字符串，需看父标签 |
| 名称表 | `itemname.lst`、`monstername.lst` 等 | 需在当前目标 PVF 中只读确认 | 不是文件路径 registry |
| `.str` 文件 | 多目录本地化字符串资源候选 | 需在当前目标 PVF 中只读确认 | 不证明运行时加载顺序 |
| `n_string.lst` | 字符串资源候选入口 | 需在当前目标 PVF 中只读确认 | 不等同于所有文本来源 |
| `stringtable.bin` | 二进制字符串表候选 | 需在当前目标 PVF 中只读确认 | 不允许人工直接编辑；验证模式只追加新条目并证明旧条目未变 |
| replacement char | Unicode replacement character 字形 | 需在当前目标 PVF 中只读确认 | 编码/反编译风险桶，不能静态硬修 |

## 高频文本字段

| 字段或标签 | 静态含义 | 边界 |
| --- | --- | --- |
| `[name]` | 名称字段，常见 StringLink 或直接文本 | 文本存在不证明 UI 显示正常 |
| `[name2]` | 第二名称或附加名称字段 | 需看文件类型上下文 |
| `[map name]` | 地图名称字段 | 不证明副本入口可见 |
| `[explain]` | 说明文本 | 不证明效果、数值或运行逻辑 |
| `[basic explain]` | 基础说明文本 | 只当说明文本 |
| `[flavor text]` | 描述/风味文本 | 不证明道具功能 |
| `[minimum info]` | APC / AI 角色等最小信息 | 可能含名称文本 |
| `[ui controls]` | UI 控件文本或控制字段 | 不证明客户端 UI 正常 |
| `[name_text]` | PVP Mission 名称文本引用 | 不证明任务 UI 可见 |
| `[cond_text]` | PVP Mission 条件文本引用 | 不替代条件列解释 |
| `[condition message]` / `[solve message]` / `[depend message]` | 任务条件、完成、依赖文本 | 不证明任务条件实机生效 |
| `[string data]` | 字符串列表或字符串参数块 | 可能是脚本、资源、音频或文本，必须看父文件 |

## 解析规则

| 场景 | 正确动作 | 禁止动作 |
| --- | --- | --- |
| 看到 StringLink | 记录 namespace、key、父标签、所在文件类型 | 直接猜物品/任务/怪物 ID |
| 看到中文文本 | 先判断是说明、名称、脚本字符串还是资源路径 | 直接写成 UI 显示成功 |
| 看到 `.str` | 作为字符串资源候选 | 直接改 `.str` 并认为生效 |
| 看到 `stringtable.bin` | 作为二进制字符串表候选；普通脚本中文只能交给验证写入器追加条目 | 人工编辑、覆盖旧条目或把它当作通用本地化写入入口 |
| 看到 replacement char | 进入编码风险桶 | 不直接替换或猜原文 |

## 静态与动态边界

静态只读可以确认：

- 文本字段是否存在。
- StringLink 样 token 的分布。
- 字符串资源候选文件是否存在。
- Tw 解码下的可见 CJK、ASCII、replacement char 形态。

静态只读不能确认：

- 未经过受控往返验证的中文写入是否安全。
- UI 是否显示、换行、缩放或不溢出。
- 客户端字体是否覆盖。
- `stringtable.bin` 或 `.str` 的实际加载优先级。
- 服务端是否放行。

## 已验证写入边界

- 语义读取已覆盖 `.str`、StringLink、中文脚本搜索、含非 ASCII 的脚本以及 `Cn`/`Tw` 冲突；这是自动只读保护。若请求编码呈现明显乱码而会话编码更可信，结果会保留正常文本并标出实际选择。
- 数字或 ASCII 最小替换可以使用正确语义源文本、受控输出和 fallback 读回；触达文本承载文件时仍要求客户端 UI smoke check。
- 普通脚本中一个完整、明确的可见反引号文本可以使用 `textWriteMode: "verified-inline-text"` 和目标确认的 `Cn` 或 `Tw`。它只按同一编码追加一个新字符串表条目，并把目标脚本的一个文本 token 指向新条目；预演必须生成隔离临时输出、由独立 TypeScript 解析器按同一编码精确读回，并证明所有旧字符串条目保持不变。明显乱码且另一编码更可信时会失败关闭；旧字段为 ASCII 或空字符串时，还必须从同一脚本的已有中文取得编码证据。
- 首期只接受已确认的显示承载类型（如 `.stk`、`.equ`、`.qst`、`.dgn`、`.map`、`.aic`、`.cre`、`.skl` 等）；`.co`、`.lst`、NUT 和其他未批准类型继续阻断。
- `.str`、StringLink 显示文本、部分 token、批量中文替换、无法编码字符和其他未验证中文写入仍失败关闭，不能生成 approval code。

边界：

- 直接中文能力只覆盖普通脚本中允许标签下的单个完整文本 token，不覆盖名称表、`.str`、StringLink 或任意逻辑字符串。
- PVF 读回正常不等于客户端 UI 文本安全。
- 任何触达中文字符串或 StringLink 样 token 的输出，部署后都要检查相关 NPC、道具名、道具描述、副本入口或副本文本。
