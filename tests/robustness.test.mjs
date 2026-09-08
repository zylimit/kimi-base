/**
 * tests/robustness.test.mjs
 * P7 健壮性红测（零第三方依赖，node:test）：
 *   REQ-060 修复指令体（gate/dod/quality status 的 FAIL·BLOCKED 项 100% 带可执行 nextStep）
 *   REQ-061 quarantine 原语（运行态 JSON 损坏 → 隔离 .corrupt-<ts> + 事件记账 + 响亮报告）
 *   REQ-059 宪法瘦身（根 AGENTS.md ≤6000 字节预算锁定 + 细则下沉结构）
 *   回归：P0 rules-audit maxUnenforced 红锁（REQ-034，注入无执法规则 exit 1）保持。
 *
 * 运行：node --test tests/robustness.test.mjs
 *
 * 纪律：行为测试在临时 git 仓中跑，断言退出码与 stdout/JSON 字段，不断言 stderr 文本；
 * 每条用例独立临时目录，互不依赖。
 * 追溯：REQ-059（宪法瘦身与执法率门禁）REQ-060（修复指令体）REQ-061（quarantine 原语）
 *       REQ-034（rules-audit 回归锚点）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(REPO, '.kimi-base', 'runtime', 'kimi-base.mjs');
const RUNTIME_OK = fs.existsSync(RUNTIME) && fs.readFileSync(RUNTIME, 'utf8').includes('process.argv');
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪' };

function mkdtemp(t, prefix = 'kimi-base-robust-') {
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
const out = (r) => `${r.stdout}\n${r.stderr}`;

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

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
function gitInitCommit(dir) {
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture init');
}
function needGit(t) {
  if (!GIT_OK) {
    t.skip('环境无 git，按纪律显式跳过');
    return false;
  }
  return true;
}

const P = {
  harness: '.kimi-base/harness.json',
  matrix: '.kimi-base/verification-matrix.json',
  catalog: '.kimi-base/module-catalog.json',
  state: '.kimi-base/state',
};
function writeHarness(dir, extra = {}) {
  write(dir, P.harness, JSON.stringify({ version: 1, ...extra }, null, 2));
}
function writeMatrix(dir, checks) {
  write(dir, P.matrix, JSON.stringify({
    version: 1,
    riskKinds: { low: ['static'], medium: ['static'], high: ['static', 'security'] },
    checks,
  }, null, 2));
}
/** 基础夹具：git 仓 + marker + catalog + 验证矩阵（全部提交） */
function baseFixture(t, checks, harnessExtra = {}) {
  const dir = mkdtemp(t);
  writeHarness(dir, harnessExtra);
  write(dir, P.catalog, JSON.stringify({ version: 1, modules: [{ id: 'app', root: 'src', paths: ['**'] }] }, null, 2));
  writeMatrix(dir, checks);
  write(dir, 'src/a.js', 'export const a = 1;\n');
  gitInitCommit(dir);
  return dir;
}

const PASS_CHECK = { id: 'static-ok', kind: 'static', command: 'node -e "process.exit(0)"' };
const FAIL_CHECK = { id: 'fail-check', kind: 'static', command: 'node -e "process.exit(1)"' };
// 无 command/executable/builtin：schema 合法（command 允许缺省），运行时判 BLOCKED
const NO_COMMAND_CHECK = { id: 'blocked-check', kind: 'static' };

/**
 * 从输出中截取「某未过项」的文本块：从含 anchor 的条目行起，到下一条同级条目行
 * （`- PASS/FAIL/...` 或 `- [level]`）或文末。nextStep 允许在条目行本身或后续缩进行上。
 */
function blockFor(stdout, anchor) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.includes(anchor));
  assert.notEqual(start, -1, `输出必须包含条目「${anchor}」\n实际输出：${stdout}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- (PASS|FAIL|BLOCKED|SKIPPED|DEGRADED|STALE|covered|UNCOVERED)\b/.test(lines[i]) || /^- \[(high|medium|info)\]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * REQ-060 核心判定：块内必须有 nextStep，且 nextStep 指向具体动作——
 * 可执行命令（node/npm/引擎 verb）或具体文件路径，不接受空泛的「请检查/待确认」。
 */
function assertActionableNextStep(block, label) {
  assert.match(block, /nextStep[：:]/, `${label} 必须带 nextStep 字段（不得只报症状）\n实际块：${block}`);
  const value = block.slice(block.search(/nextStep[：:]/)).replace(/^nextStep[：:]\s*/, '').trim();
  assert.ok(value.length >= 8, `${label} 的 nextStep 不得为空泛短句\n实际块：${block}`);
  assert.ok(
    /(?:node|npm)\s|kimi-base\.mjs|[\w./-]+\.(?:json|md|mjs)|`[^`]+`/.test(value),
    `${label} 的 nextStep 必须指向具体动作（修复命令或文件路径），不得是「请检查」式空泛指引\n实际 nextStep：${value}`
  );
}

/** 列出 state 目录下某文件的隔离产物（*.corrupt-<ts>） */
function quarantinedSiblings(dir, stateFileName) {
  const stateDir = path.join(dir, P.state);
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir).filter((name) => new RegExp(`^${stateFileName.replace('.', '\\.')}\\.corrupt-\\d+$`).test(name));
}
function quarantineEvents(dir) {
  const file = path.join(dir, P.state, 'quarantine.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// ---------------- REQ-060 修复指令体 ----------------

describe('REQ-060 修复指令体：FAIL/BLOCKED 项必须带可执行 nextStep', RT, () => {
  test('gate：FAIL 与 BLOCKED 回执条目 100% 带 nextStep 且指向具体动作', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [FAIL_CHECK, NO_COMMAND_CHECK]);
    const r = run(['gate', '--risk', 'low'], { cwd: dir });
    assert.equal(r.code, 2, `gate 有 FAIL/BLOCKED 必须 exit 2，实际 ${r.code}\n${out(r)}`);
    assertActionableNextStep(blockFor(r.stdout, 'FAIL fail-check'), 'gate FAIL 条目 fail-check');
    assertActionableNextStep(blockFor(r.stdout, 'BLOCKED blocked-check'), 'gate BLOCKED 条目 blocked-check');
  });

  test('quality status：UNCOVERED 条目带 nextStep（指向接线动作/文件）', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    writeHarness(dir);
    // reliability 定档 high（受治理）但 matrix 中无任何检查认领 → 声明未接线 = 可见缺口
    write(dir, P.catalog, JSON.stringify({
      version: 1,
      modules: [{ id: 'app', root: 'src', paths: ['**'], attributes: { reliability: 'high' } }],
    }, null, 2));
    writeMatrix(dir, [PASS_CHECK]);
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    const r = run(['quality', 'status'], { cwd: dir });
    assert.equal(r.code, 2, `存在 uncovered 必须 exit 2，实际 ${r.code}\n${out(r)}`);
    assertActionableNextStep(blockFor(r.stdout, 'UNCOVERED reliability'), 'quality status UNCOVERED 条目 reliability');
  });

  test('dod：每个 FAIL 步骤带 nextStep（重跑命令或修复路径）', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    writeHarness(dir);
    // 损坏 catalog JSON → catalog-lint 与 arch-check 两步 FAIL
    write(dir, P.catalog, '{broken catalog');
    writeMatrix(dir, [PASS_CHECK]);
    write(dir, 'AGENTS.md', '# 夹具宪法\n\n最小合规 AGENTS.md。\n');
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    const r = run(['dod'], { cwd: dir, timeout: 240_000 });
    assert.equal(r.code, 2, `dod 存在 FAIL 步骤必须 exit 2，实际 ${r.code}\n${out(r)}`);
    const failLines = r.stdout.split('\n').filter((line) => /^- FAIL /.test(line));
    assert.ok(failLines.length >= 1, `dod 夹具必须至少产生一个 FAIL 步骤\n${out(r)}`);
    for (const line of failLines) {
      const stepId = line.replace(/^- FAIL /, '').split('（')[0];
      assertActionableNextStep(blockFor(r.stdout, `- FAIL ${stepId}`), `dod FAIL 步骤 ${stepId}`);
    }
  });
});

// ---------------- REQ-061 quarantine 原语 ----------------

describe('REQ-061 quarantine 原语：损坏运行态 JSON 必须隔离+记账+响亮报告', RT, () => {
  test('tasks.json 损坏 → task status 隔离为 .corrupt-<ts>、记 quarantine 事件、不静默重建', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    write(dir, `${P.state}/tasks.json`, '{broken tasks json');
    const r = run(['task', 'status'], { cwd: dir });
    assert.equal(r.code, 0, `损坏 tasks.json 不得拖死 task status，实际 exit ${r.code}\n${out(r)}`);
    // 隔离：损坏原件被挪为 .corrupt-<ts>，证据保留
    const quarantined = quarantinedSiblings(dir, 'tasks.json');
    assert.equal(quarantined.length, 1, `tasks.json 必须被隔离为 tasks.json.corrupt-<ts>，state 目录实际：${fs.readdirSync(path.join(dir, P.state)).join(', ')}`);
    // 不静默重建：读路径不得悄悄写回一份"健康"空账本
    assert.ok(!exists(dir, `${P.state}/tasks.json`), '损坏的 tasks.json 不得在读取时被静默重建（重建必须显式可见）');
    // 事件记账：quarantine.jsonl 必须留痕
    const events = quarantineEvents(dir);
    assert.ok(events.some((event) => event.file === 'tasks.json'), `quarantine.jsonl 必须记录 tasks.json 隔离事件，实际：${JSON.stringify(events)}`);
    // 响亮报告：risk scan 必须把隔离事实浮出为高危
    const risk = run(['risk', 'scan'], { cwd: dir });
    assert.equal(risk.code, 2, `存在 quarantine 事件时 risk scan 必须 exit 2（高危可见），实际 ${risk.code}\n${out(risk)}`);
    assert.match(risk.stdout, /state-quarantined/, `risk scan 输出必须点名 state-quarantined\n${out(risk)}`);
    assert.match(risk.stdout, /tasks\.json\.corrupt-/, `risk scan 输出必须给出隔离产物文件名\n${out(risk)}`);
  });

  test('fast-mode.json 损坏 → risk scan 隔离+记账（不得按健康 fast 状态使用）', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    write(dir, `${P.state}/fast-mode.json`, 'not json at all');
    const risk = run(['risk', 'scan'], { cwd: dir });
    const quarantined = quarantinedSiblings(dir, 'fast-mode.json');
    assert.equal(quarantined.length, 1, `fast-mode.json 必须被隔离为 .corrupt-<ts>，state 目录实际：${fs.readdirSync(path.join(dir, P.state)).join(', ')}`);
    assert.ok(quarantineEvents(dir).some((event) => event.file === 'fast-mode.json'), 'quarantine.jsonl 必须记录 fast-mode.json 隔离事件');
    assert.equal(risk.code, 2, `隔离事件必须使 risk scan 高危 exit 2，实际 ${risk.code}\n${out(risk)}`);
    assert.match(risk.stdout, /state-quarantined/, out(risk));
  });

  test('ledger-head.json 损坏 → risk scan 隔离为 .corrupt-<ts> 并记 quarantine 事件（不静默兜底）', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    write(dir, `${P.state}/ledger-head.json`, '{corrupt anchor!!!');
    const risk = run(['risk', 'scan'], { cwd: dir });
    // 响亮报告（篡改面告警已存在，保持）
    assert.equal(risk.code, 2, `head 锚不可解析必须响亮 exit 2，实际 ${risk.code}\n${out(risk)}`);
    // REQ-061：任何运行态 JSON 损坏都必须走 quarantine 原语——隔离 + 事件记账，
    // 不得只在内存里打 __corrupt 标记静默兜底（锚证据必须保留在 .corrupt-<ts> 供 forensic）
    const quarantined = quarantinedSiblings(dir, 'ledger-head.json');
    assert.equal(quarantined.length, 1, `ledger-head.json 必须被隔离为 .corrupt-<ts>，state 目录实际：${fs.readdirSync(path.join(dir, P.state)).join(', ')}`);
    assert.ok(quarantineEvents(dir).some((event) => event.file === 'ledger-head.json'), 'quarantine.jsonl 必须记录 ledger-head.json 隔离事件');
  });

  test('并发隔离竞抢：N 进程同时触发同一损坏文件隔离，无崩溃、产物恰好一个、记账在', async (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    // 损坏点放在大文件尾部：JSON.parse 必须扫完全文才抛错，read→rename 竞抢窗口被拉大，
    // 5 个并发进程必然重叠（评审实证：并发触发同一文件隔离时输家 rename ENOENT 崩溃 exit 3）。
    write(dir, `${P.state}/tasks.json`, `{"version":1,"pad":"${'x'.repeat(2 * 1024 * 1024)}`);
    const N = 5;
    const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RUNTIME, 'task', 'status'], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1' }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    })));
    for (const r of results) {
      assert.notEqual(r.code, 3, `并发隔离竞抢不得崩溃 exit 3（输家 ENOENT 必须容忍）：${r.stderr}`);
      assert.ok(!r.stderr.includes('ENGINE_ERROR'), `并发隔离竞抢不得 ENGINE_ERROR：${r.stderr}`);
    }
    // 隔离恰好发生一次：产物一个 .corrupt-*（赢家独占），损坏源文件不复存在
    const quarantined = quarantinedSiblings(dir, 'tasks.json');
    assert.equal(quarantined.length, 1, `并发隔离产物必须恰好一个 .corrupt-*，state 目录实际：${fs.readdirSync(path.join(dir, P.state)).join(', ')}`);
    assert.ok(!exists(dir, `${P.state}/tasks.json`), '损坏源文件必须已被隔离走');
    // 记账在：quarantine.jsonl 至少留一条 tasks.json 隔离事件
    assert.ok(
      quarantineEvents(dir).some((event) => event.file === 'tasks.json'),
      `quarantine.jsonl 必须记录 tasks.json 隔离事件，实际：${JSON.stringify(quarantineEvents(dir))}`
    );
  });
});

// ---------------- REQ-059 宪法瘦身 ----------------

describe('REQ-059 宪法瘦身：根 AGENTS.md ≤6000 字节预算与细则下沉结构', RT, () => {
  test('本仓 AGENTS.md 不超 6000 字节且引用 .kimi-base/rules/（地图非手册）', () => {
    const file = path.join(REPO, 'AGENTS.md');
    const bytes = fs.statSync(file).size;
    assert.ok(bytes <= 6000, `根 AGENTS.md 必须 ≤6000 字节（宪法只放不变量+指针，细则下沉 .kimi-base/rules/），实际 ${bytes} 字节`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('.kimi-base/rules/'), 'AGENTS.md 必须引用 .kimi-base/rules/ 作为细则下沉面（地图非手册结构）');
  });

  test('agents-lint 体积预算锁定 6000：超限 exit 1；预算内 exit 0', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    // 约 8100 字节：超 REQ-059 的 6000 预算，但低于现行 12000 warning 线——
    // 该用例锁定的是 REQ-059 预算本身，不依赖现行阈值
    write(dir, 'AGENTS.md', `# 宪法\n\n${'宪'.repeat(2700)}\n`);
    const oversize = run(['agents-lint'], { cwd: dir });
    assert.equal(oversize.code, 1, `AGENTS.md 超 6000 字节预算必须 exit 1，实际 ${oversize.code}\n${out(oversize)}`);
    write(dir, 'AGENTS.md', '# 宪法\n\n短小精悍。\n');
    const ok = run(['agents-lint'], { cwd: dir });
    assert.equal(ok.code, 0, `预算内 AGENTS.md 必须 exit 0，实际 ${ok.code}\n${out(ok)}`);
  });
});

// ---------------- 回归：P0 rules-audit 红锁保持（REQ-034） ----------------

describe('回归：rules-audit maxUnenforced 红锁保持', RT, () => {
  const CONSTITUTION = [
    '# 测试宪法',
    '',
    '## 规则',
    '',
    '1. 一切变更必须先跑 `gate` 拿到 fresh receipt 之后才允许声称完成，没有例外。',
    '2. 命名要见名知义、避免缩写歧义，这一条是提示词纪律（prompt-only）。',
    '3. 周五下午不得合并任何代码除非线上起火，否则一律等到下周一再说。',
    '',
  ].join('\n');

  test('maxUnenforced=0 注入无执法规则 → exit 1', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir, { rulesAudit: { maxUnenforced: 0 } });
    write(dir, 'AGENTS.md', CONSTITUTION);
    const r = run(['rules-audit'], { cwd: dir });
    assert.equal(r.code, 1, `无执法规则超阈必须 exit 1，实际 ${r.code}\n${out(r)}`);
    assert.match(r.stdout, /无执法 1/, out(r));
  });
});
