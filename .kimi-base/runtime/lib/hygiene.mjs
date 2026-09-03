// lib/hygiene.mjs —— risk scan / gate-audit / retention prune

import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchBaseline } from './arch.mjs';
import { PRE_BASH_RULE_IDS } from './classifier.mjs';
import { boundedText, nowIso, runProcess, toPosix } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { changedPaths } from './git.mjs';
import { latestReceipts, readLedgerEntries, verifyLedgerChain } from './ledger.mjs';
import { REVIEW_BACKLOG_FILE } from './paths.mjs';
import { lockOwnerAlive, quarantineEvents, readState, stateFile } from './state.mjs';
import { getActiveTask } from './tasks.mjs';

export async function riskScan(ctx, now = Date.now()) {
  const risks = [];
  const push = (level, kind, detail) => risks.push({ level, kind, detail });
  const task = await getActiveTask(ctx).catch(() => null);
  if (task) {
    const ageHours = (now - Date.parse(task.createdAt)) / 3600000;
    if (ageHours > 72) push('medium', 'stale-task', `active 任务 ${task.id} 已存在 ${Math.round(ageHours)} 小时；请完成、取消或重切`);
  }
  const ledger = await readLedgerEntries(ctx);
  const chain = verifyLedgerChain(ledger.entries, { archives: ledger.archives });
  if (!chain.intact) push('high', 'ledger-chain-broken', `证据账本哈希链断裂于第 ${chain.brokenAt + 1} 条：${chain.reason}`);
  // 同一检查连续 FAIL（fail streak）。
  const byCheck = new Map();
  for (const entry of ledger.entries) {
    if (entry.__corrupt || entry.kind !== 'verification') continue;
    const list = byCheck.get(entry.checkId) ?? [];
    list.push(entry);
    byCheck.set(entry.checkId, list);
  }
  for (const [checkId, list] of byCheck) {
    let streak = 0;
    for (let index = list.length - 1; index >= 0 && list[index].status === 'FAIL'; index -= 1) streak += 1;
    if (streak >= 3) push('high', 'fail-streak', `检查 ${checkId} 连续 FAIL ${streak} 次；停止重试，先做根因分析`);
  }
  const fast = await fastModeStatus(ctx, now);
  if (fast.expired) push('medium', 'fast-mode-expired', 'Fast Mode 已过期但未显式关闭；旧 SKIPPED 回执不再算数');
  const strikes = await readState(ctx, 'stop-strikes.json', { version: 1, key: null, count: 0 });
  if ((strikes.count ?? 0) >= 2) push('medium', 'stop-strikes', `Stop 门已连拦 ${strikes.count} 次同一状态；到 ${ctx.hooks.stopFuseLimit} 次将保险丝放行并要求人工复核`);
  for (const event of (await quarantineEvents(ctx)).slice(-5)) {
    push('high', 'state-quarantined', `状态文件 ${event.file} 腐化被隔离为 ${event.quarantinedAs ?? '未知'}；请确认没有丢工作`);
  }
  // 评审 backlog 过期债：挂账有截止日，过期即风险（backlog 跨会话持久，见 lib/review.mjs）。
  const backlog = await readState(ctx, REVIEW_BACKLOG_FILE, { version: 1, entries: [] });
  const expiredBacklog = (backlog.entries ?? []).filter((entry) => Date.parse(entry.expiry) <= now);
  if (expiredBacklog.length) {
    push('medium', 'review-backlog-expired', `评审 backlog 有 ${expiredBacklog.length} 条已过期：${expiredBacklog.slice(0, 3).map((entry) => `${entry.id ?? '?'}（${entry.owner ?? '?'}）`).join('、')}；要么修复要么由 owner 书面续期`);
  }
  // 死锁残留：锁文件超过 staleMs 且属主进程已死。
  try {
    const names = await readdir(ctx.stateDir, { recursive: true });
    for (const name of names) {
      const rel = toPosix(String(name));
      if (!rel.endsWith('.lock')) continue;
      const lockPath = path.join(ctx.stateDir, rel);
      const info = await stat(lockPath).catch(() => null);
      if (!info) continue;
      if (now - info.mtimeMs > ctx.locks.staleMs && !(await lockOwnerAlive(lockPath))) {
        push('medium', 'stale-lock', `死锁残留：${rel}（属主已死，将在下次取锁时被接管）`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const changes = await changedPaths(ctx).catch(() => ({ isGit: false, paths: [] }));
  if (changes.isGit && changes.paths.length > 200) push('info', 'dirty-tree', `工作树有 ${changes.paths.length} 个未提交变更路径；长会话注意 recap 与三文件同步`);
  const baseline = await readArchBaseline(ctx).catch(() => null);
  if (baseline?.entries?.length) {
    push('info', 'arch-baseline', `架构债务基线 ${baseline.entries.length} 条；arch check --scan 会校验 stale`);
  }
  let evidenceCount = 0;
  try {
    const entries = await readdir(stateFile(ctx, 'evidence'), { withFileTypes: true });
    evidenceCount = entries.filter((entry) => entry.isFile()).length;
    if (evidenceCount > ctx.retention.evidenceMaxFiles) push('info', 'evidence-bloat', `证据文件 ${evidenceCount} 个超过保留上限 ${ctx.retention.evidenceMaxFiles}；请 retention prune`);
  } catch { /* 还没有 evidence 目录 */ }
  const order = { high: 0, medium: 1, info: 2 };
  risks.sort((left, right) => order[left.level] - order[right.level]);
  return { ok: !risks.some((item) => item.level === 'high'), scannedAt: new Date(now).toISOString(), activeTask: task?.id ?? null, evidenceCount, risks };
}

// gate-audit：从未拦过的闸要么拿证据要么撤掉。
export async function gateAudit(ctx) {
  const filePath = stateFile(ctx, 'gate-log.jsonl');
  const entries = [];
  for (const candidate of [`${filePath}.1`, filePath]) {
    let text;
    try {
      text = await readFile(candidate, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { entries.push({ ts: null, kind: 'corrupt-line', rule: 'corrupt-line', reason: '无法解析的 gate-log 行' }); }
    }
  }
  const byRule = new Map();
  for (const entry of entries.slice(-5000)) {
    const key = `${entry.kind ?? 'unknown'}:${entry.rule || 'unknown'}`;
    const current = byRule.get(key) ?? { kind: entry.kind ?? 'unknown', rule: entry.rule || 'unknown', count: 0, firstTs: entry.ts, lastTs: entry.ts };
    current.count += 1;
    if (entry.ts && (!current.firstTs || entry.ts < current.firstTs)) current.firstTs = entry.ts;
    if (entry.ts && (!current.lastTs || entry.ts > current.lastTs)) current.lastTs = entry.ts;
    byRule.set(key, current);
  }
  // 已注册但历史上零拦截的闸。pre-tool-use-bash 的规则面派生自分类器规则表
  //（CLASSIFIER_RULES 单一事实源），新增/改名规则不会在这里悄悄腐烂。
  const knownGates = [
    ...PRE_BASH_RULE_IDS.map((rule) => ({ kind: 'hook:pre-tool-use-bash', rule })),
    { kind: 'hook:pre-write', rule: 'outside-workspace' },
    { kind: 'hook:pre-write', rule: 'sensitive-path' },
    { kind: 'hook:pre-write', rule: 'task-conflict' },
    { kind: 'hook:stop', rule: 'completion-gate' }
  ];
  const neverFired = knownGates.filter((gate) => ![...byRule.keys()].some((key) => key === `${gate.kind}:${gate.rule}`));
  return {
    ok: true,
    totalInterceptions: entries.length,
    rules: [...byRule.values()].sort((left, right) => right.count - left.count),
    neverFired,
    guidance: entries.length === 0
      ? '尚无拦截记录：从未拦过的闸要么拿证据要么撤掉'
      : '关注 neverFired 清单：零拦截的闸需要证据或下线'
  };
}

export async function appendGateLog(ctx, entry) {
  try {
    const filePath = stateFile(ctx, 'gate-log.jsonl');
    await mkdir(path.dirname(filePath), { recursive: true });
    const maxBytes = ctx.retention.gateLogMaxBytes;
    const size = await stat(filePath).then((info) => info.size).catch(() => 0);
    if (size > maxBytes) await rename(filePath, `${filePath}.1`).catch(() => {});
    const record = {
      ts: nowIso(),
      kind: String(entry.kind ?? 'unknown'),
      rule: boundedText(String(entry.rule ?? ''), 200),
      reason: boundedText(String(entry.reason ?? ''), 400),
      decision: entry.decision ? String(entry.decision) : undefined,
      detail: entry.detail ? boundedText(String(entry.detail), 400) : undefined
    };
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // 审计日志绝不能拖垮 hook 主路径；主判定已经发生。
  }
}

// retention prune：销毁过期 evidence/context；保护当前 receipt 引用的证据。
export async function retentionPrune(ctx, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const now = Date.now();
  const maxAgeMs = ctx.retention.evidenceMaxAgeDays * 86400000;
  const report = { ok: true, dryRun, evidence: { kept: 0, deleted: [] }, context: { kept: 0, deleted: [] }, notes: [] };
  // 保护集：receipts/ 里最新回执引用的证据 + active 任务相关账本条目的证据。
  const protectedPaths = new Set();
  const receiptsMap = await latestReceipts(ctx);
  for (const receipt of receiptsMap.values()) if (receipt.evidencePath) protectedPaths.add(toPosix(receipt.evidencePath));
  const task = await getActiveTask(ctx).catch(() => null);
  if (task) {
    const ledger = await readLedgerEntries(ctx);
    for (const entry of ledger.entries) {
      if (!entry.__corrupt && entry.taskId === task.id && entry.evidencePath) protectedPaths.add(toPosix(entry.evidencePath));
    }
  }
  const listFiles = async (root) => {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...await listFiles(absolute));
      else if (entry.isFile()) files.push(absolute);
    }
    return files;
  };
  const evidenceFiles = [];
  for (const file of await listFiles(stateFile(ctx, 'evidence'))) {
    const info = await stat(file).catch(() => null);
    if (info) evidenceFiles.push({ file, mtimeMs: info.mtimeMs });
  }
  evidenceFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let kept = 0;
  for (const { file, mtimeMs } of evidenceFiles) {
    const relative = toPosix(path.relative(ctx.root, file));
    const isProtected = protectedPaths.has(relative);
    const tooOld = now - mtimeMs > maxAgeMs;
    const overCap = kept >= ctx.retention.evidenceMaxFiles;
    if (isProtected || (!tooOld && !overCap)) {
      kept += 1;
      continue;
    }
    report.evidence.deleted.push(relative);
    if (!dryRun) await rm(file, { force: true });
  }
  report.evidence.kept = kept;
  const contextFiles = [];
  for (const file of await listFiles(stateFile(ctx, 'context'))) {
    const info = await stat(file).catch(() => null);
    if (info) contextFiles.push({ file, mtimeMs: info.mtimeMs });
  }
  contextFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (let index = 0; index < contextFiles.length; index += 1) {
    if (index < ctx.retention.contextMaxFiles) {
      report.context.kept += 1;
      continue;
    }
    report.context.deleted.push(toPosix(path.relative(ctx.root, contextFiles[index].file)));
    if (!dryRun) await rm(contextFiles[index].file, { force: true });
  }
  if (report.evidence.deleted.length > 50) {
    report.notes.push(`删除 evidence ${report.evidence.deleted.length} 个，清单截断显示`);
    report.evidence.deleted = report.evidence.deleted.slice(0, 50);
  }
  return report;
}

// ---------- dod（Definition of Done 静态电池） ----------

// 静态电池定义唯一事实源：dod 动词与后续 release（P6）共用，禁止第二份拷贝。
// 每步 = 真实 CLI 子进程（锻炼真实入口，输出与逐跑一致）。
export const DOD_STEPS = [
  { id: 'catalog-lint', args: ['catalog', 'lint'] },
  { id: 'skills-lint', args: ['skills-lint'] },
  { id: 'agents-lint', args: ['agents-lint'] },
  { id: 'spec-lint', args: ['spec', 'lint'] },
  { id: 'adr-check', args: ['adr', 'check'] },
  { id: 'fitness', args: ['fitness', '--all'] },
  { id: 'trace', args: ['trace'] },
  { id: 'receipt-verify', args: ['receipt', 'verify'] },
  { id: 'arch-check', args: ['arch', 'check'] }
];

// 引擎入口与本文件同仓定位：<root>/.kimi-base/runtime/lib/hygiene.mjs → ../kimi-base.mjs。
const RUNTIME_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kimi-base.mjs');
const DOD_STEP_TIMEOUT_MS = 300000;

// 退出码归级（契约 v2）：1/2 = FAIL；3 = DEGRADED（响亮报告不隐瞒）；
// 4 = STALE（陈旧不是完整性失败：新鲜度是 release 的职责（receipt-fresh 条件），
// 完整性才是 dod 的职责——STALE 响亮报告、带输出尾部，但不计 FAIL 不阻断 dod 判定）。
function classifyStepExit(exitCode) {
  if (exitCode === 0) return 'PASS';
  if (exitCode === 3) return 'DEGRADED';
  if (exitCode === 4) return 'STALE';
  return 'FAIL';
}

export async function runDod(ctx) {
  const steps = [];
  for (const step of DOD_STEPS) {
    const result = await runProcess(process.execPath, [RUNTIME_ENTRY, ...step.args], {
      cwd: ctx.root,
      timeoutMs: DOD_STEP_TIMEOUT_MS,
      maxOutput: 400000
    });
    if (result.status === 'BLOCKED') {
      steps.push({ id: step.id, status: 'FAIL', exitCode: null, durationMs: result.durationMs, reason: `无法启动子进程：${result.error?.message ?? result.stderr.trim()}` });
      continue;
    }
    const status = classifyStepExit(result.exitCode);
    const output = `${result.stdout.trim()}\n${result.stderr.trim()}`.split('\n').filter(Boolean);
    steps.push({
      id: step.id,
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      // 非 PASS 才带输出尾部（有界）：失败/降级的上下文必须可见，但绝不灌爆输出。
      ...(status === 'PASS' ? {} : { outputTail: output.slice(-15) }),
      ...(result.outputTruncated ? { note: '输出被截断（>400KB），完整输出请逐跑该步' } : {})
    });
  }
  const failed = steps.filter((step) => step.status === 'FAIL');
  const degraded = steps.filter((step) => step.status === 'DEGRADED');
  const stale = steps.filter((step) => step.status === 'STALE');
  // 任一 FAIL → 治理阻断 exit 2；无 FAIL 但有 DEGRADED → exit 3（降级绝不静默）；
  // STALE 不阻断（陈旧 ≠ 完整性失败，新鲜度由 release 的 receipt-fresh 判定）；全 PASS → 0。
  const exitCode = failed.length ? 2 : degraded.length ? 3 : 0;
  return { ok: exitCode === 0, exitCode, steps, counts: {
    PASS: steps.filter((step) => step.status === 'PASS').length,
    FAIL: failed.length,
    DEGRADED: degraded.length,
    STALE: stale.length
  } };
}
