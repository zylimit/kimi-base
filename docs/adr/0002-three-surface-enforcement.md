# ADR-0002：三面执法——插件 hooks 护栏 + git hooks fail-closed + CI 权威面

状态：Accepted · 日期：2026-09-02 · 决策者：用户 + 主 Agent
Enforced-by: manifest-check, pack-check, manual:audit-独立性禁边（catalog audit 模块 forbiddenDependencies:["engine"] + 静态测试双重执法）

## 背景

v1 的唯一机械闸是 Kimi 插件 hooks（工具调用时）。它有两个结构性短板：Kimi hooks 一律 fail-open（脚本异常/超时默认放行），且只在 Kimi 会话内存活——纯 git 操作、其他工具、CI 环境全部无闸。单面执法等于把护栏的失效面当成整个治理的失效面。

## 决策

执法分三面，失效语义逐面如实声明：

1. **插件 hooks（工具调用时护栏）**：fail-open 护栏不是沙箱，高危面靠 permission rules 兜底；非标记项目（无 `.kimi-base/harness.json`）标记惰性自静默。
2. **git hooks（fail-closed 第二道闸）**：`.kimi-base/githooks/` 三个纯 POSIX sh 钩子，`install --hooks` 经 `core.hooksPath` 挂载。pre-commit 跑 scan-secrets / scan-instructions / check-syntax --staged / catalog lint / skills-lint / agents-lint / fitness --staged / sync-check --staged（首个失败即拦；budget 按设计 ADVISORY 不拦）；pre-push 跑 dod + gate；commit-msg 做信息 lint。无标记静默；无 node 响亮 fail-open（如实打印，不伪装有闸）。
3. **CI（权威面）**：selftest → 四个独立审计脚本 → run-tests → dod → arch trend --gate。`.kimi-base/audit/` 脚本与引擎**刻意独立重复实现**（禁 import 引擎），引擎缺陷无法让审计沉默；采纳者模板在 `.kimi-base/templates/github-gate.yml`。

## 备选与拒绝理由

- 只靠插件 hooks → 拒绝：fail-open + 只覆盖 Kimi 会话，git/CI 面无闸。
- 只信 CI → 拒绝：反馈太晚，本地犯错成本全推到推送后。
- hook 内联跑全量测试 → 拒绝：hook 必须轻量；重检查归 gate/dod 显式动词。

## 后果

- 无 Kimi 的环境（纯 git、CI runner）仍有 fail-closed 闸；Kimi 会话内多一层工具调用时护栏。
- 三面共用同一份引擎动词与 DOD_STEPS 事实源，判定语义无第三份拷贝。
- doctor 对已安装但未挂 git hooks 的仓库响亮警告"第二道闸未挂载"——降级可见，不静默。
