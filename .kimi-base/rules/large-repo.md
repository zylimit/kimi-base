# 大仓治理细则（主控下沉）

**命中本指针必须完整读取再行动，不得凭指针行猜测内容。**

本文件与治理引擎 `runtime/kimi-base.mjs` 的可执行契约保持一致；若引擎行为与本文件冲突，**以引擎实测为准并回改本文件**。

## 启用条件

- **项目标记** = 项目根存在 `.kimi-base/harness.json`（引擎自 cwd 向上查找；插件 hooks 以 payload.cwd 定位）。无标记目录中一切 hook 静默放行、零行为变化。
- **大仓能力开关** = `.kimi-base/module-catalog.json` 存在。catalog/matrix 缺失时 `impact`/`gate`/`arch` 等诚实降级（BLOCKED 或可见 note），绝不假绿。
- 小项目零负担：不建 catalog 则治理引擎只保留安全 hook 与任务账本。

## 退出码契约 v2（CLI 全局统一，无其他取值；hook outward 契约保持 0/2）

| 码 | 语义 |
| --- | --- |
| 0 | 成功 / PASS |
| 1 | 用法错误（含未知 flag、配置非法）或规则违例（`catalog lint`/`fitness`/`adr check`/`arch check`/`arch trend --gate` 发现违规） |
| 2 | 治理阻断：`gate` FAIL/BLOCKED、`task complete` 完成门缺口、`quality status` uncovered、`receipt verify` 篡改/断链/缺失/漂移、`doctor`/`pack-check`/`manifest --check`/install 失败 |
| 3 | 降级（freshness 绑定操作在非 git 仓：「降级：非 git 仓，无法测量」，绝不假绿）或引擎内部错误；`review` 的 no-change/无会话/NEEDS_MORE_EVIDENCE 也在此档 |
| 4 | 陈旧证据（`receipt verify`：链完好但回执指纹已移动，含 runtime 证据窗口过期；`review` 会话绑定的工作树/range.head 已移动） |

## module-catalog.json schema

顶层：`version`（=1）/ `layers[]` / `globalPaths[]` / `ignored[]`（带 reason）/ `modules[]`。

**layers 约定：最内层在前**（如 `["domain","app","infra"]`）；模块只允许依赖同层或更内层（目标 index ≤ 自身 index），反向即 `layer-direction` 违规。

Module 字段：`id`（kebab-case；`name` 形态会归一化）/ `paths[]`（glob 归属）/ `root` / `dependsOn[]` / `forbiddenDependencies[]`（永远不许 import——隐私/安全边界可执行化）/ `layer` / `provides[]`（裸包名前缀归属）/ `shared` / `owners[]` / `attributes{五性:档位}` / `contracts` / `capsule` / `tests` / `verification[]`。

配置期硬校验（非法即拒绝加载）：catch-all 裸 `**`（CATALOG_CATCH_ALL）、dependsOn/forbiddenDependencies 指向未知模块（DANGLING_DEP）、同一模块同边既声明又禁止（禁令赢）、档位 none/minimal 无书面理由（CATALOG_UNJUSTIFIED_TIER——退出治理是留痕决策）。

路径归类（catalog lint，每条 git tracked 路径必须有主）：归属优先级 **ignored > globalPaths > module > unmapped**（引擎实际顺序；`.kimi-base/**` 隐式全局）；多模块命中取最深 root、同深度即 OVERLAP。unmapped/global/truncated 一律对验证计划保守扩散（宁可全跑，不可漏测）。

## verification-matrix.json 与风险层

顶层：`version`（=1）/ `riskKinds`（可选）/ `checks[]`（必填）。

风险→检查集的两个合法来源（至少其一）：

- `matrix.riskKinds`：风险 → **kind** 列表（kind ∈ static/unit/integration/build/security/smoke）；
- `harness.json` 的 `quality.riskChecks`：风险 → **检查 id** 列表。

两者都要求：累积并集（high ⊇ medium ⊇ low）且 high 必含 security 维度，否则配置期拒绝。

check 字段：`id`（kebab-case）/ `kind` / `class`（仅允许 `"runtime"`：运行类证据，回执带 `validUntil` + `time-window-<N>h` 标签，窗口内不随指纹过期、过期即不 fresh）/ 执行体三选一且互斥（`command` shell 串 | `executable`+`args` 直执行 | `builtin` ∈ fitness/arch-check/adr-check/catalog-lint）/ `timeoutSec|timeoutMs` / `dependsOn[]` / `resourceLocks[]` / `platform[]` / `required` / `allowFastSkip` / `attributes[]`（认领五性证据）/ `runtimeValidityHours`（仅 runtime 类；缺省取 `quality.runtimeValidityHours`）/ `note`。**`command` 允许为空字符串：运行时按 BLOCKED 报（缺命令 = BLOCKED，绝不假绿）**。protected 检查（security/safety/privacy 属性或 security/safety kind）声明 `allowFastSkip` 在配置期直接拒绝（语法层面不可表示）。

## 四态质量门（gate）

- `PASS`：exit 0；`FAIL`：exit≠0；`BLOCKED`：缺命令/无法启动/超时/输出截断（坏测量按 BLOCKED）；`SKIPPED`：仅 fast mode + `allowFastSkip:true` + 非 protected。
- 聚合：任一 FAIL → FAIL；否则任一 BLOCKED → BLOCKED；全 SKIPPED → BLOCKED；否则 PASS。空计划 = BLOCKED。
- 每次执行写 receipt：绑定 task/fingerprint/risk/planHash/argvHash/证据哈希 + `contentHash` 防篡改，追加进哈希链账本（`chain = sha256(prev + '\0' + contentHash)`，断链 fail-closed）。长证据（>4000 字符）脱敏落 `state/evidence/`，回执只带摘要。
- `gate --risk R|--kind K|--dry-run`；`dependsOn` 闭包自动先跑；同 check 后续 FAIL 覆盖旧 PASS。

## 五性覆盖判定（quality status）

受影响模块声明的 critical/high 属性需 fresh PASS 认领证据：**反证压过佐证；声明未接线 = 可见缺口；SKIPPED 不覆盖也不反证**。uncovered → exit 2 → task complete / 发布闸阻断。waiver：quality waiver create/list；五要素 approver/reason/expiresAt/compensation + 绑 fingerprint + contentHash；对已执行 FAIL 与 protected 检查拒绝创建（跑挂了必须修，不能请假）；生效于 BLOCKED/SKIPPED 的降级留痕；过期/跨指纹/篡改自动失效。

## 结构化对抗评审（review）

命令面：`review start [--base <ref>]`（空 diff exit 3）→ `review blue`（stdin claims）→ `review lens <name> [--ad-hoc]`（stdin findings）→ `review verdict [--reviewer X]`；辅助：`review status` / `review team` / `review backlog add|list` / `review pack`。

- 团队选拔：catalog `review.lenses` 显式集优先，否则 `review.profile`（personal/team/production/regulated，默认 team）；属性收缩只缩不扩（受影响模块未把 lens 属性定档 ≥ low 即剔除并留因；correctness 永不剔除）。
- 裁决是计算的：blue 缺/前沿 lens 未报到 → exit 1；任一 error（含 ad-hoc）→ FIX_REQUIRED exit 2（达 `review.maxRounds` 触顶 → `escalate:true`，停止重试交人类）；应到 lens unable → NEEDS_MORE_EVIDENCE exit 3；否则 ACCEPT exit 0。**回执只在终审 ACCEPT 写入账本（kind:review）；消费者只认回执，不认 verdict 退出码。**
- 完成门接线：catalog 有 review 段且 `requireStructured !== false` 且任务 risk=high → 需要 fresh 终审 ACCEPT 回执；无 review 段 = 无新要求。
- backlog 独立持久（`state/review-backlog.json`，重开评审不冲掉）；受保护发现（security/safety/privacy 等禁词，启发式）永不可挂账；过期条目被 `risk scan` 标记。
- 细则（会话 schema/信封/退出码全表）见 `docs/PROTOCOLS.md` 第 11 节。

## 架构防腐三件套

- `arch check [--scan]`：声明图恒查（环/禁令赢/分层方向）；`--scan` 扫描真实 import 边（JS/TS/Py/Go/Java/Kotlin/C#/Rust/Ruby/PHP/Swift）对账——禁边 FAIL > 分层违规 FAIL > 未声明边 FAIL；声明但无实边 = warning 可见不拦；发现违规 exit 1；非 git 仓 = 降级 exit 3；未解析 import 如实计数。
- `arch baseline --write [--reason "..."]`：存量违规固化为 `.kimi-base/arch-baseline.json`（每条带 reason，**进 git 可评审**）；此后新债零容忍；已还清条目标 stale 催删——棘轮只紧不松。
- `arch trend --record|--gate`：漂移指标快照与棘轮门——当前指标对比**逐指标历史最优**（best-ever；debt-swap 净零回弹也拦），超越即 exit 1；无快照时 gate 通过并注明 `baseline:true`（先 --record 建立基线）。
- `adr check`：活跃 ADR 必须有 `Enforced-by:` 行；逗号分隔的引用必须是真实 matrix check id / fitness 规则 id / builtin（fitness/arch-check/adr-check/catalog-lint）或显式 `manual:` 前缀；幽灵引用 FAIL；状态行标记 superseded/deprecated/rejected/已废弃 的豁免。

## fitness（内置五规则文本级防线）

no-secret-literal(error) / no-pii-in-logs(error) / no-silent-failure(error) / no-unbounded-retry(warning) / no-unreferenced-deferral(warning，仅 safety≥high 模块)。同行注释 `kimi-base-ignore: <rule>` 抑制单条（留痕）。默认扫 git 变更面；非 git 且无 `--path` = 降级 exit 3；error 级命中 exit 1。有界扫描（2000 文件/1MB 单文件/200 命中上限）。

## 影响分析与上下文

- `impact <paths...> | --git [--risk R]`：变更→模块→反向依赖闭包→检查计划（planHash 含 risk）；`--git` 在非 git 仓 = 降级 exit 3，不伪造精确影响。
- `context pack [--budget N] [--focus "g,g"]`：预算化最小上下文包；DENY 清单（.env/*.pem/*.key/id_rsa/.ssh/.aws/*secret* 等）永不入包；装不下进 omitted 显式报告；输出 packHash。

## 记忆法与需求追溯（记忆法动词 + spec 族）

- `recap [--budget N]` / `invariants`：派生式恢复视图（现算 Position，不信摘要；缺 progress.md exit 3）与 ≤1200 字符铁律+实时状态（压缩后重读）；sessionStart 横幅默认附 invariants 摘要（`hooks.injectInvariants`）。
- `archive [--apply] [--keep-done N] [--keep-notes N]`：progress.md 超预算（Done>40 / Notes>30 / >24000 字节）时最旧条目移入 progress.archive.md（默认 dry-run；只增不删，活体留指针行）。
- `sync-check [--staged] [--paths a,b]`：三文件同步机械执法——MEMORY_BEHIND_CODE / SPEC_WITHOUT_CHANGELOG → exit 1；非 git 无 --paths → exit 3；纯文档放行。
- `spec lint` / `trace` / `spec view [--paths a,b|--all] [--budget N]`：需求可判定性 lint（error exit 1）、需求→测试覆盖门禁（coverage ≥ spec.minCoverage，默认 1.0；代码/测试悬空引用 exit 1，文档悬空只报告；只扫 REQ/NFR 声明族）、预算化需求摘要（省略显式点名）。
- `rules-audit [--files a,b]`：宪法规则执法率（enforced/declared-prompt-only/unenforced）；默认纯建议，`rulesAudit.maxUnenforced` 设数字后超限 exit 1。
- `skills-lint` / `agents-lint`：`.kimi-code/skills` 契约（name==目录、description、体积、重名）与根 AGENTS.md 体积预算（>16000 字节 error）；error → exit 1。

## hooks 接线（插件 manifest → `hook <event>`）

| 事件 | 行为 |
| --- | --- |
| `pre-tool-use-bash` | 危险命令分类：deny 恒拦（rm -rf/git reset --hard/git clean/mkfs/fork 炸弹/push --force…）；review 默认拦（git push/curl\|sh/凭据外发含跨管道），`hooks.reviewAction=warn` 可降级为提示。穿透 sudo/env/timeout/嵌套 sh -c。 |
| `pre-write` | 写前对账：active task owned 路径被任务外改动 / 越界写（仓外、.git）/ 敏感文件（.env、私钥）→ exit 2 |
| `stop` | 完成门：工作树有代码改动但缺 fresh receipt 或 progress.md 未同步 → exit 2；同一指纹连拦 `hooks.stopMaxBlocks`（默认 3）次后放行并醒目提示欠账（保险丝） |
| `prompt-submit` | 修正信号关键词（`feedback.signalKeywords` 可配）→ stdout 提醒记录 feedback |
| `subagent-stop` | "勿信自报、核客观证据"验收提醒 |
| `pre-compact` | 写 `state/compaction-note.json`（baseCommit/活跃任务/未完成检查） |
| `session-start` | 会话横幅（任务/fast/待验证）+ 写会话基线 |

一切拦截记 `state/gate-log.jsonl`；`gate-audit` 对照台账审计死闸——从未拦过的闸要么拿证据要么撤掉。

## 运行态文件（`.kimi-base/state/`，一律 git-ignored）

`tasks.json`（单 active 任务 + ownedPaths 哈希基线）/ `receipts/` / `ledger.jsonl`（超 `retention.ledgerMaxEntries` 轮转为 `ledger-archive-<ts>.jsonl` + anchor 续链）/ `evidence/` / `waivers.json` / `fast-mode.json`（expiresAt/expiresEpoch 自动过期）/ `compaction-note.json` / `gate-log.jsonl` / `arch-trend.json` / `review/session.json`（评审会话）/ `review/review-pack-*.md`（证据包）/ `review-backlog.json`（评审挂账，跨会话持久）/ `install-receipt.json` / `supervisor/`。例外：`.kimi-base/arch-baseline.json` **进 git**（带 reason 的存量债登记，可评审）。

## 性能预算（600k 设计目标）

glob 编译缓存；`git ls-files -z`（NUL 分隔，非 ASCII 文件名安全）优先于目录遍历；`maxTrackedPaths`（默认 10 万，`catalog.maxTrackedPaths` 可覆盖）截断按坏测量处理；`selftest` 内置规模冒烟。实测锚点：500 文件合成仓 catalog lint ≈64ms。
