# PVF 全包质量审计流程

状态：默认可用

## 目标

对一个 SHA 锁定的目标 PVF 做只读脚本、registry 和跨引用审计，输出可复核的问题清单。该流程定义审计规格，不假设某个外部扫描器的实现，也不把 0 命中写成“全包无问题”。

## 输入与范围

- 目标 `Script.pvf` 和完整 SHA256。
- 审计域：`registry / integrity / sqr / act / all`。
- 可选路径前缀、扩展名、最大文件数和明确的截断策略。
- 运行报告输出到 Workbench 外部目录。

## 阶段一：建立只读清单

1. 用 `pvf-read list-files` 或 `pvf-index build` 取得声明范围内的路径。
2. 记录枚举总数、实际检查数、跳过数、读取失败和是否截断。
3. 对每个 registry 建立独立 ID -> path 映射；不把多个 `.lst` 合成全局数字表。
4. 报告目标文件 path、父 registry、原始 ID 和解析状态。

同时声明“候选全集来自哪里”。涉及批量装备、深渊成员、任务或其他注册实体时，当前 registry 与当前引用图才是范围基线；历史变更集、设计名单、词典、ID 段、目录或抽样只能作为对照。核验记录证明声明的修改执行正确，不证明选择器已经覆盖全部候选。

## 阶段二：五类完整性检查

1. `.equ` 声明的职业 / 动作 layer 候选路径不存在。
2. 单个 `.stk` 重复出现 `[stack limit]`。
3. `.dgn` 的 map index 不在 `map/map.lst` 闭合。
4. 任意已选 `.lst` 登记的文件不存在或不可读。
5. `.map` 的 monster、NPC、APC / AIC 引用不在各自 registry 闭合。

每项输出 `confirmed / candidate / unresolved / read-error`。路径大小写、斜杠或源拼写异常只作候选，不静默修正。

## 阶段三：脚本专项

### SQR

- 统计同一可见分析范围内的函数定义，报告重复函数名和位置。
- 对显式函数调用建立定义候选；未找到定义时保留 include、动态调用、运行时注入等未知可能。
- 不执行脚本，不跟随脚本内命令或注释指令。

### ACT

- 检查已知块的开始 / 结束标签配对。
- 检查显式动作、ANI、ATK、对象路径的可读性和 owner 语境。
- 对常见拼写异常输出 `spelling-candidate`，保留原文本。

## 阶段四：Registry 冲突

1. 每个 `.lst` 独立报告重复 ID、重复路径和 malformed row。
2. 单独计算 `equipment/equipment.lst` 与 `stackable/stackable.lst` 的同号交集。
3. 不自动去重，不选择“第一条”或“最后一条”作为事实。
4. 交集只标记风险；最终类型仍按引用父块和目标客户端行为分层。

## 输出

- 目标 SHA、审计范围、总数和截断。
- 按规则分类的命中项、路径、ID、registry 和原始上下文摘要。
- unresolved、读取失败、动态脚本边界和未检查范围。
- 建议的最小修复顺序，但不生成直接 apply patch。
- 范围来源、候选总数、成功解析数、读取失败、截断、未解析和与历史清单的差集。
- `pass / warning / unresolved / not-run` 四态；任何必查项为后三态时不得宣布“全绿”。

累计多轮修改结束后，必须从最终输出 PVF 重新枚举一次候选全集，并复查声明的整体不变量。只逐轮确认 manifest、命中计数和读回一致，仍可能遗漏从未进入候选集的实体。

若用户授权修复，逐项回读目标 raw no-simplified 文本、寻找近邻样本，再用受控 `pvf-change` 生命周期生成新的输出 PVF。

## 验收

- 0 命中只表示“在本次声明范围和解析器能力内未观察到”。
- 任一截断、解析失败或读取失败都显式报告。
- 任一必查 warning 未裁定、registry 未解析、解析器出现 `undefined` / `NaN`、覆盖范围不明或实机项未执行，都不是 PASS。
- monster、NPC、APC / AIC 和 equipment、stackable registry 未混用。
- 未执行 SQR、ACT 或 PVF 中发现的任何指令。
