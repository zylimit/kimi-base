---
name: large-repo-harness
description: 当仓库规模大、跨模块、上下文易失控，或需要配置 catalog、影响面分析、上下文预算与定向验证时使用。
type: prompt
whenToUse: 当接入大型既有仓库、变更跨 2 个以上模块、catalog 出现告警、全仓测试成本过高或上下文频繁压缩时
---

# Large Repo Harness — 60 万行仓库作业法

## 目标

让 60 万行级、多模块、长周期仓库通过显式模块边界、预算化上下文、串行 ownership、影响面优先验证和架构防腐保持可控。**扩展方式是缩小活动范围，不是把更多源码灌入模型。**

启用条件与完整契约（schema、退出码、接线点、waiver 规则、性能预算）见 `.kimi-base/rules/large-repo.md`——命中本 skill 做实操前必须先读它。核心：`.kimi-base/module-catalog.json` 存在即启用，不存在则所有能力静默关闭、对项目零影响。

## 何时使用

- 新接入大型既有仓库
- 一个变更跨 2 个以上模块/公共契约
- catalog 出现 unmapped/overlap/shared/global/truncated
- 全仓测试成本过高或上下文频繁压缩
- 多 writer、worktree、生成物、迁移或公共 manifest 需要协调

## 1. Catalog 分区与接入

```text
node .kimi-base/runtime/kimi-base.mjs init-modules      # 绿地：生成 catalog 骨架
node .kimi-base/runtime/kimi-base.mjs catalog discover  # 棕地：从现状推导候选分区
node .kimi-base/runtime/kimi-base.mjs catalog lint      # 校验：每条 tracked path 必须有归处
```

每个 bounded module 定义：`id`、`root`/`paths`、`dependsOn`、`owners`、`contracts`、`capsule`、`tests`、`verification`，可选 `layer`、`forbiddenDependencies`、`attributes`（五性定档）。不要用 root catch-all 掩盖漏项；generated/vendor/runtime/secret 显式排除；依赖环使 lint 失败。

既有大仓接入时执行架构防腐三步：

```text
node .kimi-base/runtime/kimi-base.mjs arch check --scan      # 如实登记现状（含存量违规）
node .kimi-base/runtime/kimi-base.mjs arch baseline --write --reason "存量接入基线"   # 旧债固化进 git 可评审
node .kimi-base/runtime/kimi-base.mjs adr check              # 决策的 Enforced-by 不许幽灵引用
```

此后新增违规立即失败（新债零容忍）；还清旧债后重跑 `arch baseline --write` 收缩基线（stale 条目会被点名催删）。

## 2. Task 切分

每个 Task 只含一个可独立验收的行为切片：明确 owned paths、公共契约和 consumers；schema、迁移、lockfile、生成物、根配置视为共享 ownership；共享 checkout 默认一个 writer；并行写只允许独立 worktree + 不交叉 ownership + integration owner。任务一律 `task start --goal "..." --owned "glob,glob" --risk low|medium|high` 建立账本与基线后再动工。

## 3. 影响面驱动上下文（impact 先行）

```text
node .kimi-base/runtime/kimi-base.mjs impact --git                 # 当前工作树 diff 的受影响模块
node .kimi-base/runtime/kimi-base.mjs impact src/x/a.ts lib/b.ts   # 显式路径（非 git 环境用此形态）
```

- 直接模块沿反向依赖扩到消费者；shared/global/unmapped/overlap/truncated 安全扩到全部模块（宁可全跑，不可漏测）。
- 删除文件与非 git 环境必须明确降级/阻断（`impact --git` 在非 git 仓返回 BLOCKED），不伪造精确影响。
- **按影响面加载上下文**：只读受影响模块的 capsule、contracts、消费者和相关测试，不灌全仓。

## 4. Context Pack 预算

```text
node .kimi-base/runtime/kimi-base.mjs context pack --budget 60000 --focus "src/x/**"
```

Pack 只纳入任务相关面；凭据 DENY 清单（.env/*.pem/id_rsa/.ssh/.aws 等）永不入包；装不下的进 omitted 显式报告，不用全目录源码补洞——长期缺失回到 catalog/文档维护，而不是每轮重新猜。

## 5. 验证计划随 impact 收缩

```text
node .kimi-base/runtime/kimi-base.mjs gate            # 受影响模块的定向质量门（四态）
node .kimi-base/runtime/kimi-base.mjs quality status  # 证据账本与五性覆盖
```

顺序：changed-file 静态 → 模块单测 → 消费者契约/集成 → 更大范围 build/security/smoke。**只有跨切面、高风险、release/CI 或保守扩张时才跑全仓。**

同一 check 的后续 FAIL/BLOCKED 覆盖旧 PASS；高风险任务由 fresh tester 执行 gate。受影响模块声明 critical/high 五性属性时，完成门额外要求属性证据（FAIL 反证优先）。会话中定期 `node .kimi-base/runtime/kimi-base.mjs risk scan` 查失败连击、过期 lease 与账本链；同一 check 连续 FAIL ≥3 次停止重试，转 bug-fixer 根因分析。

## 6. 债务棘轮（还债节奏）

老仓带债接入的现实路径：`arch baseline --write` 先把存量债固化（每条带 reason、进 git 可评审），`arch trend --record` 周期性快照漂移指标（undeclared / forbidden / cycles / layer-direction），`arch trend --gate` 只在最新值超过历史最优时拦——棘轮只朝一个方向转：**旧债可以慢慢还，新债一分不许添**。还债节奏写进 DEV-PLAN（如每 Phase 还 N 条 undeclared 边），还清一段重跑 `arch baseline --write` 收缩一段基线。

## 压力场景

- **unmapped path**：停止声称精确影响，修 catalog 或执行保守检查。
- **shared contract**：扩到全部消费者，串行修改公共接口。
- **多 writer**：发现 ownership 重叠立即停止；不要靠 prompt 假装隔离。
- **全仓测试昂贵**：优化 matrix/capsule/契约测试，不直接关闭 required gate。
- **context 截断**：拆 Task、补 capsule、降低噪音；不要提高预算掩盖边界失败。

## 回执

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Changed:
Verified:
Not verified:
Needs review by:
Evidence:
```

## 初始化

确认 catalog 存在与否（`node .kimi-base/runtime/kimi-base.mjs doctor` 看 `catalogPresent`）→ 已启用读 `.kimi-base/rules/large-repo.md` 后按场景进对应节；未启用且确需大仓治理 → 先走第 1 节接入。
