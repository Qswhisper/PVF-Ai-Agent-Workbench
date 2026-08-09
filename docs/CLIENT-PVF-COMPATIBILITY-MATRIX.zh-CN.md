# 三客户端 / PVF 只读兼容矩阵

`workbench.bat client-matrix` 比较 SHA 锁定的 PVF registry、选定 raw 文件与脚本依赖、ANI/IMG/NPK 路径，以及客户端 anchor 的编码/UI 风险。

三个角色必须分开：

- 稳定功能基线不证明字节级官服原版。
- SHA 研究基线只对指定 PVF SHA 负责；归档 PVF 与当前客户端资源的时间对齐单独标记。
- 兼容压力上界只用于兼容压力检查；`custom-only` 仅表示本矩阵相对独有，不是官方字段或官方内容。

```bat
workbench.bat client-matrix build --profile "D:\research\PRIVATE-CLIENT-MATRIX-PROFILE.json" --out "D:\research\client-matrix"
workbench.bat client-matrix query --matrix "D:\research\client-matrix\CLIENT-COMPATIBILITY-MATRIX.json" --status divergent
workbench.bat client-matrix verify --matrix "D:\research\client-matrix\CLIENT-COMPATIBILITY-MATRIX.json" --rehash-pvfs --rehash-anchors --refresh-client-metadata
```

默认只扫描客户端资源文件的路径、大小和时间元数据，不读取几十 GB 内容。NPK 内部索引只在 profile 明确选择 `scoped` 或带 `explicitCompleteIndexScan=true` 的 `complete` 模式时读取；缓存按路径、大小、mtime 和目标资源 fingerprint 绑定，并支持中断后保留 checkpoint。

工具不写 PVF、客户端、NPK 或 IMG。资源路径 `present` 不证明图层、帧序列、UI、动画或音频运行正确；矩阵也不是实机 PASS。

矩阵仍然不会生成部署计划。若用户另行授权把已经通过受控写出和读回的独立 PVF 安装到某个 profile 测试客户端，改走 [CLIENT-PVF-DEPLOYMENT.zh-CN.md](CLIENT-PVF-DEPLOYMENT.zh-CN.md) 的 `workbench.bat client-pvf` 路线；矩阵结果不能代替该路线的输出与目标哈希核对。
