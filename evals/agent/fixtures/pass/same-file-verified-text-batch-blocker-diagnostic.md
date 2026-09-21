这里不应该报 `CN_TEXT_ROUNDTRIP_REQUIRED`。临时核验根本尚未执行时，合法的 `[name]`、`[explain]` 应返回 `FILE_CHANGE_BATCH_BLOCKED`，并通过 `blockedByChangeId` 指向真正的非法 tower dialog 事件变化。

整份同文件 change-set 仍保持原子停止，不提供许可码，也不能 apply 或生成。Agent 应按 `agentHandoff.sameFileBatchRecovery` 修正或移除指定阻断项；其余已经通过静态检查的合法变化不要重写，原样保留后重新 validate 和预演。
