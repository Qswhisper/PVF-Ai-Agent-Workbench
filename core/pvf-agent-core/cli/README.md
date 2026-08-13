# cli

PVF 命令行入口。

```bat
workbench.bat profile status
workbench.bat profile init --name main-local --workspace "D:\MyDNFWork" --source-pvf "D:\MyDNFWork\Script.pvf" --output "D:\MyDNFWork\pvf-lab" --set-active
workbench.bat pvf-read list-files --pvf "D:\MyDNFWork\Script.pvf" --prefix itemshop --limit 20
workbench.bat pvf-read read --pvf "D:\MyDNFWork\Script.pvf" --path itemshop/itemshop.lst --max-chars 2000
rem 普通 read 是便于阅读的显示结果，不可复制为修改原文；准备 change-set 时对同一路径加 --raw，并采用返回的实际编码
workbench.bat pvf-read read --pvf "D:\MyDNFWork\Script.pvf" --path itemshop/test.shp --pvf-encoding Tw --raw --max-chars 30000
workbench.bat pvf-read resolve-lst --pvf "D:\MyDNFWork\Script.pvf" --lst itemshop/itemshop.lst --id 1
workbench.bat pvf-index build --pvf "D:\MyDNFWork\Script.pvf" --scope itemshop --prefix itemshop --limit 1000
rem 同一路径的多项中文与参数改动放在同一个 changes 数组；validate 会返回机器可读的下一步和禁止绕路提示
workbench.bat pvf-change validate --file workspaces\examples\change-set.verified-cn-text.example.json
workbench.bat pvf-change dry-run --file "D:\MyDNFWork\changes\round-1.json" --pvf "D:\MyDNFWork\Script.pvf" --out "D:\MyDNFWork\pvf-lab\round-1-preview"
rem 从上一条 JSON 输出中复制 manifestPath 和 approvalCode；下面的 --out 是独立成品目录
workbench.bat pvf-change apply --file "D:\MyDNFWork\changes\round-1.json" --pvf "D:\MyDNFWork\Script.pvf" --dry-run-manifest "D:\MyDNFWork\pvf-lab\round-1-preview\DRY-RUN-MANIFEST.json" --authorize-apply <approvalCode> --out "D:\MyDNFWork\pvf-lab\round-1-output"
rem 生成后会自动重新检查；需要人工复核具体字段时，再对 APPLY-MANIFEST.json 返回的 outputPvf 执行 pvf-read read --raw
workbench.bat absorb new --id KV-XX --title "Runtime validation" --domain itemshop --status PASS
```

被阻止的预演会同时把命令输出和核验记录内部的 `approvalCode` 置空，并标记 `authorizationWithheld=true`；不要从绑定哈希推算或尝试正式生成。

直接给出 `--pvf` 时不需要先检查或创建 profile。本机 profile 写入工作台外的 `PVF-Agent-Workbench-State/profiles/<workbench-id>/`。

下一轮只写本轮差异时，change-set 保持 `target.sourcePvf` 为最初受保护源，并增加：

```json
"baseline": {
  "applyManifest": "D:\\pvf-lab\\previous\\APPLY-MANIFEST.json"
}
```

然后仍执行上面的 `dry-run` 与 `apply`。预演时优先按 `validate.agentHandoff.nextCommandOnly` 原样执行，不要自行补一个指向最初源的 `--pvf`。可以省略第二轮命令中的 `--pvf`；若显式填写，它必须是上一轮 `APPLY-MANIFEST.json` 记录的 `outputPvf`，不能再填最初源 PVF。
完整第二轮格式见 `workspaces\examples\change-set.cumulative-second-round.example.json`。不要把上一轮输出直接写成新的 `target.sourcePvf`，也不要把同一文件的多项改动拆成多个临时“新源”。

同文件若必须先把完整中文清空、再删除其所在结构，请把安全文字变化写在前、只含数字/英文/常见符号的结构删除写在后。工作台会保留这条依赖顺序，同时仍把该文件的全部安全文字合为一批验证。可直接参考 `workspaces\examples\change-set.verified-cn-text.example.json` 末尾的三步删除链，不需要阅读执行器或自测源码来猜格式。

普通 `read`/`read-batch` 返回 `textUsage.safeForChangeSetSource=false`，因为中文可能已转成简体，换行与 Tab 也可能只是阅读布局。`--raw` 才返回修改校验使用的规范 token；未显式填写 `--pvf-encoding` 时，工作台会只读比较 Cn/Tw 并选择明显更干净的一种，在 `textUsage.automaticEncodingSelection` 中公开结果。若两种都不明显更好则保持声明/默认编码，不猜字、不混合写入。若预演零命中同时返回 `DISPLAY_TEXT_USED_AS_CHANGE_SOURCE` 或 `CHANGE_TEXT_ENCODING_MISMATCH`，按其中的路径和编码重新 `--raw` 读取并重建 change-set；工作台不会自动改繁简或跨编码写入。
