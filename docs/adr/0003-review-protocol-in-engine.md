# ADR-0003：结构化对抗评审引擎化（review 协议入引擎）

状态：Accepted · 日期：2026-09-02 · 决策者：用户 + 主 Agent
Enforced-by: manual:完成门接线（catalog.review 段 + requireStructured≠false + risk=high → 需 fresh 终审 ACCEPT 回执）, manual:行为测试锁定（tests/review.test.mjs）

## 背景

v1 的红蓝评审是纯提示词纪律（脚本 + 流程文档）：分歧靠 reviewer 自觉记录，裁决靠人读完整串发言再下结论，评审历史随会话结束蒸发。这违反本仓自己的公理——"能机器化的一律下沉为可执行检查"。评审结论不能成为质量证据，除非它是结构化、可裁决、可绑定指纹的。

## 决策

评审协议成为引擎动词 `review pack/start[--base]/blue/lens [--ad-hoc]/verdict/status/team/backlog`（lib/review.mjs）：

1. **结构化分歧**：Blue 先自证（claims），各 lens 报到结构化 findings（severity/location/evidence），分歧是数据不是散文。
2. 九个 lens、三个阶段、四个团队剖面；team 按受影响模块声明的属性收缩选拔——审什么由模块风险画像决定，不由 reviewer 的心情决定。
3. **计算裁决**：verdict 由引擎按规则计算（error 级 finding 压过一切）；超过 maxRounds 未收敛即 escalate，不无限扯皮。
4. **回执只在终审 ACCEPT 写入账本**：中间态 ACCEPT 不写证据，消费者（完成门/release）只认账本回执。
5. backlog 持久化在 `state/review-backlog.json`，重开评审不冲掉既有欠账；过期条目在 release 判定中属阻断项。
6. `--base` range 模式支持提交后评审（回执绑定 range.head，HEAD 未移动即 fresh）；`--ad-hoc` 给非召集 lens 额外证据通道；location 正则兼容 Windows 路径。
7. red-blue-review skill 重写为该协议的编排层，不再自带评审逻辑。

## 备选与拒绝理由

- 纯提示词评审（skill 内嵌流程文本）→ 拒绝：不可判定、无回执、无持久 backlog——正是 v1 被废的形态。
- 共识投票 / 多数决裁决 → 拒绝：多数决掩盖"少数派 lens 拿着决定性证据"的情形；结构化分歧的价值恰在把反对意见留成数据，裁决按严重级规则计算而非按人头。
- 每轮评审都写回执 → 拒绝：中间态不是质量结论；证据语义必须唯一（终审 ACCEPT）。

## 后果

- 高风险任务（requireStructured + risk=high）的完成门需要 fresh 终审 ACCEPT 回执——评审从"建议"变为可门禁的证据。
- 评审成本显性化：lens 选拔、阶段推进、轮次上限都在 catalog `review` 段可配、可审计。
