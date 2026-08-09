# indexes

针对本机目标 PVF 生成的只读索引默认写到 Workbench 外部运行目录。本目录只保留 README。

- 建立索引时记录完整源 PVF SHA256；同名 `Script.pvf` 按绝对路径哈希隔离缓存键。
- 普通 `status` 使用大小、mtime 与三段采样快速确认；高可信验收使用 `--verify-full-sha`。
- 默认终端输出只给摘要；需要完整状态时加 `--details`，索引 manifest 本身始终保留完整信息。
