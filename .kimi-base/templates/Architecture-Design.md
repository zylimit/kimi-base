# Architecture Design — <项目名>

<!--
填写指引：
- 规模分级：S 档（单模块/脚本）只需填第 1、10 节 + 一条「暂不分层」决策；M 档全填；
  L 档全填且必须同步产出 .kimi-base/module-catalog.json 骨架（接通 arch check / adr check 机器闸）。
- 七大原则对照结论逐条填：本设计如何满足 + 已知妥协（指向 ADR）。
- 文档与 catalog 冲突时以 arch check 实测为准，并回改本文档。
- 自检（L 档必跑）：
  node .kimi-base/runtime/kimi-base.mjs catalog lint
  node .kimi-base/runtime/kimi-base.mjs arch check
  node .kimi-base/runtime/kimi-base.mjs adr check
-->

_版本：v1.0_
_关联 Spec：Product-Spec.md（vX.Y）_
_规模档：<S / M / L>_

## 1. 架构目标与约束

<从 Spec 提取的质量约束（规模、性能、安全、合规、五性诉求）与团队/技术约束。>

## 2. 分层

| Layer | 职责 | 允许依赖 |
|---|---|---|
| contracts | 公共契约/schema，零实现依赖 | （无） |
| domain | 业务规则 | contracts |
| application | 用例编排 | domain, contracts |
| interface | UI/API/CLI/基础设施适配 | application, domain, contracts |

> 按项目裁剪层数；依赖只指向同层或更低层。该表与 module-catalog.json 的 `layers` 保持一致。

## 3. 模块清单

| Module ID | Root | Layer | 职责（一句话） | dependsOn | shared | owners |
|---|---|---|---|---|---|---|
| | | | | | | |

## 4. 公共契约

| Contract | 路径 | 提供方 | 消费方 | 变更策略 |
|---|---|---|---|---|
| | | | | |

## 5. 变化轴与扩展点（开闭原则）

| 会变什么 | 扩展机制 | 新增行为的方式（不改哪些文件） |
|---|---|---|
| | | |

## 6. 禁止依赖（防腐规则）

| From | To | 原因 |
|---|---|---|
| | | <已写入 module-catalog.json 的 forbiddenDependencies> |

## 7. 七大原则对照结论

| 原则 | 本设计如何满足 | 已知妥协（如有，指向 ADR） |
|---|---|---|
| 开闭 | | |
| 依赖倒置 | | |
| 单一职责 | | |
| 接口隔离 | | |
| 迪米特 | | |
| 里氏替换 | | |
| 合成/聚合复用 | | |

## 8. 关键决策（ADR 索引）

| ADR | 决策 | Enforced-by |
|---|---|---|
| docs/adr/0001-*.md | | <只准引用真实存在的机制或 manual: 说明> |

## 9. 架构验收

```text
node .kimi-base/runtime/kimi-base.mjs catalog lint      # unmapped/overlap/cycle = 0
node .kimi-base/runtime/kimi-base.mjs arch check        # 新违规 = 0（存量走基线棘轮）
node .kimi-base/runtime/kimi-base.mjs adr check         # 幽灵引用 = 0
```

## 10. 债务与还债计划（棕地项目）

<arch 基线中容忍的存量违规、责任人与拆除条件；还债节奏（如每 Phase 还 N 条 undeclared 边）。>
