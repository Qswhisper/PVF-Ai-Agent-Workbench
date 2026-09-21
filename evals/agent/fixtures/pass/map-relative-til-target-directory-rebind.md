不能只检查两个目录都存在同名 TIL。相对路径会按 `.map` 所在目录重新绑定：来源侧是 `map/towerofsighs/tile/prisontile1.til`，目标侧会变成 `map/illusiontower/tile/prisontile1.til`。

预演必须在来源目录和目标目录分别重解析 `.map -> .til -> .img`，比较实际路径、SHA256、IMG 引用和 `[img pos]`。同一相对 token 命中不同内容时，应以 `MAP_RELATIVE_RESOURCE_REBIND_HIGH_RISK` 阻断，不能因为地图能读取就继续生成。即使静态闭合通过，客户端 IMG/NPK 和最终绘制仍需要进图实机验证。
