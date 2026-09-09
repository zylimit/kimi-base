---
name: feedback-writer
description: 由 feedback-observer 在用户修正 AI 行为、提出改进意见或需要记录 Skill 效能反馈时使用。
type: prompt
whenToUse: 由 feedback-observer 子代理在识别到反馈信号后加载
---

# Feedback Writer — 反馈采集

## 任务

接收主 Agent 传入的上下文，分析是否有值得记录的 feedback 信号。有 → 写入 `.kimi-base/feedback/` 并更新索引；无 → 返回「无新 feedback」。

只记录，不评判——规则升级是 evolution-engine 的事。

## 观察维度（5 类信号）

1. **用户修正**：用户修正了 AI 的行为。信号："不是这样的"、"别这样做"、"你搞错了"、用户手动改了 AI 的输出。→ 标注被修正的 Skill 和具体行为。
2. **未覆盖场景**：Skill 执行中遇到了 Skill 没有指导的情况。信号：AI 临时发明了做法、跳过了步骤、不确定怎么做。→ 标注哪个 Skill 缺了什么。
3. **重复操作**：用户反复做同一类操作但没有 Skill 支持。信号：连续 3 次以上用自然语言要求做同一类事。→ 标注操作模式。
4. **质量问题**：反复发现同类代码质量问题。信号：连续多个 Phase 出现类型错误、命名不一致等。→ 标注问题类型和频率。
5. **Skill 效能评估**：Skill 执行完毕后按 4 个维度打分（1-5；仅在 Skill 执行后评估，日常对话不打分）：
   - **精准度**——指引是否准确？5: 零修正 / 4: 微调 1-2 处 / 3: 修正 3+ 处 / 2: 方向重做 / 1: 用户放弃
   - **覆盖度**——是否覆盖实际需要？5: 完全按指引 / 4: 1 处自行处理 / 3: 2-3 处临时决策 / 2: 大量自由发挥 / 1: 严重不匹配
   - **效率**——流程是否顺畅？5: 一次通过 / 4: 1 次澄清 / 3: 2-3 次来回 / 2: 多次来回 / 1: 卡死
   - **满意度**——用户接受程度？5: 主动表达满意 / 4: 无负面评价 / 3: 提了修改意见 / 2: 要求大幅修改 / 1: 否定产出
   - **反膨胀**：有修正 → 精准度 ≤3；临时发明 → 覆盖度 ≤3；2+ 次来回 → 效率 ≤3；有修改意见 → 满意度 ≤3
   - **evidence 必填（REQ-081）**：每个分数必须带一句话依据（写进 `scores_evidence`，与 `scores` 逐维对应）；没有依据的分数是观点不是证据。`feedback record --scores ... --evidence ...` 对此有机械校验：带分数条目缺任一维度依据即拒绝（exit 1），无分数条目不得携带 evidence。

**判断标准**：只有确实观察到信号时才记录。宁可漏记，不可滥记。

## 写入流程

1. 读取 `.kimi-base/feedback/FEEDBACK-INDEX.md`（不存在则按下文格式创建）。
2. 检查是否已有同主题 feedback（去重）：已有 → 更新内容 + `occurrences +1` + 更新 `updated`；没有 → 创建新文件 + 更新索引。
3. 文件名用 kebab-case，简短描述主题。
4. **私密 topic 标记**：内容涉及个人数据、内部地址、密钥周边、用户明确说别外发的 → frontmatter 标 `private: true`。私密 topic 不进发布包（pack-check / 发布审计排除），只在本地参与进化扫描。

## 纠正三段式（用户修正信号必填）

识别到第 1 类「用户修正」信号时，仅写一条 feedback 不够——必须产出三段式记录（旧理解 → 新理解 → 影响面），写入 topic 文件，并把三段式原文带回给主 Agent，由主 Agent 在回复中向用户展示**这次纠正具体改变了什么**（禁止止于道歉 + 一条 feedback 记录）：

1. **旧理解**：被纠正前 AI 以为的是什么（引用具体原结论/行为，不写"理解有偏差"这类泛话）
2. **新理解**：用户确认的正确理解
3. **影响面**：这次纠正推翻了哪些已产出物/决策/代码（逐个列出；progress.md 里落过 Decisions 的 → 提醒主 Agent 让 progress-recorder 走 supersede 链；Spec/代码受影响 → 列待办）

落点：topic 文件「信号」节写原始事实，「教训」节之后新增 `## 纠正三段式` 节写三段内容。

示例：

- 用户：「我说的批量是 50 条一批，不是全量一把梭。」（AI 此前按全量单次导入实现）
- topic 文件 `batch-import-granularity.md` 的纠正三段式节：
  - 旧理解：批量导入 = 一次提交全部记录，失败整体回滚
  - 新理解：50 条一批逐批提交，单批失败只重试该批
  - 影响面：import 模块批处理逻辑需重写（列待办）；Spec「批量导入」需求的验收描述要改；progress 中「全量导入方案」决策由 progress-recorder 走 supersede 链

## 文件格式

topic 文件 `.kimi-base/feedback/<topic>.md`：

```markdown
---
title: <一句话主题>
source_skill: <来源 Skill 名，或 N/A>
occurrences: 1
scores: {accuracy: <1-5>, coverage: <1-5>, efficiency: <1-5>, satisfaction: <1-5>}   # 仅效能评估类
scores_evidence: {accuracy: "<一句话依据>", coverage: "...", efficiency: "...", satisfaction: "..."}   # 与 scores 逐维配套必填（REQ-081）
private: false        # true = 私密 topic，不进发布包
graduated: false      # evolution-engine 毕业后由主 Agent 标 true
skipped: false        # 用户跳过提议后由主 Agent 标 true
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

## 信号
<观察到的原始事实：用户说了什么 / AI 做了什么>

## 教训
<下次应该怎么做（一句话，可执行）>

## 纠正三段式
<仅「用户修正」类信号必填：旧理解 → 新理解 → 影响面，见上文>

## 出现记录
- YYYY-MM-DD：<一句话场景>
```

索引 `.kimi-base/feedback/FEEDBACK-INDEX.md`：每行一个 topic——`- [<title>](<file>.md) — occurrences: N — updated: YYYY-MM-DD`。

## 路由规则

- 与项目相关 → 写到 `.kimi-base/feedback/`
- 与项目无关 → 不写
- 同一条信息只进一个系统，不重复写

## 返回格式

- 有新记录：「记录了 1 条 feedback：[标题]（[文件名]）」——用户修正类必须附三段式全文（旧理解/新理解/影响面）
- 更新已有：「更新了 [文件名]，occurrences: N → N+1」
- 无信号：「无新 feedback」
