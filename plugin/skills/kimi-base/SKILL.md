---
name: kimi-base
description: kimi-base harness 会话路由：检测项目治理标记并装载对应工作流纪律
type: prompt
whenToUse: 每个会话开始时自动加载（插件 sessionStart）；非 kimi-base 项目中保持静默
---

# kimi-base 会话路由

本 skill 由插件 sessionStart 在每个会话启动时加载。它不做治理动作，只负责：
检测当前项目是否为 kimi-base 项目 —— 不是则全程静默；是则装载治理状态并按用户意图路由。

## 第一步：检测项目标记（必须最先执行）

用 Glob 或 Bash 检查当前项目根是否存在 `.kimi-base/harness.json`：

- **不存在** → 这是别的项目。立即结束本 skill：不输出任何内容、不执行任何命令、
  不在回复中提及 kimi-base。
- **存在** → 继续下一步。

## 第二步：装载治理状态（仅 kimi-base 项目）

1. 读 `.kimi-base/harness.json`（项目名、模块边界、治理配置）。
2. 依次运行：
   - `node .kimi-base/runtime/kimi-base.mjs task status`
   - `node .kimi-base/runtime/kimi-base.mjs quality status`
   - `node .kimi-base/runtime/kimi-base.mjs fast status`
3. 向用户输出简短横幅（≤6 行）：项目名 / 活跃任务 / fast mode 状态 / 待验证项（gate 四态摘要）。
   某条命令失败时在横幅对应位置标注"治理引擎不可用"并继续，不要中断会话。

## 第三步：意图路由

用户消息与左列意图有 **1% 相关即调用** 对应 skill，不要等用户明说：

| 用户意图 | 调用 skill |
| --- | --- |
| 需求、立项、产品规格 | product-spec-builder |
| 架构、选型、ADR | arch-designer |
| 五性（韧性/安全/功能安全/隐私/可靠性） | dfx-designer |
| 计划、拆解、排期 | dev-planner |
| 编码、实现、重构 | dev-builder |
| 审查、review | code-review |
| 测试、用例、覆盖率 | test-builder |
| 修 bug、排障 | bug-fixer |
| 发布、打包、上线 | release-builder |
| 收尾、合分支、清理 | branch-finisher |
| 大仓、monorepo、超大代码库 | large-repo-harness |

一条意图命中多个时，按表格从上到下依次装载。

## 恢复规则（会话恢复 / 上下文压缩后必须执行）

满足任一条件即视为"恢复会话"：用户提到"继续 / 上次 / 恢复"，或对话开头出现压缩摘要。
恢复时必须读齐以下材料才算恢复完成，缺一不可：

1. `progress.md`
2. `Product-Spec.md`
3. `Product-Spec-CHANGELOG.md`
4. `.kimi-base/state/compaction-note.json`（若存在）

读齐后先向用户复述"上次做到哪、下一步是什么"，再继续工作。
文件缺失时如实说明缺口，不要编造。

## 上下文预算纪律

- 主 Agent 不亲自读大文件全文（日志、锁文件、生成物、>500 行的源码）。
- 探索性搜索、泛读、汇总一律外包给 explore / researcher 子代理，主 Agent 只消费结论。
- 只有必须精读的文件（治理四件、当前任务直接相关的源码）才进主上下文。
