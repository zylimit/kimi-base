---
description: 恢复项目上下文：上次做到哪、下一步是什么
---
1. 运行 `node .kimi-base/runtime/kimi-base.mjs recap`——派生式恢复视图（现算 Position，不信任何摘要）；exit 3 表示 progress.md 缺失，如实标注，不要编造补齐。
2. 运行 `node .kimi-base/runtime/kimi-base.mjs invariants`——重读不可豁免铁律与实时状态（压缩后必做）。
3. 涉及本轮需求时补读 `Product-Spec.md` / `Product-Spec-CHANGELOG.md` 相关段（recap 不替代需求基线）。
4. 向用户汇报三段：上次完成了什么 / 进行到哪 / 下一步是什么（含待验证项）。$ARGUMENTS
