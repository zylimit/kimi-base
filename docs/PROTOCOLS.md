# PROTOCOLS：字段级协议

## 1. 派单包（主 Agent → 子代理，六字段）

```
Goal: 要达成什么（可判定）
Scope: 精确到文件路径的工作范围
Out of Scope: 明确不碰什么
Existing Pattern: 应遵循的现有模式/文件指针
Verification: 验收命令（具体可执行）
Escalation: 什么情况升级回主 Agent
```

## 2. 回执信封（子代理 → 主 Agent，六字段）

```
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Changed: 变更文件清单
Verified: 已验证项 + 命令 + 结果
Not verified: 未验证项（诚实留白）
Needs review by: 建议复核者
Evidence: 证据句柄（commit/路径/命令/receipt 文件）
```

纪律：回传=结论+证据句柄，不贴全文；"翻证据外包、下判断自留"。

## 3. 退出码契约 v2（CLI 全局统一；hook outward 契约保持 0/2）

| 码 | 语义 | 典型场景 |
| --- | --- | --- |
| 0 | 成功 / PASS | 一切通过 |
| 1 | 用法错误或规则违例 | 未知动词/未知 flag/非法入参/配置非法；`catalog lint`、`fitness`、`adr check`、`arch check`、`arch trend --gate` 发现违规 |
| 2 | 治理阻断 | `gate` FAIL/BLOCKED、`task complete` 完成门缺口、`quality status` uncovered、`receipt verify` 篡改/断链/缺失/漂移、`doctor`、`pack-check`、`manifest --check` 漂移、install/uninstall 失败 |
| 3 | 降级或引擎内部错误 | freshness 绑定操作在非 git 仓（"降级：非 git 仓，无法测量"）；`review start` 空 diff（no-change）；`review status` 无会话；`review verdict` 判 NEEDS_MORE_EVIDENCE；未预期异常（`ENGINE_ERROR`） |
| 4 | 陈旧证据 | `receipt verify`：链完好无篡改，但回执绑定的指纹/基线已移动（含 runtime 证据窗口过期）；`review` 会话绑定的工作树已变或 range.head 已移动 |

## 4. 验证回执（receipt）

runtime 实际字段（`.kimi-base/state/receipts/<checkId>.json` 最新态索引 + `ledger.jsonl` 全量链；哈希均为 64 位小写 hex，无 `sha256:` 前缀）：

```json
{
  "version": 1,
  "kind": "verification",
  "id": "rcpt-<14位时间戳>-<随机hex>",
  "taskId": "task-… | null",
  "checkId": "unit-tests",
  "checkKind": "unit",
  "risk": "medium",
  "fingerprint": "<hex：baseCommit+变更文件摘要>",
  "baseCommit": "<hex 或 UNBORN>",
  "argvHash": "<hex>",
  "argvDisplay": "npm test",
  "cwd": ".",
  "tool": "kimi-base/<version>",
  "toolVersion": "…",
  "fastWindow": "null 或 fast-mode windowId",
  "createdAt": "<ISO>",
  "status": "PASS|FAIL|BLOCKED|SKIPPED",
  "exitCode": 0,
  "durationMs": 1234,
  "reason": "…",
  "summary": "≤2000 字符摘要",
  "evidencePath": ".kimi-base/state/evidence/<check>-<ts>.log | null",
  "evidenceSha256": "<hex | null>",
  "evidenceBytes": 0,
  "contentHash": "<hex：剔除 contentHash/chain 后的稳定哈希>"
}
```

runtime 类检查（matrix check 声明 `"class":"runtime"`）额外带 `"validUntil": "<ISO>"` 与 `"timeWindow": "time-window-<N>h"`（N = 检查级 `runtimeValidityHours`，缺省取 `quality.runtimeValidityHours`，默认 24）：时间窗内不随树指纹过期（压测测的是部署中的系统，不是这棵树）；窗口过期即不 fresh。省略 `class` = 默认指纹绑定行为不变。

绑定规则：fingerprint 变化即 stale（runtime 窗口内除外）；同 check 后续 FAIL 覆盖旧 PASS；`SKIPPED` 仅在 fast mode + 检查声明 `allowFastSkip:true` + 非 protected（security/safety kind 或 security/safety/privacy 属性）时出现，且留痕——**带 `fastWindow` 印记的 SKIPPED 是借账不是证据：永远不能关闭 task（完成门记缺口并指向 `fast off` + 完整 `gate`），release 的 fast-debt-repaid 同样不认**；长证据（>4000 字符）脱敏后落 evidence 文件，回执只带摘要与哈希。

## 5. 证据账本链与轮转

`ledger.jsonl` 每行一条完整回执记录（含 `contentHash`）；链字段 `chain = sha256(prev_chain + '\0' + contentHash)`（首条以 GENESIS 常量起链）。断链 fail-closed：`receipt verify` 报 TAMPERED/MISSING/DRIFT，`quality status` 视同未验证。

轮转（`retention.ledgerMaxEntries`，默认 1000）：数据条目超上限时旧段整体归档为 `state/ledger-archive-<ts>-<随机>.jsonl`，新段首行写锚点：

```json
{ "kind": "anchor", "at": "<ISO>", "count": "<已归档条目总数>", "chain": "<旧段链尾>", "contentHash": "<hex>" }
```

后续条目自 `anchor.chain` 续链，跨段可验。anchor 只能位于首行；有归档段缺 anchor（截断/清空）或有 anchor 缺归档段（伪造）均 fail-closed。

## 6. waiver

存储于 `.kimi-base/state/waivers.json`（`{version:1, waivers:[…]}`），单条字段：

```json
{
  "version": 1,
  "kind": "waiver",
  "id": "waiver-<时间戳>-<随机>",
  "checkId": "integration",
  "fingerprint": "<hex>",
  "approver": "张三",
  "reason": "测试环境依赖外部服务",
  "expiresAt": "2026-09-01T00:00:00Z",
  "compensation": "每日手动跑 staging 验证",
  "createdAt": "…",
  "contentHash": "<hex>"
}
```

硬规则（创建期+运行期双重写死）：检查 id/kind/attributes 命中禁词（security|safety|secret|credential|destructive）或属 protected → 拒绝创建；当前指纹下已有 FAIL 回执 → 拒绝（跑挂了必须修，不能请假）；过期/跨指纹/内容哈希不匹配 → 自动失效。CLI 另有顶层别名 `waiver create|list`（等价于 `quality waiver …`）。

## 7. gate-log

`gate-log.jsonl` 每行：`{ts, kind, rule, reason, decision?, detail?}`——`kind` 如 `hook:pre-tool-use-bash` / `hook:pre-write` / `hook:stop`；`decision ∈ block|warn|allow|release`；`reason`/`detail` 有界脱敏。超过 `retention.gateLogMaxBytes` 轮转为 `gate-log.jsonl.1`（只留一代）。gate-audit 据此判定死闸（已知闸清单派生自分类器规则表，不手维护）。

## 8. fast-mode.json

```json
{
  "version": 1,
  "enabled": true,
  "enabledAt": "<ISO>",
  "expiresAt": "<ISO>",
  "expiresEpoch": 1736668800,
  "windowId": "<uuid>",
  "updatedAt": "<ISO>"
}
```

过期即视同关闭；`windowId` 绑定 SKIPPED 回执（`fastWindow`）。**fast 门不能关闭 task/release**：任何带 `fastWindow` 印记的 SKIPPED 都不算证据（完成门记缺口；release 的 fast-debt-repaid 拦截），还债路径唯一——`fast off` 后重跑完整 `gate`；protected kind/属性（security/safety/privacy）免疫。

## 9. compaction-note.json

```json
{
  "version": 1,
  "createdAt": "<ISO>",
  "baseCommit": "<hex | null>",
  "fingerprint": "<hex | null>",
  "activeTask": "{ id, goal, risk, ownedPaths, touchedPaths } | null",
  "pendingChecks": ["<kind>:<check> <reason>", "…"],
  "hint": "压缩前最后落盘：recap 时连同 progress.md / Product-Spec.md / Product-Spec-CHANGELOG.md 一起读"
}
```

压缩前最后落盘，recap 时优先读取。

## 10. harness.json 配置别名（canonical 与废弃别名，两者均可读）

| canonical | 废弃别名 | 生效位 |
| --- | --- | --- |
| `hooks.stopMaxBlocks` | `hooks.stopFuseLimit` | Stop 门保险丝连拦上限 |
| `feedback.signalKeywords` | `hooks.correctionKeywords` | prompt-submit 修正信号关键词 |
| `context.budgetTokens` | `context.defaultBudget` | context pack 默认预算 |

冲突时 canonical 优先；别名仅为兼容保留，新配置一律写 canonical。另：`outputLimits.hookChars` 封顶 hook 的模型向输出；`outputLimits.modelChars` 是 context pack 预算硬顶（显式 `--budget` 也不得突破）。

## 11. 结构化对抗评审（review）

哲学：共识是失效模式——廉价的一致通过不是评审。裁决由引擎从已记录的事实**计算**，不是任何一方（含主 Agent）声明。

### 11.1 会话（`state/review/session.json`，原子写 + 文件锁）

```json
{
  "version": 1,
  "diffHash": "<hex：工作树模式=gitFingerprint().diffHash；range 模式=sha256(git diff <ref>...HEAD 补丁)>",
  "baseCommit": "<hex>",
  "startedAt": "<ISO>",
  "scope": { "paths": ["src/a.js"] },
  "range": null,
  "profile": "team",
  "requiredLenses": ["correctness", "testing"],
  "excludedLenses": [{ "lens": "architecture", "reason": "受影响模块均未将 maintainability 定档 ≥ low…" }],
  "lineage": [{ "at": "<ISO>", "verdict": "FIX_REQUIRED", "diffHash": "<hex>", "errorCount": 2, "round": 1 }],
  "blue": null,
  "lenses": {},
  "verdict": null
}
```

`range` 仅 range 模式（`review start --base <ref>`）非空：`{ "base": "<ref>", "head": "<hex>", "hash": "<hex>" }`。新鲜度：工作树模式要求当前 `diffHash` 与会话一致（任何字节变化即 stale）；range 模式要求 `HEAD == range.head`（评审对象是提交范围，脏工作树不影响）。stale → 写操作一律 exit 4。重开（`review start`）：上一会话的裁决摘要追加进 `lineage`（跨轮存活），其余全部重新绑定。

### 11.2 团队选拔（review team / review start 输出）

lens 库九席，各带阶段与代言属性：阶段 1 code = correctness / architecture / maintainability；阶段 2 functional = testing / performance；阶段 3 trust = reliability / resilience / security / privacy。剖面：personal=[correctness]；team=[correctness, testing, architecture]；production=team+[security, reliability, performance]；regulated=全九席。

选拔顺序：catalog `review.lenses` 非空 → 显式集胜出；否则 `review.profile`（默认 `team`）。随后**属性收缩**：受影响模块（analyzeImpact 于变更路径）均未把该 lens 的属性定档 ≥ low 即剔除，剔除带原因入 `excludedLenses`；`correctness` 无属性，永不剔除。属性只能收缩团队，不能扩张。

catalog 段 schema（严格字段，配置期校验）：`review: { profile?, lenses?, maxRounds?(int 1..10，默认 3), requireStructured?(bool) }`。

### 11.3 stdin 输入信封

`review blue`：

```json
{ "claims": [ { "claim": "实现了 X", "evidence": "node --test 通过（输出在 …）" } ] }
```

≥1 条 claim，每条 claim 与 evidence 均非空，否则整批拒绝 exit 1。Blue 自述只作红队靶子，不作通过依据。

`review lens <name> [--ad-hoc]`：

```json
{ "findings": [ { "severity": "error|warning|info", "message": "…", "location": "src/a.js:12", "reproduction": "…" } ],
  "unable": false, "unableReason": "…" }
```

每条 finding：`severity` 三值之一；`message` 非空；`location`（须匹配 `:行号[:列]` 结尾，Windows 路径 `D:\src\x.ts:12` 合法）或 `reproduction`（非空）至少其一——一条非法整批拒绝 exit 1。`unable:true` 必须附非空 `unableReason`（白卷不算证据）。非召集 lens 一律拒绝，除非 `--ad-hoc`：记为额外证据（不占应到清单、不受阶段门控，但 error 发现照样计入裁决）。阶段门控：lens 阶段 > 当前阶段（首个有召集但未齐报的阶段）→ 拒报 exit 1 且 stdout 带 `stageGated:true`。同一 lens 重复报到 = 覆盖（latest-wins）。

### 11.4 裁决优先级（review verdict，计算而非断言）

1. 阻断 → exit 1：blue 未自证；或尚无任何阶段齐报时前沿阶段应到 lens 未报到（stderr details 列 `blockers`）。
2. 任一 error 发现（召集或 ad-hoc）→ `FIX_REQUIRED` exit 2。`round = lineage.length + 1`；round ≥ maxRounds → stdout `escalate:true` + 建议「停止重试，交由人类裁决」。
3. 应到 lens 任一 `unable` → `NEEDS_MORE_EVIDENCE` exit 3。
4. 否则 `ACCEPT` exit 0。终审（`final:true`：阶段 3 齐报，或更晚阶段无召集 lens）才写回执；非终审 ACCEPT 标 `final:false`，不写回执。

**消费者（task complete / 发布闸）只认回执，永不认 verdict 退出码。**

### 11.5 评审回执（kind:"review"）

仅终审 ACCEPT 写入：进哈希链账本 + `receipts/` 镜像，字段：

```json
{
  "version": 1, "kind": "review", "id": "rcpt-…", "checkId": "review-<taskId>",
  "taskId": "<active 任务 id；无任务时 review-<fingerprint8>>",
  "reviewer": "…", "verdict": "ACCEPT", "final": true, "round": 1,
  "lenses": ["correctness", "testing"], "requiredLenses": ["…"],
  "findings": { "error": 0, "warning": 1, "info": 0 },
  "diffHash": "<hex>", "fingerprint": "<hex>", "baseCommit": "<hex>",
  "range": { "base": "…", "head": "…", "hash": "…" },
  "notes": "…", "createdAt": "<ISO>", "contentHash": "<hex>"
}
```

完成门接线：catalog 声明 `review` 段且 `requireStructured !== false` 且任务 `risk=high` → 完成门额外要求当前指纹下带 lens 覆盖的终审 ACCEPT 回执（stale/缺失 = 缺口 exit 2）；无 review 段或 low/medium 风险 = 无新要求（向后兼容）。

回执新鲜度：工作树模式回执随指纹移动 stale（提交后必然如此——正常流程痕迹，重跑 `gate` 补 fresh 回执即可）；**range 模式回执看 `range.head` 不看工作树指纹**——`HEAD == range.head` 即 fresh（`receipt verify` 不判 stale、release 的 receipt-fresh 接受），HEAD 移动才 stale。`review start --base <ref>` 就是为"提交后评审已提交的改动"设计的绑定方式。

### 11.6 backlog（`state/review-backlog.json`，跨会话持久）

`review backlog add`（stdin `{owner, expiry, summary, lens, location?}`）要求存在 fresh 会话；`expiry` 必须未来。summary 命中 `security|safety|privacy|pii|secret|credential|密码|密钥|凭据`（启发式拦截，非保证）→ 拒绝 exit 1：受保护发现永不可挂账——backlog 不得沦为设计所拒绝的那种 waiver。**backlog 独立于会话文件持久，`review start` 重开不冲掉**；`review backlog list` 标记过期条目；`review status` 显示结转数量；`risk scan` 把过期条目标为 `review-backlog-expired`（medium）。

### 11.7 review pack（证据包）

`review pack` 生成 `state/review/review-pack-<epoch>.md`：base ref 解析（最新 tag → origin/main → HEAD~1 → 根提交）、commit 清单、diffstat、删除审计（点名被删文件）、未跟踪文件、完整 diff（>800 行溢出到 `diff-<epoch>.patch` 并在包内指路）。exit 0；非 git 仓 exit 3。lens 子代理消费此包，不各自重算 diff。

### 11.8 review 退出码速查

| 子命令 | 0 | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- | --- |
| `start` | 已开启 | 无效 `--base`/团队为空 | — | 空 diff / 非 git | — |
| `blue` / `backlog add` | 已记录 | 载荷校验失败/无会话 | — | — | 会话 stale |
| `lens` | 已报到 | 校验失败/非召集无 --ad-hoc/阶段门控（stageGated） | — | — | 会话 stale |
| `verdict` | ACCEPT | 阻断（blue 缺/前沿 lens 未报到） | FIX_REQUIRED | NEEDS_MORE_EVIDENCE | 会话 stale |
| `status` | 有会话 | — | — | 无会话 | — |
| `team` / `backlog list` | 恒 | — | — | 非 git 且无会话（team 现算需变更面） | — |
| `pack` | 已生成 | — | — | 非 git | — |

## 12. 记忆法动词（recap / invariants / archive / sync-check）

哲学：记忆无界生长即失效；恢复视图必须**派生**（读工件现算）而非引用摘要——压缩摘要把漂移带进新会话。

### 12.1 recap [--budget N]（默认 6000 字符）

输出 = 状态行 + 派生视图正文：`Position`（分支/HEAD/未提交变更数/活跃任务/最近 gate/Fast Mode——全部现算）+ progress.md 各段限量摘录（Pinned 12 / In Progress 8 / TODO P0·P1 各 10（`- [P0|P1][OPEN]` 词元）/ Decisions 末 5 / Done 首 6 / Risks 8）+ risk scan 衰变信号。条目裁剪 200 字符；**总量 ≤ 预算**（截断注记也占预算）且截断必须显式。缺 progress.md → exit 3（不假造记忆）。

### 12.2 invariants

输出 = 单份 ≤1200 字符摘要：硬编码铁律五条（证据优先/绝不假绿/保护底线/hooks 是护栏/三文件同步）+ 实时状态（活跃任务 id、fast 窗口、最近 gate  verdict 与时间、账本是否断链）。用途：压缩后与每个阶段边界重注入。sessionStart 横幅默认附带本摘要（`hooks.injectInvariants`，默认 true）。

### 12.3 archive [--apply] [--keep-done N=40] [--keep-notes N=30]

触发：progress.md 的 Done 条目数 > keep-done，或 Notes > keep-notes，或文件 > 24000 字节。动作：把最旧（段尾）Done/Notes 条目移入 `progress.archive.md` 的 `## Archived <date>` 段（按 `### Done`/`### Notes` 分组），活体文件在原处留一行指针。**默认 dry-run**；归档只增不删、条目永不改写。体积超限但条目数均在保留线内时如实报告"自动归档无能为力"。缺 progress.md → exit 3。

### 12.4 sync-check [--staged] [--paths a,b]

变更面来源：`--paths` 显式 > `--staged` 暂存区 > 默认工作树（staged+unstaged+untracked）。规则：

- `MEMORY_BEHIND_CODE`（error）：governed 模块路径（catalog 归类 `mapped`；globalPaths/ignored 不算）变更而 `progress.md` 不在改动集。
- `SPEC_WITHOUT_CHANGELOG`（error）：`Product-Spec.md` 变更而 `Product-Spec-CHANGELOG.md` 未同改。
- `CHANGELOG_WITHOUT_SPEC`（warning）：反向情况，提示确认。

catalog 不可用时不阻断：governed 面按零计并显式 note（Spec↔CHANGELOG 对账不依赖 catalog，仍执法）。违例 → exit 1；非 git 且无 `--paths` → exit 3；纯文档变更放行。

## 13. 需求可判定性与追溯（spec / trace）

配置（harness.json `spec` 段，严格校验）：`requirementDirs`（条目可为 .md 文件或目录，目录递归取 *.md；文件名含 TEMPLATE/CHANGELOG 者跳过；默认 `["Product-Spec.md"]`）、`testGlobs`（默认 `["tests/**"]`）、`minCoverage`（(0,1]，默认 1.0）。

### 13.1 需求 id 与块

id 形如 `REQ-001` 或 `REQ-<域>-001`（`(REQ|NFR)-(?:[A-Z]{2,6}-)?\d{3,4}`；裸形式与领域形式都合法）。一个需求的"块" = id 所在行起 14 行。

### 13.2 spec lint 违例表

| code | 级别 | 判定 |
| --- | --- | --- |
| NOT_NORMATIVE | error | 块内无规范关键词（SHALL/MUST/必须/不得/应当） |
| NO_TRIGGER | warning | REQ 块内无触发词（WHEN/WHILE/IF/WHERE/当/若） |
| NO_METRIC | error | NFR 块内无数字+单位（`250 ms`/`99.9 %` 形） |
| AMBIGUOUS | warning | 块内命中歧义词表（双语：友好/robust/scalable/灵活/尽可能…） |
| NO_ACCEPTANCE | error | 块内无验收证据词（Acceptance/验收/Given/Verification/验证） |
| DUPLICATE_ID | error | 同一 id 在两个文件声明（同文件后续出现视为引用） |
| PLACEHOLDER | error | 文件含 TBD/TODO/待补充/待定（ASCII 词按独立成词判定，段名枚举不算） |
| ATTRIBUTE_UNADDRESSED | warning | 治理属性（governance.attributes）在语料中未被提及 |

error → exit 1；需求目录无文件 → exit 3。

### 13.3 trace（覆盖门禁）

声明集 = spec lint 的 ids。扫描面 = tracked ∪ 未跟踪（exclude-standard）中 ≤512KB 的文本文件（需求文档本身除外）。某需求被 ≥1 个 testGlobs 命中的文件引用 = VERIFIED。`coverage = verified/declared`：< minCoverage → exit 1。代码/测试引用未声明 id = 悬空 → exit 1；文档面（docs/**、.kimi-base/templates/**、.kimi-code/**、plugin/**、*.md）悬空只报告。**对称规则**：只扫 REQ/NFR 两个声明族，不存在只扫不声明的第三族。非 git → exit 3。

### 13.4 spec view [--paths a,b | --all] [--budget N=6000]

预算化需求摘要：默认过滤面 = 当前 git 变更集；`--paths` = 追溯引用（代码或测试）落在这些路径上的需求；`--all` = 全量。每条 = id + 声明行标题 + `测试验证：yes/no`。头部计入预算；预算外省略逐条显式点名，永不静默截断。

## 14. 资产与宪法 lint（rules-audit / skills-lint / agents-lint）

### 14.1 rules-audit [--files a,b]（默认 AGENTS.md）

规则行 = 编号/子弹/表格行且 ≥25 字符、在代码围栏外。分类：行内 backtick token 能解析到 matrix check id / 引擎动词 / fitness 规则 id → `enforced`；行或所在段声明 提示词|prompt-only|(P) → `declared-prompt-only`；其余 → `unenforced` 发现。默认**纯建议恒 exit 0**；harness.json `rulesAudit.maxUnenforced` 设数字后超限 → exit 1。输出执法率（enforced/total）。

### 14.2 skills-lint

`.kimi-code/skills/*/SKILL.md`：frontmatter 缺失/坏形状 error；name 非 kebab-case 或 ≠ 目录名 error；description 缺失 error、>500 字符 error、>220 warning；正文 >24KB warning；重名 error。error → exit 1。

### 14.3 agents-lint

根 `AGENTS.md` 缺失 → error；>12000 字节 warning（每次请求全额重发）；>16000 字节 error。error → exit 1。

## 15. 规模化治理协议（P6：discover / cochange / budget / fleet / release）

### 15.1 catalog discover [--write] [--depth N=2]

从仓库事实推导 module-catalog 草案，绝不替人决定后果。

- **分组**：tracked 路径（`git ls-files`）按源码根（src/lib/app/apps/packages/services/internal/cmd/pkg/modules/components）分前缀组，源码根下取 depth+1 段、其余顶层目录取 depth 段；≥2 文件成组；兜底：任何持有文件的顶层目录自成模块。命中 ignore 候选（docs/**、.github/**、progress.md、AGENTS.md 等）的路径在分组前排除；`.kimi-base/**` 由 classifyPath 隐式全局覆盖，不入草案。
- **dependsOn**：提案模块组成探针 catalog 喂给 arch 实边扫描器（scanRealEdges），dependsOn 从真实 import 边推导——草案图从第一天起贴合代码；未解析 specifier 如实计数。
- **分层**：沿提案图最长依赖路径命名 `tier-N`（tier-1 最内层 = 无依赖基础层，层号随依赖深度递增，对齐「只许依赖同层或更内层」规则；位置命名是刻意的——发明 "domain"/"infra" 会把猜测读成发现）。
- **命令检测**：package.json scripts（npm/pnpm/yarn）/ pyproject.toml / go.mod / Cargo.toml / Makefile → detectedChecks 提案（unit/static/build kind）；接进 verification-matrix.json 是人的决定。
- **属性提案**：只对生产源码（排除 tests/fixtures/mocks/docs/*.test.*/*.spec.*）做关键词信号扫描；档位封顶 high；≥2 文件或 ≥2 不同词才成提案，附证据与 confidence。
- **needsDecision**：modules[].attributes、modules[].forbiddenDependencies、layers 命名、verification-matrix 接线（无构建清单时还有 checks）——引擎拒绝猜测，全列出来待人决。
- **写盘**：默认 dry-run 输出草案 JSON；`--write` 在 catalog 已存在时写 `module-catalog.draft.json`（绝不覆盖人工策展），否则写 `module-catalog.json`。
- 退出码：0 有提案；3 降级（非 git / 无 tracked 文件 / 无任何可成组目录）。`init-modules` 为废弃别名，stderr 注明后转发本命令。

### 15.2 cochange [--limit N=500] [--min-pairs N=3] [--ratio F=0.5]

边界对不对由"哪些模块实际一起变"判定，不由行数判定。

- 解析 `git log -n <limit> --no-merges --name-only`；每个提交的路径经 catalog 归类（仅 mapped 计入）。
- 触碰 >8 模块的提交按横扫（发版/全仓格式化）排除，排除数如实报告。
- `coupling = 共变次数 / min(commitsA, commitsB)`；对子入选条件：共变 ≥ min-pairs 且 coupling ≥ ratio。
- 分级：无声明边 → `BOUNDARY_SUSPECT`（error，exit 1）；有声明边 → `HIGH_COUPLING`（warning——耦合度意味着无法独立发布）；命中 `catalog.cochange.accepted` 三元组 `[moduleA, moduleB, "理由"]` → `ACCEPTED_COUPLING`（warning——接受耦合是留痕决策）。
- 可分析提交 < `cochange.minSample`（默认 30）→ `LOW_CONFIDENCE`（warning，exit 0）：一切结果按提示对待，不是测量。
- 共变 ≥ min-pairs 且从不与任何模块共变的模块列为抽仓候选（extraction candidates）。
- catalog 校验：`cochange.accepted` 每条必须是 [a, b, 非空理由] 三元组且 a≠b、引用真实模块 id；`cochange.minSample` 正整数。
- 非 git / 无提交历史（unborn HEAD）→ exit 3。

### 15.3 budget [--staged | --baseline ref]（变更爆炸半径预算门）

- 指标：`changedFiles`（变更面路径数）/ `changedLines`（numstat added+removed）/ `modulesTouched`（变更面归类为 mapped 的模块数）/ `newFiles`（未跟踪文件数，state/ 除外）。
- 口径：默认工作树对 HEAD（staged+unstaged+untracked，与指纹同口径——staged 变更不得报零）；`--staged` 只看暂存区；`--baseline <ref>` 看 `<ref>...HEAD` 提交区间（ref 必须可解析为提交，否则 exit 1）。
- 上限来自 harness.json `budget` 段：`maxChangedFiles` / `maxChangedLines` / `maxModules` / `maxNewFiles`，全可选正整数（严格校验，未知字段拒绝）。
- 任一超限 → exit 1，逐指标报告，固定话术："超出预算意味着拆分变更或升级——永不靠放宽预算消红"。
- 未配置 budget 段 → exit 3（未激活不是通过）；配了 maxModules 而 catalog 缺失 → exit 3（缺测量不假绿）；非 git → exit 3。
- pre-commit 末尾以 `budget --staged || true` ADVISORY 接入；升级为闸门 = 去掉 `|| true`。

### 15.4 fleet.json 模式与 fleet 动词

fleet.json 是**组级文件**（各仓共同祖先目录），不进 installer 种子。定位：`--fleet <path>` > `KIMI_BASE_FLEET` 环境变量 > 自 cwd 向上逐级查找；找不到 → exit 3（单仓模式）。

```json
{
  "version": 1,
  "name": "my-fleet",
  "repos": [{
    "id": "billing-api", "path": "billing-api", "owners": ["@payments-team"],
    "provides": [{ "contract": "billing-api", "version": "2.3.0", "kind": "http|grpc|event|schema|library|file|other",
                   "status": "active|deprecated|retired", "sunset": "2026-12-31?", "adr": "…?",
                   "external": false?, "public": false? }],
    "consumes": [{ "contract": "ledger-events", "version": "2.x?", "external": false? }]
  }]
}
```

版本选择器匹配：精确相等、`*`/`any`、`2.x`/`2` 前缀（`2.x` 接受任何 `2.*`）。fleet lint 违例表：

| code | 级别 | 判定 |
| --- | --- | --- |
| NO_REPOS / REPO_ID_MISSING / DUPLICATE_REPO | error | 无仓库 / 无 id / id 重复 |
| NO_OWNER | warning | 仓库无 owner（契约变更无人可协商） |
| REPO_MISSING | error | 声明路径不存在 |
| REPO_NOT_GIT | warning | 非 git 工作树（其自身治理会降级） |
| CONTRACT_ID_MISSING / CONTRACT_NO_VERSION | error | 契约缺 id / 版本 |
| UNKNOWN_CONTRACT_KIND / UNKNOWN_CONTRACT_STATUS | error | 未知 kind / status |
| DEPRECATED_WITHOUT_SUNSET | error | 废弃无 sunset 日期 = 永久废弃 |
| CONTRACT_WITHOUT_ADR | warning | 已发布契约无 ADR 引用（retired 豁免） |
| CONTRACT_MULTIPLE_OWNERS | error | 同一契约多个提供方 |
| CONSUME_ID_MISSING | error | 消费条目无契约 id |
| DANGLING_CONSUME | error | 消费的契约无人提供且未标 external:true |
| UNPROVIDED_VERSION | error | 选择器匹配不到任何提供版本 |
| CONSUMING_RETIRED | error | 消费已退役契约 |
| CONSUMING_DEPRECATED / SUNSET_PASSED | warning / error | 消费已废弃契约；sunset 已过升级为 error |
| ORPHAN_CONTRACT | warning | 无人消费且未标 public/external |
| CONTRACT_CYCLE | warning | 仓级契约环（DFS）——分布式单核签名：无法独立发布 |

error → exit 1。`fleet impact <contract>`：直接消费者 + 沿消费者所供契约的 BFS 传递闭包；`coordinationCost = 波及仓数 + 1`；未知契约 → exit 3 + 已知清单。`fleet status [--deep]`：逐仓 spawn `<repo>/.kimi-base/runtime/kimi-base.mjs doctor`（120s 超时，env `KIMI_BASE_ROOT=<dir>` 钉死项目根防祖先仓串扰）；--deep 加 `dod`（600s）；仓缺失/未安装/doctor 或 dod 非零 → exit 1 逐仓分列。`fleet recap [--budget 8000]`：逐仓 `recap --budget 700`，取前 5 条 dash 行，总量 ≤ 预算并显式截断。

### 15.5 release（发布就绪 composite）

阻断条件（任一不满足 → exit 2 逐项列出）：

| 条件 | 判定 |
| --- | --- |
| dod-static | 静态电池（与 `dod` 共享 lib/hygiene.mjs `DOD_STEPS` 单源，子进程跑真实 CLI）全 PASS；DEGRADED 也是未证明，阻断；步骤 exit 4 记 STALE（陈旧 ≠ 完整性失败），不阻断但响亮可见 |
| fast-mode-closed | 无开启的 fast 窗口（过期视同关闭，如实注明） |
| fast-debt-repaid | 最近一次 gate（最新指纹批次）无任何回执带 fastWindow/SKIPPED 印记；有则先 fast off 重跑完整 gate |
| ledger-intact | 只判完整性：receipt verify 无篡改/断链/缺失/漂移（fail-closed 面）。陈旧不属本条件——新鲜度归 receipt-fresh |
| receipt-fresh | 当前指纹下存在 ≥1 个 fresh PASS 回执（或终审 ACCEPT 评审回执；runtime 窗口内有效也算；range 评审回执 `range.head === 当前 HEAD` 也算） |
| sync-clean | sync-check 无 error |
| review-backlog | 评审 backlog 无过期条目 |

建议条件（不阻断）：risk-scan 发现。全部阻断条件成立 → exit 0 READY。**本命令永不打 tag、永不 push、永不建分支**——发布是 HIGH 级人工动作，release 只组装证据让人签字。非 git → exit 3。

职责划分：**完整性归 dod，新鲜度归 release**。`dod` 的 receipt-verify 步把 exit 4（stale-only）归级为 STALE——陈旧证据如实可见但不阻断 dod 判定；篡改/断链/缺失/漂移（exit 2）仍是 FAIL。`release` 的 ledger-intact 只判完整性问题，receipt-fresh 才判新鲜度。典型流程：工作树评审 ACCEPT → 提交（评审回执随指纹移动 stale，正常痕迹）→ 重跑 `gate` 取当前指纹 fresh 回执 → `dod`（STALE 可见，exit 0）→ `release` READY。对已提交的改动做评审用 range 模式：`review start --base <ref>`，回执绑定 `range.head`，HEAD 未移动即 fresh。
