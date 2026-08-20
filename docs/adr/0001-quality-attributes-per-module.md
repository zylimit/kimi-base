# ADR-0001：五性按模块声明定档，六档强制

状态：Accepted · 日期：2026-08-13
Enforced-by: catalog-lint, attributes, manual:waiver-禁词审查

## 背景

质量属性（韧性/安全/功能安全/隐私/可靠性）在 AI 开发中最常见的失效模式是"检查全绿但没人证明过 security"——检查与属性之间没有声明关系，覆盖与否不可判定。

## 决策

1. 模块在 module-catalog.json 声明 `attributes{属性: 档位}`；档位六级：critical/high/medium/low/minimal/none。
2. 检查在 verification-matrix.json 声明 `attributes[]` 认领它是哪些属性的证据。
3. 覆盖判定：受影响模块的 critical/high 属性必须有 fresh PASS 认领证据；反证（FAIL）压过佐证；SKIPPED 不覆盖也不反证。
4. none/minimal 必须写书面 reason，否则 catalog lint 以 UNJUSTIFIED_TIER 拦截——退出治理必须是留痕决策。
5. security 与 safety 为保护属性：永不豁免、永不 fast-skip。

## 备选与拒绝理由

- 八属性全集默认强制（cursor/pi 做法）→ 拒绝：默认五属性降低接入负担，扩展属性可声明。
- 全局统一档位 → 拒绝：不同模块风险画像不同，全局档位要么过松要么过紧。
- 纯文档承诺 → 拒绝：不能被检查看到的属性是愿望，不是治理。

## 后果

- 接入成本：模块必须过一遍定档（dfx-designer 承载）。
- 收益：覆盖缺口可门禁；"没人查过"状态被消灭。
