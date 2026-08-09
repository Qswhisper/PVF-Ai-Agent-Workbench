# PVF Tag 目录维护

`workbench.bat tag-knowledge` 可以在 Workbench 外解析明确授权的社区注释数据库、官方原文目录、工具扩展目录和可选 registry 提示。原始内容、作者、路径、变更记录和翻译缓存不会进入干净知识包。

```bat
workbench.bat tag-knowledge build --community-old "D:\research\community-old\comments.db" --community-new "D:\research\community-new\comments.db" --official-original "D:\research\official-original" --tool-extension "D:\research\tool-extension" --registry-hints "D:\research\registry-hints.xml" --out "D:\research\tag-catalog"
workbench.bat tag-knowledge query --catalog "D:\research\tag-catalog\PVF-TAG-CATALOG.json" --tag duration --exact
workbench.bat tag-knowledge observe-pvf --catalog "D:\research\tag-catalog\PVF-TAG-CATALOG.json" --pvf "D:\target\Script.pvf" --tag duration --out "D:\research\tag-observation"
```

迁入随包紧凑目录时必须显式指定允许的作者成员；作者值只参与本机筛选，不进入输出。先预演，再重建：

```bat
runtime\node\node.exe core\pvf-agent-core\scripts\build-clean-builtin-knowledge.js --only tag --tag-catalog "D:\research\tag-catalog\PVF-TAG-CATALOG.json" --community-author "<authorized-author>" --dry-run
runtime\node\node.exe core\pvf-agent-core\scripts\build-clean-builtin-knowledge.js --only tag --tag-catalog "D:\research\tag-catalog\PVF-TAG-CATALOG.json" --community-author "<authorized-author>"
```

筛选按作者字段中的独立成员精确匹配，不用文件夹名或注释正文猜作者。输出只保留 tag、单行任务摘要和 file type；作者、联系方式、来源路径、维护时间、完整正文、示例块和歌词类无关内容全部丢弃。

目录查询和 PVF 观察只是定位索引。社区解释、官方原文、翻译、工具扩展和 registry 提示必须分层；目标结论仍需读回真实 PVF 文件并按父块上下文解析正确 `.lst`。
