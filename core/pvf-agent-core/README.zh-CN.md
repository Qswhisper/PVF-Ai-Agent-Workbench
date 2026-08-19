# pvf-agent-core

这里是 PVF-Agent-Workbench 的本地能力核心。

## 主要入口

- `cli/pvf-readonly.js`: 只读 open/list/search/read/read-batch、名称命中自动登记确认，以及单项/批量 resolve-lst/resolve-path。
- `cli/pvf-index.js`: 生成和查询本地只读索引。
- `cli/pvf-change-set.js`: 受控写入执行器；校验、dry-run、apply 到显式 output，支持由上一轮 apply 清单绑定累积输入，并强制经 SHA256 核对且可去重复用的受保护源备份、readback、manifest。
- `cli/client-pvf-deploy.js`: 独立测试客户端部署执行器；验证 apply 输出 SHA，预览并绑定 profile 客户端目标及本轮输入基线，错误基线默认停止，部署前去重备份，部署后哈希复查，并提供受控恢复。
- `cli/pvf-backend-contract.js`: 对 PVF backend 做只读 contract 检查。
- `contracts/typescript-readonly-backend-contract.v1.json`: 固定 TypeScript fallback 的运行闭包、只读工具面、写阻断和资源上限。
- `cli/unified-knowledge-query.js`: 查询随包内置 NUT、tag、任务书签及任务显式提供的研究 artifact。
- `scripts/workbench-profile.js`: 创建、选择和查看本机私有 profile；数据保存在工作台外的用户状态目录，旧的工作台内 profile 会自动无损迁移。
- `scripts/runtime-absorb-checklist.js`: 生成实机验证结论吸收清单。

权限边界：

- `config/pvf-adapter.json` 只启动随包内置 backend，不依赖宿主插件或外部服务。
- 下一轮 change-set 只写本轮差异时必须用 `baseline.applyManifest` 引用上一轮成功生成记录；工作台重新核对上一轮输出和最初受保护源，并继续复用按原始源 SHA256 存放的备份。未声明时仍按“原始源 + 当前 change-set”处理，不会隐式累积。
- 随包 native backend 始终优先；native 无法加载时，固定 Node.js runtime 直接执行 `tools/pvf-bridge/fallback/*.ts`，只允许读取和不需要临时写出的普通 dry-run。`verified-inline-text` 的往返预演必须等待 native 可用。
- `config/write-policy.json` 定义 `pvf-change-set.js` 的受控写入通道；写入只能保存到显式 output，不能覆盖源 PVF，不能写客户端资源。
- 新增 `.co`、`.lst`、`.nut`、`.sqr`、`.str`、`.wdm` 不是普通 `write-file`：必须提交对应的 `writeProof`，通过格式、登记冲突/引用闭合、脚本结构、临时写出或编码往返和独立读回。既有高风险文件仍保持保护；新增 `.wdm` 必须把 registry、UI、dungeon、town/region 入口作为一个原子生命周期检查。
- 普通脚本中允许字段下的完整中文反引号 token（可含真实多行）可使用 `verified-inline-text` 和目标确认的 `Cn` 或 `Tw`；相同完整文本重复时，可用同次原始读回中紧邻目标的 `contextBefore`/`contextAfter` 联合定位。同构块仍重复时，普通参数和文字变化可共用 `scope.startText/endText/expectedRanges`，仅在精确非重叠区间内部匹配；目标和上下文不得越界，边界不得改写或注入，范围字段、位置与内容哈希绑定到预演和生成。`replaceAll=true` 时必须填写范围内精确 `expectedOccurrences`。参数/结构与中文拆为同路径变化，执行器计算一个最终文件并联动验证；当后续结构删除依赖文字结果时保留数组顺序，同一路径的全部安全文字仍只批量追加一次字符串表、修改一次脚本。dry-run 做隔离临时写出、旧字符串表保持、乱码冲突和 TypeScript 精确读回；apply 后再次独立复查。`.str`、StringLink 显示文本、部分中文 token、出现序号或 `scopePart` 定位、未精确计数批量和无法编码字符保持阻断。
- `config/client-pvf-deploy-policy.json` 只允许在单独预览和授权后，把已验证的独立输出安装为 profile 客户端根目录的 `Script.pvf`；源文件、输出文件、客户端目标必须互不相同，NPK/IMG/UI 等资源始终禁止。
- 文本 readback 先要求全文 SHA 一致；若 PVF 编译器只规范化了 Section 外空白、数据换行或 float32 展示，则再做区分大小写的 token 等价校验。反引号字符串、标签、整数、顺序或数量有任何变化仍会失败，manifest 会分别记录 exact 与 normalized-equivalent 数量。
