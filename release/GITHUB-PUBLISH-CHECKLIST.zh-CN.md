# GitHub 2.2.2 发布清单

本清单用于把当前干净目录同步到 GitHub。Gate 报告、真实 PVF、客户端、
本机 profile 和研究目录都不进入仓库。

## 同步方式

1. 使用 Git 客户端克隆远端仓库；不要使用 GitHub 网页逐文件上传。
2. 用本目录覆盖克隆目录中的工作台文件后执行 `git add -A`。必须使用
   `-A`，因为只复制新文件不会删除远端旧文件。
3. 确认以下 1.0/1.1 遗留文件显示为删除：

   - `config/mcp-templates/host-agent-notes.zh-CN.md`
   - `config/mcp-templates/pvf-agent-core.system-node.fragment.json`
   - `config/mcp-templates/pvf-agent-core.windows-bundled-node.fragment.json`
   - `config/mcp-templates/README.zh-CN.md`
   - `config/mcp-templates/typesquirrel-optional.zh-CN.md`
   - `config/mcp.json`
   - `core/pvf-agent-core/lib/mcp-stdio-client.js`
   - `core/pvf-agent-core/mcp/README.md`
   - `core/pvf-agent-core/mcp/server.js`

4. 运行 `workbench.bat release all`，只提交 Gate 全通过的源码树；外部
   runtime state 中的报告不提交。
5. 确认 `runtime/node/node.exe` 是普通 Git blob，不是 Git LFS pointer。
   它会触发 GitHub 的 50 MiB 警告，但低于 100 MiB 单文件硬限制。保留
   普通 Git blob 才能让 GitHub 自动生成的 Source code zip 开箱即用。
6. 检查 `git status --short`，确认没有真实 `.pvf/.npk/.img`、本机路径、
   secret、数据库、压缩包、缓存目录或 Gate 输出。
7. 提交并推送后，在远端 tag 对应的 Source code zip 中再次运行
   `workbench.bat check`、`workbench.bat pvf-change self-test`、
   `workbench.bat client-pvf self-test`、`workbench.bat fallback-self-test` 和
   `workbench.bat release gate3`，再创建 `v2.2.2`
   Release。

## 发布措辞边界

- 可以声明普通 PVF 任务无需已下架 VSCode 插件、外部 `pvf_bridge` MCP、
  TypeSquirrel、npm 或联网下载。
- 可以声明发行包固定支持 64 位 Windows，并随包携带 Node.js。
- 在找回 native Rust 源码与锁文件并重编译前，不要声明整个 native
  后端可由本仓库源码复现。
- 在全新 Windows 没有兼容 VC++ v14 runtime 时，可以声明只读查询仍由
  随包 TypeScript 备用后端工作，但不能声明 PVF 写入可用。
  `workbench.bat check` 会明确显示 degraded read-only 并给出微软官方 x64
  运行库链接。人工交互终端会打开官方说明页；Agent/CI 不弹窗，也不会
  自动下载或安装。
- 可以声明 `Cn` 搜索、`.str`、StringLink 与中文脚本读取会自动进行语义
  保护；也可以声明普通脚本中完整中文名称/描述支持单行、多行和精确计数
  批量，参数与中文可在同文件联动验证。不能宣传成任意中文都可写；
  `Cn .str`、StringLink 显示文本、部分中文 token、未计数批量和无法编码
  字符仍必须失败关闭，最终仍需游戏内文字检查。
- 可以声明已复查的独立输出 PVF 可在单独预览和确认后部署到 profile 指定
  的测试客户端，并可恢复部署前版本；不能把这项权限扩大为 NPK、IMG、UI
  或其他客户端资源写入，也不能把文件部署成功宣传为实机功能通过。
