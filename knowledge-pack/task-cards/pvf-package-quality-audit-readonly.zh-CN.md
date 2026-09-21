# PVF 全包质量只读审计

状态：默认可用

用途：扫描目标 PVF 的 registry、五类完整性、SQR、ACT、LST 重复和 equipment / stackable 同号交集，输出问题候选，不直接修复。

## 先读

- `dictionaries/pvf-quality-semantic-analysis-fields.zh-CN.md`
- `workflows/pvf-package-quality-audit.zh-CN.md`
- `safety/README.zh-CN.md`

## 最小输入

- 目标 `Script.pvf`。
- `registry / integrity / sqr / act / all` 之一。
- 是否允许全包扫描；否则给路径前缀或扩展名。

## 执行

1. 计算并报告目标 SHA，建立只读文件清单。
2. 每个 `.lst` 独立解析，不合成全局数字表。
3. 按 workflow 运行所选规则，保留原始路径、父块、ID 和位置。
4. 报告截断、读取失败、解析失败、动态脚本边界和 0 命中的限定语。
5. 报告候选全集来源。registry/当前引用图、历史变更集、词典、ID 段、目录和抽样必须分开；后五者不能单独证明范围完整。
6. 累计多轮修改后，从最终输出重新枚举一次候选全集并复查整体不变量；不能只复核本轮声明的改动链。
7. 默认不生成 change-set；修复需另行授权并逐项 raw readback。

## 必须汇报

- 检查范围、总数、实际数和截断。
- confirmed / candidate / unresolved / read-error 数量。
- pass / warning / unresolved / not-run 数量；任一必查项非 pass 时不宣布全绿。
- registry 是否混用、SQR / ACT 是否只做静态检查。
- 是否写 PVF、是否写客户端、是否需实机。
