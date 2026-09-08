# CHANGELOG

## v3.0.0（2026-09-08）

对标并超越 dsh-base/cc-base/codex-base 的 v3 重构（P0–P11，结构化对抗评审逐批 ACCEPT）：强度策略引擎（四档×12 轴、extends 只收紧、floor 只升不降、policyHash 绑证据）；Receipt v2 绑定面 + fast 证据贷款账本 + 可提交证据模式（证据可移植性为家族独有）；CLI 契约注册表；discover 真实仓健壮性（SCC 凝聚）；feedback 引擎化；沟通桥梁层（认知标注四态/交互深度四档/业务含义过链/记忆依据链）；三层反馈分级；渐进采用阶梯；棘轮持久化；安装器事务锁；自我 eval 套件。证据：421 行为测试 + selftest 27/27 + run-eval regression 20/20 全绿；release 八条件全 [x] READY。

### Added

- 强度策略引擎：`strength list/status/set/explain`；四内置档（explore/rapid/balanced/strict）× 12 封闭控制轴；extends 逐轴只收紧（STRENGTH_WEAKENING 配置期拒绝）；floor（risk/operation/attribute/path）只升不降；shadow 迁移模式；decision log；explore 档 completionMode=forbidden 阻断 task complete。
- Receipt v2：回执绑定 policyHash/engineHash/catalogHash（收紧即 stale exit 4）；fast 窗口证据贷款账本（DEFERRED 入哈希链、关窗/过期/轮转/截尾均不清债、唯一偿还=fresh PASS）；可提交证据模式（evidence.mode=committed，clone 验链直接通过，家族独有）。
- CLI 契约注册表（cli-contracts.mjs 单源派生 dispatch/help/flag 校验；重复/空值/吞 token 三类静默错误转 exit 1）。
- feedback 引擎化：`feedback record/list/scan/propose`（机器计数+聚类毕业候选+人确认落地）。
- 沟通桥梁层（软层）：认知标注四态（[确认]/[推断]/[建议]/[未知]，spec lint 机械检查）；product-spec-builder 方法层重写（向人学业务四线/答案解析器/情境复述收敛/纠正三段式）；交互深度四档（直推/确认/探索/委托）；派单第七字段 Business Context + 需求存疑回流通道；记忆依据链（Decisions 三字段+supersede 链）。
- 评审强化：authorship 机器执法（作者自审拒出 ACCEPT、无数据诚实标注）；静态发现入 review pack；review 消费强度策略轴。
- 三层反馈分级（matrix 检查 tier inner/middle/outer；protected 禁 outer）；渐进采用阶梯（discover --level L0-L3）；棘轮 bestEver 持久化；安装器 maintenance marker（wx 原子独占，install/upgrade/uninstall 三面）。
- 自我 eval 套件：tests/eval/ 23 任务 + audit/run-eval.mjs（regression 防回退入 CI，capability 爬坡不阻断）。
- CI：GitLab 模板变体；GitHub 模板定时空跑 + 汇总判定。
- nextStep 修复指令体（gate/quality/dod 的 FAIL/BLOCKED 全部带可执行修复命令）；quarantine 原语统一（损坏运行态隔离+记账，并发竞抢安全）。

### Fixed

- discover 真实仓四缺陷（重复模块/环不处理/tier 不重算/让位崩溃）——38.7 万行真实仓全链路（discover→lint 0 overlap→arch 零新债）走通。
- 账本与回执的 fail-open 面十个（伪造镜像/轮转清债/多塞键绕过/归档零鉴权/截尾灭迹等），评审五轮全部根因修复并红测+变异核查锁定。
- docs/COMMUNICATION-LAYER.md 与 docs/evals/p11-ab-test.md：软层审计取证与 A/B 情境检验（新版隐性需求召回 7/7 vs 旧版 5/7）。

## v2.0.0（2026-09-02）

对标并超越 dsh-base 的全仓重构（P1–P7c）。源布局=安装布局自托管；三面执法；评审/记忆/需求治理引擎化；退出码契约 v2。证据：188 行为测试（7 文件）+ selftest 16/16 全绿；catalog lint / arch check --scan / adr check / manifest --check / doctor / pack-check / spec lint（50 REQ）/ trace（100%）/ dod / sync-check 全 exit 0。

### Added

- **三面执法**（ADR-0002）：`.kimi-base/githooks/`（pre-commit 电池含 scan-secrets/scan-instructions、pre-push dod+gate、commit-msg lint）+ `.kimi-base/audit/` 五个独立审计脚本（禁 import 引擎）+ CI 电池与采纳者模板 `templates/github-gate.yml`；`install --hooks` 挂载。
- **结构化对抗评审引擎**（ADR-0003）：`review pack/start[--base]/blue/lens [--ad-hoc]/verdict/status/team/backlog`——九 lens 三阶段四剖面、属性收缩选拔、计算裁决、终审 ACCEPT 才写回执、backlog 持久。
- **记忆法动词**：`recap / invariants / archive / sync-check`；sessionStart 注入 invariants 摘要。
- **需求治理**：`spec lint / spec view / trace`（REQ↔代码·测试追溯门）、`rules-audit / skills-lint / agents-lint`。
- **规模化治理**：`catalog discover`（init-modules 退为废弃别名）、`cochange`、`budget`、`fleet lint/impact/status/recap`（ADR-0007）、`release` 发布就绪 composite、`dod` 静态电池（DOD_STEPS 单源）。
- 新增 ADR-0002~0007 六条决策记录。

### Changed

- **源布局=安装布局**（ADR-0005）：`template/` 消亡，载荷即 `.kimi-base/`+`.kimi-code/`；本仓自托管；安装器受管恒等映射+种子语义（缺失才落地、upgrade 不覆盖、uninstall 仅删未改动者）+事务回滚。
- 引擎 4712 行单文件拆为薄入口 + `lib/` 31 模块（共 32 文件 8416 行，零依赖 Node stdlib）；动词 25 → 40（含 help 与两个别名）。
- **退出码契约 v2**（ADR-0006）：0 干净 / 1 用法·违例 / 2 阻断 / 3 降级 / 4 陈旧；全动词严格 flag 校验；降级永不计绿；stale 独立成态。
- **privacy 入保护底线**（ADR-0004）：protected={security,safety,privacy}，永不豁免、永不 fast-skip，waiver 禁词面覆盖 reason/compensation。
- arch trend 棘轮改为逐指标历史最优（修掉继承自 cc-base 语义的 debt-swap 净零回弹洞）。
- 证据语义硬化：runtime 类证据时间窗、账本轮转带 anchor、receipt-fresh 认 range 评审回执。
- dod 把陈旧回执归级 STALE（可见不阻断）；release 拆分完整性（ledger-intact）与新鲜度（receipt-fresh）判定。

### Fixed

- fast 借账语义：带 fastWindow 印记的 SKIPPED 永远不能关闭 task；还债路径唯一（fast off + 完整 gate）。
- 继承缺陷清算：prewrite 对账腐化降级响亮留痕、pre-compact 文件锁、gate-audit 派生自分类器规则表、supervisor 退出码对齐、分类器 git 长选项/docker env-file 穿透、Windows 路径 location 正则。
- dsh 缺陷不搬（逐行精读发现，对策见 docs/CROSS-POLLINATION.md）：DIFF_EXCLUDED 自我陈旧化、backlog 随会话冲掉、非终审 ACCEPT 出证据、record-to-green 基线洗白、dod/release 清单双份漂移。

## v1.0.0（2026-08-13）

初版：双层架构（插件面+项目面）、25 动词单文件引擎、五性治理（security/safety 保护属性）、证据新鲜度绑定、架构防腐三件套、8 agents + 16 skills。融合 codex/cc/ccb/pi/cursor/opencode 六仓经验（台账见 docs/CROSS-POLLINATION.md）。
