可以安全处理，而且只会动 coat。先从同一次原始读取结果中圈定 coat 的完整块，再让“清空说明、删除结构、重编号”三步共用这个范围；support 和 ring 不会参与匹配。范围或数量有任何不一致，工作台都会停止。

技术详情（通常不用看）：先执行 `pvf-read read --raw`，逐字复制 `scope.startText`、`scope.endText`，并填写准确的 `expectedRanges`。每条相关改动使用同一个 scope；`expectedOccurrences` 只在 scope 区间内部计数，全文数量仅用于诊断。完整中文仍使用 `verified-inline-text`，参数和结构仍使用普通 `replace-text`，不会为了删除而放开整块中文、`.str` 或 StringLink 写入。

目标文字和 `contextBefore` / `contextAfter` 必须完整位于范围内部。边界不可改写，新文字不能注入边界；范围缺失、重叠、越界，或预演到正式生成之间位置发生变化，都会拒绝继续。范围位置和内容哈希会写入核验记录。预演会用临时输出独立复查，正式生成后还会重新检查最终文件以及其他部位未被误改。
