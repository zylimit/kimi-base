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
