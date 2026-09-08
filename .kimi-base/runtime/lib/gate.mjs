// lib/gate.mjs —— 质量门执行（gate 四态 + receipt）
// PASS/FAIL/BLOCKED/SKIPPED；缺命令 = BLOCKED；空计划 = BLOCKED；
// SKIPPED 仅 fast mode + allowFastSkip + 非 protected。

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { adrCheckRun, archCheckRun } from './arch.mjs';
import { bindingSurfaces } from './bindings.mjs';
import { lintCatalog } from './catalog.mjs';
import { TOOL_VERSION, blockedError, boundedTail, boundedText, contentHashOf, isPathInside, nowIso, runProcess, sha256, stableJson } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { runFitness } from './fitness.mjs';
import { git, gitFingerprint, requireGit } from './git.mjs';
import { appendLedgerRecord, ensureStateGitignore, writeEvidence, writeReceiptFile } from './ledger.mjs';
import { isProtectedCheck, loadMatrix, requiredPlan, topoOrderChecks, assertCheckTiers } from './matrix.mjs';
import { STATE_DIR } from './paths.mjs';
import { stateFile, withFileLock } from './state.mjs';
import { getActiveTask } from './tasks.mjs';

// 导出供 dod 分层电池复用（REQ-062）：检查 → 调用形态的唯一推导处，禁止第二份拷贝。
export function checkInvocation(check) {
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
    // Receipt v2 绑定面（REQ-053/ADR-0009）：策略/引擎/架构图三面，无配置显式 null。
    policyHash: planContext.bindings.policyHash,
    engineHash: planContext.bindings.engineHash,
    catalogHash: planContext.bindings.catalogHash,
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
      // REQ-055/D3/E3：外部 .log 永不入库（脱敏边界）——回执另携内联真实尾部（boundedTail
      // 先脱敏再截取，保尾不保头：尾部才是 decision-relevant 判定行），clone/换机后无需
      // 外部日志即可验链。
      evidenceMeta.evidenceTail = boundedTail(rawEvidence, 2000).trim() || '（无输出）';
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
  // REQ-054/ADR-0009 贷款账本化：fast 窗口内每条被跳检查记 kind=deferred 债务条目入哈希链。
  // 关窗/过期/删 fast-mode.json 均不清债；唯一偿还 = 窗口外同检查 fresh PASS（risk 报 FAST_MODE_DEBT）。
  // protected 与已执行 FAIL 走不到 SKIPPED 分支，永不产 DEFERRED。
  if (complete.status === 'SKIPPED' && complete.fastWindow) {
    const debt = {
      version: 1,
      kind: 'deferred',
      id: `debt-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`,
      taskId: complete.taskId,
      checkId: complete.checkId,
      checkKind: complete.checkKind,
      risk: complete.risk,
      windowId: complete.fastWindow,
      fingerprint: complete.fingerprint,
      reason: complete.reason,
      createdAt: nowIso()
    };
    await appendLedgerRecord(ctx, { ...debt, contentHash: contentHashOf(debt) });
  }
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
    // REQ-062：dry-run 是矩阵配置校验面——tier 必填在此执法（缺失/非法 exit 1 点名检查 id）。
    assertCheckTiers(matrix);
    return { dryRun: true, plan, planHash, task: task?.id ?? null, note: 'dry-run 只列计划不执行' };
  }
  await requireGit(ctx, 'gate');
  const fingerprint = await gitFingerprint(ctx);
  if (ordered.length === 0 && missingKinds.length === 0) {
    throw blockedError('验证计划为空：没有任何检查被选中；空计划不是绿灯', 'EMPTY_PLAN');
  }
  // Receipt v2 绑定面（REQ-053）：一次解析，全批回执共用；无配置的面显式 null。
  const bindings = await bindingSurfaces(ctx);
  // REQ-055：state/.gitignore 与证据模式对齐（committed 放行账本/回执，证据日志永不入库）。
  await ensureStateGitignore(ctx);
  if (ctx.evidenceMode === 'committed') {
    // D4：根 .gitignore 若排除 .kimi-base/state/，嵌套 state/.gitignore 的例外规则捞不回
    //（git 规则：父目录被排除即不下降）——gate 前探测，响亮阻断并给可操作修法，
    // 而不是让 git add 裸报 GIT_FAILED。
    const probe = await git(ctx, ['check-ignore', '-q', '--', STATE_DIR], { allowFailure: true });
    if (probe.status === 'PASS' && probe.exitCode === 0) {
      throw blockedError(
        `committed 证据模式与根 .gitignore 冲突：根 .gitignore 排除了 ${STATE_DIR}/（嵌套 state/.gitignore 捞不回被排除的父目录），回执与账本无法入库。修法：从根 .gitignore 删除/移除该排除行，或为 ${STATE_DIR}/ 设例外规则（! 前缀 unignore），或改回 evidence.mode: "local"`,
        'EVIDENCE_GITIGNORE_CONFLICT'
      );
    }
  }
  const planContext = { task, risk, fingerprint: fingerprint.fingerprint, baseCommit: fingerprint.baseCommit, bindings };
  const fast = await fastModeStatus(ctx);
  const results = new Map();
  for (const kind of missingKinds) {
    const receipt = {
      version: 1, kind: 'verification',
      id: `rcpt-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`,
      taskId: task?.id ?? null, checkId: `${kind}:__missing__`, checkKind: kind, risk,
      fingerprint: fingerprint.fingerprint, baseCommit: fingerprint.baseCommit,
      policyHash: bindings.policyHash, engineHash: bindings.engineHash, catalogHash: bindings.catalogHash,
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
  // REQ-055 committed 模式：把未忽略的 state 证据（账本/回执/.gitignore）纳入 git index，
  // 使 git status/ls-files 可见、随用户提交入库（git add 尊重 ignore 规则——证据日志本体
  // 与其余运行态物理上进不了 index）。不自动提交：提交史是用户的。
  if (ctx.evidenceMode === 'committed') {
    await git(ctx, ['add', '--', STATE_DIR]);
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
