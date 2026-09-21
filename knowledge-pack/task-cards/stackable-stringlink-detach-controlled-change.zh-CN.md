# 道具名称 StringLink 解除引用

状态：需验证

仅用于明确要求将现有道具名称改为独立文字的任务。使用普通累计变更流程，单条 replace-text 的 textWriteMode 为 verified-stringlink-detach；pvfPath 必须为 .stk，位置必须为独占一行的 [name] 完整 StringLink，previousText 必须是原始读回完整的引用token，newText 为完整反引号文字。replaceAll 必须为 false，重复引用用原始 contextBefore 定位，显式声明 pvfEncoding 为 Cn 或 Tw。

制作变更集时直接读取 `workspaces/examples/change-set.stringlink-detach.example.json`（相对工作台根目录），替换为目标原始读回的完整引用和明确的新名称，再执行 `pvf-change validate --file <外部变更集.json>` 并遵循返回的下一条命令。不要为寻找字段格式扫描示例目录、Schema 或执行器源码。

该模式明确选择新文字的目标编码，不以 StringLink 显示内容推断原编码。客户端既有已验证编码优先；未确认显示时必须实机检查。新文字必须可无损编码。原始 type9/type10 引用对按 namespace/key 精确绑定，仅替换选中的引用对为新 type7；既有字符串表条目逐字节保留，只追加新文字，不编辑共享 .str 或其他脚本。临时独立PVF往返和正式完整读回、原文件和新文件哈希仍强制执行。

原始显示形如 `` <13::name_key`显示名称`> `` 时，`13` 是 namespace（文字表编号），`name_key` 是引用键；它们分别是底层 type9/type10 token 承载的值，不是 token 类型编号。不要因 `13` 不等于 `9` 或 `10` 判定类型冲突。原文读取只证明引用形态，能否生成仍以预演的真实原始引用对、编码和独立往返核验为准；不能在只读调查阶段承诺已证明其他文件逐字节不变。

第一轮只解除名称引用。后续中文介绍可在累计下一轮沿用已经确认的同脚本中文：若缺少 [explain]，先以普通只含数字、英文和常见符号的结构替换插入空反引号字段，再在同一变更集用 verified-inline-text 填写完整说明。英文技能说明可同时按完整token替换。仍需精确数量、同文件批次及临时中文往返。

不支持部分显示文字、修改引用目标、批量解除引用、非 .stk、非 [name]、写共享文字表、关闭编码检查或原始文件覆盖。旧普通文字模式继续拒绝所有 StringLink。运行时显示需实机确认，不能由静态通过替代。
