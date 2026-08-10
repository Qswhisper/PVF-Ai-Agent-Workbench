# cli

PVF 命令行入口。

```bat
workbench.bat profile status
workbench.bat profile init --name main-local --workspace "D:\MyDNFWork" --source-pvf "D:\MyDNFWork\Script.pvf" --output "D:\MyDNFWork\pvf-lab" --set-active
workbench.bat pvf-read list-files --pvf "D:\MyDNFWork\Script.pvf" --prefix itemshop --limit 20
workbench.bat pvf-read read --pvf "D:\MyDNFWork\Script.pvf" --path itemshop/itemshop.lst --max-chars 2000
workbench.bat pvf-read resolve-lst --pvf "D:\MyDNFWork\Script.pvf" --lst itemshop/itemshop.lst --id 1
workbench.bat pvf-index build --pvf "D:\MyDNFWork\Script.pvf" --scope itemshop --prefix itemshop --limit 1000
workbench.bat pvf-change dry-run --file workspaces\examples\change-set.replace-text.example.json --pvf "D:\MyDNFWork\Script.pvf"
workbench.bat absorb new --id KV-XX --title "Runtime validation" --domain itemshop --status PASS
```
