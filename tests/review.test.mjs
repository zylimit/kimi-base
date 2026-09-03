/**
 * tests/review.test.mjs
 * 结构化对抗评审（review 动词族）契约测试（零第三方依赖，node:test）。
 *
 * 运行：node --test tests/review.test.mjs
 *
 * 追溯：REQ-031（结构化对抗评审：blue 自证/lens 报到校验/计算裁决/回执只认终审 ACCEPT/会话绑指纹）。
 *
 * 纪律（同 harness.test.mjs）：
 * - 每条用例独立临时 git 仓（os.tmpdir 下 mkdtemp），断言退出码与 stdout/状态文件 JSON 字段，
 *   不断言 stderr 文本。
 * - 契约来自协议规格（docs/PROTOCOLS.md 第 11 节），不是实现细节。
 * - 环境无 git 时依赖 git 的用例 t.skip() 明示跳过（不假绿）。
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

const SESSION = '.kimi-base/state/review/session.json';
const BACKLOG = '.kimi-base/state/review-backlog.json';
const RECEIPTS_DIR = '.kimi-base/state/receipts';

// ---------------- 基础辅助 ----------------

function mkdtemp(t, prefix = 'kimi-base-review-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
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

// ---------------- 夹具 ----------------

function writeHarness(dir) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1 }, null, 2));
}
function writeMatrix(dir, checks) {
  write(dir, '.kimi-base/verification-matrix.json', JSON.stringify({
    version: 1,
    riskKinds: { low: ['static'], medium: ['static'], high: ['static', 'security'] },
    checks,
  }, null, 2));
}
/**
 * 评审夹具：git 仓 + harness + catalog（可带 attributes/review 段）+ src/a.js（已提交）。
 * 调用后工作树干净；用 dirty() 制造待审改动。
 */
function reviewFixture(t, { attributes, review, checks } = {}) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({
    version: 1,
    modules: [{ id: 'app', root: 'src', paths: ['**'], ...(attributes ? { attributes } : {}) }],
    ...(review ? { review } : {}),
  }, null, 2));
  if (checks) writeMatrix(dir, checks);
  write(dir, 'src/a.js', 'export const a = 1;\n');
  gitInitCommit(dir);
  return dir;
}
function dirty(dir) {
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
}

const BLUE = { claims: [{ claim: '实现了 X', evidence: 'node --test 通过' }] };
const CLEAN = { findings: [] };
/** review 子命令调用；payload 以 stdin JSON 喂入（不经 shell，零转义层） */
function review(dir, args, payload) {
  return run(['review', ...args], { cwd: dir, input: payload === undefined ? undefined : JSON.stringify(payload) });
}
function readSession(dir) {
  return JSON.parse(read(dir, SESSION));
}
function reviewReceipts(dir) {
  const abs = path.join(dir, RECEIPTS_DIR);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((name) => name.startsWith('review') && name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(abs, name), 'utf8')));
}

// ---------------- 会话开启与绑定 ----------------

describe('review 会话开启与绑定', RT, () => {
  test('start 开启会话并绑定当前指纹；status 报告 fresh 与未报到 lens', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'team' } });
    dirty(dir);
    const start = review(dir, ['start']);
    assert.equal(start.code, 0, out(start));
    assert.ok(exists(dir, SESSION), '会话应落盘 state/review/session.json');
    const session = readSession(dir);
    assert.equal(session.version, 1);
    assert.match(session.diffHash, /^[0-9a-f]{64}$/);
    assert.match(session.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(session.scope.paths.includes('src/a.js'), `scope 应含变更路径: ${session.scope.paths}`);
    assert.ok(session.requiredLenses.includes('correctness'), 'correctness 是每次评审的地板');
    assert.equal(session.blue, null);
    assert.equal(session.verdict, null);
    const status = review(dir, ['status']);
    assert.equal(status.code, 0, out(status));
    assert.match(status.stdout, /correctness/, 'status 应列出未报到 lens');
  });

  test('空 diff（工作树干净且无 --base）→ exit 3（no-change 降级）', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'team' } });
    const r = review(dir, ['start']);
    assert.equal(r.code, 3, `空 diff 必须 exit 3，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /no-change|没有可评审/, '应点名 no-change');
  });

  test('任何编辑都会使会话 stale → 后续操作 exit 4', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'team' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    dirty(dir); // 会话开启后再改一个字节
    const blue = review(dir, ['blue'], BLUE);
    assert.equal(blue.code, 4, `陈旧会话必须 exit 4，实际 ${blue.code}: ${out(blue)}`);
    const lens = review(dir, ['lens', 'correctness'], CLEAN);
    assert.equal(lens.code, 4, `陈旧会话 lens 也必须 exit 4，实际 ${lens.code}: ${out(lens)}`);
    const verdict = review(dir, ['verdict']);
    assert.equal(verdict.code, 4, `陈旧会话 verdict 也必须 exit 4，实际 ${verdict.code}: ${out(verdict)}`);
    // status 是报告不是操作：会话存在即 exit 0，但应可见 stale
    const status = review(dir, ['status']);
    assert.equal(status.code, 0, out(status));
    assert.match(status.stdout, /stale|陈旧/i, 'status 应如实显示 stale');
  });

  test('无会话：status exit 3；blue/lens/verdict exit 1；非 git 仓 start exit 3', (t) => {
    const dir = mkdtemp(t); // 无 git
    writeHarness(dir);
    assert.equal(review(dir, ['status']).code, 3, 'status 无会话必须 exit 3');
    assert.equal(review(dir, ['blue'], BLUE).code, 1, 'blue 无会话必须 exit 1');
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 1, 'lens 无会话必须 exit 1');
    assert.equal(review(dir, ['verdict']).code, 1, 'verdict 无会话必须 exit 1');
    assert.equal(review(dir, ['start']).code, 3, '非 git 仓 start 必须 exit 3（降级，不假绿）');
  });
});

// ---------------- blue 校验 ----------------

describe('review blue 校验', RT, () => {
  test('空 claims / 缺 evidence / 空 claim 一律整批拒绝 exit 1；合法载荷 exit 0', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], {}).code, 1, '缺 claims 应拒');
    assert.equal(review(dir, ['blue'], { claims: [] }).code, 1, '空 claims 应拒');
    assert.equal(review(dir, ['blue'], { claims: [{ claim: 'x' }] }).code, 1, '缺 evidence 应拒');
    assert.equal(review(dir, ['blue'], { claims: [{ claim: '  ', evidence: 'e' }] }).code, 1, '空 claim 应拒');
    // 拒绝不留下任何痕迹：合法载荷仍可作为首次自证
    const ok = review(dir, ['blue'], BLUE);
    assert.equal(ok.code, 0, out(ok));
    assert.equal(readSession(dir).blue.claims.length, 1);
  });
});

// ---------------- lens 校验 ----------------

describe('review lens 校验', RT, () => {
  test('finding 无 location/reproduction → 整批拒绝 exit 1；severity 非法 → exit 1；unable 无理由 → exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const noAnchor = review(dir, ['lens', 'correctness'], { findings: [{ severity: 'error', message: 'm' }] });
    assert.equal(noAnchor.code, 1, `无落点发现必须整批拒绝，实际 ${noAnchor.code}: ${out(noAnchor)}`);
    const badSeverity = review(dir, ['lens', 'correctness'], { findings: [{ severity: 'fatal', message: 'm', location: 'src/a.js:1' }] });
    assert.equal(badSeverity.code, 1, '非法 severity 应拒');
    const mixed = review(dir, ['lens', 'correctness'], {
      findings: [
        { severity: 'warning', message: 'ok', location: 'src/a.js:2' },
        { severity: 'error', message: '无落点' },
      ],
    });
    assert.equal(mixed.code, 1, '一条坏 finding 拒绝整批');
    assert.deepEqual(readSession(dir).lenses, {}, '被拒批次不得在会话中留下 lens 记录');
    const unableNoReason = review(dir, ['lens', 'correctness'], { findings: [], unable: true });
    assert.equal(unableNoReason.code, 1, 'unable 无理由应拒（白卷不算证据）');
  });

  test('location 接受 repo 相对路径与 Windows 路径；reproduction 可替代 location', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const winPath = review(dir, ['lens', 'correctness'], {
      findings: [{ severity: 'warning', message: 'Windows 路径落点', location: 'D:\\src\\x.ts:12' }],
    });
    assert.equal(winPath.code, 0, `Windows 路径 D:\\src\\x.ts:12 必须被接受: ${out(winPath)}`);
    const winPathCol = review(dir, ['lens', 'correctness'], {
      findings: [{ severity: 'info', message: '带列号', location: 'src/a.js:12:34' }],
    });
    assert.equal(winPathCol.code, 0, `file:line:col 形态必须被接受: ${out(winPathCol)}`);
    const repro = review(dir, ['lens', 'correctness'], {
      findings: [{ severity: 'error', message: '复现路径代替落点', reproduction: 'node repro.js → 抛 TypeError' }],
    });
    assert.equal(repro.code, 0, out(repro));
    const session = readSession(dir);
    // 同一 lens 重复报到 = 覆盖（latest-wins）：最后一次合法报到为准
    assert.equal(session.lenses.correctness.findings.length, 1);
    assert.equal(session.lenses.correctness.findings[0].reproduction, 'node repro.js → 抛 TypeError');
  });
});

// ---------------- 阶段门控 ----------------

describe('review 阶段门控', RT, () => {
  // production 剖面 + 模块定档 reliability/security high → 召集 [correctness(1), testing(2), security(3), reliability(3)]
  test('阶段 3 lens 在前序阶段齐报前被拒（stageGated:true exit 1），阶段推进后放行', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      attributes: { reliability: 'high', security: 'high' },
      review: { profile: 'production' },
    });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const gated = review(dir, ['lens', 'security'], CLEAN);
    assert.equal(gated.code, 1, `阶段 3 lens 抢跑必须 exit 1，实际 ${gated.code}: ${out(gated)}`);
    assert.match(gated.stdout, /stageGated:true/, '拒绝必须带 stageGated:true 标记');
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    const stillGated = review(dir, ['lens', 'security'], CLEAN);
    assert.equal(stillGated.code, 1, '阶段 2 未齐报时阶段 3 仍应被拒');
    assert.match(stillGated.stdout, /stageGated:true/);
    assert.equal(review(dir, ['lens', 'testing'], CLEAN).code, 0);
    assert.equal(review(dir, ['lens', 'security'], CLEAN).code, 0, '阶段推进到 3 后应放行');
  });
});

// ---------------- 裁决 ----------------

describe('review verdict 裁决优先级', RT, () => {
  test('阻断：blue 未自证 / 前沿阶段 lens 未报到 → exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const noBlue = review(dir, ['verdict']);
    assert.equal(noBlue.code, 1, `blue 缺失必须阻断 exit 1，实际 ${noBlue.code}: ${out(noBlue)}`);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    const noLens = review(dir, ['verdict']);
    assert.equal(noLens.code, 1, '前沿阶段 lens 未报到必须阻断 exit 1');
  });

  test('一个 error 不被干净 lens 投票压过 → FIX_REQUIRED exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      attributes: { reliability: 'high' },
      review: { profile: 'team' },
    });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], {
      findings: [{ severity: 'error', message: '边界漏判', location: 'src/a.js:2' }],
    }).code, 0);
    assert.equal(review(dir, ['lens', 'testing'], CLEAN).code, 0);
    const verdict = review(dir, ['verdict']);
    assert.equal(verdict.code, 2, `存在 error 必须 FIX_REQUIRED exit 2，实际 ${verdict.code}: ${out(verdict)}`);
    assert.match(verdict.stdout, /FIX_REQUIRED/);
    assert.equal(reviewReceipts(dir).length, 0, 'FIX_REQUIRED 绝不写回执');
  });

  test('应到 lens 报 unable → NEEDS_MORE_EVIDENCE exit 3', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      attributes: { reliability: 'high' },
      review: { profile: 'team' },
    });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    assert.equal(review(dir, ['lens', 'testing'], { findings: [], unable: true, unableReason: '缺集成测试环境' }).code, 0);
    const verdict = review(dir, ['verdict']);
    assert.equal(verdict.code, 3, `unable 必须 NEEDS_MORE_EVIDENCE exit 3，实际 ${verdict.code}: ${out(verdict)}`);
    assert.match(verdict.stdout, /NEEDS_MORE_EVIDENCE/);
  });

  test('maxRounds 触顶：FIX_REQUIRED 达 maxRounds → escalate:true 并建议停止重试', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal', maxRounds: 2 } });
    dirty(dir);
    const errorFinding = { findings: [{ severity: 'error', message: '仍然错', reproduction: 'node repro.js' }] };
    // 第 1 轮
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], errorFinding).code, 0);
    const round1 = review(dir, ['verdict']);
    assert.equal(round1.code, 2);
    assert.doesNotMatch(round1.stdout, /escalate:true/, '第 1 轮（未触顶）不得 escalate');
    // 重开：上轮裁决摘要进 lineage
    const restart = review(dir, ['start']);
    assert.equal(restart.code, 0, out(restart));
    assert.equal(readSession(dir).lineage.length, 1, '重开后 lineage 应留存上轮裁决');
    assert.equal(readSession(dir).lineage[0].verdict, 'FIX_REQUIRED');
    // 第 2 轮（= maxRounds）
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], errorFinding).code, 0);
    const round2 = review(dir, ['verdict']);
    assert.equal(round2.code, 2);
    assert.match(round2.stdout, /escalate:true/, '触顶必须 escalate:true');
    assert.match(round2.stdout, /停止重试，交由人类裁决/, '触顶建议必须要求人类裁决');
  });

  test('回执只在终审 ACCEPT 时写入：非终审 ACCEPT exit 0 但不写回执', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      attributes: { reliability: 'high' },
      review: { profile: 'team' }, // 召集 [correctness(1), testing(2)]
    });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    const nonFinal = review(dir, ['verdict']);
    assert.equal(nonFinal.code, 0, `阶段 1 通过应 ACCEPT exit 0，实际 ${nonFinal.code}: ${out(nonFinal)}`);
    assert.match(nonFinal.stdout, /final:false/, '非终审必须标 final:false');
    assert.equal(reviewReceipts(dir).length, 0, '非终审 ACCEPT 不得写回执');
    assert.equal(review(dir, ['lens', 'testing'], CLEAN).code, 0);
    const final = review(dir, ['verdict', '--reviewer', 'judge-1']);
    assert.equal(final.code, 0, out(final));
    assert.match(final.stdout, /final:true/, '终审必须标 final:true');
    const receipts = reviewReceipts(dir);
    assert.equal(receipts.length, 1, '终审 ACCEPT 必须写且只写一份回执');
    const receipt = receipts[0];
    assert.equal(receipt.kind, 'review');
    assert.equal(receipt.verdict, 'ACCEPT');
    assert.equal(receipt.final, true);
    assert.equal(receipt.reviewer, 'judge-1');
    assert.deepEqual([...receipt.lenses].sort(), ['correctness', 'testing'], '回执必须带 lens 覆盖');
    assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
    assert.match(receipt.contentHash, /^[0-9a-f]{64}$/);
    // 回执进哈希链账本
    const ledgerLines = read(dir, '.kimi-base/state/ledger.jsonl').split('\n').filter(Boolean);
    const last = JSON.parse(ledgerLines[ledgerLines.length - 1]);
    assert.equal(last.kind, 'review', '账本尾必须是 review 回执');
    assert.equal(last.contentHash, receipt.contentHash, '账本与 receipts 镜像必须一致');
  });
});

// ---------------- ad-hoc 通道 ----------------

describe('review lens --ad-hoc 额外证据通道', RT, () => {
  test('非召集 lens 无 --ad-hoc 被拒；--ad-hoc 记录且其 error 强制 FIX_REQUIRED', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } }); // 只召集 correctness
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const refused = review(dir, ['lens', 'security'], CLEAN);
    assert.equal(refused.code, 1, '非召集 lens 无 --ad-hoc 必须拒绝');
    const adHoc = review(dir, ['lens', 'security', '--ad-hoc'], {
      findings: [{ severity: 'error', message: '注入风险', location: 'src/a.js:2' }],
    });
    assert.equal(adHoc.code, 0, `--ad-hoc 必须能记录非召集 lens: ${out(adHoc)}`);
    assert.equal(readSession(dir).lenses.security.adHoc, true, 'ad-hoc 报到必须留痕');
    // ad-hoc 不占应到清单：correctness 齐报即为终审
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    const verdict = review(dir, ['verdict']);
    assert.equal(verdict.code, 2, `ad-hoc 的 error 发现必须压过全部 clean 应到 lens，实际 ${verdict.code}: ${out(verdict)}`);
    assert.match(verdict.stdout, /FIX_REQUIRED/);
  });

  test('--ad-hoc 不受阶段门控（被收缩挡在门外的 lens 必须有上报通道）', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      attributes: { reliability: 'high' },
      review: { profile: 'team' }, // security 不在剖面内 → 非召集
    });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const adHoc = review(dir, ['lens', 'security', '--ad-hoc'], CLEAN);
    assert.equal(adHoc.code, 0, `阶段 1 时 ad-hoc 阶段 3 lens 也必须能上报: ${out(adHoc)}`);
  });
});

// ---------------- range 模式 ----------------

describe('review start --base（range 模式）', RT, () => {
  function rangeFixture(t) {
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    const base = git(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second');
    return { dir, base };
  }

  test('range 会话绑定 range.head；HEAD 不变即有效（工作树编辑不 stale）；HEAD 移动 → exit 4', (t) => {
    if (!needGit(t)) return;
    const { dir, base } = rangeFixture(t);
    const head = git(dir, 'rev-parse', 'HEAD');
    const start = review(dir, ['start', '--base', base]);
    assert.equal(start.code, 0, out(start));
    const session = readSession(dir);
    assert.equal(session.range.base, base);
    assert.equal(session.range.head, head, 'range.head 必须绑定开启时的 HEAD');
    assert.match(session.range.hash, /^[0-9a-f]{64}$/);
    // 工作树编辑不影响 range 会话（评审对象是提交范围）
    dirty(dir);
    assert.equal(review(dir, ['blue'], BLUE).code, 0, 'HEAD 不变时脏工作树不得使 range 会话 stale');
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    assert.equal(review(dir, ['verdict']).code, 0, out(read(dir, SESSION)));
    assert.equal(reviewReceipts(dir).length, 1, 'range 终审 ACCEPT 必须写回执');
    assert.equal(reviewReceipts(dir)[0].range.head, head, '回执必须携带 range');
    // HEAD 移动 → stale
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'third');
    const blue = review(dir, ['blue'], BLUE);
    assert.equal(blue.code, 4, `HEAD 移动后 range 会话必须 stale exit 4，实际 ${blue.code}: ${out(blue)}`);
  });

  test('空 range（--base HEAD）→ exit 3；无效 ref → exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    const empty = review(dir, ['start', '--base', 'HEAD']);
    assert.equal(empty.code, 3, `空 range 必须 exit 3（no-change），实际 ${empty.code}: ${out(empty)}`);
    const bogus = review(dir, ['start', '--base', 'no-such-ref-9f8e7d']);
    assert.equal(bogus.code, 1, `无效 --base ref 必须 exit 1，实际 ${bogus.code}: ${out(bogus)}`);
  });
});

// ---------------- backlog ----------------

describe('review backlog（跨会话持久）', RT, () => {
  test('add 校验（缺字段/过去 expiry exit 1）；重开评审后 backlog 存活；list 标记过期', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const missing = review(dir, ['backlog', 'add'], { owner: '张三', summary: 'x' });
    assert.equal(missing.code, 1, '缺 expiry/lens 必须拒绝');
    const past = review(dir, ['backlog', 'add'], { owner: '张三', expiry: '2000-01-01T00:00:00Z', summary: 'x', lens: 'performance' });
    assert.equal(past.code, 1, '过期 expiry 必须拒绝（没有截止日的债永远没人还）');
    const ok = review(dir, ['backlog', 'add'], { owner: '张三', expiry: '2099-01-01T00:00:00Z', summary: '性能优化挂账', lens: 'performance' });
    assert.equal(ok.code, 0, out(ok));
    // 重开评审：backlog 不得被冲掉（dsh 缺陷：backlog 存在会话里被重开清空）
    assert.equal(review(dir, ['start']).code, 0);
    const list = review(dir, ['backlog', 'list']);
    assert.equal(list.code, 0, out(list));
    assert.match(list.stdout, /性能优化挂账/, '重开后 backlog 必须存活');
    const stored = JSON.parse(read(dir, BACKLOG));
    assert.equal(stored.entries.length, 1, 'backlog 必须存于 state/review-backlog.json（独立于会话）');
    assert.equal(stored.entries[0].expired ?? false, false, '存储条目不预判 expired（list 时计算）');
    // status 应显示结转数量
    const status = review(dir, ['status']);
    assert.match(status.stdout, /backlog 结转：1 条/, 'status 必须显示结转 backlog');
  });

  test('受保护发现（security/密码 等禁词）永不可进 backlog → exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    for (const summary of ['security 隐患待修', 'privacy: 手机号脱敏缺失', '数据库密码轮换挂账']) {
      const r = review(dir, ['backlog', 'add'], { owner: '张三', expiry: '2099-01-01T00:00:00Z', summary, lens: 'security' });
      assert.equal(r.code, 1, `受保护发现「${summary}」必须拒绝进 backlog，实际 ${r.code}: ${out(r)}`);
    }
    assert.ok(!exists(dir, BACKLOG) || JSON.parse(read(dir, BACKLOG)).entries.length === 0, '受保护条目不得入账');
  });

  test('risk scan 标记过期 backlog 条目', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { review: { profile: 'personal' } });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['backlog', 'add'], { owner: '张三', expiry: '2099-01-01T00:00:00Z', summary: '性能优化挂账', lens: 'performance' }).code, 0);
    // 直接改状态文件模拟时间流逝（backlog add 创建期拒收过去时间，只能这样构造过期）
    const stored = JSON.parse(read(dir, BACKLOG));
    stored.entries[0].expiry = '2000-01-01T00:00:00.000Z';
    write(dir, BACKLOG, JSON.stringify(stored, null, 2));
    const scan = run(['risk', 'scan'], { cwd: dir });
    assert.match(scan.stdout, /review-backlog-expired/, `risk scan 必须标记过期 backlog: ${scan.stdout}`);
  });
});

// ---------------- review pack ----------------

describe('review pack 证据包', RT, () => {
  test('生成 pack（base 解析/commit 清单/删除审计/未跟踪/完整 diff）；非 git 仓 exit 3', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {});
    git(dir, 'tag', 'v0.1.0');
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second');
    git(dir, 'rm', '-q', 'src/a.js');
    git(dir, 'commit', '-q', '-m', 'third: delete a.js');
    write(dir, 'scratch.js', '// untracked\n');
    const r = review(dir, ['pack']);
    assert.equal(r.code, 0, out(r));
    const packs = fs.readdirSync(path.join(dir, '.kimi-base/state/review')).filter((name) => /^review-pack-\d+\.md$/.test(name));
    assert.equal(packs.length, 1, '应生成唯一 pack 文件');
    const body = read(dir, `.kimi-base/state/review/${packs[0]}`);
    assert.match(body, /v0\.1\.0/, 'base 应解析到最新 tag');
    assert.match(body, /Commit 清单/);
    assert.match(body, /second|third/, 'commit 清单应含新提交');
    assert.match(body, /src\/a\.js/, '删除审计必须点名被删文件');
    assert.match(body, /scratch\.js/, '未跟踪文件必须列出');
    assert.match(body, /```diff/, '应内联完整 diff（未超 800 行）');
    const noGit = mkdtemp(t);
    writeHarness(noGit);
    assert.equal(review(noGit, ['pack']).code, 3, '非 git 仓 review pack 必须 exit 3');
  });
});

// ---------------- 完成门接线 ----------------

describe('review → task complete 完成门接线', RT, () => {
  const CHECKS = [
    { id: 'static-ok', kind: 'static', command: 'node -e "process.exit(0)"' },
    { id: 'sec-ok', kind: 'security', command: 'node -e "process.exit(0)"' },
  ];

  test('catalog 声明 review 段且 risk=high：缺评审回执 exit 2；终审 ACCEPT 后放行', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      review: { profile: 'team', maxRounds: 3, requireStructured: true },
      checks: CHECKS,
    });
    assert.equal(run(['task', 'start', '--goal', '高风险改动', '--owned', 'src', '--risk', 'high'], { cwd: dir }).code, 0);
    dirty(dir);
    assert.equal(run(['gate', '--risk', 'high'], { cwd: dir }).code, 0, 'gate 应跑通');
    const blocked = run(['task', 'complete'], { cwd: dir });
    assert.equal(blocked.code, 2, `缺评审回执完成门必须 exit 2，实际 ${blocked.code}: ${out(blocked)}`);
    assert.match(blocked.stdout, /review|评审/, '缺口必须点名评审回执');
    // 跑完整评审（team 收缩后仅剩 correctness：模块无定档）
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    assert.equal(review(dir, ['verdict']).code, 0);
    assert.equal(reviewReceipts(dir).length, 1);
    const done = run(['task', 'complete'], { cwd: dir });
    assert.equal(done.code, 0, `fresh 终审 ACCEPT 回执后完成门应放行: ${out(done)}`);
  });

  test('评审回执 stale 后完成门重新拦截（任何编辑使证据失效）', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      review: { profile: 'team', requireStructured: true },
      checks: CHECKS,
    });
    assert.equal(run(['task', 'start', '--goal', '高风险改动', '--owned', 'src', '--risk', 'high'], { cwd: dir }).code, 0);
    dirty(dir);
    assert.equal(run(['gate', '--risk', 'high'], { cwd: dir }).code, 0);
    assert.equal(review(dir, ['start']).code, 0);
    assert.equal(review(dir, ['blue'], BLUE).code, 0);
    assert.equal(review(dir, ['lens', 'correctness'], CLEAN).code, 0);
    assert.equal(review(dir, ['verdict']).code, 0);
    dirty(dir); // 回执后任何编辑 → 指纹移动
    assert.equal(run(['gate', '--risk', 'high'], { cwd: dir }).code, 0, '新指纹下 gate 回执需重跑');
    const blocked = run(['task', 'complete'], { cwd: dir });
    assert.equal(blocked.code, 2, `评审回执 stale 后完成门必须重新拦截，实际 ${blocked.code}: ${out(blocked)}`);
  });

  test('catalog 无 review 段：risk=high 不需要评审回执（旧行为不变）', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, { checks: CHECKS }); // 无 review 段
    assert.equal(run(['task', 'start', '--goal', '高风险改动', '--owned', 'src', '--risk', 'high'], { cwd: dir }).code, 0);
    dirty(dir);
    assert.equal(run(['gate', '--risk', 'high'], { cwd: dir }).code, 0);
    const done = run(['task', 'complete'], { cwd: dir });
    assert.equal(done.code, 0, `无 review 段不得新增完成门要求: ${out(done)}`);
  });

  test('requireStructured:false：risk=high 同样不需要评审回执', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      review: { profile: 'team', requireStructured: false },
      checks: CHECKS,
    });
    assert.equal(run(['task', 'start', '--goal', '高风险改动', '--owned', 'src', '--risk', 'high'], { cwd: dir }).code, 0);
    dirty(dir);
    assert.equal(run(['gate', '--risk', 'high'], { cwd: dir }).code, 0);
    const done = run(['task', 'complete'], { cwd: dir });
    assert.equal(done.code, 0, `requireStructured:false 必须保持旧行为: ${out(done)}`);
  });
});

// ---------------- catalog review 段校验 ----------------

describe('catalog review 段配置校验', RT, () => {
  test('非法 profile / 未知 lens / maxRounds 越界 → catalog lint exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {});
    const lint = () => run(['catalog', 'lint'], { cwd: dir });
    assert.equal(lint().code, 0, '前置：无 review 段时 lint 通过');
    const writeReview = (review) => write(dir, '.kimi-base/module-catalog.json', JSON.stringify({
      version: 1,
      modules: [{ id: 'app', root: 'src', paths: ['**'] }],
      review,
    }, null, 2));
    writeReview({ profile: 'bogus' });
    assert.equal(lint().code, 1, '非法 profile 必须 exit 1');
    writeReview({ lenses: ['correctness', 'no-such-lens'] });
    assert.equal(lint().code, 1, '未知 lens 名必须 exit 1');
    writeReview({ maxRounds: 0 });
    assert.equal(lint().code, 1, 'maxRounds 0 必须 exit 1');
    writeReview({ maxRounds: 11 });
    assert.equal(lint().code, 1, 'maxRounds >10 必须 exit 1');
    writeReview({ profile: 'team', lenses: ['correctness'], maxRounds: 3, requireStructured: true });
    assert.equal(lint().code, 0, '合法 review 段必须放行');
  });

  test('显式 lenses 胜出剖面；属性收缩只缩不扩并记录剔除原因', (t) => {
    if (!needGit(t)) return;
    const dir = reviewFixture(t, {
      attributes: { security: 'high' },
      review: { lenses: ['correctness', 'security', 'testing'] },
    });
    dirty(dir);
    assert.equal(review(dir, ['start']).code, 0);
    const session = readSession(dir);
    // 显式集胜出（testing 不在 team 剖面默认推导路径上——这里它由显式集引入），
    // 属性收缩剔除 testing（模块未声明 reliability ≥ low），correctness 无属性永不剔除。
    assert.deepEqual([...session.requiredLenses].sort(), ['correctness', 'security']);
    assert.equal(session.excludedLenses.length, 1);
    assert.equal(session.excludedLenses[0].lens, 'testing');
    assert.match(session.excludedLenses[0].reason, /reliability/, '剔除原因必须点名属性');
    const team = review(dir, ['team']);
    assert.equal(team.code, 0);
    assert.match(team.stdout, /testing/, 'review team 必须显示剔除项');
  });
});
