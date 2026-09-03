# CHANGELOG

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
