# 五性治理细则（主控下沉）

**命中本指针必须完整读取再行动，不得凭指针行猜测内容。**

## 定位——五性治理为什么要机器化

检查跑通只证明「跑过」，不证明「建立了什么性质」。一个仓库可以每个 check 全绿，却没有任何证据说明支付模块是安全的、日志是不泄隐私的、故障是能自愈的。本层补上这个缺口：模块声明它必须持有证据的质量属性（韧性 Resilience / 网络与信息安全 Security / 功能安全 Safety / 隐私 Privacy / 可靠性 Reliability，外加可选的可用性 / 性能 / 可维护性），check 声明它的通过是哪些属性的证据，覆盖与否从此可判定、可门禁。

本层去除的是「没人查过」这个状态；它不担保属性成立——个人数据检测有漏网、静态分析看不见逻辑缺陷，工具边界要如实报告。

## 属性清单

- `security`：网络与信息安全——防未授权访问 / 破坏 / 窃听 / 篡改（SAST、依赖漏洞、密钥泄漏、SBOM）
- `safety`：功能安全——故障或失效不对人身 / 环境 / 设备造成实质伤害（危险操作闸、失效模式检查、高危模块的挂单纪律）
- `privacy`：隐私——个人与企业数据的收集 / 使用 / 存储 / 销毁合规（GDPR 等），日志与出口不携带 PII
- `resilience`：韧性——主动识别风险、故障快速恢复、抗大规模并发冲击（重试有界有退避、熔断、压测）
- `reliability`：可靠性——规定条件与时间内持续稳定无故障（回归测试、变异测试、契约测试、不吞错）
- `availability` / `performance` / `maintainability`：可选扩展属性，按需声明

## 六档强度——按模块给到该给的严格度

一刀切的严格度本身就是缺陷：全仓一个标准会把一次性原型养得和支付服务一样贵，团队的应对必然是整体关检查而不是调档。所以声明带档位：

| 档位 | 执法 | 含义 |
|---|---|---|
| `critical` | 阻断 | 缺证据即阻断完成，**永不可豁免** |
| `high` | 阻断 | 缺证据即阻断完成；waiver 只能推迟「跑不了」的检查，推迟不了属性缺口本身 |
| `medium` | 告警 | 报为缺口，不阻断 |
| `low` | 记录 | 仅记录备查 |
| `minimal` | 列示 | 按需列出；**必须给书面 reason** |
| `none` | 退出 | 明确不治理；**必须给书面 reason** |

minimal / none 必须给 reason（配置期 `CATALOG_UNJUSTIFIED_TIER` 拦裸退出）——因为「不治理」是每个属性在零成本下自然漂向的状态，退出必须是留痕决策。

声明写法（module-catalog.json 的 module.attributes，字符串档位或 `{tier, reason}` 对象）：

```json
{
  "id": "payments",
  "attributes": {
    "security": "critical",
    "privacy": "high",
    "reliability": "high",
    "availability": { "tier": "none", "reason": "纯库模块，无服务面" }
  }
}
```

## 覆盖判定三铁则（quality status 执行）

受影响模块声明的 critical/high 属性被覆盖 = 认领该属性的检查里**至少一个有 fresh PASS 回执，且没有任何一个 FAIL 反证**。三条铁则：

1. **反证压过佐证**：一个 check 说属性成立、另一个 check 证明它不成立时，属性不算覆盖——「证明不成立」比「部分证明成立」更强。
2. **声明而未接线 = 可见缺口，不是静默通过**：声明了 security:critical 却没有任何 check 认领 security，报缺口并阻断（这才是诚实状态）。
3. **SKIPPED 不覆盖也不反证**：Fast Mode 或 waiver 跳过的检查不产生任何方向的证据。

check 认领属性的写法（verification-matrix.json 的 checks[]）：

```json
{ "id": "sec-scan", "kind": "security", "command": "semgrep scan --error --config auto", "attributes": ["security"] }
```

门禁：`node .kimi-base/runtime/kimi-base.mjs quality status` 判定受影响模块的 critical/high 属性缺覆盖 → exit 2 → task complete 与发布闸阻断。medium 报告、low/minimal 记录，均不阻断。治理域跟随 impact：只判定受影响模块，不全仓泛化。

## fitness——第一天就能跑的内置规则（零外部工具）

`node .kimi-base/runtime/kimi-base.mjs fitness`（默认扫 git 变更面；`--path a,b` 显式指定；非 git 且无 `--path` = 降级 exit 3）。五条内置规则对应五性，纯文本启发式：

- `no-secret-literal`（security，error）：源码里的密钥 / token / 私钥字面量
- `no-pii-in-logs`（privacy，error）：日志语句携带 email / ssn / 卡号 / 生日等个人字段
- `no-silent-failure`（reliability，error）：空 catch / except-pass——把故障变成没人上报的错误答案
- `no-unbounded-retry`（resilience，warning）：无界重试循环——把瞬时故障放大成持续冲击
- `no-unreferenced-deferral`（safety，warning，minimumTier=high）：safety 档位 ≥high 的模块里未挂单的 TODO/FIXME——高危模块里没人认领的欠账

规则强度跟着模块档位走：带 `minimumTier` 的规则只在声明到该档位的模块里生效；模块把某属性设 `none` 则相关规则对它全部静音。同行注释 `kimi-base-ignore: <rule>` 压制单条命中（留痕于 fitness 输出）——压的是这一条，不是整条规则。error 级命中 exit 1（规则违例）。

这些是文本启发式：能减少「没人查过」的缺陷面，不能证明属性成立。要真证据，接外部工具（下节）。

## adapters——外部工具接线（工具映射到属性）

harness **不捆绑不安装**任何工具。`.kimi-base/adapters.json` 是适配目录：每个条目含命令模板、认领属性、超时与一句坦率的能力边界。接线方式 = 把条目的命令抄进 `verification-matrix.json` 的 checks[]（保留其 attributes 认领），被风险层选中后随 gate 执行。**可执行文件缺失时该检查报 BLOCKED——缺失 = BLOCKED，绝不假绿**。

速查（按属性挑工具）：

- security：`semgrep`（SAST）/ `osv-scanner`（依赖漏洞，快、低噪、适合每变更）/ `trivy`（广域扫，适合定期）/ `gitleaks`（历史敏感信息，补 fitness 只看工作树的盲区）/ `syft`（SBOM 资产清单）/ `checkov`（基础设施配置错误）
- privacy：`presidio`（个人数据检测）+ `gitleaks`
- reliability：`stryker`（变异测试——测「测试真能抓住缺陷吗」）/ `schemathesis`（API 契约对抗）
- resilience：`k6`（负载 / 延迟 / 错误率目标）

声明了 `runtimeValidityHours` 的检查（如 k6）度量的是**部署后的系统**，没有 diff 指纹能描述它——其结果按时间窗口理解，不当作当前工作树代码的证据。

## security / safety / privacy 永不豁免、永不 fast-skip

- protected 检查（kind 为 security/safety，或 attributes 含 security/safety/privacy）：`allowFastSkip` 在配置期直接拒绝（kind 与认领属性任一命中即拒——只看 kind 会漏掉「认领 privacy 的 static 检查」这个盲区）；waiver 创建期命中禁词（含 privacy/pii/隐私/个人信，且 waiver 的 reason/compensation 文本同样受检）即拒绝。
- 已执行的 FAIL 永不可豁免：waiver 只豁免 BLOCKED/SKIPPED——「跑不了的可以请假，跑挂了必须修」。
- 这是地板，不是旋钮：放宽这三类等于拆消防栓。

## 五性从需求到验证的贯通

- 需求侧：product-spec-builder 六维中的「五性需求」——问清哪些数据是个人数据、故障可容忍度、并发冲击预期、失效的物理后果，落进 Product-Spec 的非功能需求。
- 设计侧：dfx-designer 逐维定档落 module attributes；arch-designer 的 forbiddenDependencies 把隐私/安全边界可执行化（如 analytics 永不 import pii-store）。
- 开发侧：fitness 随变更跑；arch check 看边界不被穿；`arch trend --record` + `arch trend --gate` 做漂移棘轮——可维护性从形容词变成「违规指标只许降不许升」的硬指标；存量债用 `arch baseline --write` 固化（带 reason、进 git 可评审），还清后 stale 催删。
- 决策侧：每条活跃 ADR 用 `adr check` 盯执法引用——幽灵引用（指向不存在的闸）直接 FAIL。
- 审查侧：code-review / red-blue-review 的 security / privacy / resilience lens 以属性声明为靶子。
- 验证侧：quality status 覆盖门 + adapters 真工具证据；发布前 release-builder 发布闸跑全量 gate + quality status。
- 例外侧：waiver 五要素齐全（approver/reason/expiresAt/compensation/绑指纹）、留痕可审计；critical 属性与 security/safety/privacy 没有豁免通道。
