# PVF Tag 联合只读查询

状态：需验证

1. 先读 `dictionaries/pvf-tag-source-boundary-quick.zh-CN.md`，确认问题是 tag 语义、registry、目标文件结构还是运行时行为。
2. 用随包 `workbench.bat tag-knowledge query --exact` 查询；普通任务不配置外部目录。未命中时回到目标 PVF 和 clean knowledge，不猜字段。
3. 保持 `community`、`official-original`、翻译与 `tool-extension` 分层；冲突不静默合并。
4. 用 SHA 锁定目标 PVF，以 `observe-pvf --samples 3 --out <external-dir>` 对具体 tag 取样；命令会自行创建外部输出目录，不先运行 `Test-Path`、`Get-Item` 或建目录。
5. 对命令返回的 `reportPath` 运行一次 `tag-knowledge query-observation --report <reportPath>`；它会从单 tag 观察报告直接返回样本，不需要重复传 tag。旧的 `query --tag <tag> --observation <report>` 仍兼容，但不要运行缺少 `--tag` 的 `query`。
6. 用一次 `pvf-read read-batch` 读回返回的样本，核对 tag 位置、闭合、列数、tab、空列、父块、文件类型和相关 registry。
7. 输出分别标记知识层、目标观察、registry 解析和运行未知；0 命中只记录为未观察到。
8. 若进入写入候选，仍走 raw no-simplified change-set、同源同 change-set dry-run、approval code、显式输出、备份、readback 和 manifest。

禁止把社区解释或拼写候选变成 registry 事实，禁止把工具扩展说成官方原文，禁止把机翻单独作为字段含义或写入依据。

当上述命令正常工作时，第一条 shell 动作就是精确 `tag-knowledge query`；不先运行路径检查、`check`、帮助探测或通用 `pvf-read search`，它们不能替代精确目录查询和目标样本读回。
