# kimi-base

面向 [Kimi Code CLI](https://www.kimi.com/code/docs/en/) 的 **AI 编程 harness 开发脚手架**——把"需求质量、架构看护、五性治理、证据优先"固化为一整套可安装、可升级、可机器执法的开发环境，目标场景是 **60 万行级、多模块、长周期**仓库。

它不是一个新的 Agent runtime，也不修改 Kimi Code 本身：全部能力都建立在 Kimi Code 原生机制（插件 / hooks / custom agents / skills / 斜杠命令 / AGENTS.md / Plan 模式 / Goal 模式）之上，缺什么补什么，补的部分以"可执行检查"优先、"提示词纪律"兜底。

## 它解决什么问题

AI 结对编程在大型仓库上的典型失控模式：需求没问清就开工、架构边界随时间漂移、"检查全绿但没人证明过安全性"、agent 自报完成却无证据、上下文撞墙后状态丢失、旧证据为新代码背书。kimi-base 的对策是一句话：

> **一切质量结论必须有绑定当前 diff 的新鲜机器证据；一切治理退出必须留痕；一切守护自身也受治理。**

## 双层架构

```
┌─ 插件面（全局安装一次）───────────────────────────────
│  kimi.plugin.json
│   ├─ hooks（7 事件）…… 危险命令拦截 / 写前对账 / 完成门 / 压缩前落盘
│   │                  非 kimi-base 项目中自动静默（标记：.kimi-base/harness.json）
│   ├─ sessionStart skill …… 会话启动路由（检测标记→横幅→skill 路由）
│   └─ /kimi-base:* 斜杠命令 … init / doctor / status / verify / arch / recap / record / fast
│
└─ 项目面（注入到每个受治理项目）────────────────────────
   AGENTS.md                    项目小宪法（≤150 行，细节下沉 rules/）
   .kimi-code/agents/*.md        8 个专职角色（implementer/reviewer/tester/…）
   .kimi-code/skills/*/SKILL.md  16 个工作流（需求→架构→DFX→计划→编码→审查→测试→发布）
   .kimi-base/
    ├─ harness.json              唯一配置源
    ├─ module-catalog.json       模块目录：分层 / 禁边 / 五性定档
    ├─ verification-matrix.json  验证矩阵：检查 = 五性证据的认领声明
    ├─ rules/                    下沉细则（命中指针必须完整读取）
    ├─ templates/                ADR / Spec / Plan / 进度 模板
    ├─ runtime/kimi-base.mjs     治理引擎（零依赖单文件 CLI）
    └─ state/                    运行态（git-ignored）：任务账本/回执/证据/闸门日志
```

## 安装

```bash
# 1. 安装插件（提供全局 hooks 与 /kimi-base:* 命令；在 Kimi Code 中执行）
/plugins install <本仓库路径或 URL>

# 2. 在目标项目中初始化项目面
cd <你的项目>
node <kimi-base 仓库>/runtime/kimi-base.mjs install .
#   或用包装脚本： bash <kimi-base 仓库>/setup.sh .
```

未安装插件时项目面仍可工作：所有治理命令可手动/由 agent 执行，但 Stop/PreToolUse 等机器闸门不生效（降级为建议性纪律）。这是诚实声明，不是缺陷隐藏——见 `docs/ISOLATION-PROFILES.md`。

## 快速上手

```text
你：我想做一个 <产品想法>
→ product-spec-builder 追问补齐六维 + 五性需求 → Product-Spec.md（你签字批准）
→ arch-designer 七大原则推演 → Architecture-Design.md + module-catalog 骨架
→ dfx-designer 五性定档（可度量或不写）→ 落 catalog attributes
→ dev-planner 出 DEV-PLAN.md（无占位符、Task 五要素）
→ implementer 编码 → code-reviewer 三阶段审查 → tester 红测先行
→ gate 按风险层出证据回执 → quality status 判定五性覆盖 → 发布闸
```

大仓接入（棕地）：`init-modules` 生成模块骨架 → `arch baseline --write` 固化存量债务 → 之后**旧债不挡路、新债零容忍**。

## 治理引擎命令速查

| 命令 | 作用 |
| --- | --- |
| `task start/complete/status` | 任务账本：ownedPaths 哈希基线，完成门校验 |
| `gate [--risk R]` | 四态质量门 PASS/FAIL/BLOCKED/SKIPPED，出 diff 绑定回执 |
| `quality status / waiver` | 五性覆盖判定（反证压过佐证）；豁免留痕，security/safety 永不可豁免 |
| `catalog lint` | 每条路径必有主，拒绝 catch-all |
| `arch check / baseline / trend` | 真实 import 边对账声明图；债务棘轮 |
| `adr check` | ADR 执法引用幽灵检测 |
| `fitness` | 内置五规则：密钥字面量/日志 PII/空 catch/无界重试/裸 TODO |
| `impact [--git]` | 变更影响面分析，验证计划随影响收缩 |
| `context pack` | 预算化上下文包，凭据 DENY 清单永不入包 |
| `fast on/off/status` | 限时旁路，security/safety 免疫 |
| `risk scan` / `gate-audit` / `retention prune` | 风险识别 / 死闸审计 / 证据生命周期 |
| `doctor` / `manifest` / `pack-check` | 安装自检 / 哈希清单 / 发布泄漏审计 |

完整语义见 `docs/OPERATIONS.md` 与 `docs/PROTOCOLS.md`。

## 五性治理（Resilience / Security / Safety / Privacy / Reliability）

模块在 catalog 声明属性档位（critical/high/medium/low/minimal/none；none/minimal 必须书面理由），检查在 matrix 声明它是哪些属性的证据，`quality status` 据此判定：**critical/high 缺 fresh 证据即阻断；一个 FAIL 否决全部 PASS；security 与 safety 永不豁免、永不 fast-skip**。治理消灭的是"没人查过"这个状态，而不是宣称证明了属性成立——见 `docs/QUALITY-ATTRIBUTES.md`。

## 诚实边界

- hooks 是护栏不是沙箱：Kimi Code hooks 采用 fail-open 设计（脚本异常默认放行），高危操作请配合权限审批（`manual` 模式）与 `[[permission.rules]]`。
- 不写第二套 Agent runtime；不承诺 OS 级隔离；账本链是本地证据不是密码学签名。
- 架构/fitness 检查是文本启发式：它们消灭"漂移不可见"，不等价于形式化验证。

## 血缘与方法

kimi-base 是 codex-base / cc-base / ccb-base / pi-base / cursor-base / opencode-base 六个姊妹脚手架经验的融合产物，吸收与拒绝逐条留痕于 `docs/CROSS-POLLINATION.md`；Kimi 原生能力映射见 `docs/CAPABILITY-MATRIX.md`；真实项目 dogfood 教训见 `docs/LARGE-REPO-GUIDE.md` 末章。

## 文档索引

- `Product-Spec.md` / `DEV-PLAN.md` / `progress.md` —— 本仓库自身的需求、计划与记忆（自食其果）
- `docs/ARCHITECTURE.md` —— 架构总图与设计决策
- `docs/QUALITY-ATTRIBUTES.md` —— 五性治理专文
- `docs/LARGE-REPO-GUIDE.md` —— 60 万行作业法
- `docs/OPERATIONS.md` / `docs/PROTOCOLS.md` / `docs/ROLE-CONTRACTS.md` —— 运维手册 / 字段协议 / 角色契约
- `docs/ISOLATION-PROFILES.md` —— 隔离档位与诚实声明
