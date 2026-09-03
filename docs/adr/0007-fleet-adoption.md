# ADR-0007：fleet 采纳——多仓契约治理

状态：Accepted · 日期：2026-09-02 · 决策者：用户拍板（完整移植）
Enforced-by: manual:fleet-行为测试（tests/scale.test.mjs：lint/impact/status/recap/未知契约降级）, manual:模板不种子（fleet.example.json + FLEET.md 仅文档模板，installer 白名单不含）

## 背景

kimi-base 的目标场景包括仓群（fleet）：多个仓库互相提供/消费契约（API、事件），单仓治理看不到跨仓契约违例——提供方改了契约，消费方的仓内全绿照样碎。dsh-base 已有验证过的 fleet 实现；用户在 v2.0 拍板完整移植。

## 决策

1. 引擎动词 `fleet lint/impact/status/recap`（lib/fleet.mjs）：fleet.json 组级文件声明成员仓及其 provides/consumes 契约；lint 查契约违例（违例 exit 1，引用未知契约 exit 3 降级不假绿）；impact 算变更的跨仓波及面；status 逐仓跑 doctor（退出码语义，`--deep` 加 dod）；recap 逐仓汇总且总量封顶。
2. fleet.json 定位链：`--fleet` 参数 > `KIMI_BASE_FLEET` 环境变量 > 祖先目录查找；`KIMI_BASE_ROOT` 钉死项目根，防成员仓嵌套时向上查找串到祖先仓。
3. 不移植 dsh 的 stdout 单行 JSON 解析：kimi 引擎输出是中文人类文本，status/recap 改用退出码 + 文本行解析。
4. `templates/FLEET.md` + `fleet.example.json` 只作文档模板随载荷发布，**不做种子**（单仓项目不应被 fleet 资产骚扰）。

## 备选与拒绝理由

- 不移植（单仓够用）→ 拒绝：仓群契约违例是真实失效模式；用户已拍板。
- 逐字移植 dsh 输出解析 → 拒绝：输出形态不同，解析必然坏；退出码才是跨进程契约（ADR-0006）。
- fleet.json 进种子自动落地 → 拒绝：无仓群的项目里它是噪音；需要者显式启用。

## 后果

- 多仓用户获得契约级门禁；单仓用户零感知。
- **回滚条件**：若长期无真实多仓使用（无 fleet.json 实践、无缺陷报告、无需求拉动），fleet 动词 + lib/fleet.mjs + 模板撤出载荷（manifest 同步重生成），本 ADR 转 deprecated——不为想象中的规模付永久的维护税。
