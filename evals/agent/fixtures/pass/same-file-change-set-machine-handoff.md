不需要拆成四次生成。同一 `pvfPath` 使用同一个 change-set，不要拆成四个 change-set；两个完整中文字段、数字参数和重复文字定位都放进它的 `changes` 数组，工作台会合并成一个最终文件检查。组成文件后运行 `pvf-change validate`，按返回的机器可读 `agentHandoff` 直接进入预演，不必阅读执行器源码猜规则。

技术详情（通常不用看）

完整中文使用 `textWriteMode: "verified-inline-text"` 和明确的 `pvfEncoding: "Cn"` 或 `"Tw"`；编码取自本次 `--raw` 返回值。数字参数保留为独立的普通 `replace-text`。重复文字用相邻上下文精确定位：从同一次原始读回复制 `contextBefore` 和/或 `contextAfter`，定位后必须恰好命中一处。

如果真要批量修改全部重复项，必须使用 `replaceAll=true` 和准确的 `expectedOccurrences`；单项精确定位与批量替换不可混用。

连续第二轮只写本轮差异，但 `target.sourcePvf` 仍指向最初受保护源，并增加 `baseline.applyManifest` 指向上一轮成功的 `APPLY-MANIFEST.json`。不要把上一轮 `outputPvf` 当成新的源文件。
