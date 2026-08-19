# PVF AI Agent Workbench

这是一个让 AI Agent 帮你查看和修改 DNF `Script.pvf` 的便携工作台。你不需要先懂代码，只要告诉 Agent 想改什么，它会按内置知识查文件、核对 ID，并先给出安全方案。

## 下载和开始

1. 在 [Releases](https://github.com/Qswhisper/PVF-Ai-Agent-Workbench/releases) 下载最新版 **Source code (zip)**。
2. 解压后运行 `workbench.bat check`。
3. 用 Codex、Claude Code、OpenCode 或 Zcode 打开整个工作台文件夹。

然后告诉 Agent：

- `Script.pvf` 在哪里；
- 想修改什么；
- 是否允许生成新的输出 PVF；
- 是否可以进游戏测试。

第一次使用时，建议先让 Agent 只读分析，不要直接写入 PVF。

## 能做什么

- 查 PVF 文件、字段、ID 和对应的登记表，减少凭数字猜测。
- 分析商店、装备、技能、任务、掉落、礼包、宠物、副本、APC 和 NUT 脚本。
- 规划内容提取、跨版本比较、依赖关系和客户端兼容性检查。
- 按“只读分析 → 预演 → 用户批准 → 生成并复查新 PVF”的流程执行修改。
- 可在单独确认后把已复查的 PVF 安装到 profile 指定的测试客户端，并恢复部署前版本。

## 安全原则

- 默认只读，不覆盖源 PVF。
- 不会默认修改客户端、NPK 或 IMG 文件。
- 写出前必须核对目标、预演修改；写出时会创建或复用经核对的源版本备份，并重新读取检查。
- 多轮修改可显式继承上一轮成功输出；部署预览会阻止把基于旧版本的增量输出覆盖到已经继续演进的客户端。
- 本机 profile 保存在工作台目录外的用户状态目录；刷新同一路径的工作台不会删除它。旧版目录内 profile 会在首次使用 profile 命令时安全复制过去，旧文件不删除。
- 详细检查报告默认写入本地运行目录，对话和终端只显示摘要与失败项。

## 运行环境

当前版本支持 **64 位 Windows**，已自带 Node.js，不需要 npm、外部 MCP、TypeSquirrel 或已下架的 VSCode 插件。native 后端仍为首选；随包 TypeScript 只读后端由固定 Node.js runtime 直接执行，不需要转译或构建。

如果 native 后端因缺少 VC++ 运行库而无法加载，工作台会自动进入只读模式；查询仍可用，但不能输出 PVF。`workbench.bat check` 会说明原因并给出微软官方下载入口。

删除含中文说明的完整选项块也使用同一安全路线：按变更数组顺序先处理完整文字，再删除依赖该结果的结构；跨部位同值时每一步共用目标块的精确范围。工作台仍只批量处理一次中文并精确复查最终文件，其他部位保持不变。

详细规则见 [AGENTS.md](AGENTS.md)，测试客户端安装与恢复见 [docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md](docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md)，复制到新电脑前见 [docs/CLEAN-COPY.zh-CN.md](docs/CLEAN-COPY.zh-CN.md)。代码使用 MIT License，`knowledge-pack/` 使用 CC0。
