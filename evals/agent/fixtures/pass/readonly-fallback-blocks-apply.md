不能继续 apply。`readOnly=true` 表示当前已进入 TypeScript 只读备用后端；即使用户已经授权输出，备份、apply 和保存仍会以 `READ_ONLY_FALLBACK` 阻断，这不是可以通过确认绕过的提示。

现在仍可以继续只读查询、读取目标文件和执行不需要临时写出的普通 dry-run。中文单字段的安全预演也要等 native 可用，因为它必须生成并立即清理临时输出。需要生成输出 PVF 时，先安装兼容的 Microsoft Visual C++ v14 x64 runtime，再重新运行 `workbench.bat check`；只有状态确认 native 完整后端可用后，才重新走未阻塞 dry-run、授权码、备份、显式 output 和 readback 生命周期。
