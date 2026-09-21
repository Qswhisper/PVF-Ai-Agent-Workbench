# NUT 回调 / 数据通道 / UI / ACT 边界

状态：需验证

用途：处理 NUT 回调命名、脚本数据传递、运行时 UI 绘制、ACT 动作脚本和调试辅助函数。本文只提供定位边界，不保存教程正文或把社区示例当成目标运行时事实。

## 回调家族

下列名称只能作为候选入口；必须在目标 PVF 中确认脚本已加载、函数实际存在、参数形状匹配，并闭合调用或回调链。

| 家族 | 常见候选 | 最低核查 |
| --- | --- | --- |
| 被动与技能使用 | `ProcPassiveSkill_*`、`onUseSkillPassiveSkill_*`、`procSkill_*` | 技能 registry、被动脚本和职业加载链。 |
| 状态生命周期 | `onSetState_*`、`onAfterSetState_*`、`onEndState_*`、`addSetStatePacket_*` | state 写入端、读取端、substate 和结束清理。 |
| 动画与持续处理 | `onEndCurrentAni_*`、`onProc_*`、`onProcCon_*`、`procAppend_*`、`procDash_*` | 目标动画、帧条件、执行对象和调用频率；名称不能证明联机双方的执行范围。 |
| 攻击 | `onBeforeAttack_*`、`onAttack_*`、`onAfterAttack_*` | AttackInfo、目标筛选、触发顺序和 PVP 分支。 |
| 地图与计时 | `onStartDungeon_*`、`onStartMap_*`、`onEndMap_*`、`onTimeEvent_*` | 地图切换、时钟注册、跨图清理和失败恢复。 |
| 输入与刷新 | `flushCommandEnable_*`、`onChangeSkillEffect_*`、`reset_*`、`resetDungeonStart_*` | 命令入口、技能状态、重置时机和冷却边界。 |

同一加载范围内出现同名回调时，不直接并排追加第二份定义。先读回所有定义、加载顺序和现有分支，再判断是否需要合并；静态文本无法证明覆盖顺序、重复注册或回调频率。

## 数据通道闭合

- state / substate 数据要把写入端的字段数量、类型和顺序，与读取端逐项对应；不能只看到 `sq_IntVectPush` 或读取函数就假定参数含义。
- PassiveObject 创建包要把发送端与 `receiveData` 的读取顺序闭合，同时解析对象 registry、创建路径和销毁条件。
- 对象变量、common varlist、timer、全局数据和网络包是不同通道；教程中的一种存储方式不能无证据替代另一种。
- 数据通道静态闭合不证明同步、丢包、跨图保留、对象复用或多人一致性。

## 运行时 UI 与调试

- `drawMainCustomUI_*`、`drawCustomUI_*`、`drawAppend_*`、`prepareDraw_*` 只作为候选绘制入口；必须确认目标脚本入口和实际调用对象。
- `sq_DrawSpecificFrame`、`sq_DrawSpecificFrameEffect_SIMPLE`、`sq_drawCurrentFrame` 等名称先查内置 NUT 目录，再查目标 PVF 的真实调用点。
- `sqr_Print2`、`sqr_Print`、`addNumberUi`、`getNumberAnimation` 等可能是教程辅助函数或目标自定义封装，不能直接当 DNF 内置 API。
- 脚本能引用 ANI、IMG 或声音路径，不代表客户端 ImagePacks2、SoundPacks 或其他资源存在；显示、图层、残留和多人可见性仍需客户端验证。

## ACT 动作脚本

- `.act` 与 NUT 是不同运行层。`MOTION`、`TRIGGER`、`BEHAVIOR` 以及 `SET PARTY SYMBOL`、`CHECK PARTY SYMBOL`、`IS INDEX`、`DESTROY`、`SET DAMAGE BOX`、`CENTER MSG` 只作为候选语句。
- 先在目标 PVF 中观察同用途 `.act` 最近邻，核对大小写、块结构、参数数量、对象编号和配套 ANI/ATK/对象引用；不要从教程示例直接新建或改写。
- ACT 静态结构不能证明触发时机、对象生命周期、伤害盒、消息显示或客户端资源完整。

## 高风险教程结论

- “突破特定生命值上限”“自动进入某状态”“自定义伤害体系”等方案通常依赖版本、服务端结算、加载链和辅助脚本，不进入默认事实。
- 这类方案必须标记为候选，先验证目标 PVF 的完整入口和 API，再生成独立修改版 PVF，并做实机测试。
- 教程 helper、另一个客户端或另一个职业的成功样本不能单独授权既有 NUT 修改。

## 查询顺序

1. 已知精确 API：先 `knowledge-query nut --group dnf --exact`，再对目标 PVF `pvf-read search-script`。
2. 已知回调家族但不知道入口：从职业 `load_state`、被动脚本、appendage 或 PassiveObject 加载链向下闭合，不做全库猜名。
3. ACT 或 UI：读取目标同用途文件与资源引用，保留“脚本存在”和“客户端可见”之间的边界。
4. 如果进入既有 NUT 修改，只能使用 `existing-nut-controlled-edit` 专用路线；本索引不放宽 ASCII、原始字节、入口链、临时往返和实机验证要求。
