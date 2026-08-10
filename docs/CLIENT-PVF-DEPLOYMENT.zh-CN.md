# 测试客户端 PVF 部署与恢复

这个功能把工作台已经生成并复查过的输出 PVF，安装到本机 profile 指定的测试客户端。它只处理客户端根目录的 `Script.pvf`，不处理 NPK、IMG、UI 或其他客户端文件。

## 新手怎么用

平时只要告诉 Agent：

> 把刚生成的 PVF 部署到清风测试客户端。

Agent 应先给出一份部署预览。预览会说明目标客户端、当前版本、待安装版本和备份位置，但不会修改客户端。关闭客户端和启动器并明确同意后，Agent 才能继续。

测试结束后可以说：

> 把清风客户端恢复到部署前版本。

恢复同样会先预览，再等待明确确认。

## 前置条件

- 本机 profile 已填写 `client` 目录；三个客户端应使用三个独立 profile。
- `sourcePvf` 必须是受保护的独立源文件，不能同时是客户端中的 `Script.pvf`；profile 的源文件必须与 apply 清单一致，且生成输出后没有变化。
- 待部署 PVF 必须来自成功的 `pvf-change apply`。
- 对应 `APPLY-MANIFEST.json` 必须记录输出 PVF 的完整 SHA256、成功读回和源文件未覆盖。
- 客户端与启动器均已关闭。

## 命令

```bat
workbench.bat client-pvf preview --profile <profile> --apply-manifest "<APPLY-MANIFEST.json>"
workbench.bat client-pvf deploy --preview-manifest "<CLIENT-PVF-DEPLOY-PREVIEW.json>" --authorize-deploy <code> --confirm-client-closed
workbench.bat client-pvf rollback-preview --deployment-manifest "<CLIENT-PVF-DEPLOYMENT-MANIFEST.json>"
workbench.bat client-pvf rollback --preview-manifest "<CLIENT-PVF-ROLLBACK-PREVIEW.json>" --authorize-rollback <code> --confirm-client-closed
```

普通用户不需要手工拼这些参数，Agent 会读取命令返回值并执行下一步。

## 安全行为

- 预览绑定待安装 PVF、目标客户端和客户端当前 PVF；其中任一文件变化后，旧确认码立即失效。
- 部署前把客户端当前 PVF 保存到 profile 的输出目录。相同 SHA256 的版本只存一份，避免重复占用空间。
- 新 PVF 先复制到客户端同目录的临时文件并核对，再进行替换；替换失败时会尝试立即恢复原文件。
- 部署后再次计算客户端 PVF 的 SHA256；核对失败不会报告成功。
- 恢复只接受对应部署前的精确备份。如果客户端在部署后又被其他程序修改，恢复会停止，避免覆盖未知版本。
- 源 PVF 和独立输出 PVF 始终保持不变。

## 实机验证

部署成功只证明文件安装正确，不证明游戏行为正确。仍需进游戏检查目标功能。触及含中文或 StringLink 的文本文件时，还要检查名称、说明和界面文字是否乱码。

完成实机验证后，可用 `workbench.bat absorb new` 创建本地吸收清单。
