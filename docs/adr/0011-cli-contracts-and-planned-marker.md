# ADR-0011：CLI 契约注册表 + 需求生命周期标记（planned）

状态：Accepted · 日期：2026-09-04 · 决策者：用户 + 主 Agent
Enforced-by: unit, manual:P2/P1 行为测试逐 verb 断言；planned 标记语义由 tests/spec.test.mjs 红测先行锁定

## 背景

两个独立但同源于"声明与执行漂移"的问题：

1. **cli.mjs 三注册手工同步**：HELP_VERBS、KNOWN_FLAGS、dispatch switch 是三份手工保持一致的注册信息（955 行单体）。cc-base 与 codex-base 都已证实严格 flag 白名单的价值：拼错 flag 静默跑错测量还会被记录成基线，而"子命令级可读 flag 表 + 未知 flag 拒 + selftest 双向钉死"能机械消除整类漂移。
2. **规格先行与 trace 100% 覆盖不可兼得**：v3.0 要求 Product-Spec 一次立全 REQ-051+（spec-first），但 trace 的覆盖率分母计入每条已声明 REQ，未实现的 REQ 没有测试引用会让 trace 长红——要么规格迁就实现（分批立项，spec 永远慢半拍），要么塞假引用（谎称已验）。codex v5 正是卡在"规格冻结，实施中"的尴尬态。需要 spec-anchored 的生命周期机制（Fowler SDD 三级框架中 spec-first → spec-anchored 的必要条件）。

## 决策

1. **CLI 契约注册表**：新增 `lib/cli-contracts.mjs`，每个 verb 一条冻结契约（usage / 位置参数上下界 / value·boolean flags / conflicts / requiresWith）；dispatch、help、flag 校验全部由契约表单源派生，cli.mjs 只剩路由。未知 flag / 重复 flag / 空值 → exit 1 并列出该 verb 合法 flag 集（承 ADR-0006 契约）。selftest 双向钉死：每个路由有契约、每个契约有路由。40 个既有 verb 名称与语义向后兼容，flag 表以行为测试先行锁定后再迁移。
2. **需求生命周期标记**：spec lint/trace 识别需求块内 `状态：planned(P<n>)` 标记——
   - planned REQ 仍须通过全部可判定性 lint（planned 不是写烂需求的许可证）；标记缺 phase 编号报 PLANNED_NO_PHASE（error）。
   - trace 把 planned REQ 排除出覆盖率分母（零 active 时覆盖率为空真 1），单独报告 planned 计数（可见不拦）。
   - planned REQ 被 tests/ 引用 → PLANNED_HAS_TESTS 警告：实现落地的同 commit 摘除标记，覆盖率即刻开始看管它。
3. 实现 Phase 的完成定义包含"摘除对应 REQ 的 planned 标记"，使 trace 门禁自动接管后续看护——规格立项与实现落地由机制缝合，不靠记性。

## 备选与拒绝理由

- 规格分批立项（每 Phase 补 REQ）→ 拒绝：spec 永远描述过去而非目标，v3.0 的"强度策略引擎"等旗舰设计无法在实现前被 lint 审定；且与已批准的 v3.0 计划（P1 立全量 REQ）冲突。
- 为未实现 REQ 先放空测试文件占位 → 拒绝：trace 只数引用不看断言，占位文件会把"有人验"谎报成绿。
- 契约表只收敛 help/flags、dispatch 保留 switch → 拒绝：两份注册仍是两份；单源派生才消除漂移类。
- planned REQ 跳过可判定性 lint → 拒绝：规格先行恰恰要求立项时就写清触发条件与验收，否则 planned 成为烂需求庇护所。

## 后果

- Product-Spec v3.0 可以一次立全 v3 需求并全部通过 spec lint，trace 只对 active 需求执法——spec-first 与门禁绿色第一次兼得。
- 新增 verb 的成本变成"一条契约 + 一组行为测试"，注册漂移在机制上消除。
