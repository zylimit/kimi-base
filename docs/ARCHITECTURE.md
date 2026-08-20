# kimi-base 架构总图

## 1. 设计公理

1. **宿主优先**：能用 Kimi Code 原生机制的一律不自建（插件/hooks/agents/skills/命令/Plan/Goal/Swarm/Cron）。
2. **机制优先于文本**：能机器化的一律下沉为可执行检查；常驻文本只承载稳定不变量（AGENTS.md ≤150 行）。
3. **证据优先**：一切"完成"必须有绑定当前 git fingerprint 的新鲜回执；旧证据不为新代码背书。
4. **绝不假绿**：缺工具/缺命令/非 git 仓 = BLOCKED 或可见降级；fail-open 边界如实写文档。
5. **治理自身受治理**：死闸审计、保险丝、治理退出留痕（waiver/none 档/fast skip 全部可见）。
6. **标记惰性**：无 `.kimi-base/harness.json` 的项目中零行为变化——这是全局插件不扰民的根基。

## 2. 分层视图

```
┌─ 宪法层 ── 项目根 AGENTS.md（≤150 行稳定不变量 + rules/ 指针）
├─ 宿主层 ── kimi.plugin.json：hooks(7) / commands(/kimi-base:*) / sessionStart skill
│            .kimi-code/agents/*.md（8 角色）  .kimi-code/skills/*/SKILL.md（16 工作流）
├─ 配置层 ── .kimi-base/harness.json（唯一配置源）
│            module-catalog.json / verification-matrix.json / adapters.json
├─ 引擎层 ── runtime/kimi-base.mjs（零依赖单文件：25 动词 CLI + hook 调度器）
│            runtime/supervisor.mjs（开发态进程守护）
├─ 状态层 ── .kimi-base/state/（git-ignored）：tasks/receipts/evidence/ledger/gate-log/fast/compaction-note
├─ 记忆层 ── progress.md + Product-Spec*.md + DEV-PLAN.md（三文件同步）+ feedback/ 进化引擎
└─ 文档层 ── docs/（架构/五性/大仓/运维/协议/角色/隔离）+ docs/adr/
```

## 3. Kimi 原生能力映射（控制面接线）

| 治理能力 | Kimi 原生机制 | kimi-base 接线 |
| --- | --- | --- |
| 危险命令拦截 | PreToolUse(Bash) hook，exit 2 阻断 | `hook pre-tool-use-bash` 语义分类器 |
| 写保护/对账 | PreToolUse(Write\|Edit) hook | `hook pre-write` ownedPaths 哈希基线 |
| 完成门 | Stop hook（可阻断，消息回注继续） | `hook stop`：缺 fresh receipt 或 progress 未同步→拦；同指纹连拦 3 次放行（保险丝） |
| 反馈信号 | UserPromptSubmit hook | `hook prompt-submit` 关键词检测→提醒记录 |
| 验收提醒 | SubagentStop hook | `hook subagent-stop` "勿信自报" |
| 压缩前落盘 | PreCompact hook | `hook pre-compact` 写 compaction-note.json |
| 会话横幅/路由 | SessionStart hook + 插件 sessionStart.skill | `hook session-start` + kimi-base skill |
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

- Kimi hooks **fail-open**（脚本异常/超时默认放行）→ 高危操作叠加 `[[permission.rules]]` deny 与审批模式；文档明示。
- hooks 无项目级配置 → 插件全局 hooks + 标记惰性激活。
- agent frontmatter 无 per-agent 权限粒度（只有工具白名单）→ 职责边界靠"工具白名单 + 纪律 + Stop 门复核"三层。
- Stop 阻断是"回注消息让模型继续"而非强制暂停 → 保险丝防门锁死；欠账醒目提示。

## 4. 治理数据流

```
变更发生
  → impact --git            变更路径→模块→反向依赖闭包→受影响检查计划
  → gate [--risk]           执行计划→四态结果→receipt（绑 task+fingerprint+argvHash+证据哈希）
  → quality status          属性覆盖判定（声明定档 vs 认领证据；反证压过佐证）
  → task complete           完成门：required checks 全部 fresh PASS，否则 exit 2
  → Stop hook               会话收尾复核：工作树动了而 receipt/记忆缺位→拦（保险丝×3）
```

架构看护数据流：`catalog lint`（路径归属）→ `arch check`（实边对账声明图）→ `arch trend --record/--gate`（漂移棘轮）→ `adr check`（决策执法引用真实性）。文档侧承诺："Architecture-Design.md 与 catalog 冲突时以实测为准并回改文档"。

## 5. 状态与协议

状态目录 `.kimi-base/state/`（全部 git-ignored，安装器自动写 .gitignore）：

- `tasks.json` 任务账本（单 active；ownedPaths 哈希基线）
- `receipts/<check>.json` 验证回执（内容 sha256；绑定 fingerprint）
- `evidence/*.log` 检查输出（脱敏；长输出只留摘要进上下文）
- `ledger.jsonl` 证据账本哈希链（断链 fail-closed）
- `gate-log.jsonl` 每一次 hook 判定/拦截记账（gate-audit 数据源）
- `fast-mode.json`（expires_epoch）/ `compaction-note.json` / `install-receipt.json` / `supervisor/`

字段级协议见 `docs/PROTOCOLS.md`。

## 6. 安全边界（诚实声明）

- hooks 是防误操作护栏，不是 OS 沙箱；Kimi hooks fail-open。
- path 校验不是 OS 锁；账本链是本地证据不是密码学签名（有写权限者可重写）。
- fitness/arch 是文本启发式：消灭"漂移/风险不可见"，不证明属性成立。
- 真正的最后防线：`[[permission.rules]]`（deny 高危模式）+ 审批模式（manual）+ 用户复核。

## 7. 规模设计（60 万行）

- glob 编译缓存；`git ls-files -z` 优先于目录遍历；有界扫描（maxTrackedPaths 截断按坏测量处理）。
- 上下文预算：AGENTS.md ≤150 行；细则下沉 rules/（命中才读）；探索外包子代理；context pack 按预算择优装载、omitted 显式报告。
- 验证成本：gate 默认只跑受影响计划；全量验证只在发布闸。
- 压缩韧性：PreCompact 落盘 + recap 三文件铁律 + compaction-note 兜底。
