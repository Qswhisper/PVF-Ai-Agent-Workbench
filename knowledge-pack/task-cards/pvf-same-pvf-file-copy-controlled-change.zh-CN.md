# 同一 PVF 普通文本文件受控复制

适用场景：目标 PVF 内已有一个可正常读取的普通文本文件，需要以它为模板，在同一 PVF 中生成一个新的同扩展名路径。例如把全局 `monster/monsterapcdifficultybonus.tbl` 复制成副本专用难度表。

## 硬边界

- 只允许 `copy-file` 从当前目标 PVF 的 `sourcePvfPath` 复制到不存在的 `pvfPath`。
- 源、目标扩展名必须完全相同，源路径与目标路径必须不同。
- `.co`、`.lst`、`.nut`、`.sqr`、`.str`、`.wdm` 等受保护高风险类型不能走复制捷径，仍使用各自的专用 `writeProof` 路线。
- 第一轮对新目标只复制完整文件，不在这个新目标路径混入 `replace-text`。同一 change-set 可以精确修改其他既有路径的引用方，例如复制新 `.til` 并同时切换 18 张既有 `.map`；要调整克隆内容本身，才必须以第一轮成功的 `APPLY-MANIFEST.json` 声明 `baseline.applyManifest`，再进行累计第二轮。
- 复制不会自动新增登记表、引用或客户端资源。引用方必须显式列在同一原子方案或后续累计轮中并重新检查。
- 复制/新建 `.map` 或改变地图资源引用时，预演会用最终方案重解析 `.map -> .til -> .img`；同一相对 TIL token 因目标目录变化而命中不同内容时保持阻断。
- 预演会绑定源 PVF、源路径和完整源文本 SHA256，并用临时独立 PVF 写出、独立读回后立即清理。正式生成仍只能写到独立输出，不能覆盖源 PVF。

## 唯一短入口

复制示例只读：

`workspaces/examples/change-set.copy-pvf-file.example.json`

填入明确的 `target.sourcePvf`、`sourcePvfPath` 和不存在的 `pvfPath` 后：

1. 运行 `pvf-change validate --file <change-set.json>`。
2. 只执行返回的 `agentHandoff.nextCommandOnly` 进行预演（检查方案；中文改动会用临时文件验证并立即清理）。
3. 未经用户另行授权，不运行 apply。
4. 获得授权后只按预演返回的 apply 命令生成独立的修改版 PVF，并在生成后重新检查。
5. 若需修改克隆内容，读取 `workspaces/examples/change-set.cumulative-second-round.example.json`，把上一轮成功核验记录写入 `baseline.applyManifest`；不要把第一轮输出冒充新的原始源。

若目的只是让其他文件引用未改动的克隆，不要无意义地拆轮：把 `copy-file` 与其他 `pvfPath` 的精确 `replace-text` 放在同一 change-set。工作台只禁止复制与修改落在同一个新目标路径。

## 数值调整提醒

对克隆表或其他文件把整数改成小数时，选择器必须包含完整标签和原值，例如把 `[attack damage rate]\r\n1` 改为 `[attack damage rate]\r\n0.8`。不要用裸 `1`，因为它通常在同一文件重复出现。

## 仍需实机验证

工作台能证明复制文本一致、目标新建、源 PVF 未变以及独立输出可读；不能静态证明副本引用、怪物血量/防御曲线和客户端显示符合预期。部署前仍需在游戏内进入对应副本验证。
