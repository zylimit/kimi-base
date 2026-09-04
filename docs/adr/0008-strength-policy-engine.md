# ADR-0008：强度策略引擎（strength policy）——四档×控制轴、extends 只收紧、floor 只升不降、policyHash 绑证据

状态：Accepted · 日期：2026-09-04 · 决策者：用户 + 主 Agent
Enforced-by: unit, manual:P3 落地后由 strength 行为测试与 catalog lint 的 STRENGTH_WEAKENING 校验机械执法

## 背景

kimi-base 的治理强度是散装的：属性六档（模块×属性）、review 四剖面、fast 窗口、风险等级各自独立，没有仓级总开关，也没有"这个任务为什么跑这档"的可回答性。对照研究显示 codex-base v5 的 Assurance Policy 是姐妹仓中唯一成体系的档化模型（16 控制轴、extends 单调、floor 只升不降、policyHash 绑回执、shadow 迁移、decision log），而其本身也有可改良处（投影层过度工程、配置语义挤在 CLI 解析层）。用户拍板 v3.0 采用"强度策略引擎"模型：可严格开发、可快速开发、可精细化逐轴调节。

## 决策

1. 新增 `.kimi-base/strength.json`（自用，不进安装面）与 `strength.example.json`（种子）。四内置档：
   - `explore`：只读探索；completionMode=forbidden；verification=none。
   - `rapid`：快速开发；direct 验证、bound 证据、deferralMode=loan（允许证据贷款）。
   - `balanced`：均衡；affected 验证、独立评审、requireSpecTrace。
   - `strict`：严格；all 验证、三阶段全 lens 评审、独立 tester、deferralMode=disabled、reviewRounds=3。
2. 控制轴（首版 12 轴）：verificationBreadth / testStrength / reviewerMode / reviewStages / reviewLenses / reviewRounds / evidenceLevel / deferralMode / completionMode / requireSpecTrace / contextBudgetChars / budgetMaxFiles。轴集封闭，未知轴配置期拒绝。
3. **extends 只收紧**：自定义档继承具名档，逐轴校验单调；任何降级在配置期报 `STRENGTH_WEAKENING` exit 1，不是运行时才被发现。
4. **floor 只升不降**：risk tier（low→rapid / medium→balanced / high·critical→strict）× operation（develop≥rapid / complete≥balanced / package·release·deploy≥strict）× 保护属性（security/safety/privacy @ high+→strict）× 路径（治理面 `.kimi-base/**` 与信任边界 auth/security/secrets→strict）。多 floor 冲突取最高档；task 级覆盖只能逐轴收紧，放宽即拒绝。
5. **policyHash 绑证据**：解析输出 targetControls + policyHash，写入 Receipt v2（见 ADR-0009）；策略收紧 → 旧证据自动 stale（exit 4），放宽不追溯。
6. **shadow 迁移模式**：`rollout: shadow` 时解析结果只报告不阻断，供既有项目平滑接入；shadow 状态在 `strength status` 与 gate 输出中响亮可见（不是静默豁免）。
7. **decision log**：每次解析写一条有界决策日志（policyRevision / inputDigest / 逐 floor 来源 reasons），`strength explain` 可回答"这个任务为什么跑这档"。
8. 新动词 `strength list/status/set/explain`。review 四剖面（personal/team/production/regulated）保留为四档在评审轴上的别名，向后兼容。
9. 复杂度纪律：不复制 codex 的逐命令手写投影层与日历级校验；单模块超 600 行触发拆分评审。

## 备选与拒绝理由

- 简化档化（全局 profile + 每 verb 覆盖旋钮）→ 拒绝：无 floor 体系则高强度路径（release、信任边界）无法被机械抬升；无 policyHash 则策略收紧后旧证据仍在背书。
- 沿用现状（属性六档+review 剖面+fast 各自独立）→ 拒绝：用户明确要求"可精细化调整框架强度"，散装旋钮回答不了"现在是什么强度、为什么"。
- OPA/Rego 外部策略引擎 → 拒绝：引入运行时依赖违背引擎零依赖铁律；Rego 学习成本由每个采纳者承担；decision log 思想吸收、工具不引。

## 后果

- 治理强度从"散装旋钮"变成"可计算、可解释、可绑定证据"的一等概念；fast mode 成为 deferralMode=loan 的呈现层（ADR-0009）。
- 四档内置序列的单调性由校验器机械保证，配置错误配置期爆炸。
- strength.json 为自用配置永不进安装面；种子缺失才落地、upgrade 不覆盖（承 ADR-0005 种子语义）。
