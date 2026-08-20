---
description: 恢复项目上下文：上次做到哪、下一步是什么
---
1. 依次读取：`progress.md`、`Product-Spec.md`、`Product-Spec-CHANGELOG.md`、
   `.kimi-base/state/compaction-note.json`（若存在）。
2. 缺失的文件如实标注，不要编造内容补齐。
3. 向用户汇报三段：上次完成了什么 / 进行到哪 / 下一步是什么（含待验证项）。
4. 必要时补跑 `node .kimi-base/runtime/kimi-base.mjs task status` 校对活跃任务。$ARGUMENTS
