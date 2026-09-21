# PVF AI Agent Workbench

这是一个让桌面 AI Agent 帮你查看和修改 DNF `Script.pvf` 的便携工作台。它自带运行环境、PVF 工具、知识路由和安全规则，适合不熟悉代码的用户。

## 下载和开始

1. 在 [Releases](https://github.com/Qswhisper/PVF-Ai-Agent-Workbench/releases) 下载最新版 **PVF-Agent-Workbench-版本号-win-x64.zip**；**Source code (zip)** 也包含所需运行时。
2. 解压后运行 `workbench.bat check`。
3. 用 Codex、Claude Code、OpenCode 或其他命令型 Agent 打开整个工作台文件夹。
4. 让 Agent 先读取 `AGENTS.md`，再提供目标 `Script.pvf`、想处理的内容、是否允许生成新 PVF，以及能否进游戏测试。

第一次使用建议先做只读分析。

## 能做什么

- 查询 PVF 文件、字段、名称、ID 和登记关系。
- 分析商店、装备、技能、任务、掉落、副本、APC、NUT 和跨文件依赖。
- 按“只读分析 → 预演 → 用户批准 → 生成独立的修改版 PVF → 生成后重新检查”执行受控修改。
- 规划同一 PVF 内的文件复制、新文件生命周期、跨版本比较和客户端兼容性检查。
- 经单独确认后，把已复查的 PVF 部署到 profile 指定的测试客户端，并恢复部署前版本。

## 安全原则

- 默认只读；生成阶段不覆盖源 PVF。
- 数字 ID 会先通过对应登记表确认。
- 中文等文字、既有 NUT 和高风险文件只开放经过验证的专用路线，不等于任意内容都能写。
- 多轮修改必须显式继承上一轮结果，避免退回已经验证的改动。
- 不默认修改客户端、NPK、IMG、UI 或其他客户端资源。
- 真实 PVF、客户端、本机 profile、运行报告和密钥不得放入仓库。

## 运行环境与文档

支持 64 位 Windows，随包携带 Node.js，不需要 npm、外部 MCP 或已下架插件。native 后端不可用时会自动进入只读模式；查询仍可用，但不能生成 PVF。

随包 native 后端是预编译文件；当前仓库尚未包含完整 Rust 源码和锁文件，不能据此完整重建该后端。

- 中文使用说明：[README.zh-CN.md](README.zh-CN.md)
- Agent 入口与硬规则：[AGENTS.md](AGENTS.md)
- 测试客户端部署：[docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md](docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md)
- 干净复制：[docs/CLEAN-COPY.zh-CN.md](docs/CLEAN-COPY.zh-CN.md)
- 更新记录：[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

代码使用 MIT License，`knowledge-pack/` 使用 CC0。
