# 意图路由表（单源定义）

**命中本指针必须完整读取再行动，不得凭指针行猜测内容。**

用户消息与左列意图有 **1% 相关即调用** 对应 skill，不等用户明说；一条意图命中多个时，按表序从上到下依次装载。

| 意图 | Skill |
| --- | --- |
| 需求 / 立项 / 产品定义 | product-spec-builder（签字闸后才进下游） |
| 设计风格 / 视觉方向 / UI 感受定轴 | design-brief-builder（需已批准 Spec；默认探索档签字闸强制） |
| 设计稿 / 设计产出 / 页面与状态变体 | design-maker（需 Design-Brief；无设计工具走 DESIGN.md 降级） |
| 架构设计 / 选型 / ADR / 防腐 | arch-designer → 读 `.kimi-base/rules/large-repo.md` |
| 五性（韧性/安全/功能安全/隐私/可靠性） | dfx-designer → 读 `.kimi-base/rules/quality-attributes.md` |
| 开发计划 / 拆解 / 排期 | dev-planner（无占位符原则） |
| 编码 / 实现 / 重构 | dev-builder |
| 代码审查 / review | code-review（三阶段；高风险走 red-blue-review） |
| 测试 / 用例 / 覆盖率 | test-builder（红测先行，测者≠作者） |
| 修 bug / 排障 | bug-fixer（red-locks-the-bug：先补红测再修） |
| 发布 / 打包 / 上线 | release-builder（全量验证 + 隐私审计） |
| 收尾 / 合分支 / 清理 | branch-finisher |
| 大仓 / monorepo / 超大代码库 | large-repo-harness |

引用方：插件 sessionStart skill（`plugin/skills/kimi-base/SKILL.md` 第三步）与项目宪法种子（`.kimi-base/templates/AGENTS.md` 第三节）。改路由只改本文件。
