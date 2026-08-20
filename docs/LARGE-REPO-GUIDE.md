# LARGE-REPO-GUIDE：60 万行作业法

目标：60 万行级、多模块、长周期仓库上，AI 开发不失控、验证不爆炸、上下文不撞墙。

## 1. 分区：module-catalog 是一切的根基

- 每个模块声明：`paths`（glob 归属）、`layer`（分层）、`dependsOn`、`forbiddenDependencies`、`provides`、`attributes`（五性定档）。
- `catalog lint` 铁律：每条 git tracked 路径有主；拒绝 catch-all（裸 `**` 让覆盖看起来完整却什么都没证明）；重叠即错。
- 棕地接入：`init-modules` 按顶层目录生成骨架 → 人工校正 → `arch baseline --write` 固化存量债（每条带 reason，进 git 可评审）→ 此后未声明边只许降不许升。
- 文档纪律：Architecture-Design.md 与 catalog 冲突时，**以 arch check 实测为准并回改文档**——文档向机器态对齐，而不是相反。

## 2. 影响分析：验证成本随变更收缩

- `impact --git`：变更路径 → 模块归属 → 反向依赖闭包 → 受影响检查计划。
- unmapped / shared / global 变更：保守扩散到全模块（宁可全跑，不可漏测）。
- `gate` 默认只跑受影响计划；全量验证只在发布闸（release-builder）。
- 五性治理域跟随 impact：只判定受影响模块声明的 critical/high 属性。

## 3. 上下文预算：按必然撞墙设计

- AGENTS.md ≤150 行；细则下沉 rules/（命中指针才完整读取）。
- 探索外包：主 Agent 不亲自读大文件全文，派 explore/researcher 子代理，回传"结论+证据句柄"。
- `context pack --budget N --focus globs`：预算化最小上下文包；DENY 清单凭据永不入包；装不下的进 `omitted` 显式报告（不静默丢弃）。
- 派单提示词纪律：每个字带信息，删套话；子代理上下文是独立窗口，背景必须显式给全。
- 压缩韧性：PreCompact 自动落盘 compaction-note.json；恢复走 `/kimi-base:recap`（三文件+note 读齐）。
- 模型分层（可选实验）：只读角色（explore/researcher/progress-recorder）走 secondary_model 高速模型。

## 4. 验证阶梯

| 场景 | 范围 |
| --- | --- |
| 编码中 | fitness（文本级，毫秒） |
| task complete 前 | 风险层 required checks（随 impact 收缩） |
| commit/发布前 | 全量 gate + quality status + catalog/arch/adr 三件套 |
| 周期性 | risk scan、gate-audit、retention prune（可用 Kimi Cron 定时） |

## 5. 性能预算（设计目标，合成仓基准）

- PreToolUse hook 常规路径 <100ms；Stop 门 <2s。
- 60 万行/64 模块：catalog lint <10s；impact <5s。
- 手段：glob 编译缓存、`git ls-files -z`、有界扫描（超 maxTrackedPaths 按坏测量处理并保守扩散）、长输出落盘只回摘要。

## 6. 实战教训（digifiber-conflation 七克隆，详录 CROSS-POLLINATION.md §实战）

- 纯文字架构文档必然陈旧——必须绑定机器可执行版本。
- "不宣称全量绿"的披露式诚实不消债——需要棘轮（新债零容忍、旧债只减不增）。
- 多会话/多克隆共享运行栈时，部署权必须唯一裁决；"容器热载态 ≠ 镜像态"。
- 脚手架状态文件与产品仓库边界定死（state/ gitignore），否则重演"装入→清掉"反复。
- 上下文墙会撞：压缩阈值预留余量，关键状态压缩前落盘。
