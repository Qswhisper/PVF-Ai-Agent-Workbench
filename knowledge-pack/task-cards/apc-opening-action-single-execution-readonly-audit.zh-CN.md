# APC 固定首发动作单次执行只读核查

状态：默认可用

用途：处理 APC 出生后固定施放 Buff、姿态、切换技能、召唤或其他首发动作，以及“状态被再次关闭、召唤两套、首发重复、普通 AI 提前接管”等行为问题。

## 先读

- `safety/README.zh-CN.md`
- `task-cards/pvf-entity-name-search-readonly.zh-CN.md`
- `encyclopedia/pvf-file-types/apc-ai-key-stream.zh-CN.md`
- `workflows/apc-extraction-planner.zh-CN.md`
- 涉及战斗数值时再读 `task-cards/apc-combat-attribute-intent-readonly-audit.zh-CN.md`

## 执行

1. APC 名称先走 aicharacter `SearchName`，读取返回的 `.aic`。名称零命中不证明不存在；此时只沿已闭合的 dungeon/map/registry 或依赖证据继续，不换编码、猜 ID 或按目录名认人。
2. 在同一次审计中读取 `[ai pattern]`、`[key stream]`、`[key cooltime]`、`[quick skill]`、`[skill]` 与首发事件入口。每个 `.ai` / `.key` 引用都要解析到真实文件；planner 标为 unresolved 的短文件名不能被当作已闭合。
3. 为首发链列出“事件条件 -> 逻辑动作名 -> key 文件 -> skill/动作 -> 冷却身份”，再查普通战斗 AI 是否也会返回同一逻辑动作或触发同一技能。
4. 对持续 Buff、可开关姿态、召唤和会改变后续形态的技能标为高风险。历史目标已经实机观察到：固定首发动作再次进入普通 AI 候选后，可关闭持续状态、提前解放形态或重复生成召唤物；这是可复用的故障类型，不是所有 APC 必然重复的规则。
5. 修复候选应保证首发链与普通 AI 对“已经执行”使用同一可观察身份。一次性长冷却、分段首发键或复用原普通键都只是目标实现候选；不得把某个固定冷却值、键名或技能 ID 写成通用模板。
6. 若首发由多段组成，分别证明顺序、每段只执行一次，以及普通 AI 何时接管。删除原技能或让普通 AI 永久失去该技能不是默认答案。

## 实机矩阵

- 出生后的第一秒、首发链完成时、普通 AI 首次可选同技能时分别录像或记录。
- 持续状态检查是否仍开启；召唤检查单位数和重复生成；形态技能检查是否提前切换或释放。
- 覆盖被打断、击倒、控制、目标丢失、换房间/换层、死亡或重置后是否重新执行。
- 同一构建至少做多次入场；静态 key 存在、冷却值写入或技能能释放都不能替代实机单次性证明。

## 验收

- APC registry、`.aic -> .ai -> .key -> skill/动作` 已闭合，所有 unresolved 明示。
- 固定首发路径和普通 AI 复用路径已放在同一图中比较。
- 没有保存项目专属 APC 名称、ID、键名、技能 ID 或冷却常数作为默认值。
- 结论区分静态闭合、实机故障复现和修复后回归；只读审计不生成输出 PVF、不改客户端。
