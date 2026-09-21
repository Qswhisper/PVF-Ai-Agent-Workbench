# 原始区块边界与范围外保护

这些命令只读检查已经定位的文件，不生成 PVF，也不批准修改。首次定位仍遵循名称／登记路由；任务要求的首次及最终 fingerprint 仍需执行。命令内部也会在读取前后核对所有输入 PVF 的完整 SHA256。

## 已实现的检查

`scope-audit` 从原始二进制脚本的 type-5 标签 token 定位一对明确的起止标签。说明文字中的同名文本不计为标签。解析必须消费全部字节；半个 token、未知类型、无效字符串索引、缺失、重复、反向或同名嵌套区块都会停止。

```bat
workbench.bat pvf-read scope-audit --pvf "D:\TaskInput\Script.pvf" --path "stackable/known.stk" --section "[exact section]" --out "D:\TaskEvidence\scope.json"
```

只允许一个唯一的区块，选择器须是完整的 ASCII 开始标签。结束标签由相同名称生成。支持 `.stk/.equ/.skl/.etc/.dgn/.qst` 中具有标准二进制 token 格式的文件。脚本上限 16 MiB、字符串表上限 128 MiB，其他格式或超限不作成功判定。

报告绑定完整源哈希、文件原始字节哈希、区块体起止偏移及范围外摘要；不输出区块中的技能、参数和池内容。偏移是 PVF 内解密文件的字节位置，不是完整 PVF 容器位置，也不是文本字符位置。区块体不包含起止标签；标签本身属于保护范围。

`scope-compare` 重新打开保护源和候选输出，分别定位同名区块。比较区块外前缀、后缀的原始字节，以及它们引用的原始字符串表条目。区块内长度改变时，后缀按各自闭合标签定位，不沿用源文件偏移。

```bat
workbench.bat pvf-read scope-compare --pvf "D:\TaskInput\Script.pvf" --candidate-pvf "D:\TaskOutput\Script.pvf" --path "stackable/known.stk" --section "[exact section]" --out "D:\TaskEvidence\scope-comparison.json"
```

相同脚本字节不保证引用文字相同，因此字符串表也须检查。字符串重新编号即使显示相同，也会因原始字节改变而被保守拒绝。保护范围中出现 StringLink 时当前停止，不能用局部文件检查宣称其外部文字依赖保持不变。

`package-compare` 在上述区块检查之外，完整枚举并读取两份 PVF 的每个文件。它仅支持一个声明的脚本区块体，拒绝任何文件增删及其他文件原始字节变化。`stringtable.bin` 可追加条目，但所有既有条目的原始内容与索引必须保留，不能改写旧条目；偏移表随追加变长不算既有字符串内容变化。无法解释的表头、范围或尾部字节会停止。

```bat
workbench.bat pvf-read package-compare --pvf "D:\TaskInput\Script.pvf" --candidate-pvf "D:\TaskOutput\Script.pvf" --path "stackable/known.stk" --section "[exact section]" --out "D:\TaskEvidence\package-comparison.json"
```

这会执行完整包读取，成本高于单文件检查。报告保留全部检查计数和逐项原始哈希清单的聚合摘要；问题路径各最多显示 100 个，超出时明确标记诊断列表截断。显示截断不缩小实际检查范围；任何读取或解析失败都会停止，不能当成相同。比较发现差异时保存失败报告并返回非零退出码。所有报告必须写入新的外部文件，不覆盖输入目录、工作台或已有报告。

## 不能从成功结果推导的结论

- 区块标签存在和闭合，不证明它就是任务的完整语义范围，更不自动授权清空整块。
- 单文件检查不证明其他文件未变；全包比较成功也不证明声明区块内的修改正确、范围选择完整或运行效果正确。
- 全包比较的“范围外保持”指声明脚本区块外字节、其他文件和所有既有字符串条目保持，允许字符串表追加；不是整份 PVF 容器字节不变。
- `rawBodyChanged` 只比较区块体的原始 token 字节；为 false 时，区块内引用字符串的变化仍可能改变显示或行为。它不是无操作判定，也不提供生成许可。
- 原始基线身份、职业／部位／技能／参数约束和实机效果仍须独立取证。这些检查尚未自动接入 `pvf-change` 的气息语义门禁。
- 用途始终为边界和范围外保护。不得读取或复用旧职业、旧技能、旧参数或旧池资料作为新答案。

## 维护验证

```bat
workbench.bat pvf-read scope-self-test
workbench.bat fallback-self-test
```

专用自测使用全新虚构内容，包含真实格式的合成 PVF 和公开 CLI 集成；覆盖区块体增删、伪标签、范围外字节变化、字符串表间接变化、文件增删、全包检查及源漂移。报告和合成文件位于外部运行目录，不读取历史任务数据。
