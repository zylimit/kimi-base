# Project: <项目名>

<!--
填写指引：
- 本文件由 progress-recorder 子代理维护（增量合并，不是无脑追加）；区块骨架如下，不可删区块。
- Pinned / Decisions 是受保护区块：仅高置信（含"必须/不能/决定/最终选择"类确定性语言）才写入，
  写入后不可自动修订；冲突记 Notes 并标 Needs-Confirmation。
- Decisions 依据链三字段强制：理由（为什么）/ 被否方案（备选与拒绝理由）/ 适用范围（何时成立、何时重审），
  缺一不写进 Decisions——信息不足先记 Notes 并标 Needs-Confirmation 追问补齐。
- 推翻旧决策必须走 supersede 显式链：新条目写 supersedes: <旧条目日期+主题>；
  被推翻条目不删除，在其末尾补注「已被 <新条目日期+主题> 推翻」。依据链只准延长，不准断链。
- 含弱化词（可能/也许/大概/似乎/建议/考虑）的内容一律进 Notes 并标 Needs-Confirmation。
- Done 条目必须带证据指针（commit / 路径 / 命令 + 退出码 / 链接）；没有证据指针的完成记 Notes。
- TODO #ID 单调递增不复用；语义去重，相似更新原条目。
- Notes + Done 合计 > 100 条触发归档：各保留最近 50 条正文，较早的原文搬进 progress.archive.md
  （只增不删），本文件对应区块头部留一行摘要指针。
- 记结论不记过程：调试来龙去脉不进正文，需要留证据的给指针。
-->

_Last updated: <YYYY-MM-DD>_

## Pinned（仅高置信"必须遵守"写入；受保护不可修订）

- <关键约束 / 接口要求 / 依赖版本 / 目标环境>

## Decisions（按时间顺序追加，历史不可改；三字段强制：理由 / 被否方案 / 适用范围）

- <YYYY-MM-DD>: <决策内容>
  - 理由：<为什么这么做——依据的事实与目标>
  - 被否方案：<考虑过的备选 + 各自拒绝理由>
  - 适用范围：<什么条件下成立 / 出现什么信号应重审>
  - supersedes: <旧条目日期+主题>（仅推翻旧决策时必填；被推翻条目不删，在其末尾补注「已被 <新条目日期+主题> 推翻」）

## TODO（权威待办清单）

- [P0][OPEN][#1] <任务>（Owner：<可选>，Context：<路径/链接>）

## In Progress

- [P0][DOING][#2] <任务>（Owner：<可选>，Context：<路径/链接>）

## Done（最近完成的放前面）

- <YYYY-MM-DD>: [#3] <任务>（evidence：<commit/issue/PR/路径/命令 + 退出码>）

## Risks & Assumptions

- Risk：<风险描述>（Mitigation：<缓解措施>）
- Assumption：<假设>（Confidence：High/Med/Low）

## Notes（简要要点）

- <YYYY-MM-DD>: <简短记录>
- Needs-Confirmation：<待确认事项简述>

## Context Index（轻量索引）

- Archive：./progress.archive.md（若存在）
- Spec：./Product-Spec.md / ./Product-Spec-CHANGELOG.md
- Plan：./DEV-PLAN.md
