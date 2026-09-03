# kimi-base Product Spec

版本：v2.0.1 · 状态：v2.0 重构进行中 · 变更史见 `Product-Spec-CHANGELOG.md`

## 1. 定位

面向 Kimi Code CLI 的项目级 AI 编程 harness 开发脚手架。复用 Kimi Code 原生能力（插件 / hooks / custom agents / skills / 斜杠命令 / AGENTS.md / Plan 模式 / Goal 模式 / 后台任务），补齐宿主没有的工程治理：任务绑定、Git 证据指纹、模块目录与架构防腐、影响分析、验证回执、五性治理、安装升级、会话恢复、需求可判定性与追溯。目标场景：60 万行级、多模块、长周期仓库。

核心矛盾：**防止 AI agent 在大仓上失控**——无证据声称完成、覆盖用户改动、架构边界漂移、质量属性无人认领、上下文撞墙后状态丢失。

## 2. 目标用户

- 使用 Kimi Code CLI 进行中大型项目开发的工程师与团队
- 需要对 AI 产出建立质量门禁与架构看护的技术负责人
- 有韧性/安全/功能安全/隐私/可靠性合规诉求的项目

## 3. 核心场景

1. 新项目 0→1：需求追问 → Spec 签字 → 架构设计 → 五性定档 → 计划 → 受治理的开发循环
2. 存量大仓接入（棕地）：模块骨架生成 → 存量债务基线固化 → 新债零容忍
3. 长会话/多会话接力：三文件同步 + 压缩前落盘 + recap 派生式恢复
4. 发布前把关：全量验证 + 五性覆盖判定 + 泄漏审计

## 4. 复制面与维护面

- **复制面**（源布局=安装布局，安装进目标项目）：`.kimi-base/`（runtime/rules/templates/adapters/三个 example 种子）+ `.kimi-code/`（agents+skills）+ 根 AGENTS.md 种子
- **插件面**（用户级安装一次）：`kimi.plugin.json` + `plugin/`（sessionStart skill、斜杠命令；hooks 指向 runtime）
- **维护面**（只在源仓，永不进安装面）：`Product-Spec.md`、`DEV-PLAN.md`、`progress.md`、`docs/`、`tests/`、`package.json`、`.kimi-base/{harness,module-catalog,verification-matrix}.json` 自用配置、安装脚本

## 5. 功能需求

### 分发与安装

- REQ-001 仓库即插件：当用户执行 `/plugins install <path-or-url>` 时，仓库根的 `kimi.plugin.json` 必须声明 skills/commands/hooks/sessionStart.skill，且安装必须一键完成。
  验收：插件清单可被宿主解析（plugin 资产自检测试全绿），安装后 `/kimi-base:doctor` 可用。
- REQ-002 项目面注入：当对目标项目执行 `install <target>` 时，引擎必须把项目面（AGENTS.md 种子/.kimi-code/.kimi-base 种子+runtime）事务性安装进目标：staging、逐文件备份、post-hash 校验、失败时必须逆序 rollback。
  验收：空目录安装测试断言文件落地齐全且生成 install-receipt；故障注入测试（KIMI_BASE_INSTALL_FAIL_AFTER）非零退出且无受管残留。
- REQ-003 可升级不伤害定制：当 `upgrade` 遇到用户已定制文件时，必须以 LF 归一化 SHA-256 manifest 区分框架基线与定制；定制冲突必须写 `*.kimi-base-new` 旁路、不得覆盖；obsolete 文件仅未定制时才可删除。
  验收：升级测试断言旁路生成且原文件字节不变；种子三态（缺省落地/升级不覆盖/卸载仅删未改）测试全绿。
- REQ-004 当安装面漂移时，`doctor` 必须自检安装完整性（文件存在性、manifest 哈希、frontmatter 形状、rules 指针、JSON 可解析），存在 error 时必须非零退出。
  验收：完整安装 exit 0；删除必需文件后非零退出（doctor 测试组）。
- REQ-005 当发布打包前，`pack-check` 必须审计发布面：不得含 state/、私密反馈、旁路文件、秘密/个人路径模式，命中必须失败。
  验收：本仓 `pack-check` exit 0（自托管门禁测试与 CI 锁定）。

### Kimi 原生集成

- REQ-006 hooks 七事件必须全部接入：PreToolUse(Bash) 危险命令分类、PreToolUse(Write|Edit) 写前对账、Stop 完成门、UserPromptSubmit 反馈信号、SubagentStop 验收提醒、PreCompact 状态落盘、SessionStart 横幅。
  验收：hook 调度器测试组覆盖危险命令拦截/标记惰性/Stop 保险丝/pre-compact 落盘，全绿。
- REQ-007 标记惰性：当目标目录无 `.kimi-base/harness.json` 时，所有 hook 必须静默放行，非 kimi-base 项目必须零行为变化。
  验收：无标记目录中危险命令 hook 测试 exit 0 且无输出。
- REQ-008 项目级 custom agents 八角色（implementer/code-reviewer/tester/deployer/researcher/progress-recorder/feedback-observer/evolution-runner）必须用 Kimi 原生 frontmatter `tools`/`disallowedTools`/`subagents: []` 实现职责隔离与机械防递归。
  验收：八个 agent 文件 frontmatter 全部可解析且合法（doctor 与资产测试锁定）。
- REQ-009 项目级 skills 十六个工作流，frontmatter 必须合规：name==目录名（kebab-case）、description 必填且 ≤180 字符、不得写成流程摘要；模板必须以 `${KIMI_SKILL_DIR}` 引用子文件。
  验收：`skills-lint` 与 doctor 的 frontmatter 校验 exit 0。
- REQ-010 插件斜杠命令 `/kimi-base:init|doctor|status|verify|arch|recap|record|fast` 必须全部可用。
  验收：commands/*.md 八件齐备且 frontmatter 可解析（插件资产测试锁定）。

### 治理引擎（runtime，零依赖薄入口+lib 模块）

- REQ-011 任务账本：任何时候必须至多一个 active 任务；`task start` 必须对 ownedPaths 做 SHA-256 基线快照；当任务期间 owned 文件被任务外力量改动时，pre-write 钩必须阻断。
  验收：写前对账测试（基线偏离 exit 2）与 tasks.json 腐化降级留痕测试全绿。
- REQ-012 Git 证据指纹：指纹必须由 HEAD + 暂存/未暂存 diff + 未跟踪路径内容归一化哈希构成；任何字节变化必须使旧证据 stale。
  验收：指纹敏感性测试（改一字节指纹即变）；receipt verify 陈旧证据 exit 4。
- REQ-013 `gate` 必须输出四态 PASS/FAIL/BLOCKED/SKIPPED：缺命令必须 BLOCKED（绝不假绿）；空验证计划必须 BLOCKED；receipt 必须绑定 task/fingerprint/risk/argvHash/证据哈希；同 kind 后续 FAIL 必须覆盖旧 PASS。
  验收：gate 四态测试组（缺命令/空计划按 BLOCKED）与 runtime 类证据时间窗测试组全绿。
- REQ-014 当 `task complete` 时，任务风险层 required checks 必须全部持有 fresh receipt；缺口必须 exit 2 并逐条列出。
  验收：完成门测试（缺 receipt 拒 → gate 后放行 → 再改动 stale 再拒）全绿。
- REQ-015 架构防腐三件套：`catalog lint` 必须保证每条 tracked 路径有主并拒绝 catch-all 与 UNJUSTIFIED_TIER；`arch check` 必须对账真实 import 边与声明图（禁边>分层>未声明、环检测、禁令赢声明）；`adr check` 必须把 Enforced-by 幽灵引用判 FAIL。
  验收：arch/catalog/adr 三个测试组全绿。
- REQ-016 债务棘轮：`arch baseline --write` 必须固化存量违规（每条带 reason、进 git 可评审）；新债必须零容忍；已还清条目必须标 stale 催删；`arch trend --record|--gate` 必须按逐指标历史最优棘轮，回弹必须 exit 1。
  验收：baseline 三态测试与 arch trend best-ever 棘轮测试（含 debt-swap 回弹拦截）全绿。
- REQ-017 五性治理闭环：模块定档（critical/high/medium/low/minimal/none；none/minimal 必须附书面 reason）→ 检查认领属性 → 覆盖判定：critical/high 缺 fresh PASS 或存在 FAIL 反证时必须判 uncovered 阻断；反证必须压过佐证；SKIPPED 不得覆盖也不得反证。
  验收：属性覆盖测试组（无认领 exit 2 / fresh PASS 放行 / FAIL 反证 uncovered）全绿。
- REQ-018 保护属性：security 与 safety 必须永不豁免（waiver 创建期+运行期双重写死）、永不 fast-skip；waiver 仅可豁免 BLOCKED/SKIPPED，必须带 approver/reason/expires/compensation 且绑定 fingerprint。
  验收：waiver 测试组（FAIL 禁豁免/禁词拒绝/过期失效）全绿。
- REQ-019 内置 fitness 五规则 no-secret-literal / no-pii-in-logs / no-silent-failure / no-unbounded-retry / no-unreferenced-deferral 必须零依赖内置；必须支持 `kimi-base-ignore:` 同行抑制注释并留痕。
  验收：fitness 测试组五规则各自命中且抑制生效。
- REQ-020 大仓能力：`impact` 必须给出反向依赖闭包且对 unmapped 保守扩散；`context pack` 必须预算化，DENY 清单凭据永不入包，装不下必须进 omitted 显式报告；扫描必须有界（glob 缓存/文件数与字节上限）。
  验收：context pack 测试（.env/id_rsa 不入包、超预算 omitted 显式列出）与 outputLimits 封顶测试全绿。
- REQ-021 当 `fast on` 时，Fast Mode 必须显式开启、默认 24h TTL 自动过期、状态可见；保护属性/种类必须免疫；每个 skip 必须留痕。
  验收：fast mode 测试组（TTL 倒计时/off 立即失效/过期视同关闭/security 不跳过）全绿。
- REQ-022 当同一阻断指纹连拦 3 次后，Stop 完成门保险丝必须放行并醒目提示欠账，不得锁死会话。
  验收：hook stop 测试（连拦 3 次后第 4 次 exit 0）。
- REQ-023 证据生命周期：evidence 必须脱敏落盘；ledger 必须哈希链（断链 fail-closed 视同未验证）；`retention prune` 必须按策略销毁且保护被引用证据；账本超 `retention.ledgerMaxEntries` 必须轮转并以 anchor 跨段续链。
  验收：ledger 轮转测试（轮转触发/跨段 verify 通过/篡改 anchor fail-closed）全绿。
- REQ-024 危险命令分类器必须语义解析穿透 sudo/env/timeout wrapper 与嵌套 shell；rm -rf/git reset --hard/git clean/凭据外发（含跨管道）必须阻断；拦截必须全部记 gate-log；`gate-audit` 必须审计死闸（从未拦过的闸要拿证据或撤掉）。
  验收：分类器测试组（wrapper 穿透/长选项不模糊缩写/融合凭据操作数/gate-audit 派生清单）全绿。
- REQ-025 开发态进程守护：supervisor 必须提供退避拉起/健康探针/重启风暴熔断/日志轮转；只允许 kill 自己启动的进程；必须明示"不是生产 init"。
  验收：`supervisor.mjs` 无参调用输出用法声明且 exit 1（资产测试锁定）。

### 工作流与记忆

- REQ-026 需求质量：当收集需求时，product-spec-builder 必须六维收集 + 信息充足度判断（不足必须继续追问、不得硬写）+ Spec 签字闸 + Spec/CHANGELOG 成对更新。
  验收：skill 资产测试断言触发式 description 与签字闸规则存在。
- REQ-027 计划质量：dev-planner 产出必须无占位符；Task 五要素（Goal/Scope 到文件路径/Dependencies/Verification 命令/Expected 可判定）必须齐全。
  验收：skill 资产测试断言五要素与无占位符规则存在。
- REQ-028 项目记忆：progress.md 必须维持八区块（Pinned/Decisions/待办/In Progress/Done/Risks & Assumptions/Notes/Context Index）；Done 条目必须带证据指针；弱化词必须降级 Notes；归档必须只增不删。
  验收：memory 测试组（recap 派生视图/archive 移动最旧条目并留指针）全绿。
- REQ-029 三文件同步：当代码改动而 progress.md 未同步时，Stop 门必须拦截；`sync-check` 必须把 MEMORY_BEHIND_CODE 与 SPEC_WITHOUT_CHANGELOG 判 exit 1；恢复时必须读齐 progress+Spec+CHANGELOG（+compaction-note）。
  验收：sync-check 测试组（记忆落后/成对通过/纯文档放行/--staged 形态）与 Stop 门测试全绿。
- REQ-030 反馈进化：当 feedback 聚类达阈值时必须生成提议（≥3 次毕业为规则、低分优化 skill、≥5 次提议新 skill）；每条提议必须经用户确认，绝不自动改规则。
  验收：feedback-writer/evolution-engine skill 资产测试（用户确认闸规则存在）全绿。

### 评审、记忆法与需求治理（v2.0）

- REQ-031 结构化对抗评审：`review` 必须实现 blue 自证（claim 缺证据整批拒绝）→ lens 报到（finding 必须带 file:line 或复现，否则整批拒绝）→ verdict 计算裁决（任一 error 即 FIX_REQUIRED，应到 lens unable 即 NEEDS_MORE_EVIDENCE）；回执必须只在终审 ACCEPT 写入账本，消费者只认回执；会话必须绑定 diffHash/HEAD，树动即 stale。
  验收：review 测试组全绿（报到校验/阶段门控/裁决矩阵/回执绑定/backlog 跨会话）。
- REQ-032 记忆法动词：`recap` 必须是派生视图（Position 现算，不信任何摘要）且预算化（总量 ≤ 预算、截断显式、缺 progress.md exit 3）；`invariants` 必须 ≤1200 字符且含实时状态（活跃任务/fast 窗口/最近 gate/账本断链）；`archive` 必须默认 dry-run、移动最旧 Done/Notes 并留指针行、归档只增不删；sessionStart 必须默认附带 invariants 摘要（hooks.injectInvariants 可关）。
  验收：memory 测试组全绿（预算遵守/exit 3 降级/归档指针/sessionStart 注入与开关）。
- REQ-033 需求可判定与追溯：`spec lint` 必须把非规范措辞/无度量 NFR/占位符/重复 id/缺验收判 error；`trace` 必须在覆盖率低于 spec.minCoverage 或代码·测试存在悬空引用时 exit 1（文档悬空只报告），且只扫 REQ/NFR 两个声明族（对称规则）；`spec view` 必须预算化且省略逐条显式点名。
  验收：spec 测试组全绿（各违例类/覆盖门禁/悬空引用/路径过滤/预算省略）。
- REQ-034 宪法执法率：`rules-audit` 必须把规则行分类为 enforced/declared-prompt-only/unenforced 并报告执法率；默认必须纯建议（exit 0）；当 rulesAudit.maxUnenforced 设数字且超限时必须 exit 1。
  验收：rules-audit 测试（三态计数 + 阈值接线）全绿。
- REQ-035 资产 lint：当 skill/agent 资产漂移时，`skills-lint` 必须校验 name==目录名/description 长度（>500 字符 error）/体积/重名；`agents-lint` 必须把根 AGENTS.md 缺失与 >16000 字节判 error；两者 error 必须 exit 1。
  验收：skills-lint/agents-lint 测试（名不符/描述超长/AGENTS.md 缺失/超体积）全绿。

### 三面执法与规模化治理（v2.0 P5/P6）

- REQ-036 第二道闸（git hooks 电池）：当执行 `install --hooks` 时，引擎必须把 `.kimi-base/githooks/` 的 pre-commit/commit-msg/pre-push 以 100755 挂载进目标仓 index 并设置 core.hooksPath；pre-commit 必须对暂存区跑 scan-secrets（机密拦截、干净放行、无标记项目静默）；commit-msg 必须拦截过短/废话消息（Merge 豁免）；非 git 仓挂载必须响亮降级且不回滚安装主事务。
  验收：audit 测试组（hooksPath 与 100755 入 index/暂存机密被拦/干净暂存 exit 0/无标记静默/commit-msg 三态/非 git 降级）全绿。
- REQ-037 审计独立：当 `.kimi-base/audit/` 审计脚本被新增或修改时，其必须保持零第三方依赖（只允许 node: 前缀 import）且不得 import 引擎（`../runtime` 或 `.kimi-base/runtime` 引用必须为零）——审计者与被审计者必须独立。
  验收：audit 独立性静态测试（import 面扫描 + 依赖面扫描）与 arch 禁边（audit 对 engine 的 forbiddenDependencies）全绿。
- REQ-038 dod 静态电池：当执行 `dod` 时，引擎必须以真实 CLI 子进程跑齐九步电池（catalog lint/skills-lint/agents-lint/spec lint/adr check/fitness --all/trace/receipt verify/arch check）；任一步 FAIL 必须 exit 2 并点名失败步骤；无 FAIL 但有 DEGRADED 必须 exit 3，降级不得静默成通过。
  验收：dod 测试（绿灯仓九步全 PASS exit 0；植入 catalog 违例 exit 2 且点名失败步骤；未知 flag exit 1）全绿。
- REQ-039 模块发现：当存量仓无 catalog 时，`catalog discover` 必须从真实 import 边与目录成组生成模块提案（属性信号只来自生产源码）；`--write` 在无 catalog 时必须直写且草案通过 catalog lint 与 arch check，已有 catalog 时必须写 draft 不得覆盖；无可提案（无目录成组/非 git）必须降级 exit 3。
  验收：discover 测试组（提案含正确模块与真实边/--write 两态/降级 exit 3 与 init-modules 别名转发）全绿。
- REQ-040 共变耦合：当提交历史显示模块对高耦合时，`cochange` 必须对无声明边报 BOUNDARY_SUSPECT（exit 1）、薄历史附 LOW_CONFIDENCE 不拦；已声明依赖边必须降为 warning（exit 0）；catalog cochange.accepted 三元组必须降级为 warning 且缺理由/引用未知模块必须被 catalog lint 判 error；无提交历史（unborn）必须 exit 3。
  验收：cochange 测试组（BOUNDARY_SUSPECT/HIGH_COUPLING 降级/ACCEPTED_COUPLING 降级/三元组校验/unborn 降级）全绿。
- REQ-041 上下文预算：当 harness.json 配置 budget 段时，`budget` 必须按声明指标度量暂存区（--staged）或提交区间（--baseline）；预算内必须 exit 0；超限必须 exit 1、逐指标报告并给出固定话术；未配置 budget 段必须 exit 3（未激活不是通过）；未知配置键必须被严格校验拦下。
  验收：budget 测试组（未配置 exit 3/预算内 exit 0 与超限 exit 1/--staged 与 --baseline 口径/坏 ref 与未知键 exit 1）全绿。
- REQ-042 多仓舰队：当仓内存在 fleet.json 时，`fleet` 必须提供 lint（dangling consume/deprecated 无 sunset/sunset 已过判 error，契约环判 warning 且响亮报告）与 impact（传递闭包与 coordinationCost，未知契约 exit 3 并给已知清单）；status 必须对裸仓与缺失路径逐仓如实分列（exit 1），recap 对裸仓必须如实降级 exit 0；无 fleet.json 必须 exit 3（单仓模式不假装多仓）。
  验收：fleet 测试组（lint 违例分类/契约环 warning/impact 闭包与未知契约/status 逐仓降级/无 fleet.json exit 3）全绿。
- REQ-043 隐私底线：当 waiver 或 fast-skip 触及 privacy 时，引擎必须把 privacy 与 security/safety 同列保护：对认领 privacy 的检查创建 waiver 必须被拒（waiver 理由文本含"隐私"同样被拒）；protected 检查声明 allowFastSkip 必须在配置期拒绝（kind 与属性双通道）；fast mode 运行期不得延期 privacy 属性。
  验收：privacy 测试组（waiver 双拒/allowFastSkip 双通道配置期拦截/fast 窗口内 reliability 被延期而 privacy 不延期）全绿。
- REQ-044 发布就绪判定：当执行 `release` 时，引擎必须组装八项条件（dod 静态电池/fast 窗口关闭/fast 欠账已还/账本链与证据完好/当前指纹 fresh 回执/三文件同步干净/评审 backlog 无过期/风险扫描为建议项）；阻断项未过必须 exit 2 并逐一点名；该命令必须永不打 tag、永不 push、永不建分支。
  验收：release 测试组（干净夹具 + fresh gate 回执 READY exit 0 并明示永不 tag/push/建分支；缺 fresh 回执 exit 2 点名 receipt-fresh；fast 窗口开启 exit 2 点名 fast-mode-closed）全绿。

## 6. 非功能需求

五性治理属性集：resilience / security / safety / privacy / reliability（其中 security/safety/privacy 为保护底线）。

- NFR-001 治理引擎（kimi-base.mjs + lib/）必须零第三方运行时依赖：仅用 Node 18 LTS 内置模块，package.json 运行时 dependencies 必须为 0 项。
  验收：引擎隔离测试扫描全部 import 断言 100% 为 node: 前缀。
- NFR-002 性能预算：PreToolUse hook 常规路径必须 <100 ms；60 万行/64 模块合成仓 impact 必须 <5 s、catalog lint 必须 <10 s（合成基准）。
  验收：性能冒烟测试（500 文件合成仓 catalog lint <10 s）全绿。
- NFR-003 跨平台：必须支持 Linux/macOS 原生与 Windows Git Bash；ps1 脚本必须 100% ASCII。
  验收：ps1 ASCII 资产测试全绿；CI 矩阵覆盖 ubuntu + windows 双平台。
- NFR-004 治理引擎必须 100% 无网络访问（node:http/https/net 引用 0 处；supervisor 的健康探针是其职责内唯一例外）；不得读写目标项目外路径，symlink/realpath 必须防逃逸。
  验收：引擎隔离测试断言网络模块 0 引用；写路径逃逸防护由 pre-write 测试锁定。
- NFR-005 诚实降级：缺工具/缺命令/非 git 仓必须 100% 显式（BLOCKED 或 exit 3 + 可见 note），绝不假绿；fail-open 边界必须写入文档。
  验收：退出码契约测试组（非 git 降级 exit 3、未知 flag exit 1）全绿。
- NFR-006 自身质量：`node --test` 必须 100% 通过、doctor 必须零 error、manifest 必须无漂移、pack-check 必须零泄漏。
  验收：本仓门禁（selftest/doctor/manifest --check/pack-check）与全部测试在 CI 与本机全绿。

## 7. 明确非目标

- 不做第二套 Agent runtime / 不修改 Kimi Code 内核 / 不承诺 OS 沙箱隔离。
- 不捆绑不安装任何外部扫描工具（semgrep/gitleaks/k6 等走 adapters 声明，缺失=BLOCKED）。
- 不做多 agent 并行写编排（写串行；只读工作可 fan-out 且需用户显式 opt-in）。
- 不做 CI 平台集成（提供本地门禁与命令，CI 接线由用户项目自行决定）。
- 不做需求工单系统对接（任务信封止于 task ledger）。

## 8. 成功标准

1. 在空目录 `install` 后，一次完整 需求→计划→编码→gate→完成 链路可走通，且缺证据时完成门真实阻断。
2. 在 60 万行合成仓上 impact/catalog lint 满足性能预算。
3. 危险命令（含 wrapper 穿透与凭据外泄变体）被 PreToolUse 拦截并记账。
4. 全部测试通过；doctor/manifest/pack-check/spec lint/trace 自检零 error。
5. 在未安装插件的项目中，所有 hook 静默（零干扰证明）。
