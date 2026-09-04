# ADR-0010：feedback 四层进化引擎化（record/scan/propose，人确认落地）

状态：Accepted · 日期：2026-09-04 · 决策者：用户 + 主 Agent
Enforced-by: unit, manual:P6 落地后由 feedback 行为测试机械执法；毕业落地动作恒需人工确认（提示词纪律外的唯一合法路径）

## 背景

kimi-base 的 feedback 四层进化（经验记录→规则毕业→skill 优化→新 skill）目前全部由 3 个 agent + 2 个 skill 的提示词纪律执行：occurrences 计数靠手工维护 frontmatter、聚类靠 agent 自觉、索引曾残缺到虚报待办（cc-base 台账实证：索引残缺撑出"14 条待处理"虚数一整轮才发现）。这违背本仓"新增能力优先落成可执行检查"的公理，且已被 CAPABILITY-MATRIX 自认为例外。用户拍板 v3.0 将其引擎化。

## 决策

1. 新动词 `feedback record/list/scan/propose`：
   - `record`：机器维护 frontmatter（occurrences/updated），同主题去重靠索引扫描（宁漏不滥）；写入即更新 FEEDBACK-INDEX，索引不再是手工台账。
   - `scan`：聚类信号检测——单条 occurrences≥3、同一失败模式跨文件聚类 3+、无覆盖模式 5+，输出毕业候选清单（只读，不改任何规则）。
   - `propose`：生成结构化毕业提议，目标优先级固定为**可执行 check > fitness 规则 > skill 步骤 > AGENTS.md 散文**（check 不开火零成本，散文每请求都付费）；每条提议含证据指针（来源 feedback id 与 occurrences）。
2. **落地恒需人工确认**：引擎永不自动改规则；被拒提议记 `skipped: true` 不再重复提议。自动毕业是机制红线——规则改动权属于人。
3. `.kimi-base/feedback/` 纳入安装载荷（INDEX 模板 + 一条示例条目）；make-release 打包时私人条目剔除、机制保留（承 cc-base 形态）。
4. 关键词信号注入（detect-feedback-signal 提示词层）保留为记录入口的提示，不参与计数。

## 备选与拒绝理由

- 保持纯提示词纪律 → 拒绝：公理例外已被自证不可靠（索引虚报、计数漂移）；提示词维护不了需要精确计数的状态。
- 自动毕业（occurrences 达标自动改规则）→ 拒绝：教训的样本代表性无法机器判定，自动毕业会把噪声固化成闸；cc/dsh 两家都保持人确认，是有意识的共同选择。
- 向量记忆/embedding 聚类 → 拒绝（承 v2.0 台账）：零依赖铁律下不可实现，且商业记忆层基准数字无复现共识。

## 后果

- 进化机制从"最弱的一环（纯自觉）"变成可审计面：每条毕业提议都能回答"哪来的、出现几次、为什么建议落成这一层"。
- 索引由引擎单一维护，"索引残缺虚报"类事故在机制上消除。
