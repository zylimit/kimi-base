/**
 * tests/memory.test.mjs
 * 记忆法动词（recap / invariants / archive / sync-check）与 sessionStart 注入的契约测试。
 * 追溯：REQ-028（项目记忆）REQ-029（三文件同步）REQ-032（记忆法动词）。
 *
 * 运行：node --test tests/memory.test.mjs
 *
 * 纪律（同 harness.test.mjs）：每条用例独立临时 git 仓；断言退出码与 stdout/文件字段，
 * 不断言 stderr 文本；环境无 git 时依赖 git 的用例显式 skip（不假绿）。
 * 夹具中的需求 id 一律用 'REQ-' + '001' 拼接构造，避免本仓 trace 把夹具 id 当真引用。
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

// ---------------- 基础辅助 ----------------

function mkdtemp(t, prefix = 'kimi-base-memory-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

function writeHarness(dir, extra = {}) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1, ...extra }, null, 2));
}

/** 标准记忆文件：各段条目数可知，供限量/裁剪断言 */
function writeProgress(dir, { doneEntries = 2, notesEntries = 1 } = {}) {
  const done = Array.from({ length: doneEntries }, (_, i) => `- 完成项${'一二三四五六七八九十'[i] ?? i}（${i === 0 ? '最新' : i === doneEntries - 1 ? '最旧' : '较早'}）`);
  const notes = Array.from({ length: notesEntries }, (_, i) => `- 备注${'甲乙丙丁'[i] ?? i}`);
  write(dir, 'progress.md', [
    '# 测试项目记忆',
    '',
    '## Pinned（必守铁律）',
    '',
    '1. 证据优先：只有绑定指纹的回执算质量通过。',
    '2. 绝不假绿：BLOCKED 不是通过。',
    '',
    '## Decisions（只追加，含被否方案与理由）',
    '',
    '- 2026-01-01 旧决策一（被否方案：A）。',
    '- 2026-01-02 旧决策二（被否方案：B）。',
    '- 2026-01-03 旧决策三（被否方案：C）。',
    '- 2026-01-04 旧决策四（被否方案：D）。',
    '- 2026-01-05 旧决策五（被否方案：E）。',
    '- 2026-01-06 最新决策六（被否方案：F）。',
    '',
    '## TODO',
    '',
    '- [P0][OPEN][#1] 紧急事项甲',
    '- [P1][OPEN][#2] 常规事项乙',
    '- [P2][OPEN][#3] 低优先事项丙',
    '',
    '## In Progress',
    '',
    '- 正在做事项丁',
    '',
    '## Done',
    '',
    ...done,
    '',
    '## Risks & Assumptions',
    '',
    '- 风险甲：假设字段稳定。',
    '',
    '## Notes',
    '',
    ...notes,
    '',
  ].join('\n'));
}

/** sync-check 夹具：harness + catalog（app 模块=src/**）+ progress.md + src/a.js，全部已提交 */
function syncFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({
    version: 1,
    modules: [{ id: 'app', root: 'src', paths: ['**'] }],
  }, null, 2));
  writeProgress(dir);
  write(dir, 'src/a.js', 'export const a = 1;\n');
  gitInitCommit(dir);
  return dir;
}

// ---------------- recap（REQ-032） ----------------

describe('recap', RT, () => {
  test('派生视图：现算 Position + 限量摘录 + 预算遵守且截断显式', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeProgress(dir);
    gitInitCommit(dir);

    const full = run(['recap'], { cwd: dir });
    assert.equal(full.code, 0, out(full));
    // 派生而非鹦鹉学舌：Position 来自 git/tasks/ledger 现算
    assert.match(full.stdout, /- 分支 \S+ @ [0-9a-f]{12}；未提交变更 0 个路径/, 'Position 应现算分支与脏树');
    assert.match(full.stdout, /活跃任务：无/, 'Position 应现算任务账本');
    assert.match(full.stdout, /最近 gate：从未运行/, 'Position 应现算账本');
    // 限量摘录：Pinned 进包；TODO P0/P1 分段；Decisions 取末 5（最新决策六在、旧决策一不在）
    assert.match(full.stdout, /证据优先：只有绑定指纹的回执算/);
    assert.match(full.stdout, /TODO P0\n- \[P0\]\[OPEN\]\[#1\] 紧急事项甲/);
    assert.match(full.stdout, /TODO P1\n- \[P1\]\[OPEN\]\[#2\] 常规事项乙/);
    assert.match(full.stdout, /最新决策六/);
    assert.doesNotMatch(full.stdout, /旧决策一/);
    assert.match(full.stdout, /完成项一（最新）/);

    const tight = run(['recap', '--budget', '400'], { cwd: dir });
    assert.equal(tight.code, 0, out(tight));
    assert.match(tight.stdout, /已截断/, '超预算必须显式标注截断');
    const body = tight.stdout.slice(tight.stdout.indexOf('\n') + 1).replace(/\n+$/, '');
    assert.ok(body.length <= 400, `正文 ${body.length} 字符不得突破 400 预算（截断注记也占预算）`);
    assert.match(tight.stdout, /400\/400 字符；已截断/, '状态行必须报告预算用尽且截断');
    assert.match(body, /\[recap 截断于 400 字符预算/, '截断注记必须在预算内');
  });

  test('缺 progress.md → exit 3（不假造记忆）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const r = run(['recap'], { cwd: dir });
    assert.equal(r.code, 3, out(r));
  });
});

// ---------------- invariants（REQ-032） ----------------

describe('invariants', RT, () => {
  test('≤1200 字符且自包含铁律+实时状态', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const r = run(['invariants'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.ok(r.stdout.length <= 1200, `invariants 全量输出 ${r.stdout.length} 字符必须 ≤1200`);
    assert.match(r.stdout, /证据优先/);
    assert.match(r.stdout, /活跃任务：无/);
    assert.match(r.stdout, /最近 gate：从未运行/);
  });

  test('反映 open fast 窗口（fast on 后摘要点名 FAST MODE）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const on = run(['fast', 'on', '2'], { cwd: dir });
    assert.equal(on.code, 0, out(on));
    const r = run(['invariants'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.match(r.stdout, /FAST MODE 开启至/, 'open fast 窗口必须出现在实时状态里');
    assert.ok(r.stdout.length <= 1200);
  });
});

// ---------------- archive（REQ-028/REQ-032） ----------------

describe('archive', RT, () => {
  test('dry-run 默认不落盘；--apply 移动最旧条目并留指针；归档只增不删', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    writeProgress(dir, { doneEntries: 5, notesEntries: 2 });
    const before = read(dir, 'progress.md');

    const dry = run(['archive', '--keep-done', '3'], { cwd: dir });
    assert.equal(dry.code, 0, out(dry));
    assert.match(dry.stdout, /dry-run/, '默认必须是 dry-run');
    assert.match(dry.stdout, /Done：共 5 条，保留最新 3 条，移动最旧 2 条/);
    assert.equal(read(dir, 'progress.md'), before, 'dry-run 不得改动 progress.md');
    assert.ok(!exists(dir, 'progress.archive.md'), 'dry-run 不得创建归档文件');

    const applied = run(['archive', '--apply', '--keep-done', '3'], { cwd: dir });
    assert.equal(applied.code, 0, out(applied));
    const live = read(dir, 'progress.archive.md');
    assert.match(live, /## Archived \d{4}-\d{2}-\d{2}/);
    assert.match(live, /### Done/);
    assert.match(live, /完成项四/, '最旧条目必须进归档');
    assert.match(live, /完成项五（最旧）/);
    assert.doesNotMatch(live, /完成项一（最新）/, '最新条目不得归档');
    const after = read(dir, 'progress.md');
    assert.match(after, /\[progress\.archive\.md\]\(progress\.archive\.md\)/, '活体文件必须留指针行');
    assert.doesNotMatch(after, /完成项五（最旧）/);
    assert.match(after, /完成项一（最新）/);
    const doneCount = after.split('\n').filter((line) => /^- 完成项/.test(line)).length;
    assert.equal(doneCount, 3, '归档后活体 Done 必须只剩 3 条');

    const again = run(['archive'], { cwd: dir });
    assert.equal(again.code, 0, out(again));
    assert.match(again.stdout, /nothing to archive/);
  });

  test('缺 progress.md → exit 3', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const r = run(['archive'], { cwd: dir });
    assert.equal(r.code, 3, out(r));
  });
});

// ---------------- sync-check（REQ-029） ----------------

describe('sync-check', RT, () => {
  test('治理代码动而 progress.md 不动 → MEMORY_BEHIND_CODE exit 1；成对变更通过', (t) => {
    if (!needGit(t)) return;
    const dir = syncFixture(t);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const b = 2;\n');
    const violation = run(['sync-check'], { cwd: dir });
    assert.equal(violation.code, 1, out(violation));
    assert.match(violation.stdout, /MEMORY_BEHIND_CODE/);

    fs.appendFileSync(path.join(dir, 'progress.md'), '\n- 记录本次改动。\n');
    const paired = run(['sync-check'], { cwd: dir });
    assert.equal(paired.code, 0, out(paired));
  });

  test('Product-Spec.md 动而 CHANGELOG 不动 → SPEC_WITHOUT_CHANGELOG exit 1；成对通过', (t) => {
    if (!needGit(t)) return;
    const dir = syncFixture(t);
    fs.writeFileSync(path.join(dir, 'Product-Spec.md'), '# spec\n\n新增需求。\n');
    const violation = run(['sync-check'], { cwd: dir });
    assert.equal(violation.code, 1, out(violation));
    assert.match(violation.stdout, /SPEC_WITHOUT_CHANGELOG/);

    fs.writeFileSync(path.join(dir, 'Product-Spec-CHANGELOG.md'), '# changelog\n\n记录。\n');
    const paired = run(['sync-check'], { cwd: dir });
    assert.equal(paired.code, 0, out(paired));
  });

  test('纯文档/未映射路径变更放行（docs-only pass）', (t) => {
    if (!needGit(t)) return;
    const dir = syncFixture(t);
    write(dir, 'docs/x.md', '# 文档\n');
    const r = run(['sync-check'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
  });

  test('--staged 只看暂存区；--paths 显式指定（含非 git 仓）', (t) => {
    if (!needGit(t)) return;
    const dir = syncFixture(t);
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'export const c = 3;\n');
    const unstaged = run(['sync-check', '--staged'], { cwd: dir });
    assert.equal(unstaged.code, 0, '未暂存时 --staged 变更面为空必须放行');
    git(dir, 'add', 'src/a.js');
    const staged = run(['sync-check', '--staged'], { cwd: dir });
    assert.equal(staged.code, 1, out(staged));
    assert.match(staged.stdout, /MEMORY_BEHIND_CODE/);

    const explicit = run(['sync-check', '--paths', 'src/a.js'], { cwd: dir });
    assert.equal(explicit.code, 1, out(explicit));
  });

  test('非 git 仓且无 --paths → exit 3（降级不假绿）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-base/module-catalog.json', JSON.stringify({ version: 1, modules: [{ id: 'app', root: 'src', paths: ['**'] }] }, null, 2));
    write(dir, 'src/a.js', 'export const a = 1;\n');
    const r = run(['sync-check'], { cwd: dir });
    assert.equal(r.code, 3, out(r));
  });
});

// ---------------- sessionStart 注入（REQ-032） ----------------

describe('sessionStart invariants 注入', RT, () => {
  const hook = (dir) => run(['hook', 'session-start'], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: 's1' }) });

  test('默认注入 invariants 摘要（含 fast 窗口实时状态）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    run(['fast', 'on', '2'], { cwd: dir });
    const r = hook(dir);
    assert.equal(r.code, 0, out(r));
    assert.match(r.stdout, /Invariants/);
    assert.match(r.stdout, /FAST MODE 开启至/, '注入摘要必须带 fast 窗口实时状态');
  });

  test('hooks.injectInvariants=false 时横幅不携带摘要', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir, { hooks: { injectInvariants: false } });
    const r = hook(dir);
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /Invariants/);
  });
});
