# 受控修改：先选一条路线

前提：已完成目标身份确认及原始读取，并读过 safety/README.zh-CN.md。以下路径相对 knowledge-pack；例子相对工作台根。只读命中的一行，其余按需。

| 用户意图 | 首入口 |
| --- | --- |
| 普通数字/英文参数、已知名称说明、同路径联动 | 工作台 workspaces/examples/change-set.verified-cn-text.example.json；重复结构才另读 change-set.exact-scope.example.json |
| 明确修改未知标签下的独立文字 | task-cards/pvf-scalar-text-controlled-change.zh-CN.md |
| 道具名称解除共享引用 | task-cards/stackable-stringlink-detach-controlled-change.zh-CN.md |
| 同一 PVF 内复制普通文件 | task-cards/pvf-same-pvf-file-copy-controlled-change.zh-CN.md |
| 新增受保护文件或登记表新增行 | task-cards/pvf-high-risk-new-file-controlled-change.zh-CN.md |
| 既有 NUT 运行逻辑 | task-cards/pvf-existing-nut-controlled-change.zh-CN.md |
| 强化/增幅表格 | task-cards/pvf-upgrade-amplification-table-controlled-change.zh-CN.md |
| 既有 ANI 的 DELAY | task-cards/pvf-existing-ani-delay-controlled-change.zh-CN.md |
| 累计第二轮 | 工作台 workspaces/examples/change-set.cumulative-second-round.example.json |
| 安装到客户端 | workflows/client-pvf-controlled-deployment.zh-CN.md；需要独立部署授权 |

普通数值没有标签白名单；不要把中文显示字段的规则套到数字上。map 新建、复制或引用修改会自动审计目标目录的 map→til→img 闭合。同轮复制匹配 TIL 可解决内容重绑定；客户端资源存在与游戏渲染另验。

既有 CO/SQR/STR 的通用编辑、LST 改行/删行、任意 ANI 结构仍未实现，不应声称永远危险，也不能把新增文件路线当作覆盖既有文件的办法。NUT、StringLink 各有明确的已实现子集。遇到未知文字标签先区分独立标量与结构记录，再决定是否能使用标量路线；不要仅因标签未收录就要求维护者追加白名单。
