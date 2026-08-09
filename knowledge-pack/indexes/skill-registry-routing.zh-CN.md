# Skill Registry 路由索引

## 用途

当装备、道具、技能或脚本字段中出现“职业 token + 技能 ID”时，用本索引选择对应的 skill `.lst` 注册表。

## 总规则

- 技能 ID 不能单独解释，必须先确定职业 token。
- 同一个数字在不同职业 skill registry 中可以指向不同技能。
- 职业 token 的空格、方括号和拼写必须按目标 PVF 同类样本确认，不能任意归一化。
- 缺少显式职业 token 时，先结合文件族、装备路径、`[usable job]`、武器类型、触发块和同类样本判断 registry。
- `[common]` 可在技能字段里出现，但它不是独立 skill registry；在 `[skill data up]` 中已观察到 `[common] 174` 对应“基础精通”类公共技能，在 `[skill levelup]` 中已观察到 `[common] 176` 对应“远古记忆”类公共技能，仍需按适用职业分别检查对应 skill registry。
- 本索引只解决“去哪个 registry 查 ID”，不证明字段运行效果。

## 目标 PVF 最短命令

当目标 PVF、职业和技能 ID 都已明确时，第一条 shell 动作直接运行下方命令；不要先对 `workbench.bat` 或目标 PVF 做 `Test-Path` / `Get-Item`：

```bat
workbench.bat pvf-read resolve-skill --pvf "D:\target\Script.pvf" --job swordman --id 97
```

`--job` 可使用目标 `.chr [job]` token；面向新手的常见中文职业名也会通过目标 `.chr` 内容匹配。命令会在目标 PVF 内一次闭合 `character/character.lst -> .chr [job] -> skill/skilllist.lst -> 职业 skill registry -> .skl`，随后只需对返回路径执行一次 `pvf-read read`。命令成功时不再猜目录、枚举 skill 文件、查 bookmark 或试其他职业 registry。

## 职业到 Skill Registry

| 职业 token 线索 | skill registry |
| --- | --- |
| `swordman` | `skill/swordmanskill.lst` |
| `fighter` | `skill/fighterskill.lst` |
| `gunner` | `skill/gunnerskill.lst` |
| `mage` | `skill/mageskill.lst` |
| `priest` | `skill/priestskill.lst` |
| `at gunner` / `atgunner` | `skill/atgunnerskill.lst` |
| `at fighter` / `atfighter` | `skill/atfighterskill.lst` |
| `at mage` / `atmage` | `skill/atmageskill.lst` |
| `thief` | `skill/thiefskill.lst` |
| `demonic swordman` | `skill/demonicswordman.lst` |
| `creator mage` | `skill/creatormage.lst` |

## 常见使用位置

- `[skill levelup]`
- `[skill data up]`
- `[use skill]`
- `[event use skill]`
- `[perform skill]`
- `[end skill]`
- `[required skill]`

## 验证清单

1. 找到字段所在文件族和块结构。
2. 读取职业 token；如果没有职业 token，先读装备路径、`[usable job]` 和同类样本。
3. 已有明确职业与 ID 时使用 `resolve-skill`；否则再按表选择 registry。
4. 读取命令返回的 `.skl`，核对 `[name]`、`[name2]`、`[type]` 等基础信息。
5. 再回到原字段判断字段语义，不要用技能名称倒推字段效果。
