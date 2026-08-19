# 高风险新增文件受控任务卡

状态：默认可用

## 适用范围

本卡只用于新增 `.co`、`.lst`、`.nut`、`.sqr`、`.str`、`.wdm`，以及给既有 `.lst` 增加明确的新登记行。它不授权普通修改既有 `.co/.nut/.sqr/.str`，也不授权客户端资源。

开始前仍须读取安全说明，并从目标 PVF 原始读回约 1–3 个同扩展名、同用途样本。`sourceFile` 放在工作台外的任务目录，`sourceSha256` 绑定该文件；`expectAbsent` 必须为 `true`。

## 新脚本与本地化证明

新 `.co/.nut/.sqr`：

```json
"writeProof": {
  "mode": "script-new-file",
  "compileRequired": true,
  "referencePaths": ["同扩展名/目标样本.nut"]
}
```

这里的 `compileRequired` 表示必须执行适合该类型的结构检查、临时 PVF 写出和独立读回；`.nut/.sqr` 是源脚本时，不宣称已经做完整 Squirrel 字节码编译。

新 `.str`：

```json
"pvfEncoding": "Cn",
"writeProof": {
  "mode": "localization-new-file",
  "pvfEncoding": "Cn",
  "encodingRoundTripRequired": true,
  "referencePaths": ["同用途/目标样本.str"]
}
```

`Cn/Tw` 必须来自目标样本，两个位置保持一致；任一字符不能无损往返即停止。

## Registry 生命周期

新增完整 `.lst`：

```json
"writeProof": {
  "mode": "registry-lifecycle",
  "registry": {
    "lstPath": "目标/新登记表.lst",
    "action": "verify"
  }
}
```

工作台会检查每个非注释行的数字 ID、反引号路径、重复项和目标文件存在性。

给既有 `.lst` 增加一行使用普通 `replace-text`，但只开放纯新增行：

```json
"writeProof": {
  "mode": "registry-lifecycle",
  "allowExistingRegistryEdit": true,
  "registry": {
    "lstPath": "目标/登记表.lst",
    "id": 123,
    "expectedPvfPath": "目标/新增文件.ext",
    "action": "add"
  }
}
```

删除证明行后，最终 registry 必须与原文逐字一致；旧行修改、重排、额外新增、注释或空白顺带变化都会停止。

## 新 worldmap 原子证明

新 `.wdm` 必须与 `worldmap/worldmap.lst` 新行、`.wdm [ui path]` 指向的 UI、dungeon 登记、已登记 town gate、已登记 region 及同一个 town ID 一起预演：

```json
"writeProof": {
  "mode": "worldmap-lifecycle",
  "registry": {
    "lstPath": "worldmap/worldmap.lst",
    "id": 123,
    "expectedPvfPath": "worldmap/AgentPage.wdm",
    "action": "add"
  },
  "pairedEntries": [
    { "kind": "ui", "pvfPath": "worldmap/UI/AgentPage.ui" },
    { "kind": "town-gate", "pvfPath": "town/AgentTown.twn", "worldmapId": 123 },
    { "kind": "region-town", "pvfPath": "region/agent.rgn", "townId": 45 }
  ]
}
```

town 文件必须由最终 `town/town.lst` 解析为这里的 `townId`，region 文件必须由最终 `region/region.lst` 登记且在 `[towns]` 中包含同一 ID。UI 中每个目标 dungeon 必须有对应 `IDC_WORLDMAP_BUTTON*`，每个 dungeon ID 必须由最终 `dungeon/dungeon.lst` 解析且目标文件存在。

## 固定流程

1. 对所有已知目标路径一次 `pvf-read read-batch --raw`；登记路径按 registry 路由先确认。
2. 在工作台外创建源片段和一个原子 change-set，同路径改动不拆包。
3. `pvf-change validate --file ...`，只执行返回的 `agentHandoff.nextCommandOnly`。
4. 预演（检查方案；中文改动会用临时文件验证并立即清理）。任一格式、冲突、引用、结构、编码或独立读回失败时无许可。
5. 获得明确授权后生成独立的修改版 PVF，生成后重新检查；不得覆盖源 PVF。
6. 静态核验记录不等于客户端或游戏内成功。所有文字做客户端显示检查，worldmap 做页面、按钮、进图及返回路径实机检查。
