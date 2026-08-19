第一条仍按实体任务执行 `workbench.bat pvf-read search ... --keyword "叹息之塔" --search-path dungeon`，不能为了哈希先运行别的命令。

名称定位完成后，如果用户明确要求两份源 PVF 的完整 SHA256 和前后不变证明，必须在第一次 `pvf-change` 之前运行一次 `workbench.bat pvf-read fingerprint --pvf <第一份 Script.pvf> --pvf <第二份 Script.pvf>`，记录每项 `sourcePvfSha256`。最终核对时原样重跑同一条 fingerprint 命令并逐项比较；只在最后运行一次不能证明“前后不变”。无需 `Get-FileHash`、`certutil`、`pvf-read --help` 或 `pvf-read adapter-info`。

变更集格式只读取任务命中的固定示例：同文件文字与参数看 `workspaces/examples/change-set.verified-cn-text.example.json`，同构部位精确范围看 `workspaces/examples/change-set.exact-scope.example.json`，第二轮继承看 `workspaces/examples/change-set.cumulative-second-round.example.json`。不要 glob 示例目录或 schema，也不要打开 schema、执行器源码或 grep 文档。组成文件后直接运行 `pvf-change validate`，再按机器交接继续。
