/**
 * tests/cli-contracts.test.mjs
 * REQ-056 CLI 契约注册表（ADR-0011 docs/adr/0011-cli-contracts-and-planned-marker.md）行为测试。
 *
 * 运行：node --test tests/cli-contracts.test.mjs
 *
 * 纪律（同 spec.test.mjs）：临时 git 仓/临时目录夹具、断言退出码与输出字段、不依赖
 * .kimi-base/state/ 残留。本文件未使用夹具需求 id（无 spec 夹具）；凡引用本仓 REQ-056 /
 * REQ-058 均为真实追溯，非拼接夹具 id。
 *
 * REQ-058 扩表（P6，测试作者面）：feedback 动词（record/list/scan/propose）入锁定集
 * ——39+help → 40+help。扩表只加表项与专条用例，既有断言语义不变（全部用例表驱动，
 * 自动随表扩展）。扩表先行于实现（红测先行），feedback 已随 P6 落地，本组现为注册表契约锁定。
 *
 * 断言输出的特别说明：REQ-056 契约 3/4/5/6 显式要求"exit 1 且输出列出合法 flag 集/
 * 点名重复 flag/点名空值 flag/裸 token 归为位置参数"。usageError 走 stderr，故这些用例
 * 断言 out(r)=stdout+stderr 中的字段性 token（flag 名、位置参数名），不断言整句文案。
 *
 * 红测先行记录：REQ-056 落地前「现状锁定」组绿、「契约注册表/新行为」组红
 * （红因=文件缺失/行为缺失）；实现落地后全组转绿，现为契约回归锁。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(REPO, '.kimi-base', 'runtime', 'kimi-base.mjs');
const CLI_LIB = path.join(REPO, '.kimi-base', 'runtime', 'lib', 'cli.mjs');
const CONTRACTS_PATH = path.join(REPO, '.kimi-base', 'runtime', 'lib', 'cli-contracts.mjs');
const RUNTIME_OK = fs.existsSync(RUNTIME) && fs.readFileSync(RUNTIME, 'utf8').includes('process.argv');
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪' };

// ---------------- 基础辅助（同 spec.test.mjs 惯例） ----------------

function mkdtemp(t, prefix = 'kimi-base-cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
    } catch (e) {
      t.diagnostic(`临时目录清理失败（残留由 OS 回收）: ${dir} — ${e.code ?? e.message}`);
    }
  });
  return dir;
}

function run(args, opts = {}) {
  const { cwd = REPO, env = {}, input, timeout = 30_000 } = opts;
  const r = spawnSync(process.execPath, [RUNTIME, ...args], {
    cwd,
    input,
    timeout,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  if (r.error) throw new Error(`CLI 启动失败（${args.join(' ')}）: ${r.error.message}`);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// usageError 走 stderr；REQ-056 要求断言错误输出里的字段性 token，用合并视图。
const out = (r) => `${r.stdout}\n${r.stderr}`;

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function git(dir, ...args) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'kimi-base-test',
      GIT_AUTHOR_EMAIL: 'kimi-base-test@example.com',
      GIT_COMMITTER_NAME: 'kimi-base-test',
      GIT_COMMITTER_EMAIL: 'kimi-base-test@example.com',
      GIT_INIT_DEFAULT_BRANCH: 'main',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
}
function needGit(t) {
  if (!GIT_OK) {
    t.skip('环境无 git，按纪律显式跳过');
    return false;
  }
  return true;
}

/** 仅含 harness.json 的最小项目夹具（needProject 只要求 CONFIG_REL 存在）。 */
function harnessFixture(t) {
  const dir = mkdtemp(t);
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1 }, null, 2));
  return dir;
}

// ---------------- REQ-056 契约 2：41 个 verb 的 flag 现状表 ----------------
// 逐 verb 从 cli.mjs KNOWN_FLAGS（156-196 行）抄准 flag 名；kind 按 dispatchCommand
// 内实际消费方式判定：消费字符串值（String()/Number()/csv()/直接传递）= value，
// 只判断真值（Boolean()/if(flags.x)）= boolean。全局 flag：project=value（路径）、
// help=boolean（只判真值）。
// 表内 40 个 dispatch verb；第 41 个 verb 是 help（全局帮助，无自有 flag）。
// 第 40 个 dispatch verb = feedback（REQ-058，ADR-0010）：flag 粒度与注册表现状一致——
// 按 verb 并集登记（record 的 --topic/--type/--description + propose 的 --skip，均 value；
// list/scan 无自有 flag），子命令级 flag 约束由 dispatch 内部校验，不进本表。

const EXPECTED_FLAGS = {
  install: { 'dry-run': 'boolean', target: 'value', hooks: 'boolean' },
  upgrade: { 'dry-run': 'boolean', target: 'value', hooks: 'boolean' },
  uninstall: { 'dry-run': 'boolean', target: 'value' },
  manifest: { write: 'boolean', check: 'boolean' },
  doctor: { target: 'value' },
  'pack-check': {},
  // author（task start --author，REQ-057）：扩表先行于实现，已随 P5 落地转正。
  task: { goal: 'value', owned: 'value', risk: 'value', author: 'value' },
  gate: { risk: 'value', kind: 'value', 'dry-run': 'boolean' },
  quality: { check: 'value', approver: 'value', reason: 'value', expires: 'value', compensation: 'value' },
  waiver: { check: 'value', approver: 'value', reason: 'value', expires: 'value', compensation: 'value' },
  arch: { scan: 'boolean', write: 'boolean', reason: 'value', record: 'boolean', gate: 'boolean' },
  adr: {},
  catalog: { paths: 'value', write: 'boolean', depth: 'value' },
  fitness: { path: 'value', staged: 'boolean', all: 'boolean' },
  impact: { git: 'boolean', risk: 'value' },
  context: { budget: 'value', focus: 'value' },
  receipt: {},
  review: { base: 'value', 'ad-hoc': 'boolean', reviewer: 'value', notes: 'value' },
  fast: {},
  risk: {},
  'gate-audit': {},
  retention: { 'dry-run': 'boolean' },
  hook: {},
  'init-modules': { write: 'boolean' },
  recap: { budget: 'value' },
  invariants: {},
  archive: { apply: 'boolean', 'keep-done': 'value', 'keep-notes': 'value' },
  'sync-check': { staged: 'boolean', paths: 'value' },
  spec: { paths: 'value', all: 'boolean', budget: 'value' },
  trace: {},
  'rules-audit': { files: 'value' },
  'skills-lint': {},
  'agents-lint': {},
  dod: {},
  selftest: {},
  cochange: { limit: 'value', 'min-pairs': 'value', ratio: 'value' },
  budget: { staged: 'boolean', baseline: 'value' },
  fleet: { fleet: 'value', deep: 'boolean', budget: 'value' },
  release: {},
  // REQ-058 feedback 动词族（ADR-0010）：record --topic/--type/--description、
  // propose --skip，均按 dispatch 消费方式判 value；verb 并集登记（注册表现状粒度）。
  feedback: { topic: 'value', type: 'value', description: 'value', skip: 'value' },
};
const DISPATCH_VERBS = Object.keys(EXPECTED_FLAGS); // 40 个；第 41 个 = help
const GLOBAL_FLAG_NAMES = ['project', 'help'];

/** flag token 出现断言（--name 后不接词字符，防 --risk 误配 --riskx）。 */
function assertFlagToken(text, name, label) {
  assert.match(text, new RegExp(`--${name}(?![\\w-])`), `${label}：输出应列出 --${name}\n实际输出：${text}`);
}

// ---------------- 现状锁定（REQ-056 契约 2/3，写测时点应绿） ----------------

describe('REQ-056 现状锁定：flag 表与未知 flag 拒绝', () => {
  test('40 个 dispatch verb 逐一：未知 flag exit 1 且输出列出该 verb 合法 flag 集（含全局 project/help）', RT, (t) => {
    // REQ-058 注记：feedback 入表后本循环自动覆盖之（表驱动），合法 flag 集
    // （--topic/--type/--description/--skip + 全局）逐 token 锁定。
    for (const verb of DISPATCH_VERBS) {
      const r = run([verb, '--zzz-contract-probe']);
      assert.equal(r.code, 1, `${verb}：未知 flag 应 exit 1，实得 ${r.code}\n${out(r)}`);
      const text = out(r);
      for (const name of [...Object.keys(EXPECTED_FLAGS[verb]), ...GLOBAL_FLAG_NAMES]) {
        assertFlagToken(text, name, `${verb} 合法 flag 集`);
      }
      // 现状报文形如「支持的 flag：--a --b ...」；若该段可提取则做精确集合对账，
      // 既锁"不少列"也锁"不多列"（单源派生后清单不得漂移）。
      const seg = text.match(/支持的 flag：([^\n]+)/);
      if (seg) {
        const listed = seg[1].trim().split(/\s+/).filter(Boolean).sort();
        const expected = [...Object.keys(EXPECTED_FLAGS[verb]), ...GLOBAL_FLAG_NAMES].map((n) => `--${n}`).sort();
        assert.deepEqual(listed, expected, `${verb}：列出的合法 flag 集与现状表不一致`);
      }
    }
  });

  test('value flag 吞值与 boolean flag 相邻的混排解析保持现状', RT, () => {
    // --risk 是 value flag，吞掉 high；--zzz 仍被识别为未知 flag。
    const valued = run(['gate', '--risk', 'high', '--zzz-contract-probe']);
    assert.equal(valued.code, 1);
    assertFlagToken(out(valued), 'zzz-contract-probe', 'gate 未知 flag 报文');
    // --dry-run 是 boolean，后接另一个 --flag 不受影响，未知 flag 仍被拒。
    const adjacent = run(['gate', '--dry-run', '--zzz-contract-probe']);
    assert.equal(adjacent.code, 1);
    assertFlagToken(out(adjacent), 'zzz-contract-probe', 'gate 未知 flag 报文');
  });

  test('boolean flag 相邻：fitness --all --staged 正常执行（修复吞 token 不得回归此用例）', RT, (t) => {
    if (!needGit(t)) return;
    const dir = harnessFixture(t);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture init');
    const r = run(['fitness', '--all', '--staged'], { cwd: dir });
    assert.equal(r.code, 0, `fitness --all --staged 应正常执行\n${out(r)}`);
    assert.match(r.stdout, /fitness/);
  });

  test('manifest --write 与 --check 互斥 exit 1（现状冲突规则锁）', RT, () => {
    const r = run(['manifest', '--write', '--check']);
    assert.equal(r.code, 1);
    assert.match(out(r), /互斥/);
  });

  test('未知动词 exit 1', RT, () => {
    const r = run(['zzz-no-such-verb']);
    assert.equal(r.code, 1);
    assert.match(out(r), /未知动词/);
  });

  test('41 个 verb 的 --help 全部 exit 0 且输出非空（help 清单单源派生后不得丢 verb）', RT, () => {
    for (const verb of [...DISPATCH_VERBS, 'help']) {
      const r = run([verb, '--help']);
      assert.equal(r.code, 0, `${verb} --help 应 exit 0，实得 ${r.code}\n${out(r)}`);
      assert.ok(r.stdout.trim().length > 0, `${verb} --help 输出不应为空`);
    }
  });

  test('feedback 专条：未知 flag exit 1 且点名该 flag 并列出合法集、不报「未知动词」（REQ-058 扩表）', RT, () => {
    // 与表驱动循环互补的防假绿专条：循环里 feedback 的 exit 1 可被「未知动词」凑出，
    // 本条显式断言点名违规 flag 且不报「未知动词」（同 tests/feedback.test.mjs 纪律）——
    // 只有 feedback 已注册入契约，报文才会点名 flag 而非动词。
    const r = run(['feedback', 'list', '--zzz-contract-probe']);
    assert.equal(r.code, 1, `未知 flag 应 exit 1，实得 ${r.code}\n${out(r)}`);
    assertFlagToken(out(r), 'zzz-contract-probe', 'feedback 未知 flag 报文');
    for (const name of ['topic', 'type', 'description', 'skip', ...GLOBAL_FLAG_NAMES]) {
      assertFlagToken(out(r), name, 'feedback 合法 flag 集');
    }
    assert.doesNotMatch(out(r), /未知动词/, `契约校验失败不得报「未知动词」（证明 feedback 已注册）\n实际输出：${out(r)}`);
  });
});

// ---------------- 契约注册表（REQ-056 契约 1/2：单源派生回归锁） ----------------

describe('REQ-056 契约注册表：单源派生', () => {
  test('.kimi-base/runtime/lib/cli-contracts.mjs 存在并导出冻结 CONTRACTS', RT, async () => {
    assert.ok(
      fs.existsSync(CONTRACTS_PATH),
      `缺失 ${path.relative(REPO, CONTRACTS_PATH)}——REQ-056 要求新增 CLI 契约注册表（本用例红因=文件缺失）`
    );
    const mod = await import(CONTRACTS_PATH);
    assert.ok(mod.CONTRACTS, 'cli-contracts.mjs 必须导出 CONTRACTS');
    assert.ok(Object.isFrozen(mod.CONTRACTS), 'CONTRACTS 必须冻结（Object.freeze）');
  });

  test('CONTRACTS 逐 verb 形状 {usage, flags{name:{kind}}} 且 40 个既有 verb 的 flag 名/kind 与现状表逐条一致', RT, async (t) => {
    if (!fs.existsSync(CONTRACTS_PATH)) {
      assert.fail(`缺失 ${path.relative(REPO, CONTRACTS_PATH)}——无法校验契约表（本用例红因=文件缺失）`);
    }
    const { CONTRACTS } = await import(CONTRACTS_PATH);
    for (const verb of DISPATCH_VERBS) {
      const entry = CONTRACTS[verb];
      assert.ok(entry, `CONTRACTS 缺 verb：${verb}`);
      assert.equal(typeof entry.usage, 'string', `${verb}.usage 必须是字符串`);
      assert.ok(entry.usage.trim().length > 0, `${verb}.usage 不应为空`);
      assert.ok(entry.flags && typeof entry.flags === 'object', `${verb}.flags 必须是对象`);
      const expected = EXPECTED_FLAGS[verb];
      assert.deepEqual(
        Object.keys(entry.flags).sort(),
        Object.keys(expected).sort(),
        `${verb}：契约 flag 名集与现状表不一致`
      );
      for (const [name, spec] of Object.entries(entry.flags)) {
        assert.ok(spec && typeof spec === 'object', `${verb}.flags.${name} 必须是对象 {kind}`);
        assert.equal(spec.kind, expected[name], `${verb}.flags.${name}.kind 应为 ${expected[name]}（按 dispatch 消费方式判定）`);
      }
      // 可选字段形状（存在才校验）：conflicts/requires 为数组。
      for (const opt of ['conflicts', 'requires']) {
        if (entry[opt] !== undefined) assert.ok(Array.isArray(entry[opt]), `${verb}.${opt} 必须是数组`);
      }
    }
    // 防漂移：除 40 个 dispatch verb 外只允许 help（第 41 个 verb）入账。
    const extra = Object.keys(CONTRACTS).filter((k) => !DISPATCH_VERBS.includes(k) && k !== 'help');
    assert.deepEqual(extra, [], `CONTRACTS 出现现状表外 verb：${extra.join(', ')}`);
  });

  test('cli.mjs 单源派生：引用 cli-contracts 且不再自带 KNOWN_FLAGS 字面量表', RT, () => {
    const src = fs.readFileSync(CLI_LIB, 'utf8');
    assert.ok(
      /cli-contracts/.test(src),
      'cli.mjs 未引用 cli-contracts.mjs——dispatch/flag 校验/help 必须从契约表单源派生（本用例红因=未派生）'
    );
    assert.ok(
      !/const KNOWN_FLAGS\s*=\s*\{/.test(src),
      'cli.mjs 仍自带 KNOWN_FLAGS 字面量表——两份注册是漂移源，须单源派生'
    );
  });
});

// ---------------- 新行为（REQ-056 契约 4/5/6：严格 flag 校验回归锁） ----------------

describe('REQ-056 新行为：严格 flag 校验', () => {
  test('重复 flag：gate --risk high --risk low exit 1 且点名重复', RT, (t) => {
    // 非项目目录：与未知 flag 同类（用法错误），校验必须先于项目根解析；
    // 锁定：重复 flag 必须 exit 1 并点名（旧缺陷：parseCliArgs 静默覆盖、后者赢）。
    const dir = mkdtemp(t);
    const r = run(['gate', '--risk', 'high', '--risk', 'low'], { cwd: dir });
    assert.equal(r.code, 1, `重复 flag 应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.match(out(r), /重复/, `输出应点名"重复"\n实际输出：${out(r)}`);
    assertFlagToken(out(r), 'risk', '重复 flag 报文');
  });

  test('value flag 空值：task --goal= exit 1 且点名空值', RT, (t) => {
    // 锁定：value flag 空值必须 exit 1 并点名（旧缺陷：--goal= 解析为空字符串后直接放行）。
    const dir = mkdtemp(t);
    const r = run(['task', 'start', '--goal='], { cwd: dir });
    assert.equal(r.code, 1, `空值 flag 应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.match(out(r), /空值|为空/, `输出应点名"空值"\n实际输出：${out(r)}`);
    assertFlagToken(out(r), 'goal', '空值 flag 报文');
  });
});

describe('REQ-056 新行为：boolean flag 不吞后续裸 token', () => {
  // 判定依据（读 dispatchCommand 全文后选定，与各 verb 契约一致）：
  // 旧缺陷：parseCliArgs 曾把 boolean flag 后的裸 token 吞成 flag 值（如 --scan bogus-sub
  // → flags.scan='bogus-sub'，位置参数丢失）——本组锁修复后语义，禁止回退成"bug 即契约"。
  // 契约：裸 token 归为位置参数。之后按 verb 的位置参数语义分流——
  //   · 子命令类 verb（arch/adr/catalog/context/receipt/retention/spec/task/quality/…）：
  //     现状对未知子命令本就 exit 1 并点名（如「未知 arch 子命令：bogus-sub」）；
  //     修复后裸 token 落到 sub，沿用同一报错路径 → exit 1 且输出含该 token。
  //   · 零位置参数 verb（gate/manifest/dod/selftest/trace/recap/invariants/cochange/…）：
  //     ADR-0011 契约含位置参数上下界，越界 = 用法错误 → exit 1 且输出含该 token。
  //   · 位置参数吃路径的 verb（fitness/impact/install 系）：裸 token 按路径位置参数处理，
  //     属正常输入（fitness --all --staged 相邻用例已在现状锁定组保证不回归）。

  test('子命令类 verb：retention --dry-run bogus exit 1 且点名 bogus', RT, (t) => {
    // retention 的子命令校验在 needProject 之前（现状顺序），无需项目夹具。
    // 锁定：裸 token bogus 必须归为位置参数并被子命令校验点名（旧缺陷：--dry-run 吞掉 bogus
    // → sub=undefined → 报「未知 retention 子命令：<缺>」——exit 1 对但点错了名）。
    const dir = mkdtemp(t);
    const r = run(['retention', '--dry-run', 'bogus'], { cwd: dir });
    assert.equal(r.code, 1, `应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('bogus'), `裸 token bogus 应归为位置参数并被子命令校验点名\n实际输出：${out(r)}`);
  });

  test('子命令类 verb：arch --scan bogus-sub exit 1 且点名 bogus-sub', RT, (t) => {
    // arch 子命令校验在 needProject 之后（现状顺序），给最小 harness 夹具放行项目解析。
    // 锁定：裸 token bogus-sub 必须被点名（旧缺陷：--scan 吞掉 bogus-sub → 报「未知 arch 子命令：<缺>」）。
    const dir = harnessFixture(t);
    const r = run(['arch', '--scan', 'bogus-sub'], { cwd: dir });
    assert.equal(r.code, 1, `应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('bogus-sub'), `裸 token bogus-sub 应归为位置参数并被子命令校验点名\n实际输出：${out(r)}`);
  });

  test('零位置参数 verb：gate --dry-run extra exit 1 且点名 extra', RT, (t) => {
    // 非项目目录：位置参数上界校验与未知 flag 同类，必须先于项目根解析。
    // 锁定：extra 必须按位置参数越界点名（旧缺陷：extra 被吞成 --dry-run 的值 → PROJECT_ROOT_NOT_FOUND）。
    const dir = mkdtemp(t);
    const r = run(['gate', '--dry-run', 'extra'], { cwd: dir });
    assert.equal(r.code, 1, `应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('extra'), `零位置参数 verb 应报位置参数越界并点名 extra\n实际输出：${out(r)}`);
  });

  test('零位置参数 verb：manifest --check extra exit 1 且点名 extra', RT, (t) => {
    // 旧缺陷最直观形态：extra 被吞成 --check 的值，命令"正常"跑完 manifest check exit 0——
    // 拼错的多余参数静默生效。锁定：exit 1 点名 extra。
    const dir = mkdtemp(t);
    const r = run(['manifest', '--check', 'extra'], { cwd: dir });
    assert.equal(r.code, 1, `多余位置参数应 exit 1，实得 ${r.code}（现状吞 token 后假绿 exit 0）\n${out(r)}`);
    assert.ok(out(r).includes('extra'), `输出应点名 extra\n实际输出：${out(r)}`);
  });
});

// ---------------- selftest 双向钉死（REQ-056 契约 7：契约计数行回归锁） ----------------

describe('REQ-056 selftest 双向钉死', () => {
  test('selftest exit 0 且输出含契约校验计数行（contractCheck：每个路由有契约、每个契约有路由）', RT, () => {
    const r = run(['selftest']);
    assert.equal(r.code, 0, `selftest 应 exit 0\n${out(r)}`);
    // 字段名建议 contractCheck（给实现者留文案自由度）；计数行须体现契约双向钉死的
    // 覆盖数（路由数/契约数），且随自检项增加体现在通过计数里。
    assert.match(r.stdout, /contractCheck/, `selftest 输出缺契约校验计数行 contractCheck——红因=双向钉死未落地\n${r.stdout}`);
    assert.match(r.stdout, /selftest：(\d+)\/\1 通过/, `selftest 须全部通过（含契约校验项）\n${r.stdout}`);
  });
});
