# 公平决斗 APC 等级与专属装备标准化任务卡

状态：需验证

## 先读

- `safety/README.zh-CN.md`
- `workflows/apc-fair-duel-level-equipment-standardization.zh-CN.md`
- `indexes/apc-fair-duel-level-equipment-standardization-boundary.zh-CN.md`
- `task-cards/apc-combat-attribute-intent-readonly-audit.zh-CN.md`
- `task-cards/apc-character-status-hardness-readonly-audit.zh-CN.md`
- `dictionaries/apc-character-status-fields.zh-CN.md`
- `workflows/apc-extraction-planner.zh-CN.md`
- `task-cards/equipment-stackable-readonly-audit.zh-CN.md`

## 执行

1. 通过 dungeon、map 和 `aicharacter/aicharacter.lst` 闭合目标 APC，不凭房间顺序、名称或裸数字猜对象。
2. 读取 `.aic` 的等级、`[additional character status]`、`[character status rate]`、伤害倍率、技能、快捷道具和完整 `[equipment]`；伤害按物理 / 魔法攻击、主属性、独立攻击侧标签、技能和装备建立联合基线，硬度按生命、物防、魔防和受击恢复建立联合基线。
3. 每件装备通过 `equipment/equipment.lst` 解析；无法解析的值保持 unresolved，不按槽位位置强行命名。
4. 把原装备分为纯攻防速度、技能等级或技能数据、触发或 appendage、外观与未解析五类。
5. 玩家公平装备和 APC 标准装备使用不同 ID 与不同文件；不要让后续玩家调平同时改动 APC。
6. 复制套装时同步改写 `[set item]` 为 APC 专属成员 ID，并逐项读回。
7. 第一轮只改一个 APC：等级、专属武器、五件防具和三件首饰可以作为一个标准化实验包；特殊装备、魔法石和时装默认保留。
8. 第一轮不同时补偿 AIC 状态倍率或伤害倍率，先观察等级和装备组合的真实结果。
9. 写出必须使用原始 no-simplified 文本、显式输出、备份、dry-run、apply、严格 readback 和 manifest。
10. 实机只反馈双方伤害、整体速度及被移除职业装备效果是否造成明显机制退化。

## 禁止

- 不一次批量替换整张副本的全部 APC。
- 不把空装备或稀疏装备样本写成 APC 不读取装备。
- 不把装备说明文字写成运行时效果证据。
- 不因一个槽位无法解析就删除该值。
- 不把单个 APC 的结果外推为新副本全部 APC 的平衡结论。
