# Text / StringLink / Encoding 只读审计任务卡

状态：默认可用


## 快速结论

- StringLink 主要集中在 `.stk`、`.obj`、`.equ`、`.aic`、`.map`、`.mob`、`.etc`、`.ui`、`.qst`、`.msn`。
- StringLink 主要出现在 `[name]`、`[name2]`、`[map name]`、`[explain]`、`[flavor text]`、`[minimum info]`、`[ui controls]`、`[name_text]`、`[cond_text]` 等字段。

## 默认处理

1. 问文本、中文、乱码、StringLink、名称表、`.str`、`stringtable.bin`、编码或本地化时，先读本任务卡。
2. 需要术语和字段口径时，读 `dictionaries/text-stringlink-encoding-fields.zh-CN.md`。
3. 需要分布矩阵、namespace、标签和辅助差异时，读 `indexes/text-stringlink-encoding-localization-boundary.zh-CN.md`。
4. 需要文件类型说明时，读 `encyclopedia/pvf-file-types/text-stringlink-localization.zh-CN.md`。
5. `workbench.bat` 会自动保护 `Cn` 搜索、`.str`、StringLink 和非 ASCII 脚本读取；不让用户额外选择 backend。

## 不能直接下结论

- 不能把 StringLink token 写成 UI 一定显示。
- 不能把直接文本写成字体、换行或控件布局正常。
- 不能把 Tw 下可读写成所有编码都正确。
- 不能把 `.str`、名称表或 `stringtable.bin` 写成运行时一定加载。
- 不能把只读观察或 PVF 读回正常写成客户端中文文本安全。

## 下一步测试建议

本主题当前不做实机测试。后续如果要验证文本写入，最小顺序是：

1. 选一个低风险、可见 UI 文本字段。
2. 确认父文件、父块、StringLink 或直接文本形态。
3. 创建 PVF lab session 和备份。
4. 保存到显式输出 PVF，不覆盖源 PVF。
5. 重新打开输出 PVF 读回。
6. 实机检查 UI 是否显示、换行是否正常、是否有乱码和控件溢出。

如果只是含中文/StringLink 文件中的数字字段最小替换，优先使用已验证安全路线：`pvfEncoding=Cn`、不做简繁转换、不自动转换 StringLink，并在客户端检查相关道具名、说明或副本文本。

当前 `Cn .str` 和直接非 ASCII 文本写入会在 dry-run 阶段被自动阻止。不要通过手工调用 bridge 或关闭保护绕过。
