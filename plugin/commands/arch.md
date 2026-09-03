---
description: 架构健康报告（依赖规则 + 目录治理 + ADR 断链）
---
1. `node .kimi-base/runtime/kimi-base.mjs arch check $ARGUMENTS`
2. `node .kimi-base/runtime/kimi-base.mjs catalog lint`
3. `node .kimi-base/runtime/kimi-base.mjs adr check`

汇总为架构健康报告：依赖违规 / 未映射文件 / ADR 断链，各项给出修复建议。
$ARGUMENTS 可传 `--scan`（实边对账）；存量债务固化用 `arch baseline --write --reason "..."`（写操作，执行前先向用户确认）。
