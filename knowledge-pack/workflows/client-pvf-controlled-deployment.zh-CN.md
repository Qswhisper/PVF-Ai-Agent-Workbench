# 测试客户端 Script.pvf 受控部署

状态：默认可用

用途：把已通过受控写出和读回检查的独立输出 PVF，部署到本机 profile 指定的测试客户端，并保留可验证的恢复点。

## 路线

若用户明确要求跨对话“先备份再自动覆盖”，执行一次 `client-pvf preference --profile <name> --enable --authorize-persistent-deploy`。之后 `pvf-change apply` 自动触发匹配客户端的部署，读取输出中的 `automaticDeployment`。此持续授权代替下面第4步的重复询问；程序自动检查客户端/启动器，失败时保留独立成品。备份在客户端 `PVF-Backups/<旧版本SHA256>/sha256/`，每个不同版本单独目录，重复版本校验后复用。真实路径、备份、累计链、输出绑定和关闭进程检查仍全部执行。不得自动确认基线切换。

查看：`client-pvf preference --profile <name>`。撤销：同命令加 `--disable`。补做被阻断的部署：`client-pvf auto-deploy --profile <name> --apply-manifest <file>`。只有明确要求保存授权时才可启用，不根据“有备份”自行推断授权。

1. 先确认用户明确要求部署到哪个测试客户端；普通 PVF 输出授权不自动包含客户端部署。
2. 使用 `workbench.bat client-pvf preview --profile <name> --apply-manifest <file>`。预览先核对客户端当前版本是否等于本轮生成的输入版本；若命中更早的累计祖先，则逐级核对完整线性清单链后允许直接快进最终输出。若最初来源就是该客户端，工作台会核对 apply 已生成的内容寻址备份并把它作为受保护锚点；不要手工复制或直接覆盖客户端文件。
3. 用通俗语言说明：目标客户端、是否可部署、备份位置、需要关闭客户端和启动器。
4. 只有用户明确确认后，才使用预览返回的确认码执行 `client-pvf deploy`，并带 `--confirm-client-closed`。
5. 部署成功后报告客户端目标、部署前后 SHA256、备份和 manifest；不要把“文件部署成功”说成“实机功能通过”。
6. 需要恢复时，先执行 `rollback-preview`，再次获得用户确认后才执行 `rollback`。

## 阻断条件

- `APPLY-MANIFEST.json` 未绑定最终输出 PVF 的完整 SHA256或读回失败。
- 受保护锚点、独立候选输出与客户端 `Script.pvf` 仍发生碰撞。最初来源可以与客户端相同，但缺少 SHA256 已核对的内容寻址备份时必须停止。多轮累积时，本轮只读输入可以是客户端里已部署的上一轮版本；预览会用哈希确认它确实一致。
- profile 未启用、没有客户端目录，或目标不是客户端根目录的 `Script.pvf`。
- profile 的 `sourcePvf` 与 apply 清单记录的最初来源/受保护锚点均不一致，非客户端输入 PVF 生成输出后发生变化，或预览后输出 PVF、客户端当前 PVF、profile、manifest 发生变化。
- 客户端当前 SHA256 既不是本轮输入、已经部署的候选输出，也不是完整核验清单链中的祖先。祖先快进要求每个 `previousApplyManifest` 文件与 SHA256、相邻输入/输出 SHA256、受保护源锚点/来源和 chainDepth 全部闭合；缺失、漂移、循环或客户端不在链上均不能冒充快进。只有用户明确要求放弃当前修改链并切换分支时，才可在预览中单独确认基线切换。
- 用户没有确认客户端和启动器已关闭。
- 备份缺失、哈希不符，或恢复时客户端已变成未知版本。

本路线不授权 NPK、IMG、UI 或其他客户端资源写入。
