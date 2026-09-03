# kimi-base 架构总图

## 1. 设计公理

1. **宿主优先**：能用 Kimi Code 原生机制的一律不自建（插件/hooks/agents/skills/命令/Plan/Goal/Swarm/Cron）。
2. **机制优先于文本**：能机器化的一律下沉为可执行检查；常驻文本只承载稳定不变量（AGENTS.md ≤150 行）。
3. **证据优先**：一切"完成"必须有绑定当前 git fingerprint 的新鲜回执；旧证据不为新代码背书。
4. **绝不假绿**：缺工具/缺命令/非 git 仓 = BLOCKED 或可见降级；fail-open 边界如实写文档。
5. **治理自身受治理**：死闸审计、保险丝、治理退出留痕（waiver/none 档/fast skip 全部可见）。
6. **标记惰性**：无 `.kimi-base/harness.json` 的项目中零行为变化——这是全局插件不扰民的根基。
7. **源布局 = 安装布局**（v2.0，ADR-0005）：载荷即 `.kimi-base/` + `.kimi-code/`，本仓自托管 dogfood 自己的引擎。
8. **三面执法**（v2.0，ADR-0002）：执法不住在单一层面；每面的失效语义如实声明。

## 2. 分层视图

```
┌─ 宪法层 ── 项目根 AGENTS.md（≤150 行稳定不变量 + rules/ 指针）
├─ 宿主层 ── kimi.plugin.json：hooks(7) / commands(/kimi-base:*) / sessionStart skill
│            .kimi-code/agents/*.md（8 角色）  .kimi-code/skills/*/SKILL.md（16 工作流）
├─ 执法层 ── 插件 hooks（工具调用时，fail-open 护栏）
│            .kimi-base/githooks/（git 层 fail-closed：pre-commit 电池 / pre-push dod+gate / commit-msg）
│            CI（.kimi-base/audit/ 独立审计 + dod；权威面；templates/github-gate.yml 为采纳者模板）
├─ 配置层 ── .kimi-base/harness.json（唯一配置源，严格校验）
│            module-catalog.json / verification-matrix.json / adapters.json
├─ 引擎层 ── runtime/kimi-base.mjs（薄入口 33 行）+ runtime/lib/（31 模块，零依赖 Node stdlib）
│            runtime/supervisor.mjs（开发态进程守护，448 行独立文件）
├─ 状态层 ── .kimi-base/state/（git-ignored）：tasks/receipts/evidence/ledger/gate-log/fast/
│            waivers/arch-trend/review·review-backlog/compaction-note
├─ 记忆层 ── progress.md + Product-Spec*.md + DEV-PLAN.md（三文件同步）+ feedback/ 进化引擎
└─ 文档层 ── docs/（架构/五性/大仓/运维/协议/角色/隔离）+ docs/adr/（7 条 ADR）
```

引擎共 **40 个动词**（含 help；`init-modules` 为 `catalog discover` 的废弃别名，`waiver` 为 `quality waiver` 的顶层别名），退出码契约 v2（ADR-0006）：0 干净 / 1 用法·违例 / 2 阻断 / 3 降级 / 4 陈旧。

## 3. 三面执法（ADR-0002）

| 面 | 形态 | 失效语义 |
| --- | --- | --- |
| 工具调用时 | 插件 manifest 的 7 个 hook 事件 → `hook <event>` 调度 | fail-open（宿主设计）；高危面靠 permission rules |
| git 操作 | `install --hooks` 挂 `core.hooksPath=.kimi-base/githooks/`；纯 POSIX sh | fail-closed；无标记静默；无 node 响亮 fail-open |
| CI | selftest → 四独立审计脚本 → run-tests → dod → arch trend --gate | 权威面；审计脚本与引擎双实现，引擎缺陷无法让审计沉默 |

审计独立性双重执法：catalog 中 `audit` 模块声明 `forbiddenDependencies:["engine"]`（`arch check --scan` 实测 import 边），另有静态测试锁定。

## 4. lib/ 模块地图（按子系统）

| 子系统 | 模块 | 职责 |
| --- | --- | --- |
| 基础设施 | core / paths / config / state / git | 错误·哈希·JSON·子进程·TOOL_VERSION；路径常量单一口径；项目根发现+harness 严格校验；状态文件+跨进程锁+腐化隔离；Git 测量（NUL 分隔、有界输出、逐文件内容摘要指纹） |
| CLI 与 hooks | cli / hooks / classifier | 帮助与分发+逐动词严格 flag 校验；七事件 hook 调度；危险命令语义分类器（wrapper 穿透/凭据外发/git 破坏面） |
| 任务与证据 | tasks / gate / ledger / verify / quality / fast / release / hygiene | 任务账本（ownedPaths 哈希基线）；四态门+回执；ledger.jsonl 哈希链（retention 轮转带 anchor）；receipt verify；五性覆盖判定+waiver（protected={security,safety,privacy}）；限时旁路（借账不能关闭 task）；发布就绪 composite；risk scan / gate-audit / retention / **DOD_STEPS 唯一事实源** |
| 架构防腐 | catalog / arch / fitness / matrix / discover / cochange / budget | 模块目录+lint；check/baseline/trend（逐指标历史最优棘轮）+adr check；五规则文本扫描；验证矩阵+内置检查；catalog discover 草案推导；git 历史共变耦合；变更预算门 |
| 评审 | review | 结构化对抗评审：九 lens 三阶段四剖面、属性收缩选拔、计算裁决、终审 ACCEPT 才写回执、backlog 持久（ADR-0003） |
| 记忆与需求 | memory / scan | recap/invariants/archive/sync-check；spec lint / trace / spec view / rules-audit / skills-lint / agents-lint |
| 大仓与仓群 | context / fleet | impact 影响分析 + context pack；fleet 跨仓契约治理（ADR-0007） |
| 安装与自检 | installer / admin / selftest | 事务安装（受管恒等映射+种子语义+逆序 rollback+--hooks）；manifest/doctor/pack-check；运行时自冒烟 |

模块间为显式 import 无环图；`arch check --scan` 对本仓自身执法（自托管）。

## 5. Kimi 原生能力映射（控制面接线）

| 治理能力 | Kimi 原生机制 | kimi-base 接线 |
| --- | --- | --- |
| 危险命令拦截 | PreToolUse(Bash) hook，exit 2 阻断 | `hook pre-tool-use-bash` 语义分类器 |
| 写保护/对账 | PreToolUse(Write\|Edit) hook | `hook pre-write` ownedPaths 哈希基线 |
| 完成门 | Stop hook（可阻断，消息回注继续） | `hook stop`：缺 fresh receipt 或 progress 未同步→拦；同指纹连拦 3 次放行（保险丝） |
| 反馈信号 | UserPromptSubmit hook | `hook prompt-submit` 关键词检测→提醒记录 |
| 验收提醒 | SubagentStop hook | `hook subagent-stop` "勿信自报" |
| 压缩前落盘 | PreCompact hook | `hook pre-compact` 写 compaction-note.json（写入上文件锁） |
| 会话横幅/路由 | SessionStart hook + 插件 sessionStart.skill | `hook session-start`（默认注入 invariants 摘要）+ kimi-base skill |
| 角色隔离 | custom agents frontmatter | `tools`/`disallowedTools` 白名单；`subagents: []` 机械防递归 |
| 工作流固化 | skills（type:prompt 自动调用；flow 手动） | 16 个 SKILL.md，`/skill:<name>` 可手动触发 |
| 快捷命令 | 插件 commands（命名空间 /kimi-base:*） | init/doctor/status/verify/arch/recap/record/fast |
| 项目宪法 | AGENTS.md（宿主自动注入） | 根 AGENTS.md + rules/ 下沉指针 |
| 计划态 | Plan 模式（EnterPlanMode/ExitPlanMode 原生） | 高风险任务先进 plan；架构/需求走签字闸 |
| 长任务自治 | Goal 模式（/goal + 完成判据） | 与 task 账本互补：goal 管自治推进，task 管证据门 |
| 并行只读 | AgentSwarm / 后台 Agent | 审查/调研 fan-out；写操作默认串行 |
| 定时检查 | CronCreate | 可选：每日风险扫描/死闸审计提醒 |
| 成本分层 | secondary_model 子代理池（实验开关） | 只读角色走高速模型，implementer 走主模型 |

已知能力缺口与适配（诚实声明）：

- Kimi hooks **fail-open**（脚本异常/超时默认放行）→ 高危操作叠加 `[[permission.rules]]` deny 与审批模式；git hooks + CI 两面兜底（三面执法的意义正在于此）。
- hooks 无项目级配置 → 插件全局 hooks + 标记惰性激活。
- agent frontmatter 无 per-agent 权限粒度（只有工具白名单）→ 职责边界靠"工具白名单 + 纪律 + Stop 门复核"三层。
- Stop 阻断是"回注消息让模型继续"而非强制暂停 → 保险丝防门锁死；欠账醒目提示。

## 6. 治理数据流

```
变更发生
  → impact --git            变更路径→模块→反向依赖闭包→受影响检查计划
  → gate [--risk]           执行计划→四态结果→receipt（绑 task+fingerprint+argvHash+证据哈希）
  → quality status          属性覆盖判定（声明定档 vs 认领证据；反证压过佐证）
  → review start…verdict    （高风险+requireStructured）结构化对抗评审→终审 ACCEPT 回执
  → task complete           完成门：required checks 全部 fresh PASS，fast 借账 SKIPPED 不予关闭
  → Stop hook               会话收尾复核：工作树动了而 receipt/记忆缺位→拦（保险丝×3）
  → release                 发布前 composite：dod 静态电池+fast 窗口关闭+欠账已还+账本完好+
                            fresh 回执+sync-check+backlog 无过期（阻断项逐项列出）
```

架构看护数据流：`catalog lint`（路径归属）→ `arch check`（实边对账声明图）→ `arch trend --record/--gate`（逐指标历史最优棘轮）→ `adr check`（决策执法引用真实性）→ `cochange`（git 历史共变耦合复审）。文档侧承诺："Architecture-Design.md 与 catalog 冲突时以实测为准并回改文档"。

## 7. 状态与协议

状态目录 `.kimi-base/state/`（全部 git-ignored，安装器自动写 .gitignore）：

- `tasks.json` 任务账本（单 active；ownedPaths 哈希基线）
- `receipts/<check>.json` 验证回执（内容 sha256；绑定 fingerprint；range 评审回执绑 range.head）
- `evidence/*.log` 检查输出（脱敏；长输出只留摘要进上下文）
- `ledger.jsonl` 证据账本哈希链（断链 fail-closed；`retention.ledgerMaxEntries` 轮转带 anchor 跨段续链）
- `gate-log.jsonl` 每一次 hook 判定/拦截记账（gate-audit 数据源）
- `waivers.json` / `arch-trend.json` / `review/session.json` / `review-backlog.json`
- `fast-mode.json`（expires_epoch）/ `compaction-note.json` / `install-manifest.json` / `install-receipt.json` / `supervisor/`

字段级协议见 `docs/PROTOCOLS.md`。

## 8. 安全边界（诚实声明）

- hooks 是防误操作护栏，不是 OS 沙箱；Kimi hooks fail-open，git hooks 面无 node 时响亮 fail-open。
- path 校验不是 OS 锁；账本链是本地证据不是密码学签名（有写权限者可重写）。
- 分类器/fitness/arch 是启发式：消灭"漂移/风险不可见"，不证明属性成立、不构成完整威胁模型。
- 真正的最后防线：`[[permission.rules]]`（deny 高危模式）+ 审批模式（manual）+ 用户复核。

## 9. 规模设计（60 万行）

- glob 编译缓存；`git ls-files -z` 优先于目录遍历；有界扫描（maxTrackedPaths 截断按坏测量处理）。
- 上下文预算：AGENTS.md ≤150 行；细则下沉 rules/（命中才读）；探索外包子代理；context pack 按预算择优装载、omitted 显式报告。
- 验证成本：gate 默认只跑受影响计划；全量验证只在发布闸。
- 压缩韧性：PreCompact 落盘 + recap 派生视图 + compaction-note 兜底。
- 性能实测基线见 `docs/LARGE-REPO-GUIDE.md` §5（合成仓冒烟数据与诚实外推边界）。
