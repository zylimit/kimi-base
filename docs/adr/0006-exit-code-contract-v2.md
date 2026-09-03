# ADR-0006：退出码契约 v2（0/1/2/3/4，降级永不计绿，陈旧独立成态）

状态：Accepted · 日期：2026-09-02 · 决策者：用户 + 主 Agent
Enforced-by: unit, manual:行为测试一律断言退出码与 JSON 字段、不断言 stderr 文本

## 背景

v1 退出码语义含混：用法错误、规则违例、治理阻断、降级混在 1/2 两档里；supervisor 把用法错误报成 3；"证据陈旧"与"验证失败"不分——后者直接导致 dogfood 中的真实卡死：提交已评审工作后回执必然 stale（正常流程痕迹），若 stale 按 FAIL 计，干净全门禁仓永远 NOT READY。消费者（dod / release / CI / fleet status）需要可机器归级的、语义唯一的退出码。

## 决策

引擎退出码契约 v2：

| 码 | 语义 |
| --- | --- |
| 0 | 成功 / PASS（干净） |
| 1 | 用法错误（含未知 flag，列出合法集）或规则违例（catalog lint / fitness / adr / arch 发现违规） |
| 2 | 治理阻断（gate / 完成门 / quality status / 篡改·断链·缺失 / doctor / pack-check / manifest / install） |
| 3 | 降级（非 git 仓无法测量，**绝不假绿**）或引擎内部错误 |
| 4 | 陈旧证据（receipt verify：指纹已移动、链完好） |

配套规则：

1. hook outward 契约保持 0（放行）/ 2（拦截），不并入上表。
2. 全动词严格 flag 校验：未知 flag 一律 exit 1 并列出该动词合法 flag 集。
3. **降级永不计绿**：dod 全 PASS 才 exit 0；仅降级 exit 3 且响亮报告；缺工具/缺命令/非 git 仓同理。
4. **陈旧独立成态**：dod 把 receipt-verify 的 exit 4 归级为 STALE（可见不阻断）；release 拆"完整性 ≠ 新鲜度"——ledger-intact 只判篡改/断链/缺失/漂移，staleness 归 receipt-fresh（range 评审回执在 HEAD 未移动时视为 fresh）。
5. 所有 composite（dod / release / fleet status）按退出码归级，不再解析 stdout 文本当判定依据（fleet 因成员输出是中文人类文本，采用退出码 + 文本行的显式组合）。

## 备选与拒绝理由

- 沿用 v1 两档（0 / 非 0）→ 拒绝：降级与失败不可分，BLOCKED 不是一等状态就守不住"绝不假绿"。
- stale 按 FAIL 计 → 拒绝：把正常流程痕迹判红，等于训练用户无视红色。
- 为每个 composite 发明私有信号（stdout 单行 JSON 等）→ 拒绝：退出码是唯一跨进程契约；输出形态是给人看的。

## 后果

- 退出码成为所有消费者的唯一归级依据；新增动词必须落入五档之一，无第六档。
- 测试纪律随之固化：行为测试断言退出码与 JSON 字段，不断言 stderr 文本。
