宿主能发现随包 `dnf-pvf-xpilot` Skill 时，第一项 Agent 动作是先加载这个 Skill；在它之前不运行任何 shell、`check`、help、路径探测或目录扫描。

Skill 加载完成后，目标 PVF 和具体副本名都已给出的情况下，第一条 shell 命令才是 `workbench.bat pvf-read search --pvf <Script.pvf> --keyword "叹息之塔" --search-path dungeon`。即使后续还要写修改版、计时或核对源 SHA256，也不先运行 `workbench.bat check`。宿主不支持 Skill 时直接按根 `AGENTS.md` 执行同一首命令规则。

名称搜索成功后，也不因为后面要写入而补一次 `check`。继续做原始读取、`pvf-change validate` 和预演；只有命令不可用或明确返回 `READ_ONLY_FALLBACK` 时，才运行 `workbench.bat check` 诊断。
