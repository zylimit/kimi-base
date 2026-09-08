/**
 * tests/layers-adoption.test.mjs
 * P8 分层反馈与渐进采用行为测试（零第三方依赖，node:test）：
 *   三层反馈分级 / 渐进采用阶梯 / 棘轮 best-ever 持久化 / 安装器锁与 marker。
 * 追溯：REQ-062 REQ-063 REQ-064 REQ-065
 *
 * 纪律：每条用例独立临时目录（os.tmpdir 下 mkdtemp），经真实 CLI 子进程断言退出码
 * 与输出；环境无 git 时 git 用例显式 skip（不假绿）。本文件为红测先行：断言目标是
 * Product-Spec 契约，不是当前实现——当前红因逐条记录在交付核对表。
 * 运行：node --test tests/layers-adoption.test.mjs
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(REPO, '.kimi-base', 'runtime', 'kimi-base.mjs');
const RUNTIME_OK = fs.existsSync(RUNTIME) && fs.readFileSync(RUNTIME, 'utf8').includes('process.argv');
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪（不存在或无 CLI 入口）' };

function mkdtemp(t, prefix = 'kimi-base-p8-') {
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
  const { cwd = REPO, env = {}, input, timeout = 120_000, runtime = RUNTIME } = opts;
  const r = spawnSync(process.execPath, [runtime, ...args], {
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

function listFiles(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc.sort();
}

/** 全量文件内容哈希快照（dry-run 零写入比对用） */
function snapshot(dir) {
  const m = {};
  for (const f of listFiles(dir)) {
    m[f] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  }
  return m;
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

// ---------------- 契约假设区 ----------------
// 任务契约给定的事实：
// - REQ-062：verification-matrix 每条检查必须带 tier 字段，合法集 = inner/middle/outer
//   （inner=commit 前秒级可阻塞 / middle=评审级可阻塞 / outer=趋势健康信号性）；
//   缺 tier 或非法 tier = 配置期 exit 1；dod 输出按层分组，outer FAIL 响亮可见但不阻断。
// - REQ-063：catalog discover 支持 --level L0|L1|L2|L3，缺省 L1；非法 level exit 1
//   并点名合法集；L0 生成物无 attributes 段、无 arch 分层；L3 生成物/输出含 fleet 引用。
// - REQ-064：arch trend 状态文件必须把历史最优显式记为独立字段（bestEver），
//   截断 snapshots 后 --gate 仍以 bestEver 判。
// - REQ-065：install/upgrade 支持 dry-run 零写入、故障逆序回滚、maintenance marker
//   存在期间 doctor 与治理动词拒跑并点名 marker。
// 仍属推断（实现落地后按实际行为校正，只许改常量不许降断言强度）：
// - bestEver 字段名取任务契约示例 "bestEver"，按逐指标对象持久化。
// - maintenance marker 路径取 .kimi-base/state/maintenance.json（运行态簿记同区）。
// - REQ-063 生成物差异的判定面：catalog 文本（attributes/layers 键）与 discover 输出。

const P = {
  harness: '.kimi-base/harness.json',
  matrix: '.kimi-base/verification-matrix.json',
  catalog: '.kimi-base/module-catalog.json',
};
const STATE = '.kimi-base/state';
const INSTALL_RECEIPT = `${STATE}/install-receipt.json`;
const ARCH_TREND = `${STATE}/arch-trend.json`;
const MAINTENANCE_MARKER = `${STATE}/maintenance.json`; // 契约假设：路径待与实现对齐

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
function writeCatalog(dir, fragment) {
  write(dir, P.catalog, JSON.stringify({ version: 1, ...fragment }, null, 2));
}

/**
 * 源仓副本（安装载荷子集）：install 系用例全部打在副本上，与 harness.test.mjs 先例一致。
 */
function sourceCopy(t) {
  const dir = mkdtemp(t, 'kimi-base-src-');
  for (const sub of ['.kimi-base/runtime', '.kimi-base/rules', '.kimi-base/templates', '.kimi-base/audit', '.kimi-base/githooks', '.kimi-code']) {
    fs.cpSync(path.join(REPO, sub), path.join(dir, sub), { recursive: true });
  }
  for (const f of ['adapters.json', 'state.README', 'harness.example.json', 'module-catalog.example.json', 'verification-matrix.example.json']) {
    fs.cpSync(path.join(REPO, '.kimi-base', f), path.join(dir, '.kimi-base', f));
  }
  return { dir, runtime: path.join(dir, '.kimi-base', 'runtime', 'kimi-base.mjs') };
}

// ---------------- REQ-062 三层反馈分级 ----------------

describe('REQ-062 三层反馈分级', RT, () => {
  /** matrix 校验夹具：git 仓 + 最小 catalog + 参数化 checks */
  function matrixFixture(t, checks) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, { modules: [{ id: 'app', root: 'src', paths: ['**'] }] });
    writeMatrix(dir, checks);
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  test('缺 tier 的检查 → matrix 校验 exit 1 并点名检查 id', (t) => {
    if (!needGit(t)) return;
    const dir = matrixFixture(t, [{ id: 'no-tier-check', kind: 'static', command: 'node -e "process.exit(0)"' }]);
    const r = run(['gate', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 1, `缺 tier 必须配置期拒绝 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /no-tier-check/, '报告必须点名缺 tier 的检查 id');
    assert.match(out(r), /tier/, '报告必须点名缺失的字段 tier');
  });

  test('非法 tier 值 → exit 1 并点名合法集 inner/middle/outer', (t) => {
    if (!needGit(t)) return;
    const dir = matrixFixture(t, [{ id: 'bad-tier-check', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'sideways' }]);
    const r = run(['gate', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 1, `非法 tier 必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /bad-tier-check/, '报告必须点名非法 tier 的检查 id');
    assert.match(out(r), /inner/, '报告必须列出合法值 inner');
    assert.match(out(r), /middle/, '报告必须列出合法值 middle');
    assert.match(out(r), /outer/, '报告必须列出合法值 outer');
  });

  test('合法 tier 标注（inner/middle/outer 各一）→ 配置期放行', (t) => {
    if (!needGit(t)) return;
    const dir = matrixFixture(t, [
      { id: 'inner-ok', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'inner' },
      { id: 'middle-ok', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'middle' },
      { id: 'outer-ok', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'outer' },
    ]);
    const r = run(['gate', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 0, `合法 tier 标注必须放行，实际 ${r.code}: ${out(r)}`);
  });

  /**
   * dod 全绿基线夹具（对齐 scale.test.mjs releaseFixture 先例）：静态电池九步全 PASS。
   * matrix checks 参数化以携带 tier；dod 必须把矩阵检查按层分组进输出。
   */
  function dodFixture(t, checks) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      globalPaths: ['*.md', '*.json'],
      modules: [
        { id: 'app', root: 'src', paths: ['**'] },
        { id: 'tests', root: 'tests', paths: ['**'] },
      ],
    });
    writeMatrix(dir, checks);
    write(dir, 'AGENTS.md', '# 夹具宪法\n\n最小合规 AGENTS.md。\n');
    write(dir, 'Product-Spec.md', [
      '# 需求规格',
      '',
      '治理属性：resilience security safety privacy reliability。',
      '',
      '- REQ-001 当触发静态检查时，系统必须通过静态检查。',
      '  验收：tests/req.test.mjs 引用 REQ-001 并断言。',
      '',
    ].join('\n'));
    write(dir, 'tests/req.test.mjs', '// REQ-001\nimport assert from "node:assert";\nassert.ok(true);\n');
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  test('dod 输出按层分组；outer 层 FAIL 响亮可见但不阻断（exit 0）', (t) => {
    if (!needGit(t)) return;
    const dir = dodFixture(t, [
      { id: 'inner-pass', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'inner' },
      { id: 'middle-pass', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'middle' },
      { id: 'outer-fail', kind: 'static', command: 'node -e "process.exit(1)"', tier: 'outer' },
    ]);
    const r = run(['dod'], { cwd: dir, timeout: 300_000 });
    const o = out(r);
    assert.equal(r.code, 0, `outer 层失败不得阻断 dod（信号性），实际 ${r.code}:\n${o}`);
    // 按层分组：三层标题都必须出现
    assert.match(o, /inner/, 'dod 输出必须含 inner 层分组');
    assert.match(o, /middle/, 'dod 输出必须含 middle 层分组');
    assert.match(o, /outer/, 'dod 输出必须含 outer 层分组');
    // outer FAIL 响亮可见：同行点名检查 id 与 FAIL
    assert.ok(
      o.split('\n').some((line) => line.includes('outer-fail') && /FAIL/.test(line)),
      `outer 层失败必须响亮可见（outer-fail + FAIL 同行）:\n${o}`,
    );
  });

  test('middle 层检查失败 → dod 阻断 exit 2 并点名', (t) => {
    if (!needGit(t)) return;
    const dir = dodFixture(t, [
      { id: 'inner-pass', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'inner' },
      { id: 'middle-fail', kind: 'static', command: 'node -e "process.exit(1)"', tier: 'middle' },
    ]);
    const r = run(['dod'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 2, `middle 层（评审级可阻塞）失败必须 exit 2，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /middle-fail/, '报告必须点名失败的 middle 层检查');
  });
});

// ---------------- REQ-063 渐进采用阶梯 ----------------

describe('REQ-063 渐进采用阶梯', RT, () => {
  /** discover 夹具（对齐 scale.test.mjs 先例）：app→core 真实边 + 生产源码属性信号 */
  function discoverFixture(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }, null, 2));
    write(dir, 'packages/app/index.js', 'import { util } from "../core/util.js";\nexport const app = util();\n');
    write(dir, 'packages/core/util.js', '// auth token 校验\nexport const util = () => "ok";\n');
    write(dir, 'packages/core/store.js', '// credential 与 oauth session 存储\nexport const store = {};\n');
    gitInitCommit(dir);
    return dir;
  }

  test('非法 --level → exit 1 并点名合法集 L0/L1/L2/L3', (t) => {
    if (!needGit(t)) return;
    const dir = discoverFixture(t);
    const r = run(['catalog', 'discover', '--level', 'L9'], { cwd: dir });
    assert.equal(r.code, 1, `非法 level 必须 exit 1，实际 ${r.code}: ${out(r)}`);
    const o = out(r);
    for (const level of ['L0', 'L1', 'L2', 'L3']) {
      assert.ok(o.includes(level), `错误信息必须列出合法级别 ${level}: ${o}`);
    }
  });

  test('缺省级别 == L1：默认与 --level L1 生成物逐字节一致', (t) => {
    if (!needGit(t)) return;
    const implicit = discoverFixture(t);
    const r1 = run(['catalog', 'discover', '--write'], { cwd: implicit });
    assert.equal(r1.code, 0, out(r1));
    const explicit = discoverFixture(t);
    const r2 = run(['catalog', 'discover', '--write', '--level', 'L1'], { cwd: explicit });
    assert.equal(r2.code, 0, `--level L1 必须被接受，实际 ${r2.code}: ${out(r2)}`);
    assert.equal(
      read(explicit, P.catalog),
      read(implicit, P.catalog),
      '缺省必须与 --level L1 生成逐字节一致的 catalog',
    );
  });

  test('L0 生成物只含最小钩子面：catalog 无 attributes 段、无 arch 分层、不生成五性矩阵', (t) => {
    if (!needGit(t)) return;
    const dir = discoverFixture(t);
    const r = run(['catalog', 'discover', '--write', '--level', 'L0'], { cwd: dir });
    assert.equal(r.code, 0, `--level L0 必须被接受，实际 ${r.code}: ${out(r)}`);
    assert.ok(exists(dir, P.catalog), 'L0 仍应生成 module-catalog.json（最小钩子面）');
    const catalog = read(dir, P.catalog);
    assert.ok(!catalog.includes('"attributes"'), `L0 的 catalog 不得含 attributes 段（无五性治理）:\n${catalog}`);
    assert.ok(!catalog.includes('"layers"'), `L0 的 catalog 不得含 layers（无 arch 治理）:\n${catalog}`);
    assert.ok(!exists(dir, P.matrix), 'L0 不得生成 verification-matrix.json（五性/arch 治理配置属 L2+）');
  });

  test('L2 生成物含五性/arch 治理：catalog 有分层且属性信号未被裁掉', (t) => {
    if (!needGit(t)) return;
    const dir = discoverFixture(t);
    const r = run(['catalog', 'discover', '--write', '--level', 'L2'], { cwd: dir });
    assert.equal(r.code, 0, `--level L2 必须被接受，实际 ${r.code}: ${out(r)}`);
    const catalog = JSON.parse(read(dir, P.catalog));
    assert.ok(Array.isArray(catalog.layers) && catalog.layers.length > 0, 'L2 的 catalog 必须含 arch 分层治理');
    // 五性信号面：dry-run 提案须保留属性提案（生产源码的 security 信号）
    const dry = run(['catalog', 'discover', '--level', 'L2'], { cwd: dir });
    assert.equal(dry.code, 0, out(dry));
    assert.match(dry.stdout, /attributeProposals/, 'L2 必须保留五性属性提案面');
  });

  test('L3 全量 + fleet：生成物或输出必须含 fleet 引用', (t) => {
    if (!needGit(t)) return;
    const dir = discoverFixture(t);
    const r = run(['catalog', 'discover', '--write', '--level', 'L3'], { cwd: dir });
    assert.equal(r.code, 0, `--level L3 必须被接受，实际 ${r.code}: ${out(r)}`);
    const artifacts = [
      r.stdout,
      exists(dir, P.catalog) ? read(dir, P.catalog) : '',
      exists(dir, 'fleet.json') ? read(dir, 'fleet.json') : '',
      exists(dir, `${STATE}/discover-level.json`) ? read(dir, `${STATE}/discover-level.json`) : '',
    ].join('\n');
    assert.match(artifacts, /fleet/i, `L3 生成物/输出必须含 fleet 引用:\n${artifacts.slice(0, 500)}`);
  });
});

// ---------------- REQ-064 棘轮 best-ever 持久化 ----------------

describe('REQ-064 棘轮 best-ever 持久化', RT, () => {
  /**
   * 棘轮夹具：a/c 禁依赖 b；通过增删 import 边精确控制 violations 数。
   * 违规指纹不含文件，故每一轮改动必须换模块对/换有无。
   */
  function trendFixture(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'], forbiddenDependencies: ['b'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
        { id: 'c', root: 'src/c', paths: ['**'], forbiddenDependencies: ['b'] },
      ],
    });
    write(dir, 'src/a/index.js', 'export const a = 1;\n');
    write(dir, 'src/b/index.js', 'export const b = 1;\n');
    write(dir, 'src/c/index.js', 'export const c = 1;\n');
    gitInitCommit(dir);
    return dir;
  }
  const VIOLATE_A = "import { b } from '../b/index.js';\nexport const a = b;\n";
  const VIOLATE_C = "import { b } from '../b/index.js';\nexport const c = b;\n";
  const CLEAN_A = 'export const a = 1;\n';
  const CLEAN_C = 'export const c = 1;\n';
  const readTrend = (dir) => JSON.parse(read(dir, ARCH_TREND));

  test('trend 文件显式持久化 bestEver 独立字段；截断旧样本后 --gate 仍以历史最优判', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixture(t);
    // 第一轮：0 违规（历史最优）
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '第一轮 record 应成功');
    // 第二轮更差：a→b、c→b 两条禁边实边（violations=2）
    write(dir, 'src/a/index.js', VIOLATE_A);
    write(dir, 'src/c/index.js', VIOLATE_C);
    git(dir, 'add', '-A');
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '第二轮 record 应成功');
    // 契约：历史最优必须显式记录为独立字段
    const state = readTrend(dir);
    assert.ok(state.bestEver && typeof state.bestEver === 'object', `trend 文件必须显式记录 bestEver 独立字段: ${JSON.stringify(state)}`);
    assert.equal(state.bestEver.violations, 0, 'bestEver.violations 必须是历史最优 0');
    // 人为截断：删掉第一轮快照（只留最近的较差样本）——best-ever 不得因此回升
    state.snapshots = state.snapshots.slice(-1);
    write(dir, ARCH_TREND, JSON.stringify(state, null, 2));
    const truncated = readTrend(dir);
    assert.equal(truncated.bestEver.violations, 0, '截断 snapshots 后 bestEver 不得回升');
    // 当前 1 违规（好于第二轮 2、差于历史最优 0）：棘轮必须拦
    write(dir, 'src/c/index.js', CLEAN_C);
    git(dir, 'add', '-A');
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 1, `超越历史最优（0）必须 exit 1，截断样本不得抬天花板，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /历史最优|bestEver/i, '报告必须点名历史最优判定依据');
  });

  test('还债天花板永降：改善后 bestEver 单调不升，回弹即拦', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixture(t);
    // 起点 2 违规
    write(dir, 'src/a/index.js', VIOLATE_A);
    write(dir, 'src/c/index.js', VIOLATE_C);
    git(dir, 'add', '-A');
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0);
    // 还一笔债：1 违规 → bestEver 降到 1
    write(dir, 'src/c/index.js', CLEAN_C);
    git(dir, 'add', '-A');
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0);
    const state = readTrend(dir);
    assert.ok(state.bestEver && typeof state.bestEver === 'object', `trend 文件必须显式记录 bestEver 独立字段: ${JSON.stringify(state)}`);
    assert.equal(state.bestEver.violations, 1, '还债后 bestEver.violations 必须降到 1（天花板永降）');
    // 回弹到 2：超越 best-ever 即新债，棘轮拦
    write(dir, 'src/c/index.js', VIOLATE_C);
    git(dir, 'add', '-A');
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 1, `回弹超越 bestEver(1) 必须 exit 1，实际 ${r.code}: ${out(r)}`);
  });
});

// ---------------- REQ-065 安装器锁与 marker ----------------

describe('REQ-065 安装器锁与 marker', RT, () => {
  test('install --dry-run 零写入：目录树逐字节不变', (t) => {
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    const before = snapshot(dir);
    const r = run(['install', '.', '--dry-run'], { cwd: dir, runtime: src.runtime });
    assert.equal(r.code, 0, `dry-run 预演应成功: ${out(r)}`);
    assert.deepEqual(snapshot(dir), before, 'dry-run 不得写入任何文件（含 state 簿记）');
  });

  test('安装中途故障注入 → 非零退出且逆序回滚不留半装态', (t) => {
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    // FAIL_AFTER=5：事务中段注入（非第一步），证明回滚覆盖已落盘的前序操作
    const r = run(['install', '.'], { cwd: dir, runtime: src.runtime, env: { KIMI_BASE_INSTALL_FAIL_AFTER: '5' } });
    assert.notEqual(r.code, 0, '故障注入应使安装失败');
    const leftovers = listFiles(dir);
    assert.deepEqual(leftovers, [INSTALL_RECEIPT], `回滚后不得留半装态（只允许失败回执），实际: ${leftovers.join(',')}`);
    const receipt = JSON.parse(read(dir, INSTALL_RECEIPT));
    assert.equal(receipt.status, 'rolled-back', `失败回执应记 rolled-back，实际: ${receipt.status}`);
  });

  test('maintenance marker 存在期间 doctor 与 gate 拒跑并点名 marker；移除后恢复', (t) => {
    if (!needGit(t)) return;
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    write(dir, 'README.md', '# demo\n'); // 占位：git 初始提交需要内容
    gitInitCommit(dir);
    assert.equal(run(['install', '.'], { cwd: dir, runtime: src.runtime }).code, 0, '前置安装应成功');
    write(dir, MAINTENANCE_MARKER, JSON.stringify({ reason: '升级维护中', since: '2026-01-01T00:00:00Z' }));
    const doctor = run(['doctor'], { cwd: dir, runtime: src.runtime });
    assert.notEqual(doctor.code, 0, `marker 存在期间 doctor 必须拒跑，实际 ${doctor.code}: ${out(doctor)}`);
    assert.match(out(doctor), /maintenance|marker|维护/i, 'doctor 拒跑必须点名 maintenance marker');
    const gate = run(['gate'], { cwd: dir, runtime: src.runtime });
    assert.notEqual(gate.code, 0, `marker 存在期间治理动词 gate 必须拒跑，实际 ${gate.code}: ${out(gate)}`);
    assert.match(out(gate), /maintenance|marker|维护/i, 'gate 拒跑必须点名 maintenance marker');
    fs.rmSync(path.join(dir, MAINTENANCE_MARKER));
    const recovered = run(['doctor'], { cwd: dir, runtime: src.runtime });
    assert.equal(recovered.code, 0, `移除 marker 后 doctor 应恢复通过: ${out(recovered)}`);
  });
});

// ---------------- P8 修复轮（红蓝评审 verdict=FIX_REQUIRED 缺陷锁定） ----------------
// 纯追加：不改既有 15 例。每条红测对应一个已实证缺陷，红因逐条记录在断言消息。
// 追溯：REQ-062 REQ-063 REQ-064 REQ-065（修复轮）

describe('P8 修复轮', RT, () => {
  /** matrix 校验夹具（同 REQ-062 段形态）：git 仓 + 最小 catalog + 参数化 checks */
  function matrixFixtureP8(t, checks) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, { modules: [{ id: 'app', root: 'src', paths: ['**'] }] });
    writeMatrix(dir, checks);
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  /** dod 全绿基线夹具（同 REQ-062 段形态）：静态电池九步全 PASS，matrix checks 参数化 */
  function dodFixtureP8(t, checks) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      globalPaths: ['*.md', '*.json'],
      modules: [
        { id: 'app', root: 'src', paths: ['**'] },
        { id: 'tests', root: 'tests', paths: ['**'] },
      ],
    });
    writeMatrix(dir, checks);
    write(dir, 'AGENTS.md', '# 夹具宪法\n\n最小合规 AGENTS.md。\n');
    write(dir, 'Product-Spec.md', [
      '# 需求规格',
      '',
      '治理属性：resilience security safety privacy reliability。',
      '',
      '- REQ-001 当触发静态检查时，系统必须通过静态检查。',
      '  验收：tests/req.test.mjs 引用 REQ-001 并断言。',
      '',
    ].join('\n'));
    write(dir, 'tests/req.test.mjs', '// REQ-001\nimport assert from "node:assert";\nassert.ok(true);\n');
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  /** 棘轮夹具（同 REQ-064 段形态）：a/c 禁依赖 b */
  function trendFixtureP8(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'], forbiddenDependencies: ['b'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
        { id: 'c', root: 'src/c', paths: ['**'], forbiddenDependencies: ['b'] },
      ],
    });
    write(dir, 'src/a/index.js', 'export const a = 1;\n');
    write(dir, 'src/b/index.js', 'export const b = 1;\n');
    write(dir, 'src/c/index.js', 'export const c = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  // C1：marker 无独占——install 在 marker 已存在时必须拒跑，且不得误删他人 marker
  test('C1 外来 maintenance marker 存在时 install 拒跑（exit 3 点名 marker+恢复指引），他人 marker 不被误删', (t) => {
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    write(dir, MAINTENANCE_MARKER, JSON.stringify({ version: 1, installId: 'foreign-install-000', action: 'install', startedAt: '2026-01-01T00:00:00Z', reason: '并发/中断残留' }));
    const r = run(['install', '.'], { cwd: dir, runtime: src.runtime });
    assert.equal(r.code, 3, `marker 已存在时 install 必须拒跑 exit 3（降级语义），实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /maintenance|marker|维护/i, '拒跑必须点名 maintenance marker');
    assert.match(out(r), /移除|删除|恢复|重跑/, '拒跑必须带恢复指引');
    const marker = JSON.parse(read(dir, MAINTENANCE_MARKER));
    assert.equal(marker.installId, 'foreign-install-000', '他人的 marker 不得被覆盖或误删（finally 只删自己 installId 的 marker）');
  });

  test('C1 install 正常完成后自己的 marker 已移除（state 簿记不留锁）', (t) => {
    if (!needGit(t)) return;
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    write(dir, 'README.md', '# demo\n');
    gitInitCommit(dir);
    assert.equal(run(['install', '.'], { cwd: dir, runtime: src.runtime }).code, 0, '安装应成功');
    assert.ok(!exists(dir, MAINTENANCE_MARKER), '正常完成后 maintenance marker 必须移除');
  });

  // C4：protected 不得 outer——认领 security/safety/privacy 的检查标 tier=outer 必须配置期拒绝
  test('C4 protected 检查标 tier=outer → 配置面 exit 1 点名（kind 命中与属性认领两形态）', (t) => {
    if (!needGit(t)) return;
    const byKind = matrixFixtureP8(t, [{ id: 'sec-outer', kind: 'security', command: 'node -e "process.exit(0)"', tier: 'outer' }]);
    const r1 = run(['gate', '--dry-run'], { cwd: byKind });
    assert.equal(r1.code, 1, `security kind 标 outer 必须 exit 1，实际 ${r1.code}: ${out(r1)}`);
    assert.match(out(r1), /sec-outer/, '必须点名检查 id');
    assert.match(out(r1), /outer/, '必须点名非法层 outer');
    assert.match(out(r1), /protected|security|保护/, '必须点名 protected 语义');
    const byAttr = matrixFixtureP8(t, [{ id: 'privacy-outer', kind: 'static', command: 'node -e "process.exit(0)"', attributes: ['privacy'], tier: 'outer' }]);
    const r2 = run(['gate', '--dry-run'], { cwd: byAttr });
    assert.equal(r2.code, 1, `认领 privacy 属性的 static 检查标 outer 必须 exit 1，实际 ${r2.code}: ${out(r2)}`);
    assert.match(out(r2), /privacy-outer/, '必须点名检查 id');
  });

  // C5：dod 忽略 check.cwd——带 cwd 的检查在 gate PASS 而 dod FAIL（cwd 未传）
  test('C5 dod 执行 matrix 检查必须传 check.cwd（与 gate 同语义）', (t) => {
    if (!needGit(t)) return;
    const dir = dodFixtureP8(t, [
      { id: 'cwd-check', kind: 'static', command: 'node -e "process.exit(require(\'fs\').existsSync(\'a.js\') ? 0 : 1)"', cwd: 'src', tier: 'middle' },
    ]);
    const gate = run(['gate'], { cwd: dir, timeout: 300_000 });
    assert.equal(gate.code, 0, `前置：gate 对带 cwd 的检查应 PASS，实际 ${gate.code}: ${out(gate)}`);
    const dod = run(['dod'], { cwd: dir, timeout: 300_000 });
    assert.equal(dod.code, 0, `dod 必须以 check.cwd 执行（a.js 只在 src/ 下存在），实际 ${dod.code}:\n${out(dod)}`);
    assert.ok(
      out(dod).split('\n').some((line) => line.includes('cwd-check') && /PASS/.test(line)),
      `dod 输出必须含 cwd-check 的 PASS 行:\n${out(dod)}`,
    );
  });

  // C2/C3：bestEver 无形状防护——非法形态静默禁用棘轮（"abc" 比较恒 false → 永放行）
  test('C2/C3 bestEver.violations 为非数字 → arch trend --gate exit 1 响亮（不静默放行）', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixtureP8(t);
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '前置 record 应成功');
    const state = JSON.parse(read(dir, ARCH_TREND));
    state.bestEver.violations = 'abc';
    write(dir, ARCH_TREND, JSON.stringify(state, null, 2));
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 1, `bestEver 形状非法必须 exit 1（棘轮不静默禁用），实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /bestEver/, '报告必须点名 bestEver 字段');
  });

  test('C2/C3 bestEver 非对象形态（字符串） → arch trend --gate exit 1 响亮', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixtureP8(t);
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '前置 record 应成功');
    const state = JSON.parse(read(dir, ARCH_TREND));
    state.bestEver = 'oops';
    write(dir, ARCH_TREND, JSON.stringify(state, null, 2));
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 1, `bestEver 非对象必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /bestEver/, '报告必须点名 bestEver 字段');
  });

  // 头条限定：outer FAIL 时 dod 头条不得是裸「dod 通过」
  test('outer 层 FAIL 时 dod 头条必须带限定（inner/middle 全绿 + outer 失败计数可见）', (t) => {
    if (!needGit(t)) return;
    const dir = dodFixtureP8(t, [
      { id: 'inner-pass', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'inner' },
      { id: 'outer-fail', kind: 'static', command: 'node -e "process.exit(1)"', tier: 'outer' },
    ]);
    const r = run(['dod'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 0, `outer 失败不阻断，实际 ${r.code}: ${out(r)}`);
    const headline = out(r).split('\n').find((line) => line.trim().length > 0);
    assert.match(headline, /dod 通过（/, `头条不得是裸「dod 通过」——必须带限定括号，实际: ${headline}`);
    assert.match(headline, /outer/, '头条限定必须点名 outer 层');
    assert.match(headline, /1/, '头条限定必须带 outer 失败计数');
  });

  // 去重：与静态电池同 id 的 matrix 检查只执行/显示一次
  test('dod 去重：与 DOD_STEPS 同 id 的 matrix 检查不重复执行（输出中同 id 步骤行只出现一次）', (t) => {
    if (!needGit(t)) return;
    const dir = dodFixtureP8(t, [
      { id: 'catalog-lint', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'inner' },
      { id: 'extra-check', kind: 'static', command: 'node -e "process.exit(0)"', tier: 'inner' },
    ]);
    const r = run(['dod'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 0, `全绿夹具 dod 应 exit 0，实际 ${r.code}: ${out(r)}`);
    const stepLines = (id) => out(r).split('\n').filter((line) => new RegExp(`^- (PASS|FAIL|STALE|DEGRADED) ${id}（`).test(line));
    assert.equal(stepLines('catalog-lint').length, 1, `catalog-lint 与静态电池同 id，必须只跑一遍（去重），实际步骤行: ${stepLines('catalog-lint').join(' | ')}`);
    assert.equal(stepLines('extra-check').length, 1, 'extra-check 必须正常执行一次');
  });
});

// ---------------- P8 修复轮二（终审 correctness warning 锁定） ----------------
// 纯追加：不改既有 23 例。红因逐条记录在断言消息。
// 追溯：REQ-062 REQ-064 REQ-065（修复轮二）

describe('P8 修复轮二', RT, () => {
  /** dod 全绿基线夹具（同前段形态） */
  function dodFixtureP8b(t, checks) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      globalPaths: ['*.md', '*.json'],
      modules: [
        { id: 'app', root: 'src', paths: ['**'] },
        { id: 'tests', root: 'tests', paths: ['**'] },
      ],
    });
    writeMatrix(dir, checks);
    write(dir, 'AGENTS.md', '# 夹具宪法\n\n最小合规 AGENTS.md。\n');
    write(dir, 'Product-Spec.md', [
      '# 需求规格',
      '',
      '治理属性：resilience security safety privacy reliability。',
      '',
      '- REQ-001 当触发静态检查时，系统必须通过静态检查。',
      '  验收：tests/req.test.mjs 引用 REQ-001 并断言。',
      '',
    ].join('\n'));
    write(dir, 'tests/req.test.mjs', '// REQ-001\nimport assert from "node:assert";\nassert.ok(true);\n');
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  /** 棘轮夹具（同 REQ-064 段形态）：a/c 禁依赖 b */
  function trendFixtureP8b(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'], forbiddenDependencies: ['b'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
        { id: 'c', root: 'src/c', paths: ['**'], forbiddenDependencies: ['b'] },
      ],
    });
    write(dir, 'src/a/index.js', 'export const a = 1;\n');
    write(dir, 'src/b/index.js', 'export const b = 1;\n');
    write(dir, 'src/c/index.js', 'export const c = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  // W1：marker 独占 check-then-act 非原子——并发两个 install 同目标，双双读不到 marker 双双放行
  test('W1 并发两个 install 同目标 → 恰好一个成功、另一个 exit 3 点名 marker（wx 原子独占）', async (t) => {
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    const { spawn } = await import('node:child_process');
    const spawnInstall = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [src.runtime, 'install', '.'], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const [a, b] = await Promise.all([spawnInstall(), spawnInstall()]);
    const codes = [a.code, b.code].sort((left, right) => left - right);
    assert.deepEqual(codes, [0, 3], `并发 install 必须恰好一胜一拒（败者 exit 3），实际: ${codes.join(',')}\n--- A ---\n${a.stdout}${a.stderr}\n--- B ---\n${b.stdout}${b.stderr}`);
    const loser = a.code === 3 ? a : b;
    assert.match(`${loser.stdout}\n${loser.stderr}`, /maintenance|marker|维护/i, '拒跑方必须点名 maintenance marker');
    assert.ok(!exists(dir, MAINTENANCE_MARKER), '胜方正常完成后 marker 必须移除');
    assert.ok(exists(dir, INSTALL_RECEIPT), '胜方安装回执必须在场');
  });

  // W2：--gate 分支盲信 persisted bestEver——被抬高到比快照还松（篡改嫌疑）时静默放行新债
  test('W2 persisted bestEver 被抬高（999 > 快照最优 0）→ --gate 取更严者并响亮报，新债 exit 1', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixtureP8b(t);
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '前置 record（0 违规）应成功');
    const state = JSON.parse(read(dir, ARCH_TREND));
    assert.equal(state.bestEver.violations, 0, '前置：bestEver.violations 应为 0');
    state.bestEver.violations = 999; // 篡改/腐化形态：持久化值比现存快照还松
    write(dir, ARCH_TREND, JSON.stringify(state, null, 2));
    // 制造新债：a→b 禁边实边（violations=1）
    write(dir, 'src/a/index.js', "import { b } from '../b/index.js';\nexport const a = b;\n");
    git(dir, 'add', '-A');
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 1, `persisted 被抬高不得放行新债——必须按更严者（快照最优 0）判定 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /bestEver/, '报告必须点名 bestEver');
    assert.match(out(r), /快照|不一致|篡改/, '报告必须响亮指出 persisted 与快照交叉核对不一致（篡改嫌疑）');
  });

  // W3：去重只按 id——matrix 同名 fitness 换成必败命令后被误跳过，dod 假绿
  test('W3 去重按 id+argv：matrix 同名 fitness 但命令面不同（必败）→ dod 必须 FAIL exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = dodFixtureP8b(t, [
      { id: 'fitness', kind: 'static', command: 'node -e "process.exit(1)"', tier: 'middle' },
    ]);
    const r = run(['dod'], { cwd: dir, timeout: 300_000 });
    assert.equal(r.code, 2, `同 id 不同命令面的检查不得被去重跳过——matrix fitness（必败）必须使 dod exit 2，实际 ${r.code}:\n${out(r)}`);
    const failLines = out(r).split('\n').filter((line) => /^- FAIL fitness（/.test(line));
    assert.equal(failLines.length, 1, `matrix 的 fitness（必败命令）必须作为独立步骤 FAIL 出现一次，实际: ${failLines.join(' | ') || '（无）'}`);
    const passLines = out(r).split('\n').filter((line) => /^- PASS fitness（/.test(line));
    assert.equal(passLines.length, 1, '静态电池的 fitness（--all）必须照常 PASS——同名不同命令两边都跑');
  });

  // W4：uninstall 不过 marker 面——维护中卸载会把半装态目标拆光
  test('W4 uninstall 在 maintenance marker 存在时拒跑（exit 3 点名 marker）；移除后恢复', (t) => {
    if (!needGit(t)) return;
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    write(dir, 'README.md', '# demo\n');
    gitInitCommit(dir);
    assert.equal(run(['install', '.'], { cwd: dir, runtime: src.runtime }).code, 0, '前置安装应成功');
    write(dir, MAINTENANCE_MARKER, JSON.stringify({ version: 1, installId: 'foreign-upgrade-9', action: 'upgrade', startedAt: '2026-01-01T00:00:00Z' }));
    const refused = run(['uninstall', '.'], { cwd: dir, runtime: src.runtime });
    assert.equal(refused.code, 3, `marker 存在期间 uninstall 必须拒跑 exit 3，实际 ${refused.code}: ${out(refused)}`);
    assert.match(out(refused), /maintenance|marker|维护/i, 'uninstall 拒跑必须点名 maintenance marker');
    assert.ok(exists(dir, '.kimi-base/state/install-manifest.json'), '拒跑后安装面必须原样保留（manifest 仍在）');
    fs.rmSync(path.join(dir, MAINTENANCE_MARKER));
    const recovered = run(['uninstall', '.'], { cwd: dir, runtime: src.runtime });
    assert.equal(recovered.code, 0, `移除 marker 后 uninstall 应恢复，实际 ${recovered.code}: ${out(recovered)}`);
  });
});

// ---------------- P8 修复轮三（终审收尾 warning 锁定） ----------------
// 纯追加：不改既有 27 例。
// 追溯：REQ-064 REQ-065（修复轮三）

describe('P8 修复轮三', RT, () => {
  /** 棘轮夹具（同 REQ-064 段形态）：a/c 禁依赖 b */
  function trendFixtureP8c(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'], forbiddenDependencies: ['b'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
        { id: 'c', root: 'src/c', paths: ['**'], forbiddenDependencies: ['b'] },
      ],
    });
    write(dir, 'src/a/index.js', 'export const a = 1;\n');
    write(dir, 'src/b/index.js', 'export const b = 1;\n');
    write(dir, 'src/c/index.js', 'export const c = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  // W5：uninstall 事务不落 marker——删除中途 install 可起跑互踩
  test('W5 uninstall 事务进行中落 marker：期间 install 拒跑 exit 3；完成后 marker 移除', async (t) => {
    if (!needGit(t)) return;
    const src = sourceCopy(t);
    const dir = mkdtemp(t);
    write(dir, 'README.md', '# demo\n');
    gitInitCommit(dir);
    assert.equal(run(['install', '.'], { cwd: dir, runtime: src.runtime }).code, 0, '前置安装应成功');
    const { spawn } = await import('node:child_process');
    // KIMI_BASE_UNINSTALL_SLOW_MS：测试用慢速钩子（对齐 KIMI_BASE_INSTALL_FAIL_AFTER 先例），
    // 拉长 uninstall 事务窗口使并发观测确定性成立。
    const child = spawn(process.execPath, [src.runtime, 'uninstall', '.'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', KIMI_BASE_UNINSTALL_SLOW_MS: '1500' },
    });
    let uOut = '';
    child.stdout.on('data', (chunk) => { uOut += chunk; });
    child.stderr.on('data', (chunk) => { uOut += chunk; });
    const childDone = new Promise((resolve) => child.on('close', resolve));
    let markerSeen = false;
    for (let index = 0; index < 100; index += 1) {
      if (exists(dir, MAINTENANCE_MARKER)) { markerSeen = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(markerSeen, `uninstall 事务进行中必须落 maintenance marker（否则删除中途 install 可起跑互踩）: ${uOut}`);
    const during = run(['install', '.'], { cwd: dir, runtime: src.runtime });
    assert.equal(during.code, 3, `uninstall 事务进行中 install 必须拒跑 exit 3，实际 ${during.code}: ${out(during)}`);
    assert.match(out(during), /maintenance|marker|维护/i, 'install 拒跑必须点名 maintenance marker');
    const ucode = await childDone;
    assert.equal(ucode, 0, `uninstall 应正常完成: ${uOut}`);
    assert.ok(!exists(dir, MAINTENANCE_MARKER), 'uninstall 完成后自己的 marker 必须移除');
  });

  // W6：snapshots 为空时交叉核对退化为盲信 persisted——必须如实标注（机器行为不变）
  test('W6 snapshots 为空 + persisted bestEver → gate 如实标注「无快照可交叉核对，persisted 为唯一依据」', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixtureP8c(t);
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '前置 record 应成功');
    const state = JSON.parse(read(dir, ARCH_TREND));
    assert.ok(state.bestEver && typeof state.bestEver === 'object', '前置：bestEver 存在');
    state.snapshots = []; // bestEver 保留、快照清空：交叉核对退化形态
    write(dir, ARCH_TREND, JSON.stringify(state, null, 2));
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 0, `0 违规不超 bestEver 0，应通过，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /无快照可交叉核对/, '交叉核对退化时必须如实标注无快照可核对');
    assert.match(out(r), /persisted|唯一依据/, '必须如实标注 persisted bestEver 为唯一判定依据');
  });
});

// ---------------- P8 覆盖加固（testing 终审变异实验驱动） ----------------
// 纯追加：不改既有 29 例。W2 掩盖洞：其新债未入 baseline，fresh=1 可在 violations 判定
// 被摘掉的变异体下兜底出 exit 1——exit 1 并不证明 violations 交叉核对生效。本段用
// baseline 容忍把 fresh 压到 0，隔离出只有 violations 判定能产出的结果。
// 追溯：REQ-064（覆盖加固）

describe('P8 覆盖加固', RT, () => {
  /** 棘轮夹具（同 REQ-064 段形态）：a/c 禁依赖 b */
  function trendFixtureP8d(t) {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeCatalog(dir, {
      modules: [
        { id: 'a', root: 'src/a', paths: ['**'], forbiddenDependencies: ['b'] },
        { id: 'b', root: 'src/b', paths: ['**'] },
        { id: 'c', root: 'src/c', paths: ['**'], forbiddenDependencies: ['b'] },
      ],
    });
    write(dir, 'src/a/index.js', 'export const a = 1;\n');
    write(dir, 'src/b/index.js', 'export const b = 1;\n');
    write(dir, 'src/c/index.js', 'export const c = 1;\n');
    gitInitCommit(dir);
    return dir;
  }

  // W2-iso：隔离 fresh 兜底。新债务先 arch baseline 容忍（fresh=0），再抬高
  // bestEver.violations=999——盲信 persisted 的变异体（保留文案摘掉判定）下 violations
  // 回弹被静默吞（1 ≤ 999 → exit 0）；只有交叉核对取更严者才产出 exit 1 + violations 回归条目。
  test('W2-iso 新债经 baseline 容忍（fresh=0）+ bestEver.violations=999 → --gate exit 1 且 violations 回归条目在场', (t) => {
    if (!needGit(t)) return;
    const dir = trendFixtureP8d(t);
    assert.equal(run(['arch', 'trend', '--record'], { cwd: dir }).code, 0, '前置 record（0 违规）应成功');
    // 制造新债并 baseline 容忍：violations=1 但 fresh=0——fresh 字段不再能兜底 exit 1
    write(dir, 'src/a/index.js', "import { b } from '../b/index.js';\nexport const a = b;\n");
    git(dir, 'add', '-A');
    const baseline = run(['arch', 'baseline', '--write', '--reason', '存量债务，排期还清'], { cwd: dir });
    assert.equal(baseline.code, 0, `前置 baseline 容忍应成功: ${out(baseline)}`);
    // 前置证明隔离成立：篡改前 gate 的 exit 1 只能由 violations 回归产出（无 fresh 回归条目）
    const before = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(before.code, 1, `前置：violations 1 超历史最优 0 必须 exit 1，实际 ${before.code}: ${out(before)}`);
    assert.doesNotMatch(out(before), /fresh: 历史最优/, '前置证明：fresh=0，fresh 字段不产生回归条目（不兜底）');
    // 篡改/腐化形态：持久化值抬到比快照最优还松
    const state = JSON.parse(read(dir, ARCH_TREND));
    assert.equal(state.bestEver.violations, 0, '前置：bestEver.violations 应为 0');
    state.bestEver.violations = 999;
    write(dir, ARCH_TREND, JSON.stringify(state, null, 2));
    const r = run(['arch', 'trend', '--gate'], { cwd: dir });
    assert.equal(r.code, 1, `persisted 被抬高不得放行 violations 回弹——fresh=0 不兜底，必须 exit 1，实际 ${r.code}: ${out(r)}`);
    assert.match(out(r), /violations: 历史最优/, '报告必须含 violations 回归条目（exit 1 只能由交叉核对判定产出）');
    assert.doesNotMatch(out(r), /fresh: 历史最优/, '回归条目不得来自 fresh 字段（隔离断言）');
    assert.match(out(r), /不一致|篡改/, '交叉核对不一致仍须响亮报出（篡改嫌疑）');
  });
});
