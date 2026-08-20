# kimi-base DEV PLAN

交付策略：单仓三层（插件面 / 项目模板面 / 治理引擎），引擎先行、资产并行、测试收尾；每一步可独立验收。

技术栈：Node ≥18（零依赖 ESM，单文件引擎）+ Bash/PowerShell 安装包装 + Markdown 资产。选择原因：宿主 Kimi Code  hooks 以本地命令执行，Node 单文件零安装成本；Markdown 是 Kimi agents/skills 的原生载体。

## Phase 依赖

```
P1 调研审计 ──► P2 架构定型 ──► P3 runtime 引擎 ─┐
                          ├──► P4 模板资产 ──────┼──► P6 集成验证 ──► P7 发布收尾
                          └──► P5 测试与插件胶水 ┘
```

## P1 调研审计 ✅

- P1-T1 六仓深读（codex/cc/ccb/pi/cursor/opencode）产出吸收清单。Verification: 六份结构化报告。✅
- P1-T2 digifiber-conflation 七克隆实战巡视，产出落地教训 8 条。✅
- P1-T3 Kimi Code 官方文档全量核对（skills/hooks/agents/plugins/mcp/config/goals/sessions/slash-commands/tools）。Verification: 能力映射有据可查。✅

## P2 架构定型 ✅

- P2-T1 双层架构（插件面+项目面）与标记惰性激活模式。Expected: kimi.plugin.json hooks 声明与 `.kimi-base/harness.json` 标记协议。
- P2-T2 CLI 动词契约冻结（25 动词）+ 状态目录布局（.kimi-base/state/）。Expected: 三份并行开发输入一致。
- P2-T3 五性治理模型定型（五属性六档、保护属性、覆盖判定三铁则）。

## P3 runtime 引擎（runtime/kimi-base.mjs + supervisor） ✅

- P3-T1 基础设施：JSON IO/原子写/跨进程锁/LF-SHA256/git 封装/glob 缓存/路径防逃逸。
- P3-T2 治理核心：task 账本、fingerprint、gate 四态+receipt、quality 覆盖判定+waiver。
- P3-T3 架构防腐：catalog lint、arch check+baseline+trend、adr check、fitness 五规则。
- P3-T4 大仓与运维：impact、context pack、risk scan、retention、gate-audit、fast。
- P3-T5 hooks 调度器七事件 + 安装事务（install/upgrade/uninstall/manifest/doctor/pack-check）。
- P3-T6 supervisor.mjs 与跨平台包装脚本。
- Verification: `node runtime/kimi-base.mjs selftest` 通过；临时夹具仓 install→task→gate→arch→quality 全链路冒烟。

## P4 模板资产（template/） ✅

- P4-T1 `.kimi-code/agents/` 8 角色（Kimi frontmatter：tools/disallowedTools/subagents:[]）。
- P4-T2 `.kimi-code/skills/` 16 工作流（name==目录、description≤180 非流程摘要）。
- P4-T3 `.kimi-base/rules/` 3 下沉细则 + `templates/` 9 模板。
- P4-T4 `AGENTS.md` 宪法 + harness.json/module-catalog/verification-matrix/adapters 配置。
- Verification: doctor frontmatter 校验零 error。

## P5 测试与插件胶水（tests/ + plugin/） ✅

- P5-T1 tests/harness.test.mjs：16 组用例（安装事务/回执/四态门/waiver/覆盖判定/架构三件套/fitness/hooks/fast/context/doctor/插件资产自检）。
- P5-T2 plugin/skills/kimi-base（sessionStart 路由，非标记项目自静默）。
- P5-T3 plugin/commands/ 8 个斜杠命令。
- Verification: `node --test tests/` 全绿（环境缺 git 时明示 skip 不假绿）。

## P6 集成验证 ✅

- P6-T1 全量测试 + selftest + doctor + manifest:check + pack:check。
- P6-T2 端到端演练：临时目录 install → 模拟开发（改码→gate→receipt→complete）→ Stop 门阻断/放行。
- P6-T3 60 万行合成仓性能钉板（impact/catalog lint 计时）。
- Verification: 上述命令全部 exit 0，证据写入 progress.md。

## P7 发布收尾 ✅

- P7-T1 README/OPERATIONS 与实现一致性复核（文档与代码漂移回改）。
- P7-T2 make-release.sh 打包 + 泄漏扫描。
- P7-T3 progress.md 归档收尾，写下验证证据句柄。

## 风险与控制

| 风险 | 控制 |
| --- | --- |
| Kimi hooks fail-open 削弱强制力 | 文档明示+权限审批配合；高危操作走 permission rules 而非 hook |
| 插件 hooks 全局生效误伤他项目 | REQ-007 标记惰性 + sessionStart skill 自静默，测试锁定 |
| 供体机制移植走样 | 每机制指定供体文件 + 测试锁定行为 |
| 并行开发接口漂移 | CLI 契约 P2 冻结；集成阶段以测试对齐 |
| 单文件引擎可维护性 | 段落分区注释 + doctor 结构校验 + 测试覆盖 |
