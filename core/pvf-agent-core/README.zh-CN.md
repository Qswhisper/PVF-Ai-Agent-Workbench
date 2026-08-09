# pvf-agent-core

这里是 PVF-Agent-Workbench 的本地能力核心。

## 主要入口

- `cli/pvf-readonly.js`: 只读 open/list/search/read/read-batch/resolve-lst/resolve-path。
- `cli/pvf-index.js`: 生成和查询本地只读索引。
- `cli/pvf-change-set.js`: 受控写入执行器；校验、dry-run、apply 到显式 output，并强制备份、readback、manifest。
- `cli/client-pvf-deploy.js`: 独立测试客户端部署执行器；验证 apply 输出 SHA，预览并绑定 profile 客户端目标，部署前去重备份，部署后哈希复查，并提供受控恢复。
- `cli/pvf-backend-contract.js`: 对 PVF backend 做只读 contract 检查。
- `contracts/typescript-readonly-backend-contract.v1.json`: 固定 TypeScript fallback 的运行闭包、只读工具面、写阻断和资源上限。
- `cli/unified-knowledge-query.js`: 查询随包内置 NUT、tag、任务书签及任务显式提供的研究 artifact。
- `scripts/workbench-profile.js`: 创建、选择和查看本机私有 profile。
- `scripts/runtime-absorb-checklist.js`: 生成实机验证结论吸收清单。

权限边界：

- `config/pvf-adapter.json` 只启动随包内置 backend，不依赖宿主插件或外部服务。
- 随包 native backend 始终优先；native 无法加载时，固定 Node.js runtime 直接执行 `tools/pvf-bridge/fallback/*.ts`，只允许读取和 dry-run。
- `config/write-policy.json` 定义 `pvf-change-set.js` 的受控写入通道；写入只能保存到显式 output，不能覆盖源 PVF，不能写客户端资源。
- `config/client-pvf-deploy-policy.json` 只允许在单独预览和授权后，把已验证的独立输出安装为 profile 客户端根目录的 `Script.pvf`；源文件、输出文件、客户端目标必须互不相同，NPK/IMG/UI 等资源始终禁止。
- 文本 readback 先要求全文 SHA 一致；若 PVF 编译器只规范化了 Section 外空白、数据换行或 float32 展示，则再做区分大小写的 token 等价校验。反引号字符串、标签、整数、顺序或数量有任何变化仍会失败，manifest 会分别记录 exact 与 normalized-equivalent 数量。
