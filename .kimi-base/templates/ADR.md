# ADR-NNNN: <决策标题>

<!--
填写指引：
- NNNN 为单调递增编号（0001、0002……），文件名 docs/adr/NNNN-<kebab-case-标题>.md。
- 每条 ADR 只记一个决策；被拒绝的方案必须写明原因。
- Enforced-by 必填，且只准引用真实存在的机制（catalog check id / fitness 规则 id /
  layers / forbiddenDependencies / arch check / receipt / gate / impact …），
  无法自动化的写 manual: + 人工检查方式。adr check 会拦幽灵引用。
- Status 为 Superseded/已废弃 的 ADR 不再被 adr check 检查，但保留原文作历史。
-->

- Status: Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- Date: <YYYY-MM-DD>
- Deciders: <谁拍的板>

## Context

<为什么需要这个决策；约束与备选方案。被拒绝的方案逐个写明原因。>

## Decision

<决策内容，一段可执行的陈述。>

## Consequences

<正面/负面后果、迁移成本、需要跟进的事项。被接受的风险也写在这里。>

## Enforcement

<每条在世决策必须指向真实存在的守护；幽灵引用比没有更糟——adr check 会验证下面的引用真实存在。>

Enforced-by: <catalog check id | fitness 规则 id | arch check / layers / forbiddenDependencies / receipt / gate | manual:人工检查方式说明>
