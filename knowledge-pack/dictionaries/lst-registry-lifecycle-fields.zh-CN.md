# LST Registry 生命周期词典

状态：默认可用

## 基本记录

常见文件路径 registry 的一条记录可抽象为：

```text
numeric ID <TAB> relative/path.ext
```

目标 PVF 的实际分隔、注释、大小写、斜杠、空列和头部规则优先。导入候选可接受 TAB 或明确配置的逗号拆列，并忽略空行、`#` 与 `//` 注释行；写回时必须恢复目标 registry 的原始格式。

registry 行里的路径通常相对于该 `.lst` 所在目录。例如 `map/map.lst` 中的 `Tower/A.map` 对应完整 PVF 路径 `map/Tower/A.map`。只读 `resolve-path --registry <domain>` 同时接受这两种写法并返回归一后的完整查询路径；受控写入证明里的 `writeProof.registry.expectedPvfPath` 仍必须填写完整 PVF 路径，避免把“登记表相对路径”和“PVF 根相对路径”混为一谈。

## 三个身份层

| 层 | 含义 | 不能替代 |
| --- | --- | --- |
| ID | registry 内的数字键。 | 不能跨另一个 `.lst` 推断实体类型。 |
| path | registry 指向的 PVF 相对路径。 | 不能仅凭相似文件名推断 ID。 |
| name | 从目标脚本读取或导出的人类可读名称。 | 名称不是 registry 身份，重名不等于同一实体。 |

## 冲突类别

- `id-conflict`：目标 ID 已指向另一路径。
- `path-conflict`：目标路径已由另一 ID 登记。
- `exact-existing`：同一 ID 与同一路径已经存在，应复用而不是重复追加。
- `missing-target-file`：登记目标文件不存在或读取失败。
- `unregistered-file`：文件存在但未在声明的 registry 找到；先记 orphan candidate。若候选 ID 也空闲、路径反查仍无登记且引用闭合，可作为 `clean-add` 补登记，不要求重新创建文件。
- `cross-registry-id`：同号出现在另一个 registry；是否危险取决于实际引用域。
- `malformed-row`：列数、数字或路径形状无法按目标格式解析。

新增候选 ID 通常要求正整数；若目标 registry 明确存在合法的 `0` 或其他特殊约定，必须以目标样本为准，不能把工具输入限制提升为 PVF 全局事实。

## 原子生命周期

新增内容至少同时审阅：新脚本路径、新 ID、registry 行、所有引用方、引用方所用 registry、客户端资源候选和 readback。只写脚本不登记、只登记不创建文件、或只改引用不闭合 registry 都是不完整计划。
