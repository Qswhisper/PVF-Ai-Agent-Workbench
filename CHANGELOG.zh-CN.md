# 更新日志

## 未发布

## 2.1.1

- 修正受控 `replace-text` apply 对 PVF 编译器排版规范化的 readback 假失败：保留全文 SHA，新增区分大小写且仅允许 Section 外空白、数据换行与 float32 展示等价的 token 校验；manifest 分列 exact、normalized-equivalent、binary 与 failed 数量，并补齐 UI/AIC 正例及标签、整数、字符串负控。

## 2.1.0

- 将只读备用后端的运行源码从 JavaScript 迁移为由固定 Node.js 24 runtime 直接执行的 TypeScript；不增加 npm、联网或构建步骤。
- 只读模式的 stdio 工具枚举改为仅公开读取工具，并在分发层与 TypeScript API 层继续以 `READ_ONLY_FALLBACK` 阻断所有写入口。
- 扩展合成 fixture 自检，覆盖 TypeScript runtime 身份、native 优先选择、写工具隐藏、direct API/stdio 写负控和源文件 SHA 不变。
- 增加 TypeScript 只读后端机器契约，固定源码闭包、公开/阻断工具、直接 API 阻断和会话、读取、搜索资源上限。
- 畸形文件树、重复规范化路径和数据 checksum 失败改为失败关闭；搜索结果显式报告截断、读取错误数和有限错误样本。
- 为 StringTable、脚本 token 和 StringView 增加解析前资源上限，并补齐 `.lst` 相对登记路径按注册表目录解析的闭环。
- 真实多版本 PVF 差分修正 `.lst` 显示文本与登记解析的分层、根目录登记路径的 `./` 前缀，并将 StringTable/StringView 改为有界按需解码以降低大型 PVF 常驻内存。

## 2.0.0

- 普通任务改为完全自包含：随包提供固定 Node.js runtime 与 native PVF backend，不依赖外部 MCP、编辑器插件或已下架工具。
- 统一 `workbench.bat` 入口，覆盖环境检查、只读读取、索引、受控 change-set、dry-run、显式授权输出、备份和 readback。
- 知识包收口为百科、字段词典、工作流、任务卡和轻量路由；删除研究账本、历史验收报告、来源定位、样本统计和机器路径。
- 内置 NUT 声明、PVF tag 可信分层和常用任务书签；普通任务无需携带额外知识目录。
- 增加全包质检、语义比较、LST 生命周期、掉落整理、物品来源、技能树安全合并、原子内容生成与统一依赖预览。
- 增加副本与世界标准化路线，包括 map 宽屏结构迁移、worldmap 接口布局、深渊组、难度表、地狱名单、城镇预览和 ANI 边界。
- 增加外部 SHA 锁定的 PVF 谱系与客户端兼容矩阵；所有报告、缓存和真实路径保持在 Workbench 外。
- 增加项目级 `dnf-pvf-xpilot` Skill 适配器，同时保留无 Skill 宿主直接读取 `AGENTS.md` 的路线。
- 增加 runtime 完整性、知识语义纯净性、Agent eval 与三段 portable release gate。
- native 通过完整性校验但因 VC++ v14 x64 运行库加载失败时，人工终端会打开微软官方说明页；Agent/CI 只打印链接，不弹窗或自动安装。
- 增加无 npm 依赖的纯 JavaScript 只读备用后端：native 加载失败时自动接管文件树、脚本/LST/StringLink、NUT、二进制 ANI、搜索和注册表读取；所有备份、apply 与保存以 `READ_ONLY_FALLBACK` 硬阻断。
- 增加合成 PVF 双后端自检、stdio 集成负控和外部多 PVF native/fallback 差分工具，并纳入无 PVF Release Gate 3。
- 版本号从公开基线直接升级为 `2.0.0`。

## 1.1.0

- 早期公开版本。
