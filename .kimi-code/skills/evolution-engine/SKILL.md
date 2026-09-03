---
name: evolution-engine
description: 由 evolution-runner 在 session 初始化、用户要求检查规则升级或扫描进化建议时使用。
type: prompt
whenToUse: 由 evolution-runner 子代理在扫描 feedback 聚类信号时加载
---

# Evolution Engine — 进化引擎

## 任务

扫描 `.kimi-base/feedback/` 中的积累，沿四层进化路径识别信号并生成提议：

1. **记录（L1）**：feedback-writer 已完成的原始积累（本层不动作，只读数据）。
2. **规则毕业（L2）**：某 feedback 重复 **occurrences ≥ 3** → 提议升级为正式规则。
3. **Skill 优化（L3）**：某 Skill 来源的 feedback 评分持续偏低 → 提议调整该 Skill。
4. **Skill 生成（L4）**：某操作模式反复出现（**≥ 5 次**）但无 Skill 覆盖 → 提议经 skill-builder 创建新 Skill。

有信号 → 生成提议返回主 Agent；无信号 → 返回「无进化建议」。

## 扫描流程

**第一步：规则毕业候选**
读取 `.kimi-base/feedback/FEEDBACK-INDEX.md` 定位所有 feedback 文件，读每个文件的 frontmatter，筛选 `occurrences >= 3 且 graduated == false 且 skipped != true`。确定毕业目标：

- `source_skill` 明确 → 毕业到对应 SKILL.md
- 涉及多个 Skill 或全局性 → 毕业到主控规则（AGENTS.md 总体规则 / `.kimi-base/rules/` 对应文件）

**第二步：Skill 优化信号**
按 `source_skill` 分组扫描 scores，触发条件（满足任一）：

- 某 Skill 连续 3 次同一维度 ≤ 2 分
- 某 Skill 某维度最近 5 次平均 ≤ 3 分
- 某 Skill 来源的 feedback occurrences 合计 ≥ 5

**第三步：新 Skill 信号**
筛选 `occurrences >= 5` 且不属于任何已有 Skill 覆盖范围 → 标为「新 Skill 候选」。

**第四步：生成提议**（格式见下）；无信号 →「无进化建议」。

## 提议格式

```text
进化建议（共 N 条）

规则毕业（X 条）
1. [feedback 标题]：出现 [N] 次（来源：[source_skill]）
   建议写入：[目标文件] 的 [目标位置]
   内容摘要：[一句话]
   —— 确认 / 跳过

Skill 优化（X 条）
1. [Skill 名称]：累计 [N] 条相关 feedback / 评分信号 [明细]
   优化建议：[具体建议]
   —— 确认 / 跳过

新 Skill 提议（X 条）
1. [操作模式描述]：出现 [N] 次
   —— 确认创建 / 跳过
```

## 用户确认制（铁律）

- **每条提议必须用户逐条确认**——确认 / 跳过逐条收集，不打包、不默认。
- **绝不自动改规则**：evolution-runner 没有写权限；用户确认后的落笔由主 Agent 执行（文档类编辑）：
  - 规则毕业 → 将教训写入目标 SKILL.md / 规则文件，并把该 feedback 标 `graduated: true`
  - Skill 优化 → 修改对应 SKILL.md
  - 新 Skill → 走 skill-builder 创建
  - 跳过 → 标 `skipped: true`，不再重复提议
- 一次确认只覆盖当次那一条；同类新提议仍须再确认。

## 返回格式

- 有提议：「有 N 条进化建议待处理」+ 完整提议内容
- 无提议：「无进化建议」
