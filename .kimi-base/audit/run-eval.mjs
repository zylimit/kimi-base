#!/usr/bin/env node
// ============================================================================
// run-eval —— 自我 eval 套件执行器（REQ-066；独立审计脚本，禁止 import 引擎）
//
// 读取 <cwd>/tests/eval/manifest.json（{version, regression:[], capability:[]}，
// 条目为内联任务对象或相对 tests/eval/ 的任务 JSON 文件路径），逐任务机器判定：
//   - judge.command    ：在临时目录跑子进程（shell），断言退出码（expectExit，
//                        缺省 0）与可选 stdout 片段（expectStdout）；命令中 {REPO}
//                        占位符替换为被评测仓根，环境注入 KIMI_BASE_EVAL_REPO。
//   - judge.assertFile ：断言文件相对仓根存在且非空。
// 两套语义：
//   - regression（防回退）：任一失败 → exit 1 并在 failures 点名任务 id。
//   - capability（爬坡，允许当前失败）：默认不执行、只报告 total；
//     --include-capability 时执行并报告 passed/failed，但永不改退出码。
// 计数门禁：regression 单列 < 20（含空套）→ exit 1（没跑够就是没证明；
// capability 不计入门槛，防回退套不得用爬坡套注水补齐）；
// tests/eval 缺失 = regression 计数 0 < 20 → exit 1。
//
// 输出契约（同既有审计脚本）：诊断走 stderr，stdout 末行单行 JSON：
//   {ok, regression:{total,passed,failed,failures:[id...]},
//    capability:{total} | {total,passed,failed,failures:[id...]}}
// 退出码：0 全绿 / 1 用法错误·regression 失败·计数不足 / （capability 永不阻断）。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const MIN_TASKS = 20;
const TASK_TIMEOUT_MS = 300_000;

const repoRoot = process.cwd();
const evalDir = path.join(repoRoot, 'tests', 'eval');
// 命令模板里的 {REPO}：统一为正斜杠，Windows 上 node 与 cmd 都接受。
const repoToken = repoRoot.split(path.sep).join('/');

const note = (msg) => process.stderr.write(`run-eval: ${msg}\n`);

// ---------------- 参数（未知 flag = 用法错误 exit 1，绝不静默） ----------------

const args = process.argv.slice(2);
const KNOWN = new Set(['--include-capability']);
const unknown = args.filter((a) => !KNOWN.has(a));
if (unknown.length > 0) {
  note(`未知参数：${unknown.join(' ')}（支持：--include-capability）`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'usage', regression: { total: 0, passed: 0, failed: 0, failures: [] }, capability: { total: 0 } })}\n`);
  process.exit(1);
}
const includeCapability = args.includes('--include-capability');

// ---------------- 清单加载（与 tests/eval.test.mjs 的 loadSuite 同一契约形状） ----------------

function loadSuite() {
  const manifestPath = path.join(evalDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { regression: [], capability: [], error: `清单缺失：tests/eval/manifest.json（套件缺失 = 计数 0 < ${MIN_TASKS}）` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { regression: [], capability: [], error: `清单不可解析：${e.message}` };
  }
  const resolve = (entry, suite) => {
    if (typeof entry === 'string') {
      const taskPath = path.join(evalDir, entry);
      if (!fs.existsSync(taskPath)) throw new Error(`${suite} 条目指向的任务文件不存在：${entry}`);
      return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    }
    return entry;
  };
  try {
    return {
      regression: (Array.isArray(manifest.regression) ? manifest.regression : []).map((e) => resolve(e, 'regression')),
      capability: (Array.isArray(manifest.capability) ? manifest.capability : []).map((e) => resolve(e, 'capability')),
      error: null
    };
  } catch (e) {
    return { regression: [], capability: [], error: e.message };
  }
}

// ---------------- 单任务判定 ----------------

function runTask(task) {
  const judge = task.judge ?? {};
  if (typeof judge.assertFile === 'string' && judge.assertFile.trim()) {
    let st = null;
    try {
      st = fs.statSync(path.join(repoRoot, judge.assertFile));
    } catch {
      return { pass: false, note: `断言文件不存在：${judge.assertFile}` };
    }
    if (!st.isFile()) return { pass: false, note: `assertFile 不是常规文件：${judge.assertFile}` };
    if (st.size === 0) return { pass: false, note: `断言文件为空：${judge.assertFile}` };
    return { pass: true, note: '' };
  }
  if (typeof judge.command !== 'string' || !judge.command.trim()) {
    return { pass: false, note: 'judge 缺 command/assertFile（不可机器判定）' };
  }
  const expectExit = Number.isInteger(judge.expectExit) ? judge.expectExit : 0;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-base-eval-task-'));
  try {
    const r = spawnSync(judge.command.replaceAll('{REPO}', repoToken), {
      shell: true,
      cwd: workdir,
      timeout: TASK_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env, KIMI_BASE_EVAL_REPO: repoRoot, NO_COLOR: '1' }
    });
    if (r.error) return { pass: false, note: `判定命令启动失败：${r.error.message}` };
    if (r.status !== expectExit) {
      const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-5).join(' | ');
      return { pass: false, note: `退出码 ${r.status} ≠ 期望 ${expectExit}${tail ? `（输出尾部：${tail}）` : ''}` };
    }
    if (typeof judge.expectStdout === 'string' && judge.expectStdout
      && !(r.stdout ?? '').includes(judge.expectStdout)) {
      return { pass: false, note: `stdout 缺期望片段：${judge.expectStdout}` };
    }
    return { pass: true, note: '' };
  } finally {
    try {
      fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      note(`临时目录清理失败（残留由 OS 回收）: ${workdir} — ${e.code ?? e.message}`);
    }
  }
}

function runSuite(tasks, label) {
  const counts = { total: tasks.length, passed: 0, failed: 0, failures: [] };
  for (const task of tasks) {
    const id = typeof task?.id === 'string' && task.id.trim() ? task.id : '<无 id>';
    const result = runTask(task);
    if (result.pass) {
      counts.passed += 1;
      note(`[PASS] ${label}/${id}`);
    } else {
      counts.failed += 1;
      counts.failures.push(id);
      note(`[FAIL] ${label}/${id}——${result.note}`);
    }
  }
  return counts;
}

// ---------------- 主流程 ----------------

const suite = loadSuite();
if (suite.error) note(suite.error);

// 计数门禁（P10 评审修订）：门槛钉在 regression 单列——regression ≥20 且非空，
// capability 不计入（合计口径可被 capability 注水绕过：regression 空套 + 20 个
// capability 也全绿，防回退套名存实亡）。tests/eval 缺失 = regression 计数 0。
const total = suite.regression.length + suite.capability.length;
if (suite.regression.length < MIN_TASKS) {
  note(`regression 任务数 ${suite.regression.length} < ${MIN_TASKS}（capability 不计入门槛，合计 ${total} 也不算数）——没跑够就是没证明（exit 1）`);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: suite.error ?? 'suite-too-small',
    regression: { total: suite.regression.length, passed: 0, failed: 0, failures: [] },
    capability: { total: suite.capability.length }
  })}\n`);
  process.exit(1);
}

const regression = runSuite(suite.regression, 'regression');
let capability = { total: suite.capability.length };
if (includeCapability) {
  note('执行 capability 爬坡套（--include-capability）：结果只报告，永不阻断');
  capability = runSuite(suite.capability, 'capability');
} else {
  note(`capability 爬坡套默认不执行（${suite.capability.length} 个任务，只报计数）；--include-capability 可执行`);
}

const ok = regression.failed === 0;
process.stdout.write(`${JSON.stringify({ ok, regression, capability })}\n`);
note(`regression ${regression.passed}/${regression.total} 通过${regression.failed ? `，失败：${regression.failures.join(', ')}` : ''}`);
process.exit(ok ? 0 : 1);
