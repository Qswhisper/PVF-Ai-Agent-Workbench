# Monster Action / Animation 只读核查

状态：默认可用

先读：
- `encyclopedia/pvf-file-types/monster-mob.zh-CN.md`
- `encyclopedia/pvf-file-types/passiveobject-attackinfo-hitbox.zh-CN.md`
- `dictionaries/monster-fields.zh-CN.md`
- `dictionaries/monster-action-animation-fields.zh-CN.md`
- `indexes/monster-action-animation-act-observed-tag-router.zh-CN.md`
- `indexes/monster-action-animation-ani-observed-tag-router.zh-CN.md`
- `indexes/monster-action-animation-backtick-token-router.zh-CN.md`

执行：
1. 确认目标 PVF，只读打开，编码优先 `Tw`。
2. 通过 `monster/monster.lst` 解析目标 monster ID，不能猜 ID。
3. 读取目标 `.mob`，定位动作、动画和攻击相关字段。
4. 将反引号 `.act/.ani` 路径按 owner 文件目录解析；已带 PVF 根目录的路径按根目录解析。
5. 读取入口 `.act`，继续追踪 `.act` 内反引号 `.act/.ani`。
6. 读取 `.ani` 时使用二进制 ANI 反编译；反编译失败时标为未展开风险。
7. 遇到 `[CREATE PASSIVEOBJECT]` 时，通过正确 registry 解析对象 ID。
8. 遇到 `[ATTACK BOX]` / `[DAMAGE BOX]` 时，只能记录盒结构入口；实际命中、伤害和手感需要实机验证。
9. 不写 PVF，不修改客户端，不把教程或候选资料语义直接写成结论。

若用户明确要修改既有二进制 `.ani` 的帧延迟，读取 `task-cards/pvf-existing-ani-delay-controlled-change.zh-CN.md`。当前只开放 `[DELAY]` 的原字节整数补丁，不把本卡的其他观察字段自动变成可写范围。

验收：
- 每个非空 `.act/.ani` 引用都有存在/缺失判断。
- `.act` 字段、闭合标签和反引号 token 已按路由覆盖。
- `.ani` 字段标签已按路由覆盖；无法反编译的 ANI 已单独标风险。
- 数字 ID 已通过正确 registry 解析。
- 没有把动作字段、攻击盒或受击盒直接解释为实战效果。
## PassiveObject 继续闭合

遇到 `[CREATE PASSIVEOBJECT]` 或 `[CREATE PASSIVEOBJECT CIRCLE]` 时，继续执行 `task-cards/monster-created-passiveobject-readonly-audit.zh-CN.md`。不要只记录标签后停止。
