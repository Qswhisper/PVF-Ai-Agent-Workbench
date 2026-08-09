# Release Gate 3：无 PVF 冷启动

入口：

```bat
workbench.bat release gate3
```

先执行 Gate 2，再在独立 stage 中运行：

- `check-env`
- 固定 SHA 的 Node/native runtime 完整性与后端自动选择
- 无真实 PVF 的只读备用后端合成夹具、stdio 接入和写入阻断自检
- `check-knowledge-pack`
- Agent Skill 安装器自检
- Agent eval 自检
- 客户端 PVF 部署/恢复临时夹具自检（错误授权、过期目标、备份去重、部署与恢复）
- `workbench-doctor --skip-profiles --skip-release-gates`
- stage 内再次执行 Gate 1

建议发布前另把 Stage 复制到含中文和空格的独立路径运行一次本门禁，以覆盖 Windows 批处理与路径引用。

本门禁不需要真实 PVF，不创建 profile，也不碰真实客户端。部署/恢复检查只写系统临时目录中的合成 PVF 和假客户端，结束后立即清理。
