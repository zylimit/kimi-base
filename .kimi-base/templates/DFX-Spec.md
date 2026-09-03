# DFX Spec — <项目名>

<!--
填写指引：
- DFX 是评价方法论：本文件每个条目都必须可评价、可度量、可验证。「可度量或不写」。
- 五性逐维过堂：每维四选一定档（critical/high/medium/low/minimal/none 六档 + N/A 需理由）；
  none/minimal 必须给书面理由（catalog lint 的 UNJUSTIFIED_TIER 拦裸退出）。
- critical/high 维度逐场景写六要素场景卡；验证落点必须是真实存在的 check id 或 manual: 说明。
- 定档同步落进 .kimi-base/module-catalog.json 的 module.attributes；
  security/safety/privacy 永不豁免、永不 fast-skip。
- 自检（有 catalog 时）：
  node .kimi-base/runtime/kimi-base.mjs catalog lint
  node .kimi-base/runtime/kimi-base.mjs quality status
-->

_版本：v1.0_
_关联：Product-Spec.md（vX.Y）、Architecture-Design.md（如有）_

## 1. 维度总览

| 维度 | 定档 | 结论一句话 |
|---|---|---|
| 韧性 Resilience | critical/high/medium/low/minimal/none | |
| 安全 Security（信息安全） | | |
| 功能安全 Safety | | |
| 隐私 Privacy（涉及个人数据时必填） | | |
| 可靠性 Reliability | | |
| 性能 Performance（按需） | | |
| 可维护性 Maintainability（按需） | | |

> none/minimal/N/A 必须写理由；没有理由的视为未完成评价。

## 2. Critical / High 维度场景卡（六要素）

### <维度名>（<critical|high>）

- **场景**：<谁在什么条件下遇到什么——具体，不写「系统故障时」这种泛话>
- **失效与威胁假设**：<会怎么坏 / 会被怎么攻；FMEA 简版：失效模式 → 影响 → 严重度（高/中/低）>
- **度量指标**：<MTTR / RPO / RTO / P95 / 泄漏条数……>
- **目标值**：<必须达到的阈值，可判定，不写「尽量低」>
- **设计对策**：<指向架构中的具体机制/模块，如重试+熔断在 gateway 模块、秘密走 vault>
- **验证落点**：<catalog check id（须声明认领该属性）或 manual: 人工核查说明>

<每个 critical/high 维度至少一张场景卡；一个维度可有多张。>

## 3. 专项要求

### FMEA 简版（Safety / Resilience 必填）

| 失效模式 | 影响 | 严重度 | 现有探测手段 | 对策 |
|---|---|---|---|---|
| | | 高/中/低 | | |

### MTTR / RPO / RTO（Reliability / Resilience 必填）

- MTTR（故障恢复时长上限）：<值或可判定条件>
- RPO（数据可丢多少）：<值或可判定条件>
- RTO（服务可停多久）：<值或可判定条件>

### GDPR 数据生命周期（Privacy 必填）

| 环节 | 内容 |
|---|---|
| 收集 | <什么数据 / 目的 / 法律依据> |
| 使用 | <谁访问 / 最小化原则> |
| 存储 | <位置 / 期限 / 加密> |
| 共享 | <第三方 / 跨境情况> |
| 销毁 | <方式 / 期限 / 可证明性> |

## 4. 属性分层落地表（同步到 module-catalog.json）

| Module | security | safety | privacy | resilience | reliability | performance |
|---|---|---|---|---|---|---|
| | | | | | | |

## 5. 验证闭环缺口

| 属性 | 缺少的检查 | 建议命令 | 状态 |
|---|---|---|---|
| | | | 待用户确认写入 catalog checks |

## 6. 明确不做与被接受的风险

<降档/放弃的维度及书面理由、用户确认接受的风险、复评触发条件。>
