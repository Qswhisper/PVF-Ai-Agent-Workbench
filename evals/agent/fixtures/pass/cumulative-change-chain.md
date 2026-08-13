可以继续累积，但不能只把“本轮差异”直接覆盖到已经含上一轮改动的客户端，否则会把上一轮成果退回去。下一轮应明确继承上一轮已复查输出；部署前还要确认客户端正好处于这一轮的输入版本。原始源文件仍保持不动。

技术详情（通常不用看）

在下一轮 change-set 增加 `baseline.applyManifest`，指向上一轮成功的 `APPLY-MANIFEST.json`；`target.sourcePvf` 和 profile 仍指向最初受保护源。工作台会重新核对上一轮 manifest、输出 PVF、受保护源及其 SHA256，再把上一轮输出作为本轮 input PVF。未声明 baseline 仍只表示“原始源 + 本轮 change-set”，不是自动累计。

正式生成后，`client-pvf preview` 会要求客户端当前 SHA256 等于本轮 input SHA256（已经等于候选输出也可）。因此本轮只读 input 可以就是客户端里已经部署的上一轮版本，但客户端仍不能和最初受保护源或本轮候选输出文件重合。不一致时默认停止；`--confirm-baseline-switch` 只用于用户明确放弃当前修改链、主动切换分支，不能代替普通累计。
