# kimi-base

面向 [Kimi Code CLI](https://www.kimi.com/code/docs/en/) 的 **AI 编程 harness 开发脚手架**——把"需求质量、架构看护、五性治理、证据优先"固化为一整套可安装、可升级、可机器执法的开发环境，目标场景是 **60 万行级、多模块、长周期**仓库。

它不是一个新的 Agent runtime，也不修改 Kimi Code 本身：全部能力都建立在 Kimi Code 原生机制（插件 / hooks / custom agents / skills / 斜杠命令 / AGENTS.md / Plan 模式 / Goal 模式）之上，缺什么补什么，补的部分以"可执行检查"优先、"提示词纪律"兜底。

## 它解决什么问题

AI 结对编程在大型仓库上的典型失控模式：需求没问清就开工、架构边界随时间漂移、"检查全绿但没人证明过安全性"、agent 自报完成却无证据、上下文撞墙后状态丢失、旧证据为新代码背书。kimi-base 的对策是一句话：

> **一切质量结论必须有绑定当前 diff 的新鲜机器证据；一切治理退出必须留痕；一切守护自身也受治理。**

## 三面执法（v2.0 核心）

执法不住在一个层面——任何单面都有失效面，三面的失效语义逐面如实声明：

| 面 | 机制 | 失效语义 |
| --- | --- | --- |
| 工具调用时 | Kimi 插件 hooks（7 事件）：危险命令分类器 / 写前对账 / 完成门 / 压缩前落盘 | **fail-open 护栏**（宿主设计），高危面靠 permission rules 兜底；非标记项目标记惰性自静默 |
| git 操作 | `.kimi-base/githooks/`（pre-commit 电池 / pre-push dod+gate / commit-msg lint），`install --hooks` 挂载 | **fail-closed**；无 node 时响亮 fail-open（不伪装有闸） |
| CI | selftest → `.kimi-base/audit/` 独立审计（禁 import 引擎）→ 行为测试 → dod → arch trend --gate | **权威面**；采纳者模板 `templates/github-gate.yml` |

三面共用同一套引擎动词与 DOD_STEPS 事实源——判定语义没有第二份拷贝。详见 `docs/ISOLATION-PROFILES.md` 与 ADR-0002。

## 仓库布局（源布局 = 安装布局）

本仓自托管：仓库里的 `.kimi-base/` 就是装到目标项目里的样子，本仓用自己的引擎治理自己。

```
┌─ 插件面（全局安装一次）────────────────────────────────
│  kimi.plugin.json …… hooks(7 事件) + /kimi-base:* 命令 + sessionStart skill
│
└─ 项目面（载荷，install 进每个受治理项目）───────────────
   AGENTS.md                    项目小宪法（种子，缺失才落地）
   .kimi-code/agents/*.md        8 个专职角色
   .kimi-code/skills/*/SKILL.md  16 个工作流
   .kimi-base/
    ├─ runtime/                  治理引擎（薄入口 kimi-base.mjs + lib/ 31 模块 + supervisor.mjs，零依赖）
    ├─ audit/                    5 个独立审计脚本（禁 import 引擎，双实现防共谋）
    ├─ githooks/                 pre-commit / pre-push / commit-msg（第二道闸）
    ├─ rules/                    下沉细则 · templates/ 文档与 CI 模板
    ├─ harness.example.json 等    三配置种子（缺失才落地，永不覆盖）
    ├─ harness.json 等            本仓自用治理配置（永不进安装面）
    └─ state/                    运行态（git-ignored）：任务账本/回执/账本链/评审会话
```

## 安装

```bash
# 1. 安装插件（提供全局 hooks 与 /kimi-base:* 命令；在 Kimi Code 中执行）
/plugins install <本仓库路径或 URL>

# 2. 在目标项目中安装项目面（复制面 + 种子 + 可选 git hooks）
cd <你的项目>
node <kimi-base 仓库>/.kimi-base/runtime/kimi-base.mjs install . --hooks
#   --hooks 经 core.hooksPath 挂载第二道闸；非 git 仓响亮降级
#   或用包装脚本： bash <kimi-base 仓库>/setup.sh .
```

未安装插件时项目面仍可工作：所有治理命令可手动/由 agent 执行，但工具调用时闸门不生效（降级为建议性纪律）。这是诚实声明，不是缺陷隐藏——见 `docs/ISOLATION-PROFILES.md`。

## 快速上手

```text
你：我想做一个 <产品想法>
→ product-spec-builder 追问补齐六维 + 五性需求 → Product-Spec.md（你签字批准）
→ arch-designer 推演 → Architecture-Design.md + module-catalog 骨架
→ dfx-designer 五性定档（可度量或不写）→ dev-planner 出 DEV-PLAN.md
→ implementer 编码 → review 结构化对抗评审 → tester 红测先行
→ gate 按风险层出证据回执 → quality status 判定五性覆盖 → release 发布就绪判定
```

大仓接入（棕地）四步：`catalog discover --write` 从仓库事实推导骨架 → 人逐项决定 needsDecision → `arch baseline --write` 固化存量债务 → 此后 `arch trend --gate` 棘轮执法：**旧债不挡路、新债零容忍**。

## 治理引擎命令速查

`node .kimi-base/runtime/kimi-base.mjs <verb>`（40 个动词含 help；退出码契约 v2：0 干净 / 1 用法·违例 / 2 阻断 / 3 降级 / 4 陈旧）

| 组 | 命令 | 作用 |
| --- | --- | --- |
| 任务与证据 | `task start/status/complete` · `gate` · `quality status/waiver` · `receipt verify` · `fast on/off` | 任务账本；四态质量门出 diff 绑定回执；五性覆盖判定（反证压过佐证）；账本哈希链校验；限时旁路（protected 免疫，借账不能关闭 task） |
| 架构防腐 | `catalog lint/discover` · `arch check/baseline/trend` · `adr check` · `fitness` · `cochange` · `budget` | 路径归属；真实 import 边对账声明图 + 逐指标历史最优棘轮；ADR 幽灵引用；五规则文本扫描；git 历史共变耦合；变更预算门 |
| 评审 | `review pack/start/blue/lens/verdict/status/team/backlog` | 结构化对抗评审：九 lens 三阶段，计算裁决，终审 ACCEPT 才写回执，backlog 持久 |
| 需求与记忆 | `spec lint/view` · `trace` · `recap` · `invariants` · `archive` · `sync-check` · `rules-audit` | 需求可判定性 lint；REQ↔代码/测试追溯门；派生式恢复视图；铁律注入；归档；三文件同步执法；宪法执法率审计 |
| 发布 | `dod` · `release` · `pack-check` · `manifest` · `doctor` | DoD 静态电池；发布就绪 composite（永不打 tag/push）；发布面泄漏审计；哈希清单；安装自检 |
| 大仓与仓群 | `impact` · `context pack` · `fleet lint/impact/status/recap` | 影响面分析（验证随影响收缩）；预算化上下文包（DENY 清单永不入包）；多仓契约治理 |
| 运维 | `risk scan` · `gate-audit` · `retention prune` · `hook <event>` · `selftest` | 风险识别；死闸审计；证据生命周期；hook 调度器；运行时自冒烟 |
| 安装 | `install/upgrade/uninstall [--hooks] [--dry-run]` | 事务安装（种子缺失才落地、定制旁路、逆序 rollback） |

完整语义见 `docs/OPERATIONS.md` 与 `docs/PROTOCOLS.md`；每个动词支持 `--help`。

## 五性治理（Resilience / Security / Safety / Privacy / Reliability）

模块在 catalog 声明属性档位（critical/high/medium/low/minimal/none；none/minimal 必须书面理由），检查在 matrix 声明它是哪些属性的证据，`quality status` 据此判定：**critical/high 缺 fresh 证据即阻断；一个 FAIL 否决全部 PASS；security、safety、privacy 永不豁免、永不 fast-skip**（v2.0 起 privacy 入保护底线，ADR-0004）。治理消灭的是"没人查过"这个状态，而不是宣称证明了属性成立——见 `docs/QUALITY-ATTRIBUTES.md`。

## 诚实边界

- hooks 是护栏不是沙箱：Kimi Code hooks 采用 fail-open 设计（脚本异常默认放行），高危操作请配合权限审批与 `[[permission.rules]]`；git hooks 面无 node 时同样响亮 fail-open。
- 命令分类器与 fitness/arch 检查是**启发式**：它们消灭"漂移与危险不可见"，不等价于形式化验证或完整威胁模型。
- 账本链是本地证据不是密码学签名——有仓库写权限者可以重写它；它是防"无意遗忘"的账，不是防"蓄意篡改"的锁。
- 不写第二套 Agent runtime；不承诺 OS 级隔离。

## 血缘与方法

kimi-base 是 codex-base / cc-base / ccb-base / pi-base / cursor-base / opencode-base / dsh-base 七个姊妹脚手架经验的融合产物，吸收与拒绝逐条留痕于 `docs/CROSS-POLLINATION.md`；Kimi 原生能力映射见 `docs/CAPABILITY-MATRIX.md`；真实项目 dogfood 教训见 `docs/LARGE-REPO-GUIDE.md`。

## 文档索引

- `Product-Spec.md` / `DEV-PLAN.md` / `progress.md` —— 本仓库自身的需求、计划与记忆（自食其果）
- `docs/ARCHITECTURE.md` —— 架构总图与设计决策 · `docs/adr/` —— 七条架构决策记录
- `docs/QUALITY-ATTRIBUTES.md` —— 五性治理专文
- `docs/LARGE-REPO-GUIDE.md` —— 60 万行作业法
- `docs/OPERATIONS.md` / `docs/PROTOCOLS.md` / `docs/ROLE-CONTRACTS.md` —— 运维手册 / 字段协议 / 角色契约
- `docs/ISOLATION-PROFILES.md` —— 隔离档位与诚实声明
- `CHANGELOG.md` —— 版本变更记录
