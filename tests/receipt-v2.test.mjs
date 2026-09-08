/**
 * tests/receipt-v2.test.mjs
 * REQ-053 Receipt v2 绑定面 / REQ-054 fast 证据贷款账本 / REQ-055 可提交证据模式
 * 的行为测试——红测先行于实现，已随 v3.0 P4（含四轮评审修复）全部转绿
 * （Product-Spec.md 第 5 节「v3.0 强度可计算的治理」，设计依据 docs/adr/0009-receipt-v2-loan-ledger.md）。
 * 本文件对 REQ-053 REQ-054 REQ-055 的字面引用即正当追溯。
 *
 * 运行：node --test tests/receipt-v2.test.mjs
 *
 * 纪律（同 spec.test.mjs / harness.test.mjs）：临时 git 仓夹具、真实 CLI 子进程、断言退出码
 * 与 stdout 字段、不依赖 .kimi-base/state/ 残留；环境无 git 的用例显式 skip。错误码 token
 * （HarnessError 走 stderr）一律用 out(r)=stdout+stderr 合并视图，只断字段性 token
 * （strength.test.mjs 先例）。
 *
 * 红测先行记录：写测时点特性未实现，除「v1 回执向后兼容」「P7b 回归锁定」「local 模式不变」
 * 三条回归锁定用例外全部红（红因=行为缺失：缺绑定字段 / 缺 DEFERRED 账本条目 /
 * 缺 FAST_MODE_DEBT 报告 / harness.json 拒绝 evidence 配置段）；落地后全绿，
 * 本文件现为 REQ-053/054/055 契约回归锁。
 *
 * 契约歧义点的选定解释（逐条注释在用例处）：
 *   1) policyHash/catalogHash 的「显式缺省标记」选定为：键必须存在且值 === null（JSON null），
 *      以区分「无配置」与「实现忘了绑」（缺键即红）。
 *   2) 「账本可查」选定为一个直接可解析的 .kimi-base/state/ledger.jsonl：条目可 JSON.parse、
 *      含 kind/checkId/windowId 且携带 contentHash/chain（入哈希链的证据）；不假定专用查询动词。
 *   3) 「debt 视图归零」选定为 risk scan 输出中 FAST_MODE_DEBT 消失（risk 是 REQ-054 点名的
 *      唯一既有出口）；若实现方另设账本视图动词，该断言可平移。
 *   4) v1 回执（无 policyHash/engineHash/catalogHash 字段）按 v1 绑定面（fingerprint/diffHash）
 *      判定：缺新字段不得报篡改，指纹 fresh 即 exit 0。选此解释因「不谎报」——把旧格式当篡改
 *      是假阳性，静默放行指纹移动才是谎报。
 *   5) 「回执与账本被 git 跟踪（git status 可见已纳入）」选定为：不被 gitignore（check-ignore
 *      不命中）且（已在 ls-files 或出现在 git status --porcelain）；是否由引擎自动提交不作强制
 *      （自动提交会污染用户提交史，保守解释）。
 *   6) 「证据日志本体永不入库」选定为：必须被 git-ignored（check-ignore 命中）且不在 ls-files
 *      ——仅 untracked 不够，git add -A 即泄漏，ignore 才是机械保证。
 *   7) risk scan 对 FAST_MODE_DEBT 只断言报告 token，不断言退出码（契约未定欠债时 risk 的
 *      退出码语义）。
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
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪' };

// ---------------- 基础辅助（同 harness.test.mjs / strength.test.mjs 惯例） ----------------

function mkdtemp(t, prefix = 'kimi-base-receipt-v2-') {
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

/** 调 CLI：node <runtime> <args...>；opts.runtime 可指向夹具内安装的引擎副本 */
function run(args, opts = {}) {
  const { cwd = REPO, env = {}, input, timeout = 30_000, runtime = RUNTIME } = opts;
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
// 错误码 token 走 stderr（HarnessError），用合并视图只断字段性 token。
const out = (r) => `${r.stdout}\n${r.stderr}`;

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

/** 递归列出相对路径（posix 风格，跳过 .git） */
function listFiles(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc.sort();
}
const findFiles = (dir, re) => listFiles(dir).filter((f) => re.test(f));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'kimi-base-test',
  GIT_AUTHOR_EMAIL: 'kimi-base-test@example.com',
  GIT_COMMITTER_NAME: 'kimi-base-test',
  GIT_COMMITTER_EMAIL: 'kimi-base-test@example.com',
  GIT_INIT_DEFAULT_BRANCH: 'main',
  // 禁自动 gc/maintenance：后台写 .git 与收尾 rmSync 竞态（harness.test.mjs 先例）。
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
};

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
}
/** 容忍非零退出的 git（check-ignore 的语义就在退出码里） */
function gitRaw(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.error) throw new Error(`git ${args.join(' ')} 启动失败: ${r.error.message}`);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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

function writeHarness(dir, extra = {}) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1, ...extra }, null, 2));
}
function writeMatrix(dir, checks) {
  write(dir, '.kimi-base/verification-matrix.json', JSON.stringify({
    version: 1,
    // 风险累积并集：medium ⊇ low，high ⊇ medium 且必含 security（同 harness.test.mjs）
    riskKinds: { low: ['static'], medium: ['static'], high: ['static', 'security'] },
    checks,
  }, null, 2));
}
function writeCatalog(dir, fragment) {
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({ version: 1, ...fragment }, null, 2));
}
const PASS_CHECK = { id: 'static-ok', kind: 'static', command: 'node -e "process.exit(0)"' };
/** fast 可延期检查（预先声明 allowFastSkip，REQ-054 可延期性不得应急新声明） */
const DEFERRABLE_CHECK = { ...PASS_CHECK, allowFastSkip: true };

/**
 * gate/receipt 用基础夹具：git 仓 + harness + catalog + 矩阵 + 业务文件（全部提交）。
 * opts.harnessExtra：harness.json 附加段（如 evidence）；opts.strength：strength.json 内容
 * （null = 不写）；opts.withCatalog：false 时不写 module-catalog.json。
 */
function gateFixture(t, checks, opts = {}) {
  const { harnessExtra = {}, strength = null, withCatalog = true } = opts;
  const dir = mkdtemp(t);
  writeHarness(dir, harnessExtra);
  if (withCatalog) writeCatalog(dir, { modules: [{ id: 'app', root: 'src', paths: ['**'] }] });
  writeMatrix(dir, checks);
  if (strength !== null) write(dir, '.kimi-base/strength.json', JSON.stringify(strength, null, 2));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  gitInitCommit(dir);
  return dir;
}

/** 把引擎副本装进夹具仓（.kimi-base/runtime），返回副本入口；改引擎字节只改副本，不碰源仓 */
function installEngineCopy(dir) {
  fs.cpSync(path.join(REPO, '.kimi-base', 'runtime'), path.join(dir, '.kimi-base', 'runtime'), { recursive: true });
  return path.join(dir, '.kimi-base', 'runtime', 'kimi-base.mjs');
}

/** 读 fast 窗口 id（state/fast-mode.json，fast.mjs 已确认的字段名 windowId） */
function fastWindowId(dir) {
  return JSON.parse(read(dir, '.kimi-base/state/fast-mode.json')).windowId;
}

/** 读哈希链账本（.kimi-base/state/ledger.jsonl）的非空行 JSON 条目 */
function readLedger(dir) {
  return read(dir, '.kimi-base/state/ledger.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// 测试侧独立重算 contentHash（与引擎 stableJson 同算法；harness.test.mjs 第 18 节先例），
// 用于构造「缺 v2 绑定字段但未被篡改」的 v1 回执。
function stableJsonLocal(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonLocal).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJsonLocal(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function rehashReceiptFile(receiptPath, mutate) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  mutate(receipt);
  const copy = { ...receipt };
  delete copy.contentHash;
  delete copy.chain;
  receipt.contentHash = crypto.createHash('sha256').update(stableJsonLocal(copy)).digest('hex');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

/** stale 语义探针：exit 4（陈旧）且不得判篡改（exit 2 / TAMPERED 字样） */
function assertStaleNotTampered(r, label) {
  assert.equal(r.code, 4, `${label}：绑定面变化必须判陈旧 exit 4，实得 ${r.code}\n${out(r)}`);
  assert.notEqual(r.code, 2, `${label}：链完好不得判篡改 exit 2`);
  assert.doesNotMatch(out(r), /TAMPERED/, `${label}：链完好不得报 TAMPERED\n实际输出：${out(r)}`);
}

// ---------------- REQ-053：Receipt v2 绑定面 ----------------

describe('REQ-053 Receipt v2 绑定面', RT, () => {
  test('gate 回执在 diffHash 之外增绑 policyHash/engineHash/catalogHash', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK], { strength: { version: 1, profile: 'balanced' } });
    const g = run(['gate'], { cwd: dir });
    assert.equal(g.code, 0, `gate 应跑通: ${out(g)}`);
    const receipt = JSON.parse(read(dir, '.kimi-base/state/receipts/static-ok.json'));
    // 既有绑定面仍在（字段名 fingerprint 是 diffHash 的既有出口，两者任一皆可）
    assert.ok(receipt.fingerprint ?? receipt.diffHash, '回执必须保留既有 diffHash/fingerprint 绑定');
    // 锁定：回执必须携带三个新绑定字段（policyHash/engineHash/catalogHash）
    assert.ok(typeof receipt.policyHash === 'string' && receipt.policyHash.length > 0,
      `有 strength.json 时回执必须绑 policyHash（strength 解析输出），实得 ${JSON.stringify(receipt.policyHash)}`);
    assert.ok(typeof receipt.engineHash === 'string' && receipt.engineHash.length > 0,
      `回执必须绑 engineHash（runtime 树 LF 归一化哈希），实得 ${JSON.stringify(receipt.engineHash)}`);
    assert.ok(typeof receipt.catalogHash === 'string' && receipt.catalogHash.length > 0,
      `有 catalog 时回执必须绑 catalogHash（module-catalog.json 内容哈希），实得 ${JSON.stringify(receipt.catalogHash)}`);
  });

  test('无 strength.json / 无 catalog：显式 null 缺省标记，不伪造哈希', (t) => {
    if (!needGit(t)) return;
    // 契约歧义点 1：缺省标记 = 键存在且值 === null（区分「无配置」与「忘了绑」）。
    const noStrength = gateFixture(t, [PASS_CHECK]);
    assert.equal(run(['gate'], { cwd: noStrength }).code, 0, '无 strength.json 时 gate 应照常跑通');
    const r1 = JSON.parse(read(noStrength, '.kimi-base/state/receipts/static-ok.json'));
    assert.ok('policyHash' in r1, '回执必须显式携带 policyHash 键（缺省标记），不得缺键');
    assert.equal(r1.policyHash, null, '无 strength.json 时 policyHash 必须为显式 null，不伪造');

    const noCatalog = gateFixture(t, [PASS_CHECK], { withCatalog: false });
    assert.equal(run(['gate'], { cwd: noCatalog }).code, 0, '无 catalog 时 gate 应照常跑通');
    const r2 = JSON.parse(read(noCatalog, '.kimi-base/state/receipts/static-ok.json'));
    assert.ok('catalogHash' in r2, '回执必须显式携带 catalogHash 键（缺省标记），不得缺键');
    assert.equal(r2.catalogHash, null, '无 catalog 时 catalogHash 必须为显式 null，不伪造');
  });

  test('改 strength 配置轴值（policyHash 变）→ receipt verify exit 4 且点名 policyHash', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK], { strength: { version: 1, profile: 'balanced' } });
    assert.equal(run(['gate'], { cwd: dir }).code, 0, 'gate 应跑通');
    const fresh = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(fresh.code, 0, `刚跑完 gate 应通过: ${out(fresh)}`);
    // 收紧侧变化：profile balanced → strict（policyHash 必变）；git add 让变化进暂存面
    write(dir, '.kimi-base/strength.json', JSON.stringify({ version: 1, profile: 'strict' }, null, 2));
    git(dir, 'add', '-A');
    const stale = run(['receipt', 'verify'], { cwd: dir });
    assertStaleNotTampered(stale, '策略收紧');
    // 锁定：陈旧报告必须点名漂移的绑定面（policyHash），不只点名指纹移动
    assert.match(out(stale), /policyHash|policy|策略/i,
      `陈旧原因必须点名 policyHash（策略绑定面），实际输出：\n${out(stale)}`);
  });

  test('改引擎副本任意一个字节（engineHash 变）→ receipt verify exit 4 且点名 engineHash', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK]);
    // 引擎改动打在夹具仓安装的副本上（副本内改，不碰源仓）；gate/verify 均跑副本
    const runtime = installEngineCopy(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'vendor engine copy');
    assert.equal(run(['gate'], { cwd: dir, runtime }).code, 0, 'gate 应跑通');
    const fresh = run(['receipt', 'verify'], { cwd: dir, runtime });
    assert.equal(fresh.code, 0, `刚跑完 gate 应通过: ${out(fresh)}`);
    // 改副本一个字节（追加注释字节；引擎任何字节变化都使旧回执 stale——特性不是副作用）
    fs.appendFileSync(path.join(dir, '.kimi-base', 'runtime', 'lib', 'fast.mjs'), '//\n');
    const stale = run(['receipt', 'verify'], { cwd: dir, runtime });
    assertStaleNotTampered(stale, '引擎字节变化');
    assert.match(out(stale), /engineHash|engine|引擎/i,
      `陈旧原因必须点名 engineHash（引擎绑定面），实际输出：\n${out(stale)}`);
  });

  test('改 module-catalog.json（catalogHash 变）→ receipt verify exit 4 且点名 catalogHash', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK]);
    assert.equal(run(['gate'], { cwd: dir }).code, 0, 'gate 应跑通');
    const fresh = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(fresh.code, 0, `刚跑完 gate 应通过: ${out(fresh)}`);
    // catalog 内容变化（新增一个模块）；git add 让变化进暂存面
    writeCatalog(dir, { modules: [{ id: 'app', root: 'src', paths: ['**'] }, { id: 'lib', root: 'lib', paths: ['**'] }] });
    git(dir, 'add', '-A');
    const stale = run(['receipt', 'verify'], { cwd: dir });
    assertStaleNotTampered(stale, 'catalog 变化');
    assert.match(out(stale), /catalogHash|catalog|目录/i,
      `陈旧原因必须点名 catalogHash（架构图绑定面），实际输出：\n${out(stale)}`);
  });

  // 回归锁定（特别标注）：v1 语义在现实现上可绿；红=未来实现把旧格式谎报为篡改。
  test('向后兼容：v1 旧回执（无新绑定字段）按 v1 语义判定——不报篡改，指纹 fresh 即 exit 0', (t) => {
    if (!needGit(t)) return;
    // 契约歧义点 4：v1 回执按 v1 绑定面（fingerprint/diffHash）判定；缺新字段不是篡改证据。
    const dir = gateFixture(t, [PASS_CHECK]);
    assert.equal(run(['gate'], { cwd: dir }).code, 0, 'gate 应跑通');
    const receiptPath = path.join(dir, '.kimi-base', 'state', 'receipts', 'static-ok.json');
    // 剥掉 v2 绑定字段并重修 contentHash（合法 v1 回执，非篡改形态）
    rehashReceiptFile(receiptPath, (receipt) => {
      delete receipt.policyHash;
      delete receipt.engineHash;
      delete receipt.catalogHash;
    });
    const r = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(r.code, 0, `v1 回执不得因缺新字段被判失败（不谎报），实得 ${r.code}: ${out(r)}`);
    assert.doesNotMatch(out(r), /TAMPERED/, 'v1 回执缺新绑定字段不得报 TAMPERED');
  });
});

// ---------------- REQ-054：fast 证据贷款账本 ----------------

describe('REQ-054 fast 证据贷款账本', RT, () => {
  test('fast 窗口内被跳检查记 DEFERRED 债务条目入哈希链账本（kind/checkId/windowId 可解析）', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [DEFERRABLE_CHECK]);
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    const windowId = fastWindowId(dir);
    assert.ok(windowId, 'fast on 必须产生窗口 id');
    const g = run(['gate'], { cwd: dir });
    assert.match(out(g), /SKIPPED static-ok/, 'fast 窗口内可延期检查应 SKIPPED 留痕');
    // 契约歧义点 2：账本可查 = ledger.jsonl 逐行可解析，DEFERRED 条目字段齐备且入链。
    const entries = readLedger(dir);
    const deferred = entries.filter((e) => e.kind === 'deferred');
    assert.ok(deferred.length >= 1, `账本必须有 kind=deferred 的债务条目，实际条目: ${JSON.stringify(entries.map((e) => e.kind))}`);
    const entry = deferred.find((e) => e.checkId === 'static-ok');
    assert.ok(entry, `DEFERRED 条目必须含检查 id static-ok，实得: ${JSON.stringify(deferred)}`);
    assert.equal(entry.windowId, windowId, `DEFERRED 条目必须绑窗口 id ${windowId}，实得 ${JSON.stringify(entry.windowId)}`);
    assert.ok(typeof entry.contentHash === 'string' && typeof entry.chain === 'string',
      'DEFERRED 条目必须携带 contentHash/chain（入哈希链账本，不是旁白）');
  });

  test('关窗 / 窗口过期 / 删除 fast 状态文件 三形态均不清债：risk 仍报 FAST_MODE_DEBT', (t) => {
    if (!needGit(t)) return;
    const FAST_STATE = '.kimi-base/state/fast-mode.json';
    /** 造一笔债：fast on → gate（SKIPPED 留痕）→ 返回夹具目录 */
    const indebt = () => {
      const dir = gateFixture(t, [DEFERRABLE_CHECK]);
      assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
      const g = run(['gate'], { cwd: dir });
      assert.match(out(g), /SKIPPED static-ok/, '前置：窗口内检查必须已被跳过（债已发生）');
      return dir;
    };
    // 契约歧义点 7：只断言 FAST_MODE_DEBT 报告 token，不断言 risk 退出码。
    // 形态一：fast off 关窗
    const offDir = indebt();
    assert.equal(run(['fast', 'off'], { cwd: offDir }).code, 0, 'fast off 应成功');
    const offRisk = run(['risk', 'scan'], { cwd: offDir });
    assert.match(out(offRisk), /FAST_MODE_DEBT/, `关窗不清债：risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(offRisk)}`);
    // 形态二：窗口过期（expiresAt 改写为过去）
    const expiredDir = indebt();
    const st = JSON.parse(read(expiredDir, FAST_STATE));
    st.expiresAt = '2000-01-01T00:00:00.000Z';
    st.expiresEpoch = 0;
    write(expiredDir, FAST_STATE, JSON.stringify(st, null, 2));
    const expiredRisk = run(['risk', 'scan'], { cwd: expiredDir });
    assert.match(out(expiredRisk), /FAST_MODE_DEBT/, `窗口过期不清债：risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(expiredRisk)}`);
    // 形态三：删除 fast 状态文件
    const deletedDir = indebt();
    fs.rmSync(path.join(deletedDir, FAST_STATE));
    const deletedRisk = run(['risk', 'scan'], { cwd: deletedDir });
    assert.match(out(deletedRisk), /FAST_MODE_DEBT/, `删状态文件不清债：risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(deletedRisk)}`);
  });

  test('唯一偿还路径：窗口外同检查 fresh PASS 清债；窗口内再 gate 不算偿还', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [DEFERRABLE_CHECK]);
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    const g1 = run(['gate'], { cwd: dir });
    assert.match(out(g1), /SKIPPED static-ok/, '前置：窗口内检查必须已被跳过');
    // 锁定：债发生后 risk 必须报 FAST_MODE_DEBT
    const inDebt = run(['risk', 'scan'], { cwd: dir });
    assert.match(out(inDebt), /FAST_MODE_DEBT/, `欠债期间 risk 必须报 FAST_MODE_DEBT\n实际输出：${out(inDebt)}`);
    // 窗口内再 gate 一次（仍 SKIPPED，没有 fresh PASS）→ 不算偿还
    const g2 = run(['gate'], { cwd: dir });
    assert.match(out(g2), /SKIPPED static-ok/, '窗口内重跑仍应 SKIPPED');
    const stillInDebt = run(['risk', 'scan'], { cwd: dir });
    assert.match(out(stillInDebt), /FAST_MODE_DEBT/, '窗口内没有 fresh PASS，债务必须仍在');
    // 唯一偿还路径：fast off → 完整 gate（同检查 fresh PASS）
    assert.equal(run(['fast', 'off'], { cwd: dir }).code, 0, 'fast off 应成功');
    const repay = run(['gate'], { cwd: dir });
    assert.equal(repay.code, 0, `窗口外完整 gate 应跑通（fresh PASS）: ${out(repay)}`);
    const receipt = JSON.parse(read(dir, '.kimi-base/state/receipts/static-ok.json'));
    assert.equal(receipt.status, 'PASS', '偿还必须是同检查的 fresh PASS');
    assert.ok(!receipt.fastWindow, '偿还证据不得带 fast 窗口印记');
    // 契约歧义点 3：debt 视图归零 = risk scan 不再报 FAST_MODE_DEBT。
    const clean = run(['risk', 'scan'], { cwd: dir });
    assert.doesNotMatch(out(clean), /FAST_MODE_DEBT/, `fresh PASS 偿还后 risk 不得再报 FAST_MODE_DEBT\n实际输出：${out(clean)}`);
  });

  test('protected（security）与已执行 FAIL 永不进可延期集：照跑或如实 FAIL，不产 DEFERRED', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [
      DEFERRABLE_CHECK, // 唯一可延期检查
      { id: 'sec-scan', kind: 'security', command: 'node -e "process.exit(1)"' }, // protected：永不延期
      { id: 'plain-fail', kind: 'static', command: 'node -e "process.exit(1)"' }, // 未声明 allowFastSkip：窗口内照跑，如实 FAIL
    ]);
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    // security 属 high 风险层，须 --risk high 才入选计划
    const g = run(['gate', '--risk', 'high'], { cwd: dir });
    assert.notEqual(g.code, 0, '有如实 FAIL，gate 不得放行');
    assert.match(out(g), /sec-scan/, 'protected 检查必须出现在结果里（被执行，非延期）');
    assert.doesNotMatch(out(g), /sec-scan[^\n]*SKIP/i, 'protected 检查不得被 SKIPPED');
    const deferred = readLedger(dir).filter((e) => e.kind === 'deferred');
    // 防假绿：必须先证明账本里确实有 DEFERRED 条目，「不产 DEFERRED」的
    // 否定断言才不是空真。
    assert.ok(deferred.length >= 1, 'fast 窗口必须至少产出 static-ok 的 DEFERRED 条目（否则本用例的否定断言为空真）');
    assert.deepEqual(
      deferred.map((e) => e.checkId).sort(),
      ['static-ok'],
      `可延期集必须只含 static-ok；protected 与已执行 FAIL 永不产 DEFERRED，实得: ${JSON.stringify(deferred.map((e) => e.checkId))}`,
    );
  });

  // 回归锁定（特别标注，P7b 既有语义下沉到账本层前的行为锚点；现实现上预期绿）：
  // fastWindow 印记的 gate 记录永远不能关闭 task，也不能放行 release。
  test('P7b 回归锁定：fast 印记的 gate 记录不能关闭 task（exit 2 点名借账）与 release（exit 2）', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [DEFERRABLE_CHECK]);
    assert.equal(run(['task', 'start', '--goal', 'fast 借账演示', '--owned', 'src', '--risk', 'low'], { cwd: dir }).code, 0);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    const g = run(['gate'], { cwd: dir });
    assert.match(out(g), /SKIPPED static-ok/, 'fast 窗口内检查应 SKIPPED 留痕');
    const blocked = run(['task', 'complete'], { cwd: dir });
    assert.equal(blocked.code, 2, `fast 借账回执不得关闭 task，实际 ${blocked.code}: ${out(blocked)}`);
    assert.match(blocked.stdout, /fastWindow/, '缺口必须点名 fast 印记');
    const rel = run(['release'], { cwd: dir });
    assert.equal(rel.code, 2, `fast 借账未还不得放行 release，实际 ${rel.code}: ${out(rel)}`);
    assert.match(out(rel), /fast|借账/i, 'release 阻断项必须点名 fast 欠账');
  });
});

// ---------------- REQ-055：可提交证据模式 ----------------

describe('REQ-055 可提交证据模式', RT, () => {
  test('committed 模式：回执与账本纳入 git 视野（未被忽略、git status 可见）；证据日志本体永不入库', (t) => {
    if (!needGit(t)) return;
    // 锁定：harness.json 必须接受 evidence 段（committed 模式），gate 跑通是入口断言。
    const dir = gateFixture(t, [
      PASS_CHECK,
      // 输出 >4000 字节强制证据日志落盘（writeEvidence 的既有阈值），检验日志永不入库
      { id: 'noisy', kind: 'static', command: 'node -e "process.stdout.write(\'x\'.repeat(5000))"' },
    ], { harnessExtra: { evidence: { mode: 'committed' } } });
    const g = run(['gate'], { cwd: dir });
    assert.equal(g.code, 0, `committed 模式下 gate 应跑通: ${out(g)}`);
    // 回执与账本：不被 gitignore，且（已入 index 或 git status 可见）（契约歧义点 5）
    const books = findFiles(dir, /^\.kimi-base\/.*(ledger.*\.jsonl|receipts\/.*\.json)$/)
      .filter((f) => !f.endsWith('.gitignore'));
    assert.ok(books.length >= 2, `应找到账本与回执文件，实际: ${books.join(',') || '(无)'}`);
    const lsFiles = git(dir, 'ls-files');
    const status = gitRaw(dir, 'status', '--porcelain').stdout;
    for (const rel of books) {
      const ignored = gitRaw(dir, 'check-ignore', '-q', rel).code === 0;
      assert.ok(!ignored, `committed 模式下 ${rel} 不得被 git-ignored`);
      assert.ok(lsFiles.includes(rel) || status.includes(rel),
        `committed 模式下 ${rel} 必须纳入 git 跟踪（ls-files 或 git status 可见）`);
    }
    // 证据日志本体：永不入库（契约歧义点 6：必须 git-ignored，仅 untracked 不够）
    const logs = findFiles(dir, /^\.kimi-base\/.*evidence\/.*\.log$/);
    assert.ok(logs.length >= 1, 'noisy 检查应产生证据日志本体（>4000 字节阈值）');
    for (const rel of logs) {
      assert.ok(!lsFiles.includes(rel), `证据日志 ${rel} 不得被 git 跟踪`);
      assert.equal(gitRaw(dir, 'check-ignore', '-q', rel).code, 0,
        `证据日志 ${rel} 必须被 git-ignored（永不入库的机械保证）`);
    }
  });

  test('committed 模式：git clone 换机后 receipt verify 直接 exit 0（不需重跑 gate）', (t) => {
    if (!needGit(t)) return;
    // 锁定同上：committed 模式配置被接受、gate 跑通后 clone 可验。
    const dir = gateFixture(t, [PASS_CHECK], { harnessExtra: { evidence: { mode: 'committed' } } });
    const g = run(['gate'], { cwd: dir });
    assert.equal(g.code, 0, `committed 模式下 gate 应跑通: ${out(g)}`);
    // 把证据纳入提交史（若实现选择 gate 内自动提交，此处为空操作，幂等）
    if (gitRaw(dir, 'status', '--porcelain').stdout.trim()) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'committed evidence');
    }
    const parent = mkdtemp(t, 'kimi-base-clone-');
    const cloneDir = path.join(parent, 'clone');
    git(parent, 'clone', '-q', dir, cloneDir);
    // 换机模拟：克隆仓直接验链（同一引擎入口 RUNTIME——换的是仓，不是引擎版本）
    const verify = run(['receipt', 'verify'], { cwd: cloneDir });
    assert.equal(verify.code, 0, `克隆仓必须能直接验链 exit 0（证据可移植），实得 ${verify.code}:\n${out(verify)}`);
  });

  // 回归锁定（特别标注）：local 是默认零负担模式；state/.gitignore 由 install 落地，
  // 回执/账本永不进 git 跟踪——现实现上预期绿。
  test('默认 local 模式行为不变：回执/账本 git-ignored，git add -A 也不入跟踪', (t) => {
    if (!needGit(t)) return;
    // 用 install 种子建夹具（state/.gitignore 是安装器落地物，手工 harness 夹具没有它）
    const src = mkdtemp(t, 'kimi-base-src-');
    for (const sub of ['.kimi-base/runtime', '.kimi-base/rules', '.kimi-base/templates', '.kimi-base/audit', '.kimi-base/githooks', '.kimi-code']) {
      fs.cpSync(path.join(REPO, sub), path.join(src, sub), { recursive: true });
    }
    for (const f of ['adapters.json', 'state.README', 'harness.example.json', 'module-catalog.example.json', 'verification-matrix.example.json']) {
      fs.cpSync(path.join(REPO, '.kimi-base', f), path.join(src, '.kimi-base', f));
    }
    const srcRuntime = path.join(src, '.kimi-base', 'runtime', 'kimi-base.mjs');
    const dir = mkdtemp(t);
    assert.equal(run(['install', '.'], { cwd: dir, runtime: srcRuntime }).code, 0, 'install 应成功');
    // install 种子 harness.json 的 quality.riskChecks 引用种子矩阵里的检查 id；本用例只需
    // state/.gitignore 这个安装落地物，harness 覆盖为最小配置（种子语义允许用户定制）。
    writeHarness(dir);
    writeMatrix(dir, [PASS_CHECK]);
    write(dir, 'src/a.js', 'export const a = 1;\n');
    gitInitCommit(dir);
    const g = run(['gate'], { cwd: dir, runtime: srcRuntime });
    assert.equal(g.code, 0, `local 模式 gate 应跑通: ${out(g)}`);
    git(dir, 'add', '-A'); // 即使用户全量 add，被忽略的证据也不入跟踪
    const lsFiles = git(dir, 'ls-files');
    const books = findFiles(dir, /^\.kimi-base\/state\/(ledger.*\.jsonl|receipts\/.*\.json)$/);
    assert.ok(books.length >= 1, `local 模式应已产生账本/回执，实际: ${books.join(',') || '(无)'}`);
    for (const rel of books) {
      assert.ok(!lsFiles.includes(rel), `local 模式 ${rel} 不得被 git 跟踪`);
      assert.equal(gitRaw(dir, 'check-ignore', '-q', rel).code, 0, `local 模式 ${rel} 必须保持 git-ignored`);
    }
  });

  test('evidence.mode 非法值 → 配置期 exit 1 并点名非法值；合法 local 被接受', (t) => {
    // 配置期校验（harness.json 严格校验器路径），不需要 git。
    const bad = mkdtemp(t);
    writeHarness(bad, { evidence: { mode: 'turbo' } });
    const rejected = run(['fast', 'status'], { cwd: bad });
    assert.equal(rejected.code, 1, `非法 evidence.mode 必须配置期 exit 1，实得 ${rejected.code}: ${out(rejected)}`);
    // 防假绿：只断 exit 1 不够（「未知字段 evidence」式报错同样 exit 1）——必须点名非法值 turbo。
    assert.ok(out(rejected).includes('turbo'), `配置错误必须点名非法值 turbo\n实际输出：${out(rejected)}`);
    const ok = mkdtemp(t);
    writeHarness(ok, { evidence: { mode: 'local' } });
    const accepted = run(['fast', 'status'], { cwd: ok });
    assert.equal(accepted.code, 0, `evidence.mode: "local" 是合法值，必须被接受，实得 ${accepted.code}: ${out(accepted)}`);
  });
});

// ---------------- P4 评审 error 级缺陷回归锁（REQ-053/054/055 目标语义；红测先行随修复转绿） ----------------
//
// 缺陷锚点（P4 评审发现，修复语义逐条在用例处注释）：
//   D1 镜像伪造 fail-open（REQ-053/verify.mjs）：DRIFT 收窄后，伪造 receipts/ 镜像
//      （FAIL→PASS + 重算 contentHash 自洽，新哈希不在账本历史）verify exit 0 放行。
//      目标：镜像必须字段级对账账本最新条目（id/checkId/status/fingerprint/绑定面/证据哈希一致），
//      status 被改 → exit 2 判篡改。与既有「v1 回执向后兼容」回归锁定兼容：v1 回执缺的只是
//      v2 三键，其余字段与账本条目一致——对账必须跳过回执缺失的键，而不是谎报篡改。
//   D2 轮转清债（REQ-054/ledger+fast+hygiene）：retention.ledgerMaxEntries 触发轮转把未偿还
//      deferred 归档后，fastDebtOf 只扫当前段 → risk 不再报 FAST_MODE_DEBT（轮转成了未声明的
//      免债路径）。目标：债务视图跨归档段存活（扫归档段或轮转时结转未清债，实现自选）。
//   D3 committed 落盘证据与 clone 矛盾（REQ-055）：noisy 检查（>4000 字节）的外部 .log 永不入库，
//      clone 后 verify 判 MISSING exit 2——与「committed 可移植」自相矛盾。目标：回执携带内联
//      证据摘要与有界尾部（decision-relevant 随 git 走），外部日志降级为本地参考、缺失不判
//      MISSING → exit 0；篡改内联摘要 → exit 2。
//   D4 根 .gitignore 压死 committed 模式（REQ-055）：根 .gitignore 含 .kimi-base/state/ 时
//      （git 规则：父目录被排除则嵌套 .gitignore 捞不回），gate 抛 GIT_FAILED exit 1 裸栈
//      （已实测：git add -- .kimi-base/state 被根忽略规则拒绝）。目标：exit 2 + 点名根
//      .gitignore 冲突与可操作修法。
//   D5 policyHash 绑本地 state 致 clone 假陈旧（REQ-055/strength）：strength set 的 state 覆盖
//      不入库，clone 上 policyHash 失配 exit 4 且无偿还路径。目标：strength set 输出显式警告
//      「本地覆盖不入库」；verify 的 policyHash 失配报文给偿还路径指引（点名如何恢复一致）。

describe('REQ-053 P4 缺陷回归：镜像伪造 fail-open', RT, () => {
  test('伪造 receipts/ 镜像（FAIL→PASS + 重算 contentHash 自洽）→ verify exit 2 判篡改（字段级对账账本条目）', (t) => {
    if (!needGit(t)) return;
    const FAIL_CHECK = { id: 'static-fail', kind: 'static', command: 'node -e "process.exit(1)"' };
    const dir = gateFixture(t, [FAIL_CHECK]);
    const g = run(['gate'], { cwd: dir });
    assert.notEqual(g.code, 0, '前置：FAIL 检查不得放行 gate');
    const receiptPath = path.join(dir, '.kimi-base', 'state', 'receipts', 'static-fail.json');
    assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).status, 'FAIL',
      '前置：账本/镜像中的真实判定必须是 FAIL（伪造对象是 FAIL→PASS）');
    const fresh = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(fresh.code, 0, `前置：未篡改时 verify 应通过: ${out(fresh)}`);
    // 伪造形态（同 /tmp/p4-mut/fabricate.mjs）：改 FAIL→PASS 并重算 contentHash 使镜像自洽；
    // 新 contentHash 不在该 check 的账本历史中——不是回滚（DRIFT），是凭空伪造。
    rehashReceiptFile(receiptPath, (receipt) => { receipt.status = 'PASS'; });
    const forged = run(['receipt', 'verify'], { cwd: dir });
    // 锁定（D1）：镜像必须字段级对账账本最新条目——凭空伪造（新 contentHash 不在账本
    // 历史，非回滚）不得借「镜像自洽+链完好」fail-open，status FAIL≠PASS → TAMPERED exit 2。
    assert.equal(forged.code, 2, `伪造镜像（status FAIL→PASS）必须判篡改 exit 2，实得 ${forged.code}\n${out(forged)}`);
    assert.match(out(forged), /TAMPERED/, `伪造镜像必须报 TAMPERED\n实际输出：${out(forged)}`);
    assert.match(out(forged), /static-fail/, `报文必须点名被伪造的检查\n实际输出：${out(forged)}`);
  });
});

describe('REQ-054 P4 缺陷回归：轮转清债', RT, () => {
  test('轮转归档未偿还 DEFERRED 后 risk 仍报 FAST_MODE_DEBT；窗口外 fresh PASS 偿还后（跨归档段）债务清', (t) => {
    if (!needGit(t)) return;
    // retention.ledgerMaxEntries=2：造债（verification SKIPPED + deferred 共 2 条数据条目）后
    // 再追加 1 条数据条目即触发轮转，未偿还的 deferred 被归档出当前段。
    const dir = gateFixture(t, [DEFERRABLE_CHECK], { harnessExtra: { retention: { ledgerMaxEntries: 2 } } });
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    const g = run(['gate'], { cwd: dir });
    assert.match(out(g), /SKIPPED static-ok/, '前置：窗口内检查必须已被跳过（债已发生）');
    const beforeRotation = run(['risk', 'scan'], { cwd: dir });
    assert.match(out(beforeRotation), /FAST_MODE_DEBT/,
      `前置：轮转前 risk 必须已报 FAST_MODE_DEBT（否则后续断言为空真）\n实际输出：${out(beforeRotation)}`);
    // 触发轮转：关窗后把同检查翻转为 FAIL 再 gate（FAIL 不是偿还——唯一偿还是窗口外 fresh PASS），
    // 追加 1 条 verification → 数据条目 3 > cap 2 → 旧段整体归档、anchor 起新段。
    assert.equal(run(['fast', 'off'], { cwd: dir }).code, 0, 'fast off 应成功');
    writeMatrix(dir, [{ ...DEFERRABLE_CHECK, command: 'node -e "process.exit(1)"' }]);
    run(['gate'], { cwd: dir });
    const archives = findFiles(dir, /^\.kimi-base\/state\/ledger-archive-.+\.jsonl$/);
    assert.ok(archives.length >= 1, '前置：轮转必须已发生（存在归档段），否则本用例在测空气');
    assert.ok(!readLedger(dir).some((entry) => entry.kind === 'deferred'),
      '前置：deferred 债务条目必须已被归档出当前段（当前段无 deferred），否则没测到轮转清债面');
    // 锁定（D2）：deferred 债务视图必须跨归档段存活——轮转不是免债路径
    // （旧缺陷：fastDebtOf 只扫当前段 → 归档即免债，risk 不再报）。
    const afterRotation = run(['risk', 'scan'], { cwd: dir });
    assert.match(out(afterRotation), /FAST_MODE_DEBT/,
      `轮转不得清债：deferred 被归档后 risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(afterRotation)}`);
    // 偿还（轮转之后）：恢复检查为 PASS，窗口外 fresh PASS 清债——只有跨归档段记账才成立。
    writeMatrix(dir, [DEFERRABLE_CHECK]);
    const repay = run(['gate'], { cwd: dir });
    assert.equal(repay.code, 0, `窗口外完整 gate 应跑通（fresh PASS）: ${out(repay)}`);
    const clean = run(['risk', 'scan'], { cwd: dir });
    assert.doesNotMatch(out(clean), /FAST_MODE_DEBT/,
      `跨归档段偿还后 risk 不得再报 FAST_MODE_DEBT\n实际输出：${out(clean)}`);
  });
});

describe('REQ-055 P4 缺陷回归：committed 落盘证据 / 根 .gitignore / policyHash 本地覆盖', RT, () => {
  test('noisy 检查（证据日志落盘）clone 后 verify 不得判 MISSING（内联摘要随 git 走）；篡改内联摘要 → exit 2', (t) => {
    if (!needGit(t)) return;
    const NOISY_CHECK = { id: 'noisy', kind: 'static', command: 'node -e "process.stdout.write(\'x\'.repeat(5000))"' };
    const dir = gateFixture(t, [PASS_CHECK, NOISY_CHECK], { harnessExtra: { evidence: { mode: 'committed' } } });
    const g = run(['gate'], { cwd: dir });
    assert.equal(g.code, 0, `committed 模式下 gate 应跑通: ${out(g)}`);
    const receipt = JSON.parse(read(dir, '.kimi-base/state/receipts/noisy.json'));
    assert.ok(receipt.evidencePath, '前置：noisy 检查输出 >4000 字节，证据日志必须落盘（外部 .log）');
    // 把证据纳入提交史（与既有 clone 用例同例，幂等）
    if (gitRaw(dir, 'status', '--porcelain').stdout.trim()) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'committed evidence');
    }
    const parent = mkdtemp(t, 'kimi-base-clone-');
    const cloneDir = path.join(parent, 'clone');
    git(parent, 'clone', '-q', dir, cloneDir);
    // 前置：外部 .log 永不入库（committed 的 state/.gitignore 忽略 evidence/）→ clone 上物理缺失。
    assert.ok(!exists(cloneDir, receipt.evidencePath),
      `前置：证据日志本体不得随 clone 迁移（${receipt.evidencePath}），否则本用例没测到「外部日志缺失」面`);
    // 锁定（D3）：回执携带内联证据摘要与有界尾部（decision-relevant 随 git 走，sha256 已在
    // 回执里验证），外部 .log 降级为本地参考——clone 上缺失不判 MISSING（committed 可移植）。
    // （无 strength.json、同引擎、同 catalog，唯一可能失败面就是 MISSING。）
    const verify = run(['receipt', 'verify'], { cwd: cloneDir });
    assert.equal(verify.code, 0,
      `clone 后 verify 不得因外部日志缺失判 MISSING（内联摘要已随回执入库），实得 ${verify.code}:\n${out(verify)}`);
    // 篡改内联摘要/证据哈希（伪造自洽 contentHash）→ 字段级对账账本条目必须判篡改 exit 2。
    rehashReceiptFile(path.join(cloneDir, '.kimi-base', 'state', 'receipts', 'noisy.json'), (r) => {
      r.summary = 'FABRICATED inline evidence summary';
      r.evidenceSha256 = '0'.repeat(64);
    });
    const forged = run(['receipt', 'verify'], { cwd: cloneDir });
    assert.equal(forged.code, 2, `篡改内联摘要必须判篡改 exit 2，实得 ${forged.code}\n${out(forged)}`);
    assert.match(out(forged), /TAMPERED/, `篡改内联摘要必须报 TAMPERED\n实际输出：${out(forged)}`);
  });

  test('根 .gitignore 排除 .kimi-base/state/ → committed gate exit 2 且点名根 .gitignore 冲突与修法（不得 GIT_FAILED exit 1 裸栈）', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK], { harnessExtra: { evidence: { mode: 'committed' } } });
    // git 规则：父目录被根 .gitignore 排除后，嵌套 state/.gitignore 的例外规则捞不回来。
    write(dir, '.gitignore', '.kimi-base/state/\n');
    const g = run(['gate'], { cwd: dir });
    // 锁定（D4）：committed 模式必须识别根 .gitignore 冲突，治理阻断 exit 2 + 可操作指引
    // （旧缺陷：ensureStateGitignore 写嵌套 .gitignore 对根排除无效，git add 被根规则整体
    // 拒绝 → GIT_FAILED exit 1 裸栈）。
    assert.equal(g.code, 2,
      `根 .gitignore 压死 committed 模式必须是治理阻断 exit 2（非 GIT_FAILED exit 1 裸栈），实得 ${g.code}\n${out(g)}`);
    assert.match(out(g), /\.gitignore/, `报文必须点名 .gitignore 冲突\n实际输出：${out(g)}`);
    assert.match(out(g), /根|root/i, `报文必须点名冲突在「根」.gitignore（嵌套 .gitignore 捞不回被排除的父目录）\n实际输出：${out(g)}`);
    assert.match(out(g), /删除|移除|例外|unignore|!/,
      `报文必须给可操作修法（删除根排除规则或为 .kimi-base/state/ 设例外）\n实际输出：${out(g)}`);
  });

  test('strength set 本地覆盖必须警告「不入库」；clone 上 policyHash 失配报文必须给偿还路径指引', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK], {
      harnessExtra: { evidence: { mode: 'committed' } },
      strength: { version: 1, profile: 'balanced' }
    });
    // strength set 写 .kimi-base/state/strength.json（state 覆盖）——committed 模式该文件永不入库。
    const set = run(['strength', 'set', '--profile', 'strict'], { cwd: dir });
    assert.equal(set.code, 0, `strength set 应成功: ${out(set)}`);
    // 锁定（D5a）：strength set 必须显式警告「本地覆盖不随 git 入库」——
    // 否则用户不知道 clone/换机后 policyHash 会假陈旧。
    assert.match(out(set), /不入库|不入\s*git|不随\s*(git|仓库|提交)|不会被?(提交|入库)/i,
      `committed 模式下 strength set 必须显式警告「本地覆盖不入库」\n实际输出：${out(set)}`);
    const g = run(['gate'], { cwd: dir });
    assert.equal(g.code, 0, `gate 应跑通: ${out(g)}`);
    if (gitRaw(dir, 'status', '--porcelain').stdout.trim()) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'committed evidence');
    }
    const parent = mkdtemp(t, 'kimi-base-clone-');
    const cloneDir = path.join(parent, 'clone');
    git(parent, 'clone', '-q', dir, cloneDir);
    const verify = run(['receipt', 'verify'], { cwd: cloneDir });
    // 前置语义：state 覆盖没随 git 走 → clone 上 policyHash 按 strength.json（balanced）重解析
    // ≠ receipt（strict）→ 链完好、非篡改，判陈旧 exit 4。
    assert.equal(verify.code, 4, `clone 上 policyHash 失配应判陈旧 exit 4，实得 ${verify.code}\n${out(verify)}`);
    assert.doesNotMatch(out(verify), /TAMPERED/, '本地覆盖未入库不是篡改，不得报 TAMPERED');
    assert.match(out(verify), /policyHash/, `陈旧原因必须点名 policyHash 绑定面\n实际输出：${out(verify)}`);
    // 锁定（D5b）：policyHash 失配报文必须给恢复一致的偿还路径指引。
    assert.match(out(verify), /strength\s*set|恢复一致|重新?设[定置]/,
      `policyHash 失配报文必须给偿还路径指引（点名如何恢复一致，如 strength set --profile <档名>）\n实际输出：${out(verify)}`);
  });
});

// ---------------- P4 二轮评审 error 级缺陷回归锁（REQ-053/054/055 目标语义；红测先行随修复转绿） ----------------
//
// 缺陷锚点（P4 二轮评审发现，修复语义逐条在用例处注释）：
//   E1 交集对账多塞键绕过（REQ-053/verify.mjs）：镜像字段级对账取共享键交集（`if (!(key in tail))
//      continue`），往真实镜像注入账本尾没有的键（validUntil=未来）+ 重修 contentHash，对账跳过
//      该键，且 stale 循环的 validUntil 分支（窗口未过期）continue 跳过指纹比对 → 指纹已移动的
//      旧回执从 STALE 洗成 exit 0。目标：镜像只能比账本条目少键（v1 兼容），不许多键——多键即
//      TAMPERED exit 2；validUntil 豁免只在其与账本条目一致时生效。
//   E2 归档段零鉴权（REQ-054/ledger）：归档段内容从不被链校验——①就地剔除 deferred 行，
//      ②投放伪造归档（文件名时间戳字典序排最后、内置假偿还 PASS 条目），两者都使 readLedgerHistory
//      的债务视图被洗白（FAST_MODE_DEBT 静默消失）且 verify 报链完好 exit 0。目标：verify 必须
//      校验归档段与 anchor 记录（count/链尾）一致性——归档被改/伪造归档出现 → exit 2；risk 的
//      债务判定不得被归档篡改影响。
//   E3 evidenceTail 截断错位（REQ-055/gate.mjs）：evidenceTail = boundedText(rawEvidence.slice(-4000),
//      2000) 取的是 [-4000,-2000) 中段而非真实末尾——decision-relevant 的尾部判定行被丢弃。
//      目标：committed 模式 noisy 检查的回执 evidenceTail 必须包含真实输出末尾。

describe('REQ-053 P4 二轮缺陷回归：交集对账多塞键绕过', RT, () => {
  test('镜像注入账本尾没有的键（validUntil=未来）+ 重修哈希 → 把 STALE 洗成 exit 0 必须判 TAMPERED exit 2', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [PASS_CHECK]);
    assert.equal(run(['gate'], { cwd: dir }).code, 0, 'gate 应跑通');
    // 改动业务代码使指纹移动：未注入时回执必须如实判 STALE exit 4（前置，证明指纹确实已移动）
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const moved = 1;\n');
    const stale = run(['receipt', 'verify'], { cwd: dir });
    assertStaleNotTampered(stale, '前置：指纹移动（未注入）');
    // 攻击：镜像注入账本尾条目没有的键 validUntil（未来时间）并重修 contentHash 使镜像自洽。
    const receiptPath = path.join(dir, '.kimi-base', 'state', 'receipts', 'static-ok.json');
    rehashReceiptFile(receiptPath, (receipt) => {
      receipt.validUntil = new Date(Date.now() + 3600_000).toISOString();
    });
    const laundered = run(['receipt', 'verify'], { cwd: dir });
    // 锁定（E1）：镜像含账本条目不存在的键 = 凭空多键 → TAMPERED exit 2（少键才是 v1 兼容
    // 形态）；validUntil 豁免只在其与账本条目一致时生效——多塞键不得把 STALE 洗成 exit 0。
    assert.equal(laundered.code, 2,
      `注入多塞键洗钱 STALE 必须判篡改 exit 2，实得 ${laundered.code}\n${out(laundered)}`);
    assert.match(out(laundered), /TAMPERED/, `多塞键镜像必须报 TAMPERED\n实际输出：${out(laundered)}`);
    assert.match(out(laundered), /static-ok/, `报文必须点名被注入的检查\n实际输出：${out(laundered)}`);
  });
});

describe('REQ-054 P4 二轮缺陷回归：归档段零鉴权', RT, () => {
  test('就地剔除归档内 deferred / 投放伪造归档（假偿还 PASS）→ verify exit 2 且 risk 债务判定不被洗白', (t) => {
    if (!needGit(t)) return;
    // 与首轮 D2 同夹具：cap=2 造债 → 翻转 FAIL 触发轮转，未偿还 deferred 被归档出当前段。
    const rotateWithDebt = () => {
      const dir = gateFixture(t, [DEFERRABLE_CHECK], { harnessExtra: { retention: { ledgerMaxEntries: 2 } } });
      assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
      assert.match(out(run(['gate'], { cwd: dir })), /SKIPPED static-ok/, '前置：窗口内检查必须已被跳过（债已发生）');
      assert.equal(run(['fast', 'off'], { cwd: dir }).code, 0, 'fast off 应成功');
      writeMatrix(dir, [{ ...DEFERRABLE_CHECK, command: 'node -e "process.exit(1)"' }]);
      run(['gate'], { cwd: dir });
      const archives = findFiles(dir, /^\.kimi-base\/state\/ledger-archive-.+\.jsonl$/);
      assert.ok(archives.length >= 1, '前置：轮转必须已发生（存在归档段）');
      assert.ok(!readLedger(dir).some((entry) => entry.kind === 'deferred'),
        '前置：deferred 债务条目必须已被归档出当前段');
      assert.match(out(run(['risk', 'scan'], { cwd: dir })), /FAST_MODE_DEBT/,
        '前置：轮转后债务必须仍在（首轮 D2 已锁定轮转不清债）');
      return { dir, archive: archives[0] };
    };

    // 形态①：就地编辑归档段，剔除 deferred 行（债务从可读历史中消失）。
    {
      const { dir, archive } = rotateWithDebt();
      const kept = read(dir, archive).split('\n').filter(Boolean)
        .filter((line) => JSON.parse(line).kind !== 'deferred');
      write(dir, archive, `${kept.join('\n')}\n`);
      // 锁定（E2 形态①）：归档段必须与 anchor 记录（count/链尾）对账——被改 → exit 2
      // 判篡改/断链并点名归档段（旧缺陷：归档段内容从不重放校验 → exit 0 报链完好）。
      const verify = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(verify.code, 2,
        `归档段被就地编辑（剔除 deferred）必须 exit 2，实得 ${verify.code}\n${out(verify)}`);
      assert.match(out(verify), /TAMPERED|BROKEN/, `归档篡改必须报 TAMPERED/BROKEN\n实际输出：${out(verify)}`);
      assert.match(out(verify), /归档|archive/i, `报文必须点名归档段\n实际输出：${out(verify)}`);
      // 目标：risk 的债务判定不得被归档篡改洗白——不得「无高危」静默放行
      // （仍报债务或响亮报告归档篡改，实现自选）。
      const risk = run(['risk', 'scan'], { cwd: dir });
      assert.notEqual(risk.code, 0,
        `归档被剔债后 risk 不得保持干净（exit 0 无高危），实得 ${risk.code}\n${out(risk)}`);
      assert.match(out(risk), /FAST_MODE_DEBT|归档|archive|账本|ledger/i,
        `risk 必须仍报债务或响亮报告归档篡改\n实际输出：${out(risk)}`);
    }

    // 形态②：投放伪造归档（文件名时间戳字典序排最后，内置自洽的假偿还 PASS 条目）。
    {
      const { dir } = rotateWithDebt();
      // 攻击者自洽构造一条无 fastWindow 的 PASS 账本条目（测试侧独立重算，与引擎 stableJson 同算法）。
      const forged = {
        version: 1, kind: 'verification', checkId: 'static-ok', checkKind: 'static',
        status: 'PASS', createdAt: '2026-01-01T00:00:00.000Z'
      };
      forged.contentHash = crypto.createHash('sha256').update(stableJsonLocal(forged)).digest('hex');
      forged.chain = crypto.createHash('sha256').update(`GENESIS\0${forged.contentHash}`).digest('hex');
      // 文件名时间戳字典序排最后 → readLedgerHistory 把它拼在真实归档之后、当前段之前。
      write(dir, '.kimi-base/state/ledger-archive-9999999999999-ffffff.jsonl', `${JSON.stringify(forged)}\n`);
      // 锁定（E2 形态②）：伪造归档出现 = 与 anchor 记录（count/链尾）对不上 → verify exit 2；
      // 假偿还不得清债——risk 必须仍报 FAST_MODE_DEBT（旧缺陷：伪造归档零鉴权入史，
      // 假 PASS 被计为偿还，截断检测只数归档个数 → exit 0）。
      const verify = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(verify.code, 2,
        `投放伪造归档必须 exit 2，实得 ${verify.code}\n${out(verify)}`);
      assert.match(out(verify), /TAMPERED|BROKEN/, `伪造归档必须报 TAMPERED/BROKEN\n实际输出：${out(verify)}`);
      assert.match(out(verify), /归档|archive/i, `报文必须点名归档段\n实际输出：${out(verify)}`);
      const risk = run(['risk', 'scan'], { cwd: dir });
      assert.match(out(risk), /FAST_MODE_DEBT/,
        `伪造归档内的假偿还 PASS 不得清债：risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(risk)}`);
    }
  });
});

describe('REQ-055 P4 二轮缺陷回归：evidenceTail 截断错位', RT, () => {
  test('committed 模式 noisy 检查（输出尾部带判定标记行）的回执 evidenceTail 必须包含真实输出末尾', (t) => {
    if (!needGit(t)) return;
    // 金丝雀纪律：标记串拼接构造，防本仓 fitness/secret 扫描误伤字面形态。
    const marker = ['EVIDENCE', 'TAIL', 'MARKER', '7f3a9c'].join('-');
    const noisy = {
      id: 'noisy', kind: 'static',
      // >4000 字节强制走 writeEvidence 落盘 + evidenceTail 内联路径；标记行在输出真实末尾
      command: `node -e "process.stdout.write('x'.repeat(5000)+'${marker}')"`
    };
    const dir = gateFixture(t, [noisy], { harnessExtra: { evidence: { mode: 'committed' } } });
    const g = run(['gate'], { cwd: dir });
    assert.equal(g.code, 0, `committed 模式下 gate 应跑通: ${out(g)}`);
    const receipt = JSON.parse(read(dir, '.kimi-base/state/receipts/noisy.json'));
    assert.ok(receipt.evidencePath, '前置：>4000 字节输出必须落盘外部 .log（evidenceTail 是其内联替代）');
    assert.ok(typeof receipt.evidenceTail === 'string' && receipt.evidenceTail.length > 0,
      `回执必须携带内联证据尾部 evidenceTail，实得 ${JSON.stringify(receipt.evidenceTail)}`);
    // 锁定（E3）：evidenceTail 必须是真实末尾的有界尾部（判定行必须在内）——
    // 旧缺陷：boundedText(rawEvidence.slice(-4000), 2000) 从头截 2000，
    // 落进回执的是 [-4000,-2000) 中段，真实末尾被丢弃。
    assert.ok(receipt.evidenceTail.includes(marker),
      `evidenceTail 必须包含真实输出末尾的标记 ${marker}（尾部才是 decision-relevant 证据）\n实际 evidenceTail 末尾：…${receipt.evidenceTail.slice(-120)}`);
  });
});

// ---------------- P4 三轮评审 error 级缺陷回归锁（REQ-054 目标语义；红测先行随修复转绿） ----------------
//
// 缺陷锚点（P4 三轮评审发现，修复语义逐条在用例处注释）：
//   F1 镜像对账失锚（verify.mjs）：镜像对账的锚点（latestByCheck/historyByCheck）只来自当前段
//      （readLedgerEntries），某 check 的账本条目全部轮转进归档段后对账整体旁路
//      （`if (!tail || …) continue`）——① 镜像回滚到归档里的旧回执、② 凭空伪造 status/summary
//      的镜像，两者都 exit 0。目标：镜像对账必须走全史（trusted 视图/等价全量条目集），
//      轮转不削弱镜像校验。
//   F2 当前段尾部截断失声（ledger/verify/hygiene）：deferred 条目位于账本尾行、无镜像、无长度锚
//      ——删尾行后链仍是合法前缀，verify 报「链：完好」exit 0、risk 的 FAST_MODE_DEBT 失声。
//      目标：引擎必须能检测尾部截断（建议：追加条目后原子写 head 锚文件，verify 对账 head 锚
//      与链尾，不一致 → exit 2 判篡改）；截断不得清债——risk 仍报 FAST_MODE_DEBT。

describe('REQ-054 P4 三轮缺陷回归：镜像对账失锚（轮转后）', RT, () => {
  test('check 的账本条目全部轮转进归档后：镜像回滚归档旧回执 / 凭空伪造镜像 都必须 exit 2', (t) => {
    if (!needGit(t)) return;
    // cap=1：每次追加第 2 条数据条目即轮转。两次 gate（4 条 verification）后当前段只剩 anchor，
    // 两个 check 的全部账本条目都在归档段——镜像对账失去当前段锚点（失锚现场）。
    const rotatedMirrors = () => {
      const dir = gateFixture(t, [PASS_CHECK, { ...PASS_CHECK, id: 'static-ok-2' }],
        { harnessExtra: { retention: { ledgerMaxEntries: 1 } } });
      assert.equal(run(['gate'], { cwd: dir }).code, 0, 'gate#1 应跑通');
      // 保存 static-ok 的旧回执（gate#2 后将成为「归档里的旧条目」，供回滚攻击复用）
      const oldMirror = read(dir, '.kimi-base/state/receipts/static-ok.json');
      // 不改工作树再 gate：新旧回执指纹相同但 id/createdAt/durationMs 不同 → contentHash 不同。
      // （若改指纹，旧回执会被 stale 分支以 exit 4 顺带拦下，测不到镜像对账失锚本身。）
      assert.equal(run(['gate'], { cwd: dir }).code, 0, 'gate#2 应跑通');
      const archives = findFiles(dir, /^\.kimi-base\/state\/ledger-archive-.+\.jsonl$/);
      assert.ok(archives.length >= 1, '前置：轮转必须已发生（存在归档段）');
      assert.ok(!readLedger(dir).some((entry) => entry.kind === 'verification'),
        '前置：当前段必须只剩 anchor（check 的账本条目全部归档），否则没测到失锚面');
      // 前置：未攻击时 verify 必须通过（链完好、镜像与全史尾一致、指纹 fresh）
      const fresh = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(fresh.code, 0, `前置：轮转后未攻击时 verify 应通过: ${out(fresh)}`);
      return { dir, oldMirror };
    };

    // 形态①：镜像回滚到归档里的旧回执（旧 contentHash 在归档历史中、不是全史尾）。
    {
      const { dir, oldMirror } = rotatedMirrors();
      write(dir, '.kimi-base/state/receipts/static-ok.json', oldMirror);
      // 锁定（F1 形态①）：镜像对账必须走全史——旧回执哈希在史而非全史尾 → DRIFT/TAMPERED
      // exit 2（旧缺陷：对账锚点只扫当前段，全部归档后 tail 缺失整体 continue，回滚无人对账）。
      const rolled = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(rolled.code, 2,
        `镜像回滚到归档旧回执必须 exit 2（轮转不得削弱镜像校验），实得 ${rolled.code}\n${out(rolled)}`);
      assert.match(out(rolled), /DRIFT|TAMPERED/, `回滚必须报 DRIFT/TAMPERED\n实际输出：${out(rolled)}`);
      assert.match(out(rolled), /static-ok/, `报文必须点名被回滚的检查\n实际输出：${out(rolled)}`);
    }

    // 形态②：凭空伪造镜像（status/summary 与任何账本条目不符 + 重修 contentHash 自洽）。
    {
      const { dir } = rotatedMirrors();
      rehashReceiptFile(path.join(dir, '.kimi-base', 'state', 'receipts', 'static-ok.json'), (receipt) => {
        receipt.status = 'FAIL';
        receipt.summary = 'FABRICATED after rotation';
      });
      // 锁定（F1 形态②）：同上——失锚后字段级对账仍须执行，字段与全史尾不一致 → TAMPERED exit 2。
      const forged = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(forged.code, 2,
        `失锚后凭空伪造镜像必须判篡改 exit 2，实得 ${forged.code}\n${out(forged)}`);
      assert.match(out(forged), /TAMPERED/, `伪造镜像必须报 TAMPERED\n实际输出：${out(forged)}`);
      assert.match(out(forged), /static-ok/, `报文必须点名被伪造的检查\n实际输出：${out(forged)}`);
    }
  });
});

describe('REQ-054 P4 三轮缺陷回归：当前段尾部截断失声', RT, () => {
  test('deferred 尾行被删（链仍是合法前缀）→ verify 必须 exit 2 判篡改且 risk 仍报 FAST_MODE_DEBT', (t) => {
    if (!needGit(t)) return;
    const dir = gateFixture(t, [DEFERRABLE_CHECK]);
    assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
    const g = run(['gate'], { cwd: dir });
    assert.match(out(g), /SKIPPED static-ok/, '前置：窗口内检查必须已被跳过（债已发生）');
    const LEDGER = '.kimi-base/state/ledger.jsonl';
    const before = readLedger(dir);
    assert.equal(before.at(-1).kind, 'deferred',
      '前置：账本尾行必须是 deferred 债务条目（无镜像、无长度锚的失声面）');
    // 前置：截断前 verify 通过、risk 报债（否则后续断言为空真）
    assert.equal(run(['receipt', 'verify'], { cwd: dir }).code, 0, '前置：截断前 verify 应通过');
    assert.match(out(run(['risk', 'scan'], { cwd: dir })), /FAST_MODE_DEBT/,
      '前置：截断前 risk 必须已报 FAST_MODE_DEBT');
    // 攻击：删尾行（同 sed -i '$ d'）——剩余链仍是合法前缀，现行链校验无从发现。
    write(dir, LEDGER, `${read(dir, LEDGER).split('\n').filter(Boolean).slice(0, -1).join('\n')}\n`);
    // 锁定（F2）：引擎必须能检测尾部截断（head 锚文件对账链尾+条目数）→ exit 2 判篡改
    // （旧缺陷：前缀链合法、deferred 无镜像、无长度锚 → verify 报「链：完好」exit 0）。
    const verify = run(['receipt', 'verify'], { cwd: dir });
    assert.equal(verify.code, 2,
      `尾部截断（deferred 尾行被删）必须 exit 2，实得 ${verify.code}\n${out(verify)}`);
    assert.match(out(verify), /TAMPERED|BROKEN/, `尾部截断必须报 TAMPERED/BROKEN\n实际输出：${out(verify)}`);
    assert.match(out(verify), /截断|锚|head|链尾/i, `报文必须点名尾部截断/锚对账\n实际输出：${out(verify)}`);
    // 锁定（F2 债务面）：截断不得清债——risk 必须仍报 FAST_MODE_DEBT（失声 = 删账即免债的未声明路径）。
    const risk = run(['risk', 'scan'], { cwd: dir });
    assert.match(out(risk), /FAST_MODE_DEBT/,
      `尾部截断不得清债：risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(risk)}`);
  });
});

// ---------------- P4 四轮评审 error 级缺陷回归锁（REQ-054 目标语义；红测先行随修复转绿） ----------------
//
// 缺陷锚点（P4 四轮评审发现，修复语义逐条在用例处注释）：
//   G1 head 锚缺失无新旧账本判别器（ledger.mjs reconcileLedgerHead）：「无锚=降级 note」对任何
//      账本生效——rm ledger-head.json + 尾部截断 deferred 即绕过整个 F2 保护（verify exit 0
//      仅 note、risk 无声）。目标（定案）：账本内含 v2 绑定键（policyHash/engineHash/catalogHash）
//      或 kind=deferred 条目的必出自带锚引擎——此类账本无锚即 TAMPERED exit 2；只有纯 v1 旧账本
//      （全无 v2 键且无 deferred）缺锚才维持降级 note。

describe('REQ-054 P4 四轮缺陷回归：head 锚缺失的新旧账本判别', RT, () => {
  test('含 deferred/v2 键的账本 rm 锚 + 删尾行 → verify exit 2 且 risk 仍报债；纯 v1 账本无锚 → 降级 note 不判篡改', (t) => {
    if (!needGit(t)) return;
    const HEAD = '.kimi-base/state/ledger-head.json';
    const LEDGER = '.kimi-base/state/ledger.jsonl';

    // 攻击面：fast 造债（deferred 尾行 + head 锚）→ rm 锚 + 删尾行，绕过 F2 全套保护。
    {
      const dir = gateFixture(t, [DEFERRABLE_CHECK]);
      assert.equal(run(['fast', 'on'], { cwd: dir }).code, 0, 'fast on 应成功');
      const g = run(['gate'], { cwd: dir });
      assert.match(out(g), /SKIPPED static-ok/, '前置：窗口内检查必须已被跳过（债已发生）');
      assert.ok(exists(dir, HEAD), '前置：带锚引擎必须已写 head 锚');
      assert.equal(readLedger(dir).at(-1).kind, 'deferred', '前置：账本尾行必须是 deferred 债务条目');
      assert.equal(run(['receipt', 'verify'], { cwd: dir }).code, 0, '前置：攻击前 verify 应通过');
      assert.match(out(run(['risk', 'scan'], { cwd: dir })), /FAST_MODE_DEBT/,
        '前置：攻击前 risk 必须已报 FAST_MODE_DEBT');
      // 攻击：连锚带尾一起抹——剩余链仍是合法前缀，锚缺失按「旧账本」降级放行。
      fs.rmSync(path.join(dir, HEAD));
      write(dir, LEDGER, `${read(dir, LEDGER).split('\n').filter(Boolean).slice(0, -1).join('\n')}\n`);
      // 锁定（G1）：含 deferred/v2 键的账本不可能出自无锚旧引擎——缺锚即锚被删除（灭迹），
      // 必须 TAMPERED exit 2；截断不得清债——risk 仍报 FAST_MODE_DEBT（旧缺陷：「无锚=note」
      // 无新旧判别，灭迹 exit 0 仅 note，锚快照兜底因 head=null 失效）。
      const verify = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(verify.code, 2,
        `带 v2/deferred 账本缺 head 锚必须判篡改 exit 2（锚被删 = 灭迹），实得 ${verify.code}\n${out(verify)}`);
      assert.match(out(verify), /TAMPERED|BROKEN/, `缺锚灭迹必须报 TAMPERED/BROKEN\n实际输出：${out(verify)}`);
      assert.match(out(verify), /锚|head|截断/i, `报文必须点名锚缺失/截断\n实际输出：${out(verify)}`);
      const risk = run(['risk', 'scan'], { cwd: dir });
      assert.match(out(risk), /FAST_MODE_DEBT/,
        `连锚带尾灭迹不得清债：risk 必须仍报 FAST_MODE_DEBT\n实际输出：${out(risk)}`);
    }

    // 对照（回归锁定）：纯 v1 旧账本——全无 v2 绑定键、无 deferred——缺锚
    // 维持降级 note（不谎报篡改），exit 0。
    {
      const dir = gateFixture(t, [PASS_CHECK]); // 只取 git 仓骨架，不跑 gate（账本手工构造）
      // 测试侧独立构造合法 v1 链条目（与引擎 stableJson/chainLink 同算法；无 v2 三键）。
      const v1entry = {
        version: 1, kind: 'verification', id: 'rcpt-20260101000000-a1b2c3d4', checkId: 'static-ok',
        checkKind: 'static', risk: 'low', fingerprint: 'v1-legacy-fingerprint', status: 'PASS',
        createdAt: '2026-01-01T00:00:00.000Z'
      };
      v1entry.contentHash = crypto.createHash('sha256').update(stableJsonLocal(v1entry)).digest('hex');
      v1entry.chain = crypto.createHash('sha256').update(`GENESIS\0${v1entry.contentHash}`).digest('hex');
      write(dir, LEDGER, `${JSON.stringify(v1entry)}\n`);
      assert.ok(!exists(dir, HEAD), '前置：纯 v1 账本无 head 锚（特性前旧账本形态）');
      const verify = run(['receipt', 'verify'], { cwd: dir });
      assert.equal(verify.code, 0, `纯 v1 旧账本缺锚不得判失败（不谎报），实得 ${verify.code}\n${out(verify)}`);
      assert.doesNotMatch(out(verify), /TAMPERED/, '纯 v1 旧账本缺锚不得报 TAMPERED');
      assert.match(out(verify), /note/, '纯 v1 旧账本缺锚必须保留降级 note（可见，不静默）');
      assert.match(out(verify), /锚|ledger-head/i, `降级 note 必须点名 head 锚\n实际输出：${out(verify)}`);
    }
  });
});
