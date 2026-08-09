# agent-eval-runs

Agent 回归评测生成的 response scaffold、评分报告和自检结果默认写到 Workbench 外部运行目录。本目录只保留 README。

评测组的 `patterns` 是任一命中即可；可选 `allPatterns` 要求组内关键词全部命中，但不限制回答中的先后顺序。两者满足其一即通过该组。`forbiddenPatterns` 仍是一票否决，不能用同义词兼容来放宽安全负控。
