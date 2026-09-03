// lib/cli.mjs —— CLI 帮助与分发

import path from 'node:path';
import process from 'node:process';
import { doctorCommand, isSourceRepo, manifestCommand, packCheckCommand } from './admin.mjs';
import { adrCheckRun, archBaselineWrite, archCheckRun, archTrend } from './arch.mjs';
import { assessBudget } from './budget.mjs';
import { lintCatalog } from './catalog.mjs';
import { cochangeAnalysis } from './cochange.mjs';
import { findProjectRoot, loadContext, requireProjectRoot } from './config.mjs';
import { buildContextPack, impactAnalysis } from './context.mjs';
import { HarnessError, TOOL_VERSION, csv, nowIso, parseCliArgs, usageError } from './core.mjs';
import { discoverCatalog, discoverWrite, initModulesAlias } from './discover.mjs';
import { fastModeSet } from './fast.mjs';
import { runFitness } from './fitness.mjs';
import { fleetImpact, fleetLint, fleetRecap, fleetStatus, requireFleet } from './fleet.mjs';
import { runGate } from './gate.mjs';
import { dispatchHook } from './hooks.mjs';
import { gateAudit, retentionPrune, riskScan, runDod } from './hygiene.mjs';
import { assertInstallSource, applyInstallPlan, applyUninstallPlan, assertSafeTarget, buildSourceManifest, mountGitHooks, planInstall, planUninstall } from './installer.mjs';
import { archiveProgress, invariantsDigest, recap, syncCheck } from './memory.mjs';
import { INSTALL_RECEIPT_REL, TASKS_FILE } from './paths.mjs';
import { attributeCoverage, completionGate, waiverCreate, waiverList } from './quality.mjs';
import { releaseReadiness } from './release.mjs';
import { REVIEW_STAGES, backlogAdd, backlogList, recordBlue, recordLens, reviewPack, reviewStart, reviewStatus, reviewTeam, reviewVerdict, stageOfLens } from './review.mjs';
import { agentsLint, rulesAudit, skillsLint, specLint, specView, traceRequirements } from './scan.mjs';
import { selftestCommand } from './selftest.mjs';
import { updateState } from './state.mjs';
import { emptyTasks, getActiveTask, readTasks, taskCancel, taskStart } from './tasks.mjs';
import { receiptVerify } from './verify.mjs';

const HELP_GLOBAL = `kimi-base 治理运行时（${TOOL_VERSION}）

用法：node .kimi-base/runtime/kimi-base.mjs <verb> [args] [--project <dir>]
项目根：含 .kimi-base/harness.json 的目录（自 --project 或 cwd 向上查找）。
退出码契约 v2：
  0=成功/PASS；1=用法错误（含未知 flag）或规则违例（catalog lint/fitness/adr/arch 发现违规）；
  2=治理阻断（gate/完成门/quality status/篡改·断链·缺失/doctor/pack-check/manifest/install）；
  3=降级（非 git 仓无法测量，绝不假绿）或引擎内部错误；4=陈旧证据（receipt verify 指纹已移动）。
hook  outward 契约保持 0（放行）/2（拦截）。

动词：
  install <target> [--dry-run] [--hooks]     事务安装 .kimi-base/+.kimi-code/ 复制面到目标项目
  upgrade <target> [--dry-run] [--hooks]     事务升级（定制文件写 *.kimi-base-new 旁路）
  uninstall <target> [--dry-run]   事务卸载（定制文件保留）
  manifest --write|--check         生成/校验 FRAMEWORK-MANIFEST.json（复制面白名单）
  doctor [target]                  安装完整性自检（必需文件/哈希/frontmatter/rules/JSON）
  pack-check                       发布面审计（无 state/私密 feedback/旁路/泄漏）
  task start --goal G --owned "g,g" --risk low|medium|high
  task status | complete | cancel  任务账本（单 active；完成门缺口 exit 2）
  gate [--risk R] [--kind K] [--dry-run]   四态质量门（PASS/FAIL/BLOCKED/SKIPPED）
  quality status                   五性覆盖判定（critical/high 缺口 exit 2）
  quality waiver create --check K --approver X --reason R --expires ISO --compensation C
  quality waiver list              质量豁免（protected 永不可豁免）
  waiver create|list               quality waiver 的顶层别名（两种叫法都合法）
  arch check [--scan]              声明图 + 真实 import 边对账（违规 exit 1）
  arch baseline --write [--reason R]   存量债务固化（每条带 reason）
  arch trend --record|--gate       漂移棘轮（对比逐指标历史最优；回弹 exit 1）
  adr check                        ADR Enforced-by 幽灵引用 exit 1
  catalog lint                     每条 tracked 路径必须有主；拒 catch-all（违规 exit 1）
  fitness [--path p1,p2]           内置五规则文本扫描（error 级命中 exit 1）
  impact <paths...> | --git        影响分析（反向依赖闭包 + 检查计划）
  context pack [--budget N] [--focus "g,g"]   预算化上下文包（DENY 清单永不入包）
  receipt verify                   账本哈希链 + 证据重哈希（篡改/断链 exit 2；陈旧 exit 4）
  review start [--base R]          开启结构化对抗评审会话（绑定指纹；空 diff exit 3）
  review blue / lens <n> [--ad-hoc] / verdict / status / team / backlog add|list / pack
                                   Blue 自证 → 各 lens 报到 → 计算裁决（终审 ACCEPT 才写回执）
  fast on [hours]|off|status       限时质量旁路（默认 24h；protected 免疫）
  risk scan                        主动风险识别（腐化/stale/脏树/死锁残留）
  gate-audit                       死闸审计（从未拦过的闸要拿证据或撤掉）
  retention prune [--dry-run]      证据/上下文按保留策略销毁
  hook <event>                     hook 调度器（pre-tool-use-bash/pre-write/stop/
                                   prompt-submit/subagent-stop/pre-compact/session-start）
  init-modules [--write]           （已废弃别名，转发 catalog discover）生成 module-catalog 骨架
  catalog discover [--write] [--depth N]   从仓库事实推导 catalog 草案（目录分组+真实 import 边+
                                   tier-N 分层+命令检测；riskTier/forbidden 不猜，进 needsDecision；
                                   已有 catalog 时 --write 写 *.draft.json；无可提案 exit 3）
  cochange [--limit N] [--min-pairs N] [--ratio F]
                                   git 历史共变耦合：BOUNDARY_SUSPECT（无声明边）exit 1；
                                   accepted 三元组降级 warning；<30 个有效提交 = LOW_CONFIDENCE
  budget [--staged|--baseline ref] 变更预算门（harness.json budget 段；超限 exit 1，未配置 exit 3）
  fleet lint|impact|status|recap [--fleet path] [--deep] [--budget N]
                                   仓群契约治理（fleet.json 组级文件；lint 违例 exit 1，未知契约 exit 3）
  release                          发布就绪 composite（阻断项不满足 exit 2；永不打 tag/push/建分支）
  recap [--budget N]               派生式恢复视图（现算状态，不信任何摘要；缺 progress.md exit 3）
  invariants                       不可豁免铁律+实时状态（≤1200 字符；压缩后/阶段边界重读）
  archive [--apply] [--keep-done N] [--keep-notes N]
                                   最旧 Done/Notes 归档进 progress.archive.md（默认 dry-run；只增不删）
  sync-check [--staged] [--paths a,b]  三文件同步执法（MEMORY_BEHIND_CODE/SPEC_WITHOUT_CHANGELOG exit 1）
  spec lint                        需求可判定性 lint（规范词/触发/度量/验收/占位符/重复 id；exit 1）
  spec view [--paths a,b|--all] [--budget N]   预算化需求摘要（省略显式报告）
  trace                            需求→测试追溯门禁（覆盖率不足/代码·测试悬空引用 exit 1）
  rules-audit [--files a,b]        宪法执法率审计（默认纯建议；rulesAudit.maxUnenforced 超限 exit 1）
  skills-lint                      .kimi-code/skills 契约（name==目录/description/体积/重名；error exit 1）
  agents-lint                      根 AGENTS.md 必备与体积预算（>16000 字节 exit 1）
  dod                              Definition of Done 静态电池（catalog/skills/agents/spec/adr/
                                   fitness --all/trace/receipt verify/arch check；任一 FAIL exit 2，
                                   仅降级 exit 3）
  selftest                         运行时自身冒烟
  help                             本帮助

每个动词支持 --help 查看细则。未知 flag 一律 exit 1 并列出该动词的合法 flag。`;

const HELP_VERBS = {
  install: `install <target> [--dry-run] [--hooks]\n  把 <源仓>/.kimi-base/ 与 .kimi-code/ 复制面事务性安装进 target（源布局=安装布局）；\n  种子配置（harness/module-catalog/verification-matrix 的 example、AGENTS.md）仅缺省时写入。\n  staging + 逐文件备份 + post-hash 校验 + 失败逆序 rollback。\n  --hooks：安装后挂载第二道闸——git config core.hooksPath .kimi-base/githooks\n  + 三钩子 chmod 755 + git add --chmod=+x（目标非 git 仓 = 响亮降级，不回滚安装）。\n  故障注入：KIMI_BASE_INSTALL_FAIL_AFTER=<n>（测试用）。\n  写 .kimi-base/state/install-receipt.json。`,
  upgrade: `upgrade <target> [--dry-run] [--hooks]\n  LF 归一化 SHA-256 区分框架基线与用户定制：\n  未定制→安全升级；已定制→保留并写 <file>.kimi-base-new；obsolete 仅未定制才删。\n  --hooks：同 install——（重）挂载 core.hooksPath 并刷新三钩子可执行位。`,
  uninstall: `uninstall <target> [--dry-run]\n  仅删除与安装清单哈希一致的文件；用户定制的一律保留并列出。`,
  manifest: `manifest --write|--check\n  生成/校验源仓 FRAMEWORK-MANIFEST.json（.kimi-base/+.kimi-code/ 复制面稳定资产；\n  排除 state/、源仓自身治理配置、*.kimi-base-new、私密 feedback）。`,
  doctor: `doctor [target]\n  自检安装完整性：必需文件存在、manifest 哈希比对、agents/skills\n  frontmatter 形状（name kebab-case、description ≤180）、rules 指针、JSON 可解析。\n  无参时自 cwd 向上找项目根；对源仓自动切换为源仓模式。error → 非零退出。`,
  'pack-check': `pack-check\n  发布面审计：无 state/、无私密 feedback、无 *.kimi-base-new、manifest 完整；\n  泄漏扫描（token/私钥/个人路径正则）命中即失败。`,
  task: `task start --goal "目标" --owned "glob,glob" --risk low|medium|high\n  task status | task complete | task cancel\n  单 active 任务；start 对 ownedPaths 做 SHA-256 基线快照；\n  complete 执行完成门：风险层 required kinds 全部 fresh receipt，缺口 exit 2。`,
  gate: `gate [--risk low|medium|high] [--kind static|unit|integration|build|security|smoke] [--dry-run]\n  风险累积并集：high ⊇ medium ⊇ low。四态 PASS/FAIL/BLOCKED/SKIPPED。\n  缺命令=BLOCKED；空计划=BLOCKED；SKIPPED 仅 fast mode + allowFastSkip + 非 protected。\n  每次执行写 receipt（绑 task/fingerprint/risk/argvHash/证据哈希）并入哈希链账本。`,
  quality: `quality status\n  五性覆盖判定：模块定档 critical/high 的属性需 fresh PASS 认领证据；\n  反证压过佐证；声明未接线即缺口；SKIPPED 不覆盖也不反证。uncovered → exit 2。\n  runtime 类检查（matrix check 声明 "class":"runtime"）的回执带 validUntil 与\n  time-window-<N>h 标签：时间窗内不随树指纹过期，窗口过期即不 fresh。\nquality waiver create --check K --approver X --reason R --expires ISO --compensation C\n  禁词（security/safety/privacy/pii/secret/credential/destructive/隐私/个人信）拒绝；已执行 FAIL 永不可豁免；\n  过期/跨 fingerprint 自动失效。\nquality waiver list  列出全部 waiver 及其有效性。`,
  arch: `arch check [--scan]\n  声明图（环/禁令/分层方向）恒查；--scan 扫描真实 import 边（JS/TS/Py/Go/Java/\n  Kotlin/C#/Rust/Ruby/PHP/Swift）对照声明图。发现违规 exit 1；非 git 仓 = 降级 exit 3（无法测量）。\narch baseline --write [--reason "..."]\n  存量违规固化为 .kimi-base/arch-baseline.json（每条带 reason，进 git 可评审）；\n  新债零容忍；已还清条目标 stale 要求删除。\narch trend --record|--gate\n  漂移指标快照与棘轮门：当前指标对比逐指标历史最优（best-ever），回弹 exit 1；\n  无快照时 gate 通过并注明 baseline:true（先 --record 建立基线）。`,
  adr: `adr check\n  扫描 docs/adr/*.md（或 harness.json adrDir）：活跃 ADR 必须有 Enforced-by: 行，\n  引用必须是真实 check id / fitness 规则，或显式 manual: 前缀；幽灵引用 exit 1。`,
  catalog: `catalog lint [--paths a,b]\n  每条 git tracked 路径必须归属某 module / globalPaths / 带 reason 的 ignored；\n  拒绝 catch-all（裸 **）；OVERLAP/DANGLING_DEP/UNJUSTIFIED_TIER 全拦（exit 1）。\n  非 git 仓且无 --paths = 降级 exit 3。\ncatalog discover [--write] [--depth 2]\n  从仓库事实推导 catalog 草案：源码目录分组（≥2 文件成组，顶层目录兜底）、\n  真实 import 边推导 dependsOn、tier-N 位置分层（tier-1 最内层=无依赖基础层）、\n  构建清单命令检测（package.json/pyproject/go.mod/Cargo/Makefile）、\n  生产源码属性信号提案（封顶 high，≥2 文件或 ≥2 词才成提案，测试夹具不触发）。\n  猜不了的字段（属性档位/forbiddenDependencies/层名/矩阵接线）进 needsDecision，绝不替人决定。\n  --write：已有 catalog 写 module-catalog.draft.json，否则写 module-catalog.json。\n  无可提案（非 git/空树/无目录成组）→ exit 3。init-modules 是废弃别名，转发本命令。`,
  fitness: `fitness [--path p1,p2] [--staged] [--all]\n  内置五规则：no-secret-literal(error)、no-pii-in-logs(error)、no-silent-failure(error)、\n  no-unbounded-retry(warning)、no-unreferenced-deferral(warning，safety>=high 模块)。\n  抑制：同行注释 kimi-base-ignore: <rule>（留痕）。error 级命中 exit 1。\n  扫描面优先级：--path > --all（全仓 tracked∪未跟踪，dod 用）> --staged（暂存区，pre-commit 用）\n  > 默认工作树变更面；非 git 且无 --path = 降级 exit 3。`,
  impact: `impact <paths...> 或 impact --git [--risk R]\n  变更路径→模块归属→反向依赖闭包→受影响检查计划（planHash 含 risk）。\n  unmapped/shared/global/截断 → 保守扩散到全模块（宁可全跑不可漏测）。`,
  context: `context pack [--budget 60000] [--focus "glob,glob"]\n  预算化最小上下文包：focus+impact 选面；DENY 清单（.env/*.pem/id_rsa/.ssh/.aws/\n  *.key/*secret*）永不入包；装不下的进 omitted 显式报告；输出含 packHash。`,
  receipt: `receipt verify\n  证据账本哈希链校验（chain=sha256(prev+contentHash)），含轮转 anchor 跨段续链；\n  证据文件重哈希。篡改/断链/缺失/漂移 fail-closed → exit 2；\n  链完好但回执指纹已移动（陈旧证据）→ exit 4。`,
  review: `review start [--base <ref>]     开启评审会话：绑定当前指纹（diffHash）；空 diff → exit 3（no-change）。\n  --base 进入 range 模式：hash=sha256(git diff <ref>...HEAD)，HEAD 不变即有效。\n  重开时上一轮裁决摘要进 lineage（跨轮存活）后重新绑定。\nreview blue                     stdin {"claims":[{"claim","evidence"}]}：作者自证（只作靶子）；\n  缺 claim/evidence 整批拒绝 exit 1；会话陈旧 exit 4。\nreview lens <name> [--ad-hoc]   stdin {"findings":[{"severity","message","location"?,"reproduction"?}],\n  "unable"?,"unableReason"?}。severity ∈ error|warning|info；每条 finding 必须有\n  location（:行号 结尾，兼容 Windows 路径）或 reproduction，一条非法整批拒绝 exit 1。\n  非召集 lens 须 --ad-hoc（额外证据，不门控，error 仍计入裁决）；阶段门控越级拒报（stageGated:true）。\nreview verdict [--reviewer X] [--notes T]   裁决是计算的：阻断（blue 缺/前沿 lens 未报到）exit 1；\n  任一 error → FIX_REQUIRED exit 2；应到 lens unable → NEEDS_MORE_EVIDENCE exit 3；否则 ACCEPT exit 0。\n  round=lineage+1；FIX_REQUIRED 达 maxRounds（catalog.review.maxRounds，默认 3）→ escalate:true。\n  回执只在 ACCEPT 且终审时写入账本（kind:review）；消费者只认回执，不认本退出码。\nreview status                   会话摘要（阶段进度/已报/未报/backlog 结转/裁决）；无会话 exit 3。\nreview team                     打印召集 lens（含阶段）+ 剔除 lens（含原因）+ 生效剖面。\nreview backlog add              stdin {owner,expiry,summary,lens,location?}；expiry 须未来；\n  summary 命中 security|safety|privacy|pii|secret|credential|密码|密钥|凭据 → 拒绝 exit 1\n  （启发式拦截，非保证）。backlog 存 state/review-backlog.json，跨会话存活。\nreview backlog list             全部条目，过期者标记。review pack\n  证据包：base（最新 tag→origin/main→HEAD~1→根提交）、commit 清单、diffstat、\n  删除审计、未跟踪文件、完整 diff（>800 行溢出到 diff-<epoch>.patch）；\n  写 state/review/review-pack-<epoch>.md。非 git → exit 3。`,
  fast: `fast on [hours=24] | fast off | fast status\n  限时质量旁路（.kimi-base/state/fast-mode.json，expires_epoch）。\n  protected 属性/kind（security/safety/privacy）免疫；每个 skip 留痕。\n  fast 是借账不是折扣：带 fastWindow 印记的回执不能关闭 task/release；\n  还债路径唯一——fast off 后重跑完整 gate。`,
  risk: `risk scan\n  主动风险识别：状态腐化隔离、账本断链、FAIL 连击、stale 锁、fast 过期、\n  脏树规模、证据膨胀、stale baseline。按严重度输出。`,
  'gate-audit': `gate-audit\n  对照 gate-log.jsonl 审计每个 hook/规则历史上是否真的拦过：\n  从未拦过的闸要么拿证据要么撤掉。`,
  retention: `retention prune [--dry-run]\n  按 harness.json retention 策略销毁过期 evidence/context；\n  保护当前 receipt 引用的证据。`,
  hook: `hook <event>（插件 hooks 调这里；stdin 读 JSON，payload.cwd 定项目根）\n  非 kimi-base 项目（无 .kimi-base/harness.json）静默 exit 0。\n  事件：\n    pre-tool-use-bash  危险命令分类器（deny 恒拦；review 默认拦，reviewAction=warn 降级提示）\n    pre-write          写前对账（owned 基线偏离/越界/敏感文件 → exit 2）\n    stop               完成门（有改动但缺 fresh receipt 或 progress.md 未同步 → exit 2；保险丝×N）\n    prompt-submit      修正信号关键词 → stdout 提醒（exit 0）\n    subagent-stop      "勿信自报、核客观证据"提醒（exit 0）\n    pre-compact        写 .kimi-base/state/compaction-note.json\n    session-start      会话横幅 + 写会话基线`,
  'init-modules': `init-modules [--write]\n  已废弃别名：转发 catalog discover（语义完全并轨）。请改用 catalog discover [--write]。`,
  cochange: `cochange [--limit 500] [--min-pairs 3] [--ratio 0.5]\n  解析 git log --no-merges --name-only 测量模块共变耦合：\n  触碰 >8 模块的提交按横扫排除（如实计数）；coupling = 共变次数 / min(commitsA, commitsB)；\n  共变 ≥ min-pairs 且 coupling ≥ ratio 的对子：无声明边 → BOUNDARY_SUSPECT error（exit 1）；\n  有声明边 → HIGH_COUPLING warning；命中 catalog.cochange.accepted 三元组 → ACCEPTED_COUPLING warning。\n  可分析提交 < 30（cochange.minSample 可调）→ LOW_CONFIDENCE warning（exit 0，结果是提示不是测量）。\n  从不共变的模块列为抽仓候选。非 git / 无提交历史 → exit 3。`,
  budget: `budget [--staged | --baseline <ref>]\n  变更爆炸半径预算门：changedFiles / changedLines（numstat added+removed）/ modulesTouched / newFiles（未跟踪）\n  对照 harness.json budget 段（maxChangedFiles/maxChangedLines/maxModules/maxNewFiles，全可选正整数）。\n  任一超限 → exit 1 并逐指标报告：超出预算意味着拆分变更或升级——永不靠放宽预算消红。\n  未配置 budget 段 → exit 3（未激活不是通过）。非 git → exit 3。`,
  fleet: `fleet lint                     仓群清单 lint（NO_REPOS/DUPLICATE_REPO/DANGLING_CONSUME/\n  DEPRECATED_WITHOUT_SUNSET/CONTRACT_MULTIPLE_OWNERS/CONSUMING_RETIRED/SUNSET_PASSED 等 error → exit 1；\n  NO_OWNER/REPO_NOT_GIT/CONTRACT_WITHOUT_ADR/ORPHAN_CONTRACT/CONTRACT_CYCLE 等 warning）。\nfleet impact <contract>        契约变更波及面：直接消费者 + 经消费者所供契约的 BFS 传递闭包；\n  coordinationCost = 波及仓数 + 1（必须一起发布的仓数——这个数字就是决策）。未知契约 → exit 3 + 已知清单。\nfleet status [--deep]          逐仓 spawn 各自引擎的 doctor（超时 120s，KIMI_BASE_ROOT 钉根）；\n  --deep 加跑 dod（600s）。任一仓有问题 → exit 1 逐仓分列。\nfleet recap [--budget 8000]    逐仓 recap --budget 700 取前 5 条 dash 行；总量 ≤ 预算。\nfleet.json 定位：--fleet <path> > KIMI_BASE_FLEET > 自 cwd 向上逐级。找不到 → exit 3（单仓模式）。`,
  release: `release\n  发布就绪 composite：静态电池（与 dod 共享 DOD_STEPS 单源）+ fast 窗口已关 + fast 欠账已还\n  + 账本链完好（receipt verify）+ 当前指纹存在 fresh 回执 + sync-check 干净 + 评审 backlog 无过期。\n  建议项（不阻断）：risk scan。任一阻断项不满足 → exit 2 并逐项列出；全满足 → exit 0 READY。\n  本命令永不打 tag、永不 push、永不建分支——发布是 HIGH 级人工动作，这里只组装证据。`,
  recap: `recap [--budget 6000]\n  派生式恢复视图：Position（分支/未提交数/活跃任务/最近 gate/fast 窗口，全部现算）\n  + progress.md 的 Pinned(12)/In Progress(8)/TODO P0·P1(各 10)/Decisions(末 5)/Done(首 6)/\n  Risks(8) + risk scan 衰变信号。条目裁剪 200 字符；总量 ≤ 预算且截断显式标注。\n  不信任何压缩摘要。缺 progress.md → 降级 exit 3。`,
  invariants: `invariants\n  不可豁免铁律（证据优先/绝不假绿/保护底线/hooks 是护栏/三文件同步）\n  + 实时状态（活跃任务/fast 窗口/最近 gate/账本断链），≤1200 字符。\n  压缩后与每个阶段边界重读——压缩不纠偏。sessionStart 横幅默认附带本摘要\n  （hooks.injectInvariants 可关）。`,
  archive: `archive [--apply] [--keep-done 40] [--keep-notes 30]\n  progress.md 的 Done 超 keep-done 或 Notes 超 keep-notes 或文件 >24000 字节时，\n  把最旧（段尾）Done/Notes 条目移入 progress.archive.md 的 ## Archived <date> 段，\n  活体文件留指针行。默认 dry-run；归档条目只增不删、永不改写。`,
  'sync-check': `sync-check [--staged] [--paths a,b]\n  三文件同步执法：governed 模块路径变更而 progress.md 未进改动集 → MEMORY_BEHIND_CODE；\n  Product-Spec.md 变更而 Product-Spec-CHANGELOG.md 未同改 → SPEC_WITHOUT_CHANGELOG。\n  governed = catalog 归类为模块的路径（globalPaths 不算）；纯文档变更放行。\n  默认取工作树变更面（staged+unstaged+untracked）；--staged 只看暂存区。\n  违例 exit 1；非 git 且无 --paths → 降级 exit 3。`,
  spec: `spec lint\n  需求可判定性：id 形如 REQ-001 / REQ-<域>-001 / NFR-001（裸形式与领域形式都合法）。\n  块 = id 行起 14 行。NOT_NORMATIVE（缺 SHALL/MUST/必须/不得/应当）/NO_METRIC（NFR 缺\n  数字+单位）/NO_ACCEPTANCE（缺 验收/Acceptance/Given/Verification/验证）/PLACEHOLDER\n  （TBD/TODO/待补充/待定）/DUPLICATE_ID 为 error；NO_TRIGGER（REQ 缺 WHEN/当/若）/\n  AMBIGUOUS（歧义词）/ATTRIBUTE_UNADDRESSED（治理属性语料未提及）为 warning。\n  error → exit 1；需求目录无文件 → exit 3。配置：harness.json spec.requirementDirs。\nspec view [--paths a,b|--all] [--budget 6000]\n  预算化需求摘要：--paths 只显追溯引用落在这些路径上的需求；无参默认当前变更面；\n  每条 = id + 标题行 + 测试验证 yes/no；预算外省略逐条显式点名。`,
  trace: `trace\n  需求→测试追溯门禁：声明集来自 spec lint；扫描 tracked ∪ 未跟踪（exclude-standard）\n  ≤512KB 文本文件里的 id 引用。≥1 个测试文件（spec.testGlobs）引用 = VERIFIED。\n  coverage = verified/declared 必须 ≥ spec.minCoverage（默认 1.0）；代码/测试引用\n  未声明 id = 悬空（失败）；文档悬空只报告。对称规则：只扫 REQ/NFR 两个声明族。\n  失败 exit 1；非 git → exit 3。`,
  'rules-audit': `rules-audit [--files a,b]（默认 AGENTS.md）\n  规则行（编号/子弹/表格行，≥25 字符，代码围栏外）分类：backtick token 能解析到\n  matrix check id / 引擎动词 / fitness 规则 id = ENFORCED；行/段声明 提示词|prompt-only|(P)\n  = declared-prompt-only；其余 = UNENFORCED 发现。默认纯建议恒 exit 0；\n  harness.json rulesAudit.maxUnenforced 设数字后超限 exit 1。报告执法率。`,
  'skills-lint': `skills-lint\n  .kimi-code/skills/*/SKILL.md 契约：name kebab-case 且 == 目录名；description 必填、\n  >500 字符 error、>220 warning；正文 >24KB warning；重名 error。error → exit 1。`,
  'agents-lint': `agents-lint\n  根 AGENTS.md 必须存在（缺失 error）；>12000 字节 warning（每次请求全额重发）；\n  >16000 字节 error。error → exit 1。`,
  dod: `dod\n  Definition of Done 静态电池（子进程跑真实 CLI，定义唯一事实源 = lib/hygiene.mjs DOD_STEPS）：\n  catalog lint → skills-lint → agents-lint → spec lint → adr check → fitness --all（全仓）\n  → trace → receipt verify → arch check。每步归级 PASS/FAIL/DEGRADED（1/2=FAIL、\n  3=DEGRADED、4=STALE 按 FAIL 计）。任一 FAIL → exit 2；无 FAIL 但有 DEGRADED → exit 3\n  （降级响亮报告，绝不静默）；全 PASS → 0。pre-push 钩子与 CI 的第二/三道闸。`,
  selftest: `selftest\n  运行时自身冒烟：哈希/指纹/回执往返/分类器样例/原子写/frontmatter/import 提取。`
};

function printHelp(verb) {
  if (verb && HELP_VERBS[verb]) {
    process.stdout.write(`${HELP_VERBS[verb]}\n`);
    return;
  }
  process.stdout.write(`${HELP_GLOBAL}\n`);
}

// 严格 flag 校验（退出码契约 v2：未知 flag = 用法错误 exit 1）。
// parseCliArgs 曾静默吞掉任何 --flag，文档漂移由此隐身；每个动词在此登记合法 flag。
const GLOBAL_FLAGS = ['project', 'help'];
const KNOWN_FLAGS = {
  install: ['dry-run', 'target', 'hooks'],
  upgrade: ['dry-run', 'target', 'hooks'],
  uninstall: ['dry-run', 'target'],
  manifest: ['write', 'check'],
  doctor: ['target'],
  'pack-check': [],
  task: ['goal', 'owned', 'risk'],
  gate: ['risk', 'kind', 'dry-run'],
  quality: ['check', 'approver', 'reason', 'expires', 'compensation'],
  waiver: ['check', 'approver', 'reason', 'expires', 'compensation'],
  arch: ['scan', 'write', 'reason', 'record', 'gate'],
  adr: [],
  catalog: ['paths', 'write', 'depth'],
  fitness: ['path', 'staged', 'all'],
  impact: ['git', 'risk'],
  context: ['budget', 'focus'],
  receipt: [],
  review: ['base', 'ad-hoc', 'reviewer', 'notes'],
  fast: [],
  risk: [],
  'gate-audit': [],
  retention: ['dry-run'],
  hook: [],
  'init-modules': ['write'],
  recap: ['budget'],
  invariants: [],
  archive: ['apply', 'keep-done', 'keep-notes'],
  'sync-check': ['staged', 'paths'],
  spec: ['paths', 'all', 'budget'],
  trace: [],
  'rules-audit': ['files'],
  'skills-lint': [],
  'agents-lint': [],
  dod: [],
  selftest: [],
  cochange: ['limit', 'min-pairs', 'ratio'],
  budget: ['staged', 'baseline'],
  fleet: ['fleet', 'deep', 'budget'],
  release: []
};

function assertKnownFlags(verb, flags) {
  const known = KNOWN_FLAGS[verb];
  if (!known) return; // 未知动词走 default 分支报"未知动词"
  const allowed = new Set([...known, ...GLOBAL_FLAGS]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw usageError(`未知 flag：--${key}；动词 ${verb} 支持的 flag：${[...allowed].map((item) => `--${item}`).join(' ')}`);
    }
  }
}

// 输出助手：统一中文状态行。
function printResult(status, lines) {
  process.stdout.write(`${status}\n`);
  for (const line of [].concat(lines ?? [])) process.stdout.write(`${line}\n`);
}

// stdin JSON 载荷（review blue / lens / backlog add 的输入信封）。
async function readStdinJson(what) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw usageError(`${what} 需要从 stdin 读 JSON 载荷`);
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${what} 的 stdin 不是合法 JSON`);
  }
}

async function dispatchCommand(argv) {
  const { positional, flags } = parseCliArgs(argv);
  const [verb, sub, ...rest] = positional;
  if (!verb || verb === 'help' || flags.help === true && !verb) {
    printHelp(null);
    return 0;
  }
  if (flags.help || flags.h) {
    printHelp(verb);
    return 0;
  }
  assertKnownFlags(verb, flags);
  const projectStart = flags.project ? path.resolve(String(flags.project)) : process.cwd();
  const needProject = async () => loadContext(await requireProjectRoot(projectStart));

  switch (verb) {
    case 'install':
    case 'upgrade':
    case 'uninstall': {
      const target = await assertSafeTarget(sub ?? flags.target);
      if (verb === 'uninstall') {
        const plan = await planUninstall(target);
        const result = await applyUninstallPlan(plan, Boolean(flags['dry-run']));
        const counts = {};
        for (const op of result.operations) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
        printResult('卸载完成', [`目标：${target}`, `操作统计：${JSON.stringify(counts)}`, result.dryRun ? '（dry-run，未落盘）' : '']);
        return 0;
      }
      await assertInstallSource();
      const sourceManifest = await buildSourceManifest();
      const plan = await planInstall(target, sourceManifest, verb);
      const result = await applyInstallPlan(plan, Boolean(flags['dry-run']));
      const counts = {};
      for (const op of result.operations) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
      const lines = [
        `目标：${target}`,
        `操作统计：${JSON.stringify(counts)}`,
        `回执：${INSTALL_RECEIPT_REL}`,
        result.dryRun ? '（dry-run，未落盘）' : ''
      ];
      // --hooks：显式请求挂载第二道闸（git hooks）。安装主事务已成功，
      // 挂载失败是可见降级（warning），不回滚安装。
      if (flags.hooks) {
        if (result.dryRun) {
          lines.push('hooks：（dry-run，未执行挂载）');
        } else {
          const mounted = await mountGitHooks(target);
          lines.push(mounted.mounted
            ? `hooks：已挂载 core.hooksPath=${mounted.hooksPath}（三钩子 chmod 755 + git add --chmod=+x${mounted.executableStaged ? ' 已入 index' : ' 入 index 失败，请手工 git add --chmod=+x'}）`
            : `warning：--hooks 未生效——${mounted.reason}；第二道闸未挂载（可稍后重跑 ${verb} . --hooks）`);
        }
      }
      printResult(`${verb === 'install' ? '安装' : '升级'}完成`, lines);
      return 0;
    }
    case 'manifest': {
      if (flags.write && flags.check) throw usageError('manifest --write 与 --check 互斥');
      const mode = flags.write ? 'write' : 'check';
      // 源仓（kimi.plugin.json+.kimi-base/runtime+.kimi-code）优先走源仓模式；
      // 源仓自托管时根上也有 harness.json，不能让 findProjectRoot 抢成已安装模式。
      const projectRoot = (await isSourceRepo(projectStart)) ? null : await findProjectRoot(projectStart);
      const result = await manifestCommand(mode, projectRoot);
      printResult(result.ok ? `manifest ${mode} 通过` : `manifest ${mode} 失败`, [
        `模式：${result.scope === 'installed' ? '已安装项目' : '源仓'}；文件数：${result.files}；digest：${result.digest}`,
        ...(result.errors ?? [])
      ]);
      return result.ok ? 0 : 2;
    }
    case 'doctor': {
      const result = await doctorCommand(sub ?? (flags.target ? String(flags.target) : undefined));
      printResult(result.ok ? 'doctor 通过' : 'doctor 发现问题', [
        `模式：${result.mode}；目标：${result.target}`,
        ...result.errors.map((item) => `ERROR ${item}`),
        ...result.warnings.map((item) => `warning ${item}`)
      ]);
      return result.ok ? 0 : 2;
    }
    case 'pack-check': {
      const result = await packCheckCommand();
      printResult(result.ok ? 'pack-check 通过' : 'pack-check 失败', [
        `发布面文件数：${result.files}`,
        ...result.errors.map((item) => `ERROR ${item}`)
      ]);
      return result.ok ? 0 : 2;
    }
    case 'task': {
      const ctx = await needProject();
      if (sub === 'start') {
        const task = await taskStart(ctx, { goal: flags.goal, owned: flags.owned, risk: flags.risk });
        printResult('任务已开始', [
          `id：${task.id}`,
          `risk：${task.risk}；owned：${task.ownedPaths.join(', ')}`,
          `基线：base=${task.baseline.baseCommit.slice(0, 12)} fp=${task.baseline.fingerprint.slice(0, 12)}（${Object.keys(task.baseline.knownHashes).length} 个文件快照${task.baseline.degraded ? '；非 git 降级' : ''}）`
        ]);
        return 0;
      }
      if (sub === 'status') {
        const state = await readTasks(ctx);
        const active = state.activeTaskId ? state.tasks[state.activeTaskId] : null;
        const lines = active
          ? [`active：${active.id}`, `目标：${active.goal}`, `risk：${active.risk}`, `owned：${active.ownedPaths.join(', ')}`, `已触碰：${active.touchedPaths.join(', ') || '无'}`, `创建于：${active.createdAt}`]
          : ['active：无'];
        const history = Object.values(state.tasks).filter((item) => item.status !== 'active').slice(-5);
        for (const item of history) lines.push(`历史：${item.id} ${item.status} ${item.completedAt ?? item.cancelledAt ?? ''}`);
        printResult('task status', lines);
        return 0;
      }
      if (sub === 'cancel') {
        const cancelled = await taskCancel(ctx);
        printResult('任务已取消', [`id：${cancelled.id}`]);
        return 0;
      }
      if (sub === 'complete') {
        const task = await getActiveTask(ctx);
        if (!task) throw usageError('当前没有 active 任务');
        const gate = await completionGate(ctx, task);
        const coverage = await attributeCoverage(ctx, {});
        const gaps = [...gate.gaps.map((item) => `[${item.kind ?? '-'}] ${item.check ?? '-'}：${item.reason}`)];
        for (const item of coverage.uncovered ?? []) gaps.push(`五性 uncovered：${item.attribute}(${item.tier}) ${item.reason}`);
        if (!gate.ok || !coverage.ok) {
          printResult('完成门阻断（exit 2）', [`缺口 ${gaps.length} 项：`, ...gaps.map((item) => `- ${item}`)]);
          return 2;
        }
        await updateState(ctx, TASKS_FILE, emptyTasks(), (state) => {
          const current = state.tasks[task.id];
          return {
            ...state,
            activeTaskId: null,
            tasks: { ...state.tasks, [task.id]: { ...current, status: 'completed', completedAt: nowIso(), updatedAt: nowIso(), completion: { fingerprint: gate.fingerprint } } }
          };
        });
        printResult('任务完成', [`id：${task.id}`, `fingerprint：${gate.fingerprint.slice(0, 16)}`, '完成门：全部 required kinds 有 fresh 证据；五性覆盖通过']);
        return 0;
      }
      throw usageError(`未知 task 子命令：${sub ?? '<缺>'}（start/status/complete/cancel）`);
    }
    case 'gate': {
      const ctx = await needProject();
      const result = await runGate(ctx, { risk: flags.risk ? String(flags.risk) : undefined, kind: flags.kind ? String(flags.kind) : undefined, dryRun: Boolean(flags['dry-run']) });
      if (result.dryRun) {
        printResult('gate 计划（dry-run 不执行）', [
          `risk=${result.plan.risk} kinds=${result.plan.kinds.join(',')}`,
          ...result.plan.checks.map((item) => `- ${item.id}（${item.kind}）${item.display ?? '缺命令→BLOCKED'}`),
          ...result.plan.missingKinds.map((kind) => `- kind ${kind} 无任何检查 → BLOCKED`)
        ]);
        return 0;
      }
      printResult(`gate ${result.overall}`, [
        `risk=${result.plan.risk} fingerprint=${result.fingerprint.slice(0, 16)} fast=${result.fastActive}`,
        `统计：PASS=${result.counts.PASS} FAIL=${result.counts.FAIL} BLOCKED=${result.counts.BLOCKED} SKIPPED=${result.counts.SKIPPED}`,
        ...result.receipts.map((item) => `- ${item.status} ${item.checkId}（${item.checkKind}）${item.reason ? `：${item.reason}` : ''}${item.evidencePath ? ` 证据=${item.evidencePath}` : ''}`)
      ]);
      return result.overall === 'PASS' ? 0 : 2;
    }
    case 'quality':
    case 'waiver': {
      const ctx = await needProject();
      // 顶层 waiver 动词是 quality waiver 的别名（两种叫法都合法）。
      const effectiveSub = verb === 'waiver' ? 'waiver' : sub;
      const effectiveRest = verb === 'waiver' ? [sub, ...rest].filter(Boolean) : rest;
      if (effectiveSub === 'status') {
        const coverage = await attributeCoverage(ctx, {});
        printResult(coverage.ok ? 'quality status：覆盖通过' : 'quality status：存在 uncovered（exit 2）', [
          `范围：${coverage.scope}；fingerprint=${coverage.fingerprint.slice(0, 16)}`,
          ...coverage.attributes.map((item) => `- ${item.covered ? 'covered' : 'UNCOVERED'} ${item.attribute}(${item.tier}) [${item.modules.join(',')}] ${item.reason}`),
          coverage.deferredByFastMode.length ? `Fast Mode 延期：${coverage.deferredByFastMode.join(', ')}` : ''
        ]);
        return coverage.ok ? 0 : 2;
      }
      if (effectiveSub === 'waiver') {
        const action = effectiveRest[0];
        if (action === 'create') {
          const waiver = await waiverCreate(ctx, { checkId: flags.check, approver: flags.approver, reason: flags.reason, expires: flags.expires, compensation: flags.compensation });
          printResult('waiver 已创建', [
            `id：${waiver.id}`, `check：${waiver.checkId}`, `fingerprint：${waiver.fingerprint.slice(0, 16)}`,
            `expires：${waiver.expiresAt}`, `approver：${waiver.approver}`, `compensation：${waiver.compensation}`
          ]);
          return 0;
        }
        if (action === 'list') {
          const waivers = await waiverList(ctx);
          printResult('waiver 列表', waivers.length
            ? waivers.map((item) => `- ${item.id} check=${item.checkId} ${item.validity.active ? '有效' : `失效（${item.validity.why}）`} expires=${item.expiresAt} approver=${item.approver}`)
            : ['（无 waiver）']);
          return 0;
        }
        throw usageError(`未知 waiver 动作：${action ?? '<缺>'}（create/list）`);
      }
      throw usageError(`未知 ${verb} 子命令：${effectiveSub ?? '<缺>'}（status/waiver）`);
    }
    case 'arch': {
      const ctx = await needProject();
      if (sub === 'check') {
        const result = await archCheckRun(ctx, { scan: Boolean(flags.scan) });
        printResult(result.ok ? 'arch check 通过' : 'arch check 发现违规（exit 1）', result.report.split('\n'));
        return result.ok ? 0 : 1;
      }
      if (sub === 'baseline') {
        if (!flags.write) throw usageError('arch baseline 需要 --write（可选 --reason "..."）');
        const result = await archBaselineWrite(ctx, flags.reason ? String(flags.reason) : undefined);
        printResult('arch baseline 已写入', [`路径：${result.path}`, `条目：${result.written}`, `清理 stale：${result.droppedStale}`]);
        return 0;
      }
      if (sub === 'trend') {
        const mode = flags.record ? 'record' : flags.gate ? 'gate' : null;
        if (!mode) throw usageError('arch trend 需要 --record 或 --gate');
        const result = await archTrend(ctx, mode);
        if (mode === 'record') {
          printResult('arch trend 已记录', [`快照：${JSON.stringify(result.recorded)}`, `累计快照：${result.total}`]);
          return 0;
        }
        printResult(result.ok ? 'arch trend --gate 通过' : 'arch trend --gate 触发棘轮（exit 1）', [
          result.report,
          result.firstRun ? '基线：无历史快照（baseline:true）' : `基线（逐指标历史最优）：${JSON.stringify(result.baseline)}`,
          `当前：${JSON.stringify(result.current)}`
        ]);
        return result.ok ? 0 : 1;
      }
      throw usageError(`未知 arch 子命令：${sub ?? '<缺>'}（check/baseline/trend）`);
    }
    case 'adr': {
      if (sub !== 'check') throw usageError(`未知 adr 子命令：${sub ?? '<缺>'}（check）`);
      const ctx = await needProject();
      const result = await adrCheckRun(ctx);
      printResult(result.ok ? 'adr check 通过' : 'adr check 发现幽灵引用（exit 1）', result.report.split('\n'));
      return result.ok ? 0 : 1;
    }
    case 'catalog': {
      const ctx = await needProject();
      if (sub === 'lint') {
        const result = await lintCatalog(ctx, flags.paths ? csv(flags.paths) : []);
        printResult(result.ok ? 'catalog lint 通过' : 'catalog lint 发现违规（exit 1）', [
          `路径总数：${result.total}；分类统计：${JSON.stringify(result.counts)}`,
          ...result.failures.slice(0, 100).map((item) => `- ${item.path}：${item.reason ?? item.classification}`)
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'discover') {
        const depth = flags.depth !== undefined ? Number(flags.depth) : 2;
        const result = await discoverCatalog(ctx, { depth });
        if (!flags.write) {
          printResult('catalog discover（dry-run；--write 落盘）', [
            `tracked ${result.trackedPaths} 路径 → 提案模块 ${result.proposedModules} 个；真实 import 边 ${result.realEdges} 条（未解析 specifier ${result.unresolvedSpecifiers} 个，如实计数）`,
            `检测到检查命令 ${result.detectedChecks.length} 个：${result.detectedChecks.map((item) => item.id).join(', ') || '无'}`,
            ...result.needsDecision.map((item) => `- needsDecision ${item.field}：${item.why}`),
            ...(result.stillUnmappedCount ? [`- 仍无归属 ${result.stillUnmappedCount} 个：${result.stillUnmapped.join(', ')}`] : []),
            JSON.stringify({ draft: result.draft, attributeProposals: result.attributeProposals, detectedChecks: result.detectedChecks, needsDecision: result.needsDecision }, null, 2)
          ]);
          return 0;
        }
        const written = await discoverWrite(ctx, result);
        printResult('catalog discover 已写入', [
          `路径：${written.written}${written.isDraft ? '（已有 catalog，草案写为 draft——人工合并后才生效；绝不覆盖人工策展）' : ''}`,
          `模块数：${written.modules}；needsDecision ${result.needsDecision.length} 项待人决（见 dry-run 输出）`
        ]);
        return 0;
      }
      throw usageError(`未知 catalog 子命令：${sub ?? '<缺>'}（lint/discover）`);
    }
    case 'fitness': {
      const ctx = await needProject();
      const paths = flags.path ? csv(flags.path) : rest.length ? [sub, ...rest] : [];
      const result = await runFitness(ctx, {
        paths: paths.length ? paths : undefined,
        staged: Boolean(flags.staged),
        all: Boolean(flags.all)
      });
      printResult(`fitness ${result.status}${result.ok ? '' : '（exit 1）'}`, result.report.split('\n').slice(1));
      return result.ok ? 0 : 1;
    }
    case 'impact': {
      const ctx = await needProject();
      const useGit = Boolean(flags.git);
      const paths = [sub, ...rest].filter(Boolean);
      if (!useGit && !paths.length) throw usageError('impact 需要路径参数或 --git');
      const result = await impactAnalysis(ctx, { paths: useGit ? undefined : paths, risk: flags.risk ? String(flags.risk) : undefined });
      printResult('impact 分析', [
        `变更路径：${result.changedPaths.length}；直接模块：${result.directModules.join(', ') || '无'}`,
        `受影响模块：${result.affectedModules.join(', ') || '无'}${result.expandedToAll ? `（保守扩散：${result.expansionReasons.join('；')}）` : ''}`,
        `检查计划（risk=${result.risk}，planHash=${result.planHash.slice(0, 16)}）：`,
        ...result.plan.checks.map((item) => `- ${item.id}（${item.kind}）← ${item.reasons.join(', ')}`)
      ]);
      return 0;
    }
    case 'context': {
      if (sub !== 'pack') throw usageError(`未知 context 子命令：${sub ?? '<缺>'}（pack）`);
      const ctx = await needProject();
      const pack = await buildContextPack(ctx, { budget: flags.budget ? Number(flags.budget) : undefined, focus: flags.focus });
      printResult('context pack 完成', [
        `packHash=${pack.packHash.slice(0, 16)}；预算 ${pack.budget.used}/${pack.budget.total} 字符${pack.budget.cappedBy ? `（请求 ${pack.budget.requested}，被 ${pack.budget.cappedBy} 封顶）` : ''}`,
        `入包 ${pack.included.length} 个；omitted ${pack.omitted.length} 个；存储：${pack.storedAt}`,
        ...pack.included.map((item) => `+ ${item.path}（${item.chars} 字符${item.truncated ? '，截断' : ''}）← ${item.why}`),
        ...pack.omitted.map((item) => `- omitted ${item.path}：${item.reason}`)
      ]);
      return 0;
    }
    case 'receipt': {
      if (sub !== 'verify') throw usageError(`未知 receipt 子命令：${sub ?? '<缺>'}（verify）`);
      const ctx = await needProject();
      const result = await receiptVerify(ctx);
      // 分级：篡改/断链/缺失/漂移 → exit 2；仅陈旧（链完好、指纹已移动）→ exit 4。
      const code = result.ok ? 0 : result.staleOnly ? 4 : 2;
      printResult(result.ok ? 'receipt verify 通过' : result.staleOnly ? 'receipt verify：证据已陈旧（exit 4）' : 'receipt verify 失败（exit 2）', [
        `账本条目：${result.entries}（归档段 ${result.archives}）；证据校验：${result.evidenceChecked}；链：${result.chain.intact ? '完好' : '断裂'}`,
        ...result.problems.map((item) => `- ${item}`),
        ...result.stale.map((item) => `- ${item}`),
        ...(result.staleNote ? [`- note ${result.staleNote}`] : [])
      ]);
      return code;
    }
    case 'review': {
      const ctx = await needProject();
      if (sub === 'start') {
        const result = await reviewStart(ctx, { base: flags.base });
        const session = result.session;
        printResult('评审会话已开启', [
          `绑定：${session.range ? `range ${session.range.base}...HEAD（head=${session.range.head.slice(0, 12)}）` : `diffHash=${session.diffHash.slice(0, 16)} base=${session.baseCommit.slice(0, 12)}`}；范围 ${session.scope.paths.length} 个路径`,
          `剖面：${session.profile}；召集 lens：${session.requiredLenses.map((name) => `${name}(阶段${stageOfLens(name)}:${REVIEW_STAGES[stageOfLens(name)]})`).join(' ')}`,
          ...(session.excludedLenses.length ? session.excludedLenses.map((item) => `- 剔除 ${item.lens}：${item.reason}`) : []),
          `轮次：第 ${session.lineage.length + 1} 轮（lineage ${session.lineage.length} 条）`,
          result.previousVerdict ? `上轮裁决：${result.previousVerdict.verdict}（已入 lineage）` : ''
        ]);
        return 0;
      }
      if (sub === 'blue') {
        const result = await recordBlue(ctx, await readStdinJson('review blue'));
        printResult('blue 自证已记录', [`claims：${result.claims} 条（自述只作红队靶子，不作通过依据）`]);
        return 0;
      }
      if (sub === 'lens') {
        const name = rest[0];
        if (!name) throw usageError('review lens 需要 lens 名（review lens <name> [--ad-hoc]，stdin 读 findings JSON）');
        const result = await recordLens(ctx, name, await readStdinJson('review lens'), { adHoc: Boolean(flags['ad-hoc']) });
        if (result.refused) {
          printResult('lens 报到被拒（exit 1）', [`stageGated:${result.stageGated === true}`, result.reason]);
          return 1;
        }
        printResult('lens 已报到', [
          `lens：${result.lens}${result.adHoc ? '（ad-hoc 额外证据，不占应到清单）' : ''}；findings：${result.findings}（error=${result.counts.error} warning=${result.counts.warning} info=${result.counts.info}）${result.unable ? '；unable:true' : ''}`
        ]);
        return 0;
      }
      if (sub === 'verdict') {
        const result = await reviewVerdict(ctx, { reviewer: flags.reviewer, notes: flags.notes });
        printResult(`评审裁决：${result.verdict}`, [
          `round=${result.round}/${result.maxRounds}；stage=${result.stage}（${REVIEW_STAGES[result.stage]}）；final:${result.final}`,
          ...result.errorFindings.slice(0, 20).map((finding) => `- error [${finding.lens}] ${finding.location ?? finding.reproduction ?? ''}：${finding.message}`),
          ...(result.unableLenses.length ? [`无法结论的应到 lens：${result.unableLenses.join(', ')}`] : []),
          ...(result.escalate ? ['escalate:true'] : []),
          result.receipt ? `回执：已写入账本与 receipts 镜像（kind:review id=${result.receipt.id}）` : '回执：未写（非终审 ACCEPT 或其他裁决；消费者只认回执，不认本退出码）',
          `建议：${result.advice}`
        ]);
        return result.exitCode;
      }
      if (sub === 'status') {
        const result = await reviewStatus(ctx);
        const session = result.session;
        printResult('review status', [
          `新鲜度：${result.fresh ? 'fresh' : `stale（${result.staleReason}）`}；当前阶段：${result.stage}（${REVIEW_STAGES[result.stage]}）`,
          `绑定：${session.range ? `range ${session.range.base}...${session.range.head.slice(0, 12)}` : `diffHash=${session.diffHash.slice(0, 16)}`}；剖面：${session.profile ?? 'team'}`,
          `已报到：${result.reported.join(', ') || '无'}；未报到：${result.pending.join(', ') || '无'}`,
          `blue：${session.blue ? `已自证（${session.blue.claims.length} 条）` : '未自证'}；裁决：${session.verdict ? `${session.verdict.verdict}（round ${session.verdict.round}）` : '未裁决'}`,
          `backlog 结转：${result.carriedBacklog} 条${result.expiredBacklog ? `（${result.expiredBacklog} 条已过期）` : ''}`
        ]);
        return 0;
      }
      if (sub === 'team') {
        const result = await reviewTeam(ctx);
        printResult('评审团队', [
          `来源：${result.source === 'session' ? '当前会话（召集时定格）' : '按当前变更面现算'}；剖面：${result.profile}`,
          ...result.required.map((name) => `- 召集 ${name}（阶段 ${stageOfLens(name)}：${REVIEW_STAGES[stageOfLens(name)]}）`),
          ...result.excluded.map((item) => `- 剔除 ${item.lens}：${item.reason}`)
        ]);
        return 0;
      }
      if (sub === 'backlog') {
        const action = rest[0];
        if (action === 'add') {
          const result = await backlogAdd(ctx, await readStdinJson('review backlog add'));
          printResult('backlog 已入账', [`id：${result.entry.id}；owner：${result.entry.owner}；expiry：${result.entry.expiry}；累计 ${result.count} 条（跨会话存活）`]);
          return 0;
        }
        if (action === 'list') {
          const result = await backlogList(ctx);
          printResult('backlog 列表', result.count
            ? result.entries.map((entry) => `- ${entry.id} [${entry.lens}] ${entry.summary}（owner=${entry.owner} expiry=${entry.expiry}${entry.expired ? ' 已过期' : ''}）`)
            : ['（无 backlog 条目）']);
          return 0;
        }
        throw usageError(`未知 review backlog 动作：${action ?? '<缺>'}（add/list）`);
      }
      if (sub === 'pack') {
        const result = await reviewPack(ctx);
        printResult('评审证据包已生成', [
          `路径：${result.packPath}${result.spillPath ? `；diff 溢出：${result.spillPath}` : ''}`,
          `范围：${result.base}...HEAD（base 来源 ${result.baseSource}）；commit ${result.commits} 个；diff ${result.diffLines} 行`,
          `删除审计：${result.deleted.length ? result.deleted.join(', ') : '无'}；未跟踪：${result.untracked.length ? result.untracked.join(', ') : '无'}`
        ]);
        return 0;
      }
      throw usageError(`未知 review 子命令：${sub ?? '<缺>'}（start/blue/lens/verdict/status/team/backlog/pack）`);
    }
    case 'fast': {
      const ctx = await needProject();
      const action = sub ?? 'status';
      if (!['on', 'off', 'status'].includes(action)) throw usageError('fast 需要 on [hours]|off|status');
      const hours = rest[0] ? Number(rest[0]) : undefined;
      const result = await fastModeSet(ctx, action, hours);
      if (action === 'status') {
        const remainHours = result.active ? Math.max(0, (result.expiresMs - Date.now()) / 3600000) : 0;
        printResult('fast status', [
          result.active
            ? `Fast Mode 生效中：至 ${result.expiresAt}（剩余约 ${remainHours.toFixed(1)} 小时 / TTL ${Math.ceil(remainHours)}h）`
            : result.expired ? `Fast Mode 已过期（${result.expiresAt}），视同关闭` : 'Fast Mode 关闭（off）',
          'protected 属性/kind（security/safety/privacy）免疫；SKIPPED 留痕',
          'fast 门不能关闭 task/release：借账须 fast off 后重跑完整 gate 偿还'
        ]);
      } else {
        printResult(`fast ${action} 完成`, action === 'on'
          ? [`生效至 ${result.expiresAt}`, '借账提醒：窗口内的 SKIPPED 带 fastWindow 印记，不能关闭 task/release；还债 = fast off 后重跑完整 gate']
          : ['已关闭']);
      }
      return 0;
    }
    case 'risk': {
      if (sub && sub !== 'scan') throw usageError(`未知 risk 子命令：${sub}`);
      const ctx = await needProject();
      const result = await riskScan(ctx);
      printResult(result.ok ? 'risk scan：无高危' : 'risk scan：存在高危项', [
        `active 任务：${result.activeTask ?? '无'}；证据文件：${result.evidenceCount}`,
        ...(result.risks.length ? result.risks.map((item) => `- [${item.level}] ${item.kind}：${item.detail}`) : ['- 未发现风险'])
      ]);
      return result.ok ? 0 : 2;
    }
    case 'gate-audit': {
      const ctx = await needProject();
      const result = await gateAudit(ctx);
      printResult('gate-audit', [
        `拦截记录总数：${result.totalInterceptions}`,
        ...result.rules.map((item) => `- ${item.kind}:${item.rule} 拦截 ${item.count} 次（${item.firstTs ?? '?'} ~ ${item.lastTs ?? '?'}）`),
        ...(result.neverFired.length ? [`从未拦过的闸（要么拿证据要么撤掉）：`, ...result.neverFired.map((item) => `- ${item.kind}:${item.rule}`)] : ['全部已知闸均有拦截记录']),
        result.guidance
      ]);
      return 0;
    }
    case 'retention': {
      if (sub !== 'prune') throw usageError(`未知 retention 子命令：${sub ?? '<缺>'}（prune）`);
      const ctx = await needProject();
      const result = await retentionPrune(ctx, { dryRun: Boolean(flags['dry-run']) });
      printResult(`retention prune ${result.dryRun ? '（dry-run）' : '完成'}`, [
        `evidence：保留 ${result.evidence.kept}，删除 ${result.evidence.deleted.length}`,
        ...result.evidence.deleted.slice(0, 20).map((item) => `- 删 ${item}`),
        `context：保留 ${result.context.kept}，删除 ${result.context.deleted.length}`,
        ...result.notes
      ]);
      return 0;
    }
    case 'hook': {
      if (!sub) throw usageError('hook 需要事件名（见 hook --help）');
      await dispatchHook(sub);
      return process.exitCode ?? 0;
    }
    case 'init-modules': {
      // 废弃别名（P6 起 catalog discover 取代）：转发并响亮注明，不静默改语义。
      process.stderr.write('警告：init-modules 已废弃，转发 catalog discover（语义已并轨）；请改用 catalog discover [--write]\n');
      const ctx = await needProject();
      const result = await initModulesAlias(ctx, Boolean(flags.write));
      if (result.dryRun) {
        printResult('catalog discover（dry-run；--write 落盘）', [
          `tracked ${result.result.trackedPaths} 路径 → 提案模块 ${result.result.proposedModules} 个；真实 import 边 ${result.result.realEdges} 条`,
          JSON.stringify({ draft: result.result.draft, attributeProposals: result.result.attributeProposals, detectedChecks: result.result.detectedChecks }, null, 2)
        ]);
      } else {
        printResult('catalog discover 已写入', [`路径：${result.written.written}${result.written.isDraft ? '（已有 catalog，写为 draft）' : ''}；模块数：${result.written.modules}`]);
      }
      return 0;
    }
    case 'recap': {
      const ctx = await needProject();
      const result = await recap(ctx, { budget: flags.budget !== undefined ? Number(flags.budget) : undefined });
      printResult(`recap（派生视图，不信任何摘要；${result.chars}/${result.budget} 字符${result.truncated ? '；已截断' : ''}）`, result.text.split('\n'));
      return 0;
    }
    case 'invariants': {
      const ctx = await needProject();
      const digest = await invariantsDigest(ctx);
      // 摘要即全部输出（自包含 ≤1200 字符），供压缩后直接重注入。
      process.stdout.write(digest.text);
      return 0;
    }
    case 'archive': {
      const ctx = await needProject();
      const parseKeep = (name) => {
        if (flags[name] === undefined) return undefined;
        const parsed = Number(flags[name]);
        if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`archive 的 --${name} 必须是非负整数`);
        return parsed;
      };
      const result = await archiveProgress(ctx, { apply: Boolean(flags.apply), keepDone: parseKeep('keep-done'), keepNotes: parseKeep('keep-notes') });
      printResult(`archive ${result.applied ? '完成' : '（dry-run，未落盘；加 --apply 落盘）'}`, [
        `progress.md ${result.bytes} 字节（上限 ${result.maxBytes}）；Done ${result.doneEntries} 条（保留 ${result.keepDone}）；Notes ${result.noteEntries} 条（保留 ${result.keepNotes}）`,
        ...(result.plan ?? []).map((item) => `- ${item.section}：共 ${item.total} 条，保留最新 ${item.keep} 条，移动最旧 ${item.moving} 条`),
        result.moved
          ? `合计移动 ${result.moved} 条${result.applied ? ` → ${result.archive}（## Archived 日期段），活体文件已留指针行` : ''}`
          : `— ${result.reason}`
      ]);
      return 0;
    }
    case 'sync-check': {
      const ctx = await needProject();
      const result = await syncCheck(ctx, { staged: Boolean(flags.staged), paths: flags.paths ? csv(flags.paths) : undefined });
      printResult(result.ok ? 'sync-check 通过' : 'sync-check 发现违例（exit 1）', [
        `变更面 ${result.changed} 个路径（source=${result.source}）；governed 模块路径 ${result.governed} 个；progress.md ${result.ledgerInChange ? '在' : '不在'}改动集`,
        ...(result.catalogNote ? [`note ${result.catalogNote}`] : []),
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.message}`)
      ]);
      return result.ok ? 0 : 1;
    }
    case 'spec': {
      const ctx = await needProject();
      if (sub === 'lint') {
        const result = await specLint(ctx);
        if (result.degraded) {
          printResult('spec lint 降级（exit 3）', [result.reason]);
          return 3;
        }
        printResult(result.ok ? 'spec lint 通过' : 'spec lint 发现违例（exit 1）', [
          `需求文件 ${result.files} 个；声明需求 ${result.counts.requirements} 条；error ${result.counts.error} / warning ${result.counts.warning}`,
          ...result.findings.slice(0, 100).map((item) => `- ${item.severity} [${item.code}] ${item.file ? `${item.file}${item.line ? `:${item.line}` : ''} ` : ''}${item.message}`)
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'view') {
        const result = await specView(ctx, {
          paths: flags.paths ? csv(flags.paths) : undefined,
          all: Boolean(flags.all),
          budget: flags.budget !== undefined ? Number(flags.budget) : undefined
        });
        if (result.degraded) {
          printResult('spec view 降级（exit 3）', [result.reason]);
          return 3;
        }
        printResult(`spec view（渲染 ${result.rendered} 条/省略显式 ${result.omitted.length} 条；${result.chars}/${result.budget} 字符）`, result.text.split('\n'));
        return 0;
      }
      throw usageError(`未知 spec 子命令：${sub ?? '<缺>'}（lint/view）`);
    }
    case 'trace': {
      const ctx = await needProject();
      const result = await traceRequirements(ctx);
      if (result.degraded) {
        printResult('trace 降级（exit 3）', [result.reason]);
        return 3;
      }
      printResult(result.ok ? 'trace 通过' : 'trace 未达门禁（exit 1）', [
        `覆盖率 ${(result.coverage * 100).toFixed(1)}%（verified ${result.verified}/${result.total}；门槛 ${(result.minCoverage * 100).toFixed(0)}%）`,
        ...(result.unverified.length ? [`未被测试引用的需求：${result.unverified.join(', ')}`] : []),
        ...(result.dangling.length ? ['悬空引用（代码/测试点名了未声明的 id）：', ...result.dangling.map((item) => `- ${item.id} ← ${item.file}`)] : []),
        ...(result.danglingInDocsCount ? [`文档悬空引用 ${result.danglingInDocsCount} 处（仅报告不拦）：`, ...result.danglingInDocs.map((item) => `- ${item.id} ← ${item.file}`)] : []),
        result.advice
      ]);
      return result.ok ? 0 : 1;
    }
    case 'rules-audit': {
      const ctx = await needProject();
      const result = await rulesAudit(ctx, { files: flags.files ? csv(flags.files) : undefined });
      printResult(result.ok ? 'rules-audit 通过' : 'rules-audit 超阈（exit 1）', [
        `规则 ${result.counts.total} 条：enforced ${result.counts.enforced} / 声明 prompt-only ${result.counts.declaredPromptOnly} / 无执法 ${result.counts.unenforced}；执法率 ${(result.enforcementRatio * 100).toFixed(1)}%；阈值 ${result.counts.maxUnenforced ?? '未设（纯建议）'}`,
        ...result.findings.slice(0, 50).map((item) => `- [${item.code}] ${item.file}:${item.line} ${item.message}`),
        result.advice
      ]);
      return result.ok ? 0 : 1;
    }
    case 'skills-lint': {
      const ctx = await needProject();
      const result = await skillsLint(ctx);
      printResult(result.ok ? 'skills-lint 通过' : 'skills-lint 发现违例（exit 1）', [
        `skill ${result.counts.skills} 个；error ${result.counts.error} / warning ${result.counts.warning}${result.note ? `；${result.note}` : ''}`,
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.file ? `${item.file} ` : ''}${item.message}`)
      ]);
      return result.ok ? 0 : 1;
    }
    case 'agents-lint': {
      const ctx = await needProject();
      const result = await agentsLint(ctx);
      printResult(result.ok ? 'agents-lint 通过' : 'agents-lint 发现违例（exit 1）', [
        `AGENTS.md ${result.bytes} 字节（warning>12000 / error>16000）`,
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.file ? `${item.file} ` : ''}${item.message}`)
      ]);
      return result.ok ? 0 : 1;
    }
    case 'dod': {
      const ctx = await needProject();
      const result = await runDod(ctx);
      const lines = [
        `统计：PASS=${result.counts.PASS} FAIL=${result.counts.FAIL} DEGRADED=${result.counts.DEGRADED} STALE=${result.counts.STALE}`,
        ...result.steps.flatMap((step) => [
          `- ${step.status} ${step.id}（exit ${step.exitCode ?? 'N/A'}，${(step.durationMs / 1000).toFixed(1)}s）${step.reason ? `：${step.reason}` : ''}${step.note ? `；note ${step.note}` : ''}`,
          ...(step.outputTail ?? []).map((line) => `    ${line}`)
        ])
      ];
      if (result.counts.FAIL) lines.push('存在 FAIL 步骤：dod 未达成（exit 2）');
      else if (result.counts.DEGRADED) lines.push('存在 DEGRADED 步骤：降级不是通过（exit 3），请补配置后重跑');
      if (result.counts.STALE) lines.push('存在 STALE 步骤：证据陈旧不是完整性失败——新鲜度归 release 管（receipt-fresh），完整性归 dod 管；dod 不因此阻断，但发布前必须刷新证据');
      printResult(result.ok ? 'dod 通过' : result.counts.FAIL ? 'dod 未达成（exit 2）' : 'dod 降级（exit 3）', lines);
      return result.exitCode;
    }
    case 'cochange': {
      const ctx = await needProject();
      const result = await cochangeAnalysis(ctx, {
        limit: flags.limit !== undefined ? Number(flags.limit) : undefined,
        minPairs: flags['min-pairs'] !== undefined ? Number(flags['min-pairs']) : undefined,
        ratio: flags.ratio !== undefined ? Number(flags.ratio) : undefined
      });
      printResult(result.ok ? 'cochange 通过' : 'cochange 发现边界嫌疑（exit 1）', [
        `窗口 ${result.commits} 个提交：可分析 ${result.analysed}，横扫排除 ${result.sweeping}；涉及模块 ${result.modules} 个`,
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.message}`),
        `建议：${result.advice}`
      ]);
      return result.ok ? 0 : 1;
    }
    case 'budget': {
      const ctx = await needProject();
      const result = await assessBudget(ctx, {
        staged: Boolean(flags.staged),
        baseline: flags.baseline ? String(flags.baseline) : null
      });
      if (result.degraded) {
        printResult('budget 降级（exit 3）', [result.reason, `指标：${JSON.stringify(result.metrics)}`]);
        return 3;
      }
      printResult(result.ok ? 'budget 通过' : 'budget 超支（exit 1）', [
        `口径：${result.source}；指标：${JSON.stringify(result.metrics)}；上限：${JSON.stringify(result.limits)}`,
        ...result.findings.map((item) => `- 超限 ${item.metric}：实际 ${item.actual} > 上限 ${item.limit}`),
        result.advice
      ]);
      return result.ok ? 0 : 1;
    }
    case 'fleet': {
      // fleet 治理仓群（组级 fleet.json），不要求当前目录是 kimi-base 项目。
      const state = await requireFleet(projectStart, flags.fleet ? String(flags.fleet) : null);
      if (sub === 'lint') {
        const result = fleetLint(state);
        printResult(result.ok ? 'fleet lint 通过' : 'fleet lint 发现违例（exit 1）', [
          `fleet：${state.file}；仓库 ${result.counts.repos} 个；契约 ${result.counts.contracts} 个；error ${result.counts.error} / warning ${result.counts.warning}`,
          ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.message}`)
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'impact') {
        const contract = rest[0];
        if (!contract) throw usageError('fleet impact 需要契约 id（fleet impact <contract>）');
        const result = fleetImpact(state, contract);
        if (result.degraded) {
          printResult('fleet impact 降级（exit 3）', [result.reason, `已知契约：${result.known.join(', ') || '无'}`]);
          return 3;
        }
        printResult(`fleet impact：${result.contract}`, [
          `提供方：${result.provider}；版本：${result.versions.map((item) => `${item.version}(${item.status}${item.sunset ? ` sunset=${item.sunset}` : ''})`).join(', ')}`,
          `直接消费者：${result.directConsumers.join(', ') || '无'}；传递消费者：${result.transitiveConsumers.join(', ') || '无'}`,
          ...result.propagation.map((item) => `- 传播 ${item.from} --${item.via}--> ${item.to}`),
          `coordinationCost = ${result.coordinationCost}（必须一起发布的仓数——这个数字就是决策）`,
          `建议：${result.advice}`
        ]);
        return 0;
      }
      if (sub === 'status') {
        const result = await fleetStatus(state, { deep: Boolean(flags.deep) });
        const rowLine = (row) => {
          const healthy = row.exists && row.installed && row.doctorOk && (!result.deep || row.dodOk !== false);
          const detail = !row.exists ? `路径不存在（${row.path}）`
            : !row.installed ? '未安装 kimi-base 引擎'
            : `doctor exit ${row.doctorExit}${result.deep ? `；dod exit ${row.dodExit}` : ''}${row.note ? `；${row.note}` : ''}`;
          return `- ${healthy ? 'OK' : '问题'} ${row.id}：${detail}`;
        };
        printResult(result.ok ? 'fleet status 通过' : 'fleet status 有问题仓（exit 1）', [
          `fleet：${state.file}；仓库 ${result.repos} 个${result.deep ? '（--deep 含 dod）' : ''}`,
          ...result.rows.map(rowLine),
          ...(result.problems.length ? [`问题仓：${result.problems.join(', ')}`] : [])
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'recap') {
        const result = await fleetRecap(state, { budget: flags.budget !== undefined ? Number(flags.budget) : undefined });
        printResult(`fleet recap（${result.chars}/${result.budget} 字符${result.truncated ? '；已截断' : ''}）`, result.text.split('\n'));
        return 0;
      }
      throw usageError(`未知 fleet 子命令：${sub ?? '<缺>'}（lint/impact/status/recap）`);
    }
    case 'release': {
      const ctx = await needProject();
      const result = await releaseReadiness(ctx);
      printResult(result.ready ? 'release：READY' : 'release：NOT READY（exit 2）', [
        result.never,
        ...result.items.map((item) => `- [${item.ok ? 'x' : ' '}] ${item.id}${item.blocking ? '（阻断）' : '（建议）'}${item.detail ? `——${item.detail}` : ''}`),
        result.ready
          ? '全部阻断条件成立。人可以据此签字、打 tag、发布。'
          : `阻断项：${result.blockers.join('、')}——先修复再谈发布。`
      ]);
      return result.ready ? 0 : 2;
    }
    case 'selftest': {
      const result = await selftestCommand();
      return result.ok ? 0 : 1;
    }
    default:
      throw usageError(`未知动词：${verb}；运行 --help 查看全部动词`);
  }
}

export async function main() {
  try {
    const code = await dispatchCommand(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    if (error instanceof HarnessError) {
      // 退出码契约 v2 标签：1=用法/违例 2=治理阻断 3=降级 4=陈旧证据
      const label = { 1: '错误', 2: '治理阻断', 3: '降级', 4: '陈旧证据' }[error.exitCode] ?? '错误';
      process.stderr.write(`${label}[${error.code}] ${error.message}\n`);
      if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      process.exitCode = error.exitCode;
    } else {
      // 未预期异常 = 引擎错误（exit 3）：显式报错，绝不静默吞错。
      process.stderr.write(`内部错误[ENGINE_ERROR] ${error?.stack ?? error?.message ?? String(error)}\n`);
      process.exitCode = 3;
    }
  }
}
