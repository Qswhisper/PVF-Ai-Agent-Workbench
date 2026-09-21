# 装备与道具只读核查

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `encyclopedia/pvf-file-types/equipment-stackable.zh-CN.md`
- `dictionaries/equipment-fields.zh-CN.md`
- `dictionaries/stackable-fields.zh-CN.md`
- `workflows/item-stackable-dependency-planner.zh-CN.md`
- `indexes/item-stackable-dependency-planner-boundary.zh-CN.md`

## 执行

1. 确认目标 PVF，只读打开。
2. 根据任务判断目标是装备、可堆叠道具、材料、消耗品、礼包、设计图还是任务物品。
3. 通过正确 registry 解析目标 ID，不能用全局搜索替代 registry。
4. 如果目标涉及依赖闭包、礼包候选、宝珠卡片、宠物蛋、光环 / 时装相邻资源或导入前审阅，先运行 item / stackable 只读 planner。
5. 审阅 planner 的 root、candidates、relations、unresolvedReferences、registryAdditionPreview 和 externalAssetRefs；planner 输出不是导入计划。
6. 读取目标 `.equ` 或 `.stk` 文件。
7. 记录基础显示字段：`[name]`、`[grade]`、`[rarity]`、说明文本。
8. 记录限制字段：`[minimum level]`、`[usable job]`、`[attach type]`。
9. 记录经济字段：`[price]`、`[cash]`、`[value]`、`[repair price]`、`[need material]`、`[medal]`。
10. 记录重量和类型字段：`[weight]`、`[equipment type]`、`[stackable type]`、`[sub type]`。
11. 记录资源字段：`[icon]`、`[field image]`、`[move wav]`。
12. 装备文件如有攻击、防御、速度、耐久、套装、触发或效果块，只做字段盘点，不直接下运行结论。
13. 道具文件如有宝箱/选择器块，解析候选装备或道具 ID。
14. 若 `.stk` 含 `[summon apc]`，同时记录 `[stackable type]`、`[expert type]`、`[sub type]`、`[action usable place]`、`[need material]` 和 `[consume item]`，并闭合 `stackable -> APC registry -> .aic`；不要只看召唤字段。
15. 使用限制与材料扣除必须分别验证。优先采用同一道具链的单变量 A/B 和目标中的同形正样本；批量抽测不能写成全量结论，`[summon npc]` 不继承 APC 结论。
16. 如果文件引用其他物品或材料，继续用对应 registry 解析。
17. 如果涉及商店价格，回到 NPC 商店链路确认这个商品确实被目标商店售卖。
18. 如果目标是等级掉落池、批量装备覆盖或“是否还有漏网装备”，候选全集必须从当前 `equipment/equipment.lst` 枚举，并完整解析每个 `.equ` 的 `[grade]`、`[minimum level]`、`[creation rate]` 及任务相关筛选字段。itemdictionary、ID 段、目录、历史变更集和代表抽样只能作对照。
19. 若目标涉及气息/精炼与装备 `[skill data up]`，同时读取装备 `[character item check]`、完整技能数据组、气息道具 `[3choro enchant]` 与每个 `[skill]` 块的真实形状。先读取每个 `[check]` 头的完整原始轴，保留部位、职业以及槽位/growtype 分区；不能只按全部 `[skill]` 数量构造一个职业混合池，也不能把某目标的分区数量写成格式规范。tooltip、技能面板和战斗效果分别记证据；同数字 ID 跨版本必须各自解析，不能默认是同一道具。
20. 对历史零值尾垫 workaround，只按目标同形样本设计“有/无原生 `[skill data up]`、有/无尾垫、重新取得装备、重登、实际战斗”的单变量 A/B；不得按固定条数全包补零，也不得把面板变化写成战斗 PASS。
21. 若后续要修改含嵌套索引选项的 `.stk/.equ`，先按每个完整原始组头建立轴，不以全文同值或 occurrence 序号定位。预演与最终读回逐组核对：活跃索引是否形成目标结构要求的连续前缀、目标 `(index, skill, parameter signature)` 是否与方案一致、所有非目标组的同一序列是否零漂移。历史目标曾因跨部位同值误命中和索引打洞出现列表截断或客户端启动失败；这只构成风险负例，不能固化为固定组数、宽度或通用崩溃公式。

## 验收

- 目标 ID 已经通过正确 registry 解析。
- 已说明目标文件是 equipment 还是 stackable。
- `[grade]`、`[rarity]`、`[weight]` 已记录，未凭空省略。
- 材料 ID 没有从数字形状猜测。
- `[passive object]` 没有被当作可直接写装备效果的入口。
- 宝箱/选择器里的候选 ID 已按 equipment 或 stackable registry 解析。
- 召唤类道具已分别报告副本使用、召唤对象、按次消耗与未覆盖的运行边界；未把抽测或 `[summon apc]` 结论扩展到 `[summon npc]`。
- 气息/精炼与 `[skill data up]` 共存时，已分开报告准入、道具块、tooltip、技能面板和战斗效果；目标 workaround 没有被写成跨版本标准配置。
- 气息池已按每个 `[check]` 的完整原始轴保留部位、职业和槽位/growtype 分区，没有用表面选项总数拼成混合池。
- 若涉及索引选项修改，核验记录逐组证明连续性、目标签名和非目标零漂移；没有从历史样本硬编码组数或客户端结果。
- 如使用 planner，root 唯一、readErrorCount 为 0，且 unresolved / external IMG 风险已记录。
- 批量范围报告 registered 总数、成功解析、读取失败、截断、未解析和筛选后数量；变更清单全部读回不等于候选全集无漏项。
- 没有生成输出 PVF，没有改客户端。
