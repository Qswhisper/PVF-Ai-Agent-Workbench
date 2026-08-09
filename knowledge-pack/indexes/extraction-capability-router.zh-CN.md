# 提取类能力路由索引

状态：默认可用

## 用途

把跨文件提取需求映射到 Workbench 的纯净入口。本文只保留能力路由和边界，不携带外部实现、界面、实验记录或证据链。

跨域依赖预览统一先进入 `workflows/unified-dependency-planner.zh-CN.md`；下表中的领域 workflow 用于继续解释专项字段和运行时缺口。

## 路由表

| 能力 | 默认入口 | 处理 |
| --- | --- | --- |
| 装备、宠物、时装、光环相邻依赖 | `workflows/equipment-avatar-aura-creature-extraction-planner.zh-CN.md` | 只读 planner；输出候选依赖、registry 线索、视觉资源风险和未闭合引用。 |
| stackable、礼包、宝箱、选择箱、宝珠、卡片 | `workflows/stackable-package-orb-card-extraction-planner.zh-CN.md` | 只读解析；不生成礼包，不模拟抽奖，不证明附魔成功。 |
| equipmentpartset.etc 套装关系 | `workflows/equipment-avatar-aura-creature-extraction-planner.zh-CN.md` | 只读解析和校验；不自动合并、不重排。 |
| 副本、地图、worldmap、monster、passiveobject、APC 闭包 | `workflows/dungeon-extraction-planner.zh-CN.md` | 使用副本提取 workflow；输出 preview index，不直接导入。 |
| APC、AICharacter、AI、key stream | `workflows/apc-extraction-planner.zh-CN.md` | 使用 APC 提取/分析 workflow；静态闭合不证明实机行为。 |
| monster、passiveobject、actionobject 相邻链 | `task-cards/monster-mob-readonly-audit.zh-CN.md` 与 PassiveObject 路由 | 先只读闭合；需要跨副本时由副本提取 workflow 汇总。 |
| ANI/ALS/IMG/NPK/ImagePacks2 查询 | `workflows/client-asset-path-preview.zh-CN.md` | 只读资源路径索引或缺口检查；写 NPK 必须另行授权。 |
| recipe、quest、礼包生成器、抽奖模拟 | 暂不作为提取 planner | 可后续做 authoring template；不得混入 extraction 默认入口。 |
| 授权验证、群验证、数据库校验、机器码 | 禁用 | 不进入知识包能力复原。 |
| NUT/SQR 打乱、混淆、破坏性批量写入 | 禁用 | 不复原为默认能力。 |

## 道具类路由澄清

- 道具类提取默认先路由到 stackable/package/orb/card planner 和 equipment/avatar/aura/creature planner。
- 需要证明开箱、附魔、宠物携带、光环视觉或客户端资源显示时，切换到生产生命周期和目标客户端实机验证。
- wrapper、child item、宠物蛋、creature 本体、光环装备和视觉资源是不同验收层，preview 不能合并结论。

## 默认判断

- 能复用现有 workflow 的能力，进入路由，不重造工具。
- 能只读规划的能力，优先输出 preview index。
- 需要写 PVF、写 NPK 或部署客户端的能力，必须切换到生产生命周期。
- 外部索引或工具输出只能作为能力线索；目标 PVF 和目标客户端必须重新闭合。
