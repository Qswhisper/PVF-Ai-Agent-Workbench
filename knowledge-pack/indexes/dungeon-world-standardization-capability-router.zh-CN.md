# 副本与世界标准化能力路由

状态：默认可用

## 用途

把副本与世界相关任务先分成十个稳定能力，再读取对应的字段词典、工作流和任务卡。这个路由只保存可独立执行的 PVF 结构知识，不依赖任何外部软件、资料目录或历史研究文件。

## 十项能力

| 用户诉求 | 首选入口 | 处理结果 |
| --- | --- | --- |
| 副本接口布局 | `task-cards/worldmap-dungeon-interface-layout-readonly-plan.zh-CN.md` | 联合核对 `worldmap.lst -> .wdm -> .ui -> dungeon.lst`，输出按钮、入口和资源候选的一致性计划。 |
| 副本编辑器 | `task-cards/dungeon-map-spawn-entry-clear-resource-readonly-audit.zh-CN.md` | 读取 `.dgn/.map` 布局、刷怪、对象、入口、清算与资源引用；实际改动仍走受控写入。 |
| 副本难度系数 | `task-cards/dungeon-difficulty-ultimate-list-readonly-audit.zh-CN.md` | 分离 `.dgn` 的难度表引用、`.tbl` 数值矩阵和全局回退候选。 |
| 深渊组可视化 | `task-cards/hellparty-visualization-readonly-plan.zh-CN.md` | 闭合 `.dgn -> hell map -> hellparty.etc -> monster/APC registry`，输出组、权重、波次和未解析项。 |
| 地狱副本列表 | `task-cards/dungeon-difficulty-ultimate-list-readonly-audit.zh-CN.md` | 解析 `etc/ultimatedungeonlist.etc`，保留顺序和重复项，不把名单当运行证明。 |
| 城镇预览 | `task-cards/formal-region-town-worldmap-area-entry-readonly-audit.zh-CN.md` | 复核 region、town、worldmap、移动区、入口和预览资源候选。 |
| 城镇副本 ANI | `task-cards/client-assets-imagepacks-ui-readonly-audit.zh-CN.md` | 复核 `.ani/.act/.img/.til/.ui` 候选及客户端边界，不默认写客户端。 |
| 地图宽屏补全 | `task-cards/map-widescreen-structural-migration-readonly-plan.zh-CN.md` | 对同路径 `.map` 做玩法兼容审计，只迁移布局层并生成差异计划。 |
| 已验收副本数值微调 | `task-cards/validated-dungeon-numeric-tuning-readonly.zh-CN.md` | 不预设副本的版本地位或内容组合；保护已通过结构，只为一个反馈选择一个最小数值入口。 |
| 复杂副本机制壳移植 | `task-cards/complex-dungeon-mechanism-shell-readonly-audit.zh-CN.md` | 分开运行机制壳、战斗内容和显示身份；同名多 registry 身份、起始阶段例外和特殊机制覆盖均保留为显式风险。 |

## 路由原则

1. 先确定任务属于哪一项；跨项任务可以组合，但每项分别出结论。
2. 任何数字先按父块选择 registry，不能跨 `worldmap.lst`、`dungeon.lst`、`map.lst`、`monster.lst`、`aicharacter.lst` 或 `passiveobject.lst` 猜测。
3. “可视化”表示把引用关系和未闭合项结构化呈现，不代表界面、刷怪、掉落或服务端逻辑已经实机成立。
4. “标准化”表示使用稳定输入、匹配键、阻断条件和验收项，不表示可以跳过目标 PVF raw readback。
5. 所有预览、对比和计划默认只读。需要写出时，必须从目标 PVF 的 raw no-simplified 文本重建最小 change-set，再走 `pvf-change` 的 dry-run、授权码、显式输出、备份和读回。
6. PVF 内的 IMG、ANI、UI、TIL、音频路径只记为客户端候选；没有独立客户端检查或实机结果时保持未知。

## 组合任务建议

- 新增副本入口：先做“副本编辑器”静态闭合，再做“副本接口布局”，最后做客户端资源候选检查。
- 移植深渊副本：先做“深渊组可视化”，再做“地图宽屏补全”；玩法块冲突时停止自动迁移。
- 调整高难副本：把“副本难度系数”和“地狱副本列表”分开审阅，不能把入选名单当倍率表。
- 移植塔式、事件或其他特殊副本：先证明机制壳可以完成完整循环，再逐批替换战斗内容和显示身份；第一阶段与后续阶段分开测。
- 城镇与入口移植：组合“城镇预览”“副本接口布局”“城镇副本 ANI”，三者分别验收。

## 实机预算

默认先合并静态检查，只有在将要分发输出 PVF 时才安排高收益批次。一次实机批次可同时覆盖多个入口的可见性、点击、进图、地图边界、深渊柱、波次、结算和客户端资源表现；不要为每个静态字段单独消耗一次测试。
