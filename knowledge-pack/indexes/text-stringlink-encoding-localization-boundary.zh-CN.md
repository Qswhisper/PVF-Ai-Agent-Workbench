# Text / StringLink / Encoding / Localization Boundary

状态：默认可用


## 审计快照

| 项 | 目标核验 |
| --- | ---: |
| PVF 文件总数 | 需在当前目标 PVF 中只读确认 |
| 扫描文本承载文件 | 需在当前目标 PVF 中只读确认 |
| 读取失败 | 需在当前目标 PVF 中只读确认 |
| 字符串资源候选文件 | 需在当前目标 PVF 中只读确认 |
| 含 StringLink 样 token 的文件 | 需在当前目标 PVF 中只读确认 |
| StringLink 样 token | 需在当前目标 PVF 中只读确认 |
| 唯一 StringLink key | 需在当前目标 PVF 中只读确认 |
| StringLink 内嵌非 ASCII/CJK 文本 | 需在当前目标 PVF 中只读确认 |
| StringLink 内嵌 replacement char | 需在当前目标 PVF 中只读确认 |
| 含反引号 token 的文件 | 需在当前目标 PVF 中只读确认 |
| 反引号 token | 需在当前目标 PVF 中只读确认 |

## 编码形态

| 形态 | 目标核验 | 口径 |
| --- | ---: | --- |
| 文件级 CJK 字形 | 需在当前目标 PVF 中只读确认 | Tw 解码下可观察到 CJK 字形 |
| 文件级 ASCII | 需在当前目标 PVF 中只读确认 | 纯 ASCII 或近似纯 ASCII |
| 文件级 replacement char | 需在当前目标 PVF 中只读确认 | 编码/反编译风险桶 |
| StringLink 内嵌 CJK | 需在当前目标 PVF 中只读确认 | 可见文本，不证明 UI 成功 |
| StringLink 内嵌 ASCII | 需在当前目标 PVF 中只读确认 | key、英文或符号文本 |
| StringLink 内嵌 replacement char | 需在当前目标 PVF 中只读确认 | 当前未观察到 |
| 反引号 token 中 CJK | 需在当前目标 PVF 中只读确认 | 包含说明、名称、文本，也可能混有非显示字段 |
| 反引号 token 中 replacement char | 需在当前目标 PVF 中只读确认 | 需要单独风险复核 |

## 扫描文件类型

| 扩展名 | 扫描数 |
| --- | ---: |
| `.equ` | 79931 |
| `.stk` | 10467 |
| `.ai` | 7518 |
| `.obj` | 6983 |
| `.qst` | 3979 |
| `.map` | 3147 |
| `.skl` | 2372 |
| `.mob` | 2090 |
| `.aic` | 659 |
| `.cre` | 615 |
| `.dgn` | 336 |
| `.ui` | 301 |
| `.etc` | 283 |
| `.nut` | 235 |
| `.npc` | 176 |
| `.msn` | 126 |
| `.shp` | 90 |
| `.lst` | 83 |
| `.str` | 44 |

说明：当前不扫描巨量 `.ani` 帧文件；动画、帧、贴图和音频资源仍归各自资源主线。

## StringLink 分布

按扩展名：

| 扩展名 | StringLink 数 | 口径 |
| --- | ---: | --- |
| `.stk` | 11017 | 道具名称、说明和描述高频 |
| `.obj` | 4722 | passiveobject 名称、说明、对话或情境文本 |
| `.equ` | 3083 | 装备名称、说明、套装说明等 |
| `.aic` | 2775 | APC 名称、对白、情境文本 |
| `.map` | 2722 | 地图名称 |
| `.mob` | 1087 | 怪物名称或相关文本 |
| `.etc` | 777 | 活动/配置文本候选 |
| `.ui` | 553 | UI 控件文本候选 |
| `.qst` | 387 | 任务文本 |
| `.msn` | 242 | PVP Mission 文本 |

按标签：

| 标签 | StringLink 数 | 边界 |
| --- | ---: | --- |
| `[name]` | 11353 | 名称文本候选，不证明 UI 正常 |
| `[name2]` | 5057 | 第二名称或附加名称候选 |
| `[map name]` | 2722 | 地图名称候选 |
| `[explain]` | 2052 | 说明文本，不证明效果 |
| `[on attack]` | 1190 | 情境对白，不证明触发 |
| `[flavor text]` | 1084 | 描述文本，不证明功能 |
| `[combo]` | 513 | 组合/连段文本或参数候选 |
| `[minimum info]` | 503 | APC 等最小信息 |
| `[ui controls]` | 460 | UI 文本或控制字段 |
| `[speech on situation]` | 273 | 情境对白 |
| `[name_text]` | 121 | PVP Mission 名称文本 |
| `[cond_text]` | 121 | PVP Mission 条件文本 |

按 namespace：

| namespace | StringLink 数 | 主要目录提示 |
| --- | ---: | --- |
| `13` | 11017 | stackable |
| `9` | 4722 | passiveobject |
| `3` | 3083 | equipment |
| `17` | 2776 | aicharacter |
| `6` | 2722 | map |
| `7` | 1086 | monster |
| `4` | 895 | etc |
| `20` | 489 | ui / mixed |
| `11` | 387 | quest |
| `21` | 242 | pvp_mission |


## 字符串资源候选


- `n_string.lst`
- `stringtable.bin`
- `itemname.lst`、`monstername.lst`、`npcname.lst`、`passiveobjectname.lst`、`aicharactername.lst`
- `skillname0.lst` 到 `skillname9.lst`
- `aicharacter`、`character`、`common`、`creature`、`dungeon`、`equipment`、`etc`、`event`、`itemshop`、`map`、`monster`、`n_quest`、`npc`、`passiveobject`、`pet`、`pvp_mission`、`region`、`skill`、`stackable`、`stagemap`、`town`、`ui`、`worldmap` 等目录下的 `.str` 文件。

处理口径：

- 名称表和 `.str` 可作为文本资源候选。
- `stringtable.bin` 是二进制字符串表候选。
- 当前不证明运行时加载优先级，也不证明改哪个文件会影响客户端 UI。


| 项 | 目标核验 | 跨版本候选；需在当前目标 PVF 中复核 | 差异提示 |
| --- | ---: | ---: | --- |
| PVF 文件总数 | 需在当前目标 PVF 中只读确认 | 1052773 | 辅助体量更大 |
| 扫描文本承载文件 | 需在当前目标 PVF 中只读确认 | 194048 | 辅助扫描量更大 |
| 字符串资源候选文件 | 需在当前目标 PVF 中只读确认 | 59 | 接近 |
| 含 StringLink 文件 | 需在当前目标 PVF 中只读确认 | 1091 | 辅助明显更少 |
| StringLink 样 token | 需在当前目标 PVF 中只读确认 | 4105 | 辅助明显更少 |
| 反引号 token | 需在当前目标 PVF 中只读确认 | 5204863 | 辅助更多 |


## 静态与动态边界

静态只读可以确认：

- 文本承载文件是否可读。
- StringLink 样 token 是否存在及其父标签分布。
- 直接反引号 token 和 CJK/replacement char 形态。
- 字符串资源候选文件是否存在。

静态只读不能确认：

- 任意中文写入流程都安全；只有受控验证模式覆盖的单字段内联文本具有机器往返证据。
- UI 实际显示、字体覆盖、换行宽度、文本溢出或控件布局。
- 客户端资源完整。
- `.str`、名称表或 `stringtable.bin` 的运行时加载优先级。
- 服务端放行或实机行为。

## 当前已收窄的运行边界

- 已有反例证明：读回看似正常的输出 PVF 仍可能在客户端出现道具名、描述和副本文本乱码。
- 因此 Workbench 写出流程必须把“客户端 UI 文本 smoke check”列为中文/StringLink 文件的部署验收项。
- 普通脚本中允许标签下的单个完整反引号文本，现可使用 `verified-inline-text` 和目标确认的 `Cn` 或 `Tw`：预演先按同一编码隔离写出，独立 TypeScript 解析器必须精确读回，并证明所有旧字符串表条目保持不变；明显乱码或任一检查失败则不给 approval code。
- 该证据不扩展到 `.str`、StringLink 显示文本、名称表、部分 token、批量替换或无法无损编码字符。

仍未证明：

- `.str`、StringLink 显示文本、名称表或任意中文字符串的通用写入流程。
- `.str`、名称表或 `stringtable.bin` 的运行时加载优先级。
