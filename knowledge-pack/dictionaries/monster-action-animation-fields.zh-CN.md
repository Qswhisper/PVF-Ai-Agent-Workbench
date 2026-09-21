# Monster Action / Animation 字段词典

本文件只记录 monster 动作动画链的纯结构入口。字段、标签和 token 出现已经过目标 PVF 只读观察；动作表现、命中、伤害、受击盒、卡肉、同步和客户端资源完整性仍需目标链路与游戏内验证。

## 文件边界

### `.mob -> .act/.ani`

状态：需验证

含义：monster `.mob` 中的反引号路径可引用 `.act` 或 `.ani`。相对路径通常按当前 `.mob` 所在目录解析；已经带 PVF 根目录的路径按根目录解析。

注意：引用存在只证明动作或动画文件可定位，不证明动作会被 AI 选择，也不证明客户端资源完整。

### `.act -> .act/.ani`

状态：需验证

含义：monster `.act` 内也可继续通过反引号引用其他 `.act` 或 `.ani`。

注意：解释动作链时至少要读 `.mob`、入口 `.act`、被引用 `.ani`，必要时继续查 `.atk`、passiveobject 和脚本。

### `monster/**/*.act`

状态：需验证

含义：monster 目录下的动作脚本集合。当前任务只读观察到字段标签 877 个、闭合标签 117 个、反引号 token 8 个。

注意：部分 `.act` 未被 `.mob` 直接引用，不能直接当死链；必须继续查 action 入边、召唤、passiveobject 或其他系统引用。

### `monster/**/*.ani`

状态：需验证

含义：monster 目录下的动画集合。当前任务只读观察到字段标签 1145 个、闭合标签 0 个、反引号 token 0 个。

注意：动画能反编译出标签不证明客户端图像资源完整；少量二进制 ANI 如果无法展开，必须标为反编译风险。

## 关键结构入口

### `[MOTION]` / `[BASE ANI]` / `[SUB ANI]`

状态：需验证

含义：动作脚本中的动作段、基础动画和子动画入口。

注意：需要继续闭合到实际 `.ani`；动作帧和运行时选择逻辑不能只靠字段名推断。

### `[TRIGGER]` / `[BEHAVIOR]` / `[DO BEHAVIOR]`

状态：需验证

含义：动作脚本中的条件和行为块入口。

注意：只证明结构存在；具体触发条件和行为效果必须读块内内容并结合目标链路验证。

### `[CREATE PASSIVEOBJECT]`

状态：需验证

含义：动作脚本中观察到的 passiveobject 创建入口。

注意：块内数字必须通过正确 registry 解析；不能把数字直接当路径或对象结论。

### `[ATTACK BOX]`

状态：需验证

含义：动画中观察到的攻击盒相关字段入口。

注意：攻击盒存在不等于一定有伤害；还要核 `.atk`、调用动作、目标状态和实机表现。

### `[DAMAGE BOX]`

状态：需验证

含义：动画中观察到的受击盒、实体盒或碰撞盒相关字段入口。

注意：不能把所有 `[DAMAGE BOX]` 都解释成攻击输出；需要区分攻击动作、待机/受击/移动动画和对象用途。

### `[DELAY]`

状态：默认可用（仅受控整数补丁）

含义：二进制 ANI 帧属性中的 4 字节有符号整数延迟。静态数值可用于计算动画帧时长，但状态切换、循环、中断和实际玩法表现仍需实机验证。

写入边界：既有二进制 `.ani` 可按 `task-cards/pvf-existing-ani-delay-controlled-change.zh-CN.md` 做单文件单条原字节整数补丁；其他 ANI 字段、结构、路径和客户端资源不因此开放。

## 覆盖入口

- `.act` 字段和闭合标签：见 `indexes/monster-action-animation-act-observed-tag-router.zh-CN.md`。
- `.ani` 字段标签：见 `indexes/monster-action-animation-ani-observed-tag-router.zh-CN.md`。
- 反引号 token：见 `indexes/monster-action-animation-backtick-token-router.zh-CN.md`。
## Monster 创建 PassiveObject 补充

- `[CREATE PASSIVEOBJECT]` 同时观察到闭合块和内联直接 ID 两种结构。
- 闭合块的 `[INDEX]` 可为直接 ID、`[RANDOM SELECT]` 候选、`[RANDOM]` 连续候选区间或空值。
- `[CREATE PASSIVEOBJECT CIRCLE]` 也是目标 PVF 中观察到的创建入口。
- 继续读取：`dictionaries/passiveobject-action-fields.zh-CN.md`、`dictionaries/passiveobject-obj-fields.zh-CN.md`、`task-cards/monster-created-passiveobject-readonly-audit.zh-CN.md`。
