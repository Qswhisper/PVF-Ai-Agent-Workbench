# Worldmap 副本接口布局流程

状态：默认可用

## 目标

把一个 worldmap 页面的 `.wdm` 副本集合、`.ui` 按钮、dungeon registry 和客户端资源候选统一成可审阅的布局计划。默认只读。

## 输入

- 目标 PVF。
- worldmap ID、`.wdm` 路径或 dungeon ID 三选一。
- 可选客户端路径，仅用于单独授权的资源存在性检查。
- 可选目标动作：审计、移动入口、新增入口或删除入口。

## 定位

1. worldmap ID 通过 `worldmap/worldmap.lst` 解析 `.wdm`。
2. `.wdm [ui path]` 解析对应 `.ui`；直接读取该返回路径，禁止用 `list-files`、目录扫描或相似文件名猜测。
3. `.wdm [dungeon]` 中的主 ID 列按目标同类记录形状提取，再通过 `dungeon/dungeon.lst` 解析。
4. `.ui` 只选择 `IDC_WORLDMAP_BUTTON*` 或已由目标最近邻确认等价的副本入口控件。
5. UI 记录里的 dungeon ID 再通过 `dungeon/dungeon.lst` 独立解析。

## 双向一致性

1. 形成 `.wdm` 集合和 `.ui` 入口集合。
2. 按解析后的 dungeon 身份联接，而不是按按钮后缀或出现顺序联接。
3. 输出 `matched / wdm-only / ui-only / conditional / ambiguous / unresolved`。
4. 对 `[in progress]`、任务、物品或隐藏入口条件单独建列，不把差异直接判成错误。
5. 检查重复按钮号、重复 dungeon、入口坐标重叠、超出背景有效范围和明显离群。

## 资源候选

记录但不默认验证或写入：

- `.wdm [map image]`。
- dungeon 小图、worldmap pattern/slot。
- UI 背景、气泡、边框、按钮状态图。
- 入口标题、说明和可能的 ANI/IMG 引用。

客户端索引存在只表示候选资源可找到，不证明帧号、层级、点击命中或显示正常。

## 改动计划

### 移动入口

只改变已确认控件坐标/方向；保持 dungeon ID、按钮身份、条件和资源字段不变。先检查重叠和有效范围。

### 新增入口

把按钮号、控件 ID、坐标、方向、dungeon ID、`.wdm [dungeon]` 成员、条件和资源作为一个原子计划。任何一项 unresolved 时阻止自动写入。

### 删除入口

同时审阅 `.ui` 控件与 `.wdm [dungeon]` 成员；条件/隐藏入口不自动删除。保留目标文件未知块和格式。

## 受控写出

1. 重新读取 `.wdm` 与 `.ui` 的 raw no-simplified 文本。
2. `.wdm [dungeon]` 中完整、只含数字、Tab 和常见符号的记录可走受控原始 token 最小替换；扩展名本身不再造成无理由阻止。中文名称仍需符合独立的安全文字类型许可。
3. 用最小替换构建 change-set，不重排整个控件列表；`.wdm` 成员变化仍须与对应 `.ui` 入口、`dungeon/dungeon.lst` 和条件块一起审阅。
4. 对同一源和同一 change-set 完成未阻塞 dry-run。
5. 使用 approval code 写到显式新 PVF，备份并读回。
6. 客户端资源写入需要独立授权，不包含在 PVF 输出授权内。

新增整个 `.wdm` 页面时改走 `task-cards/pvf-high-risk-new-file-controlled-change.zh-CN.md`：同一原子变更必须同时证明 worldmap registry、UI、最终 dungeon registry、已登记 town gate、已登记 region 以及两者共享的 town ID。缺任一环都不产生正式生成许可。

## 实机验收

把多个入口合并为一次测试批次，检查页面可见、背景完整、按钮不重叠、气泡方向、鼠标命中、任务门控、点击进入的 dungeon 身份和返回路径。静态审计 PASS 与实机 PASS 分开记录。
