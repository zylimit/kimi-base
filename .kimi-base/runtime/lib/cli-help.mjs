// lib/cli-help.mjs —— CLI 帮助文案（HELP_GLOBAL/HELP_VERBS）与输出整形（printResult）
// 纯数据 + 纯函数；自 cli.mjs 下沉（P13 拆分），cli.mjs 保留 dispatch 与控制流。

import process from 'node:process';
import { TOOL_VERSION } from './core.mjs';

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
  feedback record --topic T --type Y --description D
                                   记录进化信号（同主题去重 occurrences+1；INDEX 机器维护）
  feedback list | scan | propose [--skip T]
                                   五字段清单 / 毕业候选扫描（只读）/ 结构化提议（永不自动改规则）
  strength list|status|set --profile P|explain [--risk R] [--operation O] [--paths a,b]
                                   强度策略引擎：四内置档×12 封闭控制轴；extends 只收紧；
                                   floor 只升不降取最高；rollout=shadow 只报告不阻断
  risk scan                        主动风险识别（腐化/stale/脏树/死锁残留）
  gate-audit                       死闸审计（从未拦过的闸要拿证据或撤掉）
  retention prune [--dry-run]      证据/上下文按保留策略销毁
  hook <event>                     hook 调度器（pre-tool-use-bash/pre-write/stop/
                                   prompt-submit/subagent-stop/pre-compact/session-start）
  init-modules [--write]           （已废弃别名，转发 catalog discover）生成 module-catalog 骨架
  catalog discover [--write] [--depth N] [--level L0|L1|L2|L3]   从仓库事实推导 catalog 草案（目录分组+真实 import 边+
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
  agents-lint                      根 AGENTS.md 必备与体积预算（>6000 字节 exit 1，REQ-059）
  dod                              Definition of Done 电池（静态电池 + matrix 检查按
                                   inner/middle/outer 三层分组；inner/middle FAIL exit 2，
                                   outer FAIL 响亮可见不阻断，仅降级 exit 3）
  selftest                         运行时自身冒烟
  help                             本帮助

每个动词支持 --help 查看细则。未知 flag 一律 exit 1 并列出该动词的合法 flag。`;

const HELP_VERBS = {
  install: `install <target> [--dry-run] [--hooks]\n  把 <源仓>/.kimi-base/ 与 .kimi-code/ 复制面事务性安装进 target（源布局=安装布局）；\n  种子配置（harness/module-catalog/verification-matrix 的 example、AGENTS.md）仅缺省时写入。\n  staging + 逐文件备份 + post-hash 校验 + 失败逆序 rollback。\n  REQ-065 maintenance marker：事务执行期间写 .kimi-base/state/maintenance.json，\n  正常完成/回滚后移除（只删自己 installId 的 marker）；marker 已存在即拒跑（exit 3，\n  防并发互踩），存在期间 doctor 与治理动词拒跑（exit 3 并点名 marker）。\n  --hooks：安装后挂载第二道闸——git config core.hooksPath .kimi-base/githooks\n  + 三钩子 chmod 755 + git add --chmod=+x（目标非 git 仓 = 响亮降级，不回滚安装）。\n  故障注入：KIMI_BASE_INSTALL_FAIL_AFTER=<n>（测试用）。\n  写 .kimi-base/state/install-receipt.json。`,
  upgrade: `upgrade <target> [--dry-run] [--hooks]\n  LF 归一化 SHA-256 区分框架基线与用户定制：\n  未定制→安全升级；已定制→保留并写 <file>.kimi-base-new；obsolete 仅未定制才删。\n  --hooks：同 install——（重）挂载 core.hooksPath 并刷新三钩子可执行位。`,
  uninstall: `uninstall <target> [--dry-run]\n  仅删除与安装清单哈希一致的文件；用户定制的一律保留并列出。`,
  manifest: `manifest --write|--check\n  生成/校验源仓 FRAMEWORK-MANIFEST.json（.kimi-base/+.kimi-code/ 复制面稳定资产；\n  排除 state/、源仓自身治理配置、*.kimi-base-new、私密 feedback）。`,
  doctor: `doctor [target]\n  自检安装完整性：必需文件存在、manifest 哈希比对、agents/skills\n  frontmatter 形状（name kebab-case、description ≤180）、rules 指针、JSON 可解析。\n  无参时自 cwd 向上找项目根；对源仓自动切换为源仓模式。error → 非零退出。`,
  'pack-check': `pack-check\n  发布面审计：无 state/、无私密 feedback、无 *.kimi-base-new、manifest 完整；\n  泄漏扫描（token/私钥/个人路径正则）命中即失败。`,
  task: `task start --goal "目标" --owned "glob,glob" --risk low|medium|high\n  task status | task complete | task cancel\n  单 active 任务；start 对 ownedPaths 做 SHA-256 基线快照；\n  complete 执行完成门：风险层 required kinds 全部 fresh receipt，缺口 exit 2。`,
  gate: `gate [--risk low|medium|high] [--kind static|unit|integration|build|security|smoke] [--dry-run]\n  风险累积并集：high ⊇ medium ⊇ low。四态 PASS/FAIL/BLOCKED/SKIPPED。\n  缺命令=BLOCKED；空计划=BLOCKED；SKIPPED 仅 fast mode + allowFastSkip + 非 protected。\n  每次执行写 receipt（绑 task/fingerprint/risk/argvHash/证据哈希 + Receipt v2 三面：\n  policyHash/engineHash/catalogHash，无配置显式 null）并入哈希链账本。\n  fast 窗口内每条被跳检查另记 kind=deferred 债务条目入账本（REQ-054）。`,
  quality: `quality status\n  五性覆盖判定：模块定档 critical/high 的属性需 fresh PASS 认领证据；\n  反证压过佐证；声明未接线即缺口；SKIPPED 不覆盖也不反证。uncovered → exit 2。\n  runtime 类检查（matrix check 声明 "class":"runtime"）的回执带 validUntil 与\n  time-window-<N>h 标签：时间窗内不随树指纹过期，窗口过期即不 fresh。\nquality waiver create --check K --approver X --reason R --expires ISO --compensation C\n  禁词（security/safety/privacy/pii/secret/credential/destructive/隐私/个人信）拒绝；已执行 FAIL 永不可豁免；\n  过期/跨 fingerprint 自动失效。\nquality waiver list  列出全部 waiver 及其有效性。`,
  waiver: `waiver create --check K --approver X --reason R --expires ISO --compensation C
waiver list
  quality waiver 的顶层别名（两种叫法都合法），语义与 quality waiver 完全一致；详见 quality --help。`,
  arch: `arch check [--scan]\n  声明图（环/禁令/分层方向）恒查；--scan 扫描真实 import 边（JS/TS/Py/Go/Java/\n  Kotlin/C#/Rust/Ruby/PHP/Swift）对照声明图。发现违规 exit 1；非 git 仓 = 降级 exit 3（无法测量）。\narch baseline --write [--reason "..."]\n  存量违规固化为 .kimi-base/arch-baseline.json（每条带 reason，进 git 可评审）；\n  新债零容忍；已还清条目标 stale 要求删除。\narch trend --record|--gate\n  漂移指标快照与棘轮门：当前指标对比逐指标历史最优（best-ever），回弹 exit 1；\n  REQ-064：历史最优显式持久化为 arch-trend.json 的 bestEver 独立字段，\n  --gate 只信持久化的 bestEver——样本截断不抬天花板，还债后天花板永降；\n  无快照时 gate 通过并注明 baseline:true（先 --record 建立基线）。`,
  adr: `adr check\n  扫描 docs/adr/*.md（或 harness.json adrDir）：活跃 ADR 必须有 Enforced-by: 行，\n  引用必须是真实 check id / fitness 规则，或显式 manual: 前缀；幽灵引用 exit 1。`,
  catalog: `catalog lint [--paths a,b]\n  每条 git tracked 路径必须归属某 module / globalPaths / 带 reason 的 ignored；\n  拒绝 catch-all（裸 **）；OVERLAP/DANGLING_DEP/UNJUSTIFIED_TIER 全拦（exit 1）。\n  非 git 仓且无 --paths = 降级 exit 3。\ncatalog discover [--write] [--depth 2] [--level L0|L1|L2|L3]\n  从仓库事实推导 catalog 草案：源码目录分组（≥2 文件成组，顶层目录兜底）、\n  真实 import 边推导 dependsOn、tier-N 位置分层（tier-1 最内层=无依赖基础层）、\n  构建清单命令检测（package.json/pyproject/go.mod/Cargo/Makefile）、\n  生产源码属性信号提案（封顶 high，≥2 文件或 ≥2 词才成提案，测试夹具不触发）。\n  渐进采用阶梯（REQ-063，缺省 L1）：L0 最小钩子面（裁掉 layers/attributes/属性提案，\n  不生成 verification-matrix.json）；L1 现状全量草案；L2 保留 layers+attributeProposals\n  （五性/arch 治理面）；L3 全量+fleet 仓群治理引用。非法 level exit 1 并列合法集。\n  猜不了的字段（属性档位/forbiddenDependencies/层名/矩阵接线）进 needsDecision，绝不替人决定。\n  --write：已有 catalog 写 module-catalog.draft.json，否则写 module-catalog.json。\n  无可提案（非 git/空树/无目录成组）→ exit 3。init-modules 是废弃别名，转发本命令。`,
  fitness: `fitness [--path p1,p2] [--staged] [--all]\n  内置五规则：no-secret-literal(error)、no-pii-in-logs(error)、no-silent-failure(error)、\n  no-unbounded-retry(warning)、no-unreferenced-deferral(warning，safety>=high 模块)。\n  抑制：同行注释 kimi-base-ignore: <rule>（留痕）。error 级命中 exit 1。\n  扫描面优先级：--path > --all（全仓 tracked∪未跟踪，dod 用）> --staged（暂存区，pre-commit 用）\n  > 默认工作树变更面；非 git 且无 --path = 降级 exit 3。`,
  impact: `impact <paths...> 或 impact --git [--risk R]\n  变更路径→模块归属→反向依赖闭包→受影响检查计划（planHash 含 risk）。\n  unmapped/shared/global/截断 → 保守扩散到全模块（宁可全跑不可漏测）。`,
  context: `context pack [--budget 60000] [--focus "glob,glob"]\n  预算化最小上下文包：focus+impact 选面；DENY 清单（.env/*.pem/id_rsa/.ssh/.aws/\n  *.key/*secret*）永不入包；装不下的进 omitted 显式报告；输出含 packHash。`,
  receipt: `receipt verify\n  证据账本哈希链校验（chain=sha256(prev+contentHash)），含轮转 anchor 跨段续链；\n  证据文件重哈希。篡改/断链/缺失/漂移 fail-closed → exit 2；\n  链完好但回执绑定面已移动（陈旧证据）→ exit 4 并点名漂移面：指纹（diffHash）\n  或 Receipt v2 的 policyHash（策略）/engineHash（引擎树）/catalogHash（架构图）。\n  v1 旧回执按 v1 绑定面判定，缺新字段不谎报篡改；committed 证据模式下只动\n  .kimi-base/state/** 的证据入库提交不算漂移（clone 换机后直接可验）。`,
  review: `review start [--base <ref>]     开启评审会话：绑定当前指纹（diffHash）；空 diff → exit 3（no-change）。\n  --base 进入 range 模式：hash=sha256(git diff <ref>...HEAD)，HEAD 不变即有效。\n  重开时上一轮裁决摘要进 lineage（跨轮存活）后重新绑定。\nreview blue                     stdin {"claims":[{"claim","evidence"}]}：作者自证（只作靶子）；\n  缺 claim/evidence 整批拒绝 exit 1；会话陈旧 exit 4。\nreview lens <name> [--ad-hoc]   stdin {"findings":[{"severity","message","location"?,"reproduction"?}],\n  "unable"?,"unableReason"?}。severity ∈ error|warning|info；每条 finding 必须有\n  location（:行号 结尾，兼容 Windows 路径）或 reproduction，一条非法整批拒绝 exit 1。\n  非召集 lens 须 --ad-hoc（额外证据，不门控，error 仍计入裁决）；阶段门控越级拒报（stageGated:true）。\nreview verdict [--reviewer X] [--notes T]   裁决是计算的：阻断（blue 缺/前沿 lens 未报到）exit 1；\n  任一 error → FIX_REQUIRED exit 2；应到 lens unable → NEEDS_MORE_EVIDENCE exit 3；否则 ACCEPT exit 0。\n  round=lineage+1；FIX_REQUIRED 达 maxRounds（catalog.review.maxRounds，默认 3）→ escalate:true。\n  回执只在 ACCEPT 且终审时写入账本（kind:review）；消费者只认回执，不认本退出码。\nreview status                   会话摘要（阶段进度/已报/未报/backlog 结转/裁决）；无会话 exit 3。\nreview team                     打印召集 lens（含阶段）+ 剔除 lens（含原因）+ 生效剖面。\nreview backlog add              stdin {owner,expiry,summary,lens,location?}；expiry 须未来；\n  summary 命中 security|safety|privacy|pii|secret|credential|密码|密钥|凭据 → 拒绝 exit 1\n  （启发式拦截，非保证）。backlog 存 state/review-backlog.json，跨会话存活。\nreview backlog list             全部条目，过期者标记。review pack\n  证据包：base（最新 tag→origin/main→HEAD~1→根提交）、commit 清单、diffstat、\n  删除审计、未跟踪文件、完整 diff（>800 行溢出到 diff-<epoch>.patch）；\n  写 state/review/review-pack-<epoch>.md。非 git → exit 3。`,
  fast: `fast on [hours=24] | fast off | fast status\n  限时质量旁路（.kimi-base/state/fast-mode.json，expires_epoch）。\n  protected 属性/kind（security/safety/privacy）免疫；每个 skip 留痕。\n  fast 是借账不是折扣：窗口内每条被跳检查记 kind=deferred 债务条目入哈希链账本；\n  关窗/过期/删 fast-mode.json 均不清债，risk scan 报 FAST_MODE_DEBT 直至偿清；\n  带 fastWindow 印记的回执不能关闭 task/release；还债路径唯一——窗口外同检查 fresh PASS。`,
  feedback: `feedback record --topic <主题> --type <五类之一> --description <描述> [--scores <JSON> --evidence <JSON>]\n  记录进化信号：topic 归一化（trim+小写+空白/下划线/连续连字符折叠为单连字符），同主题去重\n  occurrences+1 并刷新 updated；frontmatter 七键与 FEEDBACK-INDEX.md 由引擎单一维护；\n  读-改-写由跨进程文件锁互斥（并发不丢计数）。\n  --scores/--evidence（REQ-081）：效能评分（accuracy/coverage/efficiency/satisfaction，1-5 整数）\n  与逐分一句话依据（均内联 JSON 对象）；带分数条目必须附 evidence（缺任一分维度依据即 exit 1），\n  无分数条目不接受 --evidence。\n  type 合法集：user-correction / uncovered-scenario / repeated-operation / quality-issue / skill-effectiveness。\nfeedback list   五字段清单（主题/类型/occurrences/graduated/skipped）；空目录 exit 0 显式报空。\nfeedback scan   毕业候选扫描（不改任何规则与有效条目，exit 恒 0）：单条 occurrences≥3 → 毕业候选；\n  同 type 跨 ≥3 个主题 → 聚类候选；repeated-operation 且 occurrences≥5 → 新 skill 候选。\n  graduated/skipped 条目不报（宁漏不滥）；损坏条目（缺 frontmatter）隔离为 .corrupt-<ts> 并警告，不拖死扫描。\nfeedback propose [--skip <topic>]\n  对候选输出结构化提议：目标层优先级 可执行 check > fitness 规则 > skill 步骤 > AGENTS.md 散文，\n  每条带证据指针（feedback id + occurrences）；引擎永不自动改规则，落地恒需人工确认。\n  --skip：被拒提议记 frontmatter skipped:true（不删条目），之后 scan/propose 不再报该主题。`,
  strength: `strength list                       列出四内置档（explore/rapid/balanced/strict）与自定义档的逐轴生效值；\n  无 strength.json 也 exit 0（内置档客观存在）。\nstrength status                     当前生效档（strength.json profile，strength set 的 state 覆盖优先）、\n  逐轴生效值、policyHash、rollout 模式；无 strength.json → exit 3（治理未开启）。\nstrength set --profile <档名>       写 .kimi-base/state/strength.json 覆盖当前档；未知档名 exit 1 列合法集。\nstrength explain [--risk low|medium|high|critical] [--operation develop|complete|package|release|deploy]\n  [--paths a,b]                    逐轴标注最终值来源（builtin/extends/floor:risk/floor:operation/\n  floor:attribute/floor:path）；floor 只升不降、多 floor 冲突逐轴取最高；\n  --paths 命中治理面 .kimi-base/** 或信任边界（auth/security/secrets 路径段）→ strict；\n  受影响模块声明 security/safety/privacy @ high+ → strict（floor:attribute）。\n  每次解析写有界 decision log（≤200 条，state/strength-decisions.jsonl，\n  含 policyRevision/inputDigest/reasons）。\n  配置契约：自定义档 extends 具名档逐轴只收紧，降级配置期报 STRENGTH_WEAKENING exit 1；\n  rollout=shadow 时只报告不阻断（status 响亮标注，task complete 的 completionMode 不执法）；\n  rollout=enforce 且生效档 completionMode=forbidden 时 task complete exit 2。`,
  risk: `risk scan\n  主动风险识别：状态腐化隔离、账本断链、FAIL 连击、stale 锁、fast 过期、\n  fast 证据贷款欠债（FAST_MODE_DEBT：账本里未偿还的 DEFERRED 条目）、\n  脏树规模、证据膨胀、stale baseline。按严重度输出。`,
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
  'skills-lint': `skills-lint\n  .kimi-code/skills/*/SKILL.md 契约：name kebab-case 且 == 目录名；description 必填、\n  >500 字符 error、>220 warning；正文 >24KB warning；重名 error；对话型 skill（内置清单）\n  缺「对话示例」/「反例」节 warning（REQ-075 坡道）。error → exit 1。`,
  'agents-lint': `agents-lint\n  根 AGENTS.md 必须存在（缺失 error）；>6000 字节 error（REQ-059 宪法瘦身预算：\n  宪法只放不变量+指针，细则下沉 .kimi-base/rules/）。error → exit 1。`,
  dod: `dod\n  Definition of Done 电池（子进程跑真实 CLI，静态电池定义唯一事实源 = lib/hygiene.mjs DOD_STEPS）：\n  catalog lint → skills-lint → agents-lint → spec lint → adr check → fitness --all（全仓）\n  → trace → receipt verify → arch check；外加 verification-matrix 全部检查（REQ-062）。\n  输出按三层分组：inner（commit 前秒级可阻塞）/ middle（评审级可阻塞）/ outer（趋势健康\n  信号性）。每步归级 PASS/FAIL/DEGRADED/STALE（1/2=FAIL、3=DEGRADED、4=STALE 不按 FAIL 计）。\n  inner/middle 层任一 FAIL → exit 2；outer 层 FAIL 响亮可见但不阻断；无阻断 FAIL 但有\n  DEGRADED → exit 3；全 PASS → 0。pre-push 钩子与 CI 的第二/三道闸。`,
  selftest: `selftest\n  运行时自身冒烟：哈希/指纹/回执往返/分类器样例/原子写/frontmatter/import 提取。`
};

export function printHelp(verb) {
  if (verb && HELP_VERBS[verb]) {
    process.stdout.write(`${HELP_VERBS[verb]}\n`);
    return;
  }
  process.stdout.write(`${HELP_GLOBAL}\n`);
}

// 输出助手：统一中文状态行。
export function printResult(status, lines) {
  process.stdout.write(`${status}\n`);
  for (const line of [].concat(lines ?? [])) process.stdout.write(`${line}\n`);
}
