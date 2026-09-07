---
name: dev-builder
description: 当 Product-Spec.md 与 DEV-PLAN.md 就绪，用户要求开始或继续实现某个 Phase/Task 时使用。
type: prompt
whenToUse: 当用户要求开始开发、继续当前 Phase/Task，或实现某个已规划的功能时
---

# Dev Builder — 实现纪律

## 目标

按已确认的 Spec 和 DEV-PLAN 交付最小、可验证的代码切片。既有项目的架构、目录、语言规范、依赖和包管理约定优先；本 Skill 不强推框架、UI 库、测试框架、目录或文件行数。

编码执行一律派 implementer 子代理（每 Task 一个 fresh 实例）；主 Agent 只写派单包 + 验收，不亲手写代码。本文既是主 Agent 的编排纪律，也是 implementer 的执行纪律。

## 前置

必须存在：`Product-Spec.md`（已批准）、`DEV-PLAN.md`、当前 Task 的派单包七字段（Goal / Scope / Out of Scope / Existing Pattern / Verification / Escalation / Business Context，单源定义见 `.kimi-base/rules/dispatch-contract.md`）。

ADR、module capsule、module-catalog.json、现有测试和 CI 为可选输入；缺失时说明降级，不虚构要求。涉及外部 SDK/API/版本或陌生错误时先查官方资料，或交回主 Agent 派 researcher。

## 流程

### 1. 恢复与圈定

- 查看 Git 状态、当前 diff 和 active task，保护已有用户改动；发现未知并发写入时停止并协调。
- 读取相关 REQ、Plan Task、公共契约、调用方和测试。
- 大仓（module-catalog.json 存在）先运行：

```text
node .kimi-base/runtime/kimi-base.mjs catalog lint
node .kimi-base/runtime/kimi-base.mjs impact
```

unmapped、shared、global 或 truncated 结果必须安全扩大验证范围，不得忽略。

### 2. 建立任务

复杂、跨模块或中高风险任务先建立 task（goal、risk、ownedPaths 入账，Spec/Plan 引用写进 goal）：

```text
node .kimi-base/runtime/kimi-base.mjs task start --goal "实现 X（REQ-7 / P1-T2）" --owned "src/x/**,docs/x.md" --risk medium
node .kimi-base/runtime/kimi-base.mjs context pack
```

一个 Task 只交付一个可独立验收的行为切片。共享契约、schema、迁移、lockfile、生成物和公共 manifest 默认单 writer；并行写需独立 worktree、互斥 ownership 和指定 integration owner。

### 3. 实现（implementer）

- 只修改 Scope/owned paths，遵循最近的现有模式。
- 保持公共接口稳定；必要破坏性变化先核对消费者和用户决策。
- 禁止空 catch、默认成功、静默重试和无真实调用方的兼容层。
- 行为变化处理相应错误、空状态、边界、权限、事务或并发路径。
- 新增/升级依赖、迁移数据、切换包管理器或 CI 规则必须先获授权。
- 未授权时不 commit、push、tag、publish、deploy、建远程仓库、终止进程或修改机器配置。
- **持续核对业务含义（REQ-070）**：实现过程中对照派单包 Business Context（为什么做 / 谁受益 / 规则与例外）核对方向。发现实现与业务含义矛盾、或发现 Spec 未覆盖的反例（业务上说不通、与场景冲突）时**停手上报**：回 `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` 写明反例与证据，交主 Agent 回流 product-spec-builder 迭代模式。**不替需求做发明**——不擅自"合理化"吞掉矛盾后继续写码。

### 4. 受影响验证

先执行 Task 指定的最近检查，再走质量门：

```text
node .kimi-base/runtime/kimi-base.mjs gate
node .kimi-base/runtime/kimi-base.mjs quality status
```

- `PASS` 才能称通过；`FAIL` 先修根因；`BLOCKED` 报告缺失条件；`SKIPPED` 报告 Fast 窗口和残余风险。
- **证据优先（铁律）**：implementer 自报 DONE、Bash 命令跑成功、结构 validate，都**不算**质量通过——只有绑定当前 diff 指纹的 gate / receipt 机器回执算。
- **验证时效性（铁律）**：验证命令必须与汇报同轮执行并读输出。修改代码后 fingerprint 变化，旧 receipt 不再背书。
- 高风险任务的完成门需要 fresh tester 执行 gate；实现者不能冒充 tester。

Fast Mode（`node .kimi-base/runtime/kimi-base.mjs fast on|off|status`）下不自动新增测试或派 reviewer/tester，但用户显式要求的检查、安全门和不可跳过 check 仍执行；security/safety/privacy 永不 fast-skip。

### 5. 交回闭环

正常模式请求主 Agent：

- 派 fresh code-reviewer 对照当前 REQ/Task 和绑定 diff 三阶段审查。
- 按风险派独立 fresh tester 编写/运行高价值回归。
- 主 Agent 重跑关键命令并检查 receipt 时效，通过后才 commit。

子代理不得再派子代理；需要其他角色时只写进 `Needs review by`。

## Phase 完成度判断（四步走）

每完成一个 Phase：① Code Review（三阶段全过）→ ② 测试完整性（tester 跑/补回归，运行器真实输出）→ ③ 编译验证 → ④ 功能测试（对照 Phase 验收标准）。四步全过 → 用户确认 → 才进下一 Phase。重点关注跨 Task 集成问题：导入关系、文件依赖、命名一致性。

## 完成标准

- Scope 内行为完成，Out of Scope 未混入。
- 错误和安全边界可观察，无未经授权副作用。
- 当前 fingerprint 的验证命令、退出状态和 evidence 可核查。
- 未验证、降级、环境限制和人工检查明确列出。

## 反合理化清单（偷懒话术 → 应对）

Agent 容易用"合理"的理由跳过纪律。以下话术一出现，按右列应对：

**跳过编排**：

- 「这个很简单，直接写就行」→ Plan 不看复杂度看纪律：派单包七字段照写，implementer 照派。
- 「就改一个文件，不用派子代理」→ 唯一编排是铁律：主 Agent 不亲手写代码，一个文件也走派单。
- 「用户在等，先写再说」→ 5 分钟派单省 30 分钟返工；fresh 实例的上下文隔离正是质量来源。

**跳过验证**：

- 「我刚测过这个」→ 验证时效性铁律：声明同轮重跑；diff 变了旧 receipt 作废。
- 「编译通过就说明没问题」→ 编译通过 ≠ 功能正常，四步走每步都要。
- 「这个改动不可能出错」→ 不可能出错的改动最容易出错，跑 `gate` 拿回执。
- 「结构 validate 过了 / 子代理自报 DONE」→ 都不算质量通过，只有绑定当前指纹的 gate 回执算。

**模糊派单 / 软性完成**：

- 「实现时再想细节」→ 派单阶段写死目标/边界/验证，不给 fresh 实例留自由发挥的缝。
- 「添加必要的错误处理」→ 指明处理哪些错误、各自什么行为。
- 「应该没问题了」「大概率通过」→ 禁止词；「没问题」需要当场跑出来的证据。

**吞需求矛盾**：

- 「Spec 这么写，照做就行，矛盾不归我管」→ 不替需求做发明：业务上说不通就停手上报（`DONE_WITH_CONCERNS` / `NEEDS_CONTEXT`），回流 product-spec-builder。

## 回执

回执信封六字段（Status 四态与字段语义）定义见 `.kimi-base/rules/dispatch-contract.md`「回执信封六字段」节。

## 初始化

执行前置检查 → 从流程第 1 步开始。
