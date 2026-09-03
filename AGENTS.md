# kimi-base 仓内宪法

本仓是 kimi-base 脚手架本身：**源布局 = 安装布局**，本仓用自己的引擎治理自己（自托管 dogfood）。本文件只放不变量与索引；细则在 `.kimi-base/rules/`，手册在 `docs/`。规则冲突时本文件优先。

## 布局铁律

1. 载荷即 `.kimi-base/`（runtime/rules/templates/audit/githooks/adapters/三个 example 种子）+ `.kimi-code/`。改任何载荷文件后必须同 commit 重新生成 `FRAMEWORK-MANIFEST.json`（`npm run manifest`），否则 `manifest --check` 红。
2. `.kimi-base/{harness,module-catalog,verification-matrix}.json` 是本仓**自用**治理配置，永不进安装面；安装面只发 `*.example.json` 种子（缺失才落地，永不覆盖）。
3. `.kimi-base/state/` 是运行态，git-ignored，任何断言不得依赖其残留。
4. 不写第二套 Agent runtime；不修改 Kimi Code 内核；hooks 是护栏不是沙箱。

## 证据法（全部质量结论的判据）

1. 只有绑定当前 git 指纹的 gate 回执算质量通过；DONE、口头成功、`catalog lint` 通过都不算。
2. 缺工具/缺命令/非 git 仓 = BLOCKED 或可见降级，绝不假绿；SKIP 必须显式。
3. security/safety/privacy 永不豁免、永不 fast-skip；waiver 只豁免"跑不了"，不豁免"跑挂了"。
4. 声明任何东西可用前：说出能证明它的命令 → 现跑 → 读完整输出和退出码 → 确认输出支撑该结论 → 才准说。

## 工程纪律

1. 测试独立：写测者 ≠ 被测作者；测试不为迁就实现改断言。行为测试在临时 git 仓中跑，断言退出码与 JSON 字段，不断言 stderr 文本。
2. `.kimi-base/audit/` 脚本禁止 import 引擎——审计者与被审计者独立，arch 禁边（`forbiddenDependencies:["engine"]`）+ 静态测试双重执法。
3. 引擎零依赖（Node stdlib only）；新增"能力"优先落成可执行检查，提示词纪律兜底——例外需书面理由。
4. 引擎改动保持退出码契约：0 干净 / 1 用法·违规 / 2 阻断 / 3 降级 / 4 陈旧（P2 落地 v2 契约）。
5. 三文件同步：治理代码与 progress.md 同 commit；Product-Spec.md 改动与其 CHANGELOG 同 commit（P4 起由 sync-check 机械执法）。

## 命令速查

引擎：`node .kimi-base/runtime/kimi-base.mjs <verb>`。日常：`catalog lint` · `catalog discover` · `arch check` · `adr check` · `fitness` · `gate` · `dod` · `quality status` · `task start/status/complete` · `impact --git` · `review pack/start/blue/lens/verdict/status/team/backlog` · `recap` · `invariants` · `sync-check` · `spec lint/view` · `trace` · `rules-audit` · `skills-lint` · `agents-lint` · `cochange` · `budget` · `fleet` · `release` · `archive` · `doctor .` · `selftest`。全量语义见 `docs/OPERATIONS.md` 与 `docs/PROTOCOLS.md`。

## 目录地图

- `.kimi-base/runtime/` 引擎（薄路由 kimi-base.mjs + lib/* 模块 + supervisor.mjs）
- `.kimi-base/audit/` 独立审计脚本（禁 import 引擎）· `.kimi-base/githooks/` 第二道闸（`install --hooks` 挂载）
- `.kimi-base/rules/` 下沉细则 · `.kimi-base/templates/` 文档模板 · `.kimi-base/adapters.json` 外部工具目录
- `.kimi-code/` 8 agents + 16 skills（既是本仓 dogfood 也是安装载荷）
- `plugin/` 斜杠命令 + sessionStart skill · `tests/` 行为测试 · `docs/` 手册与 ADR

## 记忆

`progress.md` 是唯一项目记忆：Pinned 不可自动修订；Decisions 只追加且必须写被否方案；Done 必须带证据指针；>100 条归档不删除。
