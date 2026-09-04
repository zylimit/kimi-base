# ADR-0009：Receipt v2 全绑定 + fast 证据贷款账本 + 可提交证据模式

状态：Accepted · 日期：2026-09-04 · 决策者：用户 + 主 Agent
Enforced-by: unit, manual:P4 落地后由 receipt/gate/fast 行为测试机械执法

## 背景

三个姐妹仓的共同弱点经逐仓核实：①证据绑定面窄——kimi/dsh 回执只绑 git 指纹，引擎自身升级后旧回执仍在背书（codex 用 runtime 树哈希解决了这一点）；②fast mode 是"窗口"不是"债"——dsh 有 FAST_MODE_DEBT 报告但关窗即翻篇，codex 的 loan 模型（关窗/过期/删文件都不清债，只有 fresh PASS 偿还）是唯一机械化形态；③证据不可移植——三家 ledger/receipt 全部本地 git-ignored，CI 与换机必须全量重跑，与"另一台机器从 progress.md 恢复"的记忆法不对称（恢复了意图，恢复不了证据）。kimi v2.0 已定性"fast 借账不是折扣"（P7b 决策），但借账记录仍在 gate 输出层，未入不可变账本。

## 决策

1. **Receipt v2 绑定面扩展**：回执在 diffHash 之外增绑 policyHash（ADR-0008）+ engineHash（runtime 树 LF 归一化哈希）+ catalogHash。任一收紧侧变化 → `receipt verify` exit 4（stale），链完好不算篡改。
2. **fast 贷款账本化**：fast 窗口内跳过的每条检查记 `DEFERRED` 债务条目入哈希链账本；关窗、窗口过期、删除 fast 状态文件均不清债；唯一偿还路径 = 窗口外同检查 fresh PASS。`risk` 报 FAST_MODE_DEBT 直至偿清；带 fast 印记的记录永不能关闭 task/release（承 P7b 语义，从输出层下沉到账本层）。
3. protected 检查（security/safety/privacy）与已执行 FAIL 永不进入可延期集；可延期性须预先声明（`allowFastSkip` 既有机制），应急现场不可新声明。
4. **可提交证据模式（证据可移植性，姐妹仓无人做到）**：`harness.json` 新增 `evidence.mode: "local" | "committed"`（默认 local 保持现状）。committed 模式下回执与账本文件纳入 git（证据日志本体仍本地，回执只记其 sha256），CI 与换机可直接 `receipt verify` 验链而不必全量重跑。脱敏纪律不变：证据日志永不入库。
5. engineHash 计算排除 `state/` 等运行态路径，与 FRAMEWORK-MANIFEST 同一 LF 归一化算法；引擎任何字节变化使旧回执 stale——这是特性不是副作用：引擎变了，"它验证过"的含义就变了。

## 备选与拒绝理由

- 只绑 diffHash（现状）→ 拒绝：策略收紧、引擎修复后旧证据继续背书，证据语义被偷换。
- 关窗清债（dsh 形态）→ 拒绝：关窗动作成为"免债金牌"，债必须被证据偿还而不是被动作抹除。
- 证据全量入库（含日志）→ 拒绝：日志含命令输出，脱敏边界不可机械保证；入的是判定与链，不是原料。
- 强制 committed 模式 → 拒绝：小项目不需要证据可移植，默认 local 保持零负担；可移植是可选升级不是新税。

## 后果

- 策略、引擎、架构图任何一侧演进都会让该重验的重验——"绿"的含义随治理现实同步漂移，不再有静态绿。
- committed 模式下团队 review 能看到豁免与回执的产生（dsh 台账自认的盲区被关闭）。
- fast 从"时间窗口"完成向"证据贷款"的语义沉降：借账必还、还必以证据。
