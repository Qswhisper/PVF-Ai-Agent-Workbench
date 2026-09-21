# 明确指定的独立文字修改

用途：用户已明确要修改某个字段的完整独立文字，但标签尚未收录为显示字段。无需为每个魔改标签新增白名单。只证明原始文字 token 的精确替换与其他数据保全，不宣称该字段一定显示给玩家，也不宣称运行语义已验证。

目标已是明确的内部文件路径且不要求登记解析时，首命令直接使用：

```bat
.\workbench.bat pvf-read read --pvf "<source.pvf>" --path "<internal/path>" --raw
```

用户要求源文件身份不变时，下一条命令是 `.\workbench.bat pvf-read fingerprint --pvf "<source.pvf>"`；最终读回后重复同一条。不要为这两个固定命令扫描知识包或其他报告。

1. 按实体名称/ID 路线确认目标，原始读取目标文件。先确认用户的意图确实是这个字段；不要因普通模式失败而自动转换结构记录、路径或枚举的用途。
2. 字段必须是一个真实标签后紧接的完整反引号文字 token，独占行（文字内部可多行），后面是下一个标签或文件结束。多个值、StringLink、活动列表、称号簿特殊容器、任务进度和塔对话继续使用对应结构路线。数字字段无需此模式。
3. 使用工作台 workspaces/examples/change-set.scalar-text.example.json。textWriteMode 为 verified-scalar-text，pvfEncoding 填 --raw 选中的 Cn/Tw；previousText/newText 都是完整 token。保留原占位符数量与顺序。重复文字用精确相邻上下文或 scope 和正整数 expectedOccurrences。
4. validate 后跟随 agentHandoff 完成预演（检查方案；中文改动会用临时文件验证并立即清理）、生成独立的修改版 PVF、生成后重新检查。所有旧字符串表条目和非目标原始 token 必须保持，字符必须无损编码；文本资格、模式和最终文件哈希绑定核验记录。
5. 可用类型与普通内联文字相同；既有 CO/LST/NUT/SQR/STR 和 ANI 不因采用此模式而开放。原字段为英文或空白时，需同文件已有中文证明编码；不能用此模式绕过编码失败。
6. 交付明确说明“独立文字替换已核验，字段运行含义及客户端显示待验证”。游戏验证不可用不妨碍生成独立测试版，但不能宣称游戏通过或直接部署。
