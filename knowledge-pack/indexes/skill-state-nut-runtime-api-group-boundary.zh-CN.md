# Skill / State / NUT Runtime API 分组边界

状态：需验证

用途：把技能脚本问题按功能组路由，不保存职业样本覆盖率或历史验收状态。

| 功能组 | 常见入口 | 最低可用结论 | 不可静态证明 |
| --- | --- | --- | --- |
| 入口注册 | `pushScriptFiles`、`pushState`、`pushPassiveObj` | 脚本或对象可能进入运行时。 | 技能可用、命中或资源完整。 |
| skill 数据 | 职业 skill registry、`.skl [static data]`、`[level info]` | ID 按职业 registry 解析，数据列按读取点解释。 | 面板、PVP 修正和最终结算。 |
| 技能使用 | `sq_IsCommandEnable`、`sq_IsEnterSkill`、`sq_IsUseSkill` | 脚本检查命令或技能使用条件。 | 是否学会、冷却、输入窗口和释放成功。 |
| state / substate | state packet、int vector、`setSkillSubState` | 状态参数通道必须在写入端与读取端闭合。 | 抢占、取消窗口、同步和通用 substate 含义。 |
| 被动回调 | `ProcPassiveSkill_*`、`procAppend_*`、`checkExecutableSkill_*` | script-only 入口可能由引擎回调触发。 | 回调频率、默认学习和失败恢复。 |
| appendage / buff | appendage 挂载、proc、有效期和属性变更 | 持续效果通过 appendage 链承载。 | 叠加、刷新、死亡清理、Buff UI 和最终数值。 |
| PassiveObject | 创建包、`receiveData.read*` | PO ID 走 `passiveobject.lst`，写包顺序与读取端闭合。 | 轨迹、命中、销毁、同步和客户端资源。 |
| AttackInfo | 当前攻击信息、倍率、命中包、异常状态 | 脚本尝试改写或发送攻击包。 | 最终伤害、命中、卡肉、浮空、抗性和 PVP。 |
| 对象 / 场景 | 对象管理器、敌我判断、对象 ID、职业与场景检查 | 支撑目标搜索和分支条件。 | 目标优先级、免疫、性能和联机一致性。 |
| timer / 冷却 | time event、skill load、cool time、队列 | 支撑时序、装载和冷却入口。 | 计时精度、UI、跨图和失败恢复。 |
| 移动 / 输入 | 速度、坐标、可移动检查、鼠标/按键 | 支撑位移、轨迹和输入。 | 真实落点、碰撞、手感和同步。 |
| 视觉 / 粒子 | animation、draw-only、flash、shake、particle | 支撑表现候选。 | 资源存在、图层、残留和多人显示。 |

## 固定规则

- 先查询随包 NUT 声明，再读回目标脚本的真实调用点；两者都不能单独证明运行可用。
- 数字 ID 按父块和职业分支走正确 `.lst`，不能按数字外形猜。
- 搜索 0 命中不证明 API 不存在；未知名称不使用近似函数替代。
- 行为 PASS 必须绑定完整 PVF SHA、入口链、前置条件和测试范围，不跨版本自动继承。

回调同名冲突、数据写入/读取闭合、运行时 UI、调试 helper 与 ACT 的进一步边界见 `indexes/nut-runtime-callback-data-ui-act-boundary.zh-CN.md`。
