不需要手工切换后端，也不用每次全包重查。Workbench 会自动做 `Cn` 语义保护；已有索引按完整 PVF SHA 绑定，普通检查复用缓存和快速 freshness 检查。

数字或 ASCII 最小修改可以继续走受控 change-set、dry-run、独立输出、备份和读回。`Cn .str` 与直接非 ASCII 文本写入当前会被自动阻断，不能顺便直接改中文。因为目标文件含中文或 StringLink，输出后仍要做客户端 UI 文本 smoke check，确认名称、说明和副本文本没有乱码。
