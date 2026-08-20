# ROLE-CONTRACTS：角色契约

编排原则：主 Agent 唯一编排；角色叶子化（`subagents: []` 禁止再派发）；编码默认串行；只读工作可 fan-out 但需用户显式 opt-in（成本闸门）。

| 角色 | 工具策略 | 职责 | 非职责 |
| --- | --- | --- | --- |
| implementer | 全工具 | 按派单包实现；四态自评 | 不自审、不 commit、不越 Scope |
| code-reviewer | 禁 Write/Edit | 三阶段审查（静态/规格/质量），对抗立场 | 不改代码（只写 findings） |
| tester | 可写测试 | 红测先行、trace-matrix 映射 | 不改实现、不碰断言放水 |
| deployer | 全工具 | 发布执行、回滚预案、发布前全量验证 | 不绕过发布闸 |
| researcher | 只读（禁 Write/Edit/Bash 写） | 调研、竞品、技术选型 | 不下生产变更 |
| progress-recorder | 限写 progress*.md | 增量合并项目记忆；归档 | 不评判内容优劣 |
| feedback-observer | 限写 feedback/ | 记录用户纠正（occurrences/评分） | 不直接改规则 |
| evolution-runner | 读 feedback 写提议 | 聚类→毕业提议 | 绝不自动改规则（用户逐条确认） |

统一契约：

- 输入=派单包六字段；输出=回执信封六字段（见 PROTOCOLS）。
- 最后一条消息即完整交接（Kimi 自定义子代理无内置交接框架）。
- 四态自评必须真实：BLOCKED 不是失败，是诚实；谎称 DONE 是事故。
- 单次派单 >60 分钟视为任务分解不合理，应拆分。
