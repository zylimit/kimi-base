# QUALITY-ATTRIBUTES：五性治理

> 检查跑通只证明"跑过"，不证明"建立了什么性质"。本机制消灭的是"没人查过"这个状态——不是宣称证明了属性成立。

## 1. 属性与档位

治理核心五属性（按项目要求）：

| 属性 | 含义 | 典型证据 |
| --- | --- | --- |
| Resilience 韧性 | 遭受攻击/故障/灾害时主动识别风险并快速恢复，抵抗并发冲击 | 退避/熔断/限流/降级测试、k6 压测、混沌演练、supervisor 守护 |
| Security 信息安全 | 数据与信息安全，防未授权访问/破坏/窃听/篡改 | semgrep/gitleaks/trivy/osv 扫描、密钥零硬编码、权限最小化 |
| Safety 功能安全 | 系统故障/失效时不对人、环境、设备造成实质伤害 | FMEA、fail-safe 默认、破坏性操作审批、裸 TODO 清零 |
| Privacy 隐私 | 数据收集/使用/存储/销毁合规（GDPR 等）与隐私设计 | PII 不出日志、数据生命周期策略、隐私边界禁边、presidio |
| Reliability 可靠性 | 规定条件与时间内持续稳定无故障执行业务 | 回归测试、契约测试、变异测试、空 catch 清零、哈希链账本 |

扩展属性（可选声明，非默认强制）：availability / performance / maintainability。

六档强制力：

| 档 | 语义 | 缺口后果 |
| --- | --- | --- |
| critical | 阻断且永不可豁免 | 无 fresh 证据即 uncovered，阻断完成 |
| high | 阻断，可 waiver（security/safety 除外） | 同上 |
| medium | 告警 | 报告不阻断 |
| low | 记录 | 仅可见 |
| minimal / none | 退出治理 | **必须书面理由**（catalog lint UNJUSTIFIED_TIER 拦裸退出）——退出治理是留痕决策，不是零成本默认 |

## 2. 机制闭环

```
需求侧   product-spec-builder 必问五性 → dfx-designer 六要素场景化提需（可度量或不写）
声明侧   模块在 module-catalog.json 声明 attributes{属性:档}
认领侧   检查在 verification-matrix.json 声明 attributes[]（"我的 PASS 是这些属性的证据"）
执行侧   gate 按 impact 受影响模块跑检查 → receipt（fresh、diff 绑定）
判定侧   quality status：受影响模块的 critical/high 属性并集逐一判定
```

覆盖判定三铁则：

1. **反证压过佐证**：一个 FAIL 否决同属性全部 PASS。
2. **声明未接线 = 可见缺口**：属性定了档但无任何检查认领 → uncovered，不静默通过。
3. **SKIPPED 不覆盖也不反证**：fast skip 只是延期，欠账可见（`deferredByFastMode`）。

critical/high 判 uncovered → `quality status` exit 2 → task complete / 发布闸阻断。

## 3. 保护属性

security 与 safety 是保护属性，双重写死（创建期 + 运行期）：

- waiver 永不可用于它们（名称/属性命中禁词即拒绝）；
- fast mode 永不跳过 security kind 检查；
- 已执行的 FAIL 永不可豁免（waiver 只豁免 BLOCKED/SKIPPED——"跑不了的可以请假，跑挂了必须修"）。

## 4. 内置 fitness 规则（随变更跑的文本级防线）

| 规则 | 级别 | 命中 |
| --- | --- | --- |
| no-secret-literal | error | sk-/ghp-/xox/AKIA/私钥块等密钥字面量 |
| no-pii-in-logs | error | 日志语句携带 email/手机号/身份证/卡号模式 |
| no-silent-failure | error | 空 catch / except: pass（故障变成没人上报的错误答案） |
| no-unbounded-retry | warning | 无退避上限的重试循环（瞬时故障放大成持续冲击） |
| no-unreferenced-deferral | warning | safety≥high 模块中未挂单的 TODO/FIXME（没人认领的欠账） |

抑制：同行注释 `kimi-base-ignore: <rule>`（留痕于 fitness 输出）。

## 5. 外部工具 adapters（声明式接入，不捆绑不安装）

adapters.json 预置：semgrep（SAST）、osv-scanner（依赖漏洞）、trivy（镜像/IaC）、gitleaks（历史密钥）、syft（SBOM）、presidio（PII）、stryker（变异测试）、schemathesis（契约）、k6（压测）、checkov（IaC）。每个 adapter 声明命令模板、认领属性、超时与一句坦率的能力边界。**可执行文件缺失 = BLOCKED，绝不假绿**；runtime 类检查（k6）结果按时间窗（runtimeValidityHours）理解，不当作当前 diff 的证据。

## 6. 逐属性落地要点

- **Resilience**：supervisor 开发态守护（退避/探针/熔断）+ no-unbounded-retry + k6 适配 + risk scan 主动识别。
- **Security**：分类器凭据防护 + no-secret-literal + 上述 SAST/SCA 适配 + 权限审批兜底。
- **Safety**：fail-safe 默认（非 git 仓 arch=BLOCKED 不假 PASS；账本断链视同未验证）+ 裸 TODO 规则 + 破坏性操作 HIGH 审批。
- **Privacy**：no-pii-in-logs + context pack DENY 清单（凭据永不入 LLM 上下文）+ evidence 脱敏 + retention 定期销毁 + catalog forbiddenDependencies 画隐私边界（如 analytics 永不 import pii-store）+ 发布隐私审计。
- **Reliability**：四态门 + 回执链 + 红测先行（red-locks-the-bug）+ 变异/契约适配。

## 7. 诚实边界

本机制确证的是"声明的属性有真实执行过的证据"，并不确证属性成立；fitness 是文本启发式，可能漏报/误报；真正的属性保障来自设计评审、测试深度与生产观测的组合。
