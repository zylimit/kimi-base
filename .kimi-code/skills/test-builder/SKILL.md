---
name: test-builder
description: 当功能完成需要独立测试、补高价值回归、锁定缺陷或运行测试证据时使用。
type: prompt
whenToUse: 当功能开发完成需要回归测试、缺陷修复前需要红测锁定、打包/合并前需要测试卡点时
---

# Test Builder — 务实回归测试

## 目标

以契约和风险为中心建立可重跑的回归防线，不追求覆盖率虚荣。测试作者必须独立于被测实现作者——主 Agent 派 fresh tester 子代理（或非该功能作者的另一 implementer fresh 实例），写测≠被测作者。

## 前置

- 被测行为、验收条件、Scope 和 exclusions 明确
- 当前 diff、影响面和代码路径可定位（大仓先 `node .kimi-base/runtime/kimi-base.mjs impact`）
- 已知 runner、fixture、测试目录和 CI 约定

新增测试框架、插件或 lockfile 变化必须取得授权；缺工具时返回 `BLOCKED` 或提出最小方案，不静默安装。

## 三条铁律

**红测先行（red-locks-the-bug）**：修复任何已确认缺陷之前，必须先补一条**锁定该缺陷的失败测试**——此刻必然变红、且红在预期原因上。主 Agent 亲见红（验红）→ implementer 修绿（禁碰测试断言）→ code-reviewer 复审。缺陷固化为永久回归测试防再犯，修复有客观靶子（红转绿）。确实无法自动化时，记录一条可重复的人工复现步骤作为降级锁。

**写测独立性（防 confirmation bias）**：断言以 Spec / 契约为准，不照抄实现逻辑。自码自测会把作者的（可能错的）假设原样写进断言——测试"绿"只证明代码符合作者想象，不证明符合 Spec。

**测试即需求映射（trace-matrix）**：每个用例必须有锚点——REQ 号 / 缺陷号 / 契约条目。交付附 trace 矩阵：

```text
| 锚点（REQ/缺陷/契约） | 用例 | 状态（红/绿） |
```

没有锚点的用例不许进套件（防覆盖率表演）；有锚点没覆盖的条目列进覆盖缺口。

## 测试预算（按价值排序）

1. 跨边界契约、序列化往返、API/schema 兼容
2. 解析/清洗/去重/状态迁移
3. 权限、安全、路径、事务、并发和关键错误路径
4. 纯函数与高分支业务规则
5. 核心用户流程 E2E

通常不测第三方库自身、无分支透传和脆弱大快照，除非契约明确要求。

## 流程

1. 用 `impact`、task 和当前 diff 圈定直接模块、消费者和风险。
2. 从 Spec/契约提取独立断言；缺测试基建时按 `${KIMI_SKILL_DIR}/references/test-scaffold.md` 做最小 scaffold（能跑通一个样例即可，不过度配置）。
3. 列出候选用例、破坏代价和取舍理由；每个候选用例先定锚点。
4. 只修改测试、fixture 和授权的测试配置；**不得修改生产代码**。
5. 先跑最近测试，再走质量门 `node .kimi-base/runtime/kimi-base.mjs gate`；高风险任务由 fresh tester 执行。
6. 失败分类：product（代码错 → 交回主 Agent 路由 bug-fixer）/ test（测试错 → tester 自修）/ environment / prerequisite / suspected-flaky（标出来，不默默重跑刷绿）。
7. 修改后重跑；只接受当前 fingerprint 的新鲜证据。

Fast Mode 下不自动新增或运行测试；用户显式要求测试时照常执行。

## 完成标准

- 高风险相关必测项可重跑且真实执行。
- 运行器输出 passed/failed/exit status 可核查。
- 无遗留红测；无法执行项明确为 BLOCKED 或 Not verified。
- trace 矩阵列出每个新增用例防的是哪类回归，以及未测项和理由。
- 不自动 commit/push。

## 回执

```text
Status: PASS | FAIL | NEEDS_CONTEXT | BLOCKED
Changed:
Verified:
Not verified:
Needs review by:
Evidence: <运行器输出位置 + trace 矩阵>
```

## 初始化

执行前置检查 → 从流程第 1 步开始。
