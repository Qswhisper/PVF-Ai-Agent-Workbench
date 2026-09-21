# 完整原文取证与重新核验

用于已经通过名称／登记路线定位的明确文件。保留原有首次检索优先级；完整导出不替代身份解析，也不发现全部任务范围。

大文件原文保存到新建的外部目录，终端只返回路径、完整性与哈希。不会生成或覆盖 PVF。原文为受控修改所用的 canonical token 排列，关闭简繁转换和 StringLink 展开；UTF-8 是证据文本的存储编码，Cn/Tw 是 PVF 的读取编码，两者不能混用。

```bat
workbench.bat pvf-read export-evidence --pvf "D:\TaskInput\Script.pvf" --path "stackable/known.stk" --out "D:\TaskEvidence\run-01" --purpose boundary-only
```

`--path` 可重复，单批最多 256 个明确路径。省略 `--pvf-encoding` 时复用现有 Cn/Tw 自动选择并保存选择依据；已从当前文件确认编码时可显式指定。每文件默认且最多 16777216 个 UTF-16 字符单元，可用 `--max-chars-per-file` 调低限制；单批 UTF-8 文本总量最多 64 MiB。超限或截断会停止，不能把分段标记为完整。大于此上限的文件仍须通过已有分页路线处理，不能声明该导出能力已覆盖任意大小文件。

必须明确用途：

- `boundary-only`：只识别待替换范围和非目标内容保护边界；不能复用其中历史职业、技能、参数或池答案。
- `rebuild-evidence`：允许作为新取证输入，但仍需正确登记表、原文解释及必要实机验证。这个标签只是用途声明，不会自动证明内容可信或语义正确。

输出目录必须是新的，且位于 Workbench 和输入 PVF 所在目录之外。检查真实路径和已存在的祖先，阻止链接把外部路径导回保护目录。内部 PVF 路径不直接物化为磁盘目录，避免路径越界和 Windows 文件名冲突。失败时保留 `INCOMPLETE.json` 和已产生的部分文本，供定位问题；重试应使用新目录。成功清单只在全部文件和源文件稳定性检查完成后生成。没有自动清理历史输出的动作。

导出返回 `agentHandoff.nextCommandOnly`，直接运行该命令进行核验，例如：

```bat
workbench.bat pvf-read verify-evidence --pvf "D:\TaskInput\Script.pvf" --manifest "D:\TaskEvidence\run-01\EVIDENCE.json" --manifest-sha256 <导出时单独记录的清单哈希>
```

核验会检查清单哈希、文件完整性和文本哈希，并重新打开用户明确指定的 PVF、重新读取每个原文文件。它不会自动打开清单声称的源文件路径；即使文本和清单里的哈希一起被重写，与当前 PVF 原文不一致也会停止。清单摘要应保留在独立调用记录中，不能核验时只重新计算待验清单的摘要来替代。

源文件在 backend 打开前绑定完整 SHA256，在操作结束时再算一次，大小、修改时间或 SHA256 漂移均停止。命令内部的前后检查不替代任务安全规则要求的首次和最终 `pvf-read fingerprint`。

哈希含义：

- `sourcePvfSha256`：完整 PVF 容器的 SHA256。
- `canonicalTextSha256`：完整、未做显示转换的原文以 UTF-8 存储后的 SHA256；不是 PVF 内部原始二进制文件的 SHA256。
- `manifestSha256`：落盘的 `EVIDENCE.json` 字节 SHA256。

成功只证明声明文件集合的原文完整性与本次源身份。它不证明原始基线身份、全包覆盖、职业／技能／部位关系、参数含义、气息替换白名单或非目标原始字节不变；也不批准 PVF 生成或安装。当前未接入气息专用语义门禁。

维护自测：

```bat
workbench.bat pvf-read evidence-self-test
workbench.bat fallback-self-test
```

前者使用完全虚构的文本和注入读取器，覆盖截断、改写清单与文本、源漂移、重复路径、外部路径保护及未知编码等情况，核验记录保存在外部运行目录。真实 PVF CLI 集成需单独验证，不能只用单元检查替代。修改此能力后应保留成功和失败样本，不把完整性通过写成游戏语义 PASS。
