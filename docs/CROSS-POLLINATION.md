# CROSS-POLLINATION：七仓融合台账

方法论（承袭 pi-base/opencode-base 的审计纪律）：**以实际文件为准而非 README 宣传**；每条记录"吸收什么/拒绝什么/为什么/如何适配"；新供体发版或自身改核心流程时复查。

## 供体角色

| 供体 | 角色 | 定位 |
| --- | --- | --- |
| ccb-base | 重型母体 | CCB daemon + tmux 多模型编队（claude×codex），Linux 专用，实证稳跑 15 天 |
| cc-base | 纯 Claude Code 派生 | hooks 双平台双写、harness.mjs 3033 行、feedback 31 条 |
| codex-base | Codex CLI 派生（v3） | 模块化 runtime（19 模块）、证据链最完整、审计过姊妹仓 |
| pi-base | Pi 派生 | 运行时强制最彻底（depth guard/writer gate）、waiver 五要素 |
| cursor-base | Cursor 派生 | 语义化 shell 分类器、哈希链账本、唯一带 CI、ADR 制度 |
| opencode-base | OpenCode 派生 | 插件桥接 hooks、融合方法论文档最成熟 |
| dsh-base | dash 派生（v2.0 对标仓） | 单目录自托管布局、三面执法、评审/记忆/spec 引擎化；逐行精读过，缺陷见专项台账 |
| digifiber-conflation ×7 | 实战场 | 同一 15 万行产品 × 7 种 harness 的真实 dogfood |

## 吸收清单（机制 → 来源 → kimi-base 落点）

| 机制 | 主来源 | kimi-base 落点 |
| --- | --- | --- |
| 证据新鲜度绑定（receipt 绑 task+fingerprint+argvHash+证据哈希） | codex-base | runtime gate/receipt（REQ-012/013） |
| "validate ≠ 质量"语义分层（结构校验永不写 PASS） | codex-base 审计发现 | doctor 只证结构；质量只有 gate 出 |
| 债务棘轮（baseline 固化存量、新债零容忍、stale 催删） | codex/cc/pi/cursor 四家趋同 | arch baseline/trend（REQ-016） |
| ADR 幽灵引用检测（Enforced-by 必须真实存在） | cursor/codex | adr check（REQ-015） |
| 死闸审计（闸靠数据留） | codex/ccb | gate-log + gate-audit（REQ-024） |
| Stop 连拦 3 次保险丝 | codex/opencode | hook stop（REQ-022） |
| 安装事务（staging/备份/逆序 rollback/定制旁路） | codex/pi/cc | install/upgrade（REQ-002/003） |
| 三文件同步机器执法 | cc-base | hook stop 复合判定（REQ-029） |
| 反馈进化四层引擎（用户确认制） | cc/ccb/opencode | feedback/ + evolution-runner（REQ-030） |
| 主控下沉指针模式（命中必须完整读取） | cc/opencode | AGENTS.md + rules/ |
| fail-closed/绝不假绿家族 | pi/cc/cursor | gate 四态（REQ-013） |
| 运行时强制 > 提示词自觉 | pi-base | 映射为 frontmatter tools/subagents + hooks（REQ-008） |
| waiver 五要素 + security 永不豁免 | pi/cursor | quality waiver（REQ-018） |
| none/minimal 档必须书面理由 | pi/cursor | catalog lint UNJUSTIFIED_TIER |
| 语义化 shell 分类器（wrapper 穿透/凭据跨管道） | cursor-base | hook pre-tool-use-bash（REQ-024） |
| 哈希链账本断链 fail-closed | cursor-base | receipt verify（REQ-023） |
| preCompact 状态落盘 | cursor-base | hook pre-compact（REQ-006） |
| 属性覆盖"反证压过佐证、随 impact 收缩" | codex/cursor | quality status（REQ-017） |
| 隔离档案诚实声明 | opencode-base | docs/ISOLATION-PROFILES.md |
| 能力矩阵四象限（保留/不保留/不可妥协/升级方向） | opencode-base | docs/CAPABILITY-MATRIX.md |
| supervisor 开发态守护（退避/探针/熔断/只杀自己拉的） | pi/opencode/cc | runtime/supervisor.mjs（REQ-025） |
| skill description lint（禁流程摘要词） | codex/pi/cc | doctor frontmatter 校验 |
| 防黑屏发行级 workaround 精神（踩坑→根因→固化） | opencode-base | 发行纪律本身 |
| 写测独立 / red-locks-the-bug / 验收五步闸 / 派单包六字段 / 回执信封六字段 | 家族共识 | skills + agents 正文契约 |

## 拒绝清单（含理由）

| 拒绝项 | 来源 | 理由 |
| --- | --- | --- |
| CCB daemon/tmux 多进程编排 | ccb-base | 违背"不写第二套 runtime"；Kimi 子代理已覆盖委派诉求 |
| 多模型异构交叉审查 | ccb-base | Kimi 单宿主无第二模型审查面；以红蓝对抗+多视角 lens+写测独立补偿，记为已知弱化 |
| hooks .sh/.ps1 双平台双写 | cc/opencode | Kimi hook 直接调 node 单文件，天然跨平台，消灭双写维护税 |
| 自动 push/自动部署自动化 | 多家曾考虑 | 远端副作用一律人工确认（审批三档 HIGH） |
| 项目级 config 注入（~/.kimi-code/config.toml 改写） | — | Kimi 配置为用户级；项目差异只落 .kimi-base/harness.json |
| hook 内联跑重检查（全量测试进 Stop hook） | — | hook 须轻量（默认 30s 上限）；重检查走 gate 命令由 agent 显式执行 |
| 八属性全集默认强制 | cursor/pi | 默认五属性（用户指定），扩展属性可选声明；降认知负担 |
| 单文件 3033-5860 行的段落分区风格 | cc/cursor | 保留单文件但要求分区注释+自测锚点；超过可维护性即拆 lib/（留作演进口） |

## 适配差异表（供体机制 → Kimi 现实）

| 供体假设 | Kimi 现实 | 适配 |
| --- | --- | --- |
| hooks 项目级注册（.claude/settings.json、opencode.json…） | hooks 只在用户 config.toml 或插件 manifest | 插件 hooks + `.kimi-base/harness.json` 标记惰性激活 |
| Stop 可 block（Claude/codex）或不可 block（opencode idle） | Kimi Stop 可 block（exit 2 + stderr 回注） | 完成门机械执法可用；保险丝防锁死 |
| hooks failClosed 可配（cursor） | Kimi hooks 一律 fail-open | 诚实声明 + permission rules 兜底 |
| per-agent 权限对象（opencode edit:deny…） | Kimi frontmatter 工具白名单 | tools/disallowedTools/subagents:[] |
| subagent depth guard 环境变量（pi） | Kimi 无嵌套派发深度配置 | `subagents: []` 空名单 = 禁止再派发 |
|  slash commands 项目目录（opencode command） | 插件 commands 命名空间 | /kimi-base:* 八命令 |
| 宿主计划模式自研（pi plan-mode 扩展） | Plan 模式原生 | 直接复用；签字闸写进 workflow 规则 |
| compaction 定制（pi compaction.ts） | PreCompact hook + /compact 提示 | compaction-note.json + recap 铁律 |

## dsh-base 专项台账（v2.0 逐行精读）

dsh-base 是 v2.0 的对标仓：逐行精读其引擎与载荷后按"吸收 / 缺陷不搬 / 行业实践拒绝"三类留痕。kimi 实现逐条经代码核对，非 README 转述。

### 吸收（dsh 机制 → kimi 落点）

| dsh 机制 | kimi-base 落点 |
| --- | --- |
| 单目录布局（源布局=安装布局、自托管） | template/ 消亡，载荷即 `.kimi-base/`+`.kimi-code/`（ADR-0005，P1） |
| 引擎模块化拆分 | 4712 行单文件 → 薄入口 + `lib/` 31 模块显式无环 import（P1） |
| 五档退出码（0/1/2/3/4，stale 独立） | 退出码契约 v2 + 全动词严格 flag 校验（ADR-0006，P2） |
| 逐指标历史最优棘轮 | `arch trend` 对比 BEST-EVER，debt-swap 净零回弹必拦（修掉 cc-base 继承的 debt-swap 洞，P2） |
| 结构化对抗评审协议 | `review pack/start/blue/lens/verdict/status/team/backlog` 引擎化（ADR-0003，P3） |
| 记忆法动词 | `recap / invariants / archive / sync-check`（P4） |
| spec 可判定性 lint + 追溯门 | `spec lint / trace / spec view`（P4；自用 50 REQ 100% 追溯） |
| 宪法执法率审计 / 资产 lint | `rules-audit` / `skills-lint` / `agents-lint`（P4） |
| catalog 从仓库事实推导 | `catalog discover`（`init-modules` 退为废弃别名；分层方向按 kimi 规则翻转，P6） |
| git 历史共变耦合 | `cochange`（P6） |
| 仓群契约治理 | `fleet lint/impact/status/recap` 全量移植（ADR-0007，P6） |
| 三面执法（git hooks + CI 面） | `.kimi-base/githooks/` + `.kimi-base/audit/` + CI 电池 + `dod`/`release` composite（ADR-0002，P5） |
| 审计者与被审计者独立 | audit 脚本禁 import 引擎，catalog 禁边 + 静态测试双重执法（P5） |
| 注入指令扫描 | `scan-instructions`（8 类注入规则，P5） |

### 刻意不搬（dsh 缺陷，逐行精读时发现）

| dsh 缺陷 | kimi 对策（实现已核对） |
| --- | --- |
| DIFF_EXCLUDED 按 diff 文本排除路径：被排除的 tracked 文件改动不进证据哈希，旧回执可背书新代码（自我陈旧化） | kimi 不解析 diff 文本：`gitFingerprint` = baseCommit + **每个变更文件的内容摘要**逐文件拼接（lib/git.mjs），任何字节变化都移动指纹 |
| 评审 backlog 存在会话文件内，重开评审即被冲掉 | backlog 独立持久 `state/review-backlog.json`（lib/paths.mjs 常量分离），过期条目进 release 阻断项 |
| 非终审 ACCEPT 也 exit 0 且 final:false 分支实为死代码 | 裁决前沿模型（frontier）使非终审 ACCEPT 可达；**回执只在终审 ACCEPT 写账本**（lib/review.mjs `verdict==='ACCEPT' && final`），消费者只认回执 |
| waiver 保护仅靠单词正则 | kimi 继承并扩展禁词面（privacy/PII/隐私/个人信，覆盖 reason/compensation 文本）——**仍是启发式**：这是分类器不是自然语言理解，绕过可能的措辞不存在保证，诚实写入 README 诚实边界 |
| dod 与 release 各自硬编码检查清单，两份拷贝必漂移 | DOD_STEPS 单源（lib/hygiene.mjs），release 直接 import 复用，代码注释禁止第二份拷贝 |
| trend 基线"记录到全绿为止"（record-to-green） | kimi 棘轮对比逐指标**历史最优**：任何指标回弹即新债，不存在"等到绿了再记录"的洗白路径 |

### 拒绝的行业实践（v2.0 评估留痕，每条一句理由）

| 实践 | 拒绝理由 |
| --- | --- |
| spec-as-source（规格直接生成代码/测试） | 规格是契约不是实现；生成层把规格错误放大成系统性错误 |
| 向量记忆（embedding 检索代替结构化记忆） | 不可审计、不可归档、不可 diff；progress.md 三文件+派生 recap 已覆盖恢复诉求 |
| 多模型异构交叉审查 | Kimi 单宿主无第二模型审查面；结构化分歧+计算裁决+写测独立补偿（与 2026-08-13 决策一致） |
| hooks 自动 push/自动部署 | 远端副作用一律人工确认；release 永不打 tag/push/建分支 |
| hooks sh/ps1 双平台双写 | 引擎统一 node 入口，githooks 纯 POSIX sh（Windows 走 Git Bash）；双写维护税不值得 |
| 共识投票式评审 | 多数决掩盖少数派决定性证据；裁决按严重级规则计算（ADR-0003） |

## digifiber 实战教训（七克隆证据 → 固化机制）

1. 三文件同步+阈值归档是长跑记忆骨干（431 条归档、正文稳定 ~100 条）→ REQ-028/029。
2. 架构文档必须绑定机器可执行版并声明"以实测为准回改"（7 个项目纯文字架构文档无一幸免地陈旧）→ arch-designer skill 铁律。
3. 闸门记账（判过几次/拦过什么），长期全绿即砍 → gate-log + gate-audit。
4. 脚手架入库边界事先定死（曾发生"装入→用户下令清掉"反复）→ state/ 必 gitignore + pack-check。
5. 多会话共享运行栈时部署权必须唯一裁决（两次覆盖事故）→ deployer 角色唯一性 + workflow 规则。
6. 披露式诚实不消债（32 条 baseline fail 长期悬挂）→ 棘轮机制 REQ-016。
7. 上下文墙按必然撞墙设计（实测后端墙 124.5K tokens）→ 预算纪律+预落盘+recap。
8. hook 能力按宿主实测降级并诚实标注失效面 → 本文档适配差异表 + ISOLATION-PROFILES。

## 复查触发器

- Kimi Code 文档 hooks/agents/skills/plugins 章节变更（新能力或语义变化）→ 复核 CAPABILITY-MATRIX。
- 家族供体发新版 → 按"立即采纳/适配后再用/拒绝/仅母体用"四分类评估。
- 自身核心流程变更（gate/task/hook 协议）→ 回查本台账是否仍成立。
