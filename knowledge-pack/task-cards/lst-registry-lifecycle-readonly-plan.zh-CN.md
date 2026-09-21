# LST Registry 生命周期只读计划

状态：默认可用

用途：导出任意 `.lst`，检查重复和引用闭合，并为新增 `ID + path` 生成冲突预览。

## 先读

- `dictionaries/lst-registry-lifecycle-fields.zh-CN.md`
- `workflows/lst-registry-lifecycle.zh-CN.md`

## 最小输入

- 目标 PVF 和目标 `.lst` 路径。
- 只读导出，或候选 `ID + TAB + relative path` 列表。
- 若登记新内容，提供引用方或业务目标。

## 执行

1. 新增登记前先对候选路径执行一次 `pvf-read resolve-path --registry <domain>`。可输入完整 PVF 路径或登记表相对路径；若已命中，复用返回的 ID，不再追加重复行。
2. 按目标格式解析 ID / path，名称单列。
3. 输出 exact-existing、id-conflict、path-conflict、missing、unregistered-file、malformed、clean-add；真正未登记但已经存在的目标文件可以进入 clean-add 审阅。
4. 新脚本、registry 和引用方按一个原子计划审阅。
5. 默认只给 preview，不自动选择覆盖或去重策略。

## 禁止

- 只登记不创建文件，或只创建文件不登记。
- 用名称作为 registry 主键。
- 将一个 registry 的空闲 ID 外推到另一个 registry。
- 未预览冲突就追加行。
