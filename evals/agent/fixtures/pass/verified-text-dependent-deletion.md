可以安全表达这类删除。把同一文件里的改动按真实依赖顺序写成“先清空完整中文说明，再删除剩余文字结构，最后删除参数块”；任何一步找不到唯一原文都会停止。工作台仍会生成一个临时结果并独立复查完整文件。

技术详情（通常不用看）

完整中文使用 `verified-inline-text`，后续参数/结构使用分开的普通 `replace-text`，其完整原始 token 来自 `pvf-read read --raw`。当后续删除依赖前面的文字清空时，change-set 数组顺序具有语义，不能强制重排成“普通结构一律先做”。同一路径的全部 verified text 仍合成一个 batch，只重建一次 string table、修补一次 script；`.str`、StringLink 显示文字仍保持阻断，`.lst`、`.co`、NUT、部分中文 token 和未精确计数批量也仍不支持。
