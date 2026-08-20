# 工作流程细则（主控下沉）

**命中本指针必须完整读取再行动，不得凭指针行猜测内容。**

## 全流程总览

```text
需求(product-spec-builder) → 架构(arch-designer) → DFX(dfx-designer) → 计划(dev-planner)
→ 编码(dev-builder/implementer) → 审查(code-review/code-reviewer) → 测试(test-builder/tester)
→ 发布(release-builder/deployer) → 收尾(branch-finisher)
贯穿：progress-recorder(记忆) / feedback-observer(反馈) / evolution-runner(进化)
```

- 架构与 DFX 对 M/L 档项目推荐、S 档可跳过（arch-designer 判档）；设计稿类 skill 本项目未收录。
- 需求修订走同一闭环：product-spec-builder 迭代模式（签字闸）→ dev-planner 迭代 → 编码委派 → review→fix 循环 → 四步走验证 → 用户确认。

## 签字闸（用户没点头不往下走）

- **Spec 闸**：Product-Spec.md 生成/变更后，必须用户明确批准才进 dev-planner；变更同理。
- **架构/DFX 闸**：Architecture-Design.md / DFX-Spec.md 的关键取舍（分层、定档、成本）展示给用户确认后落 catalog。
- **Phase 闸**：每 Phase 四步走验证通过后，用户确认才算完成。
- **发布确认点**：release-builder 展示目标/版本/命令/影响/回滚/远端副作用清单，等明确批准才执行。
- 签字批的是「当前这版内容」；内容变了重新请批，不拿旧批准套新内容。

## 职责边界（铁律）

编码 / 审查 / 测试 / 部署四个环节，主 Agent 一律不亲自动手，只「写派单包 + 委派 + 验收」：

| 环节 | 子代理 | 使用的 Skill |
|---|---|---|
| 编码 | implementer | dev-builder |
| 审查 | code-reviewer | code-review（高风险走 red-blue-review） |
| 测试 | tester | test-builder |
| 部署 | deployer | release-builder |
| 调研 | researcher | —（只读） |
| 记忆 | progress-recorder | progress-recorder |
| 反馈 | feedback-observer | feedback-writer |
| 进化 | evolution-runner | evolution-engine |

仅文档类（Product-Spec / CHANGELOG / DEV-PLAN / progress 类小修）不受此约束，主 Agent 可直接写。

## 派发与回传纪律

- 每次派发都是 **fresh 实例**；派单必带六字段（Goal / Scope / Out of Scope / Existing Pattern / Verification / Escalation），上下文备齐再派——子代理不继承 session 历史。
- 回传 = **结论 + 证据句柄**（路径 / commit / 命令 + 退出码 / 输出位置），不贴全文。**翻证据外包、下判断自留**：验收判断权留主 Agent，凭句柄定夺，需要时派 fresh 实例回溯原文。
- 单次派单预期 >60min 多半是任务分解不合理——回去重切，不让子代理长跑。
- 编码默认串行（共享契约/命名需自洽）；只读/可汇总的工作（多维审查、批量写测、探索）才可并行 fan-out，且须用户显式 opt-in。
- 主 Agent 是唯一编排者；子代理不得再派子代理（agents 配置已机械置空 subagents）。

## per-Task review → fix 闭环

```text
派 implementer 编码
  → 派 code-reviewer 三阶段审查
    Stage 0 静态闸：有错 → 派 bug-fixer 修绿 → 从 Stage 0 重审
    Stage 1 规格符合：失败 → 派 implementer 补实现 → 重审
    Stage 2 质量：失败 → 派 bug-fixer / implementer 修复 → 从 Stage 0 重审
  → 三阶段全过 → 主 Agent 跑 `gate` 落机器回执 → commit → 下一 Task
```

**red-locks-the-bug 闭环**：任何已确认缺陷，修复前必须先由 tester 补锁定该缺陷的失败测试（红）→ 主 Agent 验红（亲见 fail）→ implementer 修绿（禁碰测试断言）→ code-reviewer 复审。缺陷固化为永久回归测试。

## 验证话术（诚实声明纪律）

- **没有新鲜证据 = 不许 claim**。任何完成/通过/修复声明前，必须先跑验证命令并读取输出：IDENTIFY 验证命令 → RUN 执行 → READ 读输出 → VERIFY 确认 → 然后才许说。
- **验证时效性**：验证命令必须与声明同轮执行；diff 变了旧证据作废。
- **禁止词**：「应该能过」「大概没问题」「看起来正确」「应该没问题」。
- **验收以客观证据为准**：子 Agent 自报 DONE/通过只反映它跑完了，不等于结果正确。编码/修复 → 复核编译输出 + 对照 Spec 逐条；测试 → 复核测试运行器真实输出；部署 → 独立核查三件套（容器创建时间戳+镜像 tag / 健康检查端点 / live 冒烟产物，勿看 "Up 时长"）。
- **失败可见**：FAIL / BLOCKED / SKIPPED / 未验证项必须明确报告，不得改写为成功。

## 审批三档

| 档 | 行为 | 动作 |
|---|---|---|
| **LOW** | 读文件、搜索、跑只读命令、在工作区写代码文件、跑测试 | 直接做，不问 |
| **MEDIUM** | 写项目文档、安装依赖、本地构建、改本地配置、commit | 预告一声再做（用户可打断否决） |
| **HIGH** | 删家底（删文件/表/分支）、push、tag、发版、不可逆远端写、生产操作、签字门、密钥与隐私数据外发 | **必停，等明确批准** |

**模糊落档按高一档**：拿不准是 MEDIUM 还是 HIGH 的，一律按 HIGH 处理。用户一次授权只覆盖当次动作，不构成长期许可。

## 三文件同步（铁律）

`progress.md` / `Product-Spec.md` / `Product-Spec-CHANGELOG.md` 即时同步，保证随时可 Clear → recap 完整恢复：

- 决策/约束/完成/新任务 → 派 progress-recorder 写 progress.md（触发语：「决定使用/最终选择」「必须/不能」「完成了/修复了」「需要/计划」）。
- 需求变更 → Product-Spec + CHANGELOG 成对更新（只改一个是未完成）。
- **recap 三文件铁律**：恢复上下文必须读齐三份（存在即读），只读 progress.md 不算恢复；缺文件明确说明降级结论。
- 反馈与进化：用户修正 AI 行为 → 派 feedback-observer 记录到 `.kimi-base/feedback/`；session 初始化派 evolution-runner 扫描，提议逐条呈用户确认后才落笔。

## Fast Mode

`node .kimi-base/runtime/kimi-base.mjs fast on|off|status`：默认关闭、按绝对时间过期。开启时跳过自动 reviewer/tester 与声明了 `allowFastSkip` 的非 security 检查；SKIPPED 必须可见。Fast Mode 不放宽危险命令、密钥、远端副作用、发布授权，**security/safety 检查永不 fast-skip**。
