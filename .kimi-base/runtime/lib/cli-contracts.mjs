// lib/cli-contracts.mjs —— CLI 契约注册表（REQ-056 / ADR-0011）
//
// 单源事实：dispatch 路由、flag 白名单校验、help 清单、selftest 双向钉死全部从本表派生，
// cli.mjs 不再自带 KNOWN_FLAGS 字面量表（两份注册 = 漂移源）。
// 每条契约：{ usage, positional:{min,max}, flags:{name:{kind}}, conflicts?: string[][] }
//   kind='value'   —— dispatch 消费字符串值（String()/Number()/csv()/直接传递），解析时吞下一个裸 token；
//   kind='boolean' —— dispatch 只判真值（Boolean()/if(flags.x)），解析时不吞后续裸 token。
// flag 名/kind 与行为测试 tests/cli-contracts.test.mjs 的现状表逐条对账，改名 = 向后兼容破坏。

const value = { kind: 'value' };
const boolean = { kind: 'boolean' };

export const GLOBAL_FLAGS = Object.freeze({
  project: value,   // 项目根查找起点（路径）
  help: boolean     // 只判真值
});

export const CONTRACTS = Object.freeze({
  install: { usage: 'install <target> [--dry-run] [--hooks]', positional: { min: 0, max: 1 }, flags: { 'dry-run': boolean, target: value, hooks: boolean } },
  upgrade: { usage: 'upgrade <target> [--dry-run] [--hooks]', positional: { min: 0, max: 1 }, flags: { 'dry-run': boolean, target: value, hooks: boolean } },
  uninstall: { usage: 'uninstall <target> [--dry-run]', positional: { min: 0, max: 1 }, flags: { 'dry-run': boolean, target: value } },
  manifest: { usage: 'manifest --write|--check', positional: { min: 0, max: 0 }, flags: { write: boolean, check: boolean }, conflicts: [['write', 'check']] },
  doctor: { usage: 'doctor [target]', positional: { min: 0, max: 1 }, flags: { target: value } },
  'pack-check': { usage: 'pack-check', positional: { min: 0, max: 0 }, flags: {} },
  task: { usage: 'task start --goal G --owned "g,g" --risk low|medium|high | task status|complete|cancel', positional: { min: 0, max: 1 }, flags: { goal: value, owned: value, risk: value } },
  gate: { usage: 'gate [--risk R] [--kind K] [--dry-run]', positional: { min: 0, max: 0 }, flags: { risk: value, kind: value, 'dry-run': boolean } },
  quality: { usage: 'quality status | quality waiver create --check K --approver X --reason R --expires ISO --compensation C | quality waiver list', positional: { min: 0, max: 2 }, flags: { check: value, approver: value, reason: value, expires: value, compensation: value } },
  waiver: { usage: 'waiver create|list（quality waiver 的顶层别名）', positional: { min: 0, max: 2 }, flags: { check: value, approver: value, reason: value, expires: value, compensation: value } },
  arch: { usage: 'arch check [--scan] | arch baseline --write [--reason R] | arch trend --record|--gate', positional: { min: 0, max: 1 }, flags: { scan: boolean, write: boolean, reason: value, record: boolean, gate: boolean } },
  adr: { usage: 'adr check', positional: { min: 0, max: 1 }, flags: {} },
  catalog: { usage: 'catalog lint [--paths a,b] | catalog discover [--write] [--depth N]', positional: { min: 0, max: 1 }, flags: { paths: value, write: boolean, depth: value } },
  fitness: { usage: 'fitness [--path p1,p2] [--staged] [--all] [paths...]', positional: { min: 0, max: Infinity }, flags: { path: value, staged: boolean, all: boolean } },
  impact: { usage: 'impact <paths...> | impact --git [--risk R]', positional: { min: 0, max: Infinity }, flags: { git: boolean, risk: value } },
  context: { usage: 'context pack [--budget N] [--focus "g,g"]', positional: { min: 0, max: 1 }, flags: { budget: value, focus: value } },
  receipt: { usage: 'receipt verify', positional: { min: 0, max: 1 }, flags: {} },
  review: { usage: 'review start [--base R] | blue | lens <n> [--ad-hoc] | verdict [--reviewer X] [--notes T] | status | team | backlog add|list | pack', positional: { min: 0, max: 2 }, flags: { base: value, 'ad-hoc': boolean, reviewer: value, notes: value } },
  fast: { usage: 'fast on [hours]|off|status', positional: { min: 0, max: 2 }, flags: {} },
  risk: { usage: 'risk scan', positional: { min: 0, max: 1 }, flags: {} },
  'gate-audit': { usage: 'gate-audit', positional: { min: 0, max: 0 }, flags: {} },
  retention: { usage: 'retention prune [--dry-run]', positional: { min: 0, max: 1 }, flags: { 'dry-run': boolean } },
  hook: { usage: 'hook <event>（stdin 读 JSON 载荷）', positional: { min: 0, max: 1 }, flags: {} },
  'init-modules': { usage: 'init-modules [--write]（已废弃别名，转发 catalog discover）', positional: { min: 0, max: 0 }, flags: { write: boolean } },
  recap: { usage: 'recap [--budget N]', positional: { min: 0, max: 0 }, flags: { budget: value } },
  invariants: { usage: 'invariants', positional: { min: 0, max: 0 }, flags: {} },
  archive: { usage: 'archive [--apply] [--keep-done N] [--keep-notes N]', positional: { min: 0, max: 0 }, flags: { apply: boolean, 'keep-done': value, 'keep-notes': value } },
  'sync-check': { usage: 'sync-check [--staged] [--paths a,b]', positional: { min: 0, max: 0 }, flags: { staged: boolean, paths: value } },
  spec: { usage: 'spec lint | spec view [--paths a,b|--all] [--budget N]', positional: { min: 0, max: 1 }, flags: { paths: value, all: boolean, budget: value } },
  trace: { usage: 'trace', positional: { min: 0, max: 0 }, flags: {} },
  'rules-audit': { usage: 'rules-audit [--files a,b]', positional: { min: 0, max: 0 }, flags: { files: value } },
  'skills-lint': { usage: 'skills-lint', positional: { min: 0, max: 0 }, flags: {} },
  'agents-lint': { usage: 'agents-lint', positional: { min: 0, max: 0 }, flags: {} },
  dod: { usage: 'dod', positional: { min: 0, max: 0 }, flags: {} },
  selftest: { usage: 'selftest', positional: { min: 0, max: 0 }, flags: {} },
  cochange: { usage: 'cochange [--limit N] [--min-pairs N] [--ratio F]', positional: { min: 0, max: 0 }, flags: { limit: value, 'min-pairs': value, ratio: value } },
  budget: { usage: 'budget [--staged|--baseline ref]', positional: { min: 0, max: 0 }, flags: { staged: boolean, baseline: value } },
  fleet: { usage: 'fleet lint|impact <contract>|status|recap [--fleet path] [--deep] [--budget N]', positional: { min: 0, max: 2 }, flags: { fleet: value, deep: boolean, budget: value } },
  release: { usage: 'release', positional: { min: 0, max: 0 }, flags: {} },
  // REQ-058 feedback 动词族（ADR-0010）：record --topic/--type/--description、propose --skip，
  // 均按 dispatch 消费方式判 value；verb 并集登记，子命令级约束由 dispatch 内部校验。
  feedback: { usage: 'feedback record --topic T --type Y --description D | list | scan | propose [--skip T]', positional: { min: 1, max: 1 }, flags: { topic: value, type: value, description: value, skip: value } },
  // 第 41 个 verb：全局帮助，无自有 flag；dispatch 在契约校验前短路处理。
  help: { usage: 'help', positional: { min: 0, max: 0 }, flags: {} }
});

// REQ-052 strength 动词族契约（ADR-0008）。单列导出而不入 CONTRACTS：CONTRACTS 键集被
// REQ-056 现状表行为测试（tests/cli-contracts.test.mjs 的 EXPECTED_FLAGS/extra 断言）锁定为
// 40 dispatch verb + help，扩表属独立测试作者面；扩表落地后本条目应并入 CONTRACTS。
// cli.mjs 的 dispatch/flag 校验/help 对本契约的派生方式与 CONTRACTS 条目完全一致。
export const STRENGTH_CONTRACT = Object.freeze({
  usage: 'strength list | status | set --profile P | explain [--risk R] [--operation O] [--paths a,b]',
  positional: Object.freeze({ min: 1, max: 1 }),
  flags: Object.freeze({ profile: value, risk: value, operation: value, paths: value })
});

// 深冻结：契约是跨模块共享事实，运行期不可变。
for (const entry of Object.values(CONTRACTS)) {
  Object.freeze(entry.flags);
  for (const spec of Object.values(entry.flags)) Object.freeze(spec);
  Object.freeze(entry.positional);
  if (entry.conflicts) for (const group of entry.conflicts) Object.freeze(group);
  if (entry.requires) for (const group of entry.requires) Object.freeze(group);
  Object.freeze(entry);
}
