/**
 * tests/hooks-ext.test.mjs
 * REQ-080 review 机械闸 + REQ-081 进化补强（红测先行：先写行为契约，确认红因后实现转绿）。
 *
 *   REQ-080：post-edit hook 置脏（PostToolUse Edit/Write 代码文件 → state 置脏；
 *            文档/.kimi-base/仓外不置脏）· Stop 脏闸（脏标记在 → 阻断并指引派发 review）·
 *            终审 ACCEPT 清脏（FIX_REQUIRED 不清）· 三振熔断（同一清单连拦 3 次第 4 次放行
 *            + stop-fuse-release 欠账留痕）· feedback 信号（收窄高信号词命中注入提示并
 *            点名 feedback-observer；宽词「能不能/为什么」不误报）。
 *   REQ-081：feedback record 带 --scores 必须附 --evidence（每分一句话依据），
 *            缺 evidence / evidence 缺维度 → exit 1；带齐 → 落 frontmatter；无分数条目不受影响。
 *
 * 运行：node --test tests/hooks-ext.test.mjs
 *
 * 纪律：行为测试在临时 git 仓中跑，断言退出码与状态文件/stdout 的 JSON 字段，不断言 stderr 文本；
 * hook 拦截的具体判定一律读 .kimi-base/state/gate-log.jsonl 记账。
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
const RUNTIME_OK = fs.existsSync(RUNTIME) && fs.readFileSync(RUNTIME, 'utf8').includes('process.argv');
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪' };

const DIRTY = '.kimi-base/state/review-dirty.json';

function mkdtemp(t, prefix = 'kimi-base-hooks-ext-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // 收尾删除在 CI 上有环境竞态（Windows Defender/索引器短时持锁 EBUSY）：重试覆盖短时占用；
  // 最终仍失败则 diagnostic 留痕、残留交 OS 回收——清理失败不伪造测试结果。
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

function writeHarness(dir) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1 }, null, 2));
}
/** 治理夹具：git 仓 + harness + 单模块 catalog（review 剖面 personal=只有 correctness lens）+ src/a.js 已提交 */
function gateFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({
    version: 1,
    modules: [{ id: 'app', root: 'src', paths: ['**'] }],
    review: { profile: 'personal' },
  }, null, 2));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  gitInitCommit(dir);
  return dir;
}

/** hook 调用：payload.cwd 指向夹具仓 */
function hook(dir, event, payload) {
  return run(['hook', event], { cwd: dir, input: JSON.stringify({ cwd: dir, ...payload }) });
}
const postEdit = (dir, filePath) =>
  hook(dir, 'post-edit', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: filePath } });
const stop = (dir) => hook(dir, 'stop', { hook_event_name: 'Stop', session_id: 'hooks-ext' });
const promptSubmit = (dir, prompt) =>
  hook(dir, 'prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt });

function readDirty(dir) {
  if (!exists(dir, DIRTY)) return { version: 1, files: {} };
  return JSON.parse(read(dir, DIRTY));
}
function gateLog(dir) {
  const logPath = path.join(dir, '.kimi-base', 'state', 'gate-log.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// ---------------- REQ-080：post-edit 置脏 ----------------

describe('review 机械闸：post-edit 置脏', RT, () => {
  test('Edit 代码文件 → state/review-dirty.json 置脏；文档与治理元数据不置脏', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    const r = postEdit(dir, 'src/a.js');
    assert.equal(r.code, 0, `post-edit 是观察型事件，必须 exit 0，实际 ${r.code}: ${out(r)}`);
    assert.ok(readDirty(dir).files['src/a.js'], 'src/a.js 必须进脏清单');
    postEdit(dir, 'README.md');
    postEdit(dir, '.kimi-base/harness.json');
    assert.deepEqual(Object.keys(readDirty(dir).files), ['src/a.js'], '文档与 .kimi-base 元数据不得置脏');
  });

  test('仓外路径与无标记项目：不置脏、静默 exit 0', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    assert.equal(postEdit(dir, '../outside.js').code, 0, '仓外路径必须静默放过');
    assert.deepEqual(readDirty(dir).files, {}, '仓外路径不得置脏');
    const bare = mkdtemp(t); // 无 .kimi-base/harness.json：标记惰性
    const r = postEdit(bare, 'src/a.js');
    assert.equal(r.code, 0, `非 kimi-base 项目必须静默放行，实际 ${r.code}`);
    assert.ok(!exists(bare, DIRTY), '非标记项目不得落任何状态文件');
  });
});

// ---------------- hook 锁等待封顶（trust 回归） ----------------

describe('hook 锁等待封顶', RT, () => {
  test('活进程持 review-dirty 锁 → post-edit ≤4s 降级退出（exit 0 + stderr/gate-log 留痕），不得跑到 15s 默认锁超时', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    // 模拟活进程持锁：ownerToken 不属于本进程、pid 指向存活的测试进程、mtime 新鲜——
    // 不满足 stale 接管条件，持锁期间 post-edit 只能在锁上干等。
    const lockPath = path.join(dir, '.kimi-base', 'state', 'review-dirty.json.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ownerToken: 'held-' + 'by-test', createdAt: new Date().toISOString() })); // 拼接构造防 scan-secrets generic-assignment 命中本行（金丝雀惯例，值不变）
    const started = Date.now();
    const r = postEdit(dir, 'src/a.js');
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0, `观察型 hook 永不阻断，锁等待超时必须降级 exit 0，实际 ${r.code}: ${out(r)}`);
    assert.ok(elapsed < 5000, `钩子里的锁等待封顶 3s（+进程启动余量），实际 ${elapsed}ms——不得跑到 15s 默认锁超时`);
    assert.match(r.stderr, /置脏失败/, `降级必须 stderr 留痕：${r.stderr}`);
    assert.ok(gateLog(dir).some((entry) => entry.rule === 'dirty-mark-failed'), '降级必须记 gate-log dirty-mark-failed');
    assert.ok(!exists(dir, DIRTY), '降级不得伪造置脏（脏清单必须不存在）');
  });
});

// ---------------- REQ-080：Stop 脏闸与三振熔断 ----------------

describe('review 机械闸：Stop 脏闸与三振', RT, () => {
  test('脏标记在且文件仍在变更集 → Stop 阻断并指引派发 review；无脏标记的改动不含该指引', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    postEdit(dir, 'src/a.js');
    const blocked = stop(dir);
    assert.equal(blocked.code, 2, `脏标记在必须阻断，实际 ${blocked.code}`);
    const entries = gateLog(dir).filter((entry) => entry.rule === 'completion-gate');
    assert.ok(entries.length, 'gate-log 必须记 completion-gate');
    assert.match(entries.at(-1).reason, /评审/, `阻断原因必须指引派发 review：${entries.at(-1).reason}`);
    assert.ok(entries.at(-1).reason.includes('src/a.js'), '阻断原因必须点名未评审文件');
    // 对照：同样的工作树改动但无脏标记（非经 Edit/Write hook 落地）→ 阻断原因不含评审指引
    const dir2 = gateFixture(t);
    fs.appendFileSync(path.join(dir2, 'src/a.js'), 'export const b = 2;\n');
    assert.equal(stop(dir2).code, 2, '缺 fresh receipt 仍按完成门阻断');
    const plain = gateLog(dir2).filter((entry) => entry.rule === 'completion-gate').at(-1);
    assert.doesNotMatch(plain.reason, /评审/, `无脏标记时不得混入评审指引：${plain.reason}`);
  });

  test('三振熔断：同一脏清单连拦 3 次后第 4 次放行且记 stop-fuse-release；欠账提示上 stdout；换指纹重置计数', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    // 夹具做成「完成门已绿、只剩脏闸」：一条平凡 gate 检查 + progress.md 入变更集 + 先跑 gate 产
    // fresh 回执，使保险丝计数只由「未经评审」驱动——此前夹具缺 fresh receipt，完成门自身也驱动
    // 计数，置脏删掉（markDirty 变异）后用例照绿，对 REQ-080 本体变异不敏感。
    write(dir, '.kimi-base/verification-matrix.json', JSON.stringify({
      version: 1,
      riskKinds: { low: ['static'], medium: ['static'], high: ['static', 'security'] },
      checks: [{ id: 'static-ok', kind: 'static', command: 'node -e "process.exit(0)"' }],
    }, null, 2));
    write(dir, 'progress.md', '# progress\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add matrix and progress');
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    fs.appendFileSync(path.join(dir, 'progress.md'), '- 进展\n'); // 三文件同步：progress.md 入变更集
    postEdit(dir, 'src/a.js');
    assert.equal(run(['gate'], { cwd: dir }).code, 0, '前置：gate 必须产当前指纹的 fresh 回执');
    const first = stop(dir);
    assert.equal(first.code, 2, `脏闸必须拦截，实际 ${first.code}`);
    const firstReason = gateLog(dir).filter((entry) => entry.rule === 'completion-gate').at(-1);
    assert.match(firstReason.reason, /未经评审/, `拦截原因必须点名未经评审：${firstReason.reason}`);
    assert.doesNotMatch(firstReason.reason, /fresh receipt|progress\.md/,
      `完成门必须已绿——保险丝只由「未经评审」驱动：${firstReason.reason}`);
    assert.equal(stop(dir).code, 2, '第 2 次必须仍拦');
    assert.equal(stop(dir).code, 2, '第 3 次必须仍拦');
    const released = stop(dir);
    assert.equal(released.code, 0, `连拦 3 次后第 4 次必须保险丝放行，实际 ${released.code}`);
    assert.match(released.stdout, /保险丝放行/, '放行必须在 stdout 醒目提示（不得静默放过）');
    assert.match(released.stdout, /欠账/, '放行提示必须声明欠账仍在——放行 ≠ 通过');
    const rules = gateLog(dir).map((entry) => entry.rule);
    assert.ok(rules.includes('stop-fuse-release'), `放行必须记 stop-fuse-release 欠账，实际 ${rules.join(',')}`);
    // 换指纹重置：工作树再变 → 阻断指纹变化 → 计数归 1 重新拦，不得沿旧指纹的释放继续放行
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const c = 3;\n');
    const refingerprinted = stop(dir);
    assert.equal(refingerprinted.code, 2, `换指纹后必须重新拦截，实际 ${refingerprinted.code}`);
    const lastGate = gateLog(dir).filter((entry) => entry.rule === 'completion-gate').at(-1);
    assert.match(lastGate.detail, /strikes=1\//, `换指纹后 strikes 必须重置为 1，实际 ${lastGate.detail}`);
  });

  test('脏文件已还原（不在变更集）→ 剪枝不拦', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    postEdit(dir, 'src/a.js'); // 置脏时甚至不需要真改文件
    const r = stop(dir);
    assert.equal(r.code, 0, `工作树干净时脏标记必须剪枝放过，实际 ${r.code}: ${out(r)}`);
    assert.deepEqual(readDirty(dir).files, {}, '剪枝必须落盘（陈旧标记不得残留）');
  });
});

// ---------------- REQ-080：终审 ACCEPT 清脏 ----------------

describe('review 机械闸：清脏', RT, () => {
  function review(dir, args, payload) {
    return run(['review', ...args], { cwd: dir, input: payload === undefined ? undefined : JSON.stringify(payload) });
  }
  const BLUE = { claims: [{ claim: '实现了 X', evidence: 'node --test 通过' }] };

  test('终审 ACCEPT → 脏清单清掉本会话范围文件；FIX_REQUIRED 不清脏', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    postEdit(dir, 'src/a.js');
    assert.ok(readDirty(dir).files['src/a.js'], '前置：脏标记已置');
    assert.equal(review(dir, ['start']).code, 0, out(review(dir, ['status'])));
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    // 先报 error → FIX_REQUIRED：不清脏
    assert.equal(review(dir, ['lens', 'correctness'], { findings: [{ severity: 'error', message: 'm', location: 'src/a.js:2' }] }).code, 0);
    assert.equal(review(dir, ['verdict']).code, 2, 'error 发现必须 FIX_REQUIRED');
    assert.ok(readDirty(dir).files['src/a.js'], 'FIX_REQUIRED 不得清脏');
    // 修复后重开评审 → ACCEPT：清脏
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], { findings: [] }).code, 0);
    assert.equal(review(dir, ['verdict']).code, 0, '无 error 发现必须 ACCEPT');
    assert.deepEqual(readDirty(dir).files, {}, '终审 ACCEPT 必须清脏');
    // 清脏后 Stop 完成门不得再指「未经评审」：缺 fresh receipt 的拦截是既有语义仍会发生，
    // 但拦截原因不得再混入评审指引（落实为真实断言——此前的 assert.ok(logs.length >= 0) 恒真，
    // 是评审发现的死断言，不锁定任何行为）。
    const afterClear = stop(dir);
    assert.equal(afterClear.code, 2, '缺 fresh receipt 仍按完成门阻断（既有语义）');
    const lastGate = gateLog(dir).filter((entry) => entry.rule === 'completion-gate').at(-1);
    assert.doesNotMatch(lastGate.reason, /未经评审/, `清脏后不得再指「未经评审」：${lastGate.reason}`);
  });

  test('终审 ACCEPT 清脏失败（review-dirty.json 被目录占用）→ verdict 仍 exit 0 且 dirty-clear-failed 留痕', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    postEdit(dir, 'src/a.js');
    assert.ok(readDirty(dir).files['src/a.js'], '前置：脏标记已置');
    // 清脏故障注入：状态文件路径被目录占用，updateState 读写必炸（EISDIR/ENOTDIR）。
    // 契约（trust 回归）：清脏失败不拖死裁决——残余脏标记会被 Stop 继续拦，方向安全；
    // 但绝不静默吞：stderr + gate-log dirty-clear-failed 留痕，让「ACCEPT 了还拦」可排障。
    fs.rmSync(path.join(dir, DIRTY));
    fs.mkdirSync(path.join(dir, DIRTY));
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], { findings: [] }).code, 0);
    const verdict = review(dir, ['verdict']);
    assert.equal(verdict.code, 0, `清脏失败不得拖死 ACCEPT 裁决，实际 ${verdict.code}: ${out(verdict)}`);
    assert.match(verdict.stderr, /清脏失败/, `清脏失败必须 stderr 可见：${verdict.stderr}`);
    assert.ok(gateLog(dir).some((entry) => entry.rule === 'dirty-clear-failed'), '清脏失败必须记 gate-log dirty-clear-failed');
  });
});

// ---------------- REQ-080：feedback 信号检测（prompt-submit） ----------------

describe('feedback 信号检测', RT, () => {
  test('收窄高信号词命中 → 注入提示并点名 feedback-observer；宽词不误报', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    for (const prompt of ['你搞错了，应该是 50 条一批', '这样做不对', '别这样改', '重做']) {
      const r = promptSubmit(dir, prompt);
      assert.equal(r.code, 0, `prompt-submit 必须 exit 0，实际 ${r.code}`);
      assert.match(r.stdout, /修正信号/, `「${prompt}」必须命中修正信号`);
      assert.match(r.stdout, /feedback-observer/, '提示必须指引派发 feedback-observer');
    }
    for (const prompt of ['能不能帮我看看这个问题', '为什么这样实现', '帮我加个按钮']) {
      const r = promptSubmit(dir, prompt);
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '', `宽词「${prompt}」不得误报，实际输出：${r.stdout}`);
    }
  });
});

// ---------------- REQ-081：feedback record 评分 evidence 校验 ----------------

describe('feedback record 评分 evidence 校验', RT, () => {
  const SCORES = JSON.stringify({ accuracy: 3, coverage: 3, efficiency: 4, satisfaction: 3 });
  const EVIDENCE = JSON.stringify({ accuracy: '修正 3+ 处', coverage: '2 处临时决策', efficiency: '1 次澄清', satisfaction: '提了修改意见' });

  test('带 --scores 无 --evidence → exit 1 且不落盘；带齐 → exit 0 落 frontmatter', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const noEvidence = run(['feedback', 'record', '--topic', 'score-ev', '--type', 'skill-effectiveness', '--description', 'x', '--scores', SCORES], { cwd: dir });
    assert.equal(noEvidence.code, 1, `带分数缺 evidence 必须 exit 1，实际 ${noEvidence.code}: ${out(noEvidence)}`);
    assert.ok(!exists(dir, '.kimi-base/feedback/score-ev.md'), '被拒记录不得落盘');
    const ok = run(['feedback', 'record', '--topic', 'score-ev', '--type', 'skill-effectiveness', '--description', 'x', '--scores', SCORES, '--evidence', EVIDENCE], { cwd: dir });
    assert.equal(ok.code, 0, `带齐 evidence 必须 exit 0，实际 ${ok.code}: ${out(ok)}`);
    const text = read(dir, '.kimi-base/feedback/score-ev.md');
    assert.match(text, /^scores:/m, 'frontmatter 必须落 scores');
    assert.match(text, /修正 3\+ 处/, 'evidence 必须逐分落盘');
  });

  test('evidence 缺维度 / scores 值越界 → exit 1', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const partial = run(['feedback', 'record', '--topic', 'ev-partial', '--type', 'skill-effectiveness', '--description', 'x', '--scores', SCORES, '--evidence', JSON.stringify({ accuracy: '只给一分依据' })], { cwd: dir });
    assert.equal(partial.code, 1, `evidence 缺维度必须 exit 1，实际 ${partial.code}: ${out(partial)}`);
    assert.doesNotMatch(out(partial), /未知 flag/, '拒绝必须来自 evidence 校验而非 flag 未注册');
    const badScore = run(['feedback', 'record', '--topic', 'ev-bad', '--type', 'skill-effectiveness', '--description', 'x', '--scores', JSON.stringify({ accuracy: 9 }), '--evidence', JSON.stringify({ accuracy: 'x' })], { cwd: dir });
    assert.equal(badScore.code, 1, `分数越界（非 1-5 整数）必须 exit 1，实际 ${badScore.code}: ${out(badScore)}`);
    assert.doesNotMatch(out(badScore), /未知 flag/, '拒绝必须来自 scores 校验而非 flag 未注册');
  });

  test('无分数条目照常记录（不带 --scores 不需要 --evidence）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const r = run(['feedback', 'record', '--topic', 'plain-entry', '--type', 'user-correction', '--description', '用户修正了导入粒度'], { cwd: dir });
    assert.equal(r.code, 0, `无分数 record 必须不受影响，实际 ${r.code}: ${out(r)}`);
    assert.ok(exists(dir, '.kimi-base/feedback/plain-entry.md'));
  });
});
