# Monster AI / 召唤 / 出生 / 掉落只读核查

状态：默认可用

## 先读

- `safety/README.zh-CN.md`
- `encyclopedia/pvf-file-types/monster-mob.zh-CN.md`
- `dictionaries/monster-fields.zh-CN.md`
- `dictionaries/monster-ai-fields.zh-CN.md`
- `indexes/monster-ai-observed-tag-router.zh-CN.md`
- `indexes/monster-ai-expression-router.zh-CN.md`
- `indexes/monster-entry-link-router.zh-CN.md`

## 执行

1. 确认目标 PVF，只读打开，编码优先 `Tw`。
2. 输入为数字 monster ID 时，必须先通过 `monster/monster.lst` 解析。
3. 输入为 `.mob` 路径时，先确认主 registry 是否注册，再查其他脚本文本直接路径入边。
4. 批量研究 `[think term]`、`[attack delay]` 等行为节奏前，从当前 `monster.lst` 注册项与 map/dungeon 真实出生、生成及召唤入边共同构造候选集；不能从文件名、历史 ID 区间或旧统计数反推全集。
5. 枚举目标怪物的全部已知使用点。只要任一已解析入边连接受保护内容、特殊机制副本或明确不在修改范围的上下文，该怪物就进入 `shared-risk`，不得因其他普通入边而自动纳入；未知上下文保持 `unknown`，不能默认纳入或排除。
6. 同一目标文件出现多个待处理标签时，必须有完整标签和值及足以唯一定位的相邻上下文；无法确定 occurrence 时记为 `duplicate` 并跳过，不能猜第几个。
7. AI 核查从 `.mob [ai pattern]` 进入，逐个解析难度分支中的 `.ai` 路径，再继续追踪 `.ai -> .ai`。
8. AI 缺失引用按源文件与原始路径记录；不要用同名文件猜测补链。
9. `[SUMMON MONSTER]` 位于行为块时读取 `[INDEX]`；位于 `[TRIGGER] -> [WHICH]` 时按选择器处理。
10. 召唤和出生的 monster ID 均通过 `monster/monster.lst` 解析。
11. map/dungeon `[monster]` 块只把完整数值记录当出生行；`[NPC]`、`[champion]` 后的短行单独记录。
12. `.mob` 掉落块中的物品 ID 按 equipment / stackable 正确 registry 解析。
13. registry 未命中、缺失引用、未观察到入边和未解析 ID 只记录，不修复。
14. 批量报告至少闭合 `resolved / eligible / shared-risk / unknown / duplicate / changed / no-op`；静态计数不能改写成出生、AI 或行为运行通过。
15. 不写 PVF，不修改客户端，不声明 AI、召唤、出生或掉落的运行效果。

## 验收

- monster ID 没有靠文件名或全局数字搜索猜测。
- `.mob -> .ai` 与 `.ai -> .ai` 都有存在/缺失判断。
- 无入边 `.ai` 与未注册 `.mob` 没有被直接判定为废弃文件。
- `[SUMMON MONSTER]` 行为块和选择器用法已分开。
- map/dungeon 完整出生行和短数字附属行已分开。
- 掉落物品 ID 已经过正确 registry 解析，未命中项没有补猜。
- 批量候选来自当前注册表与真实入边；共享风险、未知上下文、重复标签、实际改动和 no-op 数量均未被吞掉。
- 全程只读，没有生成输出 PVF，没有修改客户端。
