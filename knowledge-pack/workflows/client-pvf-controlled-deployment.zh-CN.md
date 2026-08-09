# 测试客户端 Script.pvf 受控部署

状态：默认可用

用途：把已通过受控写出和读回检查的独立输出 PVF，部署到本机 profile 指定的测试客户端，并保留可验证的恢复点。

## 路线

1. 先确认用户明确要求部署到哪个测试客户端；普通 PVF 输出授权不自动包含客户端部署。
2. 使用 `workbench.bat client-pvf preview --profile <name> --apply-manifest <file>`。不要手工复制或直接覆盖客户端文件。
3. 用通俗语言说明：目标客户端、是否可部署、备份位置、需要关闭客户端和启动器。
4. 只有用户明确确认后，才使用预览返回的确认码执行 `client-pvf deploy`，并带 `--confirm-client-closed`。
5. 部署成功后报告客户端目标、部署前后 SHA256、备份和 manifest；不要把“文件部署成功”说成“实机功能通过”。
6. 需要恢复时，先执行 `rollback-preview`，再次获得用户确认后才执行 `rollback`。

## 阻断条件

- `APPLY-MANIFEST.json` 未绑定最终输出 PVF 的完整 SHA256或读回失败。
- source PVF、独立输出 PVF与客户端 `Script.pvf` 不是三个不同文件。
- profile 未启用、没有客户端目录，或目标不是客户端根目录的 `Script.pvf`。
- profile 的 `sourcePvf` 与 apply 清单不一致，源 PVF 生成输出后发生变化，或预览后输出 PVF、客户端当前 PVF、profile、manifest 发生变化。
- 用户没有确认客户端和启动器已关闭。
- 备份缺失、哈希不符，或恢复时客户端已变成未知版本。

本路线不授权 NPK、IMG、UI 或其他客户端资源写入。
