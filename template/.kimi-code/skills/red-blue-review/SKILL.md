---
name: red-blue-review
description: 当要对一批改动做发版前/合并前对抗审查，或用户说红蓝审查、对抗审查、检视改动时使用。
type: prompt
whenToUse: 当一批改动已成型、需要发版前或合并前的对抗性审查，或高风险改动（架构变更、安全相关、核心逻辑重写）时
---

# Red-Blue Review — 红蓝对抗审查

## 任务

对一批改动跑 Blue → Red → Judge 三遍，把审查从「看着没问题」变成「证据说话」。
定位：发版/合并前的对抗闸。比 code-review 三阶段更对抗（红队默认证伪、专挑死角）。
结论填进报告副本：`ACCEPT`（放行）/ `FIX_REQUIRED`（须修清单）/ `NEEDS_MORE_EVIDENCE`（证据不足，补了再判）。

## 依赖检测

- 必需：一批已成型的改动（已 commit，默认审最近 tag..HEAD；或工作树未提交改动）；git 可用。无改动则提示无可审范围。
- 可选：Product-Spec.md（红队可对照需求挑「自相矛盾」）、DEV-PLAN.md（对照 Phase 交付清单看漏没漏）。

## 第一性原则

**自述不作数**：Blue 的自证、Red 的指控、子 Agent 的「通过」，都不因为「它这么说」就采信——必须落到 file:line 或可复现路径才算数。给不出落点的，一律不进结论。

**红队是证伪姿态**：Red 默认想推翻这批改动，不是找优点。专往边界、回滚、安全死角挑——「没挑出问题」只在挑过了之后才成立。

**Judge 只看证据**：裁定时只认 file:line 和复现路径，不看任何一方的自述措辞。证据够才下结论，不够就 NEEDS_MORE_EVIDENCE，不替任何一方圆场。

**走过场 = 失职**：Blue 没真自证、Red 没真攻击就出的 PASS，比不审更糟——它制造虚假安全感。任何一方交白卷式「没问题」，Judge 直接打回。

## 三遍流程

### Blue pass：自证（摆靶子，不作数）

派 implementer（fresh 实例）把这批改动逐条自证：改了什么（文件 + 一句话意图）、验证了什么（跑了什么命令）、证据在哪（file:line / 命令 + 输出位置）。明确告诉它：这是自述，只作红队靶子，**不作为通过依据**。

### Red pass：攻击（证伪姿态，四 lens）

派 code-reviewer（fresh 实例，独立于 Blue），按四个 lens 逐个往死里挑，每 lens 默认想推翻：

- **correctness**——逻辑错、边界漏（空/越界/null）、与既有规则或 Spec 自相矛盾
- **security**——注入 / 越权 / 泄露（密钥、路径）/ 破坏性操作无防护
- **resilience**——无界重试、缺超时、静默吞错、故障扩散、回滚困难
- **privacy**——日志/出口携带个人数据、产物混入私密文件、销毁缺失

（发版场景可将后两个 lens 替换为 release / 跨平台 lens：打包产物缺漏、装不上、路径/换行/编码坑。）

铁律：每个 finding 必须附**复现路径或文件行号**——给不出的不算 finding（防空喊）。挑不出就如实报「该 lens 无 finding」，不凑数。

### Judge pass：裁定（主 Agent，只看证据）

主 Agent 逐条裁定每个 Red finding：

- **采信**——证据（file:line / 复现路径）成立 → 计入须修
- **驳回**——证据不足 / 复现不出来 → 写明理由，降级待确认，不计入须修

全部裁完后出三态之一：`ACCEPT` / `FIX_REQUIRED`（列清单，每条带 file:line + 修复建议）/ `NEEDS_MORE_EVIDENCE`（指明缺什么、回去补了再判）。

## 轮次封顶

最多 **2 轮**：FIX_REQUIRED → 派 bug-fixer / implementer 修 → 重跑本流程为第 2 轮；第 2 轮仍 FIX_REQUIRED → 停止循环，把未决清单与证据升级给用户决策，不无限打磨。

## 工作流程（主 Agent 编排）

1. **拷报告副本**：`${KIMI_SKILL_DIR}/RED-BLUE-REVIEW.md` 是空模板，**永远保持空**——绝不就地填。每次审查先拷到 per-review 工作路径（如 `.task/red-blue-review-<标识>.md`，标识由主 Agent 定，方便三方指同一份）。
2. **凑证据包**：跑 `bash ${KIMI_SKILL_DIR}/red-blue-review.sh [BASE] [HEAD]`（审未提交工作树用 `--working`），拿到 markdown 证据包：审查范围、改动清单、删除审计、新文件、完整 diff（过长时给临时文件路径）。脚本对无效 ref 响亮报错——见到报错先核对参数，别把空包当「没东西可审」。删除审计重点看：diff 里删除行落在规则/skill/钩子上时，确认是不是误删既有防线。
3. **Blue 自证**：派 implementer 把自证表直接写进报告副本的 Blue 区，回传只给「已写入 + 一句话摘要」——**产物文件才是交付，回传消息不承载 findings**。
4. **Red 攻击**：派 code-reviewer 把按 lens 分组的 findings 直接写进报告副本的 Red 区，同样只回「已写入 + 摘要」。
5. **Judge 裁定**：主 Agent 自己读报告副本逐条裁定（不派子代理裁定；需要回溯原文时可派 fresh researcher 翻证据，裁定权留主 Agent）。结论 + 逐条理由填进 Judge 区：
   - `ACCEPT` → 放行，可继续 commit / 合并 / 发版
   - `FIX_REQUIRED` → 修复后重跑（计入轮次）
   - `NEEDS_MORE_EVIDENCE` → 补齐证据（补测试/补复现）→ 回到对应遍重判

## 初始化

执行依赖检测 → 从拷报告副本开始。
