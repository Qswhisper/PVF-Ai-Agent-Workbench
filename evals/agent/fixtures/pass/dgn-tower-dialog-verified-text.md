`.dgn [tower dialog]` 可以修改完整对话 token，但只限严格可见消息结构：`[tower dialog]`、整数层号、完整对话、`on start` 或 `on complete` 必须依次相邻。从本次原始读回复制完整繁体对话，使用 `verified-inline-text` 与 `pvfEncoding: Tw`。

`on start`、`on complete` 是事件/逻辑 token，不能修改；部分中文仍被阻断，结构缺项、StringLink 或未知事件也继续阻断。重复时用 `contextBefore`/`contextAfter`，必要时再用精确 scope 定位。

预演会生成隔离临时 PVF，做独立读回、编码对比和字符串表保护检查后立即清理；通过后才可能获得生成许可。正式生成独立 PVF 并重新检查后，仍需实机对话文字检查，包括换行和出现时机。
