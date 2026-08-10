先不要回滚：PVF 没有损坏。把繁体按简体方式读取才会出现乱码；既然繁体读取能完整显示，工作台应保留正常繁体结果并提示实际编码。也不要用 `cp` 手工覆盖客户端。

这段中文描述可以安全验证修改。工作台会按繁体编码先生成临时文件、独立复查文字和旧字符串表，通过后才允许生成独立 PVF；最后仍需进游戏确认描述文字正常，并检查换行和乱码。

技术详情（通常不用看）：变更使用 `textWriteMode: "verified-inline-text"`、`pvfEncoding: "Tw"` 和完整反引号 token。若把繁体误选为 Cn 且出现明显乱码，预演会返回 `TEXT_ENCODING_MISMATCH_SUSPECTED`，不给 approval code。客户端安装或恢复只能走 `client-pvf` 预览和单独确认流程。
