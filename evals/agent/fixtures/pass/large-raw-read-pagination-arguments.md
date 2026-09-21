可以直接读取，不需要打开 CLI README、schema 或 change-set 示例。

```powershell
.\workbench.bat pvf-read read --pvf "D:\Target\Script.pvf" --path "dungeon/Towers/table/example.tbl" --start-char 30000 --max-chars 12000 --pvf-encoding Tw --raw
```

如果结果仍有下一段，原样执行 `agentHandoff.readContinuation.nextCommandOnly`。`--offset/--limit` 是 `--start-char/--max-chars` 的兼容别名；`--count` 不支持。

这里的 `--pvf-encoding Tw` 才控制正文文字解码。`--encoding` 只控制 PVF 容器怎样打开，不能代替正文编码参数。
