# 干净复制到新电脑

这个 Workbench 可以直接拷到另一台电脑给 AI Agent 使用，但干净包只应该包含规则、工具、知识包和示例。不要把本机私有配置、真实 PVF、客户端、索引缓存或运行产物一起当成工作台内容迁移。

当前干净包支持 64 位 Windows。它自带 Node.js，不依赖 npm、联网下载、外部 `pvf_bridge` MCP、TypeSquirrel 或已下架的 VSCode 插件。native backend 会在首次 `workbench.bat check` 中真实加载；目标电脑若缺少兼容的 Microsoft Visual C++ v14 runtime，工作台会自动使用随包 TypeScript 只读备用后端。`.ts` 源码由固定 Node.js runtime 直接执行，不需要安装或编译；检查命令会显示[微软官方说明页](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)和[官方 x64 直达下载](https://aka.ms/vc14/vc_redist.x64.exe)。读取任务仍能工作，但 PVF 备份、apply 和保存全部阻断。人工交互终端会打开说明页，Agent/自动化不弹窗；也可随时运行 `workbench.bat runtime-help --open`。Workbench 不私自附带、下载或安装 Microsoft DLL。

## 不要复制

- `config/providers.local.json`
- `config/workspace-profiles.local.json`
- `config/*.secret.json`
- 任何真实 `.pvf`、`.bak`、`.npk`、`.img`
- 外部 source manifest、claim store、PVF lineage、dependency plan、client matrix、私有回归 profile 和查询报告

运行产物默认直接写到 Workbench 外部，`workbench.bat check` 会拒绝 Workbench 内残留的非占位运行产物。手动复制前仍应确认没有把外部运行目录、真实 PVF 或客户端一起打包。

## 新电脑启动顺序

1. 进入 Workbench 根目录，运行 `workbench.bat check`。
2. 支持 Agent Skills 的宿主可以直接发现 `.agents/skills/dnf-pvf-xpilot`；需要用户级调用时，在新电脑运行 `workbench.bat skill install --client codex` 或 `--client agents`。
3. 让当前 AI Agent 先读 `AGENTS.md`、`README.zh-CN.md` 和 knowledge-pack 路由入口。
4. 如果需要固定 PVF、客户端和输出目录，重新运行 `workbench.bat profile init ... --set-active` 生成本机 profile。
5. 直接使用 `workbench.bat pvf-read`、`workbench.bat pvf-index`、`workbench.bat pvf-change`；随包后端不需要宿主 MCP、已下架插件或额外知识目录。若 `check` 显示只读降级，可继续读取和预演，但必须修复 native 后才能生成输出。需要部署到测试客户端时，使用单独的 `workbench.bat client-pvf` 预览、确认和恢复路线。
6. 用 `workbench.bat knowledge-query nut/tag/bookmark` 检查随包知识是否可查；只在具体任务需要时重新提供该任务自己的 PVF、客户端或输出路径。

## 复制后判断是否干净

- `workbench.bat check` 应通过。
- 输出中应出现 `Runtime integrity: 2 pinned artifact(s)`。完整状态会显示 native 可读写；若显示 degraded read-only，工作台仍可读，但不满足发布前的写入环境检查。
- `workbench.bat fallback-self-test` 应通过合成 PVF、独立 native 读取、stdio 集成和全部写入口负控。
- `workbench.bat knowledge-check` 应通过。
- `workbench.bat doctor check --skip-profiles` 应通过必需能力通道。
- `workbench.bat eval self-test` 应同时接受正夹具并拒绝负夹具。
- `workbench.bat skill self-test` 应通过结构、安装更新、漂移检测和冲突保护检查。
- `workbench.bat client-pvf self-test` 应通过纯临时夹具的预览、授权负控、备份去重、部署和恢复检查，不需要真实客户端。
- `workbench.bat knowledge-query self-test` 和 `workbench.bat client-matrix self-test` 应通过只读 contract 与边界负控。
- `workbench.bat release gate3` 应在独立 stage 中通过。
- `config/workspace-profiles.local.json` 不应该来自旧电脑；需要时在新电脑重新生成。
