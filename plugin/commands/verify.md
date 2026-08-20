---
description: 按当前改动跑影响面分析与 gate 验证，汇报四态结果
---
1. 运行 `node .kimi-base/runtime/kimi-base.mjs impact --git`，取得本次改动的影响面。
2. 运行 `node .kimi-base/runtime/kimi-base.mjs gate $ARGUMENTS`，执行验证矩阵。
3. 按四态（PASS / FAIL / BLOCKED / SKIPPED）逐条汇报检查结果与整体结论。
4. 存在 FAIL 或 BLOCKED 时：明确告知用户验证未通过，列出差距与修复建议，
   **不得宣称任务完成**；全部通过才可进入完成/收尾流程。
