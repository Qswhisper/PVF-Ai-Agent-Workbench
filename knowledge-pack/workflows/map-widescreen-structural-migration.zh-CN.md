# 地图宽屏结构迁移流程

状态：默认可用

## 目标

从一个布局供体 PVF 向目标 PVF 的同路径 `.map` 迁移宽屏布局层，同时保留目标玩法、ID、未知块和文本格式。默认只生成只读兼容审计和迁移计划，不写 PVF。

## 输入

- 目标 PVF 与完整 SHA256。
- 布局供体 PVF 与完整 SHA256。
- 筛选器至少一个：显式 `.map` 路径、map ID、dungeon ID 或地图类型/路径前缀。
- 可配置的相似度初筛阈值。
- 是否“宽高不一致即跳过”。
- NPC、APC、town movable area 坐标是否分别允许进入计划。
- 是否允许最终生成输出 PVF；没有明确授权时保持 preview-only。

## 阶段一：定位同路径地图

1. 若输入 map ID，分别通过两侧 `map/map.lst` 解析，不假设同号 ID 指向同路径。
2. 若输入 dungeon ID，先在目标 `dungeon/dungeon.lst` 解析 `.dgn`，再读取地图引用；供体侧按路径闭合。
3. 规范化斜杠和大小写后，只保留两侧都存在的同路径 `.map`。
4. 任一侧读取失败、路径多义或 registry 不闭合时，将该文件标记 unresolved，不进入自动迁移。

## 阶段二：玩法兼容审计

1. 用结构计数计算相似度，只作候选排序。
2. 比较地图类型、副本归属、怪物记录非坐标部分、怪物条件、特定 AI、blood/ultimate monster 和 special passive object。
3. 任一玩法项不同，输出 `blocked-gameplay-divergence`。相似度高不能解除阻断。
4. 怪物记录只有在身份键、记录数量、列形都可证明一一对应时，才允许单独比较坐标。
5. 若任务要求尺寸不同即跳过，在此阶段输出 `skipped-size-divergence`；否则尺寸变化留到布局计划。

## 阶段三：建立布局迁移计划

1. 按 `dictionaries/map-widescreen-structural-migration-fields.zh-CN.md` 的候选块逐项比较。
2. 每一项记录 `unchanged / replace / add / target-only / donor-only / ambiguous`。
3. monster 只生成坐标差异，不复制身份、等级、类型、数量或生成逻辑。
4. NPC 按 NPC ID、APC 按 AIC ID、town movable area 按后部稳定标识列匹配；三类必须分别显式启用。
5. 对重复键、缺键和列形分歧保留 unresolved，不按出现顺序强配。
6. 客户端 `.til/.img/.ani` 等只记录候选路径，不写客户端。

## 阶段三补充：目标目录资源重解析

1. 从来源 `.map` 与最终目标 `.map` 提取完整 `.til` token。
2. 相对 token 分别以来源地图目录、目标地图目录为基准解析；使用最终原子方案中的待复制文件，不只查看原始 PVF。
3. 对解析出的 TIL 记录实际路径、语义文本 SHA256和可得的原始内容 SHA256，再比较 IMG 引用与 `[img pos]`。
4. 同一相对 token 在目标目录命中内容不同的 TIL 时输出 `MAP_RELATIVE_RESOURCE_REBIND_HIGH_RISK`，扣留生成许可。
5. 如果同一 change-set 已复制匹配 TIL，使最终目标内容一致，则保留路径变化证据并允许继续；不要求为了切换其他 `.map` 引用而人为拆成累计第二轮。
6. 无法解析的目标 TIL 保持阻断；`.img` 仍是客户端资源候选，不声称已验证 NPK。

## 阶段四：格式保真与预览

1. 从目标 PVF 重新读取 raw no-simplified 文本。
2. 以目标原块为 previousText，以最小字段/记录替换为 newText。
3. 保留目标 TAB、缩进、注释、换行、未知块和未授权块。
4. 输出逐文件 diff、阻断原因、unresolved、资源候选和实机验收项。
5. 输出 `.map -> .til -> .img` 前后绑定、哈希及关键字段差异。
6. preview 不得声称已经生成可用宽屏地图。

## 阶段五：受控写出

仅在用户授权生成新 PVF 后执行：

1. 把已审阅计划重建为精确 change-set。
2. `workbench.bat pvf-change validate`。
3. 对同一目标 PVF、同一 change-set 做未阻塞 dry-run。
4. 使用匹配的 manifest 和 approval code，写到显式新输出，创建备份并读回。
5. 不覆盖源 PVF，不写客户端。

## 高收益实机批次

一次批次可以选 5-10 张代表地图，合并检查：

- 左右边界、门、玩家起点、镜头和滚动背景。
- 怪物出生位置与数量没有被改变。
- 深渊柱、机关和特殊对象仍在正确位置并能触发。
- NPC/APC/城镇移动区只在已启用时发生坐标变化。
- 无黑图、红叉、丢 tile、背景断层或卡死。

批次结果按地图和检查项记录 PASS/FAIL；不要把一张地图的结果外推到所有 map 类型。

## 验收

- 两侧 PVF 和每个文件均有 SHA/路径身份。
- 自动候选全部是同路径 `.map`。
- 玩法阻断先于相似度判断。
- 未覆盖目标怪物身份或生成逻辑。
- 格式和未知块保持目标原样。
- 相对 TIL 在目标目录重新解析；静默改绑到不同内容时已阻断。
- 输出明确区分 preview、已写 PVF 和实机结果。
