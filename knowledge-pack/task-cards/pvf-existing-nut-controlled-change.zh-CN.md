# 既有 NUT 专用受控修改任务卡

状态：默认可用

## 适用范围

本卡只用于目标 PVF 中已经存在、位于 `sqr/` 下、且由 `load_state -> passive_skill -> appendage` 链加载，或符合下方显式 `direct-character-state` / `direct-character-skill-use` 登记路线或下方 `direct-character-skill-proc` 证据路线的 `.nut`。它解决的是少量运行时逻辑需要修改、普通高风险保护又不应整体解除的场景。

默认保护没有取消：没有专用证明的既有 `.nut` 仍停止；既有 `.co/.sqr/.str` 仍停止；中文等文字、StringLink 显示文本、客户端资源和覆盖源 PVF 不在本路线权限内。

## 开始前

1. 对目标 NUT、load_state 和每个 API 目标证据脚本做一次 `pvf-read read-batch --raw`；默认 appendage 路线还须读 passive 入口；直接状态使用下方同职业 pushState 登记，skill-use 使用下方同职业 common 文件登记及既有前后回调。返回的 `textUsage.rawTextBindings[].sourceTextSha256` 可填写目标 NUT 原文哈希；若 `complete=false`，先扩大读取上限，不能使用截断文本。
2. 每个 API/常量先用一次 `knowledge-query nut --name <symbol> --group dnf --exact`，再用一次目标 `pvf-read search-script --keyword <symbol>`；只把实际读回并含精确符号的目标脚本写进 `targetEvidencePaths`。
3. 改动内容必须只包含数字、英文和常见符号，以及 Tab/CR/LF。中文等文字继续走各自安全路线，不能混进 NUT 证明。

目标 NUT 即使含有在 Cn/Tw 下显示为 Unicode 替代字符（U+FFFD）的既有旧注释字节，也不需要先重写或清洗整份文件。工作台会把完整原文与原始字节绑定，只替换已经精确定位的 ASCII 字节区间；指定区间外的原始字节必须逐段完全一致。替换原文或新内容触及中文等文字、字节位置不唯一或任一保留区间不一致时仍会停止。

## writeProof

同一 `.nut` 的每条 `replace-text` 必须复制完全相同的证明：

```json
"writeProof": {
  "mode": "existing-nut-controlled-edit",
  "sourceTextSha256": "从完整 --raw 读回取得的 64 位 SHA256",
  "structureCheckRequired": true,
  "temporaryRoundTripRequired": true,
  "runtimeValidationRequired": true,
  "loadChain": [
    {
      "fromPvfPath": "sqr/character/job_load_state.nut",
      "toPvfPath": "sqr/character/job/passive_skill_job.nut",
      "requiredText": "从 load_state 原始读回复制、且把下一路径作为函数调用参数的完整 ASCII 片段"
    },
    {
      "fromPvfPath": "sqr/character/job/passive_skill_job.nut",
      "toPvfPath": "sqr/character/job/appendage/ap_job_fixture.nut",
      "requiredText": "从 passive 原始读回复制、且把目标 appendage 路径作为函数调用参数的完整 ASCII 片段"
    }
  ],
  "touchedFunctions": ["实际新增或修改的函数名"],
  "apiSymbols": [
    {
      "name": "sq_ExampleApi",
      "kind": "function",
      "targetEvidencePaths": ["sqr/目标版本内实际含该符号的样本.nut"]
    }
  ],
  "apidPlan": {
    "namespace": "稳定的任务用途名",
    "ids": [9901],
    "conflictSearchRequired": true
  }
}
```

本轮不新增 APID 时明确写 `"ids": []`。新增 APID 时，工作台会搜索目标 PVF 的整个 `sqr/`，任何精确数字冲突、搜索截断/错误或同一原子 change-set 内重复声明都会停止。

## 工作台会检查

- `sourceTextSha256` 与目标 NUT 的完整原始文本一致。
- 默认 appendage 路线的 load chain 连续、从 `*_load_state.nut` 开始、包含 `passive_skill_*.nut`，并以目标 NUT 结束；每段精确引用都存在于目标 PVF 的执行代码中，目标路径必须是函数调用参数。注释、与调用无关的孤立字符串或“先写无关可执行代码、再把路径藏到行尾注释”的片段都不算加载证据。
- 最终脚本的引号、注释、括号和函数体闭合；既有函数不能删除，未声明函数不能改动，非函数顶层代码不能改变。
- 每个 `apiSymbols` 都有大小写精确的内置 DNF 声明、目标 PVF 既有执行代码证据，并在最终目标脚本中实际使用；函数名只作为变量、函数定义、注释或字符串出现都不算调用。
- 每个 APID 在目标源脚本中无冲突、在最终脚本中作为已声明 DNF API 调用的独立整数参数实际出现，并在同一原子 change-set 内唯一；注释、字符串、`APID_9901` 之类标识符片段或与 API 无关的闲置数字不算 APID 使用或冲突。
- 不重新编码整份 NUT；每项替换都把已定位文字位置映射到唯一原始 ASCII 字节区间，并核对所有非目标字节的逐段 SHA256。源文件中已经存在的不可还原 Cn/Tw 旧字节会原样保留。
- 预演期间生成临时独立 PVF，重新打开后由 TypeScript 解析器独立读回，既核对完整最终 token，也核对目标 NUT 原始字节 SHA256；临时文件立即清理，源 PVF SHA256 不变。
- 正式生成重新执行以上静态审计，并绑定预演核验记录、确认码、内容寻址源备份、独立输出和最终文本/原始字节读回。

## 固定流程

1. 使用 `workspaces/examples/change-set.existing-nut-controlled.example.json` 作为字段形状参考；替换其中全部占位内容，不照抄路径、哈希、函数或 APID。
2. 运行 `pvf-change validate --file ...`，随后只执行返回的 `agentHandoff.nextCommandOnly`。
3. 预演（检查方案；中文改动会用临时文件验证并立即清理）。本路线本身不允许中文，但仍沿用同一安全表述和核验记录。
4. 预演无阻断且用户明确授权后，生成独立的修改版 PVF；不得覆盖源 PVF。
5. 生成后重新检查目标 NUT、源 PVF SHA256、受保护备份和输出 SHA256。
6. 必须做实机异常状态、持续时间、刷新/叠加、普通受击与边界回归。静态检查通过不等于行为正确，核验记录会持续标明 `runtimeValidationRequired=true`。

## 显式直接技能状态登记

状态：需验证。使用同一`existing-nut-controlled-edit`写入器，但明确填写`loadChainKind: "direct-character-state"`。不填时仍是原appendage路线，不能自动降级到宽松检查。

仅接受恰好一段加载证明：`sqr/character/<job>_load_state.nut`中完整的`IRDSQRCharacter.pushState(ENUM_CHARACTERJOB_..., "Character/<job>/...nut", "CallbackSuffix", STATE_..., SKILL_...);`。路径必须为直接字符串且等于编辑目标，职业枚举（忽略分词下划线）必须与加载文件和目标职业目录相符。登记必须在源文件中唯一、位于顶层、是独立语句；注释、字符串、函数体、条件体、动态变量、路径穿越、错误职业和任意同名加载器均停止。requiredText可跨行，但不可省略参数或附加无关前缀。

只编辑以`_<CallbackSuffix>`结尾的声明函数。其余原始文本SHA256、ASCII字节范围、目标API/APID、临时独立PVF往返、最终原始字节读回和实机要求全部不变。加载脚本只作证据，不在本路线中改写。`pushPassiveObj`、变量路径和一般脚本加载不在本次扩展内；被动对象消费者尚不能借技能状态身份取得写入权限。

这条路线只证明可受控修改已有状态脚本，不证明气息层叠加与费用等行为正确；不能把截断最终技能值当作仅截断气息贡献。操作具体技能参数前仍须核对角色分支和对应技能登记，保留其他装备与零气息行为。

## 显式技能使用公共回调

状态：需验证。`loadChainKind: "direct-character-skill-use"`仅接受一段：同职业`sqr/character/<job>_load_state.nut`顶层唯一独立语句`IRDSQRCharacter.pushScriptFiles("Character/<job>/<job>_common.nut");`。路径必须完整字面量，目录和common文件职业一致；拒绝一般脚本、动态路径、注释、条件、函数内登记及重复登记。

只允许修改目标原文中已经存在的`useSkill_before_<job>`和`useSkill_after_<job>`函数，大小写职业归属一致；不得新增回调或修改其他函数。未显式选择时不改变原路线。按“开始前”读取common目标、加载器和API证据原文，其他源哈希、ASCII目标字节、非目标字节保持、API/APID、临时与最终独立读回要求全部保留；静态通过不证明费用和回退实际生效。该路线不开放其他公共回调、任意pushScriptFiles目标或被动对象脚本。

既有同名空函数的保留仅适用于 direct-character-skill-use 和 direct-character-skill-proc：原文件已存在、所有重复函数体只含空白、全部声明文本逐个相同、数量及全文件函数顺序不变，而且不得列为修改函数。新增、删除、改动任何一个重复声明，或重复体含代码/注释，仍阻断。此例外只允许原样保留；原始字节保全与独立读回要求不变。

## 显式技能公共 proc 调用

状态：需实机验证。明确填写 `loadChainKind: "direct-character-skill-proc"`，只允许修改一个已经存在的 `procSkill_<技能登记后缀>` 函数。目标仍须是同职业 canonical common 文件，`loadChain` 只放该文件的唯一顶层 `pushScriptFiles` 登记。不会自动开放其他公共函数、被动对象或一般加载脚本。

除通用 writeProof 外，增加以下 `skillProc` 字段；所有路径、语句和编号来自目标原文，不可照抄示意职业：

```json
"skillProc": {
  "dispatcher": "procSkill_Job",
  "requiredCall": "procSkill_Skill(obj);",
  "stateRegistration": {
    "fromPvfPath": "sqr/character/job_load_state.nut",
    "toPvfPath": "sqr/character/job/skill/skill.nut",
    "requiredText": "IRDSQRCharacter.pushState(ENUM_CHARACTERJOB_JOB, \"Character/Job/skill/skill.nut\", \"Skill\", STATE_SKILL, SKILL_SKILL);"
  },
  "headerRegistration": {
    "fromPvfPath": "sqr/character/job_load_state.nut",
    "toPvfPath": "sqr/character/job/job_header.nut",
    "requiredText": "IRDSQRCharacter.pushScriptFiles(\"Character/Job/job_header.nut\");"
  },
  "skillId": 7,
  "skillRegistryPath": "skill/jobskill.lst",
  "skillPvfPath": "skill/job/skill.skl"
}
```

开始前批量读取 common、加载器、对应头文件、技能登记表、登记后的技能及状态脚本原文。职业目录、加载器、枚举和登记表必须相符；header 和 state 均须唯一顶层直接登记。头文件中技能符号只能出现一次，必须直接赋予该整数 ID；登记表必须把该 ID 唯一解析到声明的 `.skl`，同时读回技能和对应状态回调。

common 中原有 `procSkill_<job>(obj)` 与目标 callee 均只能有一个声明。调度函数体只接受一系列无条件、独立的 `procSkill_*(obj);` 调用，其中声明的 callee 恰好一次；条件、提前返回、赋值、注释中的调用等均不能作为证明。目标 callee 的既有代码还须以登记的技能符号调用 `sq_GetLevelData`、`sq_GetIntData` 或 `sq_GetSkillLevel`。只允许改该 callee；调度函数、加载器、头文件、登记表和状态证据不得同轮修改。技能数值可以同轮原子修改，技能身份仍由既有登记闭合。

仍使用原来的完整文本 SHA256、唯一 ASCII 原始字节定位、非目标字节保全、函数/API/APID、临时独立 PVF 往返、最终文本及字节读回。错误职业、函数、编号、缺失调用链或证据文件变化仍停止。静态通过不证明 MP 下限、触发周期和叠加上限正确，需按实际改动实机验证。
