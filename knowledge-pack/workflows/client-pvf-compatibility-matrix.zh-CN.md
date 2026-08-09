# 客户端 / PVF 兼容矩阵流程

状态：默认可用

## 适用

用于比较三类 SHA 锁定目标的 registry、选定 raw PVF 文件、脚本依赖、ANI/IMG/NPK 路径，以及客户端 anchor 的编码/UI 风险。

## 输入

- Workbench 外的私有 profile。
- 至少三个目标，分别承担稳定功能基线、SHA 研究基线和兼容压力上界角色。
- 每个目标的完整 PVF SHA、客户端根目录、客户端伴随 PVF 和资源时间对齐状态。
- 有界的 registry、PVF probe、client anchor 和资源扫描策略。

## 执行

1. 校验三种角色和禁止声明：稳定功能基线不证明官服原版；兼容压力上界不具官方字段权威。
2. 重哈希每份目标 PVF，使用 raw no-simplified 读取指定 registry 与 probe。
3. 分别记录文件存在性、raw 文本 SHA、registry fingerprint、依赖引用和读错误。
4. 扫描客户端 anchor 的完整 SHA 与编码候选；SHA 研究基线的归档 PVF 与当前客户端伴随 PVF 不一致时保持时间对齐未知。
5. 客户端资源默认只扫元数据。只有 profile 明确要求时才做 scoped/complete NPK 索引读取，并保存外部缓存与中断 checkpoint。
6. 动态格式 IMG 路径标 `unknown`；完整索引覆盖下的精确路径未命中才可标 `missing`。
7. 生成 `present / missing / divergent / custom-only / unknown` 矩阵。
8. 用 `verify --rehash-pvfs --rehash-anchors --refresh-client-metadata` 做交付前 readback。

## 命令

```bat
workbench.bat client-matrix build --profile "D:\research\PRIVATE-CLIENT-MATRIX-PROFILE.json" --out "D:\research\client-matrix"
workbench.bat client-matrix query --matrix "D:\research\client-matrix\CLIENT-COMPATIBILITY-MATRIX.json" --status divergent
workbench.bat client-matrix verify --matrix "D:\research\client-matrix\CLIENT-COMPATIBILITY-MATRIX.json" --rehash-pvfs --rehash-anchors --refresh-client-metadata
```

## 验收

- PVF、profile、anchor 与资源元数据可重哈希。
- registry、raw 文件、资源条目与编码/UI 风险分层。
- `custom-only` 明示为矩阵相对状态；`unknown` 不被静默改成 missing。
- 报告明确未写 PVF、客户端、NPK 或 IMG，且不是实机 PASS。
