# Product Spec 变更日志

## v3.0.0（2026-09-04）v3.0 立项：强度可计算的治理 + 需求生命周期标记

### 为什么改

对 dsh-base / cc-base / codex-base 三仓逐行级对标与业界调研（OpenAI harness engineering、Anthropic long-running agents、Fowler harness 框架、ETH AGENTS.md 实证、Tessl position paper）后，用户拍板 v3.0 三个方向：规划+逐 Phase 推进、强度策略引擎档化模型、feedback 进化引擎化。规格先行要求一次立全 v3 需求，但 trace 100% 覆盖门禁使"未实现的需求"无法立项——为此先落地 REQ-067 生命周期标记（planned 不计入覆盖率分母但仍受可判定性 lint），再以 planned 形态立全 REQ-051~068。

### 变更

- 新增第 5 节小节「v3.0 强度可计算的治理」：REQ-051/052 强度策略引擎与动词族（ADR-0008）/ REQ-053 Receipt v2 绑定面 / REQ-054 fast 证据贷款账本 / REQ-055 可提交证据模式（ADR-0009）/ REQ-056 CLI 契约注册表（ADR-0011）/ REQ-057 评审独立性接线 / REQ-058 feedback 引擎化（ADR-0010）/ REQ-059 宪法瘦身与执法率门禁 / REQ-060 修复指令体 / REQ-061 quarantine 原语 / REQ-062 三层反馈分级 / REQ-063 渐进采用阶梯 / REQ-064 棘轮 best-ever 持久化 / REQ-065 安装器锁与 marker / REQ-066 自我 eval 套件 / REQ-068 discover 真实仓健壮性（P0 真实仓校准发现的缺陷立项）。全部 `状态：planned(P<n>)`。
- 新增 REQ-067 需求生命周期标记（本条为 active，P1 落地，验收 tests/spec.test.mjs「需求生命周期标记 planned」用例组）。
- NFR-002 性能预算更新真实仓锚点（38.7 万行/2196 文件/222 模块实测：lint 257ms、impact 181ms、arch scan 1644ms、gate 843ms），外推边界改按"文件数×模块数"表述。
- 版本号 v2.0.2 → v3.0.0。

## v2.0.2（2026-09-04）REQ-009 阈值与引擎契约对齐

### 为什么改

v3.0 重构 P0 基线盘点发现 REQ-009 声称 "description ≤180 字符"，但引擎 `skills-lint` 实际契约是 >500 error / >220 warning——规格文本声称了执法并不存在的阈值（规格过声称）。按"被测图与文档不一致时修文档"原则对齐到被执法的契约，≤180 保留为撰写指引。

### 变更

- REQ-009 阈值表述改为 "≤500 字符硬顶（>220 字符触发警告，撰写指引 ≤180）"，验收行不变（`skills-lint` 与 doctor exit 0 本就测的是引擎契约）。
- 版本号 v2.0.1 → v2.0.2（文档级订正，无行为变更）。

## v2.0.1（2026-09-02）P5/P6 需求追溯补立

### 为什么改

P5（三面执法）与 P6（规模化与治理深化）的引擎能力已落地并有行为测试，但 Product-Spec 没有对应 REQ——trace 的覆盖率只能证明"已声明的有人验"，证明不了"已建的有人声明"。本变更只补立需求条目并接线既有测试，无语义扩张、无引擎行为变化。

### 变更

- 新增第 5 节小节「三面执法与规模化治理（v2.0 P5/P6）」：REQ-036 git hooks 电池（install --hooks）/ REQ-037 审计脚本独立 / REQ-038 dod 静态电池 / REQ-039 catalog discover / REQ-040 cochange / REQ-041 budget / REQ-042 fleet / REQ-043 privacy 保护底线 / REQ-044 release 发布就绪判定。
- 每条验收行指向既有测试组（tests/audit.test.mjs、tests/scale.test.mjs），两文件头部加追溯锚点注释完成 trace 接线。
- 版本号 v2.0.0 → v2.0.1（文档级补立，无行为变更）。

## v2.0.0（2026-09-02）需求可判定化 + v2.0 新能力条目

### 为什么改

P4 落地 `spec lint`/`trace` 引擎动词后对本文档 dogfood：初版需求全部缺规范关键词与验收证据（NOT_NORMATIVE/NO_ACCEPTANCE），需求移动没有机器可判的完成定义。按"修规格文本，不削弱 lint 规则"原则逐条改写。

### 变更

- 全部 REQ-001~030 / NFR-001~006 改写为可判定形式：规范关键词（必须/不得/应当）+ 触发条件（当/若，EARS）+ 每条附「验收」行（指向真实测试组或门禁命令）。语义无扩大，仅把隐含约束写明。
- 第 4 节复制面从 `template/` 旧布局订正为 v2.0 源布局=安装布局（P1 决策的规格追认）。
- 新增 REQ-031 结构化对抗评审 / REQ-032 记忆法动词（recap/invariants/archive/sync-check）/ REQ-033 spec lint+trace+spec view / REQ-034 rules-audit / REQ-035 skills-lint+agents-lint。三面执法（three-surface）/fleet/discover 属后续 Phase，本轮不立项。
- 第 6 节开头显式列出五性治理属性集（resilience/security/safety/privacy/reliability），使治理属性在需求语料中有着落（spec lint ATTRIBUTE_UNADDRESSED）。
- 第 8 节成功标准第 4 条纳入 spec lint/trace 自检。

## v1.0.0（2026-08-13）初版

### 定位

家族第七个 harness 脚手架：面向 Kimi Code CLI 的融合版。供体：codex-base / cc-base / ccb-base / pi-base / cursor-base / opencode-base，外加 digifiber-conflation 七克隆实战教训。

### 吸收（取舍依据摘要，全量台账见 docs/CROSS-POLLINATION.md）

- 自 codex-base：证据新鲜度绑定链、validate≠质量 语义分层、债务棘轮、ADR 幽灵引用检测、死闸审计、Stop 连拦保险丝、吸收/拒绝双台账、安装事务用户定制保护、属性治理"反证优先+随 impact 收缩"。
- 自 cc-base/ccb-base：diff-bound 审查回执、三文件同步机器执法、MANIFEST 分层升级、反馈进化四层引擎、主控下沉指针模式、fail-closed 家族、"闸靠数据留"、验收五步闸、派单包/回执信封契约。
- 自 pi-base：运行时强制优先于提示词（在 Kimi 侧映射为 frontmatter `tools`/`disallowedTools`/`subagents: []` + hooks）、waiver 五要素、none/minimal 档必须书面理由、对供体缺陷的修正方法论。
- 自 cursor-base：四态验证+缺失工具=BLOCKED、哈希链账本断链 fail-closed、任务写所有权哈希基线、语义化 shell 分类器（wrapper 穿透/凭据跨管道追踪）、preCompact 状态落盘、编译产物字节级 parity 思路（转化为 manifest 漂移检查）。
- 自 opencode-base：CROSS-POLLINATION 融合方法论、能力矩阵四象限（保留/不保留/不可妥协/升级方向）、隔离档案诚实声明、注入式安装不碰项目根 AGENTS.md 的边界纪律（kimi-base 改为：AGENTS.md 由安装器生成且纳入 manifest 分层，用户定制走旁路）。
- 自 digifiber 实战：文档必须绑定机器可执行版本并声明"以实测为准回改"、脚手架入库边界定死（state/ 必 gitignore）、部署权唯一裁决、上下文墙按必然撞墙设计、披露式诚实需配棘轮消债。

### 拒绝

- ccb-base 的 CCB daemon/tmux 多进程编排（重型母体专属，违背"不写第二套 runtime"）。
- 多模型异构交叉审查（Kimi 单宿主内以红蓝对抗+多视角 lens 补偿，记录为已知弱化）。
- 自动 push / 自动部署类自动化（远端副作用一律人工确认）。
- 项目根 `.kimi-code/config.toml` 式项目级配置（Kimi 无此机制；项目差异一律落 `.kimi-base/harness.json`）。
- hook 内执行长任务（Kimi hook timeout 上限 600s 但设计为轻量拦截；重检查走 gate 命令而非 hook 内联）。

### Kimi 原生能力适配差异（相对供体）

- hooks 无项目级配置 → 以**插件 hooks + 项目标记惰性激活**替代（REQ-007）。
- Stop 可阻断（exit 2）→ 完成门可机械执法，优于 opencode（session.idle 不可拦）；弱于 cursor failClosed（Kimi hooks 整体 fail-open，写入诚实边界）。
- 无 slash commands 项目级目录 → 插件 commands 命名空间 `/kimi-base:*`。
- custom agents 无 per-agent 权限模型 → 以 `tools`/`disallowedTools` 工具白名单 + `subagents: []` 防递归替代。
- Plan 模式 / Goal 模式 / Swarm / Cron 为宿主原生 → 工作流 skill 直接复用，不重造。
