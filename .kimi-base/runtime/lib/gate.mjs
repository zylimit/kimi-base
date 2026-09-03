// lib/gate.mjs —— 质量门执行（gate 四态 + receipt）
// PASS/FAIL/BLOCKED/SKIPPED；缺命令 = BLOCKED；空计划 = BLOCKED；
// SKIPPED 仅 fast mode + allowFastSkip + 非 protected。

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { adrCheckRun, archCheckRun } from './arch.mjs';
import { lintCatalog } from './catalog.mjs';
import { TOOL_VERSION, blockedError, boundedText, contentHashOf, isPathInside, nowIso, runProcess, sha256, stableJson } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { runFitness } from './fitness.mjs';
import { gitFingerprint, requireGit } from './git.mjs';
import { appendLedgerRecord, writeEvidence, writeReceiptFile } from './ledger.mjs';
import { isProtectedCheck, loadMatrix, requiredPlan, topoOrderChecks } from './matrix.mjs';
import { stateFile, withFileLock } from './state.mjs';
import { getActiveTask } from './tasks.mjs';

function checkInvocation(check) {
  if (check.builtin) return { builtin: check.builtin, display: `builtin:${check.builtin}`, argvHash: sha256(stableJson({ builtin: check.builtin })) };
  if (check.executable) {
    return { executable: check.executable, args: check.args ?? [], shell: false, display: [check.executable, ...(check.args ?? [])].join(' '), argvHash: sha256(stableJson({ executable: check.executable, args: check.args ?? [] })) };
  }
  if (check.command) {
    return { executable: check.command, args: [], shell: true, display: check.command, argvHash: sha256(stableJson({ shell: check.command })) };
  }
  return null;
}

async function toolVersionOf(ctx, invocation) {
  if (invocation.builtin) return TOOL_VERSION;
  const name = invocation.shell ? (process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh')) : invocation.executable;
  if (path.basename(name).startsWith('node')) return process.version;
  const result = await runProcess(name, ['--version'], { cwd: ctx.root, timeoutMs: 2000, maxOutput: 2000 });
  return result.status === 'PASS' ? boundedText(result.stdout || result.stderr, 500).trim() : 'unavailable';
}

// 内置检查：让 fitness/arch/adr/catalog 以 receipt 形式进入同一证据机器。
async function runBuiltinCheck(ctx, name) {
  if (name === 'fitness') {
    const result = await runFitness(ctx, {});
    return { status: result.status, output: result.report };
  }
  if (name === 'arch-check') {
    const result = await archCheckRun(ctx, { scan: true });
    return { status: result.ok ? 'PASS' : 'FAIL', output: result.report };
  }
  if (name === 'adr-check') {
    const result = await adrCheckRun(ctx);
    return { status: result.ok ? 'PASS' : 'FAIL', output: result.report };
  }
  if (name === 'catalog-lint') {
    const result = await lintCatalog(ctx);
    return { status: result.ok ? 'PASS' : 'FAIL', output: `catalog lint：${result.total} 路径；失败 ${result.failures.length}\n${result.failures.slice(0, 50).map((item) => `- ${item.path}: ${item.reason ?? item.classification}`).join('\n')}` };
  }
  return { status: 'BLOCKED', output: `未知内置检查：${name}` };
}

async function withResourceLocks(ctx, names, callback, index = 0) {
  const sorted = [...new Set(names ?? [])].sort();
  if (index >= sorted.length) return callback();
  const lockPath = stateFile(ctx, path.join('resource-locks', `${sorted[index].replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`));
  return withFileLock(lockPath, ctx.locks, () => withResourceLocks(ctx, sorted, callback, index + 1));
}

async function executeCheck(ctx, check, planContext, dependencyResults, fast) {
  const started = Date.now();
  const invocation = checkInvocation(check);
  const base = {
    version: 1,
    kind: 'verification',
    id: `rcpt-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`,
    taskId: planContext.task?.id ?? null,
    checkId: check.id,
    checkKind: check.kind,
    risk: planContext.risk,
    fingerprint: planContext.fingerprint,
    baseCommit: planContext.baseCommit,
    argvHash: invocation?.argvHash ?? null,
    argvDisplay: invocation?.display ?? null,
    cwd: check.cwd ?? '.',
    tool: TOOL_VERSION,
    fastWindow: null,
    createdAt: nowIso()
  };
  // runtime 类证据（压测/拨测测的是部署中的系统，不是这棵树）：
  // 回执带 validUntil + time-window-<N>h 标签；时间窗内不随树指纹过期，窗口过期即不 fresh。
  if (check.class === 'runtime') {
    const hours = check.runtimeValidityHours ?? ctx.runtimeValidityHours;
    base.validUntil = new Date(Date.parse(base.createdAt) + hours * 3600000).toISOString();
    base.timeWindow = `time-window-${hours}h`;
  }
  let status;
  let exitCode = null;
  let reason = '';
  let output = '';
  const failedDeps = (check.dependsOn ?? []).filter((id) => !['PASS', 'SKIPPED'].includes(dependencyResults.get(id)?.status));
  if (!invocation) {
    status = 'BLOCKED';
    reason = '检查未配置 command/executable/builtin（缺命令 = BLOCKED，绝不假绿）';
  } else if (failedDeps.length) {
    status = 'BLOCKED';
    reason = `依赖检查未通过：${failedDeps.join(', ')}`;
  } else if (check.platform && check.platform.length && !check.platform.includes(process.platform)) {
    status = 'BLOCKED';
    reason = `平台不匹配：声明 ${check.platform.join('/')}，当前 ${process.platform}`;
  } else if (fast.active && check.allowFastSkip === true && !isProtectedCheck(check)) {
    status = 'SKIPPED';
    reason = `Fast Mode 生效（至 ${fast.expiresAt}），检查声明 allowFastSkip`;
    base.fastWindow = fast.windowId;
  } else {
    let result;
    if (invocation.builtin) {
      const builtinRun = await runBuiltinCheck(ctx, invocation.builtin);
      result = { status: builtinRun.status, exitCode: builtinRun.status === 'PASS' ? 0 : builtinRun.status === 'FAIL' ? 1 : null, stdout: builtinRun.output, stderr: '', timedOut: false };
    } else {
      const cwd = path.resolve(ctx.root, check.cwd ?? '.');
      if (!isPathInside(ctx.root, cwd)) {
        result = { status: 'BLOCKED', exitCode: null, stdout: '', stderr: '', timedOut: false, error: new Error(`检查 cwd 逃逸仓库：${check.cwd}`) };
      } else {
        result = await withResourceLocks(ctx, check.resourceLocks, () => runProcess(invocation.executable, invocation.args, {
          cwd,
          shell: invocation.shell,
          timeoutMs: check.timeoutMs ?? 120000,
          maxOutput: ctx.outputLimits.evidenceChars
        }));
      }
    }
    status = result.status;
    exitCode = result.exitCode ?? null;
    output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.timedOut) reason = `超时（${check.timeoutMs ?? 120000}ms）`;
    else if (result.error) reason = `无法启动：${result.error.message}`;
    else if (result.outputTruncated) reason = '输出超过上限被截断（坏测量，按 BLOCKED 处理）';
    if (result.outputTruncated) { status = 'BLOCKED'; exitCode = null; }
  }
  const durationMs = Date.now() - started;
  const rawEvidence = [reason, output].filter(Boolean).join('\n');
  let evidenceMeta = { evidencePath: null, evidenceSha256: null, evidenceBytes: 0 };
  if (rawEvidence.length > 0) {
    if (rawEvidence.length > 4000) {
      evidenceMeta = await writeEvidence(ctx, check.id, rawEvidence);
    } else {
      evidenceMeta.evidenceSha256 = sha256(rawEvidence);
      evidenceMeta.evidenceBytes = Buffer.byteLength(rawEvidence, 'utf8');
    }
  }
  const summary = boundedText(rawEvidence || reason || '（无输出）', 2000).trim() || '（无输出）';
  const receipt = {
    ...base,
    status,
    exitCode,
    durationMs,
    reason,
    summary,
    ...evidenceMeta,
    toolVersion: invocation ? await toolVersionOf(ctx, invocation).catch(() => 'unavailable') : 'unavailable'
  };
  const complete = { ...receipt, contentHash: contentHashOf(receipt) };
  await appendLedgerRecord(ctx, complete);
  await writeReceiptFile(ctx, complete);
  return complete;
}

export async function runGate(ctx, options = {}) {
  const matrix = await loadMatrix(ctx);
  const task = await getActiveTask(ctx);
  const risk = options.risk ?? task?.risk ?? ctx.riskDefault;
  const plan0 = requiredPlan(ctx, matrix, risk, options.kind ?? null);
  const kinds = plan0.kinds;
  const selected = plan0.checks;
  const byId = new Map(matrix.checks.map((check) => [check.id, check]));
  const selectedIds = new Set(selected.map((check) => check.id));
  // 依赖闭包：被依赖的检查即使不在选择内也必须先跑。
  const includeDeps = (id) => {
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!selectedIds.has(dependency)) {
        selectedIds.add(dependency);
        includeDeps(dependency);
      }
    }
  };
  for (const id of [...selectedIds]) includeDeps(id);
  const ordered = topoOrderChecks(matrix.checks).filter((check) => selectedIds.has(check.id));
  // 每个被选 kind 至少应有一个检查；缺配置的 kind 合成 BLOCKED（缺命令绝不假绿）。
  const missingKinds = plan0.missingKinds.filter((kind) => !ordered.some((check) => check.kind === kind));
  const plan = {
    risk,
    kinds,
    checks: ordered.map((check) => ({ id: check.id, kind: check.kind, display: checkInvocation(check)?.display ?? null, required: check.required !== false })),
    missingKinds
  };
  const planHash = sha256(stableJson(plan));
  if (options.dryRun) {
    return { dryRun: true, plan, planHash, task: task?.id ?? null, note: 'dry-run 只列计划不执行' };
  }
  await requireGit(ctx, 'gate');
  const fingerprint = await gitFingerprint(ctx);
  if (ordered.length === 0 && missingKinds.length === 0) {
    throw blockedError('验证计划为空：没有任何检查被选中；空计划不是绿灯', 'EMPTY_PLAN');
  }
  const planContext = { task, risk, fingerprint: fingerprint.fingerprint, baseCommit: fingerprint.baseCommit };
  const fast = await fastModeStatus(ctx);
  const results = new Map();
  for (const kind of missingKinds) {
    const receipt = {
      version: 1, kind: 'verification',
      id: `rcpt-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`,
      taskId: task?.id ?? null, checkId: `${kind}:__missing__`, checkKind: kind, risk,
      fingerprint: fingerprint.fingerprint, baseCommit: fingerprint.baseCommit,
      argvHash: null, argvDisplay: null, cwd: '.', tool: TOOL_VERSION, toolVersion: 'unavailable',
      fastWindow: null, status: 'BLOCKED', exitCode: null, durationMs: 0,
      reason: `kind ${kind} 在 verification-matrix 中没有任何检查命令`, summary: `kind ${kind} 无命令配置`,
      evidencePath: null, evidenceSha256: null, evidenceBytes: 0, createdAt: nowIso()
    };
    const complete = { ...receipt, contentHash: contentHashOf(receipt) };
    await appendLedgerRecord(ctx, complete);
    results.set(complete.checkId, complete);
  }
  for (const check of ordered) {
    results.set(check.id, await executeCheck(ctx, check, planContext, results, fast));
  }
  const receipts = [...results.values()];
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 };
  for (const receipt of receipts) counts[receipt.status] += 1;
  const overall = counts.FAIL > 0 ? 'FAIL'
    : counts.BLOCKED > 0 ? 'BLOCKED'
    : receipts.length > 0 && counts.SKIPPED === receipts.length ? 'BLOCKED'
    : 'PASS';
  return { dryRun: false, overall, counts, receipts, plan, planHash, task: task?.id ?? null, fingerprint: fingerprint.fingerprint, fastActive: fast.active };
}
