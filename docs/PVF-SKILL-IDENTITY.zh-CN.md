# 当前 PVF 的职业与技能登记身份检查

这些命令从指定 PVF 重新建立登记关系，检查“角色登记 ID → 角色文件中的精确 job token → 技能登记表 → 技能 ID → 技能文件”。不同登记表中的相同数字不是同一技能。检查只读，不生成或安装 PVF，也不替代现有首次定位路由与前后 fingerprint。

## 建立身份图

```bat
workbench.bat pvf-read skill-identity-audit --pvf "D:\TaskInput\Script.pvf" --out "D:\TaskEvidence\identity-graph.json"
```

从 `character/character.lst` 与 `skill/skilllist.lst` 的相同根 ID 建立分支关系，完整读取每个登记的 `.chr`、职业 `.lst` 和 `.skl` 原始字节。角色文件必须有唯一、完整的 `[job]` 字符串字段；保留其精确值，不用别名合并分支。身份图记录源完整 SHA256、文件原始 SHA256、登记行偏移、每行状态与未解决问题。

命令使用独立只读后端读取原始字节。身份路径和 job token 只接受可确认的 ASCII；不根据中文名称猜测身份。脚本必须具有完整 token 结构和有效字符串引用。缺失文件、重复登记 ID、歧义 job 字段、未知格式或超限都不能作为成功。指向相同文件的多个登记 ID 会完整保留，并记录路径别名，不自动推导游戏行为相同。

当前上限为根表各 256 行、单个职业表 50,000 行、总技能登记 100,000 行、单脚本 16 MiB、字符串表 128 MiB。读取前后再次核对源文件身份；发生变化即停止。

## 检查待核验身份

```bat
workbench.bat pvf-read skill-identity-check --pvf "D:\TaskInput\Script.pvf" --claims "D:\TaskEvidence\identity-claims.json" --out "D:\TaskEvidence\identity-check.json"
```

每次检查都重新读取目标 PVF，不把已有身份图当作事实输入。下面仅展示虚构的格式；所有值均须替换为本轮目标取证结果，不是气息候选：

```json
{
  "format": "pvf-skill-identity-claims-v1",
  "sourcePvfSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "claims": [
    {
      "characterId": 100,
      "jobToken": "[example branch]",
      "skillRegistry": "skill/example.lst",
      "skillId": 200,
      "expectedPvfPath": "skill/example/example.skl"
    }
  ]
}
```

输入必须绑定完整源哈希，每条记录的五个身份字段必须完全匹配；路径使用身份图给出的规范路径。未知字段、遗漏字段、重复角色与技能 ID 组合、错误哈希、登记未解决或任一错配均阻止成功。不能把参数列、池分配等额外字段塞入文件后期待它们也得到核验。输入限普通非链接 JSON 文件、2 MiB、1 至 10,000 条记录。

输出必须是工作台和输入所在目录之外的新外部文件，不能覆盖已有文件。身份不匹配时保存失败核验记录并返回非零退出码；格式无效等提前失败可能不产生报告。

## 结果边界

- 基础职业登记不是转职分支、可玩性、可学习性或技能等级上限证明。
- 技能文件完整读取不是技能行为、参数列含义、正向维度或 S/A/B 分类证明。
- 身份图不是气息候选清单；登记行数量不是候选数量。
- 装备合法部位、武器归属、池分配、数值与实机效果必须另行取证。
- 源哈希只标识本轮输入，不能证明它是未修改的原始基线。
- 检查器尚未接入 `pvf-change` 的气息语义门禁。成功结果不授权生成或部署。
- 新一轮不得读取或复用任何旧职业、旧技能、旧参数或旧池资料作为答案；只能从受保护输入重新取证。

## 维护验证

```bat
workbench.bat pvf-read skill-identity-self-test
workbench.bat fallback-self-test
```

专用测试使用虚构内容和真实格式的合成 PVF，覆盖跨分支同 ID、精确 job／登记表／路径错配、源绑定、缺失或歧义登记、截断数据、别名保留、额外字段拒绝和公开 CLI。合成文件及核验记录保存在外部运行目录。
