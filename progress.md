# kimi-base 项目记忆

格式约定：Pinned（受保护，不可自动修订）/ Decisions（只追加）/ TODO / In Progress / Done（带证据指针）/ Risks & Assumptions / Notes。>100 条归档到 progress.archive.md（只增不删）。

## Pinned（必守铁律）

1. 证据优先：DONE、Bash 成功、validate 结构通过都不算质量通过；只有绑定当前 git fingerprint 的 gate receipt 算。
2. 绝不假绿：缺工具/缺命令/非 git 仓 = BLOCKED 或可见降级；SKIP 必须显式。
3. security 与 safety 永不豁免、永不 fast-skip；waiver 只豁免"跑不了"，不豁免"跑挂了"。
4. 治理退出必须留痕：none/minimal 定档要书面理由，waiver 要五要素，fast 要 TTL。
5. 不写第二套 Agent runtime；不修改 Kimi Code 内核；hooks 是护栏不是沙箱（fail-open 如实写文档）。
6. 非 kimi-base 项目（无 .kimi-base/harness.json）中一切 hook 与 sessionStart skill 必须静默。
7. 测试独立性：写测者 ≠ 被测作者；测试不许为迁就实现而改断言。

## Decisions（只追加，含被否方案与理由）

- 2026-08-13 分发形态定为「Kimi 插件（hooks+命令+路由 skill）+ 项目模板注入」双层。否决「纯项目注入」：Kimi 无项目级 hooks，纯注入失去机械闸门；否决「纯插件」：插件用户级生效会污染非治理项目，且项目资产（AGENTS.md/catalog）本就该随仓走。
- 2026-08-13 项目资产放 `.kimi-code/`（agents/skills）而非 `.agents/`：`.agents/` 是跨工具共享目录，避免与 codex-base 等同仓安装互相覆盖；Kimi 原生优先扫描 `.kimi-code/`。
- 2026-08-13 项目配置收敛到 `.kimi-base/harness.json` 单一配置源；catalog/matrix/adapters 独立文件（大仓 catalog 可能很大）。
- 2026-08-13 五性采用用户指定五属性（resilience/security/safety/privacy/reliability）为治理核心，扩展属性（availability/performance/maintainability）允许在 catalog 声明但非默认要求。否决八属性全集默认强制：认知负担大于收益（与 codex-base 拒绝理由一致）。
- 2026-08-13 多模型异构审查不移植（Kimi 单宿主），以红蓝对抗+多视角 lens+写测独立补偿，记录为已知弱化项。
- 2026-08-13 runtime 单文件零依赖（家族共识形态），supervisor 独立文件。
- 2026-08-13 hook 调度以 payload.cwd 定项目根（插件 hook 进程 cwd=插件根，不可依赖 process.cwd）。

## TODO

- [P1][OPEN][#7] 真实 60 万行仓库校准性能基线（当前为合成仓目标值）
- [P2][OPEN][#8] Windows 真实环境验证（ps1/Git Bash hooks）
- [P2][OPEN][#9] 插件经 /plugins install 实装后的端到端验证（hooks 真实触发）

## In Progress

- 无（v1.0.0 构建完成，进入使用反馈期）

## Done

- 六仓深度调研与 Kimi 官方文档核对完成。证据：docs/CROSS-POLLINATION.md、docs/CAPABILITY-MATRIX.md（2026-08-13）
- P2 架构定型：双层架构 + CLI 契约 + 五性模型。证据：Product-Spec.md REQ-001~030、docs/ARCHITECTURE.md（2026-08-13）
- P3 runtime 引擎：runtime/kimi-base.mjs（4712 行，23 动词+7 hook 事件）+ supervisor.mjs（448 行）+ 跨平台安装脚本。证据：`selftest` 15/15（2026-08-13）
- P4 模板资产：8 agents + 16 skills + 3 rules + 9 templates（template/，description lint 全过）
- P5 测试与插件胶水：tests/harness.test.mjs 37 用例 + plugin/skills + plugin/commands×8。证据：`node --test tests/harness.test.mjs` 37/37 通过（2026-08-13，Node 24）
- P6 集成验证（全部亲跑）：doctor/manifest --check/pack-check/selftest 全 exit 0；/tmp 端到端：缺证据完成门 exit 2（列 6 项缺口）→ gate→quality→complete 放行；改动后旧回执 stale 再拦；危险命令（wrapper 穿透/凭据跨管道外泄）exit 2、非标记项目静默 exit 0；arch 禁边检出→baseline 固化→放行；fast mode 2 条 SKIPPED 且 security 不跳过；security waiver 拒绝创建；Stop 保险丝实测 [2,2,2,0]；receipt verify 账本链完整
- P7 契约对齐：rules/skills/PROTOCOLS/ADR 全部对齐引擎真实契约（消灭 receipt write、arch record、quality attributes 等幽灵引用）；module-catalog 示例 layers 修正为最内层在前

## Risks & Assumptions

- Risk：Kimi hooks fail-open，脚本异常即放行 → Mitigation：分类器自身最小化+防御性编码；高危面叠加 permission rules；文档明示边界（docs/ISOLATION-PROFILES.md）。
- Risk：插件 commands/skills 全局可见造成他项目噪音 → Mitigation：sessionStart skill 首行即标记检查并静默；测试锁定惰性行为。
- Assumption：`subagents: []` 空列表语义为"禁止再派发"（Confidence: 高；依据官方文档"Allowlist…Omit to allow every type"的反向语义；待实装验证 #9）。
- Assumption：PreToolUse 的 tool_input 字段名与 Write/Edit 的 path 字段稳定（Confidence: 高；依据官方 hooks 文档示例）。

## Notes

- 家族供体仓库均在 /home/z00632348/code/ 下可读，移植以实际文件为准而非 README 宣传。
