/**
 * tests/spec.test.mjs
 * 需求可判定性与追溯（spec lint / trace / spec view）、rules-audit、skills-lint、agents-lint
 * 的契约测试 + 本仓资产锚点测试。
 * 追溯：REQ-033（spec/trace）REQ-034（rules-audit）REQ-035（skills/agents-lint）REQ-067（planned 生命周期标记）REQ-069（认知标注四态）REQ-075（skills-lint 对话型工艺检查）。
 * 内容面资产锚点：REQ-070（派单第七字段 Business Context）REQ-071（交互深度四档）REQ-075（skill 工艺与去重）
 * ——三条均为 planned，字面引用触发 trace 的 PLANNED_HAS_TESTS 提示，属预期工作流（实现落地同 commit 摘除标记）。
 *
 * 运行：node --test tests/spec.test.mjs
 *
 * 纪律（同 harness.test.mjs）：临时 git 仓、断言退出码与 stdout 字段、不断言 stderr。
 * 夹具需求 id 一律拼接构造（'REQ-' + '201'），本仓 trace 不得把夹具 id 计为引用。
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

function mkdtemp(t, prefix = 'kimi-base-spec-') {
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

// ---------------- 夹具 ----------------

const reqId = (n) => 'REQ-' + String(n).padStart(3, '0');
const nfrId = (n) => 'NFR-' + String(n).padStart(3, '0');
const reqEntry = (id) => `- ${id} 当用户触发该场景时，系统必须完成 ${id} 对应的行为。\n  验收：测试引用该 id 并断言行为。`;
const nfrEntry = (id) => `- ${id} 系统必须满足 99.9 % 的可用性指标。\n  验收：测试引用该 id 并断言度量结果。`;
const ATTRIBUTES_LINE = '治理属性：resilience security safety privacy reliability。';

function writeHarness(dir, extra = {}) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1, ...extra }, null, 2));
}

/** spec 夹具：harness（spec 段指向 specs/ 目录）+ specs/*.md；git 提交 */
function specFixture(t, docs, { harnessExtra = {}, withGit = true } = {}) {
  const dir = mkdtemp(t);
  writeHarness(dir, {
    spec: { requirementDirs: ['specs'], testGlobs: ['tests/**'], minCoverage: 1.0 },
    ...harnessExtra,
  });
  for (const [rel, content] of Object.entries(docs)) write(dir, rel, content);
  if (withGit) gitInitCommit(dir);
  return dir;
}

// ---------------- spec lint（REQ-033） ----------------

describe('spec lint', RT, () => {
  test('非规范/无度量/占位符/缺验收 全部判 error（exit 1 并点名 code）', (t) => {
    const dir = specFixture(t, {
      // 第一个文件只有一条无规范词、无验收的需求（块=id 行起 14 行）→ NOT_NORMATIVE + NO_ACCEPTANCE
      'specs/a.md': `# 需求\n\n- ${reqId(101)} 系统支持登录。\n`,
      'specs/b.md': [
        '# 需求',
        '',
        `- ${nfrId(101)} 系统必须稳定运行。`, // NO_METRIC（无数字+单位）
        '  验收：测试引用该 id。',
        `- ${reqId(102)} 当导入时，系统必须完成导入。`,
        '  验收：TBD', // PLACEHOLDER
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /NOT_NORMATIVE/);
    assert.match(r.stdout, /NO_METRIC/);
    assert.match(r.stdout, /NO_ACCEPTANCE/);
    assert.match(r.stdout, /PLACEHOLDER/);
  });

  test('跨文件重复 id → DUPLICATE_ID；段名枚举里的 TODO 字样不算占位符', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': `# A\n\n${reqEntry(reqId(103))}\n`,
      'specs/b.md': `# B\n\n${reqEntry(reqId(103))}\n`,
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /DUPLICATE_ID/);

    const clean = specFixture(t, {
      'specs/a.md': `# A\n\n${reqEntry(reqId(104))}\n\n记忆段清单：Pinned/Decisions/TODO/In Progress/Done。\n`,
    });
    const ok = run(['spec', 'lint'], { cwd: clean });
    assert.equal(ok.code, 0, out(ok));
  });

  test('干净规格 exit 0；REQ 缺触发词只警告不拦', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${reqEntry(reqId(105))}\n${nfrEntry(nfrId(105))}\n\n${ATTRIBUTES_LINE}\n\n- ${reqId(106)} 系统必须幂等重放。\n  验收：测试引用该 id。\n`,
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.match(r.stdout, /NO_TRIGGER/, '无触发词的 REQ 应警告');
    assert.match(r.stdout, /声明需求 3 条/);
  });

  test('需求目录无文件 → exit 3；spec 段未知字段被配置校验拒绝（exit 1）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir, { spec: { requirementDirs: ['nope.md'], testGlobs: ['tests/**'], minCoverage: 1.0 } });
    const degraded = run(['spec', 'lint'], { cwd: dir });
    assert.equal(degraded.code, 3, out(degraded));

    const bad = mkdtemp(t);
    writeHarness(bad, { spec: { bogus: 1 } });
    const rejected = run(['spec', 'lint'], { cwd: bad });
    assert.equal(rejected.code, 1, out(rejected));
  });
});

// ---------------- trace（REQ-033） ----------------

describe('trace', RT, () => {
  test('覆盖门禁：verified/declared < minCoverage → exit 1 并点名未验证需求；补齐后 exit 0', (t) => {
    if (!needGit(t)) return;
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${reqEntry(reqId(201))}\n${reqEntry(reqId(202))}\n${nfrEntry(nfrId(201))}\n`,
    });
    write(dir, 'tests/a.test.mjs', `// 覆盖 ${reqId(201)} 与 ${nfrId(201)}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'cite one');

    const under = run(['trace'], { cwd: dir });
    assert.equal(under.code, 1, out(under));
    assert.match(under.stdout, /覆盖率 66\.7%/);
    assert.match(under.stdout, new RegExp(`未被测试引用的需求：${reqId(202)}`));

    write(dir, 'tests/b.test.mjs', `// 覆盖 ${reqId(202)}\n`);
    const full = run(['trace'], { cwd: dir });
    assert.equal(full.code, 0, out(full));
    assert.match(full.stdout, /覆盖率 100\.0%/);
  });

  test('代码/测试引用未声明 id → 悬空 exit 1；文档悬空只报告不拦', (t) => {
    if (!needGit(t)) return;
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${reqEntry(reqId(203))}\n`,
    });
    write(dir, 'tests/a.test.mjs', `// 覆盖 ${reqId(203)}\n`);
    write(dir, 'docs/note.md', `行文举例 ${reqId(999)}（文档悬空）。\n`);
    const docOnly = run(['trace'], { cwd: dir });
    assert.equal(docOnly.code, 0, out(docOnly));
    assert.match(docOnly.stdout, /文档悬空引用 1 处/);

    write(dir, 'src/code.js', `// 实现了 ${reqId(999)}\n`);
    const dangling = run(['trace'], { cwd: dir });
    assert.equal(dangling.code, 1, out(dangling));
    assert.match(dangling.stdout, new RegExp(`悬空引用[\\s\\S]*${reqId(999)} ← src/code\\.js`));
  });
});

// ---------------- spec view（REQ-033） ----------------

describe('spec view', RT, () => {
  test('--paths 只显引用落在该路径上的需求；--all 全量；预算外省略显式点名', (t) => {
    if (!needGit(t)) return;
    const docs = { 'specs/a.md': `# 需求\n\n${[201, 202, 203, 204, 205, 206].map((n) => reqEntry(reqId(n))).join('\n')}\n` };
    const dir = specFixture(t, docs);
    write(dir, 'src/a.js', `// 实现 ${reqId(201)}\n`);
    write(dir, 'tests/b.test.mjs', `// 覆盖 ${reqId(202)}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'wire refs');

    const filtered = run(['spec', 'view', '--paths', 'src/a.js'], { cwd: dir });
    assert.equal(filtered.code, 0, out(filtered));
    assert.match(filtered.stdout, new RegExp(`- ${reqId(201)} `));
    assert.doesNotMatch(filtered.stdout, new RegExp(`- ${reqId(202)} `));
    assert.match(filtered.stdout, /选中 1\/6 条/);

    const byTest = run(['spec', 'view', '--paths', 'tests/b.test.mjs'], { cwd: dir });
    assert.match(byTest.stdout, new RegExp(`- ${reqId(202)} .*—— .*测试验证：yes`));

    const all = run(['spec', 'view', '--all'], { cwd: dir });
    assert.match(all.stdout, /选中 6\/6 条/);
    assert.match(all.stdout, /测试验证：no/, '未被测试引用的需求必须如实标 no');

    const tight = run(['spec', 'view', '--all', '--budget', '200'], { cwd: dir });
    assert.equal(tight.code, 0, out(tight));
    assert.match(tight.stdout, /预算外显式省略 [1-5] 条：/, '预算装不下的条目必须逐条点名');
  });

  test('非 git 仓且无 --paths/--all → exit 3', (t) => {
    const dir = specFixture(t, { 'specs/a.md': `# 需求\n\n${reqEntry(reqId(207))}\n` }, { withGit: false });
    const r = run(['spec', 'view'], { cwd: dir });
    assert.equal(r.code, 3, out(r));
  });
});

// ---------------- rules-audit（REQ-034） ----------------

describe('rules-audit', RT, () => {
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

  test('三态分类计数：enforced / declared-prompt-only / unenforced；默认纯建议 exit 0', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, 'AGENTS.md', CONSTITUTION);
    const r = run(['rules-audit'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.match(r.stdout, /enforced 1 \/ 声明 prompt-only 1 \/ 无执法 1/, out(r));
    assert.match(r.stdout, /执法率 33\.3%/);
    assert.match(r.stdout, /RULE_UNENFORCED.*AGENTS\.md:7/);
  });

  test('rulesAudit.maxUnenforced 接线：超限 exit 1', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir, { rulesAudit: { maxUnenforced: 0 } });
    write(dir, 'AGENTS.md', CONSTITUTION);
    const r = run(['rules-audit'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
  });
});

// ---------------- skills-lint / agents-lint（REQ-035） ----------------

describe('skills-lint', RT, () => {
  const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

  test('name ≠ 目录名 → NAME_MISMATCH exit 1；description >500 → DESCRIPTION_TOO_LONG', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-code/skills/foo/SKILL.md', skill('bar', '当演示时使用。'));
    const mismatch = run(['skills-lint'], { cwd: dir });
    assert.equal(mismatch.code, 1, out(mismatch));
    assert.match(mismatch.stdout, /NAME_MISMATCH/);

    write(dir, '.kimi-code/skills/foo/SKILL.md', skill('foo', 'x'.repeat(501)));
    const tooLong = run(['skills-lint'], { cwd: dir });
    assert.equal(tooLong.code, 1, out(tooLong));
    assert.match(tooLong.stdout, /DESCRIPTION_TOO_LONG/);
  });

  test('重名 → DUPLICATE_SKILL；缺 SKILL.md → NO_SKILL_MD；合规 → exit 0', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-code/skills/foo/SKILL.md', skill('dup-name', '当演示时使用。'));
    write(dir, '.kimi-code/skills/bar/SKILL.md', skill('dup-name', '当演示时使用。'));
    const dup = run(['skills-lint'], { cwd: dir });
    assert.equal(dup.code, 1, out(dup));
    assert.match(dup.stdout, /DUPLICATE_SKILL/);

    const dir2 = mkdtemp(t);
    writeHarness(dir2);
    fs.mkdirSync(path.join(dir2, '.kimi-code', 'skills', 'empty'), { recursive: true });
    const missing = run(['skills-lint'], { cwd: dir2 });
    assert.equal(missing.code, 1, out(missing));
    assert.match(missing.stdout, /NO_SKILL_MD/);

    const dir3 = mkdtemp(t);
    writeHarness(dir3);
    write(dir3, '.kimi-code/skills/foo/SKILL.md', skill('foo', '当演示时使用。'));
    const ok = run(['skills-lint'], { cwd: dir3 });
    assert.equal(ok.code, 0, out(ok));
  });
});

// ---------------- skills-lint 对话型工艺（REQ-075，ADR-0012） ----------------

describe('skills-lint 对话型工艺', RT, () => {
  const skillBody = (name, body) => `---\nname: ${name}\ndescription: 当演示时使用。\n---\n\n${body}\n`;

  test('对话型 skill 缺「示例」节与「反例」节 → warning（SKILL_NO_EXAMPLES / SKILL_NO_ANTIPATTERNS），exit 0 不阻断', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-code/skills/product-spec-builder/SKILL.md', skillBody('product-spec-builder', '## 任务\n\n采集需求。'));
    const r = run(['skills-lint'], { cwd: dir });
    assert.equal(r.code, 0, `warning 坡道不得阻断：\n${out(r)}`);
    assert.match(r.stdout, /SKILL_NO_EXAMPLES/, out(r));
    assert.match(r.stdout, /SKILL_NO_ANTIPATTERNS/, out(r));
  });

  test('对话型 skill 具备示例节与反例节（含「常见错误」别名）→ 零工艺 warning', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-code/skills/arch-designer/SKILL.md', skillBody('arch-designer', '## 对话示例与反例\n\n**示例一**\n\n**反例**\n\n- × 错误 → 正确。'));
    write(dir, '.kimi-code/skills/bug-fixer/SKILL.md', skillBody('bug-fixer', '## 对话示例\n\n**示例一**\n\n## 常见错误\n\n- × 错误 → 正确。'));
    const r = run(['skills-lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SKILL_NO_EXAMPLES|SKILL_NO_ANTIPATTERNS/, out(r));
  });

  test('执行型 skill 不要求示例/反例节 → 零工艺 warning（既有行为不破）', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-code/skills/dev-builder/SKILL.md', skillBody('dev-builder', '## 目标\n\n实现纪律。'));
    const r = run(['skills-lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SKILL_NO_EXAMPLES|SKILL_NO_ANTIPATTERNS/, out(r));
  });

  test('本仓 6 个对话型 skill 全合规：REPO 上 skills-lint 零工艺 warning', (t) => {
    if (!RUNTIME_OK) {
      t.skip('runtime 未就绪，显式跳过');
      return;
    }
    const r = run(['skills-lint'], { cwd: REPO });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SKILL_NO_EXAMPLES|SKILL_NO_ANTIPATTERNS/, `本仓对话型 skill 必须全部具备示例与反例节：\n${out(r)}`);
  });

  test('围栏内假示例节不放行缺节 skill：「对话示例」仅在代码围栏内 → 仍报 SKILL_NO_EXAMPLES（P6 修复轮红测）', (t) => {
    // 红因（写测时点）：skillsLint 的标题收集不豁免代码围栏（scan.mjs 直接 split('\n') 全量匹配），
    // 围栏内模板片段的 `## 对话示例` 被当成真实章节，缺节 skill 被放行（SKILL_NO_EXAMPLES 缺失）。
    const dir = mkdtemp(t);
    writeHarness(dir);
    write(dir, '.kimi-code/skills/product-spec-builder/SKILL.md', skillBody('product-spec-builder',
      '## 任务\n\n采集需求。\n\n## 反例\n\n- × 错误 → 正确。\n\n引用模板片段：\n\n```markdown\n## 对话示例\n\n**示例一**\n```'));
    const r = run(['skills-lint'], { cwd: dir });
    assert.equal(r.code, 0, `warning 坡道不得阻断：\n${out(r)}`);
    assert.match(r.stdout, /SKILL_NO_EXAMPLES/, `围栏内的假示例节不得算数——缺节 skill 仍须报 SKILL_NO_EXAMPLES\n实际输出：${out(r)}`);
    assert.doesNotMatch(r.stdout, /SKILL_NO_ANTIPATTERNS/, `真实反例节在围栏外，不得误报\n实际输出：${out(r)}`);
  });
});

describe('agents-lint', RT, () => {
  test('根 AGENTS.md 缺失 → exit 1；>16000 字节 → exit 1；正常 → exit 0', (t) => {
    const dir = mkdtemp(t);
    writeHarness(dir);
    const missing = run(['agents-lint'], { cwd: dir });
    assert.equal(missing.code, 1, out(missing));
    assert.match(missing.stdout, /NO_ROOT_AGENTS/);

    write(dir, 'AGENTS.md', `# 宪法\n\n${'长'.repeat(17000)}\n`);
    const oversize = run(['agents-lint'], { cwd: dir });
    assert.equal(oversize.code, 1, out(oversize));
    assert.match(oversize.stdout, /ROOT_AGENTS_OVERSIZE/);

    write(dir, 'AGENTS.md', '# 宪法\n\n短小精悍。\n');
    const ok = run(['agents-lint'], { cwd: dir });
    assert.equal(ok.code, 0, out(ok));
  });
});

// ---------------- 本仓资产锚点与自托管 dogfood ----------------
// 以下用例读 REPO 本体（与 harness.test.mjs「plugin 资产自检」同模式），
// 为暂无行为测试的需求提供真实而最小的追溯锚点。

describe('资产锚点与 dogfood', () => {
  const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

  // REQ-001：仓库即插件（kimi.plugin.json 可解析且声明各面）
  test('kimi.plugin.json 声明 skills/commands/hooks/sessionStart', () => {
    const manifest = JSON.parse(readRepo('kimi.plugin.json'));
    assert.ok(manifest.hooks || manifest.commands || manifest.skills, `插件清单必须声明资产面：${Object.keys(manifest).join(',')}`);
  });

  // REQ-008：八角色 agents frontmatter 合规（name==文件名、description 必填）
  test('八个 custom agents frontmatter 全部合法', () => {
    const dir = path.join(REPO, '.kimi-code', 'agents');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    assert.deepEqual(files.map((f) => f.replace(/\.md$/, '')), [
      'code-reviewer', 'deployer', 'evolution-runner', 'feedback-observer',
      'implementer', 'progress-recorder', 'researcher', 'tester',
    ]);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(m, `${f} 必须有 frontmatter`);
      const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const description = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
      assert.equal(name, f.replace(/\.md$/, ''), `${f} name 必须等于文件名`);
      assert.ok(description, `${f} 缺 description`);
    }
  });

  // REQ-025：supervisor 无参 = 用法声明 + exit 1 + 明示"不是生产 init"
  test('supervisor 无参调用输出用法并 exit 1', () => {
    const r = spawnSync(process.execPath, [path.join(REPO, '.kimi-base', 'runtime', 'supervisor.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout ?? ''}${r.stderr ?? ''}`, /不是生产 init/);
  });

  // REQ-026/REQ-027/REQ-030：workflow skills 的硬规则锚点真实存在
  test('product-spec-builder 含签字闸；dev-planner 含无占位符；进化引擎含用户确认闸', () => {
    assert.match(readRepo('.kimi-code/skills/product-spec-builder/SKILL.md'), /签字/);
    assert.match(readRepo('.kimi-code/skills/dev-planner/SKILL.md'), /占位符/);
    assert.match(readRepo('.kimi-code/skills/evolution-engine/SKILL.md'), /确认/);
    assert.match(readRepo('.kimi-code/skills/feedback-writer/SKILL.md'), /occurrences/);
  });

  // NFR-001/NFR-004：治理引擎零第三方依赖、零网络模块（supervisor 健康探针是职责例外）
  test('引擎 import 100% 为 node: 内置或相对路径，且无网络模块', () => {
    const runtimeDir = path.join(REPO, '.kimi-base', 'runtime');
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.mjs')) files.push(p);
      }
    };
    walk(runtimeDir);
    assert.ok(files.length > 10, 'runtime 文件枚举异常');
    const networkModules = new Set(['node:http', 'node:https', 'node:net', 'node:dgram']);
    for (const file of files) {
      if (file.endsWith('supervisor.mjs')) continue; // 职责内唯一网络例外（健康探针）
      const text = fs.readFileSync(file, 'utf8');
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${path.basename(file)} 引入非内置依赖：${spec}`);
        assert.ok(!networkModules.has(spec), `${path.basename(file)} 引入网络模块：${spec}`);
      }
    }
    const pkg = JSON.parse(readRepo('package.json'));
    assert.equal(pkg.dependencies, undefined, 'package.json 不得有运行时 dependencies');
  });

  // NFR-003：ps1 脚本 100% ASCII
  test('setup.ps1 为纯 ASCII', () => {
    const bytes = fs.readFileSync(path.join(REPO, 'setup.ps1'));
    for (const b of bytes) assert.ok(b < 128, `setup.ps1 含非 ASCII 字节 ${b}`);
  });

  // REQ-004/REQ-005 + REQ-033/034/035 + REQ-032 的 dogfood：本仓门禁自检全绿
  test('本仓自检：doctor / pack-check / spec lint / trace / rules-audit / skills-lint / agents-lint / recap / invariants', (t) => {
    if (!RUNTIME_OK) {
      t.skip('runtime 未就绪，显式跳过');
      return;
    }
    for (const args of [['doctor', '.'], ['pack-check'], ['spec', 'lint'], ['trace'], ['rules-audit'], ['skills-lint'], ['agents-lint'], ['recap'], ['invariants']]) {
      const r = run(args, { cwd: REPO });
      assert.equal(r.code, 0, `本仓 ${args.join(' ')} 必须 exit 0：\n${out(r)}`);
    }
  });
});

// ---------------- 需求生命周期标记 planned（REQ-067） ----------------

describe('需求生命周期标记 planned', RT, () => {
  /** planned 需求条目：reqEntry 的块内（id 行起 14 行窗口内）补一行状态标记。 */
  const plannedEntry = (id, status) => `${reqEntry(id)}\n  状态：${status}`;

  /** trace 的 planned 统计走 stdout JSON（规格契约）：整体解析失败时退回内嵌 JSON 对象。 */
  const parseTraceJson = (r) => {
    try { return JSON.parse(r.stdout); } catch { /* 退回内嵌 JSON 块 */ }
    const start = r.stdout.indexOf('{');
    const end = r.stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(r.stdout.slice(start, end + 1)); } catch { /* 无 JSON */ }
    }
    return null;
  };

  test('spec lint：合法 planned 标记（半角 planned(P3) 与全角 planned（P2.1））→ exit 0', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${plannedEntry(reqId(301), 'planned(P3)')}\n${plannedEntry(reqId(302), 'planned（P2.1）')}\n\n${ATTRIBUTES_LINE}\n`,
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
  });

  test('spec lint：planned 无可解析 phase 编号（裸 planned / 空括号）→ PLANNED_NO_PHASE exit 1', (t) => {
    for (const status of ['planned', 'planned()']) {
      const dir = specFixture(t, {
        'specs/a.md': `# 需求\n\n${plannedEntry(reqId(303), status)}\n`,
      });
      const r = run(['spec', 'lint'], { cwd: dir });
      assert.equal(r.code, 1, `状态：${status} 必须判 error：\n${out(r)}`);
      assert.match(r.stdout, /PLANNED_NO_PHASE/, out(r));
    }
  });

  test('spec lint：planned 不免除可判定性——缺规范关键词照判 NOT_NORMATIVE', (t) => {
    const dir = specFixture(t, {
      // 无 必须/不得/应当，也无验收行；planned 不是写烂需求的许可证
      'specs/a.md': `# 需求\n\n- ${reqId(304)} 系统支持登录。\n  状态：planned(P3)\n`,
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /NOT_NORMATIVE/);
  });

  test('trace：active 有引用 + planned 无引用 → exit 0、coverage=1、planned 计数=1', (t) => {
    if (!needGit(t)) return;
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${reqEntry(reqId(401))}\n${plannedEntry(reqId(402), 'planned(P3)')}\n`,
    });
    write(dir, 'tests/a.test.mjs', `// 覆盖 ${reqId(401)}\n`);
    const r = run(['trace'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const json = parseTraceJson(r);
    assert.ok(json, `trace stdout 必须含 planned 统计的 JSON 输出：\n${out(r)}`);
    assert.equal(json.coverage, 1, out(r));
    assert.equal(json.planned, 1, out(r));
  });

  test('trace：全部 REQ 均 planned（0 条 active）→ exit 0 且 coverage=1（零 active 为空真）', (t) => {
    if (!needGit(t)) return;
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${plannedEntry(reqId(403), 'planned(P3)')}\n${plannedEntry(reqId(404), 'planned(P1)')}\n`,
    });
    const r = run(['trace'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const json = parseTraceJson(r);
    assert.ok(json, `trace stdout 必须含 planned 统计的 JSON 输出：\n${out(r)}`);
    assert.equal(json.coverage, 1, out(r));
    assert.equal(json.planned, 2, out(r));
  });

  test('trace：planned REQ 被 tests/ 引用 → exit 0 但输出警告 PLANNED_HAS_TESTS', (t) => {
    if (!needGit(t)) return;
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${plannedEntry(reqId(405), 'planned(P3)')}\n`,
    });
    write(dir, 'tests/a.test.mjs', `// 覆盖 ${reqId(405)}\n`);
    const r = run(['trace'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.match(r.stdout, /PLANNED_HAS_TESTS/, out(r));
  });

  test('trace：active 无引用照判 exit 1 且只点名 active；planned 不计入未验证（既有行为回归）', (t) => {
    if (!needGit(t)) return;
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${reqEntry(reqId(406))}\n${plannedEntry(reqId(407), 'planned(P3)')}\n`,
    });
    const r = run(['trace'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, new RegExp(`未被测试引用的需求：[^\\n]*${reqId(406)}`), out(r));
    assert.doesNotMatch(r.stdout, new RegExp(`未被测试引用的需求：[^\\n]*${reqId(407)}`), out(r));
  });
});

// ---------------- 认知标注四态（REQ-069，ADR-0012） ----------------

describe('认知标注四态', RT, () => {
  // 夹具条款正文刻意避开 spec lint 其他规则雷区：不含占位词（TBD/待补充等）、
  // 不含歧义词表词条；条款均在 REQ 块之外，不受可判定性检查影响。

  test('二级标题「现状与假设」节内合法四态（含数字条款与 fence 豁免）→ exit 0 无 SPEC_ 告警', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [确认] 目标平台为 Linux，来源为 2026-09-01 用户访谈纪要。',
        '1. [推断] 团队规模在十人以内，依据：仓库近一年提交者名单共七人。',
        '- [建议] 首版只交付只读视图，理由是降低首发风险。',
        '- [未知] 结算币种规则未明，确认：由财务负责人在评审会答复。',
        '',
        '```',
        '- 示例片段里的无标签列表行不构成条款（fence 豁免）',
        '```',
        '',
        '## 需求清单',
        '',
        reqEntry(reqId(501)),
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_UNLABELED|SPEC_LABEL_NO_BASIS|SPEC_LABEL_NO_VERIFY_PATH/, out(r));
  });

  test('三级标题「现状与假设」节内 [推断] 条款无依据 → SPEC_LABEL_NO_BASIS exit 1', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '### 现状与假设',
        '',
        '- [推断] 团队偏好异步评审而非会议评审。',
        '',
        reqEntry(reqId(502)),
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_BASIS/, out(r));
  });

  test('[未知] 条款无确认途径 → SPEC_LABEL_NO_VERIFY_PATH exit 1', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [未知] 第三方计费接口的限流策略尚不明朗。',
        '',
        reqEntry(reqId(503)),
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_VERIFY_PATH/, out(r));
  });

  test('未标条款按推断论处 → exit 0 但有 SPEC_UNLABELED warning；下一同级标题结束检查面', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- 部署频率目前大约每周一次。',
        '',
        '## 需求清单',
        '',
        '- 节外的无标签列表行不构成现状与假设条款。',
        '',
        reqEntry(reqId(504)),
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const hits = r.stdout.match(/SPEC_UNLABELED/g) ?? [];
    assert.equal(hits.length, 1, `节外列表行不得计入：\n${out(r)}`);
  });

  test('无「现状与假设」节 → 不检查，exit 0 零 SPEC_ 输出（存量零回归）', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': `# 需求\n\n${reqEntry(reqId(505))}\n\n${ATTRIBUTES_LINE}\n`,
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_UNLABELED|SPEC_LABEL_/, out(r));
  });
});

// ---------------- 认知标注四态·评审修复（REQ-069 第二轮，红蓝评审 FIX_REQUIRED 驱动） ----------------

describe('认知标注四态·评审修复', RT, () => {
  test('标签 token 自包含不算确认途径：[未知] 条款的"确认"只来自 [确认] 标签本身 → SPEC_LABEL_NO_VERIFY_PATH exit 1', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        // 「确认」二字只出现在 [确认] 标签 token 内；剥离标签后条款无任何确认途径
        '- [未知] 结算币种规则未明，本节另有[确认]条款演示标签形态。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_VERIFY_PATH/, out(r));
  });

  test('URL 里的"依据："不豁免推断条款：依据判定前先剥离 URL → SPEC_LABEL_NO_BASIS exit 1', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [推断] 会话超时时长约三十分钟，详见 https://example.com/wiki/依据：session 页面。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_BASIS/, out(r));
  });

  test('同条款 ≥2 个认知标签 → SPEC_LABEL_MULTI error exit 1（恰好一个，多标签等于没表态）', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [确认] [推断] 团队规模为七人，依据：近一年提交者名单。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_MULTI/, out(r));
  });

  test('~~~ 波浪 fence 与 ``` 同等豁免：fence 内无标签列表行不触发 SPEC_UNLABELED', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '~~~',
        '- 波浪 fence 内的无标签列表演示行不构成条款',
        '~~~',
        '',
        '- [确认] 目标平台为 Linux，来源为 2026-09-01 用户访谈纪要。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_UNLABELED/, out(r));
  });

  test('节标题精确匹配：「## 附录：现状与假设标注规则」是提及不是开节，其内条款不检查', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 附录：现状与假设标注规则',
        '',
        '- 本节说明标签用法，不是现状与假设节，此处的无标签列表行不受检查。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_UNLABELED/, out(r));
  });
});

// ---------------- 认知标注四态·终审修复（REQ-069 第三轮，终审 FIX_REQUIRED 驱动） ----------------

describe('认知标注四态·终审修复', RT, () => {
  test('带节号前缀的标题（## 3. 现状与假设（认知标注），模板形态）必须开节并检查', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 3. 现状与假设（认知标注）',
        '',
        '- [推断] 团队偏好异步评审而非会议评审。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_BASIS/, out(r));
  });

  test('URL 后接全角逗号与真依据不误报：「参考 https://x，依据：…」exit 0 零 SPEC_ 输出', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [推断] 重试上限为三次，参考 https://example.com/retry-policy，依据：SRE 访谈记录。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_LABEL_NO_BASIS|SPEC_UNLABELED/, out(r));
  });

  test('「确认率」裸子串不算确认途径：确认途径须结构化（确认：/由…确认/确认途径）', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [未知] 确认率待提升。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_VERIFY_PATH/, out(r));
  });

  test('fence 混用：``` 开 ~~~ 闭不关节（fence 内无标签行不误报）', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '```',
        '- 反引号 fence 内的无标签行',
        '~~~',
        '- 波浪行不关反引号 fence，此行仍在 fence 内',
        '```',
        '',
        '- [确认] 目标平台为 Linux，来源为 2026-09-01 用户访谈纪要。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_UNLABELED/, out(r));
  });

  test('fence 长度：~~~~ 内嵌 ``` 不误关（闭 fence 必须同字符且长度 ≥ 开）', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '~~~~',
        '```',
        '- 四波浪 fence 内嵌三反引号，此行仍在 fence 内',
        '~~~~',
        '',
        '- [确认] 目标平台为 Linux，来源为 2026-09-01 用户访谈纪要。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_UNLABELED/, out(r));
  });
});

// ---------------- 认知标注四态·确认途径口径放宽（REQ-069 第四轮，终审 warning 驱动） ----------------

describe('认知标注四态·确认途径口径', RT, () => {
  test('责任方+场合齐备的确认途径（由…答复）不报 error：「由财务负责人在评审会答复」exit 0', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [未知] 结算币种规则，由财务负责人在评审会答复。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(r.stdout, /SPEC_LABEL_NO_VERIFY_PATH/, out(r));
  });

  test('放宽不赦免裸子串：「确认率待提升」仍报 SPEC_LABEL_NO_VERIFY_PATH（回归锁）', (t) => {
    const dir = specFixture(t, {
      'specs/a.md': [
        '# 需求',
        '',
        '## 现状与假设',
        '',
        '- [未知] 确认率待提升。',
        '',
      ].join('\n'),
    });
    const r = run(['spec', 'lint'], { cwd: dir });
    assert.equal(r.code, 1, out(r));
    assert.match(r.stdout, /SPEC_LABEL_NO_VERIFY_PATH/, out(r));
  });
});

// ---------------- 内容面资产锚点（REQ-070 / REQ-071 / REQ-075） ----------------
// 三条均为 planned：断言全部指向仓内真实交付内容（本仓即被测对象），
// 为内容面交付提供可机器核查的验收证据。红 = 交付内容缺斤短两，如实报告。

describe('资产锚点：内容面（REQ-070/071/075）', () => {
  const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

  /** 从单源 .kimi-base/rules/dispatch-contract.md「派单包七字段」节解析有序字段名（剥离括号注）。 */
  const dispatchFields = () => {
    const text = readRepo('.kimi-base/rules/dispatch-contract.md');
    const section = text.match(/## 派单包七字段[\s\S]*?(?=\n## )/);
    assert.ok(section, 'dispatch-contract.md 缺「派单包七字段」节');
    return [...section[0].matchAll(/^\d+\.\s+\*\*([^*：:]+)\*\*/gm)]
      .map((m) => m[1].split(/[（(]/)[0].trim());
  };

  // REQ-070 派单第七字段：七字段单源定义完整，且第七字段为 Business Context
  test('REQ-070：dispatch-contract.md 七字段单源定义齐备，第七字段为 Business Context', () => {
    assert.deepEqual(dispatchFields(), [
      'Goal', 'Scope', 'Out of Scope', 'Existing Pattern', 'Verification', 'Escalation', 'Business Context',
    ], '派单包七字段单源定义漂移');
  });

  // REQ-070：8 个 agent 输入契约段字段名与单源逐一对账（字段名从单源解析，不另写副本）
  test('REQ-070：全部 8 个 agent 的输入契约段逐字段含单源七字段名', () => {
    const fields = dispatchFields();
    const dir = path.join(REPO, '.kimi-code', 'agents');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    assert.equal(files.length, 8, `agents 数量漂移：${files.join(',')}`);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const section = text.match(/## 输入契约[^\n]*\n[\s\S]*?(?=\n## )/);
      assert.ok(section, `${f} 缺输入契约段`);
      for (const field of fields) {
        assert.ok(section[0].includes(`**${field}**`), `${f} 输入契约缺单源字段「${field}」`);
      }
    }
  });

  // REQ-070 需求存疑回流：三个交付侧 skill 各含「需求存疑」回流节（标题级匹配）
  test('REQ-070：code-review/bug-fixer/test-builder 各含「需求存疑」回流节标题', () => {
    for (const skill of ['code-review', 'bug-fixer', 'test-builder']) {
      const text = readRepo(`.kimi-code/skills/${skill}/SKILL.md`);
      assert.match(text, /^## .*需求存疑/m, `${skill} 缺「需求存疑」回流节标题`);
    }
  });

  // REQ-071 交互四档：workflow.md 含四档定义与「问过的不再问」
  test('REQ-071：workflow.md 含直推/确认/探索/委托四档定义与「问过的不再问」', () => {
    const text = readRepo('.kimi-base/rules/workflow.md');
    assert.match(text, /交互深度四档/, 'workflow.md 缺「交互深度四档」节');
    for (const tier of ['直推档', '确认档', '探索档', '委托档']) {
      assert.ok(text.includes(tier), `workflow.md 缺「${tier}」定义`);
    }
    assert.match(text, /问过的不再问/, 'workflow.md 缺「问过的不再问」澄清持久化规则');
  });

  // REQ-071 单源：templates/AGENTS.md 引用 workflow.md，不含第二份逐字四档定义
  test('REQ-071：templates/AGENTS.md 引用 workflow.md 且不复制四档定义（单源）', () => {
    const text = readRepo('.kimi-base/templates/AGENTS.md');
    assert.ok(text.includes('.kimi-base/rules/workflow.md'), 'templates/AGENTS.md 必须引用 workflow.md 单源');
    for (const tier of ['直推档', '确认档', '探索档', '委托档']) {
      assert.ok(!text.includes(tier), `templates/AGENTS.md 出现「${tier}」——四档定义被复制，违反单源`);
    }
  });

  // REQ-075 工艺：6 个对话型 skill 各含「对话示例」与反例节（≥2 个示例 + 反例行）
  test('REQ-075：6 个对话型 skill 各含「对话示例」节（≥2 个多轮示例）与反例', () => {
    const dialogSkills = ['product-spec-builder', 'arch-designer', 'dfx-designer', 'dev-planner', 'bug-fixer', 'code-review'];
    for (const skill of dialogSkills) {
      const text = readRepo(`.kimi-code/skills/${skill}/SKILL.md`);
      const heading = text.match(/^## .*对话示例.*$/m);
      assert.ok(heading, `${skill} 缺「对话示例」节标题`);
      const rest = text.slice(heading.index + heading[0].length);
      const next = rest.search(/^## /m);
      const section = next === -1 ? rest : rest.slice(0, next);
      const examples = section.match(/\*\*示例/g) ?? [];
      assert.ok(examples.length >= 2, `${skill} 对话示例不足 2 个（实得 ${examples.length}）`);
      assert.match(section, /^- ×/m, `${skill} 对话示例节缺反例行（- × ……）`);
    }
  });

  // REQ-075 工艺：dev-builder 含「反合理化清单」
  test('REQ-075：dev-builder 含「反合理化清单」节', () => {
    assert.match(readRepo('.kimi-code/skills/dev-builder/SKILL.md'), /^## 反合理化清单/m);
  });

  // REQ-075 去重：意图路由表单源存在，两个引用方只引用不复制表本体
  test('REQ-075：意图路由表单源 rules/intent-routing.md 存在，引用方只引用不复制', () => {
    const routing = readRepo('.kimi-base/rules/intent-routing.md');
    assert.match(routing, /意图路由表/, 'rules/intent-routing.md 缺路由表本体');
    for (const rel of ['plugin/skills/kimi-base/SKILL.md', '.kimi-base/templates/AGENTS.md']) {
      const text = readRepo(rel);
      assert.ok(text.includes('.kimi-base/rules/intent-routing.md'), `${rel} 必须引用路由表单源`);
      assert.ok(!/^\|\s*意图\s*\|\s*Skill\s*\|/m.test(text), `${rel} 复制了路由表本体，违反单源`);
    }
  });
});
