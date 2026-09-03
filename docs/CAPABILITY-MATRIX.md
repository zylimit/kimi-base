# CAPABILITY-MATRIX：能力矩阵

四象限记录：保留（做了什么）/ 刻意不保留（不做什么+为什么）/ 不可妥协的强度 / 升级方向。

## 1. 保留：能力 → Kimi 原生机制 → kimi-base 实现

| 能力 | Kimi 原生机制 | kimi-base 实现 |
| --- | --- | --- |
| 项目宪法注入 | AGENTS.md 自动注入系统提示 | template/AGENTS.md（≤150 行 + rules/ 指针） |
| 专职角色 | .kimi-code/agents/*.md（custom agents） | 8 角色：implementer/code-reviewer/tester/deployer/researcher/progress-recorder/feedback-observer/evolution-runner |
| 防递归派发 | frontmatter `subagents: []` | 全部角色叶子化，编排权只在主 Agent |
| 只读审查隔离 | frontmatter `disallowedTools` | code-reviewer/researcher 禁 Write/Edit |
| 工作流固化 | .kimi-code/skills/*/SKILL.md | 16 个工作流 skill（需求/DFX/架构/计划/开发/审查/测试/修缺/发布/记忆/反馈/进化/红蓝/收尾/大仓/skill 工程） |
| 会话启动路由 | 插件 sessionStart.skill | kimi-base skill：标记检测→横幅→路由表；非标记项目自静默 |
| 危险命令拦截 | PreToolUse hook（exit 2） | 语义化分类器：wrapper 穿透/凭据跨管道外发/git 破坏性子命令 |
| 写前对账 | PreToolUse(Write\|Edit) hook | ownedPaths 哈希基线；越界写（仓外/.git/敏感文件）拦截 |
| 完成门 | Stop hook（exit 2 + 回注） | 缺 fresh receipt 或三文件未同步→拦；连拦 3 次保险丝放行 |
| 压缩韧性 | PreCompact hook | compaction-note.json（base commit/active task/未完成检查） |
| 反馈信号 | UserPromptSubmit hook | 修正关键词检测→提醒记录 feedback |
| 验收提醒 | SubagentStop hook | "勿信自报、核客观证据" |
| 会话横幅 | SessionStart hook | 项目/任务/fast/待审状态 + 脏树 recap 提醒 |
| 快捷命令 | 插件 commands | /kimi-base:init doctor status verify arch recap record fast |
| 任务账本 | runtime CLI | task start/complete/status + ownedPaths 基线 |
| 质量门 | runtime CLI | gate 四态 + receipt（diff 绑定）+ quality 覆盖判定 + waiver |
| 架构防腐 | runtime CLI | catalog lint/discover / arch check / adr check / trend 棘轮（逐指标历史最优）/ cochange / budget |
| 五性治理 | runtime CLI + catalog 声明 | 五属性六档；security/safety/privacy 保护底线（ADR-0004） |
| 结构化对抗评审 | runtime CLI | review pack/start/blue/lens/verdict/status/team/backlog：九 lens 三阶段、计算裁决、终审 ACCEPT 才写回执（ADR-0003） |
| 记忆法 | runtime CLI | recap（派生视图）/ invariants（会话注入）/ archive / sync-check（三文件同步执法） |
| 需求治理 | runtime CLI | spec lint（可判定性）/ trace（REQ↔代码·测试追溯门）/ spec view / rules-audit / skills-lint / agents-lint |
| 三面执法·git 面 | git hooks（core.hooksPath） | .kimi-base/githooks/：pre-commit 电池 / pre-push dod+gate / commit-msg；`install --hooks` 挂载（ADR-0002） |
| 三面执法·CI 面 | CI runner + 独立审计 | .kimi-base/audit/ 五脚本（禁 import 引擎双实现）+ dod 静态电池 + release composite；采纳者模板 templates/github-gate.yml |
| 仓群治理 | runtime CLI | fleet lint/impact/status/recap（fleet.json 组级契约；ADR-0007） |
| 大仓上下文 | runtime CLI | impact / context pack（DENY 清单+omitted 可见） |
| 进程守护 | runtime CLI | supervisor.mjs（退避/探针/熔断） |
| 限时旁路 | runtime CLI | fast mode（TTL；protected 免疫；skip 留痕；借账不能关闭 task/release） |
| 计划态 | Plan 模式原生 | 高风险变更先进 plan；签字闸走 ExitPlanMode 审批 |
| 长任务自治 | Goal 模式原生 | 与 task 账本互补；goal 目标里写清验证命令 |
| 并行只读 | AgentSwarm / 后台 Agent | 审查/调研 fan-out（用户 opt-in）；写串行 |
| 定时治理 | CronCreate 原生 | 可选周期任务：risk scan / gate-audit / retention prune |
| 模型分层 | secondary_model 子代理池（实验） | 只读角色走高速模型降本；默认不开启 |
| 迁移导入 | /import-from-cc-codex 内置 skill | 从 Claude/Codex 项目迁入时的资产转换入口 |

## 2. 刻意不保留

| 能力 | 为什么不做 | 轻量替代 |
| --- | --- | --- |
| 第二套 Agent runtime / daemon | 违背宿主优先公理 | Kimi 子代理 + runtime CLI |
| 多模型异构交叉审查 | Kimi 单宿主；secondary_model 是成本分层非异构对抗 | 红蓝对抗 + 多视角 lens + 写测独立 |
| 多 agent 并行写 | 写冲突风险大于收益（家族共识） | 写串行 + 只读 fan-out |
| CI 平台绑定 | 交付物是可移植框架；CI 绑定由用户项目决定 | 本地 gate + dod + pack-check；`.kimi-base/audit/` 独立审计脚本与采纳者模板 `templates/github-gate.yml` 提供现成接线 |
| 自动 push/部署 | 远端副作用必须人工确认 | 审批三档 HIGH 必停 |
| 外部扫描工具捆绑 | 环境不可控；捆绑即坏即假绿 | adapters.json 声明式接入，缺失=BLOCKED |
| 需求工单系统 | 超出框架边界 | 任务信封 + trace-matrix 由 test-builder 维护 |

## 3. 不可妥协的强度

1. 子代理自报不当证据：完成只认 fresh receipt。
2. 缺工具/缺命令绝不假绿：BLOCKED 是一等状态。
3. security/safety/privacy 永不豁免、永不 fast-skip：语法层面不可表示。
4. 非标记项目零干扰：hook 与 skill 自静默。
5. 安装不覆盖用户定制：旁路 + 逆序 rollback。
6. 一切拦截记账：闸靠数据留，不靠感觉留。

## 4. 升级方向（偏好序）

1. 可执行检查 > 提示词规则（新能力优先做成 CLI 动词而非更多文本）。
2. 静态闸 > 更多 reviewer agent。
3. 插件机制红利 > 项目注入（若 Kimi 后续支持项目级 hooks/skills 增强，优先回迁）。
4. 若 Kimi 开放 hooks fail-closed 选项 → 安全分类器立即切换并删相应诚实声明。
5. secondary_model 实验转正后 → 角色→模型分层写入默认模板。

## 5. v2.0 已兑现的升级项（自评留痕）

- ~~引擎单文件 >6k 行拆分~~ → **已完成（P1）**：4712 行单文件拆为薄入口 + `lib/` 31 模块，manifest 同步覆盖；本行保留作升级机制的兑现证据。
- ~~红蓝评审提示词纪律~~ → **已完成（P3）**：评审协议引擎化（ADR-0003），skill 降为编排层。
- ~~CI 接线说明~~ → **已完成（P5）**：三面执法落地（ADR-0002），审计脚本与 CI 电池入库。
