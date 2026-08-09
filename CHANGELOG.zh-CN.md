# 更新日志

## 未发布

## 2.1.3

- 将随包 Tag 社区层从未经作者边界确认的大批量注释收敛为 344 条作者成员精确匹配、去重且可直接用于任务定位的单行摘要；保留 2513 条官方原文 / 工具扩展存在性记录与 54 条 registry 提示，并移除署名、渠道、联系方式、维护记录、长正文和歌词类无关内容。
- 内置知识生成器增加显式作者筛选、缺少作者条件时失败关闭、摘要提取、单类构建与 dry-run；知识纯净检查新增大小写无关的私有元数据、来源披露、旧客户端角色和历史来源名称阻断。
- 技能参数事实升级到 2.2，删除无执行价值的纯净度自证字段；删除两份冗余产品功能总表，将仍有执行价值的七类横向能力并入正式任务路由。
- 客户端兼容矩阵改用稳定功能基线、SHA 研究基线和兼容压力上界三种中性角色，保留原有只读比较能力和证据边界，不再携带具体客户端名称。

## 2.1.2

- 将 PVF 内部路径统一改为失败关闭校验，拒绝绝对路径、盘符/UNC、ADS、空段、`.`/`..`、Windows 设备名和落盘越界；副本提取使用独占新文件，旧导入器的 apply/源覆盖入口改为强制转交受控写入通道。
- 普通 backend server 即使 native 可用也默认只读；只有 `pvf-change apply` 的受控 capability 才公开写工具，且源 PVF、已有输出、已有备份与已有 manifest 均禁止覆盖。
- 新增自动 `Cn` 语义读取保护：中文脚本搜索、`.str`、StringLink 和含非 ASCII 的脚本会在统一后端入口自动使用 TypeScript 只读语义结果，无需新增 profile 或用户参数。
- 受控写入增加中文编码护栏与会话文本 overlay：数字/ASCII 最小修改可保持 StringLink 文本并读回；`Cn .str` 和直接非 ASCII 文本写入在 dry-run/apply 前阻断，避免 native 返回成功但输出乱码。
- 索引建立时记录完整 PVF SHA256，日常 freshness 继续使用元数据与三段采样快速检查，高可信验收可用 `--verify-full-sha`；同名的多个 `Script.pvf` 使用路径哈希隔离缓存键。
- fallback 自检扩展到 66 项，加入便携 GBK fixture、语义搜索、受控写入负控和路径攻击样本；大型自检、Doctor、backend contract 与 Release Gate 默认只输出摘要，完整报告落盘，失败项仍直接显示；未配置可选 profile 不再报成警告。

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
