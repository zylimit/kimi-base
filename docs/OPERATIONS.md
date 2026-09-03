# OPERATIONS：运维手册

所有命令形如 `node .kimi-base/runtime/kimi-base.mjs <verb>`（源仓内同路径，仓库自托管）。
退出码契约 v2（hook outward 契约保持 0/2）：

| 码 | 语义 |
| --- | --- |
| 0 | 成功 / PASS |
| 1 | 用法错误（含未知 flag）或规则违例（`catalog lint`/`fitness`/`adr check`/`arch check`/`arch trend --gate` 发现违规） |
| 2 | 治理阻断（`gate`/`task complete`/`quality status`/`receipt verify` 篡改·断链·缺失/`doctor`/`pack-check`/`manifest --check`/install 失败） |
| 3 | 降级（freshness 绑定操作在非 git 仓：「降级：非 git 仓，无法测量」）或引擎内部错误 |
| 4 | 陈旧证据（`receipt verify`：链完好但回执指纹已移动，含 runtime 证据窗口过期） |

## 1. 安装与自检

| 命令 | 说明 |
| --- | --- |
| `install <target> [--dry-run] [--hooks]` | 事务安装项目面（staging/备份/rollback）；`--hooks` 挂载第二道闸（git hooks） |
| `upgrade <target> [--hooks]` | 升级框架文件；用户定制写 `*.kimi-base-new` 旁路；`--hooks` 同 install |
| `uninstall <target>` | 仅删除仍等于基线的文件 |
| `doctor [target]` | 完整性自检（哈希/frontmatter/指针/JSON/第二道闸挂载警告） |
| `manifest --write\|--check` | 生成/校验 FRAMEWORK-MANIFEST.json |
| `pack-check` | 发布面泄漏审计 |
| `selftest` | 引擎冒烟 |

## 2. 日常开发循环

```bash
node .kimi-base/runtime/kimi-base.mjs task start --goal "实现 X" --owned "src/x/**" --risk medium
# ……编码……
node .kimi-base/runtime/kimi-base.mjs impact --git        # 影响面
node .kimi-base/runtime/kimi-base.mjs gate                # 受影响检查→回执
node .kimi-base/runtime/kimi-base.mjs quality status      # 五性覆盖判定
node .kimi-base/runtime/kimi-base.mjs task complete       # 完成门
```

日常记忆与需求门禁（一行一条）：

| 命令 | 说明 |
| --- | --- |
| `recap [--budget N]` | 派生式恢复视图：现算 Position + progress.md 限量摘录 + 衰变信号（压缩/换班后第一件事） |
| `invariants` | ≤1200 字符铁律+实时状态；压缩后与阶段边界重读 |
| `archive [--apply]` | progress.md 超预算时把最旧 Done/Notes 归档进 progress.archive.md（默认 dry-run） |
| `sync-check [--staged]` | 三文件同步执法：代码动而 progress.md 不动 / Spec 动而 CHANGELOG 不动 → exit 1 |
| `spec lint` | 需求可判定性：规范词/触发/度量/验收/占位符/重复 id |
| `trace` | 需求→测试覆盖门禁（spec.minCoverage 默认 1.0）与悬空引用 |
| `spec view [--paths a,b\|--all]` | 预算化需求摘要（本次变更触达哪些需求） |
| `rules-audit [--files a,b]` | 宪法执法率审计（默认纯建议） |
| `skills-lint` / `agents-lint` | skill 契约与根 AGENTS.md 体积预算 |
| `dod` | Definition of Done 静态电池：catalog lint → skills-lint → agents-lint → spec lint → adr check → fitness --all → trace → receipt verify → arch check；任一 FAIL exit 2，仅降级 exit 3；步骤 exit 4（证据陈旧）记 STALE——响亮可见但不阻断（**完整性归 dod，新鲜度归 release**） |

## 3. 架构看护

- `catalog lint`：路径归属/禁 catch-all/定档理由。
- `catalog discover [--write] [--depth N]`：从仓库事实推导 catalog 草案（源码目录分组 + 真实 import 边推导 dependsOn + tier-N 位置分层 + 构建清单命令检测 + 生产源码属性信号提案）；属性档位/forbiddenDependencies 不猜，进 `needsDecision` 待人决；已有 catalog 时 `--write` 写 `module-catalog.draft.json`（绝不覆盖人工策展），否则写 `module-catalog.json`；无可提案 → exit 3。`init-modules` 是废弃别名，转发本命令。
- `arch check [--scan]`：实边对账。违规分级：禁边 > 分层 > 未声明。发现违规 exit 1。
- `arch baseline --write`：固化存量债（每条带 reason）；已还清条目会标 stale 催删。
- `arch trend --record|--gate`：漂移快照与棘轮门——对比逐指标历史最优（best-ever），回弹 exit 1（CI/发布前跑 --gate）。
- `adr check`：ADR 的 `Enforced-by:` 必须指向真实检查或 `manual:`。

## 4. 质量属性

- `quality status`：覆盖判定（反证压过佐证；critical/high 缺证据 exit 2）。
- `quality waiver create --check K --approver 人 --reason 因 --expires ISO --compensation 补偿`：只豁免 BLOCKED/SKIPPED；security/safety/privacy 禁词拒绝（含 pii/隐私/个人信；waiver 理由文本同样受检）；绑指纹，过期自失效。
- `fitness [--path]`：五规则扫描。

## 5. 结构化对抗评审（review）

```bash
node .kimi-base/runtime/kimi-base.mjs review pack                    # 证据包（state/review/review-pack-<epoch>.md）
node .kimi-base/runtime/kimi-base.mjs review start [--base <tag>]    # 开会：绑定指纹，召集 lens 团队
echo '{"claims":[{"claim":"…","evidence":"…"}]}' | node .kimi-base/runtime/kimi-base.mjs review blue
echo '{"findings":[{"severity":"error","message":"…","location":"src/a.js:12"}]}' | node .kimi-base/runtime/kimi-base.mjs review lens correctness
node .kimi-base/runtime/kimi-base.mjs review verdict --reviewer main # 计算裁决；终审 ACCEPT 才写回执
```

- 裁决退出码：1 阻断（blue 缺/前沿 lens 未报到）· 2 FIX_REQUIRED（达 maxRounds 触顶 escalate:true，停止重试交人类）· 3 NEEDS_MORE_EVIDENCE · 0 ACCEPT（`final:true` 才写 kind:review 回执进账本）。
- `review status|team|backlog add|backlog list`：会话摘要/团队与剔除原因/挂账（受保护发现禁入，跨会话存活，过期被 risk scan 标记）。
- 完成门接线：catalog 有 `review` 段且 `requireStructured !== false` 且 risk=high → 需 fresh 终审 ACCEPT 回执。全量协议见 `docs/PROTOCOLS.md` 第 11 节。
- 提交后评审：工作树模式回执随提交必然 stale（正常流程痕迹——重跑 `gate` 补 fresh 回执即可）；对已提交的改动做评审用 range 模式 `review start --base <ref>`——回执绑定 `range.head`，HEAD 未移动即 fresh（脏工作树不影响），`receipt verify` 与 release 的 receipt-fresh 都认这个绑定。

## 6. Fast Mode

- `fast on [小时数]` / `fast off` / `fast status`：限时旁路（默认 24h），仅跳过声明 `allowFastSkip:true` 的非保护检查；每次 skip 留痕；security/safety/privacy 免疫（kind 或认领属性任一命中即受保护）。**fast 是借账不是折扣**：带 `fastWindow` 印记的 SKIPPED 不能关闭 task（完成门记缺口），也不能通过 release（fast-debt-repaid 拦截）；还债路径唯一——`fast off` 后重跑完整 `gate`。

## 7. 风险与卫生

- `risk scan`：状态腐化/死锁残留/stale 基线/脏树。
- `gate-audit`：死闸审计——长期零拦截的闸要么拿出证据要么撤掉（已知闸清单派生自分类器规则表）。
- `retention prune`：按 retention 策略销毁过期证据（保护被 receipt 引用的）；账本条目超 `retention.ledgerMaxEntries` 自动轮转（旧段归档 `ledger-archive-<ts>.jsonl`，新段 anchor 续链）。
- `receipt verify`：账本链校验；断链/篡改 fail-closed → exit 2；仅指纹移动（陈旧）→ exit 4（range 评审回执看 HEAD 不看工作树指纹）；断链后 quality status 视同未验证，重跑检查。

## 8. 服务守护（开发态）

- `services` 在 harness.json 声明；`supervisor.mjs start|stop|status|logs <name>`。
- 退避拉起/健康探针/重启风暴熔断/日志轮转；只 kill 自己启动的进程；**不是生产 init**。

## 9. 故障恢复

| 症状 | 处置 |
| --- | --- |
| 压缩/重启后状态丢失 | `/kimi-base:recap`（引擎 `recap`+`invariants` 派生视图）；需求基线补读 Spec+CHANGELOG |
| Stop 门连续误拦 | 同一指纹 3 次后自动放行；查 gate-log 定位欠账 |
| receipt 被判 stale | 指纹变了（有改动）；重跑 `gate` |
| 账本断链 | `receipt verify` 定位断点；断链后 quality status 视同未验证，重跑检查 |
| 安装中途失败 | 自动逆序 rollback；残留 staging 在 `.kimi-base/state/install-*`，人工清理 |
| hook 不生效 | 确认插件已安装且 `/plugins` 中启用；确认项目根有 `.kimi-base/harness.json`；`/kimi-base:doctor` 查配置 |

## 10. 三面执法：git hooks + 独立审计 + CI

三道闸互补（模型见 `docs/ISOLATION-PROFILES.md` 第 5 节）：插件 hooks（fail-open 护栏）→ git hooks（本地 fail-closed）→ CI（合并权威）。

### 挂载第二道闸（git hooks）

```bash
node .kimi-base/runtime/kimi-base.mjs install . --hooks   # 或 upgrade . --hooks
```

做三件事：`git config core.hooksPath .kimi-base/githooks`；三钩子 `chmod 755`；`git add --chmod=+x` 让可执行位进 index（跨平台存活）。目标非 git 仓 = 响亮降级（warning），安装主事务不受影响。`doctor` 会对未挂载的 git 仓给出"第二道闸未挂载"警告（不失败）。

各钩子跑什么：

- `pre-commit`（首个失败即拦；exit 3 降级响亮记录但不拦）：`scan-secrets --staged` → `scan-instructions --staged` → `check-syntax` → `catalog lint` → `skills-lint` → `agents-lint` → `fitness --staged` → `sync-check --staged`；末尾 `budget --staged || true` 为 ADVISORY（超出仅响亮提示；P6+ 去掉 `|| true` 即升级为闸门）。
- `pre-push`：`dod` → `gate`，任一非零（含降级 3）即拦。kimi 的 gate 把证据绑定整棵树指纹（漂移即 stale、fail-closed），已覆盖 dsh 式 `--baseline` 的范围语义，故不需要该 flag。
- `commit-msg`：主题 <12 字符或命中废话黑名单（wip/fix/update/changes/misc/stuff/temp/test/asdf，整词、大小写不敏感）→ 拦；>72 字符只警告；Merge/Revert/注释行豁免。

诚实声明（务必读）：项目无 `.kimi-base/harness.json` 标记时钩子完全静默；机器上没有 node 时钩子响亮放行（**SKIPPED 不是 PASS**——这是文档化 fail-open，权威在 CI）；`--no-verify` 可以绕过本地闸，绕过属 HIGH 级行为、必须能向人解释。

### 独立审计脚本（`.kimi-base/audit/`）

五个零依赖 Node 脚本，**禁止 import 引擎**（catalog 中 `audit` 模块声明 `forbiddenDependencies:["engine"]`，`arch check --scan` 机械执法；另有静态测试锁死 `../runtime` 引用）——引擎内部缺陷无法让它们沉默。stdout 单行 JSON + stderr 人类摘要；exit 0/1，非 git 仓 exit 3。

| 脚本 | 回答的问题 |
| --- | --- |
| `scan-secrets.mjs [--staged]` | 禁入库路径（.env 非 example/密钥材料/凭据目录）被 tracked？文本含凭据形状字面量（PEM/ghp_/sk-/AKIA/通用 password·token 赋值 ≥8 字符）？占位/示例/env 引用放行；`scan-secrets:ignore` 同行抑制留痕 |
| `scan-instructions.mjs [--staged]` | 指令文件（AGENTS/CLAUDE/SKILL/.cursor 等，不可信输入）含 8 类注入？（端点改写/内嵌凭据/指令推翻/外泄命令/隐瞒用户/隐形字符/教唆绕门禁/读秘密文件）`scan-instructions:ignore` 抑制 |
| `check-syntax.mjs` | 每个 tracked .mjs/.cjs/.js 都能 `node --check` 通过？ |
| `manifest.mjs [--check]` | FRAMEWORK-MANIFEST.json 与复制面实况一致？（独立重算 LF 归一化 sha256 + digest，不用引擎代码） |
| `run-tests.mjs` | Node 20 安全的 `node --test` 启动器（显式文件清单，不依赖 glob 展开）；无测试可跑 exit 3 |

### 第三道闸（CI）

本仓 `.github/workflows/ci.yml` 即参考实现：selftest → check-syntax → scan-secrets → scan-instructions → manifest --check → run-tests → `dod` → `arch trend --gate`（ubuntu+windows × node 20/22）。采纳者把 `.kimi-base/templates/github-gate.yml` 复制到自己仓的 `.github/workflows/`（installer 不写 `.github`——不越俎代庖）；安装布局 = 源布局，路径无需调整。

## 11. 规模化与仓群治理（P6）

| 命令 | 说明 |
| --- | --- |
| `catalog discover [--write] [--depth N]` | 棕地/绿地接入：从 tracked 路径、真实 import 边与构建清单推导 module-catalog 草案；猜不了的字段（属性档位/forbiddenDependencies/层名/矩阵接线）进 `needsDecision`，绝不替人决定 |
| `cochange [--limit N] [--min-pairs N] [--ratio F]` | 用 git 历史测量模块共变耦合：无声明边的高耦合对 = BOUNDARY_SUSPECT（exit 1）；有声明边 = HIGH_COUPLING（warning）；`catalog.cochange.accepted` 三元组留痕接受（warning）；可分析提交 <30 = LOW_CONFIDENCE（exit 0，结果是提示不是测量）；从不共变的模块列为抽仓候选 |
| `budget [--staged\|--baseline ref]` | 变更爆炸半径预算门：changedFiles/changedLines/modulesTouched/newFiles 对照 harness.json `budget` 段；任一超限 exit 1（"超出预算意味着拆分变更或升级——永不靠放宽预算消红"）；未配置 exit 3 |
| `fleet lint` | 仓群清单校验：DANGLING_CONSUME/DEPRECATED_WITHOUT_SUNSET/CONTRACT_MULTIPLE_OWNERS/CONSUMING_RETIRED/SUNSET_PASSED 等为 error（exit 1）；NO_OWNER/ORPHAN_CONTRACT/CONTRACT_CYCLE 等为 warning |
| `fleet impact <contract>` | 契约变更波及面：直接消费者 + 传递闭包；`coordinationCost` = 必须一起发布的仓数（这个数字就是决策）；未知契约 exit 3 + 已知清单 |
| `fleet status [--deep]` | 组级体检：逐仓 spawn 各自引擎 `doctor`（120s 超时，`KIMI_BASE_ROOT` 钉根防串仓），`--deep` 加 `dod`；任一仓有问题 exit 1 |
| `fleet recap [--budget N]` | 组级"现在到哪了"：逐仓 `recap --budget 700` 取前 5 条 dash 行，总量 ≤ 预算（默认 8000） |
| `release` | 发布就绪 composite：静态电池（与 `dod` 共享 DOD_STEPS 单源；STALE 不阻断但可见）+ fast 窗口已关 + fast 欠账已还 + 账本链完好（只判完整性：篡改/断链/缺失/漂移；陈旧归 receipt-fresh）+ 当前指纹 fresh 回执（含 `range.head === HEAD` 的 range 评审回执）+ sync-check 干净 + 评审 backlog 无过期；建议项 risk scan；阻断项不满足 exit 2 逐项列出。**永不打 tag/push/建分支** |

fleet.json 是组级文件（放各仓共同祖先目录）：`--fleet <path>` > `KIMI_BASE_FLEET` 环境变量 > 自 cwd 向上逐级查找；找不到 = 单仓模式（fleet 动词 exit 3）。installer 不种子 fleet.json；治理指南与示例见 `.kimi-base/templates/FLEET.md` 与 `.kimi-base/templates/fleet.example.json`。字段级协议见 `docs/PROTOCOLS.md` 第 15 节。
