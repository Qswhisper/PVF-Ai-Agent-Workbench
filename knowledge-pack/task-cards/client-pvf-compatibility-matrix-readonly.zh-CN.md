# 客户端 / PVF 兼容矩阵只读任务卡

状态：默认可用

## 先读

- `dictionaries/client-compatibility-matrix-boundary-quick.zh-CN.md`
- `workflows/client-pvf-compatibility-matrix.zh-CN.md`
- `safety/README.zh-CN.md`

## 执行

1. 确认三种证据角色、完整 PVF SHA 与客户端资源时间对齐状态。
2. 先用 metadata 或 scoped 扫描；只有明确 profile 才读取完整 NPK 索引。
3. 分层比较 registry、raw probe、依赖、资源路径和客户端 anchor。
4. 保留 `unknown` 与 `custom-only` 的限定含义。
5. 交付前重哈希 PVF、anchor 和资源元数据。

## 禁止

- 不把稳定功能基线称为已证明的字节级官服原版。
- 不把兼容压力上界的独有内容称为官方字段。
- 不把动态 IMG 模板的字面未命中写成 missing。
- 不写客户端、NPK、IMG 或部署资源。
- 不把矩阵或资源存在性写成实机 PASS。
