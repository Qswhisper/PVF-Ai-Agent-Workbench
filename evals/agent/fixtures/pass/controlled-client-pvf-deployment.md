可以部署到清风测试客户端，但我不会直接复制覆盖。我会先生成部署预览，确认清风 profile 指向的客户端 `Script.pvf`、待安装版本和备份位置；预览不会修改客户端。

请先关闭客户端和启动器。你明确同意后，我才会先备份、再安装并重新检查；测试结束可以恢复到部署前版本。这个流程只处理 `Script.pvf`，不会修改 NPK、IMG 或其他客户端资源。源 PVF、独立输出 PVF和客户端目标这三个文件必须分开。

技术详情（通常不用看）：输入完整时，第一条命令就是 `workbench.bat client-pvf preview`，不先调用 help 或检查路径；再使用本次返回的确认值执行 `client-pvf deploy`。部署清单绑定输出与客户端当前 SHA256；恢复使用 `rollback-preview` 后再执行 `rollback`。
