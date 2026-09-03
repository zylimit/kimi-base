---
name: red-blue-review
description: 当要对一批改动做发版前/合并前对抗审查，或用户说红蓝审查、对抗审查、检视改动时使用。
type: prompt
whenToUse: 当一批改动已成型、需要发版前或合并前的对抗性审查，或高风险改动（架构变更、安全相关、核心逻辑重写）时
---

# Red-Blue Review — 红蓝对抗审查（引擎协议编排）

## 任务

把审查从「看着没问题」变成「证据说话」：Blue 自证摆靶 → 各 lens 独立攻击 → 引擎计算裁决。
本 skill 只做编排；会话、校验、裁决、回执全部由治理引擎 `review` 动词族机械执行。
三态裁决：`ACCEPT`（放行，终审才写回执）/ `FIX_REQUIRED`（exit 2，须修）/ `NEEDS_MORE_EVIDENCE`（exit 3，补证据再判）。

## 依赖检测

- 必需：git 仓 + 一批已成型的改动（工作树未提交改动，或 `review start --base <ref>` 审提交范围）。
- 可选：catalog `review` 段（profile/lenses/maxRounds/requireStructured）；缺省剖面 team。
- 无改动时引擎 exit 3（no-change）——不要绕过，如实报告无可审范围。

## 第一性原则

**自述不作数**：Blue 的自证只作红队靶子，不作通过依据（引擎只记录、不采信）。

**红队是证伪姿态**：每个 lens 默认想推翻这批改动，专往边界、回滚、安全死角挑——「没挑出问题」只在挑过了之后才成立。挑不出就如实报 `{"findings":[]}`，不凑数。

**发现必须有落点**：每条 finding 必须带 `location`（`file:line`，Windows 路径合法）或 `reproduction`（可复现路径），否则引擎整批拒收。

**裁决是计算的**：未报到的 lens 不能被豁免；报出 error 的 lens 不被干净 lens 投票压过；主 Agent 不得替任何一方圆场改写裁决。

## 编排流程（主 Agent）

引擎：`node .kimi-base/runtime/kimi-base.mjs review <sub>`（下称 `kb review …`）。

1. **凑证据包**：`kb review pack` → 读生成的 `state/review/review-pack-<epoch>.md`（commit 清单/diffstat/删除审计/未跟踪/完整 diff；diff 超 800 行时读溢出 patch）。删除审计重点核：删除行落在规则/skill/钩子上时，确认不是误删既有防线。
2. **开会**：`kb review start`（发版审提交范围用 `--base <tag>`）。引擎输出本轮召集的 lens 清单（含阶段）与被剔除 lens（含原因）——以引擎输出为准，不自作主张加减。
3. **Blue 自证**：派 implementer（fresh 实例）逐条自证「改了什么/验证了什么/证据在哪」，主 Agent 汇总为 claims 数组喂 `kb review blue`（stdin JSON）。被拒（缺 claim/evidence）即打回重写，不垫付。
4. **Red 攻击**：按当前阶段给每个召集 lens 派一个 fresh code-reviewer 子代理——单消息派单（目标 + pack 路径 + 该 lens 的 asks + 输出格式），子代理只回该 lens 的 stdin JSON（`{"findings":[…]}` 或 `{"findings":[],"unable":true,"unableReason":"…"}`）。主 Agent 原样喂 `kb review lens <name>`；被拒（stageGated/缺落点）即打回，不修饰。阶段未齐报前不得派后续阶段的 lens。
   - 任何一方发现召集清单之外的问题：`kb review lens <name> --ad-hoc`（额外证据，error 照样压 verdict）——通道存在就是为了它。
5. **裁决**：`kb review verdict --reviewer <主 Agent 标识>`。
   - exit 1 = 阻断（blue 缺/前沿 lens 未报到）→ 补齐再判
   - exit 2 = `FIX_REQUIRED` → 派 bug-fixer 修 → `kb review start` 开新一轮（lineage 跨轮存活）；stdout 出现 `escalate:true` = 触顶，停止重试，把未决清单升级给用户
   - exit 3 = `NEEDS_MORE_EVIDENCE` → 按 unableReason 补证据后重报该 lens
   - exit 0 且 `final:true` = 终审 ACCEPT，回执已写账本——完成门/发布只认这份回执；`final:false` = 阶段通过，推进下一阶段
6. **挂账**：人类拍板接受的非受保护 finding 可 `kb review backlog add`（owner+expiry+summary+lens）；summary 命中 security/safety/privacy 等禁词引擎一律拒——受保护发现只能修或升级，不得挂账。

## 轮次封顶

maxRounds 由 catalog `review.maxRounds` 定（默认 3）。触顶后引擎输出 `escalate:true`：同一改动反复被拒是关于标准的信息，不是再试一次的指令——停止循环，交由人类裁决（缩范围/降剖面/书面记债三选一）。

## 初始化

执行依赖检测 → `kb review pack`。
