/**
 * tests/eval.test.mjs
 * REQ-066（自我 eval 套件）行为与结构测试——红测先行于实现。
 * 设计依据：Product-Spec.md REQ-066；独立性铁律承 docs/adr/0002（审计者不 import 引擎）。
 *
 * 运行：node --test tests/eval.test.mjs
 *
 * 纪律（同 audit.test.mjs / strength.test.mjs）：行为测试在临时 git 仓中跑真实子进程，
 * 断言退出码与 JSON 字段，不断言 stderr 文本，不依赖 .kimi-base/state/ 残留；
 * 环境无 git 时相关用例显式 t.skip()（不假绿）。
 *
 * 红测先行记录：写测时点 tests/eval/ 与 .kimi-base/audit/run-eval.mjs 均不存在，
 * 全部结构用例红（目录/清单缺失）+ 行为用例红（脚本不存在，spawn 失败）。
 *
 * 契约歧义点的选定解释（写测者选定，实现者可异议但须同步改测——测试不为迁就实现改断言）：
 *   1) 任务定义载体：REQ-066 允许"每个一个文件或一个清单文件"，本测试钉死为
 *      tests/eval/manifest.json 清单（{version, regression:[...], capability:[...]}），
 *      条目可以是内联任务对象或相对 tests/eval/ 的任务 JSON 文件路径——两套分列由此
 *      机器可区分。实现若选纯散文件方案须同步改 loadSuite()，不得删断言。
 *   2) 任务字段：id/name/description/expected/judge/trace 六字段齐备；judge 二选一
 *      （command 非空字符串 XOR assertFile 相对路径字符串），不允许"人工看一眼"。
 *   3) 计数口径（P10 评审修订）：门槛钉在 regression 单列——regression ≥20 且非空，
 *      capability 不计入门槛。修订理由：原「两套合计 ≥20」口径可被 capability 注水绕过
 *      （regression 空套 + 20 个 capability 也 exit 0；regression 砍到 17 个、用 capability
 *      补齐仍全绿），防回退套名存实亡。两套分列断言（capability 非空）保留在结构组。
 *   4) capability 阻断语义：capability 失败永不改退出码（"低通过爬坡，允许当前失败"）；
 *      --include-capability 只是执行并报告计数，不是把 capability 升级为阻断项。
 *   5) tests/eval 缺失 = regression 计数 0 < 20 → exit 1（"没跑够就是没证明"），不是 exit 3。
 *   6) 输出契约（仿既有审计脚本）：stdout 末行单行 JSON，
 *      {ok, regression:{total,passed,failed,failures:[id...]}, capability:{total,passed,failed}|null}。
 *   7) 夹具一律 git init：既不假设 run-eval 用 git 定文件集，也不假设它不用——两种
 *      实现都能过，行为断言只钉退出码与 JSON 字段。
 *
 * 修订记录（P10 评审，计数口径漏洞）：
 *   - 结构组「总数 ≥20（两套合计）」改为「regression 单列 ≥20」（capability 不计入）。
 *   - 行为组「套件计数不足 20」改名「regression 19 → exit 1」：夹具不变（本来就是
 *     regPass:19），但旧名下测的是合计口径，新名下钉的是 regression 单列口径。
 *   - 增补两例漏洞形状：「regression 空套 + 20 capability → exit 1」与「regression 19 +
 *     capability 5（合计 24）→ exit 1」——合计口径下这两例全绿，正是评审发现的绕过路径。
 *   - CI 锚点：github-gate.yml 已接 run-eval（P9 落地后 skip 解除）；gitlab-gate.yml 变体
 *     的 run-eval 锚点增于 tests/spec.test.mjs 的 P9 CI 锚点组。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = path.join(REPO, 'tests', 'eval');
const RUN_EVAL = path.join(REPO, '.kimi-base', 'audit', 'run-eval.mjs');
const GATE_TEMPLATE = path.join(REPO, '.kimi-base', 'templates', 'github-gate.yml');
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function mkdtemp(t, prefix = 'kimi-base-eval-') {
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
    }
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return (r.stdout ?? '').trim();
}
function needGit(t) {
  if (!GIT_OK) {
    t.skip('环境无 git，按纪律显式跳过');
    return false;
  }
  return true;
}

/** 跑 run-eval 独立审计脚本：node .kimi-base/audit/run-eval.mjs [args]，cwd=夹具仓 */
function runEval(args = [], opts = {}) {
  const r = spawnSync(process.execPath, [RUN_EVAL, ...args], {
    cwd: opts.cwd ?? REPO,
    timeout: 120_000,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' }
  });
  if (r.error) throw new Error(`run-eval 启动失败：${r.error.message}`);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r) => `${r.stdout}\n${r.stderr}`;
/** stdout 末行单行 JSON（审计脚本既有契约，同 audit.test.mjs） */
const jsonLine = (r) => JSON.parse(r.stdout.trim().split('\n').at(-1));

// ---------------- 清单加载（结构测试与夹具共用同一契约形状） ----------------

/**
 * 解析 tests/eval/manifest.json：条目为内联对象或相对 tests/eval/ 的任务文件路径。
 * 返回 { regression: Task[], capability: Task[] }；任何形态错误直接抛错（红因响亮）。
 */
function loadSuite(evalDir) {
  const manifestPath = path.join(evalDir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), `清单缺失：${path.relative(REPO, manifestPath)}（REQ-066 要求两套可机器区分）`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const suite of ['regression', 'capability']) {
    assert.ok(Array.isArray(manifest[suite]), `manifest.${suite} 必须是数组（两套分列，机器可区分）`);
  }
  const resolve = (entry, suite) => {
    if (typeof entry === 'string') {
      const taskPath = path.join(evalDir, entry);
      assert.ok(fs.existsSync(taskPath), `${suite} 条目指向的任务文件不存在：${entry}`);
      return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    }
    return entry;
  };
  return {
    regression: manifest.regression.map((e) => resolve(e, 'regression')),
    capability: manifest.capability.map((e) => resolve(e, 'capability'))
  };
}

/** 单任务形态断言：六字段齐备 + 判定可机器执行 + 来源可追溯 */
function assertTaskShape(task, label) {
  assert.equal(typeof task.id, 'string', `${label}: id 必须是字符串`);
  assert.ok(task.id.trim(), `${label}: id 不能为空`);
  assert.ok(typeof task.name === 'string' && task.name.trim(), `${label}(${task.id}): name 缺失`);
  assert.ok(typeof task.description === 'string' && task.description.trim(), `${label}(${task.id}): 任务描述 description 缺失`);
  assert.ok(typeof task.expected === 'string' && task.expected.trim(), `${label}(${task.id}): 期望行为 expected 缺失`);
  // 判定方式：command XOR assertFile，机器可判定，不允许人工判定
  const judge = task.judge ?? {};
  const hasCommand = typeof judge.command === 'string' && judge.command.trim();
  const hasAssertFile = typeof judge.assertFile === 'string' && judge.assertFile.trim();
  assert.ok(hasCommand || hasAssertFile,
    `${label}(${task.id}): judge 必须带 command 或 assertFile（机器可判定，不允许人工看一眼）`);
  assert.ok(!(hasCommand && hasAssertFile), `${label}(${task.id}): judge.command 与 judge.assertFile 二选一，不得并存`);
  // 来源可追溯：REQ 编号或行为锚点
  const trace = task.trace;
  const traceable = (typeof trace === 'string' && trace.trim()) ||
    (Array.isArray(trace) && trace.length > 0 && trace.every((s) => typeof s === 'string' && s.trim()));
  assert.ok(traceable, `${label}(${task.id}): trace 缺失（每个任务必须带 REQ 或行为锚点）`);
}

// ---------------- 结构契约（对真仓，红测主体） ----------------

describe('REQ-066 套件结构（tests/eval/）', () => {
  test('tests/eval/ 目录存在', () => {
    assert.ok(fs.existsSync(EVAL_DIR) && fs.statSync(EVAL_DIR).isDirectory(),
      'tests/eval/ 不存在（REQ-066：必须提供自我 eval 套件）');
  });

  test('清单存在且 regression / capability 两套机器可区分', () => {
    const suites = loadSuite(EVAL_DIR);
    assert.ok(suites.regression.length > 0, 'regression 套不能为空');
    assert.ok(suites.capability.length > 0, 'capability 套不能为空（低通过爬坡套必须单列）');
  });

  // P10 评审修订：门槛从「两套合计 ≥20」改为「regression 单列 ≥20」——capability 不计入，
  // 防回退套的强度不能用爬坡套注水补齐。
  test('regression 套 ≥20 且非空（capability 不计入门槛），两套分列', () => {
    const suites = loadSuite(EVAL_DIR);
    assert.ok(suites.regression.length >= 20,
      `regression 任务数 ${suites.regression.length} < 20（REQ-066：≥20 个代表性任务，门槛钉 regression 单列）`);
  });

  test('每个任务六字段齐备、判定机器可执行、来源可追溯', () => {
    const suites = loadSuite(EVAL_DIR);
    for (const task of suites.regression) assertTaskShape(task, 'regression');
    for (const task of suites.capability) assertTaskShape(task, 'capability');
  });

  test('任务 id 全局唯一（跨两套不得撞名，点名才无歧义）', () => {
    const suites = loadSuite(EVAL_DIR);
    const seen = new Map();
    for (const [suite, tasks] of Object.entries(suites)) {
      for (const task of tasks) {
        assert.ok(!seen.has(task.id), `任务 id 重复：${task.id}（${seen.get(task.id)} 与 ${suite}）`);
        seen.set(task.id, suite);
      }
    }
  });

  test('judge.assertFile 指向的断言文件真实存在（相对仓根）', () => {
    const suites = loadSuite(EVAL_DIR);
    for (const task of [...suites.regression, ...suites.capability]) {
      const assertFile = task.judge?.assertFile;
      if (typeof assertFile === 'string' && assertFile.trim()) {
        assert.ok(fs.existsSync(path.join(REPO, assertFile)),
          `${task.id}: judge.assertFile 不存在：${assertFile}`);
      }
    }
  });

  test('每个任务带 REQ 或行为锚点（trace 非空即满足，REQ 编号或自由锚点文本）', () => {
    const suites = loadSuite(EVAL_DIR);
    for (const task of [...suites.regression, ...suites.capability]) {
      const anchors = Array.isArray(task.trace) ? task.trace : [task.trace];
      assert.ok(anchors.every((a) => typeof a === 'string' && a.trim().length > 0),
        `${task.id}: trace 锚点为空`);
    }
  });
});

// ---------------- run-eval.mjs 存在性与审计独立性 ----------------

describe('REQ-066 run-eval 审计脚本', () => {
  test('.kimi-base/audit/run-eval.mjs 存在', () => {
    assert.ok(fs.existsSync(RUN_EVAL), '.kimi-base/audit/run-eval.mjs 不存在（REQ-066：regression 套必须有独立执行入口）');
  });

  test('审计独立：run-eval.mjs 不 import 引擎、零第三方依赖', () => {
    assert.ok(fs.existsSync(RUN_EVAL), '前置：run-eval.mjs 必须存在');
    const text = fs.readFileSync(RUN_EVAL, 'utf8');
    const specifiers = [
      ...[...text.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...text.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    ];
    for (const specifier of specifiers) {
      assert.ok(!/(^\.\.\/runtime\/|\.kimi-base\/runtime\/|runtime\/lib\/)/.test(specifier),
        `run-eval.mjs 不得依赖引擎（审计者独立铁律）：${specifier}`);
      assert.ok(specifier.startsWith('node:'), `run-eval.mjs 引入非 stdlib 依赖：${specifier}`);
    }
  });
});

// ---------------- run-eval 行为契约（临时 git 仓夹具） ----------------

/** 造一个任务对象；pass 控制 judge 成败 */
function mkTask(id, { pass = true, trace = 'REQ-066', assertFile = null } = {}) {
  const judge = assertFile
    ? { assertFile }
    : { command: `node -e "process.exit(${pass ? 0 : 1})"` };
  return {
    id,
    name: `任务 ${id}`,
    description: `${id} 的任务描述`,
    expected: `${id} 的期望行为`,
    judge,
    trace
  };
}

/**
 * 夹具仓：tests/eval/manifest.json + 内联任务。
 * regPass/regFail/capPass/capFail 控制四套计数，默认 20 个全绿 regression。
 */
function evalRepo(t, { regPass = 20, regFail = 0, capPass = 0, capFail = 0 } = {}) {
  const dir = mkdtemp(t);
  const regression = [];
  for (let i = 0; i < regPass; i++) regression.push(mkTask(`reg-${String(i + 1).padStart(3, '0')}`, { pass: true }));
  for (let i = 0; i < regFail; i++) regression.push(mkTask(`reg-bad-${i + 1}`, { pass: false }));
  const capability = [];
  for (let i = 0; i < capPass; i++) capability.push(mkTask(`cap-${String(i + 1).padStart(3, '0')}`, { pass: true }));
  for (let i = 0; i < capFail; i++) capability.push(mkTask(`cap-bad-${i + 1}`, { pass: false }));
  write(dir, 'tests/eval/manifest.json', JSON.stringify({ version: 1, regression, capability }, null, 2));
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture: eval suite with enough length');
  return dir;
}

describe('REQ-066 run-eval 退出码契约', () => {
  test('regression 全绿（20 任务）→ exit 0，JSON ok:true 且计数正确', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t);
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const report = jsonLine(r);
    assert.equal(report.ok, true);
    assert.equal(report.regression.total, 20);
    assert.equal(report.regression.failed, 0);
  });

  test('regression 任一失败 → exit 1 且 failures 点名失败任务 id', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 19, regFail: 1 });
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    const report = jsonLine(r);
    assert.equal(report.ok, false);
    assert.ok(Array.isArray(report.regression.failures), 'failures 必须是数组');
    assert.ok(report.regression.failures.includes('reg-bad-1'),
      `failures 必须点名失败任务 id：${JSON.stringify(report.regression.failures)}`);
  });

  test('capability 默认只报告计数不阻断：cap 全挂 regression 全绿仍 exit 0', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 20, capFail: 3 });
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 0, `capability 失败不得阻断（低通过爬坡允许当前失败）：${out(r)}`);
    const report = jsonLine(r);
    assert.equal(report.ok, true);
    // 默认不跑 capability：不执行则不计 pass/fail，只报告总数（两种诚实形态都接受）
    const cap = report.capability;
    assert.ok(cap && typeof cap.total === 'number' && cap.total === 3,
      `capability 计数必须响亮报告：${JSON.stringify(cap)}`);
  });

  test('--include-capability 执行 capability 并报告，失败仍不阻断退出码', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 20, capPass: 1, capFail: 2 });
    const r = runEval(['--include-capability'], { cwd: dir });
    assert.equal(r.code, 0, `capability 永不阻断（允许当前失败）：${out(r)}`);
    const report = jsonLine(r);
    assert.equal(report.capability.total, 3);
    assert.equal(report.capability.passed, 1);
    assert.equal(report.capability.failed, 2);
  });

  test('regression 19 → exit 1（regression 单列门槛，没跑够就是没证明）', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 19 });
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 1, `regression 19 < 20 必须 exit 1：${out(r)}`);
    assert.equal(jsonLine(r).ok, false);
  });

  // P10 评审增补：合计口径的漏洞形状——capability 注水不得补齐 regression 门槛
  test('regression 空套 + 20 capability → exit 1（capability 不计入门槛）', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 0, capPass: 20 });
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 1, `regression 0 < 20 必须 exit 1（合计 20 不算数）：${out(r)}`);
    assert.equal(jsonLine(r).ok, false);
  });

  test('regression 19 + capability 5（合计 24）→ exit 1（合计口径注水不救场）', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 19, capPass: 5 });
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 1, `regression 19 < 20 必须 exit 1（合计 24 也不算数）：${out(r)}`);
    assert.equal(jsonLine(r).ok, false);
  });

  test('tests/eval 缺失（计数 0 < 20）→ exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    write(dir, 'README.md', '# fixture\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture without eval suite at all');
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 1, `套件缺失 = 没跑够，必须 exit 1：${out(r)}`);
  });

  test('judge.assertFile 指向不存在的文件 → 该任务判失败，exit 1 点名', (t) => {
    if (!needGit(t)) return;
    const dir = evalRepo(t, { regPass: 19 });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'tests/eval/manifest.json'), 'utf8'));
    manifest.regression.push(mkTask('reg-assert-missing', { assertFile: 'tests/eval/expectations/nonexistent.txt' }));
    write(dir, 'tests/eval/manifest.json', JSON.stringify(manifest, null, 2));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture: task with missing assert file');
    const r = runEval([], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    const report = jsonLine(r);
    assert.ok(report.regression.failures.includes('reg-assert-missing'),
      `断言文件缺失的任务必须被点名：${JSON.stringify(report.regression.failures)}`);
  });
});

// ---------------- CI 接入（P9 依赖，暂缓） ----------------

describe('REQ-066 regression 套进 CI', () => {
  test('templates/github-gate.yml 引用 run-eval（regression 套在 CI 电池内）',
    () => {
      assert.ok(fs.existsSync(GATE_TEMPLATE), 'CI 门禁模板缺失');
      const text = fs.readFileSync(GATE_TEMPLATE, 'utf8');
      assert.ok(/run-eval/.test(text),
        'github-gate.yml 必须引用 .kimi-base/audit/run-eval.mjs（REQ-066：regression 套必须进 CI）');
    });
});
