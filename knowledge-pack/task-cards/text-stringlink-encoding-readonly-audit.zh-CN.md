# Text / StringLink / Encoding 只读审计任务卡

状态：默认可用


## 快速结论

- StringLink 主要集中在 `.stk`、`.obj`、`.equ`、`.aic`、`.map`、`.mob`、`.etc`、`.ui`、`.qst`、`.msn`。
- StringLink 主要出现在 `[name]`、`[name2]`、`[map name]`、`[explain]`、`[flavor text]`、`[minimum info]`、`[ui controls]`、`[name_text]`、`[cond_text]` 等字段。

## 默认处理

1. 问文本、中文、乱码、StringLink、名称表、`.str`、`stringtable.bin`、编码或本地化时，先读本任务卡。
2. 需要术语和字段口径时，读 `dictionaries/text-stringlink-encoding-fields.zh-CN.md`。
3. 需要分布矩阵、namespace、标签和辅助差异时，读 `indexes/text-stringlink-encoding-localization-boundary.zh-CN.md`。
4. 需要文件类型说明时，读 `encyclopedia/pvf-file-types/text-stringlink-localization.zh-CN.md`。
5. `workbench.bat` 会自动保护 `Cn` 搜索、`.str`、StringLink 和非 ASCII 脚本读取；不让用户额外选择 backend。

## 不能直接下结论

- 不能把 StringLink token 写成 UI 一定显示。
- 不能把直接文本写成字体、换行或控件布局正常。
- 不能把 Tw 下可读写成所有编码都正确。
- 不能把 `.str`、名称表或 `stringtable.bin` 写成运行时一定加载。
- 不能把只读观察或 PVF 读回正常写成客户端中文文本安全。

## 下一步测试建议

如果要修改普通脚本中的直接中文名称或描述，最小顺序是：

1. 选一个低风险、可见 UI 文本字段。
2. 确认父文件、父块、StringLink 或直接文本形态。
3. 普通读取只作浏览；其 `textUsage.safeForChangeSetSource=false` 表明文字可能已简体化、布局也可能被整理，不能复制到 change-set。对同一路径用 `pvf-read read --raw`（或 `read-batch --raw`）取得与写入校验一致的完整反引号 token（可含真实多行）。未明确指定编码时，原始读取只读比较 Cn/Tw，并在 `textUsage.automaticEncodingSelection` 中返回每个文件的 `selectedEncoding`；仅明显更干净时才改选，不做逐段猜测。使用 `textWriteMode: "verified-inline-text"` 和该 `pvfEncoding=Cn` 或 `pvfEncoding=Tw`。只改一处时用 `replaceAll=false`；若完整文字重复，从同一次原始读回复制紧邻目标的 `contextBefore` 和/或 `contextAfter`。若同构块连相邻上下文也重复，再从该次原始读回复制区间头尾，填写 `scope.startText`、`scope.endText`、正整数 `scope.expectedRanges`；目标和上下文必须完全位于区间内部。需要批量时用 `replaceAll=true` 并填写区间内的精确 `expectedOccurrences`。
4. 预演时生成隔离临时输出；用独立 TypeScript 解析器按同一编码精确读回，并确认既有字符串表条目未变。若另一编码明显更可信，按编码误选阻断。失败时不给 approval code。
5. 用户批准后保存到显式输出 PVF，不覆盖源 PVF，并创建或复用经 SHA256 核对的内容寻址备份。
6. 重新打开输出 PVF，做同样的精确独立读回。
7. 实机检查 UI 是否显示、换行是否正常、是否有乱码和控件溢出。

如果只是含中文/StringLink 文件中的数字字段最小替换，优先使用已验证安全路线：采用目标原文确认的 `Cn` 或 `Tw`、不做简繁转换、不自动转换 StringLink，并在客户端检查相关道具名、说明或副本文本。

参数/结构和中文同时变化时，拆成同一路径的两条或多条变化：参数块从 `--raw` 返回的规范 token 排列制作，并使用普通 `replace-text`；每个中文字段用 `verified-inline-text`；需要限定同一块时，每条都带同一个精确 scope。组成文件后先运行 `pvf-change validate` 并按它返回的 `agentHandoff` 继续；未知字段不会被静默忽略。同路径多项改动应保留在一个 change-set，不要拆成多次 apply。Workbench 会合并成一个最终文件验证，同一路径的多条文字只重建一次字符串表并修改一次脚本。删除含中文说明的选项块时，可以按数组顺序写成“完整文字清空 → 删除文字残留结构 → 删除参数块”；每一步仍须精确命中，最终结果仍须临时写出并独立精确复查。scope 的开始/结束标记不能改写或由新文字注入，缺失、重叠、数量不符、越界或预演后漂移都会停止。连续下一轮以 `baseline.applyManifest` 引用上一轮成功记录，`target.sourcePvf` 仍为最初受保护源，不得把上一轮输出直接当作新源。普通读取的中文、参数换行与 Tab 都可能只是显示形式，不能作为 change-set 原文。零命中若返回 `DISPLAY_TEXT_USED_AS_CHANGE_SOURCE` 或 `CHANGE_TEXT_ENCODING_MISMATCH`，只按其编码提示重新原始读取，不自动接受繁简变体或另一编码。当前仍会自动阻止 `Cn .str`、StringLink 显示文本、部分中文 token、任意 `scopePart`、未声明准确数量的批量和无法无损编码的字符。不要通过手工调用 bridge 或关闭保护绕过。
