# NUT Runtime API 快速入口

状态：默认可用

用途：作为 NUT / state / skill runtime 问题的轻量入口。默认先读本文；只有要确认某个具体 API、回调参数或脚本写法时，再打开完整词典 `dictionaries/nut-runtime-api-boundary.zh-CN.md`。

## 总规则

- 当目标 PVF 和 API 名称都明确时只用两条命令：先 `workbench.bat knowledge-query nut --name <symbol> --kind <kind> --group dnf --exact`，再 `workbench.bat pvf-read search-script --pvf <Script.pvf> --keyword <symbol>`。两步已覆盖内置声明与目标脚本观察，不再运行 help、`Test-Path`、`Get-Item`、普通 filename search 或目录枚举。
- API 名称用随包 `workbench.bat nut-api query` 或 `workbench.bat knowledge-query nut` 精确查询；不需要额外目录。内置目录未命中时继续查目标 PVF，不猜函数名。
- 内置声明版本、函数签名和常量值只说明接口形状，默认 `targetRuntimeVerified: false`；还要查目标 PVF 真实调用点。目录 0 命中不证明运行时不存在。
- `dnf`、`squirrel`、`frontend`、`tooling` 必须分组理解；Attract-Mode 的 `frontend` 声明不是 DNF 运行时 API。
- 函数存在不等于当前脚本入口会运行；必须确认 `load_state`、职业入口或已加载脚本把它推入。
- 函数签名只能说明调用形状，不能证明伤害、命中、同步、PVP、UI、读条、冷却或资源显示。
- 数字参数必须回到目标 PVF 的 `.lst`、`.skl [static data]`、state 包、substate 分支或同脚本上下文解释。
- 涉及客户端视觉、音效、图标、动画资源时，Script 引用不证明 ImagePacks2/NPK 完整。

## 行为证据边界

单个行为 PASS 只能证明其完整组合链和记录中的前置条件，不能把链内任一 API 声明单独提升为全版本运行证明，也不能自动覆盖其他职业、远程 / 脱手、APC、不屈读条、PVP、同步或客户端资源。

## 读法

| 需求 | 默认先读 | 何时打开完整词典 |
| --- | --- | --- |
| 入口注册、pushScriptFiles、pushState、pushPassiveObj | 本文 + `indexes/skill-state-nut-runtime-api-group-boundary.zh-CN.md` | 要核具体 API 形状或参数时 |
| 技能使用、切 state、substate、冷却、读 level data | 本文 + 目标技能链索引 | 要确认某个 `sq_*` / `IRDSQRCharacter.*` API 时 |
| 动作帧、读条、动画层、坐标移动 | 本文 + 目标 `.chr/.ani/.skl` 闭合 | 要确认具体动画/帧 API 时 |
| Appendage、buff、active status、对象查找 | 本文 + 目标 appendage / skill 链 | 要确认 appendage 生命周期或对象 API 时 |
| PassiveObject、AttackInfoPacket、动态攻击包 | 本文 + PassiveObject compact router | 要确认 `sq_SendCreatePassiveObjectPacket`、attack packet、回调参数时 |
| 回调参数、`onSetState_*`、`onProc_*`、`onAttack_*` | 本文 + 目标脚本实际入口 | 要确认回调参数最低含义时 |
| 函数、类、常量精确查询 | `nut-api query --exact --kind ... --group dnf` | 有同名冲突、声明版本不明或需看参数时 |
| 已给目标 PVF 的精确函数核对 | `knowledge-query nut --exact --group dnf` + `pvf-read search-script --keyword <symbol>` | 只有需要解释复杂入口链时才继续读返回的具体脚本 |
| 两个以上历史 PVF 的调用变化 | `nut-api query --observation ...` 或外部 observation diff | 结论必须同时显示完整 PVF SHA；索引后仍读回相关脚本 |

## 禁止外推

- 不把教程 helper、社区封装、另一个客户端函数名直接当当前目标 PVF API。
- 不把 `frontend` / Attract-Mode API 混入 DNF 候选，也不把声明的 3.0.7 自动当作目标运行时版本。
- 不把目录或目标脚本搜索 0 命中写成“API 不存在”；未知 API 停止候选构建，不用近似名称替代。
- 不把一个职业或一个技能的 substate、static data index、attack packet 用法扩成全职业规则。
- 不把静态脚本闭合写成实机命中、伤害、冷却 UI 或服务端一致性。
- 不把 NUT 改动列入低风险变更；NUT 任务默认需要目标入口链、API 定义、最小改动、读回和实机验证。

## 深层入口

- 完整 API 词典：`dictionaries/nut-runtime-api-boundary.zh-CN.md`
- API 组边界：`indexes/skill-state-nut-runtime-api-group-boundary.zh-CN.md`
- API 分组边界：`indexes/skill-state-nut-runtime-api-group-boundary.zh-CN.md`
- 技能参数：`indexes/skill-parameter-index.zh-CN.md`
