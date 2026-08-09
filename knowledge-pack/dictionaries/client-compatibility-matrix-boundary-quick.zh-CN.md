# 客户端 / PVF 兼容矩阵快速边界

状态：默认可用

## 三种证据角色

- 稳定功能基线：只表示已知稳定的功能对照；不证明字节级官服原版。
- SHA 研究基线：只对完整 PVF SHA 绑定的研究事实负责。归档 PVF 与当前客户端资源若不是同一快照，必须标 `resourceTemporalAlignment: unknown`。
- 兼容压力上界：只作内容量和兼容压力上界；其独有内容不能称为官方字段或官方语义。

## 状态

| 状态 | 含义 |
| --- | --- |
| `present` | 当前检查层发现对象；不自动证明运行时正确。 |
| `missing` | 在声明为完整的当前检查覆盖内未发现对象。 |
| `divergent` | 多目标都有对象，但 registry、raw 文本 SHA、anchor SHA 或资源条目长度等比较签名不同。 |
| `custom-only` | 只在一个矩阵目标出现；仅是矩阵相对状态，不代表官方或正确。 |
| `unknown` | 覆盖不足、动态路径模板、读取错误或证据不足，不能降格写成 missing。 |

## 资源层边界

- 默认只采集 ImagePacks2/NPK 文件元数据；读取 NPK 内部索引必须由私有 profile 明确限定范围或明确启用完整索引扫描。
- `%04d`、`*` 等动态 IMG 路径不是可精确查询路径；字面未命中固定为 `unknown`。
- NPK 索引命中只证明容器索引存在候选条目，不证明 IMG 图层、ANI 帧、UI、音频或实机行为正确。
- 缓存按路径、大小、mtime 和目标资源 fingerprint 绑定；重要结论仍应复核 PVF SHA、client anchor SHA 和资源元数据 fingerprint。

## 硬边界

矩阵只读，不写 PVF、客户端、NPK 或 IMG，不生成部署计划。若用户另行授权安装已经通过受控写出和读回的独立输出 PVF，改走 `workflows/client-pvf-controlled-deployment.zh-CN.md`；矩阵结果不能代替部署路线的输出与客户端当前版本绑定。NPK/IMG/UI 等真实客户端资源改动仍需另外授权；运行时结论仍需高收益实机验证。
