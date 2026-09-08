/**
 * tests/feedback.test.mjs
 * REQ-058 feedback 引擎化（feedback record/list/scan/propose 动词族）的行为测试——
 * 红测先行于实现，已随 v3.0 P6 落地转绿（Product-Spec.md 第 5 节「v3.0 强度可计算的治理」
 * REQ-058，设计依据 docs/adr/0010-feedback-engine.md）。本文件对 REQ-058 的字面引用即
 * 正当追溯。
 *
 * 运行：node --test tests/feedback.test.mjs
 *
 * 纪律（同 strength.test.mjs / receipt-v2.test.mjs）：临时目录夹具、真实 CLI 子进程、
 * 断言退出码与输出字段、不依赖 .kimi-base/state/ 残留。错误 token（HarnessError 走
 * stderr）一律用 out(r)=stdout+stderr 合并视图，只断字段性 token。feedback 四动词是
 * 纯文件操作（契约未要求 git），夹具一律最小 harness.json 项目，不依赖 git；安装载荷
 * 用例参照 receipt-v2「local 模式」先例：复制源仓载荷到临时 src 再 install 进目标。
 *
 * 红测先行记录：写测时点特性未实现，全部用例红（红因=行为缺失：未知动词 feedback /
 * .kimi-base/feedback/ 不在安装复制面）；落地后全绿，本文件现为 REQ-058 契约回归锁。
 * 防假绿纪律保留：exit 1 类用例（缺参数/非法 type/未知 flag）会被「未知动词 exit 1」
 * 凑绿——每个此类用例必须同时断言点名违规项且不报「未知动词」。
 *
 * 既有套件影响（历史记录，已闭环）：feedback 入 CONTRACTS 时 tests/cli-contracts.test.mjs
 * 的现状表与 selftest 动词集钉死由实现方同 commit 扩表同步（strength 的 STRENGTH_CONTRACT
 * 先例：扩表后并入 CONTRACTS）。
 *
 * 契约歧义点的选定解释（逐条注释在用例处）：
 *   1) 五类 type 的机器 token：契约只说「五类之一」（feedback-writer 五类信号），选定
 *      kebab 英文 token：user-correction / uncovered-scenario / repeated-operation /
 *      quality-issue / skill-effectiveness。
 *   2) topic 归一化口径（契约 8「大小写/空白归一化」）：trim + 小写 + 连续空白/下划线
 *      折叠为单连字符；同主题判定 = 归一化后字符串相等；条目文件 =
 *      .kimi-base/feedback/<归一化 topic>.md。
 *   3) 「同失败模式跨文件聚类 3+」最小口径（契约 5 括注）：type 相同且 topic 互异
 *      （不同文件）≥3 → 聚类候选，模式字段 = type。
 *   4) 「无覆盖模式 occurrences≥5 → 新 skill 候选」最小口径：type=repeated-operation
 *      （feedback-writer 信号 3「重复操作」= 无 Skill 支持）且 occurrences≥5。
 *   5) scan/propose 的「结构化」：选定输出行内含 topic、occurrences、候选类别 token
 *      （候选/聚类/新 skill），不要求 JSON（契约未定输出格式）；scan 退出码恒 0。
 *   6) propose 目标优先级（可执行 check > fitness 规则 > skill 步骤 > AGENTS.md 散文）：
 *      每条提议必须点名一个目标层（token 断言）；优先级排序本身不做机械断言——
 *      目标层映射是实现判断，排序正确性留给评审（红测只锁「点名目标层 + 证据指针 +
 *      永不落盘规则」这三条可判定语义）。
 *   7) record「返回条目路径」：stdout 含 .kimi-base/feedback/<topic>.md。
 *   8) 安装载荷的「一条示例条目」：不断言具体文件名——install 后 .kimi-base/feedback/
 *      下除 FEEDBACK-INDEX.md 外至少再有一个 .md（含 templates/ 子目录形态，
 *      兼容 installer isStableAsset 的 feedback 白名单先例）。
 *   9) skipped 语义：propose --skip 只标 frontmatter skipped:true（不删条目），之后
 *      scan 不再报该主题、propose 不再提议该主题；graduated:true 条目同样不进候选。
 *  10) updated「刷新」：同日运行无法区分秒级刷新——断言 updated 为合法 YYYY-MM-DD
 *      且 ≥ created；刷新语义主要由 occurrences 递增与 INDEX 行同步断言承载。
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
const RT = RUNTIME_OK ? {} : { skip: '.kimi-base/runtime/kimi-base.mjs 未就绪' };

// ---------------- 基础辅助（同 strength.test.mjs / receipt-v2.test.mjs 惯例） ----------------

function mkdtemp(t, prefix = 'kimi-base-feedback-') {
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

/** 递归列出相对路径（posix 风格） */
function listFiles(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc.sort();
}

// ---------------- 夹具 ----------------

/** 仅含 harness.json 标记的最小项目（needProject 只要求 CONFIG_REL 存在；feedback 是纯文件操作）。 */
function feedbackFixture(t) {
  const dir = mkdtemp(t);
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1 }, null, 2));
  return dir;
}

/** 五类 type token（契约歧义点 1 的选定解释）。 */
const TYPES = ['user-correction', 'uncovered-scenario', 'repeated-operation', 'quality-issue', 'skill-effectiveness'];

/**
 * 按契约 2 的 frontmatter 形状手写 feedback 条目（scan/propose 夹具用——与 record 解耦，
 * 保证 scan/propose 用例钉的是 scan/propose 本身而非 record 前置）。
 */
function writeFeedbackEntry(dir, topic, fields = {}) {
  const fm = {
    type: fields.type ?? 'quality-issue',
    description: fields.description ?? `${topic} 的描述`,
    created: fields.created ?? '2026-09-01',
    updated: fields.updated ?? '2026-09-01',
    occurrences: fields.occurrences ?? 1,
    graduated: fields.graduated ?? false,
    skipped: fields.skipped ?? false,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  write(dir, `.kimi-base/feedback/${topic}.md`, `---\n${lines.join('\n')}\n---\n\n## 信号\n夹具信号。\n`);
  return `.kimi-base/feedback/${topic}.md`;
}

/** 解析 md frontmatter 为 {key: stringValue}（缺 frontmatter 即断言失败）。 */
function parseFrontmatter(md, label) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, `${label}：缺 frontmatter\n实际内容：${md.slice(0, 300)}`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

const FEEDBACK_FRONTMATTER_KEYS = ['type', 'description', 'created', 'updated', 'occurrences', 'graduated', 'skipped'];

/** 断言条目 frontmatter 契约 2 的七键齐备。 */
function assertEntryFrontmatter(fm, label) {
  for (const key of FEEDBACK_FRONTMATTER_KEYS) {
    assert.ok(key in fm, `${label}：frontmatter 缺键 ${key}（契约 2 七键），实得键：${Object.keys(fm).join(',')}`);
  }
  assert.match(fm.created, /^\d{4}-\d{2}-\d{2}$/, `${label}：created 必须是 YYYY-MM-DD，实得 ${fm.created}`);
  assert.match(fm.updated, /^\d{4}-\d{2}-\d{2}$/, `${label}：updated 必须是 YYYY-MM-DD，实得 ${fm.updated}`);
  assert.ok(Number.isInteger(Number(fm.occurrences)) && Number(fm.occurrences) >= 1,
    `${label}：occurrences 必须是正整数，实得 ${fm.occurrences}`);
}

/** 目录树内容快照（rel → sha256），scan 只读 / propose 不改规则断言用。 */
function snapshotTree(dir, { exclude = () => false } = {}) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const rel of listFiles(dir)) {
    if (exclude(rel)) continue;
    map.set(rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex'));
  }
  return map;
}

function assertTreeUnchanged(before, after, label) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}：文件集不得变化`);
  for (const [rel, hash] of before) {
    assert.equal(after.get(rel), hash, `${label}：${rel} 内容不得变化`);
  }
}

// ---------------- 契约 1：feedback 动词接入 CLI 契约注册表 ----------------

describe('feedback 动词注册与契约校验（契约 1）', RT, () => {
  test('feedback --help 列出 record/list/scan/propose 四子命令', () => {
    // 锁定：HELP_VERBS 必须有 feedback 条目并列出四子命令。
    const r = run(['feedback', '--help']);
    assert.equal(r.code, 0, out(r));
    assert.ok(out(r).includes('feedback'), `help 必须含 feedback 动词条目\n实际输出：${out(r)}`);
    for (const sub of ['record', 'list', 'scan', 'propose']) {
      assert.ok(out(r).includes(sub), `help 必须列出子命令 ${sub}\n实际输出：${out(r)}`);
    }
  });

  test('feedback 子命令的未知 flag → exit 1 且点名违规 flag（契约校验不得旁路，strength D4 先例）', (t) => {
    // 防假绿：feedback 若未注册，contractOf 查表落空会报「未知动词」exit 1 凑绿——
    // 必须同时断言点名违规 flag 且不报「未知动词」。
    const dir = feedbackFixture(t);
    const r = run(['feedback', 'list', '--bogus-flag'], { cwd: dir });
    assert.equal(r.code, 1, `未知 flag 应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('bogus-flag'), `应点名未知 flag --bogus-flag\n实际输出：${out(r)}`);
    assert.doesNotMatch(out(r), /未知动词/, `契约校验失败不得报「未知动词」（证明 feedback 已注册）\n实际输出：${out(r)}`);
  });
});

// ---------------- 契约 2/3/8：feedback record ----------------

describe('feedback record（契约 2/3/8）', RT, () => {
  test('新建条目：落盘 .kimi-base/feedback/<topic>.md（七键 frontmatter）+ 机器维护 INDEX + 返回条目路径', (t) => {
    // 锁定：record 落盘条目 + 机器维护 INDEX + 返回条目路径。
    const dir = feedbackFixture(t);
    const r = run(['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', '测试间歇失败'], { cwd: dir });
    assert.equal(r.code, 0, `record 应 exit 0，实得 ${r.code}\n${out(r)}`);
    // 契约 7（歧义点选定）：返回条目路径。
    assert.match(out(r), /\.kimi-base\/feedback\/flaky-test\.md/, `stdout 必须返回条目路径\n实际输出：${out(r)}`);
    assert.ok(exists(dir, '.kimi-base/feedback/flaky-test.md'), '条目文件必须落盘');
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assertEntryFrontmatter(fm, 'flaky-test');
    assert.equal(fm.type, 'quality-issue', `type 必须如实写入，实得 ${fm.type}`);
    assert.equal(fm.description, '测试间歇失败', `description 必须如实写入，实得 ${fm.description}`);
    assert.equal(Number(fm.occurrences), 1, `新建条目 occurrences 必须为 1，实得 ${fm.occurrences}`);
    assert.equal(fm.graduated, 'false', `新建条目 graduated 必须为 false，实得 ${fm.graduated}`);
    assert.equal(fm.skipped, 'false', `新建条目 skipped 必须为 false，实得 ${fm.skipped}`);
    // INDEX 由引擎单一维护（ADR-0010：索引不再是手工台账）。
    assert.ok(exists(dir, '.kimi-base/feedback/FEEDBACK-INDEX.md'), 'record 必须机器创建/维护 FEEDBACK-INDEX.md');
    const index = read(dir, '.kimi-base/feedback/FEEDBACK-INDEX.md');
    assert.ok(index.includes('flaky-test'), `INDEX 必须含条目行（topic）\n实际内容：${index}`);
  });

  test('同主题去重：occurrences+1、updated 刷新、INDEX 行同步、不产生第二个文件', (t) => {
    const dir = feedbackFixture(t);
    const first = run(['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', '测试间歇失败'], { cwd: dir });
    assert.equal(first.code, 0, out(first));
    const second = run(['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', '又一次间歇失败'], { cwd: dir });
    assert.equal(second.code, 0, `同主题再记录应 exit 0（去重），实得 ${second.code}\n${out(second)}`);
    const files = listFiles(path.join(dir, '.kimi-base', 'feedback')).filter((f) => f.endsWith('.md') && f !== 'FEEDBACK-INDEX.md');
    assert.deepEqual(files, ['flaky-test.md'], `同主题去重不得产生第二个文件，实得：${files.join(',')}`);
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 2, `同主题去重 occurrences 必须 +1（=2），实得 ${fm.occurrences}`);
    // 歧义点 10：同日运行，updated 合法且 ≥ created 即通过；刷新语义主要靠计数与 INDEX 同步承载。
    assert.ok(fm.updated >= fm.created, `updated（${fm.updated}）不得早于 created（${fm.created}）`);
    const indexLine = read(dir, '.kimi-base/feedback/FEEDBACK-INDEX.md').split('\n').find((line) => line.includes('flaky-test'));
    assert.ok(indexLine, 'INDEX 必须含 flaky-test 行');
    assert.match(indexLine, /occurrences\D*2/, `INDEX 行必须同步 occurrences=2\n实际行：${indexLine}`);
  });

  test('同主题判定归一化（契约 8）："Flaky Test" 与 "flaky-test" 是同主题（大小写/空白归一）', (t) => {
    const dir = feedbackFixture(t);
    const first = run(['feedback', 'record', '--topic', 'Flaky Test', '--type', 'quality-issue', '--description', '测试间歇失败'], { cwd: dir });
    assert.equal(first.code, 0, out(first));
    const second = run(['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', '又一次'], { cwd: dir });
    assert.equal(second.code, 0, out(second));
    // 歧义点 2：归一化为 kebab——单文件 flaky-test.md，occurrences=2。
    const files = listFiles(path.join(dir, '.kimi-base', 'feedback')).filter((f) => f.endsWith('.md') && f !== 'FEEDBACK-INDEX.md');
    assert.deepEqual(files, ['flaky-test.md'], `大小写/空白归一化后必须落同一文件，实得：${files.join(',')}`);
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 2, `归一化判定为同主题，occurrences 必须为 2，实得 ${fm.occurrences}`);
  });

  test('缺参数 exit 1 且点名缺失 flag：--topic / --type / --description 各缺一', (t) => {
    // 防假绿：未知动词 exit 1 会凑绿退出码——必须同时断言点名缺失 flag 且不报未知动词。
    const dir = feedbackFixture(t);
    const cases = [
      { args: ['feedback', 'record', '--type', 'quality-issue', '--description', 'x'], missing: 'topic' },
      { args: ['feedback', 'record', '--topic', 'flaky-test', '--description', 'x'], missing: 'type' },
      { args: ['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue'], missing: 'description' },
    ];
    for (const { args, missing } of cases) {
      const r = run(args, { cwd: dir });
      assert.equal(r.code, 1, `缺 --${missing} 应 exit 1，实得 ${r.code}\n${out(r)}`);
      assert.ok(out(r).includes(missing), `缺参报错必须点名 --${missing}\n实际输出：${out(r)}`);
      assert.doesNotMatch(out(r), /未知动词/, `缺参报错不得是「未知动词」（防假绿）\n实际输出：${out(r)}`);
    }
  });

  test('非法 type（五类之外）→ exit 1 且点名非法值与合法集', (t) => {
    // 防假绿：未知动词 exit 1 凑绿——必须点名非法值且不报未知动词。
    const dir = feedbackFixture(t);
    const r = run(['feedback', 'record', '--topic', 'flaky-test', '--type', 'bogus-type', '--description', 'x'], { cwd: dir });
    assert.equal(r.code, 1, `非法 type 应 exit 1，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('bogus-type'), `应点名非法 type 值 bogus-type\n实际输出：${out(r)}`);
    assert.doesNotMatch(out(r), /未知动词/, `非法 type 报错不得是「未知动词」（防假绿）\n实际输出：${out(r)}`);
    for (const type of TYPES) {
      assert.ok(out(r).includes(type), `合法集应列出 ${type}\n实际输出：${out(r)}`);
    }
  });
});

// ---------------- 契约 4：feedback list ----------------

describe('feedback list（契约 4）', RT, () => {
  test('列全部条目：主题/类型/occurrences/graduated/skipped 五字段可见', (t) => {
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { type: 'quality-issue', occurrences: 2 });
    writeFeedbackEntry(dir, 'batch-import', { type: 'repeated-operation', occurrences: 5, skipped: true });
    const r = run(['feedback', 'list'], { cwd: dir });
    assert.equal(r.code, 0, `list 应 exit 0，实得 ${r.code}\n${out(r)}`);
    for (const topic of ['flaky-test', 'batch-import']) {
      assert.ok(out(r).includes(topic), `list 必须列出主题 ${topic}\n实际输出：${out(r)}`);
    }
    for (const type of ['quality-issue', 'repeated-operation']) {
      assert.ok(out(r).includes(type), `list 必须显示类型 ${type}\n实际输出：${out(r)}`);
    }
    assert.match(out(r), /occurrences|次数/, `list 必须显示 occurrences\n实际输出：${out(r)}`);
    assert.match(out(r), /graduated|毕业/, `list 必须显示 graduated 状态\n实际输出：${out(r)}`);
    assert.match(out(r), /skipped|跳过/, `list 必须显示 skipped 状态\n实际输出：${out(r)}`);
  });

  test('空 feedback 目录 → exit 0 且显式报告空（不是崩溃也不是假数据）', (t) => {
    // 空集语义选定：exit 0 + 显式空报告。
    const dir = feedbackFixture(t);
    const r = run(['feedback', 'list'], { cwd: dir });
    assert.equal(r.code, 0, `空目录 list 应 exit 0，实得 ${r.code}\n${out(r)}`);
    assert.match(out(r), /无|空|0/, `空目录必须显式报告\n实际输出：${out(r)}`);
  });
});

// ---------------- 契约 5：feedback scan（聚类毕业候选，只读） ----------------

describe('feedback scan（契约 5）', RT, () => {
  test('单条 occurrences≥3 且未毕业未跳过 → 毕业候选（含 topic 与 occurrences）', (t) => {
    // 手写条目夹具与 record 解耦。
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: 3 });
    const r = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, `scan 应 exit 0，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('flaky-test'), `候选清单必须含 topic flaky-test\n实际输出：${out(r)}`);
    assert.match(out(r), /候选|candidate/i, `必须显式标注候选类别\n实际输出：${out(r)}`);
    assert.match(out(r), /occurrences\D*3|3\s*次/, `候选必须携带 occurrences=3 证据\n实际输出：${out(r)}`);
  });

  test('occurrences≥3 但 graduated:true / skipped:true → 不进候选（宁漏不滥）', (t) => {
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'already-graduated', { occurrences: 9, graduated: true });
    writeFeedbackEntry(dir, 'user-skipped', { occurrences: 9, skipped: true });
    const r = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, `scan 应 exit 0，实得 ${r.code}\n${out(r)}`);
    assert.ok(!out(r).includes('already-graduated'), `graduated 条目不得再进候选\n实际输出：${out(r)}`);
    assert.ok(!out(r).includes('user-skipped'), `skipped 条目不得再进候选\n实际输出：${out(r)}`);
  });

  test('同失败模式跨文件聚类 3+（同 type、3 个不同 topic、各 occurrences 1）→ 聚类候选', (t) => {
    // 歧义点 3：模式字段=type 相同即可的最小口径。
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'naming-drift-a', { type: 'quality-issue', occurrences: 1 });
    writeFeedbackEntry(dir, 'naming-drift-b', { type: 'quality-issue', occurrences: 1 });
    writeFeedbackEntry(dir, 'naming-drift-c', { type: 'quality-issue', occurrences: 1 });
    const r = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.match(out(r), /聚类|cluster/i, `同模式跨文件 3+ 必须产出聚类候选\n实际输出：${out(r)}`);
    assert.ok(out(r).includes('quality-issue'), `聚类候选必须点名模式（type）\n实际输出：${out(r)}`);
  });

  test('同 type 仅 2 个 topic → 不产聚类候选（阈值边界）', (t) => {
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'naming-drift-a', { type: 'quality-issue', occurrences: 1 });
    writeFeedbackEntry(dir, 'naming-drift-b', { type: 'quality-issue', occurrences: 1 });
    const r = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.doesNotMatch(out(r), /聚类|cluster/i, `2 < 3 不得产聚类候选\n实际输出：${out(r)}`);
  });

  test('无覆盖模式 occurrences≥5（type=repeated-operation）→ 新 skill 候选', (t) => {
    // 歧义点 4：repeated-operation=无 Skill 覆盖信号类。
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'batch-import', { type: 'repeated-operation', occurrences: 5 });
    const r = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assert.ok(out(r).includes('batch-import'), `候选清单必须含 topic\n实际输出：${out(r)}`);
    assert.match(out(r), /新\s*skill|new[- ]skill/i, `occurrences≥5 无覆盖模式必须标新 skill 候选\n实际输出：${out(r)}`);
  });

  test('scan 只读：.kimi-base/feedback 与 harness.json 逐字节不变（不改任何规则/条目）', (t) => {
    // ADR-0010：scan 只读，不改任何规则。
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: 3 });
    // state/ 是运行态（引擎自由写），排除在只读断言面外。
    const before = snapshotTree(dir, { exclude: (rel) => rel.startsWith('.kimi-base/state/') });
    const r = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assertTreeUnchanged(before, snapshotTree(dir, { exclude: (rel) => rel.startsWith('.kimi-base/state/') }), 'scan 只读');
  });
});

// ---------------- 契约 6：feedback propose（结构化提议，永不自动改规则） ----------------

describe('feedback propose（契约 6）', RT, () => {
  test('每个候选产结构化提议：点名目标层（check>fitness>skill>AGENTS.md）+ 证据指针（feedback id + occurrences）', (t) => {
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: 3 });
    const r = run(['feedback', 'propose'], { cwd: dir });
    assert.equal(r.code, 0, `propose 应 exit 0，实得 ${r.code}\n${out(r)}`);
    assert.ok(out(r).includes('flaky-test'), `提议必须含证据指针（feedback id=topic）\n实际输出：${out(r)}`);
    assert.match(out(r), /occurrences\D*3|3\s*次/, `提议必须含证据指针（occurrences=3）\n实际输出：${out(r)}`);
    // 歧义点 6：每条提议必须点名一个目标层；优先级排序不机械断言。
    assert.match(out(r), /check|fitness|skill|AGENTS\.md/i,
      `提议必须点名目标层（可执行 check > fitness 规则 > skill 步骤 > AGENTS.md 散文）\n实际输出：${out(r)}`);
    assert.match(out(r), /提议|proposal/i, `必须显式标注为提议（非既成事实）\n实际输出：${out(r)}`);
  });

  test('永不自动改规则：propose 后 AGENTS.md / .kimi-base/rules/ / .kimi-code/skills/ 逐字节不变', (t) => {
    // ADR-0010 机制红线：引擎永不自动改规则，
    // 落地恒需人工确认——提议只输出不落盘规则文件。
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: 3 });
    // 规则面哨兵文件：propose 若自动毕业必动其中之一。
    write(dir, 'AGENTS.md', '# 哨兵 AGENTS\n规则原文不得被引擎改动。\n');
    write(dir, '.kimi-base/rules/guard.md', '# 哨兵规则\n不得被引擎改动。\n');
    write(dir, '.kimi-code/skills/demo/SKILL.md', '---\nname: demo\ndescription: 哨兵\n---\n不得被引擎改动。\n');
    const before = snapshotTree(dir, { exclude: (rel) => rel.startsWith('.kimi-base/state/') });
    const r = run(['feedback', 'propose'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    assertTreeUnchanged(before, snapshotTree(dir, { exclude: (rel) => rel.startsWith('.kimi-base/state/') }),
      'propose 永不自动改规则（规则面与 feedback 条目均不得被写）');
  });

  test('propose --skip <topic>：记 skipped:true；之后 scan 不再报该主题、propose 不再提议它', (t) => {
    // ADR-0010：被拒提议记 skipped:true 不再重复提议。
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: 3 });
    writeFeedbackEntry(dir, 'other-topic', { occurrences: 4 });
    const skip = run(['feedback', 'propose', '--skip', 'flaky-test'], { cwd: dir });
    assert.equal(skip.code, 0, `--skip 应 exit 0，实得 ${skip.code}\n${out(skip)}`);
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(fm.skipped, 'true', `--skip 必须记 frontmatter skipped:true，实得 ${fm.skipped}`);
    // 未 skip 的条目不受影响。
    const other = parseFrontmatter(read(dir, '.kimi-base/feedback/other-topic.md'), 'other-topic');
    assert.equal(other.skipped, 'false', `未被 skip 的条目 skipped 必须保持 false，实得 ${other.skipped}`);
    const scan = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(scan.code, 0, out(scan));
    assert.ok(!out(scan).includes('flaky-test'), `skip 后 scan 不得再报该主题\n实际输出：${out(scan)}`);
    assert.ok(out(scan).includes('other-topic'), `skip 不得株连其他候选\n实际输出：${out(scan)}`);
    const propose = run(['feedback', 'propose'], { cwd: dir });
    assert.equal(propose.code, 0, out(propose));
    assert.ok(!out(propose).includes('flaky-test'), `skip 后 propose 不得再提议该主题\n实际输出：${out(propose)}`);
  });
});

// ---------------- 契约 7：安装载荷 ----------------

describe('安装载荷（契约 7）', RT, () => {
  /**
   * 参照 receipt-v2「local 模式」先例：复制源仓载荷到临时 src，从 src 的引擎 install 进目标。
   * .kimi-base/feedback 条件复制：源仓无该目录时跳过（install 照常成功），
   * 锁定落在目标侧断言——不造夹具错误冒充行为失败。
   */
  function installFixture(t) {
    const src = mkdtemp(t, 'kimi-base-src-');
    for (const sub of ['.kimi-base/runtime', '.kimi-base/rules', '.kimi-base/templates', '.kimi-base/audit', '.kimi-base/githooks', '.kimi-code']) {
      fs.cpSync(path.join(REPO, sub), path.join(src, sub), { recursive: true });
    }
    for (const f of ['adapters.json', 'state.README', 'harness.example.json', 'module-catalog.example.json', 'verification-matrix.example.json']) {
      fs.cpSync(path.join(REPO, '.kimi-base', f), path.join(src, '.kimi-base', f));
    }
    if (fs.existsSync(path.join(REPO, '.kimi-base', 'feedback'))) {
      fs.cpSync(path.join(REPO, '.kimi-base', 'feedback'), path.join(src, '.kimi-base', 'feedback'), { recursive: true });
    }
    const dir = mkdtemp(t);
    const srcRuntime = path.join(src, '.kimi-base', 'runtime', 'kimi-base.mjs');
    const install = run(['install', '.'], { cwd: dir, runtime: srcRuntime });
    assert.equal(install.code, 0, `install 应成功: ${out(install)}`);
    return { dir, srcRuntime };
  }

  test('install 后 .kimi-base/feedback/ 存在：FEEDBACK-INDEX.md 模板 + 至少一条示例条目', (t) => {
    // 锁定：安装面必须携带 .kimi-base/feedback（INDEX 模板 + 示例条目）。
    const { dir } = installFixture(t);
    assert.ok(exists(dir, '.kimi-base/feedback'), '安装面必须含 .kimi-base/feedback/ 目录');
    assert.ok(exists(dir, '.kimi-base/feedback/FEEDBACK-INDEX.md'), '安装面必须含 FEEDBACK-INDEX.md 模板');
    // 歧义点 8：示例条目落点不断言具体文件名（含 feedback/templates/ 白名单形态）。
    const mds = listFiles(path.join(dir, '.kimi-base', 'feedback')).filter((f) => f.endsWith('.md') && f !== 'FEEDBACK-INDEX.md');
    assert.ok(mds.length >= 1, `安装面必须含至少一条示例条目（INDEX 之外的 .md），实得：${mds.join(',') || '(无)'}`);
  });

  test('install 后 feedback list 直接可用（exit 0 且列出示例条目）', (t) => {
    const { dir, srcRuntime } = installFixture(t);
    const r = run(['feedback', 'list'], { cwd: dir, runtime: srcRuntime });
    assert.equal(r.code, 0, `新装项目的 feedback list 应 exit 0，实得 ${r.code}\n${out(r)}`);
    assert.match(out(r), /\S/, 'list 输出不得为空');
  });
});

// ---------------- P6 修复轮回归锁（评审 verdict=FIX_REQUIRED 驱动，correctness lens 实证） ----------------
// 缺陷锚点（P6 评审发现；红测先行随修复转绿，现为回归锁）：
//   1) 并发 record 丢计数——read-modify-write 无互斥（feedback.mjs record 读-改-写窗口），
//      10 并发实得 occurrences<10；
//   2) 损坏条目（缺 frontmatter）拖死全部四动词——readEntries 的 splitEntry 抛
//      FEEDBACK_ENTRY_INVALID，list/scan/propose 非零退出；
//   3) record 假失败真落盘双计——先写条目后 writeIndex 抛错：exit 非零但条目已落盘，
//      用户重试把同一信号计成 2 次。

describe('feedback record 并发与腐化韧性（P6 修复轮）', RT, () => {
  test('10 并发同主题 record → occurrences===10 且不产生第二个文件（读-改-写必须互斥）', async (t) => {
    const dir = feedbackFixture(t);
    const { spawn } = await import('node:child_process');
    const runAsync = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RUNTIME, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const results = await Promise.all([...Array(10)].map((_, index) =>
      runAsync(['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', `第 ${index + 1} 次间歇失败`])));
    for (const r of results) {
      assert.equal(r.code, 0, `并发 record 必须全部 exit 0\n${r.stdout}\n${r.stderr}`);
    }
    const files = listFiles(path.join(dir, '.kimi-base', 'feedback')).filter((f) => f.endsWith('.md') && f !== 'FEEDBACK-INDEX.md');
    assert.deepEqual(files, ['flaky-test.md'], `并发同主题不得产生第二个文件，实得：${files.join(',')}`);
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 10,
      `10 次并发 record 必须全部计数（occurrences===10），实得 ${fm.occurrences}——read-modify-write 丢计数`);
    const indexLine = read(dir, '.kimi-base/feedback/FEEDBACK-INDEX.md').split('\n').find((line) => line.includes('flaky-test'));
    assert.ok(indexLine, 'INDEX 必须含 flaky-test 行');
    assert.match(indexLine, /occurrences\D*10/, `INDEX 行必须同步 occurrences=10\n实际行：${indexLine}`);
  });

  test('损坏条目（缺 frontmatter）被隔离而非拖死四动词：list/scan/propose exit 0 + 隔离警告 + 有效条目照常', (t) => {
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: 3 });
    write(dir, '.kimi-base/feedback/broken-entry.md', '# 没有 frontmatter 的损坏条目\n正文。\n');
    const list = run(['feedback', 'list'], { cwd: dir });
    assert.equal(list.code, 0, `损坏条目在场时 list 应 exit 0（隔离不拖死），实得 ${list.code}\n${out(list)}`);
    assert.match(out(list), /corrupt|隔离/, `list 必须输出隔离警告\n实际输出：${out(list)}`);
    assert.ok(out(list).includes('broken-entry'), `隔离警告必须点名损坏条目\n实际输出：${out(list)}`);
    assert.ok(out(list).includes('flaky-test'), `损坏条目不得株连有效条目的列出\n实际输出：${out(list)}`);
    // 隔离 = 重命名为 <条目>.md.corrupt-<ts>（state.mjs quarantine 同款精神），不再以 .md 参与读取。
    assert.ok(!exists(dir, '.kimi-base/feedback/broken-entry.md'), '损坏条目必须被重命名隔离（原路径不再存在）');
    const quarantined = listFiles(path.join(dir, '.kimi-base', 'feedback')).filter((f) => f.startsWith('broken-entry.md.corrupt-'));
    assert.equal(quarantined.length, 1, `隔离文件名应为 broken-entry.md.corrupt-*，实得：${quarantined.join(',') || '(无)'}`);
    // 隔离后 scan/propose 照常工作且不再报该损坏条目（已被隔离）。
    const scan = run(['feedback', 'scan'], { cwd: dir });
    assert.equal(scan.code, 0, `scan 应 exit 0，实得 ${scan.code}\n${out(scan)}`);
    assert.ok(out(scan).includes('flaky-test'), `有效候选照常进 scan\n实际输出：${out(scan)}`);
    const propose = run(['feedback', 'propose'], { cwd: dir });
    assert.equal(propose.code, 0, `propose 应 exit 0，实得 ${propose.code}\n${out(propose)}`);
    assert.ok(out(propose).includes('flaky-test'), `有效候选照常进 propose\n实际输出：${out(propose)}`);
  });

  test('损坏条目在场时 record 可重入：首次 exit 0 且 occurrences=1，再次记录正常 +1（不假失败真落盘双计）', (t) => {
    const dir = feedbackFixture(t);
    write(dir, '.kimi-base/feedback/broken-entry.md', '损坏，无 frontmatter。\n');
    const args = ['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', '间歇失败'];
    const first = run(args, { cwd: dir });
    assert.equal(first.code, 0,
      `record 应 exit 0（损坏条目隔离后 INDEX 照常维护），实得 ${first.code}——假失败会诱使用户重试造成双计\n${out(first)}`);
    let fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 1, `首次 record occurrences=1，实得 ${fm.occurrences}`);
    const second = run(args, { cwd: dir });
    assert.equal(second.code, 0, out(second));
    fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 2, `再次记录正常去重 +1（=2），实得 ${fm.occurrences}`);
  });

  test('info 级锁定：非法 occurrences（负数）按 0 起计（record 后=1）——负计数递增永不毕业的静默死条', (t) => {
    const dir = feedbackFixture(t);
    writeFeedbackEntry(dir, 'flaky-test', { occurrences: -5 });
    const r = run(['feedback', 'record', '--topic', 'flaky-test', '--type', 'quality-issue', '--description', '又一次'], { cwd: dir });
    assert.equal(r.code, 0, out(r));
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 1, `非法 occurrences（-5）应按 0 起计 +1=1，实得 ${fm.occurrences}`);
  });

  test('info 级锁定：topic 归一化连字符折叠——flaky--test 与 Flaky Test 是同主题', (t) => {
    const dir = feedbackFixture(t);
    const first = run(['feedback', 'record', '--topic', 'flaky--test', '--type', 'quality-issue', '--description', '间歇失败'], { cwd: dir });
    assert.equal(first.code, 0, out(first));
    const second = run(['feedback', 'record', '--topic', 'Flaky Test', '--type', 'quality-issue', '--description', '又一次'], { cwd: dir });
    assert.equal(second.code, 0, out(second));
    const files = listFiles(path.join(dir, '.kimi-base', 'feedback')).filter((f) => f.endsWith('.md') && f !== 'FEEDBACK-INDEX.md');
    assert.deepEqual(files, ['flaky-test.md'], `连字符折叠后必须落同一文件，实得：${files.join(',')}`);
    const fm = parseFrontmatter(read(dir, '.kimi-base/feedback/flaky-test.md'), 'flaky-test');
    assert.equal(Number(fm.occurrences), 2, `归一化判定为同主题，occurrences 必须为 2，实得 ${fm.occurrences}`);
  });
});
