# kimi-base DEV PLAN

交付策略：单仓三层（插件面 / 项目模板面 / 治理引擎），引擎先行、资产并行、测试收尾；每一步可独立验收。

技术栈：Node ≥18（零依赖 ESM，单文件引擎）+ Bash/PowerShell 安装包装 + Markdown 资产。选择原因：宿主 Kimi Code  hooks 以本地命令执行，Node 单文件零安装成本；Markdown 是 Kimi agents/skills 的原生载体。

## Phase 依赖

```
P1 调研审计 ──► P2 架构定型 ──► P3 runtime 引擎 ─┐
                          ├──► P4 模板资产 ──────┼──► P6 集成验证 ──► P7 发布收尾
                          └──► P5 测试与插件胶水 ┘
```

## P1 调研审计 ✅

- P1-T1 六仓深读（codex/cc/ccb/pi/cursor/opencode）产出吸收清单。Verification: 六份结构化报告。✅
- P1-T2 digifiber-conflation 七克隆实战巡视，产出落地教训 8 条。✅
- P1-T3 Kimi Code 官方文档全量核对（skills/hooks/agents/plugins/mcp/config/goals/sessions/slash-commands/tools）。Verification: 能力映射有据可查。✅

## P2 架构定型 ✅

- P2-T1 双层架构（插件面+项目面）与标记惰性激活模式。Expected: kimi.plugin.json hooks 声明与 `.kimi-base/harness.json` 标记协议。
- P2-T2 CLI 动词契约冻结（25 动词）+ 状态目录布局（.kimi-base/state/）。Expected: 三份并行开发输入一致。
- P2-T3 五性治理模型定型（五属性六档、保护属性、覆盖判定三铁则）。

## P3 runtime 引擎（runtime/kimi-base.mjs + supervisor） ✅

- P3-T1 基础设施：JSON IO/原子写/跨进程锁/LF-SHA256/git 封装/glob 缓存/路径防逃逸。
- P3-T2 治理核心：task 账本、fingerprint、gate 四态+receipt、quality 覆盖判定+waiver。
- P3-T3 架构防腐：catalog lint、arch check+baseline+trend、adr check、fitness 五规则。
- P3-T4 大仓与运维：impact、context pack、risk scan、retention、gate-audit、fast。
- P3-T5 hooks 调度器七事件 + 安装事务（install/upgrade/uninstall/manifest/doctor/pack-check）。
- P3-T6 supervisor.mjs 与跨平台包装脚本。
- Verification: `node runtime/kimi-base.mjs selftest` 通过；临时夹具仓 install→task→gate→arch→quality 全链路冒烟。

## P4 模板资产（template/） ✅

- P4-T1 `.kimi-code/agents/` 8 角色（Kimi frontmatter：tools/disallowedTools/subagents:[]）。
- P4-T2 `.kimi-code/skills/` 16 工作流（name==目录、description≤180 非流程摘要）。
- P4-T3 `.kimi-base/rules/` 3 下沉细则 + `templates/` 9 模板。
- P4-T4 `AGENTS.md` 宪法 + harness.json/module-catalog/verification-matrix/adapters 配置。
- Verification: doctor frontmatter 校验零 error。

## P5 测试与插件胶水（tests/ + plugin/） ✅

- P5-T1 tests/harness.test.mjs：16 组用例（安装事务/回执/四态门/waiver/覆盖判定/架构三件套/fitness/hooks/fast/context/doctor/插件资产自检）。
- P5-T2 plugin/skills/kimi-base（sessionStart 路由，非标记项目自静默）。
- P5-T3 plugin/commands/ 8 个斜杠命令。
- Verification: `node --test tests/` 全绿（环境缺 git 时明示 skip 不假绿）。

## P6 集成验证 ✅

- P6-T1 全量测试 + selftest + doctor + manifest:check + pack:check。
- P6-T2 端到端演练：临时目录 install → 模拟开发（改码→gate→receipt→complete）→ Stop 门阻断/放行。
- P6-T3 60 万行合成仓性能钉板（impact/catalog lint 计时）。
- Verification: 上述命令全部 exit 0，证据写入 progress.md。

## P7 发布收尾 ✅

- P7-T1 README/OPERATIONS 与实现一致性复核（文档与代码漂移回改）。
- P7-T2 make-release.sh 打包 + 泄漏扫描。
- P7-T3 progress.md 归档收尾，写下验证证据句柄。

## v2.0 重构 Phase 表（对标并超越 dsh-base；全部完成，证据见 progress.md Done）

```
P1 源布局=安装布局自托管 ──► P2 契约硬化 ──► P3 评审引擎化 ──► P4 记忆/需求治理
                                                              │
P7c 文档与发版 ◄── P7b dogfood 双修 ◄── P7a 测试补盲+dogfood ◄┴── P5 三面执法 ──► P6 规模化治理深化
```

| Phase | 内容 | 完成证据 |
| --- | --- | --- |
| P1 ✅ | template/ 消亡；载荷=`.kimi-base/`+`.kimi-code/`；引擎拆薄入口+lib/；安装器恒等映射+种子语义 | selftest 15/15、测试 38/38、catalog/manifest/doctor/pack-check/arch 全 exit 0 |
| P2 ✅ | 退出码契约 v2；严格 flag 校验；best-ever 棘轮；runtime 证据时间窗；账本轮转 anchor；继承缺陷清算 | selftest 16/16、测试 53/53、六闸全 exit 0 |
| P3 ✅ | review 协议引擎化（九 lens/三阶段/四剖面/计算裁决/终审回执/持久 backlog）；red-blue-review skill 重写为编排层 | 测试 80/80、七闸全 exit 0 |
| P4 ✅ | recap/invariants/archive/sync-check；spec lint/trace/spec view；rules-audit/skills-lint/agents-lint；Spec 41 条可判定化 | 测试 115/115、trace 100%、spec lint 0 error |
| P5 ✅ | 三面执法：githooks 三钩子 + audit 五独立脚本 + dod 电池 + install --hooks + CI 电池 | 测试 144/144、模拟 CI 序列全绿 |
| P6 ✅ | catalog discover/cochange/budget/fleet 全移植；privacy 入保护底线；release composite | 测试 166/166、spec lint 41 条、trace 100% |
| P7a ✅ | 测试补盲 gaps 16 例；REQ-036~044 补立；端到端 dogfood；性能冒烟（合成仓 4954 文件/151 模块） | 测试 182/182、trace 100% 50/50 |
| P7b ✅ | dogfood 缺陷双修：fast 借账不能关闭 task；stale≠完整性失败（dod STALE 态/release 完整性≠新鲜度） | 测试 188/188、dogfood 全程翻绿 release READY |
| P7c ✅ | 文档与发版：ADR-0002~0007、README/ARCHITECTURE/CAPABILITY-MATRIX/CROSS-POLLINATION 刷新、CHANGELOG.md、版本 2.0.0 | adr check 7 活跃 0 幽灵；全量闸见 progress.md P7c 条目 |

## v3.0 重构 Phase 表（强度可计算的治理；依据 ADR-0008~0011，REQ-051~068）

```
P0 基线消化 ──► P1 规格与计划 ──► P2 CLI 契约+discover 健壮性 ──► P3 强度策略引擎 ──► P4 Receipt v2+贷款账本
                                                                                        │
P10 eval+总收尾 ◄── P9 CI/发布面 ◄── P8 反馈分层+采用阶梯+安装器 ◄── P7 宪法瘦身+修复指令体 ◄── P6 feedback 引擎化 ◄── P5 评审强化
```

| Phase | 内容（REQ 激活集） | 完成证据 |
| --- | --- | --- |
| P0 ✅ | TODO #7 真实仓性能校准（38.7 万行/222 模块，发现 discover 三缺陷立项 REQ-068）/ #9 插件 TUI 实装 E2E 全 PASS（F1/F2 限制如实记录）/ #10 执法率 16.7%→50% 且 maxUnenforced=0 转门禁（红锁验证）/ 文档漂移三修 | progress.md 2026-09-04 P0 条目；rules-audit 阈值 0 exit 0；校准表入 LARGE-REPO-GUIDE §5 |
| P1 ✅ | Product-Spec v3.0.0（REQ-051~068 立项）+ CHANGELOG + ADR-0008~0011 + REQ-067 planned 标记引擎落地（红测先行 7 用例）+ 本表 | spec lint 0 error、trace 100%（51 active，planned 17 单列）、tests 27/27、adr check 0 幽灵 |
| P2 ✅ | CLI 契约注册表（REQ-056）+ discover 真实仓健壮性（REQ-068：SCC 环处理/重复模块/tier 重算/fitness 去重） | cli-contracts 16/16 + discover 12/12 全绿；selftest 20/20（contractCheck+specifier 仲裁自证）；run-tests 225/225；真实仓 discover→lint(0 overlap)→arch(零新债) 走通；结构化评审 4 轮 6 error 全部修复（变异核查证真闸），verdict ACCEPT 回执 rcpt-20260905074521 |
| P3 | 强度策略引擎（REQ-051/052）：strength.json schema、resolver（extends 只收紧/floor 只升不降/shadow/decision log）、strength 动词族、policyHash | strength 测试组全绿 + 摘 planned 标记 |
| P4 ✅ | Receipt v2 绑定面（REQ-053）+ fast 贷款账本（REQ-054）+ 可提交证据模式（REQ-055） | receipt-v2 26/26；run-tests 285/285；评审五轮 10 error 全修复；verdict ACCEPT rcpt-20260907183718 |
| P11（插队，用户 2026-09-08 指令） | 沟通桥梁层（REQ-069~075，ADR-0012，设计 docs/COMMUNICATION-LAYER.md）：认知标注四态+spec lint 检查 / 业务含义过链（派单第七字段+回流通道）/ 交互深度四档 / psb 方法层重写 / 记忆依据链+纠正三段式 / 阶段专业化 / skill 工艺与去重 | 各 REQ 验收行；真实情境前后对比检验 |
| P5 | 评审强化（REQ-057）：authorship 账本接线、静态发现入 review-pack、review 消费策略轴 | review 测试组全绿 |
| P6 | feedback 引擎化（REQ-058）：record/scan/propose、聚类毕业、人确认落地、载荷纳入 | feedback 测试组全绿 |
| P7 | 宪法瘦身（REQ-059：AGENTS.md 地图化 ≤6000 字节）+ 修复指令体（REQ-060）+ quarantine 原语（REQ-061） | rules-audit 阈值保持 0；gate/dod nextStep 100% |
| P8 | 三层反馈分级（REQ-062）+ 渐进采用阶梯（REQ-063）+ 棘轮持久化（REQ-064）+ 安装器锁与 marker（REQ-065）+ 压缩边界诚实降级文档（F2 结论落地） | init/arch/install 测试组全绿 |
| P9 | CI 模板扩展（GitLab 变体+定时空跑+汇总判定）+ release 接入强度 floor | 模板测试 + release 测试组全绿 |
| P10 | 自我 eval 套件（REQ-066）+ 真实仓性能复测 + v3.0.0 发布（release verb 全绿） | eval ≥20 任务两套分列；release READY |

每 Phase 完成判据（机械）：行为测试全绿（临时 git 仓、断言退出码与 JSON 字段、红测先行）→ dod 0 → gate PASS 绑当前指纹 → manifest --check 0 → trace 100% → spec lint 0 error → 摘对应 REQ planned 标记 → progress.md 同 commit。

## 风险与控制

| 风险 | 控制 |
| --- | --- |
| Kimi hooks fail-open 削弱强制力 | 文档明示+权限审批配合；高危操作走 permission rules 而非 hook |
| 插件 hooks 全局生效误伤他项目 | REQ-007 标记惰性 + sessionStart skill 自静默，测试锁定 |
| 供体机制移植走样 | 每机制指定供体文件 + 测试锁定行为 |
| 并行开发接口漂移 | CLI 契约 P2 冻结；集成阶段以测试对齐 |
| 单文件引擎可维护性 | 段落分区注释 + doctor 结构校验 + 测试覆盖 |
