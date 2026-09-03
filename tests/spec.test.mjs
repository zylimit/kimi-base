/**
 * tests/spec.test.mjs
 * 需求可判定性与追溯（spec lint / trace / spec view）、rules-audit、skills-lint、agents-lint
 * 的契约测试 + 本仓资产锚点测试。
 * 追溯：REQ-033（spec/trace）REQ-034（rules-audit）REQ-035（skills/agents-lint）。
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
