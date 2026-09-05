/**
 * tests/discover.test.mjs
 * REQ-068（discover 真实仓健壮性）行为测试——红测先行于实现，P2 落地同 commit 追溯锚点转正（摘 planned 标记）。
 *
 * 覆盖四个缺陷（现场见 docs/LARGE-REPO-GUIDE.md §5 真实仓校准节）：
 *   1) 重复模块：目录分组（≥2 文件成组）丢弃的单文件深层组坠入顶层兜底，与既有同 root
 *      模块产出 paths 完全相同的两个模块（校准现场的 src 与 src-2）。
 *   2) 环不处理：互 import 的模块把循环边原样写进 dependsOn，catalog lint 随后 DFS 报环。
 *      目标：SCC 凝聚——同环模块合并为一个模块，合并事实写入 needsDecision，dependsOn 为 DAG。
 *   3) 断环/凝聚后 tier 必须在凝聚后的 DAG 上重算：tier-1=最内层（无依赖基础层，见
 *      discover.mjs 分层注释与 progress.md「discover 分层方向翻转」决策），依赖者层号更大；
 *      每条 dependsOn 边必须满足 tier(被依赖) <= tier(依赖者)，且无互相依赖的同层模块对。
 *   4) fitness --all 重复报告：--all 的扫描面是 tracked ∪ untracked 的字符串 Set 并集
 *      （fitness.mjs runFitness）， identical 路径串已被 Set 去重；残留向量是同一底层文件
 *      经两种路径形态进入扫描面（tracked 原路径 + 未跟踪软链/硬链别名），同一命中被报两次。
 *      目标：同一命中（同一底层文件同一行同一规则）只报一次。
 *   5) 回归守卫：无环普通仓 discover 行为不变（exit 0，草案字段齐全）。
 *
 * 运行：node --test tests/discover.test.mjs
 *
 * 纪律（同 scale.test.mjs / spec.test.mjs）：临时 git 仓、真实 CLI 子进程、断言退出码与
 * stdout 结构化字段、不断言 stderr；环境无 git 时显式 skip（不假绿）。
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

// 需求 id 一律拼接构造（见文件头追溯说明）。
const REQ = 'REQ-' + '068';

// ---------------- 基础辅助 ----------------

function mkdtemp(t, prefix = 'kimi-base-discover-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // 收尾删除在 CI 上有环境竞态：重试覆盖短时占用；最终失败则 diagnostic 留痕、
  // 残留交 OS 回收——清理失败不伪造测试结果。
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
      // 禁掉自动 gc/maintenance：后台写 .git 与收尾 rmSync 竞态（ENOTEMPTY）。
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

function writeHarness(dir, extra = {}) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1, ...extra }, null, 2));
}

/** 从 catalog discover dry-run stdout 提取 JSON 提案（首个 "\n{" 起；同 scale.test.mjs 口径） */
function proposalJson(r) {
  const index = r.stdout.indexOf('\n{');
  assert.ok(index > 0, `dry-run 输出应含 JSON 提案: ${r.stdout.slice(0, 200)}`);
  return JSON.parse(r.stdout.slice(index + 1));
}

/**
 * 重复模块夹具：顶层散文件（src/a.js、src/b.js → 目录分组成组 prefix=src）
 * + 单文件深层目录（src/deep/only.js → 组 size 1 被丢弃 → 坠入顶层兜底 rest['src']）。
 * 两条路径都产出 root=src 的模块，id 碰撞成 src 与 src-2（校准现场形态）。
 */
function duplicateModuleFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/a.js', 'export const a = 1;\n');
  write(dir, 'src/b.js', 'export const b = 2;\n');
  write(dir, 'src/deep/only.js', 'export const only = 3;\n');
  gitInitCommit(dir);
  return dir;
}

/**
 * 循环 import 夹具：alpha ↔ beta 互 import（SCC），gamma → alpha（环外入边，
 * 用于观察凝聚后的 tier 重算）。每目录两文件以满足「≥2 文件成组」。
 */
function cyclicFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/alpha/a1.js', 'import { b } from "../beta/b1.js";\nexport const a = b;\n');
  write(dir, 'src/alpha/a2.js', 'export const a2 = 1;\n');
  write(dir, 'src/beta/b1.js', 'import { a2 } from "../alpha/a2.js";\nexport const b = a2;\n');
  write(dir, 'src/beta/b2.js', 'export const b2 = 1;\n');
  write(dir, 'src/gamma/g1.js', 'import { a2 } from "../alpha/a2.js";\nexport const g = a2;\n');
  write(dir, 'src/gamma/g2.js', 'export const g2 = 1;\n');
  gitInitCommit(dir);
  return dir;
}

/**
 * 环内含公共前缀散文件成员的夹具：alpha ↔ beta 互 import，且顶层散文件组
 *（src/loose1.js + src/loose2.js → 模块 root=src）也在环内（loose1 → alpha、
 * beta → loose2）。凝聚后公共前缀 root=src 被该成员占满，paths 禁止退裸 ['**']
 * （红锁 REQ-068 路径吞并缺陷：校准现场 src/** 吞掉 9 个模块、overlap=68%）。
 */
function cyclicLooseMemberFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/loose1.js', 'import { a2 } from "./alpha/a2.js";\nexport const l1 = a2;\n');
  write(dir, 'src/loose2.js', 'export const l2 = 1;\n');
  write(dir, 'src/alpha/a1.js', 'import { b } from "../beta/b1.js";\nexport const a = b;\n');
  write(dir, 'src/alpha/a2.js', 'export const a2 = 1;\n');
  write(dir, 'src/beta/b1.js', 'import { l2 } from "../loose2.js";\nimport { a2 } from "../alpha/a2.js";\nexport const b = a2 + l2;\n');
  write(dir, 'src/beta/b2.js', 'export const b2 = 1;\n');
  write(dir, 'src/gamma/g1.js', 'import { a2 } from "../alpha/a2.js";\nexport const g = a2;\n');
  write(dir, 'src/gamma/g2.js', 'export const g2 = 1;\n');
  gitInitCommit(dir);
  return dir;
}

/** 回归守卫夹具：无环普通仓（app → core，真实 import 边） */
function acyclicFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }, null, 2));
  write(dir, 'src/core/util.js', 'export const util = () => "ok";\n');
  write(dir, 'src/core/store.js', 'export const store = {};\n');
  write(dir, 'src/app/index.js', 'import { util } from "../core/util.js";\nexport const app = util();\n');
  write(dir, 'src/app/main.js', 'export const main = 1;\n');
  gitInitCommit(dir);
  return dir;
}

// ---------------- 图断言辅助 ----------------

/** DFS 检环：返回找到的第一个环（节点 id 数组，首尾相接）或 null。未知依赖 id 忽略。 */
function findCycle(modules) {
  const graph = new Map(modules.map((m) => [m.id, (m.dependsOn ?? []).filter((d) => modules.some((x) => x.id === d))]));
  const state = new Map(); // 1=在栈 2=完成
  const stack = [];
  let cycle = null;
  const visit = (id) => {
    if (cycle) return;
    state.set(id, 1);
    stack.push(id);
    for (const next of graph.get(id) ?? []) {
      if (cycle) return;
      const s = state.get(next) ?? 0;
      if (s === 0) visit(next);
      else if (s === 1) { cycle = [...stack.slice(stack.indexOf(next)), next]; return; }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of graph.keys()) {
    if (cycle) break;
    if ((state.get(id) ?? 0) === 0) visit(id);
  }
  return cycle;
}

/** tier-N → N；非法层名返回 NaN（由调用方断言）。 */
function tierIndex(module) {
  const match = /^tier-(\d+)$/.exec(module.layer ?? '');
  return match ? Number(match[1]) : NaN;
}

/** 从 fitness stdout 解析发现行：`- error [rule] path:line message` */
function fitnessFindings(r) {
  const findings = [];
  const re = /^- (error|warning) \[([\w-]+)\] (\S+):(\d+) /gm;
  let match;
  while ((match = re.exec(r.stdout)) !== null) {
    findings.push({ severity: match[1], rule: match[2], path: match[3], line: Number(match[4]) });
  }
  return findings;
}

// ---------------- REQ 068 缺陷 1：重复模块 ----------------

describe(`${REQ} discover 重复模块`, RT, () => {
  test('draft 中任何两个模块不得共享相同 (root, paths)——单文件深层组坠兜底不得复制既有模块覆盖面', (t) => {
    if (!needGit(t)) return;
    const dir = duplicateModuleFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    assert.ok(modules.length >= 2, `夹具应产出 ≥2 个提案模块: ${JSON.stringify(modules.map((m) => m.id))}`);
    const seen = new Map();
    const duplicates = [];
    for (const m of modules) {
      const key = `${m.root}${JSON.stringify([...(m.paths ?? [])].sort())}`;
      if (seen.has(key)) duplicates.push([seen.get(key), m.id]);
      else seen.set(key, m.id);
    }
    assert.deepEqual(duplicates, [],
      `不得产出 (root, paths) 完全相同的重复模块（校准现场 src/src-2）: ${JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths })))}`);
  });
});

// ---------------- REQ 068 缺陷 2：环不处理（SCC 凝聚） ----------------

describe(`${REQ} discover 循环 import`, RT, () => {
  test('互 import 模块必须 SCC 凝聚：dependsOn 为无环 DAG，且 needsDecision 记录凝聚事实', (t) => {
    if (!needGit(t)) return;
    const dir = cyclicFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const cycle = findCycle(modules);
    assert.equal(cycle, null,
      `draft.dependsOn 必须是无环 DAG（SCC 凝聚后自环/互环消失），检出环: ${cycle ? cycle.join(' -> ') : ''}；`
      + `模块图: ${JSON.stringify(modules.map((m) => ({ id: m.id, dependsOn: m.dependsOn })))}`);
    const condensed = (proposal.needsDecision ?? []).some((d) =>
      /凝聚|SCC|强连通|环|cycle/i.test(`${d.field} ${d.why}`));
    assert.ok(condensed,
      `SCC 凝聚是草案对人工的欠债声明，必须写入 needsDecision: ${JSON.stringify(proposal.needsDecision?.map((d) => d.field))}`);
  });
});

// ---------------- REQ 068 缺陷 3：断环/凝聚后 tier 重算 ----------------

describe(`${REQ} discover 凝聚后 tier 重算`, RT, () => {
  test('凝聚后的 DAG 上每条 dependsOn 边层序一致（tier-1=最内层，依赖者层号更大），无同层互赖模块对', (t) => {
    if (!needGit(t)) return;
    const dir = cyclicFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const byId = new Map(modules.map((m) => [m.id, m]));
    for (const m of modules) {
      assert.ok(Number.isFinite(tierIndex(m)), `模块 ${m.id} 必须有合法 tier-N 层名: ${m.layer}`);
    }
    // 层向判定与引擎 arch 规则同向：只允许依赖同层或更内层（层号更小或相等）。
    const badEdges = [];
    for (const m of modules) {
      for (const dep of m.dependsOn ?? []) {
        const target = byId.get(dep);
        if (!target) continue;
        if (tierIndex(target) > tierIndex(m)) {
          badEdges.push(`${m.id}(${m.layer}) -> ${dep}(${target.layer})`);
        }
      }
    }
    assert.deepEqual(badEdges, [],
      `每条 dependsOn 边必须满足 tier(被依赖) <= tier(依赖者)（断环后 tier 须在 DAG 上重算）: ${badEdges.join(', ')}`);
    const mutualSameTier = [];
    for (const m of modules) {
      for (const dep of m.dependsOn ?? []) {
        const target = byId.get(dep);
        if (!target) continue;
        if ((target.dependsOn ?? []).includes(m.id) && tierIndex(target) === tierIndex(m)) {
          mutualSameTier.push(`${m.id} <-> ${dep}（同 ${m.layer}）`);
        }
      }
    }
    assert.deepEqual(mutualSameTier, [],
      `不得存在 tier 相同却互相依赖的模块对（互赖 = 环，必须凝聚为单模块）: ${mutualSameTier.join(', ')}`);
  });
});

// ---------------- REQ 068 红锁：凝聚模块在共享前缀下禁止裸 ** ----------------

describe(`${REQ} 凝聚模块 paths 吞并红锁`, RT, () => {
  test('环内含公共前缀散文件成员时，凝聚模块 paths 必须枚举成员子树与散文件，不得退裸 [**]', (t) => {
    if (!needGit(t)) return;
    const dir = cyclicLooseMemberFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    assert.equal(findCycle(modules), null, 'draft 必须无环');
    // 公共前缀 src 下还有 gamma 等环外模块 → 共享前缀 → 禁止裸 **。
    const condensed = modules.find((m) => m.root === 'src');
    assert.ok(condensed, `应存在凝聚模块（root=src）: ${JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths })))}`);
    assert.notDeepEqual([...(condensed.paths ?? [])].sort(), ['**'],
      `共享前缀 root=src 下裸 ** 会吞掉环外模块子树（校准现场 overlap=68%）: ${JSON.stringify(condensed.paths)}`);
    for (const expected of ['alpha/**', 'beta/**', 'loose1.js', 'loose2.js']) {
      assert.ok(condensed.paths.includes(expected),
        `凝聚模块 paths 必须枚举成员子树与散文件（缺 ${expected}）: ${JSON.stringify(condensed.paths)}`);
    }
    // 同 root 双模块是同深度 overlap 的结构性来源：root 必须全图唯一。
    const roots = modules.map((m) => m.root);
    assert.equal(new Set(roots).size, roots.length,
      `任何两个模块不得共享同一 root（同深度 tie 无法仲裁）: ${JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root })))}`);
  });
});

// ---------------- REQ 068 缺陷 4：fitness --all 重复报告 ----------------

describe(`${REQ} fitness --all 同一命中只报一次`, RT, () => {
  test('同一底层文件经 tracked 原路径 + 未跟踪链接别名两种形态进入扫描面，同一 (行,规则) 命中只报一次', (t) => {
    if (!needGit(t)) return;
    const dir = mkdtemp(t);
    writeHarness(dir);
    // no-secret-literal（error 级）：api_key = "8+ 字符" 必命中。
    // 病灶串按 harness.test.mjs 同款手法拼接构造：写入夹具仓的内容与逐字面形态完全
    // 一致，但本源文件不携带完整触发模式（本仓自身 fitness/dod 会扫 tests/）。
    write(dir, 'src/hit.js', 'const api_key = "abcdefg' + 'h123";\nmodule.exports = {};\n');
    gitInitCommit(dir);
    // 同一底层文件的第二种路径形态：未跟踪软链（Windows 无权限时退硬链；都失败显式 skip）。
    let aliasForm = 'symlink';
    try {
      fs.symlinkSync('src/hit.js', path.join(dir, 'dup-hit.js'));
    } catch {
      try {
        fs.linkSync(path.join(dir, 'src/hit.js'), path.join(dir, 'dup-hit.js'));
        aliasForm = 'hardlink';
      } catch (e) {
        t.skip(`环境不支持软链/硬链（${e.code ?? e.message}），按纪律显式跳过`);
        return;
      }
    }
    t.diagnostic(`别名形态: ${aliasForm}`);
    const r = run(['fitness', '--all'], { cwd: dir });
    assert.equal(r.code, 1, `error 级命中必须 exit 1: ${out(r)}`);
    const findings = fitnessFindings(r);
    // (file, line, rule) 三元组唯一（目标契约；字符串级去重）。
    const triples = findings.map((f) => `${f.path}:${f.line}:${f.rule}`);
    assert.equal(new Set(triples).size, triples.length,
      `(file,line,rule) 三元组必须唯一: ${JSON.stringify(findings)}`);
    // 同一命中（同一底层文件同一行同一规则，经 src/hit.js 或 dup-hit.js 报到）只许一次。
    const sameHit = findings.filter((f) =>
      f.rule === 'no-secret-literal' && f.line === 1 && (f.path === 'src/hit.js' || f.path === 'dup-hit.js'));
    assert.equal(sameHit.length, 1,
      `同一命中必须只报一次（tracked∪untracked 并集须按底层文件去重，而非仅路径字符串去重）: ${JSON.stringify(sameHit)}`);
  });
});

// ---------------- REQ 068 缺陷 5：回归守卫（应绿） ----------------

describe(`${REQ} 回归守卫：无环普通仓 discover 行为不变`, RT, () => {
  test('exit 0；draft 含 modules/dependsOn/tier(layer)/layers 与 needsDecision 字段', (t) => {
    if (!needGit(t)) return;
    const dir = acyclicFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const draft = proposal.draft;
    assert.ok(Array.isArray(draft.modules) && draft.modules.length >= 2, 'draft.modules 必须非空');
    const modules = new Map(draft.modules.map((m) => [m.id, m]));
    assert.ok(modules.has('app') && modules.has('core'), `应提案 app/core 模块: ${[...modules.keys()]}`);
    for (const m of draft.modules) {
      assert.ok(Array.isArray(m.dependsOn), `模块 ${m.id} 必须有 dependsOn 字段`);
      assert.ok(Number.isFinite(tierIndex(m)), `模块 ${m.id} 必须有 tier-N 层名: ${m.layer}`);
    }
    assert.deepEqual(modules.get('app').dependsOn, ['core'], 'app 的 dependsOn 应来自真实 import 边');
    assert.deepEqual(draft.layers, ['tier-1', 'tier-2'], '无环两层仓分层不变（tier-1=最内层）');
    assert.equal(modules.get('core').layer, 'tier-1', '无依赖基础模块是最内层 tier-1');
    assert.equal(modules.get('app').layer, 'tier-2', '依赖者层号更大');
    assert.equal(findCycle(draft.modules), null, '无环仓草案必须无环');
    assert.ok(Array.isArray(proposal.needsDecision) && proposal.needsDecision.length > 0,
      'needsDecision 必须存在且非空（猜不了的字段进 needsDecision）');
  });
});

// ---------------- REQ 068 P2 评审回归：occupant 让位 + 实边重扫（红测先行） ----------------
// 三个形态复刻自 P2 testing lens 评审实证现场（/tmp/kb-resplit-*、/tmp/kb-rootdot-*）：
//   6) occupant 让位触发重扫后：draft 残留 q-a↔w 环、W→散文件 G 的边错挂凝聚模块、
//      root=src/q 被凝聚模块与 occupant 双占（root 全图唯一不变量破）。
//   7) 跨顶层根互环（src↔lib）凝聚 root='.'，另一组环配 occupant 触发重扫后全图实边
//      归零——凝聚模块丢失 src→ext 真实边，"无环"沦为边全丢的假绿。
//   8) resplit 分支覆盖红锁：环公共前缀被环外散文件组占用时，让位产物必须无环、
//      root 全图唯一、occupant 散文件归属唯一模块。
// 写测时点当前实现三例全红；红因必须都是缺陷本身（环残留/边错归属/边丢失/root 撞车），
// 不是夹具或断言错误。

/** 路径覆盖判定：模块 paths（相对 root 的 glob）是否覆盖 repo 相对路径 rel。 */
function coversFile(m, rel) {
  if (m.root !== '.' && rel !== m.root && !rel.startsWith(`${m.root}/`)) return false;
  const sub = m.root === '.' ? rel : rel.slice(m.root.length + 1);
  for (const pattern of m.paths ?? []) {
    if (pattern === '**' || pattern === sub) return true;
    if (pattern.endsWith('/**') && sub.startsWith(`${pattern.slice(0, -3)}/`)) return true;
  }
  return false;
}

/**
 * 形态6 夹具（复刻 /tmp/kb-resplit-*）：环 src/q/a↔src/q/b；环外 occupant = src/q 顶层
 * 散文件组（g1,g2 → 模块 root=src/q，占住环的公共前缀）；环外 W=src/w import G(g1)；
 * 环成员 a/x import W(w1)。正确 draft：凝聚(q-a,q-b) → W → G 属主模块，DAG。
 */
function resplitCycleFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/q/a/x.mjs', 'import { z } from "../b/z.mjs";\nimport { w1 } from "../../w/w1.mjs";\nexport const x = z + w1;\n');
  write(dir, 'src/q/a/y.mjs', 'export const y = 1;\n');
  write(dir, 'src/q/b/z.mjs', 'import { y } from "../a/y.mjs";\nexport const z = y;\n');
  write(dir, 'src/q/b/w.mjs', 'export const w2 = 1;\n');
  write(dir, 'src/q/g1.mjs', 'export const g1 = 1;\n');
  write(dir, 'src/q/g2.mjs', 'export const g2 = 2;\n');
  write(dir, 'src/w/w1.mjs', 'import { g1 } from "../q/g1.mjs";\nexport const w1 = g1;\n');
  write(dir, 'src/w/w2.mjs', 'export const w3 = 1;\n');
  gitInitCommit(dir);
  return dir;
}

/**
 * 形态7 夹具（复刻 /tmp/kb-rootdot-*）：跨顶层根互环 src↔lib（凝聚后公共前缀='' →
 * root='.'），环成员 src/s2 import ext/e1（环外真实出边）；另一组环 app/q/a↔app/q/b
 * 配环外 occupant app/q 散文件组（g1,g2）触发让位+重扫。
 */
function rootDotCondensedFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/s1.mjs', 'import { l1 } from "../lib/l1.mjs";\nexport const s1 = l1;\n');
  write(dir, 'src/s2.mjs', 'import { e1 } from "../ext/e1.mjs";\nexport const s2 = e1;\n');
  write(dir, 'lib/l1.mjs', 'import { s1 } from "../src/s1.mjs";\nexport const l1 = s1;\n');
  write(dir, 'lib/l2.mjs', 'export const l2 = 1;\n');
  write(dir, 'ext/e1.mjs', 'export const e1 = 1;\n');
  write(dir, 'ext/e2.mjs', 'export const e2 = 2;\n');
  write(dir, 'app/q/a/x.mjs', 'import { z } from "../b/z.mjs";\nexport const x = z;\n');
  write(dir, 'app/q/a/y.mjs', 'export const y = 1;\n');
  write(dir, 'app/q/b/z.mjs', 'import { y } from "../a/y.mjs";\nexport const z = y;\n');
  write(dir, 'app/q/b/w.mjs', 'export const w = 1;\n');
  write(dir, 'app/q/g1.mjs', 'export const g1 = 1;\n');
  write(dir, 'app/q/g2.mjs', 'export const g2 = 2;\n');
  gitInitCommit(dir);
  return dir;
}

/**
 * 形态8 夹具：环 src/alpha↔src/beta（公共前缀 src）；环外 occupant = src 顶层散文件组
 *（loose1,loose2 → 模块 root=src，占住公共前缀，触发让位细分+重扫）；环外 gamma 在
 * 共享前缀下（防裸 ** 吞并的对照）。与 cyclicLooseMemberFixture 的差异：散文件组在环外。
 */
function resplitOccupantFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/alpha/a1.js', 'import { b } from "../beta/b1.js";\nexport const a = b;\n');
  write(dir, 'src/alpha/a2.js', 'export const a2 = 1;\n');
  write(dir, 'src/beta/b1.js', 'import { a2 } from "../alpha/a2.js";\nexport const b = a2;\n');
  write(dir, 'src/beta/b2.js', 'export const b2 = 1;\n');
  write(dir, 'src/gamma/g1.js', 'export const g = 1;\n');
  write(dir, 'src/gamma/g2.js', 'export const g2 = 1;\n');
  write(dir, 'src/loose1.js', 'export const l1 = 1;\n');
  write(dir, 'src/loose2.js', 'export const l2 = 1;\n');
  gitInitCommit(dir);
  return dir;
}

// ---------------- REQ 068 缺陷 6：occupant 让位+重扫后环残留且边错归属 ----------------

describe(`${REQ} occupant 让位+重扫：draft 无环且边归属正确`, RT, () => {
  test('W→散文件 G 的边必须挂在 G 的属主模块上（不得错挂凝聚模块），凝聚模块保留 →W 边，root 全图唯一', (t) => {
    if (!needGit(t)) return;
    const dir = resplitCycleFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const graph = () => JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths, dependsOn: m.dependsOn })));
    // 防误绿锚点：本夹具必须真的触发 occupant 让位细分+重扫分支。
    const why = (proposal.needsDecision ?? []).map((d) => `${d.field} ${d.why}`).join(' ');
    assert.match(why, /让位/, `夹具必须触发 occupant 让位+重扫分支: ${why}`);
    // 硬不变量：重扫后 draft 仍必须是无环 DAG（凝聚的使命）。
    const cycle = findCycle(modules);
    assert.equal(cycle, null,
      `重扫后 draft 残留环: ${cycle ? cycle.join(' -> ') : ''}；图: ${graph()}`);
    // 边归属：w1.mjs import 的是 occupant 散文件 g1.mjs，W 的出边必须指向 g1 的属主模块。
    const w = modules.find((m) => coversFile(m, 'src/w/w1.mjs'));
    assert.ok(w, `应存在覆盖 src/w/w1.mjs 的模块: ${graph()}`);
    const g1Owners = modules.filter((m) => coversFile(m, 'src/q/g1.mjs'));
    assert.equal(g1Owners.length, 1, `src/q/g1.mjs 必须有唯一属主模块: ${graph()}`);
    assert.deepEqual([...(w.dependsOn ?? [])].sort(), [g1Owners[0].id],
      `W 的唯一实边是 w1→g1，必须挂在 g1 属主模块（${g1Owners[0].id}）上，不得错挂凝聚模块: ${graph()}`);
    // 凝聚模块保留真实出边 x.mjs→w1.mjs（重扫不得丢环外边）。
    const condensed = modules.find((m) => coversFile(m, 'src/q/a/x.mjs') && coversFile(m, 'src/q/b/z.mjs'));
    assert.ok(condensed, `应存在凝聚 a+b 的模块: ${graph()}`);
    assert.ok((condensed.dependsOn ?? []).includes(w.id),
      `凝聚模块必须保留 →W 的真实边（x.mjs import w1.mjs）: ${graph()}`);
    // root 全图唯一：让位产物不得与凝聚模块撞 root。
    const roots = modules.map((m) => m.root);
    assert.equal(new Set(roots).size, roots.length,
      `任何两个模块不得共享同一 root（含让位产物）: ${graph()}`);
  });
});

// ---------------- REQ 068 缺陷 7：root='.' 凝聚模块重扫后实边丢失 ----------------

describe(`${REQ} root=. 凝聚模块触发重扫后实边不丢`, RT, () => {
  test('跨顶层根互环凝聚 root=. 后，成员 import 环外模块的真实边必须保留（重扫丢边 = 无环假绿）', (t) => {
    if (!needGit(t)) return;
    const dir = rootDotCondensedFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const graph = () => JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths, dependsOn: m.dependsOn })));
    const why = (proposal.needsDecision ?? []).map((d) => `${d.field} ${d.why}`).join(' ');
    assert.match(why, /让位/, `夹具必须触发 occupant 让位+重扫分支: ${why}`);
    // src↔lib 互环凝聚为单模块，公共前缀='' → root='.'。
    const condensed = modules.find((m) => coversFile(m, 'lib/l1.mjs') && coversFile(m, 'src/s1.mjs'));
    assert.ok(condensed, `src/lib 互环应凝聚为单模块: ${graph()}`);
    assert.equal(condensed.root, '.', `跨顶层根凝聚模块 root 应退到 .: ${graph()}`);
    // 核心红锁：s2.mjs import ext/e1.mjs 是环外真实出边，重扫后必须保留。
    const ext = modules.find((m) => coversFile(m, 'ext/e1.mjs'));
    assert.ok(ext, `应存在覆盖 ext/e1.mjs 的模块: ${graph()}`);
    assert.ok((condensed.dependsOn ?? []).includes(ext.id),
      `凝聚模块必须保留 src/s2→ext/e1 真实边，重扫丢边会让"无环"沦为边全丢的假绿: ${graph()}`);
    // 旁证：夹具有 ≥2 条环外实边（凝聚→ext、q-a/q-b 环外无边但有 app/q occupant 结构），
    // 重扫后全图实边不得归零。
    const totalEdges = modules.reduce((n, m) => n + (m.dependsOn ?? []).length, 0);
    assert.ok(totalEdges > 0, `夹具存在环外实边，重扫后全图 dependsOn 不得全空: ${graph()}`);
    assert.equal(findCycle(modules), null, `draft 必须无环: ${graph()}`);
  });
});

// ---------------- REQ 068 缺陷 8：让位细分（resplit）分支覆盖红锁 ----------------

describe(`${REQ} 让位细分分支：环公共前缀被环外模块占用`, RT, () => {
  test('让位后 draft 无环、root 全图唯一、occupant 散文件与环外子树归属唯一模块、凝聚模块不退裸 **', (t) => {
    if (!needGit(t)) return;
    const dir = resplitOccupantFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const graph = () => JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths, dependsOn: m.dependsOn })));
    // 覆盖红锁：本用例存在的意义是让 resplit 分支至少被执行一次——锚定分支确实到达。
    const why = (proposal.needsDecision ?? []).map((d) => `${d.field} ${d.why}`).join(' ');
    assert.match(why, /让位/, `夹具必须触发 occupant 让位细分+重扫分支: ${why}`);
    assert.equal(findCycle(modules), null, `让位后 draft 必须无环: ${graph()}`);
    // root 全图唯一是硬不变量（同深度 tie 无法仲裁）：让位产物不得与凝聚模块撞 root。
    const roots = modules.map((m) => m.root);
    assert.equal(new Set(roots).size, roots.length,
      `任何两个模块不得共享同一 root（含让位产物）: ${graph()}`);
    // occupant 散文件与环外子树归属唯一模块（不丢、不重、不被吞并）。
    const ownersOf = (file) => modules.filter((m) => coversFile(m, file));
    for (const file of ['src/loose1.js', 'src/loose2.js', 'src/gamma/g1.js']) {
      assert.equal(ownersOf(file).length, 1, `${file} 必须归属唯一模块: ${graph()}`);
    }
    // 共享前缀下凝聚模块 paths 枚举成员子树，不得退裸 **。
    const condensed = modules.find((m) => coversFile(m, 'src/alpha/a1.js') && coversFile(m, 'src/beta/b1.js'));
    assert.ok(condensed, `应存在凝聚 alpha+beta 的模块: ${graph()}`);
    assert.notDeepEqual([...(condensed.paths ?? [])].sort(), ['**'],
      `共享前缀下凝聚模块不得退裸 **: ${graph()}`);
  });
});

// ---------------- REQ 068 P2 第三轮回归：第二轮再凝聚 paths 膨胀（红测先行） ----------------
// 形态9 复刻 correctness 复审实证现场（/tmp/kb-round2-*）：discover.mjs 凝聚-重扫循环
// 第二轮再凝聚只用 member.root 推导子树 glob，丢弃 member.paths 的枚举收窄——
// 凝聚 {q-a,w} 时 q-a（root=src/q，paths 已收窄为 a/**、b/**）被按 root 重推成 'q/**'，
// 覆盖面膨胀吞掉 occupant 散文件 g1/g2（幻影模块：g1 双属主），g1→ext 真实边随之错挂
// 膨胀后的凝聚模块。
// 写测时点当前实现红；红因必须是缺陷本身（覆盖面膨胀/幻影双属主/边错归属）。

/**
 * 形态9 夹具（复刻 /tmp/kb-round2-*）：环 src/q/a↔src/q/b；occupant 散文件 g1/g2 在
 * src/q 直属（g1 import ../ext/e1.mjs —— 环外真实出边）；src/w/w1 import 环成员 a/x，
 * 且 w1 用裸 specifier `import "src/q/g1.mjs"` 指向 occupant 散文件——重扫后该边触发
 * 第二轮再凝聚。src/ext/{e1,e2} 为环外模块（g1→ext 边的归属断言目标）。
 */
function round2RecondenseFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/q/a/x.mjs', 'import { z } from "../b/z.mjs";\nimport { w1 } from "../../w/w1.mjs";\nexport const x = z + w1;\n');
  write(dir, 'src/q/a/y.mjs', 'export const y = 1;\n');
  write(dir, 'src/q/b/z.mjs', 'import { y } from "../a/y.mjs";\nexport const z = y;\n');
  write(dir, 'src/q/b/w.mjs', 'export const w2 = 1;\n');
  write(dir, 'src/q/g1.mjs', 'import { e1 } from "../ext/e1.mjs";\nexport const g1 = e1;\n');
  write(dir, 'src/q/g2.mjs', 'export const g2 = 2;\n');
  write(dir, 'src/w/w1.mjs', 'import { g1 } from "src/q/g1.mjs";\nexport const w1 = g1;\n');
  write(dir, 'src/w/w2.mjs', 'export const w3 = 1;\n');
  write(dir, 'src/ext/e1.mjs', 'export const e1 = 1;\n');
  write(dir, 'src/ext/e2.mjs', 'export const e2 = 2;\n');
  gitInitCommit(dir);
  return dir;
}

describe(`${REQ} 第二轮再凝聚：paths 枚举收窄不得膨胀为 root 子树`, RT, () => {
  test('再凝聚后：无环、root 唯一、覆盖面=成员文件并集（g1 唯一属主且非凝聚模块幻影）、g1→ext 边归真实属主、再凝聚不隐瞒', (t) => {
    if (!needGit(t)) return;
    const dir = round2RecondenseFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const graph = () => JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths, dependsOn: m.dependsOn })));
    const ownersOf = (file) => modules.filter((m) => coversFile(m, file));

    // ① 硬不变量：任意轮凝聚后 draft 必须是无环 DAG。
    const cycle = findCycle(modules);
    assert.equal(cycle, null,
      `再凝聚后 draft 必须无环: ${cycle ? cycle.join(' -> ') : ''}；图: ${graph()}`);

    // ② root 全图唯一。
    const roots = modules.map((m) => m.root);
    assert.equal(new Set(roots).size, roots.length,
      `任何两个模块不得共享同一 root: ${graph()}`);

    // ③ 覆盖面 = 成员文件并集：每个 tracked 源码文件必须有且仅有一个属主
    // （幻影覆盖 = 膨胀的 q/** 与逐文件枚举双占 g1/g2）。
    const sourceFiles = [
      'src/q/a/x.mjs', 'src/q/a/y.mjs', 'src/q/b/z.mjs', 'src/q/b/w.mjs',
      'src/q/g1.mjs', 'src/q/g2.mjs',
      'src/w/w1.mjs', 'src/w/w2.mjs',
      'src/ext/e1.mjs', 'src/ext/e2.mjs'
    ];
    for (const file of sourceFiles) {
      assert.equal(ownersOf(file).length, 1,
        `${file} 必须归属唯一模块（多属主=paths 膨胀幻影，零属主=覆盖面丢失）: ${graph()}`);
    }
    // 凝聚模块（a、b 真成员的属主）不得幻影覆盖 occupant 散文件 g1/g2——
    // member.paths 枚举收窄（a/**、b/**）禁止被 member.root 重推成 q/**。
    const condensed = ownersOf('src/q/a/x.mjs')[0];
    assert.ok(coversFile(condensed, 'src/q/b/z.mjs'),
      `凝聚模块必须真实覆盖环成员 a 与 b: ${graph()}`);
    for (const phantom of ['src/q/g1.mjs', 'src/q/g2.mjs']) {
      assert.ok(!coversFile(condensed, phantom),
        `凝聚模块不得幻影覆盖非成员文件 ${phantom}（paths 须沿用成员枚举收窄，不得按 root 膨胀为 q/**）: ${graph()}`);
    }

    // ④ g1→ext 真实边必须挂在 g1 的唯一属主模块上（用 coversFile 定位，不硬编码 id）。
    const g1Owner = ownersOf('src/q/g1.mjs')[0];
    const extOwner = ownersOf('src/ext/e1.mjs')[0];
    assert.ok(g1Owner && extOwner, `g1 与 ext/e1 必须各有属主: ${graph()}`);
    assert.ok((g1Owner.dependsOn ?? []).includes(extOwner.id),
      `g1.mjs import ../ext/e1.mjs 的真实边必须归属 g1 的属主模块（${g1Owner.id}），不得错挂膨胀后的凝聚模块: ${graph()}`);

    // ⑤ 再凝聚不得隐瞒：a↔b 的合并必须被点名；若凝聚产物跨 src/q 与 src/w 两树
    //（第二轮再凝聚确发生），w 的合并也必须出现在 needsDecision。
    const why = (proposal.needsDecision ?? []).filter((d) => d.field === 'modules[].dependsOn').map((d) => d.why).join(' ');
    assert.match(why, /a\s*↔.*b|b\s*↔.*a/,
      `环成员 a↔b 的凝聚必须在 needsDecision 点名: ${why}`);
    const spansW = coversFile(condensed, 'src/w/w1.mjs');
    if (spansW) {
      assert.match(why, /↔\s*w\b|\bw\b\s*↔/,
        `凝聚模块覆盖 src/w 子树 = 第二轮再凝聚已发生，必须在 needsDecision 点名 w 的合并: ${why}`);
    }
  });
});

// ---------------- REQ 068 P2 第四轮回归：同轮多 SCC 让位崩溃 + NodeNext 假绿（红测先行） ----------------
// 两个形态复刻 correctness 终审实证现场（/tmp/kb-dotrebase-*、/tmp/kb-nodenext-*）：
//   10) 同轮多 SCC 让位崩溃：三个环同轮凝聚，SCC2 的 occupant 恰好是 SCC3 的成员——
//       让位细分把成员从 modules 移除后，SCC3 的 target 查找落空（discover.mjs:432
//       TypeError: Cannot set properties of undefined），discover 整命令 ENGINE_ERROR。
//   11) 裸路径 specifier 扩展名改写假绿：import "src/b/x.js"（NodeNext 风格，真实文件
//       x.ts）未做 .js→.ts 改写解析，真实违例边 a→b 消失，arch check --scan 假绿 exit 0。
// 写测时点当前实现两例全红；红因必须是缺陷本身（崩溃 / 假绿），不是夹具或断言错误。

/**
 * 形态10 夹具（复刻 /tmp/kb-dotrebase-*）：三个环同轮——
 * src/q/a↔src/q/b；src/r/d↔src/r/e；src/r/g3↔src/r/f/f1（occupant 模块 r 自身与 r-f 成环）。
 * src/q/{g1,g2} 与 src/r/{g3,g4} 为顶层散文件组（各占住环的公共前缀 src/q、src/r）。
 */
function multiSccSameRoundFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, 'src/q/a/x.mjs', 'import { z } from "../b/z.mjs";\nexport const x = z;\n');
  write(dir, 'src/q/a/y.mjs', 'export const y = 1;\n');
  write(dir, 'src/q/b/z.mjs', 'import { y } from "../a/y.mjs";\nexport const z = y;\n');
  write(dir, 'src/q/b/w.mjs', 'export const w = 1;\n');
  write(dir, 'src/q/g1.mjs', 'export const g1 = 1;\n');
  write(dir, 'src/q/g2.mjs', 'export const g2 = 2;\n');
  write(dir, 'src/r/d/d1.mjs', 'import { e1 } from "../e/e1.mjs";\nexport const d1 = e1;\n');
  write(dir, 'src/r/d/d2.mjs', 'export const d2 = 1;\n');
  write(dir, 'src/r/e/e1.mjs', 'import { d2 } from "../d/d2.mjs";\nexport const e1 = d2;\n');
  write(dir, 'src/r/e/e2.mjs', 'export const e2 = 1;\n');
  write(dir, 'src/r/f/f1.mjs', 'import { g4 } from "../g4.mjs";\nexport const f1 = g4;\n');
  write(dir, 'src/r/f/f2.mjs', 'export const f2 = 1;\n');
  write(dir, 'src/r/g3.mjs', 'import { f1 } from "./f/f1.mjs";\nexport const g3 = f1;\n');
  write(dir, 'src/r/g4.mjs', 'export const g4 = 2;\n');
  gitInitCommit(dir);
  return dir;
}

/**
 * 形态11 夹具（复刻 /tmp/kb-nodenext-*）：既有 catalog 中模块 b 为 root=src/b
 * paths=['x.ts']（枚举形态），模块 a 的文件 import 'src/b/x.js'（NodeNext 风格裸路径
 * specifier，真实文件 x.ts）。catalog 未声明 a→b——解析出实边即 undeclared-dependency。
 */
function nodenextSpecifierFixture(t) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({
    version: 1, layers: [], globalPaths: [], ignored: [],
    modules: [
      { id: 'a', root: 'src/a', paths: ['**'], dependsOn: [], owners: [], provides: [], attributes: {}, verification: [] },
      { id: 'b', root: 'src/b', paths: ['x.ts'], dependsOn: [], owners: [], provides: [], attributes: {}, verification: [] }
    ]
  }, null, 2));
  write(dir, 'src/a/f.ts', 'import { x } from "src/b/x.js";\nexport const f = x;\n');
  write(dir, 'src/a/f2.ts', 'export const f2 = 1;\n');
  write(dir, 'src/b/x.ts', 'export const x = 1;\n');
  gitInitCommit(dir);
  return dir;
}

// ---------------- REQ 068 缺陷 10：同轮多 SCC 让位崩溃 ----------------

describe(`${REQ} 同轮多 SCC 让位：不得崩溃且产出合法 draft`, RT, () => {
  test('三环同轮（occupant 是另一环成员）时 discover exit 0、无环、root 唯一、paths 无 ./ 前缀破坏 pattern', (t) => {
    if (!needGit(t)) return;
    const dir = multiSccSameRoundFixture(t);
    const r = run(['catalog', 'discover'], { cwd: dir });
    // 核心红锁：同轮多 SCC 的让位仲裁不得访问已被移除的模块成员而 ENGINE_ERROR。
    assert.equal(r.code, 0, `discover 不得崩溃（同轮多 SCC 让位仲裁不得引用已移除模块）: ${out(r)}`);
    assert.doesNotMatch(out(r), /ENGINE_ERROR/, `不得出现内部错误: ${out(r)}`);
    const proposal = proposalJson(r);
    const modules = proposal.draft.modules;
    const graph = () => JSON.stringify(modules.map((m) => ({ id: m.id, root: m.root, paths: m.paths, dependsOn: m.dependsOn })));
    const cycle = findCycle(modules);
    assert.equal(cycle, null,
      `同轮多 SCC 凝聚后 draft 必须无环: ${cycle ? cycle.join(' -> ') : ''}；图: ${graph()}`);
    const roots = modules.map((m) => m.root);
    assert.equal(new Set(roots).size, roots.length,
      `任何两个模块不得共享同一 root: ${graph()}`);
    // paths 重基红锁：root='.' 成员 rel='.' 时不得产出 './src/...' 破坏 pattern。
    for (const m of modules) {
      for (const pattern of m.paths ?? []) {
        assert.ok(!pattern.startsWith('./'),
          `paths 重基不得产出 ./ 前缀破坏 pattern（模块 ${m.id} root=${m.root}）: ${graph()}`);
      }
    }
  });
});

// ---------------- REQ 068 缺陷 11：裸路径 specifier 扩展名改写假绿 ----------------

describe(`${REQ} 裸路径 specifier 扩展名改写：真实违例边不得消失`, RT, () => {
  test('import "src/b/x.js"（真实文件 x.ts）必须解析出 a→b 实边，arch check --scan 报 undeclared-dependency exit 1', (t) => {
    // 钉的是：扩展名未改写（.js→.ts）导致 import 解析落空、真实违例边 a→b 消失，
    // arch check --scan 假绿 exit 0（实测输出「arch check 通过」+「未解析 import 计数：1」）。
    if (!needGit(t)) return;
    const dir = nodenextSpecifierFixture(t);
    const r = run(['arch', 'check', '--scan'], { cwd: dir });
    assert.equal(r.code, 1,
      `存在未声明的真实 import 边 a→b，arch check --scan 必须 exit 1（扩展名未改写会把违例吞成假绿 exit 0）: ${out(r)}`);
    assert.match(out(r), /undeclared-dependency\] a -> b/,
      `必须点名 undeclared-dependency a -> b: ${out(r)}`);
  });
});
