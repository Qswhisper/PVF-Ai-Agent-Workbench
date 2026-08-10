# PVF 只读备用后端

Workbench 的普通后端选择顺序是：

```text
随包 native 可加载 -> 使用完整后端
随包 native 加载失败 -> 自动使用 TypeScript 只读备用后端
```

备用后端不是外部插件，也不需要 npm、网络、转译器或额外安装。它的 `.ts` 源码随干净 Workbench 一起复制，由固定的 Node.js 24 runtime 直接做类型擦除并执行，用来保证新电脑暂时缺少 VC++ 运行库时仍能开展只读工作。`workbench.bat check` 会同时验证固定 runtime 具备这项能力。

即使 native 正常加载，统一只读入口仍会在 `Cn` 中文搜索、`.str`、StringLink 或含非 ASCII 脚本出现时自动采用备用后端的语义结果。这个保护按会话复用，不需要 profile 参数，也不要求普通用户手工设置环境变量。

## 可以做什么

- 打开 PVF、读取文件树和元数据。
- 列出、读取和搜索文件。
- 解密并反编译常见脚本与 LST。
- 保留或解析 StringLink，并按需读取 StringTable / StringView。
- 读取 NUT 等纯文本文件。
- 反编译支持范围内的二进制 ANI；无法识别时返回原始 base64，而不是猜测文本。
- 支持 Workbench 的注册表解析、只读 planner、索引和不需要临时写出的普通 dry-run 路线。

## 绝对不能做什么

备用模式下，保存、写文件、非 dry-run 文本替换、删除、重命名、导入、导出和为写入任务创建备份都会抛出 `READ_ONLY_FALLBACK`。`verified-inline-text` 的 dry-run 也会停止，因为它必须实际生成并清理一个隔离临时输出才能证明编码安全；停止时不给 approval code。stdio 的 `tools/list` 不公开写工具；即使绕过枚举直接按名称调用，分发层和 TypeScript API 层仍会再次阻断。`workbench.bat pvf-change apply` 会在修改发生前停止，不会把备用解析结果交给 native 写回。

native 可写时仍有独立的编码护栏：普通脚本中一个完整、明确的中文名称/描述可以使用 `verified-inline-text` 和目标确认的 `Cn` 或 `Tw`。预演会先按同一编码生成隔离临时输出，由 TypeScript 备用解析器精确读回，并确认所有旧字符串表条目保持不变；若另一编码明显更可信或任一检查失败，都不给正式生成许可。`.str`、StringLink 显示文本、部分 token、批量替换和无法无损编码的字符仍被阻断。数字或 ASCII 最小替换继续使用语义正确的源文本、会话 overlay 和 fallback 读回；所有文本承载文件都保留客户端文字检查。

这条限制是架构边界，不是等待用户确认后可以绕开的提示。需要输出 PVF 时，先安装兼容的 Microsoft Visual C++ v14 x64 runtime，再运行 `workbench.bat check`，直到状态显示 native 完整后端可用。

## 已知限制

- 不做简繁自动转换；返回目标编码下的原始显示文本。
- 混合编码或来源不明的 NUT 注释可能与 native 呈现不同；可执行的 ASCII 结构仍需保持，乱码不能当成写入依据。
- 全包正文搜索需要逐文件按需解密，在大型 PVF 上可能比 native 慢。
- 二进制 ANI 只反编译已确认的结构；未知结构保留为二进制。
- `listFiles` 在首次读取前根据扩展名推断脚本/ANI 类型，读取后才确认内容类型。
- 搜索最多保留 5000 条结果并标记 `truncated`；结果数量从不构成写入授权。
- 同时最多打开 4 个 TypeScript fallback session；文件树、单次读取、StringTable 条目及解码缓存、脚本 token、StringView 文件数、搜索关键字和错误样本均有显式资源上限。StringTable 按索引解码，StringView 只加载当前脚本实际引用的编号。损坏文件会计入 `errorCount`，不会静默伪装成普通未命中。

## 检查与维护

```bat
workbench.bat check
workbench.bat fallback-self-test
workbench.bat backend-contract show-readonly
```

`fallback-self-test` 默认只打印摘要和失败项，完整报告会写入本机 runtime state；维护人员需要逐项查看时加 `--details`。回归包含普通中文写入的预演、批准绑定、独立输出、精确读回、HTML 实体负控、StringLink 保持和源 PVF 不变。

维护人员可用 `PVF_WORKBENCH_BACKEND=typescript-readonly` 强制进入备用模式。`workbench.bat fallback-diff` 只用于对外部 PVF 做 native/fallback 回归比较，报告必须写在 Workbench 外。普通用户和 Agent 不应为了绕过 native 错误而强设 backend 模式。
