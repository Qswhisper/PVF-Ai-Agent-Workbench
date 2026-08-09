# knowledge-pack

这里是 PVF-Agent-Workbench 的纯净知识包。它只放 Agent 执行任务需要的结论、词典、流程、安全规则，以及已经去除来源路径和正文的紧凑事实目录。

它不是原始资料的备份。来源正文、实验报告、旧路径、社区教程、源码参考、候选报告和争议追查材料不进入纯净工作台。普通任务不应寻找或要求额外资料目录。

## 默认入口

普通路由任务中，Agent 应先读：

1. `safety/README.zh-CN.md`
2. `indexes/knowledge-index.json`
3. 路由命中的 `encyclopedia/`、`dictionaries/`、`workflows/` 或 `task-cards/` 文件

如果根目录 `AGENTS.md` 已将请求命中“精确只读快速路径”，则直接读取该路径点名的短文件，不再读取根索引来重复发现同一路由。安全 README 和目标 PVF 读回仍保留。

`indexes/knowledge-index.json` 是轻量根路由。找不到旧 topic 时，再按需打开 `indexes/knowledge-topic-routes.full.json`；不要默认读取完整 topic 路由或深索引。

如果某个主题没有命中路由，先做只读定位，不要回退到来源资料或旧报告。

涉及全包质检、双 PVF 语义对比、结果集、LST 登记、独立掉落整理、物品来源、技能树布局或原子内容生成时，先读 `encyclopedia/pvf-file-types/pvf-crosscutting-productivity.zh-CN.md`。普通任务继续直接使用具体主题，不需要额外资料目录。

## 子目录

- `safety/`：只放硬边界。默认只读、不覆盖源 PVF、写出必须备份和读回。
- `indexes/`：放路由、结构化参数事实和内置 NUT/tag/任务书签紧凑目录；不放来源正文或证据链。
- `encyclopedia/`：纯百科，说明某类 PVF 文件或系统是什么。
- `dictionaries/`：纯词典，说明标签、字段、词条、常见值是什么意思。
- `workflows/`：纯流程，说明某类任务怎么做。
- `task-cards/`：面向 Agent 的短任务卡。

## 状态标记

纯净知识包只使用三种状态：

- `默认可用`：Agent 可以按正文理解和执行；写 PVF 时仍必须确认目标 PVF、解析 `.lst`、备份、输出新 PVF、读回。
- `需验证`：只能当任务线索；必须查目标 PVF、客户端或实机后才能下结论。
- `禁用`：已知容易错、过时、误导，不能照做。

不要在正文里写来源报告、旧实验路径或证据链。结论必须在进入正文前完成验收；普通任务只使用迁入后的结论，并继续核验目标 PVF。

## 禁止进入

- 真实 PVF、PVF 备份、实验输出 PVF。
- 客户端、ImagePacks2/NPK 原文件。
- API key、本地 profile、索引缓存、运行报告。
- 社区教程全文、源码全文、OCR 全文、旧实验报告全文。
- 只用于证明“为什么这么写”的证据链。
