# PVF-Agent-Workbench

这是一个给桌面 AI Agent 使用的 DNF PVF 便携工作台，已包含运行环境、PVF 工具、知识路由和安全规则。

## 第一次使用

1. 在工作台根目录运行 `workbench.bat check`。
2. 用 Agent 打开整个工作台目录。
3. 对 Agent 说：

```text
请先加载 dnf-pvf-xpilot Skill，读取 AGENTS.md，并按工作台规则帮助我处理 PVF。
```

4. 提供目标 `Script.pvf`、想处理的内容、是否允许生成新 PVF，以及能否进游戏测试。

不会代码也没关系。第一次建议先让 Agent 做只读分析。

## 工作方式

- 普通任务统一通过 `workbench.bat` 执行。
- 名称、数字 ID、字段和跨文件引用会先在目标 PVF 中核对。
- 写出前先做预演（检查方案；中文改动会用临时文件验证并立即清理）。
- 获得明确同意后生成独立的修改版 PVF，创建或复用已核对的源版本备份，并在生成后重新检查。
- 多轮修改显式继承上一轮结果；客户端部署是另一项单独授权。
- 中文等文字、既有 NUT、新文件和登记表等高风险内容只走对应的受控路线。
- 技能 `.skl` 的已知可见文字标签及其 ` ex` 备用变体（如 `[explain ex]`、`[basic explain ex]`）可按完整文字 token 验证。用户明确指定的未知标签独立文字也有专用路线，但其游戏含义和显示效果仍需确认。
- 强化/增幅等级表按原始分组、显式单元格与稀有度做结构化预演和独立回读，保留未修改的原始行，锻造表保持隔离。

## 随包内容

- 固定 Node.js、native PVF 后端和 TypeScript 只读备用后端；
- PVF 字段、NUT、标签和常用任务知识；
- 只读查询、索引、受控修改、依赖分析和发布检查工具；
- 项目级 `dnf-pvf-xpilot` Agent Skill。

native 后端缺少兼容的 VC++ 运行库时，工作台仍可读取，但会阻止所有 PVF 写入。`workbench.bat check` 会说明原因。

详细规则由 Agent 按需读取 [AGENTS.md](AGENTS.md) 和 `knowledge-pack/`。测试客户端安装与恢复见 [docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md](docs/CLIENT-PVF-DEPLOYMENT.zh-CN.md)，复制到新电脑前见 [docs/CLEAN-COPY.zh-CN.md](docs/CLEAN-COPY.zh-CN.md)，版本变化见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)。
