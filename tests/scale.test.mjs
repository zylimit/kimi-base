/**
 * tests/scale.test.mjs
 * P6 规模化与治理深化行为测试（零第三方依赖，node:test）：
 *   catalog discover / cochange / budget / fleet / privacy 保护底线 / release。
 * 追溯：REQ-039（discover）REQ-040（cochange）REQ-041（budget）REQ-042（fleet）
 *   REQ-043（privacy 底线）REQ-044（release）。
 *
 * 纪律：每条用例独立临时 git 仓（os.tmpdir 下 mkdtemp），经真实 CLI 子进程断言
 * 退出码与结构化字段；环境无 git 时 git 用例显式 skip（不假绿）。
 * 运行：node --test tests/scale.test.mjs
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
const RT = RUNTIME_OK ? {} : { skip: 'runtime 未就绪' };

function mkdtemp(t, prefix = 'kimi-base-p6-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  return dir;
}

function run(args, opts = {}) {
  const { cwd = REPO, env = {}, input, timeout = 120_000 } = opts;
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
/** 追加一轮提交：files = {相对路径: 内容} */
function commitRound(dir, files, message) {
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}
function needGit(t) {
  if (!GIT_OK) {
    t.skip('环境无 git，按纪律显式跳过');
    return false;
  }
  return true;
}

// ---------------- 夹具 ----------------

function writeHarness(dir, extra = {}) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1, ...extra }, null, 2));
}
function writeCatalog(dir, fragment) {
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({ version: 1, ...fragment }, null, 2));
}
function writeMatrix(dir, checks) {
  write(dir, '.kimi-base/verification-matrix.json', JSON.stringify({
    version: 1,
    riskKinds: { low: ['static'], medium: ['static'], high: ['static', 'security'] },
    checks,
  }, null, 2));
}

/** discover 夹具：两个 packages 模块（真实 import 边）+ 测试夹具（payment 词）+ package.json（test 脚本） */
function discoverFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }, null, 2));
  write(dir, 'packages/app/index.js', 'import { util } from "../core/util.js";\nexport const app = util();\n');
  write(dir, 'packages/app/main.js', 'export const main = 1;\n');
  // 生产源码含 security 关键词（两个文件/多个词 → 强信号）
  write(dir, 'packages/core/util.js', '// auth token 校验\nexport const util = () => "ok";\n');
  write(dir, 'packages/core/store.js', '// credential 与 oauth session 存储\nexport const store = {};\n');
  // 测试夹具含 billing/payment 词——属性提案绝不许从测试文件产生
  write(dir, 'tests/billing.test.js', '// payment invoice billing refund 的测试\nimport assert from "node:assert";\nassert.ok(true);\n');
  gitInitCommit(dir);
  return dir;
}
/** 从 dry-run stdout 提取 JSON 提案（首个 "\n{" 起） */
function proposalJson(r) {
  const index = r.stdout.indexOf('\n{');
  assert.ok(index > 0, `dry-run 输出应含 JSON 提案: ${r.stdout.slice(0, 200)}`);
  return JSON.parse(r.stdout.slice(index + 1));
}

// ---------------- catalog discover ----------------

describe('catalog discover', RT, () => {
  test('提案含正确模块/真实边/位置分层；属性信号只来自生产源码', (t) => {
    if (!needGit(t)) return;
    const dir = discoverFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = new Map(proposal.draft.modules.map((m) => [m.id, m]));
    assert.ok(modules.has('app') && modules.has('core'), `应提案 app/core 模块: ${[...modules.keys()]}`);
    assert.deepEqual(modules.get('app').dependsOn, ['core'], 'app 的 dependsOn 应来自真实 import 边');
    assert.deepEqual(modules.get('core').dependsOn, []);
    assert.deepEqual(proposal.draft.layers, ['tier-1', 'tier-2']);
    assert.equal(modules.get('core').layer, 'tier-1', '无依赖的基础模块是最内层 tier-1');
    assert.equal(modules.get('app').layer, 'tier-2', '依赖者层号更大（只许依赖同层或更内层）');
    // 属性提案：core 的 security 来自生产源码；测试文件的 billing/payment 词不得产生提案
    assert.ok(proposal.attributeProposals.core?.security, 'core 应有 security 提案（两文件多词）');
    assert.equal(proposal.attributeProposals.core.security.proposedTier, 'high', '提案档位封顶 high');
    const allEvidence = JSON.stringify(proposal.attributeProposals);
    assert.ok(!allEvidence.includes('tests/'), '测试路径不得出现在任何提案证据中');
    assert.ok(!allEvidence.includes('payment'), '测试夹具的 payment 词不得触发提案');
    // 命令检测与 needsDecision
    assert.ok(proposal.detectedChecks.some((c) => c.id === 'unit'), '应检测到 unit 命令');
    const decisionFields = proposal.needsDecision.map((d) => d.field);
    assert.ok(decisionFields.includes('modules[].attributes'), '属性档位必须 needsDecision');
    assert.ok(decisionFields.includes('modules[].forbiddenDependencies'), 'forbiddenDependencies 必须 needsDecision');
    // 草案自身不带属性/禁令（拒绝猜测）
    for (const m of proposal.draft.modules) {
      assert.deepEqual(m.attributes, {}, '草案模块不得猜属性');
      assert.equal(m.forbiddenDependencies, undefined, '草案模块不得猜禁令');
    }
  });

  test('--write：无 catalog 直写且草案通过 catalog lint 与 arch check；已有 catalog 写 draft 不覆盖', (t) => {
    if (!needGit(t)) return;
    const dir = discoverFixture(t);
    const w1 = run(['catalog', 'discover', '--write'], { cwd: dir });
    assert.equal(w1.code, 0, out(w1));
    assert.ok(exists(dir, '.kimi-base/module-catalog.json'), '无 catalog 时应直写 module-catalog.json');
    assert.ok(!exists(dir, '.kimi-base/module-catalog.draft.json'), '无 catalog 时不应写 draft');
    const lint = run(['catalog', 'lint'], { cwd: dir });
    assert.equal(lint.code, 0, `草案应通过 catalog lint: ${out(lint)}`);
    const arch = run(['arch', 'check'], { cwd: dir });
    assert.equal(arch.code, 0, `草案应通过 arch check（分层方向正确）: ${out(arch)}`);
    const before = read(dir, '.kimi-base/module-catalog.json');
    const w2 = run(['catalog', 'discover', '--write'], { cwd: dir });
    assert.equal(w2.code, 0, out(w2));
    assert.ok(exists(dir, '.kimi-base/module-catalog.draft.json'), '已有 catalog 时应写 draft');
    assert.equal(read(dir, '.kimi-base/module-catalog.json'), before, '已有 catalog 绝不许被覆盖');
  });

  test('无可提案降级 exit 3（无目录成组 / 非 git）；init-modules 别名转发并注明废弃', (t) => {
    if (!needGit(t)) return;
    const empty = mkdtemp(t);
    writeHarness(empty);
    write(empty, 'README.md', '# demo\n');
    gitInitCommit(empty);
    const r = run(['catalog', 'discover'], { cwd: empty });
    assert.equal(r.code, 3, `无目录成组必须 exit 3，实际 ${r.code}: ${out(r)}`);

    const plain = mkdtemp(t);
    writeHarness(plain);
    const ng = run(['catalog', 'discover'], { cwd: plain });
    assert.equal(ng.code, 3, `非 git 仓必须 exit 3，实际 ${ng.code}: ${out(ng)}`);

    const dir = discoverFixture(t);
    const alias = run(['init-modules'], { cwd: dir });
    assert.equal(alias.code, 0, out(alias));
    assert.match(alias.stderr, /已废弃/, '别名必须在 stderr 注明废弃');
  });
});

// ---------------- cochange ----------------

describe('cochange', RT, () => {
  const COUPLING_COMMITS = [
    { 'src/a/x1.js': 'export const x1 = 1;\n', 'src/b/y1.js': 'export const y1 = 1;\n' },
    { 'src/a/x2.js': 'export const x2 = 1;\n', 'src/b/y2.js': 'export const y2 = 1;\n' },
    { 'src/a/x3.js': 'export const x3 = 1;\n', 'src/b/y3.js': 'export const y3 = 1;\n' },
  ];
  function cochangeFixture(t, catalogExtra = {}) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
        { id: 'c', root: 'src/c', paths: ['**'] },
      ],
      ...catalogExtra,
    });
    write(dir, 'src/c/z.js', 'export const z = 1;\n');
    gitInitCommit(dir);
    for (const [index, files] of COUPLING_COMMITS.entries()) commitRound(dir, files, `coupled ${index}`);
    return dir;
  }

  test('高耦合无声明边 → BOUNDARY_SUSPECT（exit 1）；薄历史附 LOW_CONFIDENCE（不拦）', (t) => {
    if (!needGit(t)) return;
    const dir = cochangeFixture(t);
    const r = run(['cochange'], { cwd: dir });
    assert.equal(r.code, 1, `BOUNDARY_SUSPECT 必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /BOUNDARY_SUSPECT/);
    assert.match(r.stdout, /LOW_CONFIDENCE/, '3 个可分析提交 < 30，必须如实报 LOW_CONFIDENCE');
  });

  test('声明边 → HIGH_COUPLING 降为 warning（exit 0）', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'], dependsOn: ['b'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
      ],
    });
    gitInitCommit(dir);
    for (const [index, files] of COUPLING_COMMITS.entries()) commitRound(dir, files, `coupled ${index}`);
    const r = run(['cochange'], { cwd: dir });
    assert.equal(r.code, 0, `已声明边只警告不拦，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /HIGH_COUPLING/);
    assert.doesNotMatch(r.stdout, /BOUNDARY_SUSPECT/);
  });

  test('cochange.accepted 三元组 → ACCEPTED_COUPLING 降级 warning（exit 0）', (t) => {
    if (!needGit(t)) return;
    const dir = cochangeFixture(t, { cochange: { accepted: [['a', 'b', '共享同主数据模型，已知的协调边界']] } });
    const r = run(['cochange'], { cwd: dir });
    assert.equal(r.code, 0, `accepted 对子只警告，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /ACCEPTED_COUPLING/);
    assert.match(r.stdout, /共享同主数据模型/, 'accept 理由必须随 finding 可见');
  });

  test('cochange 段校验：三元组缺理由 / 引用未知模块 → catalog lint exit 1', (t) => {
    if (!needGit(t)) return;
    const badShape = mkdtemp(t);
    writeHarness(badShape);
    writeCatalog(badShape, {
      modules: [{ id: 'a', root: 'src/a', paths: ['**'] }, { id: 'b', root: 'src/b', paths: ['**'] }],
      cochange: { accepted: [['a', 'b']] },
    });
    write(badShape, 'src/a/x.js', 'export const x = 1;\n');
    write(badShape, 'src/b/y.js', 'export const y = 1;\n');
    gitInitCommit(badShape);
    const r1 = run(['catalog', 'lint'], { cwd: badShape });
    assert.equal(r1.code, 1, `缺理由的 accepted 必须被校验拦下，实际 ${r1.code}: ${out(r1)}`);

    const unknown = mkdtemp(t);
    writeHarness(unknown);
    writeCatalog(unknown, {
      modules: [{ id: 'a', root: 'src/a', paths: ['**'] }],
      cochange: { accepted: [['a', 'ghost', '理由']] },
    });
    write(unknown, 'src/a/x.js', 'export const x = 1;\n');
    gitInitCommit(unknown);
    const r2 = run(['catalog', 'lint'], { cwd: unknown });
    assert.equal(r2.code, 1, `引用未知模块的 accepted 必须被拦，实际 ${r2.code}: ${out(r2)}`);
  });

  test('无提交历史（unborn）→ exit 3', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, { modules: [{ id: 'a', root: 'src/a', paths: ['**'] }] });
    write(dir, 'src/a/x.js', 'export const x = 1;\n');
    git(dir, 'init', '-q'); // 不提交：unborn HEAD
    const r = run(['cochange'], { cwd: dir });
    assert.equal(r.code, 3, `无历史必须 exit 3，实际 ${r.code}: ${out(r)}`);
  });
});

// ---------------- budget ----------------

describe('budget', RT, () => {
  function budgetFixture(t, harnessExtra = {}, withCatalog = true) {
    const dir = mkdtemp(t);
    writeHarness(dir, harnessExtra);
    if (withCatalog) writeCatalog(dir, { modules: [{ id: 'app', root: 'src', paths: ['**'] }] });
    write(dir, 'src/a.js', 'export const a = 1;\n');
    write(dir, 'src/b.js', 'export const b = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  test('未配置 budget 段 → exit 3（未激活不是通过）', (t) => {
    if (!needGit(t)) return;
    const dir = budgetFixture(t);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const a2 = 2;\n');
    const r = run(['budget'], { cwd: dir });
    assert.equal(r.code, 3, `未配置必须 exit 3，实际 ${r.code}: ${out(r)}`);
  });

  test('预算内 exit 0；超限 exit 1 且逐指标报告并给出固定话术', (t) => {
    if (!needGit(t)) return;
    const dir = budgetFixture(t, { budget: { maxChangedFiles: 10, maxChangedLines: 5000, maxModules: 5, maxNewFiles: 10 } });
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const a2 = 2;\n');
    fs.appendFileSync(path.join(dir, 'src/b.js'), 'export const b2 = 2;\n');
    const under = run(['budget'], { cwd: dir });
    assert.equal(under.code, 0, `预算内应 exit 0: ${out(under)}`);

    const over = budgetFixture(t, { budget: { maxChangedFiles: 1 } });
    fs.appendFileSync(path.join(over, 'src/a.js'), 'export const a2 = 2;\n');
    fs.appendFileSync(path.join(over, 'src/b.js'), 'export const b2 = 2;\n');
    const r = run(['budget'], { cwd: over });
    assert.equal(r.code, 1, `超限必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /changedFiles/, '必须逐指标点名');
    assert.match(r.stdout, /超出预算意味着拆分变更或升级——永不靠放宽预算消红/, '固定话术逐字出现');
  });

  test('--staged 只看暂存区；--baseline 看提交区间；坏 ref exit 1；未知配置键被严格校验拦下', (t) => {
    if (!needGit(t)) return;
    const dir = budgetFixture(t, { budget: { maxChangedFiles: 1 } });
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const a2 = 2;\n');
    fs.appendFileSync(path.join(dir, 'src/b.js'), 'export const b2 = 2;\n');
    git(dir, 'add', 'src/a.js'); // 只暂存一个文件
    const staged = run(['budget', '--staged'], { cwd: dir });
    assert.equal(staged.code, 0, `--staged 只算暂存区（1 个文件），实际 ${staged.code}: ${out(staged)}`);
    const worktree = run(['budget'], { cwd: dir });
    assert.equal(worktree.code, 1, `工作树口径 2 个文件超限，实际 ${worktree.code}: ${out(worktree)}`);

    const base = budgetFixture(t, { budget: { maxChangedFiles: 1 } });
    const ref = git(base, 'rev-parse', 'HEAD');
    commitRound(base, { 'src/c.js': 'export const c = 1;\n', 'src/d.js': 'export const d = 1;\n' }, 'range');
    const inRange = run(['budget', '--baseline', ref], { cwd: base });
    assert.equal(inRange.code, 1, `区间内 2 文件超限，实际 ${inRange.code}: ${out(inRange)}`);
    const badRef = run(['budget', '--baseline', 'no-such-ref-9f8e7d'], { cwd: base });
    assert.equal(badRef.code, 1, `坏 ref 是用法错误 exit 1，实际 ${badRef.code}: ${out(badRef)}`);

    const rotten = budgetFixture(t, { budget: { maxChangedFiles: 5, typoKey: 1 } });
    const r = run(['budget'], { cwd: rotten });
    assert.equal(r.code, 1, `未知 budget 键必须被严格校验拦下，实际 ${r.code}: ${out(r)}`);
  });
});

// ---------------- fleet ----------------

describe('fleet', RT, () => {
  function writeFleet(dir, fleet) {
    write(dir, 'fleet.json', JSON.stringify(fleet, null, 2));
  }
  function mkRepo(dir, id) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    git(dir, 'init', '-q', id);
  }

  test('lint：dangling consume / deprecated 无 sunset / sunset 已过 全为 error（exit 1）', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    mkRepo(dir, 'alpha');
    mkRepo(dir, 'beta');
    writeFleet(dir, {
      version: 1,
      name: 't',
      repos: [
        {
          id: 'alpha', path: 'alpha', owners: ['@a'],
          provides: [{ contract: 'old-api', version: '1.0.0', kind: 'http', status: 'deprecated', sunset: '2000-01-01', adr: 'docs/adr/1.md' }],
          consumes: [{ contract: 'ghost-api' }],
        },
        {
          id: 'beta', path: 'beta', owners: ['@b'],
          provides: [{ contract: 'beta-api', version: '2.0.0', kind: 'http', status: 'deprecated', adr: 'docs/adr/2.md' }],
          consumes: [{ contract: 'old-api', version: '1.x' }],
        },
      ],
    });
    const r = run(['fleet', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, `三类 error 必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /DANGLING_CONSUME/);
    assert.match(r.stdout, /DEPRECATED_WITHOUT_SUNSET/);
    assert.match(r.stdout, /SUNSET_PASSED/);
  });

  test('lint：契约环为 warning（exit 0 但响亮报告）；干净 fleet exit 0', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    mkRepo(dir, 'a');
    mkRepo(dir, 'b');
    writeFleet(dir, {
      version: 1,
      name: 't',
      repos: [
        { id: 'a', path: 'a', owners: ['@a'], provides: [{ contract: 'ca', version: '1.0.0', kind: 'http', status: 'active', adr: 'x.md' }], consumes: [{ contract: 'cb' }] },
        { id: 'b', path: 'b', owners: ['@b'], provides: [{ contract: 'cb', version: '1.0.0', kind: 'event', status: 'active', adr: 'y.md' }], consumes: [{ contract: 'ca' }] },
      ],
    });
    const r = run(['fleet', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, `warning 不拦，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /CONTRACT_CYCLE/, '跨仓契约环必须报告');

    const clean = mkdtemp(t);
    mkRepo(clean, 'solo');
    writeFleet(clean, {
      version: 1,
      name: 't',
      repos: [{ id: 'solo', path: 'solo', owners: ['@s'], provides: [{ contract: 's-api', version: '1.0.0', kind: 'http', status: 'active', adr: 'a.md', public: true }], consumes: [] }],
    });
    const ok = run(['fleet', 'lint'], { cwd: clean });
    assert.equal(ok.code, 0, `干净 fleet 应 exit 0: ${out(ok)}`);
  });

  test('impact：传递闭包与 coordinationCost；未知契约 exit 3 并给已知清单', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    for (const id of ['front', 'mid', 'base']) mkRepo(dir, id);
    writeFleet(dir, {
      version: 1,
      name: 't',
      repos: [
        { id: 'front', path: 'front', owners: ['@f'], provides: [], consumes: [{ contract: 'mid-api' }] },
        { id: 'mid', path: 'mid', owners: ['@m'], provides: [{ contract: 'mid-api', version: '2.0.0', kind: 'http', status: 'active', adr: 'm.md' }], consumes: [{ contract: 'base-schema' }] },
        { id: 'base', path: 'base', owners: ['@b'], provides: [{ contract: 'base-schema', version: '3.1.0', kind: 'schema', status: 'active', adr: 'b.md' }], consumes: [] },
      ],
    });
    const r = run(['fleet', 'impact', 'base-schema'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.match(r.stdout, /coordinationCost = 3/, `直接 mid + 传递 front + 提供方 base = 3: ${r.stdout}`);
    assert.match(r.stdout, /传播 mid --mid-api--> front/);
    const unknown = run(['fleet', 'impact', 'nope-api'], { cwd: dir });
    assert.equal(unknown.code, 3, `未知契约必须 exit 3，实际 ${unknown.code}: ${out(unknown)}`);
    assert.match(unknown.stdout, /mid-api/, '已知契约清单必须列出');
  });

  test('status：裸仓（无引擎）与缺失路径仓 → exit 1 逐仓分列；recap 对裸仓如实降级 exit 0', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    fs.mkdirSync(path.join(dir, 'bare')); // 存在但无 .kimi-base 引擎
    writeFleet(dir, {
      version: 1,
      name: 't',
      repos: [
        { id: 'bare', path: 'bare', owners: ['@x'], provides: [], consumes: [] },
        { id: 'gone', path: 'gone', owners: ['@y'], provides: [], consumes: [] },
      ],
    });
    const r = run(['fleet', 'status'], { cwd: dir });
    assert.equal(r.code, 1, `问题仓必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /bare：未安装/, '裸仓报告未安装');
    assert.match(r.stdout, /gone：路径不存在/, '缺失仓报告路径不存在');
    const recap = run(['fleet', 'recap'], { cwd: dir });
    assert.equal(recap.code, 0, out(recap));
    assert.match(recap.stdout, /## bare/, 'recap 每仓一个块');
  });

  test('无 fleet.json（单仓模式）→ exit 3', (t) => {
    const dir = mkdtemp(t);
    const r = run(['fleet', 'lint'], { cwd: dir });
    assert.equal(r.code, 3, `无 fleet.json 必须 exit 3，实际 ${r.code}: ${out(r)}`);
  });
});

// ---------------- privacy 保护底线（P6 提升） ----------------

describe('privacy 保护底线', RT, () => {
  const WAIVER_FLAGS = ['--approver', 'lead', '--reason', '工具缺失，等待安装', '--expires', '2099-01-01T00:00:00Z', '--compensation', '手工复查'];
  function privacyFixture(t, checks, moduleAttributes) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, { modules: [{ id: 'app', root: 'src', paths: ['**'], ...(moduleAttributes ? { attributes: moduleAttributes } : {}) }] });
    writeMatrix(dir, checks);
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  test('对认领 privacy 的检查创建 waiver 被拒；理由文本含"隐私"同样被拒', (t) => {
    if (!needGit(t)) return;
    const dir = privacyFixture(t, [
      { id: 'pii-scan', kind: 'static', executable: 'kimi-base-no-such-cmd-9f8e7d', attributes: ['privacy'] },
      { id: 'plain-check', kind: 'static', executable: 'kimi-base-no-such-cmd-9f8e7d' },
    ]);
    run(['gate'], { cwd: dir });
    const byAttr = run(['quality', 'waiver', 'create', '--check', 'pii-scan', ...WAIVER_FLAGS], { cwd: dir });
    assert.equal(byAttr.code, 2, `privacy 认领检查永不可豁免，实际 ${byAttr.code}: ${out(byAttr)}`);
    assert.match(out(byAttr), /WAIVER_FORBIDDEN/);
    const byReason = run(['quality', 'waiver', 'create', '--check', 'plain-check', '--approver', 'lead', '--reason', '涉及个人隐私数据，申请跳过', '--expires', '2099-01-01T00:00:00Z', '--compensation', 'x'], { cwd: dir });
    assert.equal(byReason.code, 2, `理由文本含隐私词的 waiver 同样拒绝，实际 ${byReason.code}: ${out(byReason)}`);
  });

  test('allowFastSkip 在 protected 检查上配置期拒绝：kind 侧与属性侧都要拦', (t) => {
    if (!needGit(t)) return;
    // 属性侧：认领 privacy 的 static 检查携带 allowFastSkip（dsh 的 class-vs-attributes 盲区）
    const byAttr = privacyFixture(t, [
      { id: 'pii-fast', kind: 'static', command: 'node -e "process.exit(0)"', attributes: ['privacy'], allowFastSkip: true },
    ]);
    const r1 = run(['gate', '--dry-run'], { cwd: byAttr });
    assert.equal(r1.code, 1, `privacy 属性 + allowFastSkip 必须配置期拦下，实际 ${r1.code}: ${out(r1)}`);
    assert.match(out(r1), /MATRIX_INVALID/);
    // kind 侧：security kind + allowFastSkip（既有保护，防回归）
    const byKind = privacyFixture(t, [
      { id: 'sec-fast', kind: 'security', command: 'node -e "process.exit(0)"', allowFastSkip: true },
    ]);
    const r2 = run(['gate', '--dry-run'], { cwd: byKind });
    assert.equal(r2.code, 1, `security kind + allowFastSkip 必须配置期拦下，实际 ${r2.code}: ${out(r2)}`);
    assert.match(out(r2), /MATRIX_INVALID/);
  });

  test('fast mode 运行期不得延期 privacy 属性（reliability 对照组被延期）', (t) => {
    if (!needGit(t)) return;
    const dir = privacyFixture(t, [
      { id: 'priv-check', kind: 'static', command: 'node -e "process.exit(0)"', attributes: ['privacy'] },
      { id: 'rel-check', kind: 'static', command: 'node -e "process.exit(0)"', attributes: ['reliability'] },
    ], { privacy: 'high', reliability: 'high' });
    assert.equal(run(['gate'], { cwd: dir }).code, 0, '前置 gate 取得 fresh PASS');
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    const r = run(['quality', 'status'], { cwd: dir });
    const deferredLine = r.stdout.split('\n').find((line) => line.includes('延期')) ?? '';
    assert.ok(deferredLine.includes('reliability'), `reliability 应被 fast 延期: ${r.stdout}`);
    assert.ok(!deferredLine.includes('privacy'), `privacy 绝不被 fast 延期（运行期保护）: ${r.stdout}`);
  });
});

// ---------------- release ----------------

describe('release', RT, () => {
  /** 全绿夹具：dod 静态电池九步在本夹具全部 PASS（含 spec/trace/AGENTS.md/catalog 归属） */
  function releaseFixture(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      globalPaths: ['*.md', '*.json'],
      modules: [
        { id: 'app', root: 'src', paths: ['**'] },
        { id: 'tests', root: 'tests', paths: ['**'] },
      ],
    });
    writeMatrix(dir, [{ id: 'static-ok', kind: 'static', command: 'node -e "process.exit(0)"', attributes: ['reliability'] }]);
    write(dir, 'AGENTS.md', '# 夹具宪法\n\n最小合规 AGENTS.md。\n');
    write(dir, 'Product-Spec.md', [
      '# 需求规格',
      '',
      '治理属性：resilience security safety privacy reliability。',
      '',
      '- REQ-001 当触发静态检查时，系统必须通过 static-ok 检查。',
      '  验收：tests/req.test.mjs 引用 REQ-001 并断言。',
      '',
    ].join('\n'));
    write(dir, 'tests/req.test.mjs', '// REQ-001\nimport assert from "node:assert";\nassert.ok(true);\n');
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  test('干净夹具 + fresh gate 回执 → READY exit 0，并明示永不打 tag/push/建分支', (t) => {
    if (!needGit(t)) return;
    const dir = releaseFixture(t);
    assert.equal(run(['gate'], { cwd: dir }).code, 0, '前置 gate 应跑通');
    const r = run(['release'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 0, `全部阻断条件成立必须 exit 0，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /READY/);
    assert.match(r.stdout, /永不打 tag、永不 push、永不建分支/, '边界声明必须逐字出现');
    assert.match(r.stdout, /\[x\] receipt-fresh/);
  });

  test('缺 fresh 回执 → NOT READY exit 2 并点名 receipt-fresh', (t) => {
    if (!needGit(t)) return;
    const dir = releaseFixture(t);
    const r = run(['release'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 2, `无 fresh 回执必须 exit 2，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /NOT READY/);
    assert.match(r.stdout, /\[ \] receipt-fresh/);
    assert.match(r.stdout, /阻断项：.*receipt-fresh/);
  });

  test('fast 窗口开启 → NOT READY exit 2 并点名 fast-mode-closed', (t) => {
    if (!needGit(t)) return;
    const dir = releaseFixture(t);
    assert.equal(run(['gate'], { cwd: dir }).code, 0);
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0);
    const r = run(['release'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 2, `fast 窗口开启必须 exit 2，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /\[ \] fast-mode-closed/);
    assert.match(r.stdout, /阻断项：.*fast-mode-closed/);
  });

  // P7b 回归（dogfood #11）：提交后评审回执陈旧是新鲜度问题，不是完整性问题——
  // dod 记 STALE 不阻断；release 的 ledger-intact 只判完整性，receipt-fresh 由 fresh gate 回执满足。
  test('工作树评审 ACCEPT → 提交 → 重跑 gate：dod exit 0（STALE 可见）且 release READY', (t) => {
    if (!needGit(t)) return;
    const dir = releaseFixture(t);
    // 工作树改动 → 工作树模式评审（catalog 无 review 段：默认剖面经属性收缩只剩 correctness）
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    assert.equal(run(['review', 'start'], { cwd: dir }).code, 0, 'review start 应成功');
    assert.equal(run(['review', 'blue'], { cwd: dir, input: JSON.stringify({ claims: [{ claim: 'c', evidence: 'e' }] }) }).code, 0);
    assert.equal(run(['review', 'lens', 'correctness'], { cwd: dir, input: JSON.stringify({ findings: [] }) }).code, 0);
    const verdict = run(['review', 'verdict'], { cwd: dir });
    assert.equal(verdict.code, 0, `终审 ACCEPT 应 exit 0: ${out(verdict)}`);
    // 提交已评审工作 → 评审回执陈旧（绑定的是评审时的工作树指纹）
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'reviewed work');
    const stale = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(stale.code, 4, `前置：提交后旧评审回执应判陈旧 exit 4，实际 ${stale.code}: ${out(stale)}`);
    // 重跑 gate 取得当前指纹的 fresh 回执
    assert.equal(run(['gate'], { cwd: dir }).code, 0, '提交后 gate 应跑通');
    const dod = run(['dod'], { cwd: dir, timeout: 300_000 });
    assert.equal(dod.code, 0, `陈旧回执不得拖垮 dod 判定，实际 ${dod.code}: ${out(dod)}`);
    assert.match(dod.stdout, /STALE receipt-verify/, 'dod 必须响亮标出 STALE 步骤');
    const r = run(['release'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 0, `干净+全门禁仓必须 READY，实际 ${r.code}: ${out(r)}`);
    assert.match(r.stdout, /\[x\] ledger-intact/);
    assert.match(r.stdout, /\[x\] receipt-fresh/);
  });

  // P7b 回归：range 模式评审（review start --base <ref>，P3）的回执绑定提交范围——
  // HEAD 未移动即 fresh（脏工作树不影响），HEAD 移动才 stale。verify 与 release 都须认这个绑定。
  test('提交后 range 评审 ACCEPT：脏树不 stale（verify exit 0）且 release receipt-fresh 满足；HEAD 移动则 stale', (t) => {
    if (!needGit(t)) return;
    const dir = releaseFixture(t);
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'work to review');
    assert.equal(run(['review', 'start', '--base', base], { cwd: dir }).code, 0, 'range review start 应成功');
    assert.equal(run(['review', 'blue'], { cwd: dir, input: JSON.stringify({ claims: [{ claim: 'c', evidence: 'e' }] }) }).code, 0);
    assert.equal(run(['review', 'lens', 'correctness'], { cwd: dir, input: JSON.stringify({ findings: [] }) }).code, 0);
    const verdict = run(['review', 'verdict'], { cwd: dir });
    assert.equal(verdict.code, 0, `终审 ACCEPT 应 exit 0: ${out(verdict)}`);
    // 脏工作树（未提交改动）不使 range 回执 stale：评审对象是已提交的 diff
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const c = 3;\n');
    const verify = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(verify.code, 0, `HEAD 未移动时 range 回执不得判 stale，实际 ${verify.code}: ${out(verify)}`);
    const r = run(['release'], { cwd: dir, timeout: 300_000 });
    assert.match(r.stdout, /\[x\] receipt-fresh/, `receipt-fresh 必须接受 range.head=HEAD 的评审回执: ${r.stdout}`);
    // HEAD 移动 → 评审对象已变 → 回执 stale
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'move head');
    const moved = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(moved.code, 4, `HEAD 移动后 range 回执必须 stale exit 4，实际 ${moved.code}: ${out(moved)}`);
    assert.match(out(moved), /range\.head/, 'stale 报告应点名 range.head 已移动');
  });
});
