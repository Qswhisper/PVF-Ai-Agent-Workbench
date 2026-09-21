# 地图宽屏结构迁移只读计划

状态：默认可用

用途：比较目标 PVF 与布局供体 PVF 的同路径 `.map`，判断哪些布局可迁移、哪些玩法冲突必须阻断。

## 先读

- `safety/README.zh-CN.md`
- `dictionaries/map-widescreen-structural-migration-fields.zh-CN.md`
- `workflows/map-widescreen-structural-migration.zh-CN.md`

## 最小输入

- 两个 `Script.pvf` 路径及各自角色：目标、布局供体。
- 显式 `.map` 路径、map ID 或 dungeon ID。
- 是否跳过尺寸不同地图。
- 是否分别允许 NPC、APC、town movable area 坐标进入计划。

## 执行

1. 只读读取两侧 `map/map.lst` 和目标 `.map`；按 registry 解析输入 ID。
2. 只处理两侧都存在的同路径地图。
3. 先比较玩法阻断块，再看结构相似度和布局差异。
4. 相似度很高但 `[special passive object]`、monster 非坐标逻辑或其他玩法块不同，仍输出 blocked。
5. 对允许迁移的块输出逐块 diff；怪物只允许坐标候选。
6. 对每个 `.map` 的相对 `.til` 引用分别按来源目录和目标目录重解析，并继续展开 `.til -> .img`；同 token 改绑到不同内容时标记高风险阻断。
7. 保留目标格式、注释、未知块和未授权字段。
8. 默认只给 preview，不生成输出 PVF。

## 必须汇报

- 两侧 PVF SHA 与同路径地图。
- 相似度只作初筛。
- 玩法兼容/阻断项。
- 可迁移布局块、单独启用的坐标类别和 unresolved。
- 客户端资源候选。
- `.map -> .til -> .img` 的前后实际解析路径、文本/原始内容 SHA256（可得时）及 `[img pos]` 差异。
- 是否写出 PVF、是否修改客户端、是否需要实机。

## 禁止

- 只因相似度达标就整文件覆盖。
- 用供体 monster ID、等级、类型、数量或生成逻辑覆盖目标。
- 把特殊对象差异当普通坐标差异。
- 把供体格式化后的全文写回目标。
- 只证明目标目录存在同名 TIL，就把相对引用视为迁移安全。
