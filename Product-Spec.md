# kimi-base Product Spec

版本：v1.0.0 · 状态：初版 · 变更史见 `Product-Spec-CHANGELOG.md`

## 1. 定位

面向 Kimi Code CLI 的项目级 AI 编程 harness 开发脚手架。复用 Kimi Code 原生能力（插件 / hooks / custom agents / skills / 斜杠命令 / AGENTS.md / Plan 模式 / Goal 模式 / 后台任务），补齐宿主没有的工程治理：任务绑定、Git 证据指纹、模块目录与架构防腐、影响分析、验证回执、五性治理、安装升级、会话恢复。目标场景：60 万行级、多模块、长周期仓库。

核心矛盾：**防止 AI agent 在大仓上失控**——无证据声称完成、覆盖用户改动、架构边界漂移、质量属性无人认领、上下文撞墙后状态丢失。

## 2. 目标用户

- 使用 Kimi Code CLI 进行中大型项目开发的工程师与团队
- 需要对 AI 产出建立质量门禁与架构看护的技术负责人
- 有韧性/安全/功能安全/隐私/可靠性合规诉求的项目

## 3. 核心场景

1. 新项目 0→1：需求追问 → Spec 签字 → 架构设计 → 五性定档 → 计划 → 受治理的开发循环
2. 存量大仓接入（棕地）：模块骨架生成 → 存量债务基线固化 → 新债零容忍
3. 长会话/多会话接力：三文件同步 + 压缩前落盘 + recap 恢复
4. 发布前把关：全量验证 + 五性覆盖判定 + 泄漏审计

## 4. 复制面与维护面

- **复制面**（安装进目标项目）：`template/` 全部（AGENTS.md、`.kimi-code/agents/`、`.kimi-code/skills/`、`.kimi-base/` 配置与 rules、templates）+ `runtime/`（治理引擎）
- **插件面**（用户级安装一次）：`kimi.plugin.json` + `plugin/`（sessionStart skill、斜杠命令；hooks 指向 runtime）
- **维护面**（只在源仓）：`Product-Spec.md`、`DEV-PLAN.md`、`progress.md`、`docs/`、`tests/`、`package.json`、安装脚本

## 5. 功能需求

### 分发与安装

- REQ-001 仓库即插件：`kimi.plugin.json` 位于仓库根，声明 skills/commands/hooks/sessionStart.skill，`/plugins install <path-or-url>` 一键安装。
- REQ-002 项目面注入：`install <target>` 把 template+runtime 事务性安装进目标项目（staging、逐文件备份、post-hash 校验、失败逆序 rollback）。
- REQ-003 可升级不伤害定制：LF 归一化 SHA-256 manifest 区分框架基线与用户定制；定制冲突写 `*.kimi-base-new` 旁路不覆盖；obsolete 文件仅未定制时删除。
- REQ-004 `doctor` 自检安装完整性（文件存在性、manifest 哈希、frontmatter 形状、rules 指针、JSON 可解析），error 非零退出。
- REQ-005 `pack-check` 发布面泄漏审计：无 state/、无私密反馈、无旁路文件、无秘密/个人路径。

### Kimi 原生集成

- REQ-006 hooks 七事件全部接入：PreToolUse(Bash) 危险命令分类、PreToolUse(Write|Edit) 写前对账、Stop 完成门、UserPromptSubmit 反馈信号、SubagentStop 验收提醒、PreCompact 状态落盘、SessionStart 横幅。
- REQ-007 标记惰性：目标目录无 `.kimi-base/harness.json` 时所有 hook 静默放行，非 kimi-base 项目零行为变化。
- REQ-008 项目级 custom agents 八角色（implementer/code-reviewer/tester/deployer/researcher/progress-recorder/feedback-observer/evolution-runner），frontmatter 用 Kimi 原生 `tools`/`disallowedTools`/`subagents: []` 实现职责隔离与机械防递归。
- REQ-009 项目级 skills 十六个工作流，frontmatter 合规（name==目录、description ≤180 字符且非流程摘要），模板以 `${KIMI_SKILL_DIR}` 引用。
- REQ-010 插件斜杠命令 `/kimi-base:init|doctor|status|verify|arch|recap|record|fast` 可用。

### 治理引擎（runtime，零依赖单文件）

- REQ-011 任务账本：单 active 任务；ownedPaths SHA-256 基线；任务期间外部写入被 pre-write 钩阻断。
- REQ-012 Git 证据指纹：HEAD + 暂存/未暂存 diff + 未跟踪路径内容归一化哈希；任何字节变化使旧证据 stale。
- REQ-013 四态质量门：PASS/FAIL/BLOCKED/SKIPPED；缺命令=BLOCKED 绝不假绿；空验证计划=BLOCKED；receipt 绑定 task/fingerprint/risk/argvHash/证据哈希；同 kind 后续 FAIL 覆盖旧 PASS。
- REQ-014 完成门：task complete 要求风险层 required checks 全部有 fresh receipt，缺口即 exit 2 列出。
- REQ-015 架构防腐三件套：catalog lint（每路径有主、拒 catch-all、UNJUSTIFIED_TIER）、arch check（真实 import 边 vs 声明图：禁边>分层>未声明、环检测、禁令赢声明）、adr check（Enforced-by 幽灵引用 FAIL）。
- REQ-016 债务棘轮：`arch baseline --write` 固化存量违规（每条带 reason、进 git 可评审），新债零容忍，已还清条目标 stale 要求删除；`arch trend --record|--gate` 漂移棘轮。
- REQ-017 五性治理闭环：模块定档（critical/high/medium/low/minimal/none，none/minimal 强制书面 reason）→ 检查认领属性 → 覆盖判定（critical/high 缺 fresh PASS 或存在 FAIL 反证即 uncovered 阻断；反证压过佐证；SKIPPED 不覆盖也不反证）。
- REQ-018 保护属性：security 与 safety 永不豁免（waiver 创建期+运行期双重写死）、永不 fast-skip；waiver 仅可豁免 BLOCKED/SKIPPED，必须带 approver/reason/expires/compensation，绑定 fingerprint。
- REQ-019 内置 fitness 五规则：no-secret-literal / no-pii-in-logs / no-silent-failure / no-unbounded-retry / no-unreferenced-deferral，支持 `kimi-base-ignore:` 抑制注释。
- REQ-020 大仓能力：impact 影响分析（反向依赖闭包、unmapped 保守扩散）、context pack 预算化上下文包（DENY 清单凭据永不入包、装不下进 omitted 显式报告）、glob 缓存与有界扫描。
- REQ-021 Fast Mode：显式开启、默认 24h TTL 自动过期、状态可见；保护属性/种类免疫；每个 skip 留痕。
- REQ-022 Stop 完成门保险丝：同一阻断指纹连拦 3 次后放行并醒目提示欠账，防门锁死会话。
- REQ-023 证据生命周期：evidence 脱敏落盘、ledger 哈希链（断链 fail-closed 视同未验证）、retention prune 定期销毁（保护被引用证据）。
- REQ-024 危险命令分类器：语义解析穿透 sudo/env/timeout wrapper 与嵌套 shell；rm -rf/git reset --hard/git clean/凭据外发（含跨管道）阻断；拦截全部记 gate-log；`gate-audit` 死闸审计（从未拦过的闸要拿证据或撤掉）。
- REQ-025 开发态进程守护：supervisor 退避拉起/健康探针/重启风暴熔断/日志轮转，只 kill 自己启动的进程，明示"不是生产 init"。

### 工作流与记忆

- REQ-026 需求质量：product-spec-builder 六维必须收集 + 信息充足度判断（不足继续追问不硬写）+ Spec 签字闸 + Spec/CHANGELOG 成对更新。
- REQ-027 计划质量：dev-planner 无占位符原则、Task 五要素（Goal/Scope 到文件路径/Dependencies/Verification 命令/Expected 可判定）。
- REQ-028 项目记忆：progress.md 八区块（Pinned/Decisions/TODO/In Progress/Done/Risks & Assumptions/Notes/Context Index）；Done 带证据指针；弱化词降级 Notes；>100 条自动归档只增不删。
- REQ-029 三文件同步：代码改动而 progress.md 未同步时 Stop 门拦截；recap 必须读齐 progress+Spec+CHANGELOG（+compaction-note）才算恢复。
- REQ-030 反馈进化：feedback 记录（occurrences/评分）→ 聚类提议（≥3 次毕业为规则、低分优化 skill、≥5 次提议新 skill）→ 每条必须用户确认，绝不自动改规则。

## 6. 非功能需求

- NFR-001 零第三方运行时依赖（仅 Node ≥18 内置模块），单文件引擎。
- NFR-002 性能预算：PreToolUse hook <100ms 常规路径；60 万行/64 模块合成仓 impact <5s、catalog lint <10s（合成基准）。
- NFR-003 跨平台：Linux/macOS 原生；Windows 经 Git Bash；ps1 脚本 100% ASCII。
- NFR-004 无网络访问；不读不写目标项目外路径；symlink/realpath 防逃逸。
- NFR-005 诚实降级：缺工具/缺命令/非 git 仓一律 BLOCKED 或可见降级，绝不假绿；fail-open 边界写入文档。
- NFR-006 自身质量：`node --test` 全绿、doctor 零 error、manifest 无漂移、pack-check 零泄漏。

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
4. 全部测试通过；doctor/manifest/pack-check 自检零 error。
5. 在未安装插件的项目中，所有 hook 静默（零干扰证明）。
