# 地图宽屏结构迁移词典

状态：默认可用

## 角色定义

- 目标 PVF：保留玩法和身份、准备接收布局补全的一侧。
- 布局供体 PVF：提供已经扩展或修正的地图布局。
- 同路径地图：两侧 PVF 中规范化路径完全相同的 `.map`。默认只对同路径文件建立自动比较候选。
- 玩法块：改变怪物身份、生成条件、AI、特殊对象或副本归属的内容。
- 布局块：地形、背景、坐标、镜头、滚动和表现资源等可独立迁移候选。

## 初筛字段

### `[type]`

状态：默认可用

含义：地图类型。两侧不同应阻断自动迁移。

### 地图宽高、tile 宽高

状态：需验证

含义：地图与 tile 的尺寸线索。任务可选择“尺寸不同即跳过”，也可以在玩法兼容后把供体尺寸纳入布局计划。

边界：尺寸一致不代表结构兼容，尺寸不同也不能单独证明供体就是宽屏版本。

### 结构相似度

状态：需验证

含义：用块类型、记录数或布局计数做候选排序的启发式指标。

边界：阈值必须可配置；`70%` 可以作为人工初筛起点，但不是跨版本行为事实。相似度再高也不能覆盖玩法阻断项。

## 自动迁移阻断项

以下内容存在不一致时，默认拒绝整图自动合并：

- `[type]`
- `[dungeon]`
- `[monster]` 中除已确认坐标列以外的身份、等级、类型、数量或生成逻辑
- `[monster condition]`
- `[monster specific AI]`
- `[blood monster]`
- `[ultimate monster]`
- `[special passive object]`

`[special passive object]` 同时可能含深渊柱、机关或特殊地图对象。即使它也带坐标，未先证明对象身份和记录形状一致时仍属于玩法阻断项。

## 布局迁移候选

玩法兼容且目标最近邻样本确认列形后，可把下列内容加入布局计划：

- `[tile]`、`[extended tile]`
- `[animation]`、`[background animation]`
- `[passive object]`
- 玩家起点、PVP 起点
- movable area、virtual movable area
- pathgate、guild entrance
- event monster position、quest animation
- monster spawn position、attacked monster info
- BGM / sound
- camera limits
- map size、tile size
- background、far、middle、near scroll 等背景滚动层

边界：列表表示候选类别，不保证每个版本都使用相同标签拼写、列数和闭合形式。必须读取目标文件的同类块后再形成 change-set。

## 怪物、NPC、APC 与移动区

### 怪物坐标

状态：需验证

只允许在两侧记录能够按稳定身份键一一匹配、且目标最近邻确认坐标列后同步坐标。不得覆盖 monster ID、等级、类型、数量、条件或生成逻辑。重复身份或记录数量不一致时标记 ambiguous，不自动配对。

### NPC 坐标

状态：需验证

匹配键为 NPC ID。必须由任务单独启用，不能因为其他布局块允许迁移而隐式开启。

### APC 坐标

状态：需验证

匹配键为 AIC ID，并按 `aicharacter/aicharacter.lst` 解析。必须由任务单独启用。

### `[town movable area]`

状态：需验证

优先使用记录后部的稳定标识列匹配，而不是只按出现顺序。必须由任务单独启用；标识不唯一时保持 unresolved。

## 格式保真

目标文件的下列内容默认不可被供体整体覆盖：

- 原有 TAB、空列和缩进。
- 注释及注释位置。
- CRLF/LF 换行形式。
- 未识别块、未知列和目标专用扩展。
- 不在授权范围内的块顺序与内容。

迁移计划应表达为目标 raw no-simplified 文本上的最小替换，而不是序列化整个供体文件。

## 相对资源绑定

### `.map -> .til`

状态：默认阻断静默改绑

`.map` 中形如 `` `Tile/prisontile1.til` `` 的引用按地图所在目录重新解释。地图从 `map/A/` 复制到 `map/B/` 后，token 虽未变化，实际目标可能从 `map/A/tile/prisontile1.til` 变成 `map/B/tile/prisontile1.til`。

预演必须记录来源/目标实际路径、语义文本 SHA256，并在后端可提供时同时记录原始内容 SHA256。路径变化但最终内容一致可作为已核对的目录改绑；路径和内容同时变化属于高风险，不能仅凭“两个文件都存在”继续。

### `.til -> .img` 与 `[img pos]`

状态：需验证

TIL 的 IMG 引用和 `[img pos]` 会影响地图图集及偏移。目标目录重解析后应比较：

- IMG 引用列表；
- `[img pos]` 块；
- TIL 内容哈希；
- 是否由同一原子 change-set 复制了匹配 TIL。

Script 侧闭合不证明客户端 NPK/IMG 存在或绘制正确，仍需客户端资源检查和进图实测。
