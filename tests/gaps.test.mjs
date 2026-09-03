/**
 * tests/gaps.test.mjs
 * P7a 补盲测试：此前零覆盖的引擎面（零第三方依赖，node:test）。
 *   pre-write hook 三面（仓外/敏感路径/任务冲突）· receipt verify 证据面（TAMPERED/DRIFT/BROKEN/MISSING）
 *   retention prune · risk scan · supervisor 生命周期与熔断 · gate 检查形态（builtin/platform/resourceLocks）
 *
 * 运行：node --test tests/gaps.test.mjs
 *
 * 纪律：行为测试在临时 git 仓中跑，断言退出码与 stdout/JSON 状态字段，不断言 stderr 文本；
 * hook 拦截的具体规则一律读 .kimi-base/state/gate-log.jsonl 记账判定。
 * 已覆盖不重复：prewrite 对账降级（tasks.json 腐化放行+留痕）、账本轮转/anchor 篡改 fail-closed、
 * receipt 镜像内容篡改 TAMPERED、review-backlog-expired 风险标记——见 tests/harness.test.mjs 与
 * tests/review.test.mjs 对应用例。
 * 追溯：REQ-006/REQ-011（pre-write 写前对账）REQ-012（指纹绑定）REQ-013（gate 四态与检查形态）
 *       REQ-023（证据生命周期 retention/ledger）REQ-025（supervisor 开发态守护）NFR-003（平台门控）。
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
const SUPERVISOR = path.join(REPO, '.kimi-base', 'runtime', 'supervisor.mjs');
const RUNTIME_OK = fs.existsSync(RUNTIME) && fs.readFileSync(RUNTIME, 'utf8').includes('process.argv');
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪' };

function mkdtemp(t, prefix = 'kimi-base-gaps-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // 收尾删除在 CI 上有环境竞态：Windows Defender/索引器短时持锁（EBUSY）。重试覆盖
  // 短时占用；最终仍失败则 diagnostic 留痕、残留交 OS 回收——清理失败不伪造测试结果，
  // 不该把全绿的套件拖红。
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
      // CI 上 git 提交会派生后台 gc/maintenance 进程异步补写 .git，与收尾 rmSync 撞出
      // ENOTEMPTY。测试夹具一律禁掉自动 gc/maintenance——没有后台写就没有竞态。
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
// 输出 >4000 字符 → 证据落盘 .kimi-base/state/evidence/（gate.mjs 的阈值）
const BIG_CHECK = { id: 'big-output', kind: 'static', command: 'node -e "console.log(\'x\'.repeat(5000))"' };

/** pre-write hook 调用：payload.cwd 指向夹具仓 */
function preWrite(dir, filePath) {
  return run(['hook', 'pre-write'], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_input: { file_path: filePath } }),
  });
}
function gateLogRules(dir) {
  const logPath = path.join(dir, '.kimi-base', 'state', 'gate-log.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).rule);
}

// ---------------- pre-write hook 拦截面 ----------------

// 追溯：REQ-006/REQ-011/NFR-004（对账降级形态已由 harness.test.mjs 覆盖，此处只补三个拦截面）
describe('pre-write hook 拦截面', RT, () => {
  test('仓外写入 → exit 2 且 gate-log 记 outside-workspace', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const r = preWrite(dir, '../outside.txt');
    assert.equal(r.code, 2, `仓外写入必须 exit 2，实际 ${r.code}`);
    assert.ok(gateLogRules(dir).includes('outside-workspace'), `gate-log 必须记 outside-workspace，实际 ${gateLogRules(dir).join(',')}`);
  });

  test('敏感文件 .env / id_rsa → exit 2 记 sensitive-path；.env.example 模板放行', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    for (const name of ['.env', 'id_rsa']) {
      const r = preWrite(dir, name);
      assert.equal(r.code, 2, `写 ${name} 必须 exit 2，实际 ${r.code}`);
    }
    const rules = gateLogRules(dir);
    assert.equal(rules.filter((rule) => rule === 'sensitive-path').length, 2, `两次敏感写入都应记 sensitive-path，实际 ${rules.join(',')}`);
    const allowed = preWrite(dir, '.env.example');
    assert.equal(allowed.code, 0, `模板文件 .env.example 必须放行，实际 ${allowed.code}`);
  });

  test('任务冲突熔断：owned 路径被任务外改动 → exit 2 记 task-conflict；认领路径放行', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    assert.equal(run(['task', 'start', '--goal', 'x', '--owned', 'src/a.js', '--risk', 'low'], { cwd: dir }).code, 0);
    // 基线一致的首次写入：放行并认领（touchedPaths）
    const first = preWrite(dir, 'src/a.js');
    assert.equal(first.code, 0, `基线一致的 owned 写入必须放行，实际 ${first.code}`);
    // 非 owned 路径不受任务对账约束
    assert.equal(preWrite(dir, 'src/other.js').code, 0, '非 owned 路径必须放行');
    // 新任务：owned 路径被任务外力量改动（哈希偏离基线且未认领）→ 阻断
    const dir2 = baseFixture(t, [PASS_CHECK]);
    assert.equal(run(['task', 'start', '--goal', 'x', '--owned', 'src/a.js', '--risk', 'low'], { cwd: dir2 }).code, 0);
    fs.appendFileSync(path.join(dir2, 'src/a.js'), 'export const oob = 1;\n'); // 任务外改动
    const blocked = preWrite(dir2, 'src/a.js');
    assert.equal(blocked.code, 2, `任务外改动后的 owned 写入必须 exit 2，实际 ${blocked.code}`);
    assert.ok(gateLogRules(dir2).includes('task-conflict'), 'gate-log 必须记 task-conflict');
  });
});

// ---------------- receipt verify 证据面 ----------------

// 追溯：REQ-012/REQ-023（镜像内容篡改与轮转/anchor 形态已由 harness.test.mjs 覆盖）
describe('receipt verify 证据面', RT, () => {
  test('证据文件被篡改 → TAMPERED exit 2；证据文件被删除 → MISSING exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [BIG_CHECK]);
    assert.equal(run(['gate'], { cwd: dir }).code, 0, out(run(['gate'], { cwd: dir })));
    const receipt = JSON.parse(read(dir, '.kimi-base/state/receipts/big-output.json'));
    assert.ok(receipt.evidencePath, '大输出检查必须落证据文件');
    assert.ok(exists(dir, receipt.evidencePath), '证据文件必须存在');
    fs.appendFileSync(path.join(dir, receipt.evidencePath), 'tampered\n');
    const tampered = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(tampered.code, 2, `证据篡改必须 exit 2，实际 ${tampered.code}: ${out(tampered)}`);
    assert.match(tampered.stdout, /TAMPERED/, 'stdout 必须点名 TAMPERED');
    fs.rmSync(path.join(dir, receipt.evidencePath), { force: true });
    const missing = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(missing.code, 2, `证据缺失必须 exit 2，实际 ${missing.code}: ${out(missing)}`);
    assert.match(missing.stdout, /MISSING/, 'stdout 必须点名 MISSING');
  });

  test('receipts/ 镜像自洽但偏离账本尾 → DRIFT exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    assert.equal(run(['gate'], { cwd: dir }).code, 0);
    const mirrorPath = path.join(dir, '.kimi-base', 'state', 'receipts', 'static-ok.json');
    const mirrorV1 = fs.readFileSync(mirrorPath, 'utf8'); // 自洽的旧镜像（contentHash 与内容匹配）
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const moved = 1;\n');
    assert.equal(run(['gate'], { cwd: dir }).code, 0); // 账本尾推进到 v2，镜像也是 v2
    fs.writeFileSync(mirrorPath, mirrorV1); // 镜像回滚到 v1：自洽但 ≠ 账本尾 → DRIFT（不是 TAMPERED）
    const r = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(r.code, 2, `镜像漂移必须 exit 2，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /DRIFT/, 'stdout 必须点名 DRIFT');
    assert.doesNotMatch(r.stdout, /TAMPERED receipts/, '自洽镜像不得误判 TAMPERED');
  });

  test('账本中段条目被改（不重修哈希）→ BROKEN exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    assert.equal(run(['gate'], { cwd: dir }).code, 0);
    assert.equal(run(['gate'], { cwd: dir }).code, 0);
    const ledgerPath = path.join(dir, '.kimi-base', 'state', 'ledger.jsonl');
    const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length >= 2, '两次 gate 至少两条账本条目');
    const first = JSON.parse(lines[0]);
    first.reason = '手改的'; // 不重修 contentHash/chain
    fs.writeFileSync(ledgerPath, `${[JSON.stringify(first), ...lines.slice(1)].join('\n')}\n`);
    const r = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(r.code, 2, `断链必须 fail-closed exit 2，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /BROKEN/, 'stdout 必须点名 BROKEN');
  });
});

// ---------------- retention prune ----------------

// 追溯：REQ-023（证据生命周期：过期销毁 + 引用保护 + dry-run 预览）
describe('retention prune', RT, () => {
  test('过期证据删除、receipt 引用证据保护、--dry-run 只报不落盘', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [BIG_CHECK], { retention: { evidenceMaxAgeDays: 30 } });
    assert.equal(run(['gate'], { cwd: dir }).code, 0);
    const first = JSON.parse(read(dir, '.kimi-base/state/receipts/big-output.json')).evidencePath;
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const moved = 1;\n');
    assert.equal(run(['gate'], { cwd: dir }).code, 0);
    const second = JSON.parse(read(dir, '.kimi-base/state/receipts/big-output.json')).evidencePath;
    assert.notEqual(first, second, '两次 gate 应各落一份证据');
    // 两份证据都老化到 40 天前：过期但 second 被最新 receipt 引用
    const old = new Date(Date.now() - 40 * 86400000);
    for (const rel of [first, second]) fs.utimesSync(path.join(dir, rel), old, old);
    const dry = run(['retention', 'prune', '--dry-run'], { cwd: dir });
    assert.equal(dry.code, 0, out(dry));
    assert.match(dry.stdout, /dry-run/, '必须显式标注 dry-run');
    assert.ok(dry.stdout.includes(first), `dry-run 清单应点名将删 ${first}: ${dry.stdout}`);
    assert.ok(!dry.stdout.includes(second), `被引用证据不得进删除清单: ${dry.stdout}`);
    assert.ok(exists(dir, first) && exists(dir, second), 'dry-run 不得真删');
    const real = run(['retention', 'prune'], { cwd: dir });
    assert.equal(real.code, 0, out(real));
    assert.ok(!exists(dir, first), `过期且未被引用的证据必须删除：${first}`);
    assert.ok(exists(dir, second), `receipt 引用的证据必须保护：${second}`);
  });
});

// ---------------- risk scan ----------------

describe('risk scan', RT, () => {
  test('干净仓 exit 0 且报告无风险', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    const r = run(['risk', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, `干净仓必须 exit 0，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /未发现风险/, out(r));
  });

  test('active 任务超 72h → 标记 stale-task（medium 不阻断）', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [PASS_CHECK]);
    assert.equal(run(['task', 'start', '--goal', 'x', '--owned', 'src/a.js', '--risk', 'low'], { cwd: dir }).code, 0);
    const tasksPath = path.join(dir, '.kimi-base', 'state', 'tasks.json');
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    const active = tasks.tasks[tasks.activeTaskId];
    active.createdAt = new Date(Date.now() - 100 * 3600000).toISOString(); // 100h 前
    fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
    const r = run(['risk', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, `medium 风险不得阻断，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /stale-task/, '必须标记 stale-task');
  });

  test('同一检查连续 3 次 FAIL → fail-streak 高危 exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [FAIL_CHECK]);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(run(['gate'], { cwd: dir }).code, 2, `第 ${i + 1} 次 gate 应 FAIL（exit 2）`);
    }
    const r = run(['risk', 'scan'], { cwd: dir });
    assert.equal(r.code, 2, `fail-streak 是高危，必须 exit 2，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /fail-streak/, '必须标记 fail-streak');
  });
});

// ---------------- supervisor 生命周期 ----------------

// 追溯：REQ-025（退避拉起/熔断/只杀自己拉的进程）；用法与 exit 1 由 spec.test.mjs 资产测试覆盖
describe('supervisor 生命周期', RT, () => {
  function sup(dir, args, timeout = 30_000) {
    const r = spawnSync(process.execPath, [SUPERVISOR, ...args, '--project', dir], { encoding: 'utf8', timeout });
    if (r.error) throw new Error(`supervisor 启动失败（${args.join(' ')}）: ${r.error.message}`);
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  function supJson(dir, args, timeout) {
    const r = sup(dir, args, timeout);
    assert.equal(r.code, 0, `supervisor ${args.join(' ')} 应 exit 0: ${r.stdout}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  function serviceFixture(t, services) {
    const dir = mkdtemp(t, 'kimi-base-sup-');
    writeHarness(dir, { services });
    return dir;
  }
  /** 主线程忙等 sleep（node:test 同步体用） */
  function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms);
  }

  test('start/status/stop 生命周期：长跑服务确认 liftoff 才报 started，stop 收敛', (t) => {
    const dir = serviceFixture(t, { svc: { command: 'node -e "setInterval(()=>{},1000)"' } });
    t.after(() => sup(dir, ['stop', 'svc'])); // 兜底回收，绝不留孤儿子进程
    const started = supJson(dir, ['start', 'svc']);
    assert.equal(started.ok, true);
    assert.equal(started.status, 'running', `确认 liftoff 才准报 started: ${JSON.stringify(started)}`);
    assert.ok(Number.isInteger(started.childPid) && started.childPid > 0, '必须给出 childPid');
    const status = supJson(dir, ['status', 'svc']);
    assert.equal(status.services.length, 1);
    assert.equal(status.services[0].status, 'running');
    assert.equal(status.services[0].supervisorAlive, true);
    assert.equal(status.services[0].childAlive, true);
    const stopped = supJson(dir, ['stop', 'svc']);
    assert.equal(stopped.status, 'stopped');
    const after = supJson(dir, ['status', 'svc']);
    assert.notEqual(after.services[0].status, 'running', 'stop 后不得再报 running');
    assert.equal(after.services[0].childAlive, false, 'stop 必须收割子进程（只 kill 自己启动的）');
  });

  test('重启风暴熔断：立即退出的服务在窗口内超 maxRestarts → crashed 停手', (t) => {
    const dir = serviceFixture(t, {
      crashy: {
        command: 'node -e "process.exit(1)"',
        restart: { maxRestarts: 2, windowSec: 120, backoffMs: 100, backoffMaxMs: 400 },
      },
    });
    t.after(() => sup(dir, ['stop', 'crashy']));
    const started = supJson(dir, ['start', 'crashy']);
    assert.equal(started.ok, true);
    // 熔断发生在被拉起的守护进程内：轮询 status 直至 crashed（重启 3 次 ≈ 亚秒级，给足 10s 余量）
    let last = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      last = supJson(dir, ['status', 'crashy']).services[0];
      if (last.status === 'crashed') break;
      sleepMs(250);
    }
    assert.equal(last?.status, 'crashed', `10s 内必须熔断到 crashed，实际 ${JSON.stringify(last)}`);
    assert.ok(last.restarts > 2, `熔断前重启次数应超 maxRestarts=2，实际 ${last.restarts}`);
  });
});

// ---------------- gate 检查形态补盲（builtin / platform / resourceLocks） ----------------

// 追溯：REQ-013（gate 四态：形态不通一律不假绿）NFR-003（平台门控如实报告）
describe('gate 检查形态', RT, () => {
  test('builtin:fitness 经 gate 出 PASS 回执（与命令检查同一证据机器）', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [{ id: 'fitness-builtin', kind: 'static', builtin: 'fitness' }]);
    const r = run(['gate'], { cwd: dir });
    assert.equal(r.code, 0, `干净夹具的 builtin fitness 必须 PASS，实际 ${r.code}: ${out(r)}`);
    const receipt = JSON.parse(read(dir, '.kimi-base/state/receipts/fitness-builtin.json'));
    assert.equal(receipt.status, 'PASS');
    assert.equal(receipt.argvDisplay, 'builtin:fitness', '回执必须记录 builtin 调用形态');
  });

  test('未知 builtin 在配置期拒绝（exit 1，不是运行期假绿）', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [{ id: 'bad-builtin', kind: 'static', builtin: 'no-such-builtin' }]);
    const r = run(['gate'], { cwd: dir });
    assert.equal(r.code, 1, `未知 builtin 必须 exit 1，实际 ${r.code}`);
  });

  test('platform 门控：非当前平台 → BLOCKED（exit 2 并点名）；当前平台 → PASS；非法值 → exit 1', (t) => {
    if (!needGit(t)) return;
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    const dir = baseFixture(t, [{ id: 'other-os', kind: 'static', command: 'node -e "process.exit(0)"', platform: [otherPlatform] }]);
    const blocked = run(['gate'], { cwd: dir });
    assert.equal(blocked.code, 2, `平台不匹配的检查必须 BLOCKED → exit 2，实际 ${blocked.code}: ${out(blocked)}`);
    assert.match(blocked.stdout, /平台不匹配/, '必须如实点名平台不匹配');
    assert.match(blocked.stdout, /BLOCKED=1/, '统计必须含 BLOCKED=1');
    const dir2 = baseFixture(t, [{ id: 'this-os', kind: 'static', command: 'node -e "process.exit(0)"', platform: [process.platform] }]);
    assert.equal(run(['gate'], { cwd: dir2 }).code, 0, '当前平台检查必须正常执行');
    const dir3 = baseFixture(t, [{ id: 'bad-os', kind: 'static', command: 'node -e "process.exit(0)"', platform: ['aix'] }]);
    assert.equal(run(['gate'], { cwd: dir3 }).code, 1, '非法 platform 值必须配置期 exit 1');
  });

  // resourceLocks 的语义是跨进程互斥（gate 进程内检查本就串行执行）：
  // 用「测试进程持锁（活 pid）→ gate 等锁超时 exit 1；释锁后 gate 通过且锁不残留」证明互斥真实生效，
  // 不做并发时序断言（竞态断言必然 flaky）。
  test('resourceLocks：活进程持锁 → gate 等锁超时 exit 1；释锁后通过且锁文件不残留', (t) => {
    if (!needGit(t)) return;
    const dir = baseFixture(t, [{ id: 'db-check', kind: 'static', command: 'node -e "process.exit(0)"', resourceLocks: ['db'] }], {
      locks: { timeoutMs: 1500, staleMs: 3600000, pollMs: 50 },
    });
    const lockRel = '.kimi-base/state/resource-locks/db.lock';
    write(dir, lockRel, JSON.stringify({ pid: process.pid, ownerToken: 'gaps-' + 'test', createdAt: new Date().toISOString() }));
    const held = run(['gate'], { cwd: dir });
    assert.equal(held.code, 1, `锁被活进程持有必须等锁超时 exit 1，实际 ${held.code}: ${out(held)}`);
    fs.rmSync(path.join(dir, lockRel), { force: true });
    const free = run(['gate'], { cwd: dir });
    assert.equal(free.code, 0, `释锁后必须正常通过，实际 ${free.code}: ${out(free)}`);
    assert.ok(!exists(dir, lockRel), 'gate 结束后资源锁必须释放（无残留 .lock）');
  });
});

// ---------------- UNSAFE_TARGET 区分器（pwsh 实测发现的真 bug）----------------
// 已安装项目用自带引擎重跑 install（如 install . --hooks 挂载第二道闸）曾被误拒——
// 哨兵只看"目标与引擎根重叠"，分不清脚手架源仓与已安装项目。区分器 = 源根的 kimi.plugin.json。
describe('install 自我重跑与源仓拒绝', RT, () => {
  test('已安装项目：自带引擎 install . --hooks 允许并挂载 core.hooksPath', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    git(dir, 'init', '-q');
    // 用真仓引擎（带 kimi.plugin.json 的源仓）装进目标项目——目标与源不重叠，允许
    const first = run(['install', '.'], { cwd: dir });
    assert.equal(first.code, 0, out(first));
    // 关键：改用"已安装的引擎"对自己项目重跑 install --hooks（doctor 提示的补救路径）
    const installed = path.join(dir, '.kimi-base', 'runtime', 'kimi-base.mjs');
    const r = spawnSync(process.execPath, [installed, 'install', '.', '--hooks'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `已安装项目重跑 install 必须允许，实际 ${r.status}: ${r.stdout}\n${r.stderr}`);
    const hooksPath = git(dir, 'config', 'core.hooksPath');
    assert.equal(hooksPath, '.kimi-base/githooks', `core.hooksPath 必须挂载，实际: ${hooksPath || '(未设置)'}`);
  });

  test('脚手架源仓自身：install . 仍被 UNSAFE_TARGET 拒绝', () => {
    const r = run(['install', '.'], { cwd: REPO });
    assert.equal(r.code, 1, `源仓自我安装必须拒绝 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /UNSAFE_TARGET|源仓/, '必须点名 UNSAFE_TARGET');
  });
});
