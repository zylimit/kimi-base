---
name: code-review
description: 当用户要求审查代码、对抗审查、检查质量或对照规格核查实现时使用。
type: prompt
whenToUse: 当 Task/Phase 实现完成、合并前、发版前，或用户要求审查代码质量时
---

# Code Review — 三阶段审查

## 目标

只读、独立、缺陷优先地判断变更是否满足 Spec/Task，是否引入 correctness、安全、韧性、隐私、维护和发布风险。审查者不修改代码；修复交回主 Agent 路由。

审查执行一律派 code-reviewer 子代理（fresh 实例）；主 Agent 不自己审。

## 输入

- REQ/Task/ADR/设计或其他明确行为契约
- 完整 base commit 与 canonical diff 指纹
- Scope、exclusions、Out of Scope
- 已执行验证及 evidence

既有项目没有固定 Spec 时，可使用 issue、验收条件、公共契约和现有测试。base/diff/scope/exclusions 不完整时，报告为未绑定审查，**不能判通过**。

大型仓库先运行 `node .kimi-base/runtime/kimi-base.mjs impact`，只读加载受影响模块 capsule、公共契约、消费者和相关测试；不要倾倒全仓。

## 三阶段

### Stage 0：静态闸与客观证据

- 静态检查（lint / 类型 / 构建）真实跑过，贴命令与退出码。
- harness 启用时：核对既有 receipt 是否绑定当前 fingerprint/diff；`node .kimi-base/runtime/kimi-base.mjs fitness` 扫变更文件五性反模式。
- `FAIL`、`BLOCKED`、`SKIPPED` 和未运行项如实报告；结构 validate 不能代替质量 PASS。

Stage 0 有静态错 → 停在 Stage 0，回主 Agent 派 bug-fixer 修绿后从 Stage 0 重审。

### Stage 1：规格与行为（做对了没有）

逐条检查范围内契约（REQ 逐条过）：

- happy / error / empty / loading / boundary 路径
- 状态、事务、并发、重试和幂等
- API / schema / 序列化 / 迁移兼容
- 权限、路径、输入校验和数据隔离
- 漏实现、半实现、scope creep 和旧行为回归

每个 finding 必须包含严重度、`path:line`、触发路径或推理链、具体影响和最小修复方向。Stage 1 有 HIGH 及以上问题 → 停在 Stage 1，不进 Stage 2。

### Stage 2：代码与运维（做好了没有）

- 模块职责、耦合、重复、局部复杂度、可测试性
- 错误是否可观察，是否存在空 catch / 默认成功
- 依赖和配置变化是否必要且受控
- 测试是否覆盖高价值契约，而不是覆盖率表演
- 安装/升级/卸载、package hygiene、跨平台、编码、回滚、隐私和远端副作用

不要用机械行数、个人命名偏好或固定框架规则制造噪声；以仓库现有规范为准。

## 多视角 lens

三阶段之外，用四个 lens 各独立过一遍 diff（每个 lens 默认想推翻）：

- **correctness**：逻辑错、边界漏（空/越界/null）、与既有规则或 Spec 自相矛盾
- **security**：注入 / 越权 / 密钥或路径泄露 / 破坏性操作无防护
- **resilience**：无界重试、缺超时、静默吞错、故障扩散路径
- **privacy**：日志/出口携带个人数据、超范围收集、销毁缺失

security/privacy 相关 finding 永不降级为「建议」。

## 对抗模式

高风险变更（架构变更、安全相关、核心逻辑重写）走 red-blue-review skill（Blue 自证 → Red 攻击 → Judge 裁定）。多个只读 reviewer 可并行各审一个 lens；任何修复都会改变 diff，必须重新审查并重新生成 receipt。

## 需求存疑回流（REQ-070）

Stage 1 核的是 Spec 的字面，派单包 Business Context 承载"为什么"。以下两种情况**不得只在代码层面消化**（改代码迁就 Spec、或当没看见）：

- 实现与 Spec 字面符合，但与 Business Context（动机 / 受益人）矛盾；
- Spec 本身可疑——业务上说不通，或与已确认场景、其他 REQ、「规则与例外」冲突。

处理：产出「需求存疑」条目——**哪条 REQ / 为什么可疑 / 证据（path:line 或具体场景）**——列入报告的 Open questions 并显式标注「回流 product-spec-builder 迭代模式」，由主 Agent 路由。确认的 Spec 错误修正后，该反例必须进 Spec「规则与例外」节（无此节则新增），防同类需求错误复发。

## 对话示例与反例

**示例一（输入不全：未绑定审查不判通过）**

主 Agent：审一下这次改动。
AI：缺 base commit 与 canonical diff 指纹，也没给 REQ/Task 对照面。没有绑定面的审查只能谈风格，判不了行为符合性——按未绑定审查处理，不判通过。请补：① 对应 REQ/Task 与 Business Context；② base commit；③ Scope 与 exclusions。
主 Agent：REQ-007，base 是 a1b2c3，Scope 是 src/notify/**，排除 mocks。
AI：绑定面齐了。先跑 impact 圈定受影响模块……（Stage 0-2 后）Stage 1 发现：REQ-007 验收行要求「催单生成站内提醒」，实现却直接弹窗客服——[High] src/notify/push.ts:42。对照 Business Context，用户明确说过「催单不直接弹客服」，这是规格偏离不是自由裁量。
主 Agent：修完你再看看。
AI：任何修复都改变 diff，旧证据与回执作废——修复后从 Stage 0 重审，重新生成 receipt。

**示例二（字面符合但与业务含义矛盾：回流不消化）**

AI：Stage 1 核 REQ-012 字面：「48 小时无反馈后客户可催单」——实现符合。但对照 Business Context：动机是「客户三天没人理打电话骂」，规则与例外节写明「VIP 单直达老张」。实现里 VIP 单也走 48 小时计时——VIP 压群没人理时，要等 48 小时后客户催单才被发现，动机场景照样发生。字面符合、业务上说不通。
主 Agent：你的处理？
AI：不替需求做发明，也不当没看见。产出「需求存疑」：REQ-012 可疑——VIP 例外未豁免计时；证据：src/notify/escalate.ts:17 无 VIP 分支 + Spec「规则与例外」条目。列入 Open questions，标注回流 product-spec-builder 迭代模式。本次审查结论 DONE_WITH_CONCERNS——字面范围内通过，存疑项交主 Agent 路由。

**反例**

- × 口头「审查通过」不落机器回执 → 口头通过不可核查，diff 一变无从追溯 → Stage 0-2 全过后由主 Agent 跑 `gate` 落绑定指纹的回执。
- × 审查者顺手把发现的问题改了 → 审查与修复同人，独立性归零，且 diff 变化使旧证据作废 → 审查只读，修复交回主 Agent 路由。
- × 拿机械行数、个人命名偏好当 finding → 噪声淹没真问题，审查信用破产 → 以仓库现有规范为准，只报 correctness/安全/韧性/隐私/维护/发布风险。
- × security/privacy 发现写成「建议后续关注」→ 保护属性永不降级 → security/privacy finding 永不降级为建议。
- × 实现与 Business Context 矛盾时改代码迁就、或当没看见 → 代码层消化需求矛盾，同类需求错误复发 → 产出「需求存疑」条目回流 psb。

## 机器回执（通过的唯一形式）

口头「审查通过」不算数。Stage 0-2 全过后，由主 Agent 跑质量门落机器回执：

```text
node .kimi-base/runtime/kimi-base.mjs gate             # 受影响检查→绑定当前 git 指纹的回执
node .kimi-base/runtime/kimi-base.mjs receipt verify   # 校验账本链与证据完整性（断链 fail-closed）
```

回执绑定 task + 当前 git 指纹 + 检查 argvHash + 证据哈希：任何改动使旧回执 stale → 必须重审重跑。Stop hook 在会话收尾时复核证据新鲜度，缺证据会拦截。

## 输出

Findings 排在最前，按 `Critical > High > Medium > Low`：

```text
[Severity] Title
Location: path:line
Evidence: reproduction or reasoning
Impact: concrete failure
Fix: minimum direction
```

随后列出 Open questions、Verified、Not verified、残余风险、base commit 与 diff 指纹。无 finding 时明确写「未发现 finding」，并说明实际攻击过的路径和测试缺口。

## 初始化

核对输入（base/diff/scope 齐全）→ 从 Stage 0 开始。
