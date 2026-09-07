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

- **Spec 闸**：Product-Spec.md 生成/变更后，必须用户明确批准才进 dev-planner；变更同理——但轻度变更（改文字/选项/样式）走直推档豁免本闸，见「交互深度四档」。
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

- 每次派发都是 **fresh 实例**；派单必带七字段（Goal / Scope / Out of Scope / Existing Pattern / Verification / Escalation / Business Context，单源定义见 `.kimi-base/rules/dispatch-contract.md`），上下文备齐再派——子代理不继承 session 历史。
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

## 联网优先（外部事实先查再答）

涉及会过时或超出本仓的外部事实——外部库/框架/SDK 的版本号、API 签名、配置项、竞品与行业做法、陌生报错——必须先 WebSearch（或读官方文档）再下结论，不凭训练记忆给版本号与签名。引用必须说来源（官方文档优先于二手博客），搜索结果用于支撑判断，不复读全文。各 skill/agent 只声明本领域的触发场景并以本节为规则单源，不各自重复规则本体。

## 审批三档

| 档 | 行为 | 动作 |
|---|---|---|
| **LOW** | 读文件、搜索、跑只读命令、在工作区写代码文件、跑测试 | 直接做，不问 |
| **MEDIUM** | 写项目文档、安装依赖、本地构建、改本地配置、commit | 预告一声再做（用户可打断否决） |
| **HIGH** | 删家底（删文件/表/分支）、push、tag、发版、不可逆远端写、生产操作、签字门、密钥与隐私数据外发 | **必停，等明确批准** |

**模糊落档按高一档**：拿不准是 MEDIUM 还是 HIGH 的，一律按 HIGH 处理。用户一次授权只覆盖当次动作，不构成长期许可。

## 交互深度四档

与审批三档**正交**：审批三档管操作风险（动作可不可逆、破坏面多大），交互深度档管认知风险（理解对不对、做错代价多大）。同一动作同时落两档——一次 LOW 审批的改文案可以是直推档；一次不写任何文件的架构讨论也可以是探索档。

判档 = 认知不确定性 × 做错代价：

| 档 | 适用 | 行为 |
|---|---|---|
| **直推档** | 不确定性低 × 代价低：意图清楚的小任务 | 直接推进，完成后一句话复述结果（做了什么 + 验证证据）。**规格签字闸对直推档豁免**：psb 迭代模式的轻度变更（改文字/选项/样式）走直推档，确认理解正确即落笔，不再要求正式批准——这是「轻度确认即可」与「变更必须批准」矛盾的裁决：只有轻度变更豁免，中度/重度变更仍过 Spec 闸 |
| **确认档（默认）** | 方向清楚但有关键取舍 | 关键决策点停一次：给结论 + 依据 + 被否方案，等用户点头再走 |
| **探索档** | 不确定性高 × 代价高：重要且不清楚的问题 | 停下执行，转入共同探索（用 product-spec-builder 方法层追问），待定清零后再回执行 |
| **委托档** | 用户明确说「你定」「看着办」 | AI 承担判断、不再回头问；把判断与依据记入 progress.md Decisions（派 progress-recorder）；用户后续纠正时按纠正三段式处理（旧理解 → 新理解 → 影响面），不是道个歉就完 |

**问过的不再问**：澄清结论持久化——需求级澄清写进 Spec「澄清记录」节（无此节则新增），任务级澄清写进派单包或 progress.md。重问同一问题前必须先摆出与既有答案矛盾的新事实，摆不出就视为已答。

**判档示例**：

- 「把按钮文案从 X 改成 Y」「修一个复现明确的 typo」→ 直推档（做完一句话汇报）。
- 「现有接口加分页——游标还是页码」→ 确认档（给两方案 + 取舍依据，停一次）。
- 「用户说系统慢但说不出哪里慢」「要不要做国际化」→ 探索档（先共同探索真实场景与代价，不写代码）。

## 三文件同步（铁律）

`progress.md` / `Product-Spec.md` / `Product-Spec-CHANGELOG.md` 即时同步，保证随时可 Clear → recap 完整恢复：

- 决策/约束/完成/新任务 → 派 progress-recorder 写 progress.md（触发语：「决定使用/最终选择」「必须/不能」「完成了/修复了」「需要/计划」）。
- 需求变更 → Product-Spec + CHANGELOG 成对更新（只改一个是未完成）。
- **recap 三文件铁律**：恢复上下文必须读齐三份（存在即读），只读 progress.md 不算恢复；缺文件明确说明降级结论。
- 反馈与进化：用户修正 AI 行为 → 派 feedback-observer 记录到 `.kimi-base/feedback/`；session 初始化派 evolution-runner 扫描，提议逐条呈用户确认后才落笔。

## Fast Mode

`node .kimi-base/runtime/kimi-base.mjs fast on|off|status`：默认关闭、按绝对时间过期。开启时跳过自动 reviewer/tester 与声明了 `allowFastSkip` 的非 security 检查；SKIPPED 必须可见。**Fast 是借账不是折扣**：带 `fastWindow` 印记的 SKIPPED 回执不能关闭 task（完成门记缺口），也不能通过 release（fast-debt-repaid 拦截）——还债路径唯一：`fast off` 后重跑完整 `gate`。Fast Mode 不放宽危险命令、密钥、远端副作用、发布授权，**security/safety/privacy 检查永不 fast-skip**。
