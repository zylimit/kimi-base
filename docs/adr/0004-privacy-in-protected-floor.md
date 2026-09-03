# ADR-0004：privacy 升入保护底线（protected = security + safety + privacy）

状态：Accepted · 日期：2026-09-02 · 决策者：用户拍板
Enforced-by: attributes, no-pii-in-logs, manual:waiver-禁词审查（含 privacy/PII/隐私/个人信）

## 背景

ADR-0001（2026-08-13）定五性治理模型时，保护属性只含 security 与 safety：永不豁免、永不 fast-skip。privacy 当时是普通属性——意味着"跳过 PII 检查"理论上可以走 waiver 留痕合法化。v2.0 重构中用户拍板：隐私与安全的伦理同级，不能存在合法绕过的路径。

## 决策

1. 保护底线改为 `PROTECTED_ATTRIBUTES = {security, safety, privacy}`，**修订 ADR-0001 第 5 条的保护子集**（五性属性集与六档定档框架不变）。
2. privacy 永不豁免、永不 fast-skip，与 security/safety 同约束：
   - waiver 创建拒绝对 privacy 检查豁免；禁词面（privacy/PII/隐私/个人信）覆盖 waiver 自身的 reason/compensation 文本——不许借文字描述走私隐私豁免。
   - matrix 的 `allowFastSkip` 保护判定为双通道：检查 kind 或其认领属性任一命中 protected 即拒绝配置 fast-skip。
   - fast mode 运行期对 protected 检查免疫。
3. 本仓宪法（AGENTS.md 证据法第 3 条）、progress.md Pinned 第 3 条与全载荷旧表述同批拉齐。

## 备选与拒绝理由

- privacy 保持普通属性（可 waiver、可 fast-skip）→ 拒绝：只要豁免路径存在，"PII 检查被合法跳过"就迟早发生；保护属性的全部意义就是语法层面不可表示该操作。
- 八属性全集默认强制（cursor/pi 做法）→ 拒绝：维持 ADR-0001 结论，本决策只动保护子集不动属性全集。

## 后果

- waiver 只豁免"跑不了"，永不豁免"跑挂了"的原则扩展到 privacy；fast 借账同样不能跳过 privacy 检查。
- 历史决策不撤销而修订：ADR-0001 保持活跃，本条明确记载被修订的子集，修订链可溯。
