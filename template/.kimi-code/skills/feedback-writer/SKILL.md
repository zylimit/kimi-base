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

**判断标准**：只有确实观察到信号时才记录。宁可漏记，不可滥记。

## 写入流程

1. 读取 `.kimi-base/feedback/FEEDBACK-INDEX.md`（不存在则按下文格式创建）。
2. 检查是否已有同主题 feedback（去重）：已有 → 更新内容 + `occurrences +1` + 更新 `updated`；没有 → 创建新文件 + 更新索引。
3. 文件名用 kebab-case，简短描述主题。
4. **私密 topic 标记**：内容涉及个人数据、内部地址、密钥周边、用户明确说别外发的 → frontmatter 标 `private: true`。私密 topic 不进发布包（pack-check / 发布审计排除），只在本地参与进化扫描。

## 文件格式

topic 文件 `.kimi-base/feedback/<topic>.md`：

```markdown
---
title: <一句话主题>
source_skill: <来源 Skill 名，或 N/A>
occurrences: 1
scores: {accuracy: <1-5>, coverage: <1-5>, efficiency: <1-5>, satisfaction: <1-5>}   # 仅效能评估类
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

## 出现记录
- YYYY-MM-DD：<一句话场景>
```

索引 `.kimi-base/feedback/FEEDBACK-INDEX.md`：每行一个 topic——`- [<title>](<file>.md) — occurrences: N — updated: YYYY-MM-DD`。

## 路由规则

- 与项目相关 → 写到 `.kimi-base/feedback/`
- 与项目无关 → 不写
- 同一条信息只进一个系统，不重复写

## 返回格式

- 有新记录：「记录了 1 条 feedback：[标题]（[文件名]）」
- 更新已有：「更新了 [文件名]，occurrences: N → N+1」
- 无信号：「无新 feedback」
