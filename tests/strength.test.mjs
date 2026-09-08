/**
 * tests/strength.test.mjs
 * REQ-051（强度策略引擎）/ REQ-052（strength 动词族）行为测试——红测先行于实现，
 * 已随 v3.0 P3 落地转绿（planned 标记已摘除，字面引用为正式追溯）。
 * 设计依据：docs/adr/0008-strength-policy-engine.md。
 *
 * 运行：node --test tests/strength.test.mjs
 *
 * 纪律（同 spec.test.mjs / cli-contracts.test.mjs）：临时 git 仓夹具、真实 CLI 子进程、
 * 断言退出码与输出字段、不依赖 .kimi-base/state/ 残留；环境无 git 的用例显式 skip。
 * 特别说明（同 cli-contracts.test.mjs 先例）：HarnessError/usageError 报文走 stderr，
 * 凡断言错误码 token（STRENGTH_WEAKENING 等）的用例一律用 out(r)=stdout+stderr 合并视图，
 * 只断言字段性 token，不断言整句文案、不断言 stderr 独立内容。
 *
 * 红测先行记录：写测时点特性未实现，除「shadow 不阻断」的 task complete 半句外全部红
 * （红因=行为缺失/未知动词 strength）；落地后全绿，本文件现为 REQ-051/052 契约回归锁。
 *
 * 契约歧义点的选定解释（详见各用例注释）：
 *   1) explain 的 path/attribute floor 触发入口：契约只列了 --risk/--operation，选定
 *      --paths（仿 spec view --paths / impact 路径参数的既有惯例）。
 *   2) floors 配置段形状契约未定义：本文件不依赖 floors 覆盖形态，只用 ADR-0008 的
 *      内建默认 floor 映射（risk high→strict / operation release→strict / 保护属性
 *      high+→strict / 治理面·信任边界路径→strict）；封闭轴集测试改在 customProfiles.axes
 *      注入第 13 个轴名。
 *   3) 当前生效档来源：strength.json 的 profile 字段为配置期当前档，strength set 写
 *      state 覆盖之；夹具一律显式给 profile，不依赖缺省档。
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

// 追溯锚点：REQ-051 / REQ-052（字面引用，接通 PLANNED_HAS_TESTS 工作流，勿拼接构造）。

// ---------------- 基础辅助（同 spec.test.mjs 惯例） ----------------

function mkdtemp(t, prefix = 'kimi-base-strength-') {
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
// 错误码 token 走 stderr（HarnessError），用合并视图只断字段性 token。
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

/** 仅含 harness.json 标记的最小项目（needProject 只要求 CONFIG_REL 存在）。 */
function writeHarness(dir, extra = {}) {
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1, ...extra }, null, 2));
}

/** strength.json 夹具：config 为 null 时不写该文件（治理未开启形态）。 */
function strengthFixture(t, config, { withGit = false, files = {} } = {}) {
  const dir = mkdtemp(t);
  writeHarness(dir);
  if (config !== null) write(dir, '.kimi-base/strength.json', JSON.stringify(config, null, 2));
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  if (withGit) gitInitCommit(dir);
  return dir;
}

// ---------------- 契约常量：12 封闭控制轴、档序、四内置档（REQ-051） ----------------

const AXES = [
  'verificationBreadth', 'testStrength', 'reviewerMode', 'reviewStages', 'reviewLenses',
  'reviewRounds', 'evidenceLevel', 'deferralMode', 'completionMode', 'requireSpecTrace',
  'contextBudgetChars', 'budgetMaxFiles',
];

/** 弱→强档序；数值轴（null）按正整数升序比。 */
const AXIS_ORDER = {
  verificationBreadth: ['none', 'direct', 'affected', 'all'],
  testStrength: ['none', 'smoke', 'unit', 'full'],
  reviewerMode: ['none', 'self', 'independent', 'staged'],
  reviewStages: [0, 1, 2, 3],
  reviewLenses: ['none', 'minimal', 'standard', 'full'],
  reviewRounds: [1, 2, 3],
  evidenceLevel: ['none', 'bound', 'policy-bound', 'attested'],
  deferralMode: ['loan', 'disabled'],
  completionMode: ['forbidden', 'low-risk', 'standard', 'strict'],
  requireSpecTrace: [false, true],
  contextBudgetChars: null,
  budgetMaxFiles: null,
};

/** 四内置档逐轴值（特性契约给定，逐轴锁定）。 */
const BUILTIN = {
  explore: {
    verificationBreadth: 'none', testStrength: 'none', reviewerMode: 'none', reviewStages: 0,
    reviewLenses: 'none', reviewRounds: 1, evidenceLevel: 'none', deferralMode: 'loan',
    completionMode: 'forbidden', requireSpecTrace: false, contextBudgetChars: 20000, budgetMaxFiles: 5,
  },
  rapid: {
    verificationBreadth: 'direct', testStrength: 'smoke', reviewerMode: 'self', reviewStages: 1,
    reviewLenses: 'minimal', reviewRounds: 1, evidenceLevel: 'bound', deferralMode: 'loan',
    completionMode: 'low-risk', requireSpecTrace: false, contextBudgetChars: 40000, budgetMaxFiles: 20,
  },
  balanced: {
    verificationBreadth: 'affected', testStrength: 'unit', reviewerMode: 'independent', reviewStages: 2,
    reviewLenses: 'standard', reviewRounds: 2, evidenceLevel: 'policy-bound', deferralMode: 'loan',
    completionMode: 'standard', requireSpecTrace: true, contextBudgetChars: 60000, budgetMaxFiles: 50,
  },
  strict: {
    verificationBreadth: 'all', testStrength: 'full', reviewerMode: 'staged', reviewStages: 3,
    reviewLenses: 'full', reviewRounds: 3, evidenceLevel: 'attested', deferralMode: 'disabled',
    completionMode: 'strict', requireSpecTrace: true, contextBudgetChars: 100000, budgetMaxFiles: 200,
  },
};
const BUILTIN_NAMES = Object.keys(BUILTIN); // explore/rapid/balanced/strict

/**
 * 最小合法 verification-matrix（completionGate 强依赖 loadMatrix；riskKinds 累积并集
 * 且 high 必须含 security）。low 层挂一个 unit 检查：无 fresh receipt 时完成门自然 exit 2——
 * completionMode 执法用例在这条既有阻断路径之上点名 completionMode，防「别处 exit 2 凑绿」。
 */
const MATRIX_MIN = JSON.stringify({
  version: 1,
  riskKinds: { low: ['unit'], medium: ['unit', 'security'], high: ['unit', 'security'] },
  checks: [{ id: 'unit-smoke', kind: 'unit', command: 'true' }],
}, null, 2);

/** 从 status/explain 文本提取逐轴值（容忍半角/全角冒号与等号；缺轴即测试失败）。 */
function parseAxes(text) {
  const axes = {};
  for (const axis of AXES) {
    const m = text.match(new RegExp(`${axis}\\s*[：:=]\\s*([^\\s，,；;]+)`));
    assert.ok(m, `输出缺轴 ${axis}\n实际输出：${text}`);
    axes[axis] = m[1];
  }
  return axes;
}

/** 归一化轴值为可比较类型（数值轴转数、布尔轴转布尔）。 */
function normalizeAxisValue(axis, raw) {
  if (AXIS_ORDER[axis] === null) return Number(raw);
  if (axis === 'requireSpecTrace') return raw === 'true';
  if (axis === 'reviewStages' || axis === 'reviewRounds') return Number(raw);
  return raw;
}

/** 轴值强度秩：枚举轴按档序下标，数值轴按数值（越大越强）。 */
function axisRank(axis, value) {
  if (AXIS_ORDER[axis] === null) return Number(value);
  const idx = AXIS_ORDER[axis].indexOf(value);
  assert.ok(idx >= 0, `轴 ${axis} 出现档序外取值：${String(value)}`);
  return idx;
}

// ---------------- REQ-052：strength list ----------------

describe('strength list', RT, () => {
  test('无 strength.json 也 exit 0 且列出四内置档（内置档客观存在）', (t) => {
    const dir = strengthFixture(t, null);
    const r = run(['strength', 'list'], { cwd: dir });
    assert.equal(r.code, 0, `无 strength.json 时 list 应 exit 0\n${out(r)}`);
    for (const name of BUILTIN_NAMES) {
      assert.ok(out(r).includes(name), `list 输出应含内置档 ${name}\n实际输出：${out(r)}`);
    }
  });

  test('列出自定义档及其逐轴生效值（extends 合并后的最终值）', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'balanced',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 3 } } },
    });
    const r = run(['strength', 'list'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.ok(out(r).includes('team'), `list 输出应含自定义档 team\n实际输出：${out(r)}`);
    assert.match(out(r), /reviewRounds\s*[：:=]\s*3/, `team 的 reviewRounds 收紧值 3 应可见\n实际输出：${out(r)}`);
  });
});

// ---------------- REQ-051/052：内置四档逐轴值锁定与单调性 ----------------

describe('内置四档（逐轴值锁定 + 单调性）', RT, () => {
  // 逐档起子进程读 status 的逐轴生效值；既逐轴对账契约值，也验证档序单调。
  test('四内置档逐轴值与契约表逐条一致', (t) => {
    for (const name of BUILTIN_NAMES) {
      const dir = strengthFixture(t, { version: 1, profile: name });
      const r = run(['strength', 'status'], { cwd: dir });
      assert.equal(r.code, 0, `${name}：status 应 exit 0\n${out(r)}`);
      const axes = parseAxes(out(r));
      for (const axis of AXES) {
        assert.equal(
          normalizeAxisValue(axis, axes[axis]),
          BUILTIN[name][axis],
          `${name}.${axis} 应为 ${BUILTIN[name][axis]}，实得 ${axes[axis]}\n${out(r)}`
        );
      }
    }
  });

  test('档序单调：explore ≤ rapid ≤ balanced ≤ strict（逐轴）', (t) => {
    const parsed = {};
    for (const name of BUILTIN_NAMES) {
      const dir = strengthFixture(t, { version: 1, profile: name });
      const r = run(['strength', 'status'], { cwd: dir });
      assert.equal(r.code, 0, `${name}：status 应 exit 0\n${out(r)}`);
      parsed[name] = parseAxes(out(r));
    }
    for (const axis of AXES) {
      const ranks = BUILTIN_NAMES.map((name) => axisRank(axis, normalizeAxisValue(axis, parsed[name][axis])));
      for (let i = 1; i < ranks.length; i += 1) {
        assert.ok(
          ranks[i] >= ranks[i - 1],
          `轴 ${axis} 违反单调：${BUILTIN_NAMES[i - 1]}=${ranks[i - 1]} > ${BUILTIN_NAMES[i]}=${ranks[i]}`
        );
      }
    }
  });
});

// ---------------- REQ-052：strength status ----------------

describe('strength status', RT, () => {
  test('无 strength.json → exit 3（治理未开启，响亮不假绿）', (t) => {
    const dir = strengthFixture(t, null);
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 3, `无 strength.json 时 status 应 exit 3，实得 ${r.code}\n${out(r)}`);
  });

  test('有配置 → exit 0，输出当前生效档、逐轴生效值、policyHash、rollout 模式', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced', rollout: 'enforce' });
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.ok(out(r).includes('balanced'), `应点名当前生效档 balanced\n实际输出：${out(r)}`);
    parseAxes(out(r)); // 12 轴齐全（缺轴即断言失败）
    assert.match(out(r), /policyHash\s*[：:=]\s*\S+/, `应输出 policyHash\n实际输出：${out(r)}`);
    assert.match(out(r), /rollout\s*[：:=]\s*enforce/, `应输出 rollout 模式\n实际输出：${out(r)}`);
  });
});

// ---------------- REQ-052：strength set ----------------

describe('strength set', RT, () => {
  test('set --profile rapid 写 state 生效：随后 status 的当前档为 rapid', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });
    const set = run(['strength', 'set', '--profile', 'rapid'], { cwd: dir });
    assert.equal(set.code, 0, out(set));
    const status = run(['strength', 'status'], { cwd: dir });
    assert.equal(status.code, 0, out(status));
    assert.ok(out(status).includes('rapid'), `set 后 status 应反映新档 rapid\n实际输出：${out(status)}`);
    const axes = parseAxes(out(status));
    assert.equal(axes.testStrength, 'smoke', `rapid 档 testStrength 应为 smoke\n${out(status)}`);
  });

  test('未知档名 exit 1 且列出合法集（内置四档 + 自定义档）', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'balanced',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 3 } } },
    });
    const r = run(['strength', 'set', '--profile', 'nope'], { cwd: dir });
    assert.equal(r.code, 1, `未知档名应 exit 1，实得 ${r.code}\n${out(r)}`);
    for (const name of [...BUILTIN_NAMES, 'team']) {
      assert.ok(out(r).includes(name), `合法集应列出 ${name}\n实际输出：${out(r)}`);
    }
  });
});

// ---------------- REQ-052：strength explain 与 decision log ----------------

describe('strength explain 与 decision log', RT, () => {
  test('无 floor 输入：逐轴输出最终值且来源为 builtin', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });
    const r = run(['strength', 'explain'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    parseAxes(out(r));
    assert.match(out(r), /builtin/, `balanced 无 floor 时来源应标 builtin\n实际输出：${out(r)}`);
  });

  test('自定义档收紧轴的来源标 extends', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 3 } } },
    });
    const r = run(['strength', 'explain'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.reviewRounds, '3', `team.reviewRounds 应为收紧值 3\n${out(r)}`);
    assert.match(out(r), /extends/, `收紧轴来源应标 extends\n实际输出：${out(r)}`);
  });

  test('decision log：解析后写 strength-decisions.jsonl，条目含 policyRevision/inputDigest/reasons', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });
    const r = run(['strength', 'explain'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const logPath = path.join(dir, '.kimi-base', 'state', 'strength-decisions.jsonl');
    assert.ok(fs.existsSync(logPath), `缺 decision log：${path.relative(dir, logPath)}`);
    const lines = read(dir, '.kimi-base/state/strength-decisions.jsonl').trim().split('\n');
    assert.ok(lines.length >= 1, 'decision log 至少一条');
    const entry = JSON.parse(lines.at(-1));
    assert.ok(entry.policyRevision, `条目缺 policyRevision：${lines.at(-1)}`);
    assert.ok(entry.inputDigest, `条目缺 inputDigest：${lines.at(-1)}`);
    assert.ok(Array.isArray(entry.reasons), `条目缺 reasons 数组：${lines.at(-1)}`);
  });

  test('decision log 有界 ≤200 条（预置 210 条后解析一次必须截断）', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });
    const seed = Array.from({ length: 210 }, (_, i) => JSON.stringify({ policyRevision: `seed-${i}`, inputDigest: 'seed', reasons: [] })).join('\n');
    write(dir, '.kimi-base/state/strength-decisions.jsonl', `${seed}\n`);
    const r = run(['strength', 'explain'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const lines = read(dir, '.kimi-base/state/strength-decisions.jsonl').trim().split('\n');
    assert.ok(lines.length <= 200, `decision log 必须有界 ≤200 条，实得 ${lines.length}`);
    const entry = JSON.parse(lines.at(-1));
    assert.ok(entry.policyRevision && entry.inputDigest && Array.isArray(entry.reasons), '截断后最新条目字段必须齐备');
  });
});

// ---------------- REQ-051：extends 只收紧 + 配置严格校验 ----------------

describe('extends 只收紧与配置严格校验', RT, () => {
  test('extends balanced 但 reviewRounds:1（降级）→ exit 1 报 STRENGTH_WEAKENING', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 1 } } },
    });
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 1, `降级配置应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.match(out(r), /STRENGTH_WEAKENING/, `应报 STRENGTH_WEAKENING\n实际输出：${out(r)}`);
  });

  test('extends 未知目标 → exit 1 配置错误并点名目标', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'nope', axes: {} } },
    });
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 1, `未知 extends 目标应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('nope'), `应点名未知目标 nope\n实际输出：${out(r)}`);
  });

  test('未知轴名（第 13 轴）出现在自定义档 axes → exit 1（轴集封闭）', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 3, bogusAxis: 1 } } },
    });
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 1, `未知轴名应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('bogusAxis'), `应点名未知轴 bogusAxis\n实际输出：${out(r)}`);
  });

  test('非法轴值（evidenceLevel 档序外取值）→ exit 1 配置错误', (t) => {
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { evidenceLevel: 'gold' } } },
    });
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 1, `非法轴值应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('evidenceLevel'), `应点名非法轴 evidenceLevel\n实际输出：${out(r)}`);
  });

  test('非法 rollout 取值 → exit 1 并点名非法值（严格校验类比 harness.json）', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced', rollout: 'yolo' });
    const r = run(['strength', 'status'], { cwd: dir });
    assert.equal(r.code, 1, `非法 rollout 应 exit 1，实得 ${r.code}\n${out(r)}`);
    // 只断 exit 1 会被「未知动词 exit 1」假绿——必须点名非法值证明错误来自配置校验。
    assert.ok(out(r).includes('yolo'), `应点名非法 rollout 值 yolo\n实际输出：${out(r)}`);
  });
});

// ---------------- REQ-051：floor 只升不降 ----------------

describe('floor 只升不降（多 floor 冲突取最高）', RT, () => {
  // 基线档一律 rapid（低强度），证明抬升来自 floor 而非配置档本身。
  test('risk=high → 生效档抬到 strict，explain 标注 floor:risk', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' });
    const r = run(['strength', 'explain', '--risk', 'high'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `risk=high 应抬到 strict 档（verificationBreadth=all）\n${out(r)}`);
    assert.equal(axes.testStrength, 'full', `risk=high 应抬到 strict 档（testStrength=full）\n${out(r)}`);
    assert.match(out(r), /floor:risk/, `抬升轴来源应标 floor:risk\n实际输出：${out(r)}`);
  });

  test('operation=release → 生效档抬到 strict，标注 floor:operation', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' });
    const r = run(['strength', 'explain', '--operation', 'release'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `operation=release 应抬到 strict\n${out(r)}`);
    assert.match(out(r), /floor:operation/, `抬升轴来源应标 floor:operation\n实际输出：${out(r)}`);
  });

  test('路径命中治理面（.kimi-base/**）→ strict，标注 floor:path', (t) => {
    // 契约歧义点 1：explain 的路径入口选定为 --paths（仿 spec view/impact）。
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' });
    const r = run(['strength', 'explain', '--paths', '.kimi-base/harness.json'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `治理面路径应抬到 strict\n${out(r)}`);
    assert.match(out(r), /floor:path/, `抬升轴来源应标 floor:path\n实际输出：${out(r)}`);
  });

  test('路径命中信任边界（auth/）→ strict，标注 floor:path', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' });
    const r = run(['strength', 'explain', '--paths', 'src/auth/login.js'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `信任边界路径应抬到 strict\n${out(r)}`);
    assert.match(out(r), /floor:path/, `抬升轴来源应标 floor:path\n实际输出：${out(r)}`);
  });

  test('受影响模块声明保护属性（security=high）→ strict，标注 floor:attribute', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' }, {
      files: {
        '.kimi-base/module-catalog.json': JSON.stringify({
          version: 1,
          layers: ['app'],
          globalPaths: [],
          ignored: [],
          modules: [
            { name: 'app', paths: ['src/**'], layer: 'app', dependsOn: [], forbiddenDependencies: [], provides: [], attributes: { security: 'high' } },
          ],
        }, null, 2),
      },
    });
    const r = run(['strength', 'explain', '--paths', 'src/pay.js'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `保护属性 high 应抬到 strict\n${out(r)}`);
    assert.match(out(r), /floor:attribute/, `抬升轴来源应标 floor:attribute\n实际输出：${out(r)}`);
  });

  test('多 floor 冲突取最高：risk=medium（→balanced）× operation=release（→strict）→ strict', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'explore' });
    const r = run(['strength', 'explain', '--risk', 'medium', '--operation', 'release'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `多 floor 冲突应取最高（strict）\n${out(r)}`);
    assert.equal(axes.reviewerMode, 'staged', `多 floor 冲突应取最高（strict）\n${out(r)}`);
  });

  test('floor 可抬升配置档但不降低：risk=medium 把 explore 抬到 balanced，strict 档不被 risk=low 拉低', (t) => {
    const raised = strengthFixture(t, { version: 1, profile: 'explore' });
    const up = run(['strength', 'explain', '--risk', 'medium'], { cwd: raised });
    assert.equal(up.code, 0, out(up));
    const upAxes = parseAxes(out(up));
    assert.equal(upAxes.verificationBreadth, 'affected', `risk=medium 应把 explore 抬到 balanced\n${out(up)}`);

    const kept = strengthFixture(t, { version: 1, profile: 'strict' });
    const down = run(['strength', 'explain', '--risk', 'low'], { cwd: kept });
    assert.equal(down.code, 0, out(down));
    const downAxes = parseAxes(out(down));
    assert.equal(downAxes.verificationBreadth, 'all', `floor 只升不降：strict 不得被 risk=low 拉低\n${out(down)}`);
  });
});

// ---------------- REQ-051：policyHash 稳定且敏感 ----------------

describe('policyHash', RT, () => {
  const extractHash = (text) => {
    const m = text.match(/policyHash\s*[：:=]\s*([0-9a-fA-F]{8,})/);
    assert.ok(m, `输出缺 policyHash\n实际输出：${text}`);
    return m[1];
  };

  test('同配置同输入 policyHash 稳定；改任一轴值即变', (t) => {
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });
    const first = run(['strength', 'status'], { cwd: dir });
    const second = run(['strength', 'status'], { cwd: dir });
    assert.equal(first.code, 0, out(first));
    assert.equal(second.code, 0, out(second));
    assert.equal(extractHash(out(first)), extractHash(out(second)), '同配置同输入 policyHash 必须稳定');

    // 改一个轴（自定义档收紧 reviewRounds）→ policyHash 必须变。
    write(dir, '.kimi-base/strength.json', JSON.stringify({
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 3 } } },
    }, null, 2));
    const changed = run(['strength', 'status'], { cwd: dir });
    assert.equal(changed.code, 0, out(changed));
    assert.notEqual(extractHash(out(changed)), extractHash(out(first)), '改任一轴值 policyHash 必须变化');
  });
});

// ---------------- REQ-051：shadow 模式与 completionMode 执法 ----------------

describe('shadow 模式与 completionMode 执法', RT, () => {
  test('explore 档（enforce）：task complete 必须 exit 2 并点名 completionMode=forbidden', (t) => {
    if (!needGit(t)) return;
    const dir = strengthFixture(t, { version: 1, profile: 'explore', rollout: 'enforce' }, {
      withGit: true,
      files: { '.kimi-base/verification-matrix.json': MATRIX_MIN },
    });
    const start = run(['task', 'start', '--goal', '探查代码', '--owned', 'src/**', '--risk', 'low'], { cwd: dir });
    assert.equal(start.code, 0, out(start));
    const r = run(['task', 'complete'], { cwd: dir });
    assert.equal(r.code, 2, `explore 档下 task complete 应 exit 2，实得 ${r.code}\n${out(r)}`);
    assert.match(out(r), /completionMode\s*[：:=]\s*forbidden/, `应点名 completionMode=forbidden\n实际输出：${out(r)}`);
  });

  test('rollout=shadow：status 响亮标注 shadow 且 exit 0；completionMode 不执法', (t) => {
    if (!needGit(t)) return;
    const dir = strengthFixture(t, { version: 1, profile: 'explore', rollout: 'shadow' }, {
      withGit: true,
      files: { '.kimi-base/verification-matrix.json': MATRIX_MIN },
    });
    const status = run(['strength', 'status'], { cwd: dir });
    assert.equal(status.code, 0, `shadow 下 status 应照常输出 exit 0\n${out(status)}`);
    assert.match(out(status), /shadow/, `shadow 状态必须响亮可见\n实际输出：${out(status)}`);
    // shadow 不阻断任何操作：explore 档的 completionMode=forbidden 不得成为阻断理由。
    // （缺 fresh receipt 的既有完成门阻断不受本用例断言影响——只断 completionMode 缺席。）
    const start = run(['task', 'start', '--goal', '探查代码', '--owned', 'src/**', '--risk', 'low'], { cwd: dir });
    assert.equal(start.code, 0, out(start));
    const complete = run(['task', 'complete'], { cwd: dir });
    assert.doesNotMatch(out(complete), /completionMode/, `shadow 下 completionMode 不得执法\n实际输出：${out(complete)}`);
  });
});

// ---------------- REQ-052：selftest 含 strength 断言项 ----------------

describe('selftest 集成', RT, () => {
  test('selftest exit 0 且自检条目数 ≥21（含 strength 相关断言项）', () => {
    const r = run(['selftest'], { cwd: REPO });
    assert.equal(r.code, 0, `selftest 应 exit 0\n${out(r)}`);
    const m = r.stdout.match(/selftest：(\d+)\/\1 通过/);
    assert.ok(m, `selftest 输出缺通过计数行\n${r.stdout}`);
    assert.ok(Number(m[1]) >= 21, `自检条目数应 ≥21（含 strength 断言项），实得 ${m[1]}`);
  });
});

// ---------------- P3 评审缺陷回归（独立测试作者追加；纯追加段，不动既有用例与文件头） ----------------
// 缺陷锚点（P3 评审发现的四处实现缺陷；红测先行随修复转绿，现为回归锁）：
//   D1 attribute floor 只吃字符串形属性声明——catalog.mjs parseAttributeDeclaration 明确的
//      合法对象形 {tier, reason} 被 String({...})="[object Object]" 吞掉，保护属性永不抬升。
//   D2 attribute floor 裸 matchesGlob 不剥 module.root 前缀——codex 系模块（root + root 内
//      glob）下仓根相对路径永不命中（正确语义见 catalog.mjs moduleMatches）。
//   D3 customProfiles 与内置档同名时 resolveCustom 早退（内置档先占 resolved）→ 静默回落
//      内置档；同名遮蔽必须配置期拒绝。
//   D4 strength 未注册进 CONTRACTS，assertContract 查表落空直接早退——未知 flag / 多余
//      位置参数 / 重复 flag 全部旁路（exit 0）。
// 收紧防回归项（当前实现此处无缺陷，预期绿；红=未来回退信号）：
//   G1 policyHash 轴值变量隔离（既有「改任一轴值即变」用例混淆了档名变量 balanced→team）。
//   G2 decision log 截断保新（防 slice(0, 200) 丢新留旧形态）。

describe('P3 缺陷回归：attribute floor 合法形态', RT, () => {
  test('对象形属性声明 {"security":{"tier":"high","reason":...}} → strict 且标 floor:attribute', (t) => {
    // 锁定（D1）：对象形 {tier, reason} 是 catalog 合法属性声明，必须命中属性 floor——
    // 旧缺陷：attributeFloorProfile 用 String(...) 比档，对象形被吞成 "[object Object]" 永不命中。
    // 夹具隔离：路径 src/pay.js 命中模块 glob 但不含治理面/信任边界段，抬升只能来自属性 floor。
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' }, {
      files: {
        '.kimi-base/module-catalog.json': JSON.stringify({
          version: 1,
          layers: ['app'],
          globalPaths: [],
          ignored: [],
          modules: [
            { name: 'app', paths: ['src/**'], layer: 'app', dependsOn: [], forbiddenDependencies: [], provides: [], attributes: { security: { tier: 'high', reason: '支付面' } } },
          ],
        }, null, 2),
      },
    });
    const r = run(['strength', 'explain', '--paths', 'src/pay.js'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `对象形保护属性声明（tier=high）应抬到 strict\n${out(r)}`);
    assert.match(out(r), /floor:attribute/, `抬升轴来源应标 floor:attribute\n实际输出：${out(r)}`);
  });

  test('codex 系模块（root=packages/pay + paths=["src/**"]）：仓根相对路径必须命中 → strict/floor:attribute', (t) => {
    // 锁定（D2）：codex 系模块的仓根相对路径必须先剥 module.root 前缀再匹配 root 内 glob
    // （catalog.mjs moduleMatches 语义）——旧缺陷：裸 matchesGlob 锚定 ^src 永不命中。
    // 夹具隔离：路径段无 auth/security/secrets，抬升只能来自属性 floor。
    const dir = strengthFixture(t, { version: 1, profile: 'rapid' }, {
      files: {
        '.kimi-base/module-catalog.json': JSON.stringify({
          version: 1,
          layers: ['app'],
          globalPaths: [],
          ignored: [],
          modules: [
            { id: 'pay', root: 'packages/pay', paths: ['src/**'], layer: 'app', dependsOn: [], forbiddenDependencies: [], provides: [], attributes: { security: 'high' } },
          ],
        }, null, 2),
      },
    });
    const r = run(['strength', 'explain', '--paths', 'packages/pay/src/pay.js'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const axes = parseAxes(out(r));
    assert.equal(axes.verificationBreadth, 'all', `codex 系模块的仓根相对路径应命中并抬到 strict\n${out(r)}`);
    assert.match(out(r), /floor:attribute/, `抬升轴来源应标 floor:attribute\n实际输出：${out(r)}`);
  });
});

describe('P3 缺陷回归：自定义档与内置档同名必须配置期拒绝', RT, () => {
  test('customProfiles.balanced 遮蔽内置档 → status 与 list 均 exit 1 配置错误（不得静默回落内置档）', (t) => {
    // 锁定（D3）：与内置档同名的 customProfiles 必须配置期拒绝，不得静默回落内置档
    // （旧缺陷：resolveCustom 见内置档先占 resolved 即早退，同名自定义档被静默丢弃）。
    // 只断 exit 1 会被「未知动词 exit 1」假绿——必须同时点名被遮蔽的档名 balanced。
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'balanced',
      customProfiles: { balanced: { extends: 'strict' } },
    });
    const status = run(['strength', 'status'], { cwd: dir });
    assert.equal(status.code, 1, `同名自定义档应配置期拒绝（status exit 1），实得 ${status.code}\n${out(status)}`);
    assert.ok(out(status).includes('balanced'), `配置错误应点名被遮蔽的档名 balanced\n实际输出：${out(status)}`);
    const list = run(['strength', 'list'], { cwd: dir });
    assert.equal(list.code, 1, `list 同样不得静默回落内置档（exit 1），实得 ${list.code}\n${out(list)}`);
  });
});

describe('P3 收紧：policyHash 轴值变量隔离', RT, () => {
  const extractHash = (text) => {
    const m = text.match(/policyHash\s*[：:=]\s*([0-9a-fA-F]{8,})/);
    assert.ok(m, `输出缺 policyHash\n实际输出：${text}`);
    return m[1];
  };

  test('档名不变、仅一个轴值经 extends 收紧变化 → policyHash 必须变', (t) => {
    // 变量隔离（G1）：既有「同配置稳定；改任一轴值即变」用例同时改了档名
    // （balanced→team）与轴值，无法单独证明 hash 对轴值敏感。本用例档名恒为 team，
    // 只动 reviewRounds 2→3（2=基线值非降级，3=收紧，两种配置均合法）。
    const dir = strengthFixture(t, {
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 2 } } },
    });
    const first = run(['strength', 'status'], { cwd: dir });
    assert.equal(first.code, 0, out(first));
    write(dir, '.kimi-base/strength.json', JSON.stringify({
      version: 1,
      profile: 'team',
      customProfiles: { team: { extends: 'balanced', axes: { reviewRounds: 3 } } },
    }, null, 2));
    const second = run(['strength', 'status'], { cwd: dir });
    assert.equal(second.code, 0, out(second));
    assert.notEqual(extractHash(out(second)), extractHash(out(first)), '档名不变仅改一个轴值，policyHash 必须变化');
  });
});

describe('P3 收紧：decision log 截断保新', RT, () => {
  test('预置 200 条种子后解析一次 → ≤200 条且尾部必须是本次解析（防 slice(0,200) 丢新留旧）', (t) => {
    // 边界语义（G2）：截断必须丢旧留新。slice(0, 200) 形态条数同样 ≤200（既有有界
    // 用例查不出），但会丢掉本次解析记录、永久留旧种子——必须断言尾部条目身份。
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });
    const seed = Array.from({ length: 200 }, (_, i) => JSON.stringify({ policyRevision: `seed-${i}`, inputDigest: 'seed', reasons: [] })).join('\n');
    write(dir, '.kimi-base/state/strength-decisions.jsonl', `${seed}\n`);
    const r = run(['strength', 'explain'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const lines = read(dir, '.kimi-base/state/strength-decisions.jsonl').trim().split('\n');
    assert.ok(lines.length <= 200, `decision log 必须有界 ≤200 条，实得 ${lines.length}`);
    const m = out(r).match(/policyHash\s*[：:=]\s*([0-9a-fA-F]{8,})/);
    assert.ok(m, `explain 输出缺 policyHash\n${out(r)}`);
    const last = JSON.parse(lines.at(-1));
    assert.equal(
      last.policyRevision,
      m[1],
      `截断后尾部必须是本次解析（policyRevision=本次 policyHash ${m[1]}），实得 ${JSON.stringify(last.policyRevision)}——疑似 slice(0,200) 丢新留旧`
    );
    assert.ok(!lines.some((line) => line.includes('"seed-0"')), '丢的必须是最旧种子（seed-0 方向），不得丢新条目');
  });
});

describe('P3 缺陷回归：strength 动词契约校验', RT, () => {
  test('未知 flag / 多余位置参数 / 重复 flag → exit 1 并点名违规项（不得旁路契约校验）', (t) => {
    // 锁定（D4）：strength 契约必须入 CONTRACTS 单源注册表（旧缺陷：单列于
    // STRENGTH_CONTRACT，assertContract 查表落空直接 return——契约约束全被旁路）。
    // 每个子断言除 exit 1 外必须点名违规 token，防「别处报错凑出 exit 1」假绿。
    const dir = strengthFixture(t, { version: 1, profile: 'balanced' });

    const bogus = run(['strength', 'status', '--bogus-flag'], { cwd: dir });
    assert.equal(bogus.code, 1, `未知 flag --bogus-flag 应 exit 1，实得 ${bogus.code}\n${out(bogus)}`);
    assert.ok(out(bogus).includes('bogus-flag'), `应点名未知 flag --bogus-flag\n实际输出：${out(bogus)}`);

    const extra = run(['strength', 'list', 'junk'], { cwd: dir });
    assert.equal(extra.code, 1, `多余位置参数 junk 应 exit 1，实得 ${extra.code}\n${out(extra)}`);
    assert.ok(out(extra).includes('junk'), `应点名多余位置参数 junk\n实际输出：${out(extra)}`);

    const dup = run(['strength', 'set', '--profile', 'rapid', '--profile', 'strict'], { cwd: dir });
    assert.equal(dup.code, 1, `重复 flag --profile 应 exit 1，实得 ${dup.code}\n${out(dup)}`);
    assert.ok(out(dup).includes('profile'), `应点名重复 flag --profile\n实际输出：${out(dup)}`);
  });
});
