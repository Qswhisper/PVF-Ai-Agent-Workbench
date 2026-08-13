本机配置不会再跟着工作台目录一起被刷新掉：profile 保存在工作台外的用户状态目录。旧版目录内的配置首次使用时会复制过去，原文件不会自动删除；不会跨盘搜索或擅自恢复别的备份。

技术详情（通常不用看）

新位置是 `PVF-Agent-Workbench-State/profiles/<workbench-id>/workspace-profiles.local.json`。同一路径更新工作台后会继续读取该文件；迁移采用原子写入，旧 `config/workspace-profiles.local.json` 只作为迁移来源并保持不变。复制到另一台电脑或不同工作台路径时仍应重新运行 `workbench.bat profile init`，避免把机器路径错误复用。
