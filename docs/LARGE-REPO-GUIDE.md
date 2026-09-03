# LARGE-REPO-GUIDE：60 万行作业法

目标：60 万行级、多模块、长周期仓库上，AI 开发不失控、验证不爆炸、上下文不撞墙。

## 1. 分区：module-catalog 是一切的根基

- 每个模块声明：`paths`（glob 归属）、`layer`（分层）、`dependsOn`、`forbiddenDependencies`、`provides`、`attributes`（五性定档）。
- `catalog lint` 铁律：每条 git tracked 路径有主；拒绝 catch-all（裸 `**` 让覆盖看起来完整却什么都没证明）；重叠即错。
- 棕地接入四步：`catalog discover [--write]` 从仓库事实（目录分组 + 真实 import 边 + 构建清单）推导草案 → **人逐项决定 `needsDecision`**（属性档位/forbiddenDependencies/层名/矩阵接线——引擎拒绝猜，人不得偷懒全收）→ `arch baseline --write` 固化存量债（每条带 reason，进 git 可评审）→ 此后 `arch trend --gate` 棘轮执法，未声明边只许降不许升。（`init-modules` 是 discover 的废弃别名。）
- 边界复审节奏：`cochange` 定期（建议每迭代/发版前）用 git 历史测量共变耦合——高耦合无声明边 = BOUNDARY_SUSPECT，要么修边界/补声明，要么在 `catalog.cochange.accepted` 写书面理由留痕；历史太薄（<30 个有效提交）时它自己报 LOW_CONFIDENCE，别拿提示当测量。
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

### 实测冒烟（v2.0 P7a，2026-09-02，Windows + Node 24）

合成仓 4954 文件 / 151 模块（约 1 万行）：

| 命令 | 耗时 |
| --- | --- |
| `catalog lint` | 332ms |
| `impact --git`（改 core 触发最大反向闭包） | 227ms |
| `arch check --scan` | 1373ms |
| `gate`（2 个琐碎检查） | 518ms |

对照上方设计目标（60 万行/64 模块 lint<10s、impact<5s）余量约两个数量级。**诚实外推边界**：合成仓只有约 1 万行且为均匀合成结构，文件数×40、行数×60 的真实仓其 git 操作、全文扫描与 import 边解析的增长曲线未必线性——60 万行真实校准仍挂 TODO #7，本节数字只证明"机制本身没有明显常数级病态"，不证明 60 万行达标。

## 6. 实战教训（digifiber-conflation 七克隆，详录 CROSS-POLLINATION.md §实战）

- 纯文字架构文档必然陈旧——必须绑定机器可执行版本。
- "不宣称全量绿"的披露式诚实不消债——需要棘轮（新债零容忍、旧债只减不增）。
- 多会话/多克隆共享运行栈时，部署权必须唯一裁决；"容器热载态 ≠ 镜像态"。
- 脚手架状态文件与产品仓库边界定死（state/ gitignore），否则重演"装入→清掉"反复。
- 上下文墙会撞：压缩阈值预留余量，关键状态压缩前落盘。
