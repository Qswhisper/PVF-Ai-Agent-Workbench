# 安全边界

状态：默认可用

## 总规则

- 默认只读。
- 不覆盖源 PVF。
- 不默认修改客户端资源。
- 不把真实 PVF、客户端、API key、索引缓存或运行产物放进 Workbench。
- 数字 ID 不是事实，必须按上下文通过正确 `.lst` registry 解析。
- 教程示例 ID、社区注释、GM 字段、源码字段不能直接作为写 PVF 依据。
- 目标 PVF、任务选择器和工作台已经明确时，第一条 shell 动作必须是路由给出的 `workbench.bat` 命令。不要用 `Test-Path`、`Get-Item`、`Get-ChildItem`、`Resolve-Path` 预检工作台、目标 PVF 或报告/输出目录，也不要用分号串联检查；工作台命令会自行校验输入并创建其声明的外部输出目录，失败后再按返回错误诊断。

## 面向新手的说明

- 安全检查、哈希绑定和机器清单全部保留，但用户可见回复先用通俗中文说明“能否继续、会改什么、风险是什么、下一步做什么”。
- 主结论优先说“预演（先检查；中文改动会用临时文件验证并立即清理）”“生成独立 PVF”“生成后复查”“普通脚本里的完整中文名称/描述（包括多行）可验证修改；批量需先核对准确数量”，不要在开头堆叠 ASCII、non-ASCII、backend、manifest、approval code、readback 或 smoke check。
- 用户确实需要命令、路径、确认码、错误码或实现细节时，放到“技术详情（通常不用看）”之后。不得为了通俗而省略阻断条件或安全步骤。

## 写 PVF 必须满足

1. 明确目标 PVF。
2. 对同一源 PVF 和同一 change-set 完成未阻塞 dry-run，保留 `DRY-RUN-MANIFEST.json` 和 approval code。只要预演被阻止，命令输出和核验记录内部都不会提供可用许可，不要从绑定哈希推算或尝试生成。
3. apply 时显式提供该 dry-run manifest 和 approval code；源 PVF 或 change-set 哈希变化后必须重新 dry-run。
4. 明确输出 PVF，且输出路径不是源 PVF。
5. 创建按源文件 SHA256 存放并核对的备份；相同源版本只保留一份，复用前再次核对哈希。
6. 解析相关 `.lst`。
7. 做最小修改。
8. 保存到显式输出。
9. 重新打开输出 PVF 读回。
10. 生成 manifest 或等价变更清单。
11. 需要时由用户做游戏内验证。

多轮迭代不是自动累积。下一轮只包含本轮差异时，必须在 change-set 中用 `baseline.applyManifest` 显式引用上一轮成功的 `APPLY-MANIFEST.json`。工作台核对上一轮输出、最初受保护源和完整哈希后，以上一轮输出作为本轮输入；`target.sourcePvf` 和 profile 仍指向最初受保护源。预演时按 `pvf-change validate` 返回的 `agentHandoff.nextCommandOnly` 原样执行，不要自行补一个指向最初源的 `--pvf`。未声明该字段就仍表示“原始源 + 本轮改动”，不得部署到已经含历史改动的客户端。部署预览会核对客户端当前版本与本轮输入版本；不一致时默认停止。

## 新增块 / 新增文件护栏

- 新增标签块、新增完整 `.stk` / `.qst` / `.dgn` 等文件，或跨系统引用新 ID 时，先在目标 PVF 的同目录、同扩展名、同用途样本中找最近邻对照。
- 最近邻对照默认只做窄范围抽样，不做无必要全库扫描。优先读目标 PVF 中 3 个左右同类样本，确认块位置、是否有闭合标签、列数、tab、空列和配套字段。
- 已有字段的单个数字最小替换可以按目标块 readback 处理；新增块和新增文件不得凭字段名想象格式。
- 如果目标 PVF 没有同类样本，外部教程、工具源码或其他 PVF 只能作为候选线索，必须提高风险等级并安排 readback / 实机验证。
- 搜索工具返回 0 命中不能单独证明标签不存在，尤其是大规模全文搜索。遇到关键标签时，用目标目录、已知样本路径或其他搜索通道复核。

## 文本与编码护栏

- 创建工作会话或 change-set 后，先确认源 PVF、输出 PVF 和客户端路径在记录中没有乱码。
- 普通 `Cn` 搜索、`.str`、StringLink 和含非 ASCII 的脚本读取由 Workbench 自动进行语义保护；不要要求新手手工切换 backend，也不要关闭该保护来换取速度。
- 含中文字符串或 StringLink 样 token 的 PVF 文本文件，不能只用“读回正常”判断客户端文本安全。
- 数字字段最小替换可按已验证安全路线处理：使用目标原文实际对应的 `pvfEncoding=Cn` 或 `pvfEncoding=Tw`，不做简繁转换，不自动转换 StringLink。两种编码冲突时不得把明显乱码当成源文件损坏。
- 普通脚本中完整、明确的可见中文字段可以使用 `textWriteMode: "verified-inline-text"`。`previousText` 与 `newText` 必须都是完整反引号 token，token 内允许真实 CRLF/LF 多行，编码必须是目标确认的 `Cn` 或 `Tw`。单点替换默认要求恰好 1 次；相同完整文字重复时，可从同一次原始读回复制紧邻的 `contextBefore` 和/或 `contextAfter`，让“上下文 + 旧文字”只命中目标位置。上下文不得包含旧文字，只用于定位并会绑定到预演和正式生成记录，不会放宽完整文字、字段、StringLink、文件类型或编码检查。不要使用容易随文件变化漂移的出现序号。批量必须使用 `replaceAll=true` 并填写精确正整数 `expectedOccurrences`，实际数量不一致就停止。旧字段为纯英文或空字符串时，它本身不能证明新中文该用哪种编码，必须由同一脚本中的已有中文提供证据，否则停止。旧的 `verified-inline-cn` 仅作为兼容别名接受。
- 参数/结构与中文联动时，必须拆成同一 `pvfPath` 下的独立变化：先用 `pvf-read read --raw`（或 `read-batch --raw`）取得与写入校验完全一致的原始 token 排列。未显式给编码时，原始读取会只读比较 Cn/Tw，并且只在一方明显更干净时自动选择；选择结果在 `textUsage.automaticEncodingSelection` 中公开，之后把该 `selectedEncoding` 填入完整中文变化的 `pvfEncoding`。参数块只包含数字、英文、标签、Tab 和常见符号；中文使用完整文字 token。普通读取仅用于查看，可能把繁体转成简体或整理布局，返回的 `textUsage.safeForChangeSetSource=false` 表示不得复制其中任何 `previousText` 或上下文。若预演零命中诊断为 `DISPLAY_TEXT_USED_AS_CHANGE_SOURCE` 或 `CHANGE_TEXT_ENCODING_MISMATCH`，必须按诊断对同一路径重新 `--raw` 读取并重建 change-set；诊断只提供恢复路线，不会自动改字或跨编码写入。组成 change-set 后先运行 `pvf-change validate`，其 `agentHandoff` 明确要求把同路径多项改动留在同一个数组、连续第二轮使用 `baseline.applyManifest`；不要阅读执行器源码或把多项改动拆成多个临时新源。Workbench 先计算一个最终文件；彼此独立时优先先写结构再写文字，若后续结构删除明确依赖“完整中文先清空”的结果，则保留 change-set 数组顺序。无论顺序如何，同一文件的全部安全文字仍只追加一次字符串表、修改一次脚本，所有中间命中与最终文件都统一精确复查。不要把“参数块 + 中文说明”整个声明为 `verified-inline-text`。
- 首期只开放已确认承载名称/说明的文件类型；`.co`、`.lst`、NUT 等逻辑或登记文件不会因为含 `[name]` 就获得中文写权限。
- 这类预演必须先在隔离临时输出中真实写入，再由独立 TypeScript 解析器使用同一编码精确读回；还要证明既有字符串表条目未改变，并比较另一中文编码是否显示出更可信的原文。任一检查失败都不能生成 approval code，核验记录内部也会明确标记许可已收回，临时输出随后清理。
- 直接输出 `.str`、直接修改 StringLink 显示文本、部分中文 token、未声明精确数量的批量替换和无法无损编码的字符仍必须失败关闭；无操作替换不应触发写入。
- 如果输出 PVF 出现 HTML 实体化、路径乱码或客户端道具名/描述/副本文本乱码，禁止继续部署该输出。
- 涉及中文字符串文件的部署验收必须包含客户端 UI 文本 smoke check。

## 客户端资源

Script.pvf 内有资源引用，不代表客户端 ImagePacks2/NPK 资源完整。

修改客户端、写入 NPK、替换 IMG、部署资源包都需要单独授权。

把受控输出 `Script.pvf` 安装到测试客户端也属于单独授权，但可使用专门的 `workbench.bat client-pvf` 路线：

1. 只接受已成功读回并绑定最终输出 SHA256 的 `APPLY-MANIFEST.json`。
2. `preview` 只生成外部预览，不修改客户端；它绑定输出 PVF、profile 客户端根目录和客户端当前 `Script.pvf`。
多轮累积输出还要求客户端当前 SHA256 等于本轮输入 SHA256（或已经等于候选输出）；因此客户端可以就是上一轮输出所在的测试目标，但仍不能与最初受保护源或本轮候选输出是同一文件。不一致时视为可能回退历史改动。只有明确主动切换修改分支时，才可单独确认基线切换。
3. `deploy` 必须使用预览确认码，并确认客户端和启动器已关闭。
4. profile 的 source PVF 必须与 apply 清单一致且未变化；source PVF、独立输出 PVF 和客户端 `Script.pvf` 必须是三个不同文件。
5. 替换前创建并核对客户端当前 PVF 的内容寻址备份；相同 SHA256 只存一份。
6. 部署后核对客户端目标 SHA256；恢复必须再次预览和确认，且客户端当前版本发生未知变化时停止。
7. 这项权限只覆盖 profile 客户端根目录的 `Script.pvf`，不包含 NPK、IMG、UI 或其他客户端文件。
