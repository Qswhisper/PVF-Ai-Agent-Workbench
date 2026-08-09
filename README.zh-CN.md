# PVF-Agent-Workbench

这是一个给桌面 AI Agent 使用的 DNF PVF 工作台。它已经带好运行环境、PVF 工具、知识和安全规则，复制到新的 64 位 Windows 电脑后也能直接使用。

## 第一次使用

1. 在工作台根目录运行 `.\workbench.bat check`。
2. 用 Agent 打开整个工作台目录。
3. 对 Agent 说：

```text
请先读取 AGENTS.md，并按工作台规则帮助我处理 PVF。
```

4. 提供目标 `Script.pvf`、想修改的内容、是否允许生成输出 PVF，以及能否进游戏测试。

不会代码也没关系。Agent 会自己查知识路由和相关文件；新手只需要把目标说清楚，并先从只读分析开始。

## 工作方式

- 普通任务统一使用 `workbench.bat`。
- 默认只读，不覆盖源 PVF，也不默认修改客户端资源。
- 数字 ID 会先通过正确的 `.lst` 登记表确认。
- 已知职业与技能 ID 时，工作台会一次闭合角色分支和职业技能登记表，不需要猜技能目录。
- 已知 NUT/API 名称时，内置声明查询与目标脚本观察各用一条命令；依赖预览返回的 JSON 已是完整报告，不要求 Agent 再造摘要。
- 真正写出前会先预演（只检查，不改文件）；确认后生成独立 PVF，并自动备份和复查。
- 中文搜索、`.str` 和 StringLink 编码检查由工作台自动处理，不需要新手增加配置。
- 需要实机测试时，可在单独确认后把已复查的输出 PVF 安装到 profile 指定的测试客户端，并支持恢复部署前版本；不会顺便修改 NPK、IMG 或其他客户端资源。
- 普通检查默认只显示摘要，详细报告自动落盘；索引建立后会复用 SHA 绑定缓存。

## 已内置

- Node.js、首选 native PVF 后端和无需 npm/构建的 TypeScript 只读备用后端；
- PVF 字段知识、NUT 接口、标签说明和常用任务路径；
- 商店、物品、技能、任务、掉落、副本、APC、内容提取和依赖分析等工作流；
- 项目级 `dnf-pvf-xpilot` Agent Skill。

不需要外部 `pvf_bridge` MCP、TypeSquirrel、npm 或已下架的 VSCode 插件。如果 native 后端缺少 VC++ 运行库，读取功能仍可使用，但所有 PVF 写入都会被阻止；`workbench.bat check` 会给出修复入口。

为避免中文乱码，当前会主动阻止直接修改 `.str` 中文或其他中文文字；只改数字、英文和常见符号仍可按安全流程完成。这些检查由工作台自动处理，不会增加新手配置。

生成测试 PVF 后，可以让 Agent“部署到某个测试客户端”。Agent 会先说明目标和备份位置，等你关闭客户端并确认后才安装；测试结束也可以让它恢复。详细流程见 [docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md](docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md)。

详细规则由 Agent 按需读取 [AGENTS.md](AGENTS.md) 和 `knowledge-pack/`。复制到新电脑前可查看 [docs/CLEAN-COPY.zh-CN.md](docs/CLEAN-COPY.zh-CN.md)。
