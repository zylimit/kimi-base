// lib/hooks.mjs —— hook 调度器（插件 manifest 的 hooks 调这里）
// 从 stdin 读 JSON；一律用 payload.cwd 找项目（ hooks 可能从任意目录触发）。
// 非 kimi-base 项目（无 .kimi-base/harness.json）静默放行。

import path from 'node:path';
import process from 'node:process';
import { classifyDangerousCommand, classifySensitiveCommand, isSecretBasename } from './classifier.mjs';
import { findProjectRoot, loadContext } from './config.mjs';
import { HarnessError, TOOL_VERSION, boundedText, normalizeRepoPath, nowIso, resolveForWrite, sha256, toPosix, usageError } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { gitFingerprint } from './git.mjs';
import { appendGateLog } from './hygiene.mjs';
import { readLedgerEntries } from './ledger.mjs';
import { invariantsDigest } from './memory.mjs';
import { completionGate } from './quality.mjs';
import { readState, updateState, writeState } from './state.mjs';
import { getActiveTask, prewriteReconcile } from './tasks.mjs';

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __malformed: true };
  }
}

function hookDeny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

// hook 对模型的输出口径统一走 outputLimits.hookChars（默认 4000）封顶 + 脱敏。
function hookSay(ctx, text) {
  process.stdout.write(`${boundedText(text, ctx.outputLimits.hookChars)}\n`);
}

function writeToolPaths(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const keys = ['path', 'file_path', 'filePath', 'target', 'filename'];
  const result = [];
  for (const key of keys) {
    if (typeof toolInput[key] === 'string' && toolInput[key].trim()) result.push(toolInput[key]);
  }
  return [...new Set(result)];
}

// 写路径策略：仓外/.git/敏感文件一律拦截。
async function validateWritePath(ctx, inputPath) {
  const resolved = await resolveForWrite(ctx.root, inputPath);
  const relative = normalizeRepoPath(toPosix(path.relative(ctx.root, resolved.absolute)));
  const pieces = relative.toLowerCase().split('/');
  const base = pieces.at(-1);
  if (pieces.includes('.git')) throw new HarnessError(`禁止写入 .git 元数据：${relative}`, 'WRITE_BLOCKED', 2);
  if (ctx.security.allowedSecretTemplates.map((item) => item.toLowerCase()).includes(base)) return relative;
  if (isSecretBasename(ctx, base)) throw new HarnessError(`禁止写入敏感文件：${relative}`, 'WRITE_BLOCKED', 2);
  if (ctx.security.secretDirs.some((item) => pieces.includes(item.toLowerCase()))) {
    throw new HarnessError(`禁止写入凭据目录：${relative}`, 'WRITE_BLOCKED', 2);
  }
  return relative;
}

async function hookPreToolUseBash(ctx, payload) {
  const command = String(payload.tool_input?.command ?? '');
  if (!command.trim()) return;
  const dangerous = classifyDangerousCommand(command);
  const verdict = dangerous.action !== 'allow' ? dangerous : classifySensitiveCommand(ctx, command);
  if (verdict.action === 'allow') return;
  if (verdict.action === 'deny' || ctx.hooks.reviewAction !== 'warn') {
    await appendGateLog(ctx, { kind: 'hook:pre-tool-use-bash', rule: verdict.rule, reason: verdict.reason, decision: 'block', detail: command.slice(0, 300) });
    hookDeny(`已拦截（${verdict.rule}）：${verdict.reason}`);
    return;
  }
  // 配置降级：提示进上下文但不阻断，拦截仍记账。
  await appendGateLog(ctx, { kind: 'hook:pre-tool-use-bash', rule: verdict.rule, reason: verdict.reason, decision: 'warn', detail: command.slice(0, 300) });
  hookSay(ctx, `kimi-base 提醒（reviewAction=warn，未阻断）：${verdict.reason}（规则 ${verdict.rule}）`);
}

async function hookPreWrite(ctx, payload) {
  const candidates = writeToolPaths(payload.tool_input);
  if (!candidates.length) return;
  for (const candidate of candidates) {
    let relative;
    try {
      relative = await validateWritePath(ctx, candidate);
    } catch (error) {
      await appendGateLog(ctx, { kind: 'hook:pre-write', rule: error.code === 'OUTSIDE_WORKSPACE' ? 'outside-workspace' : 'sensitive-path', reason: error.message, decision: 'block', detail: candidate });
      hookDeny(`写前拦截：${error.message}`);
      return;
    }
    const { conflict, degraded } = await prewriteReconcile(ctx, relative);
    if (degraded) {
      // tasks.json 腐化/被隔离：放行但响亮留痕——对账缺失绝不能静默。
      const reason = `写前对账降级：${degraded.file} 无法解析（已隔离，详见 quarantine.jsonl）：${degraded.error}；本次写入放行但任务对账缺失`;
      process.stderr.write(`kimi-base 警告：${reason}\n`);
      await appendGateLog(ctx, { kind: 'hook:pre-write', rule: 'prewrite-reconcile-degraded', reason, decision: 'allow', detail: relative });
    }
    if (conflict) {
      await appendGateLog(ctx, { kind: 'hook:pre-write', rule: 'task-conflict', reason: `任务外改动：${relative}`, decision: 'block', detail: relative });
      hookDeny(`写前对账拦截：${relative} 在 active 任务 ownedPaths 内，但内容哈希已偏离任务基线（被任务外力量改过）。请先 task status 核对，必要时 cancel 重开任务。`);
      return;
    }
  }
}

const SIX_DISCIPLINES = [
  '1. 证据优先：完成只认绑定当前 git fingerprint 的 fresh receipt，自报不算',
  '2. 绝不假绿：缺工具/缺命令/非 git 仓 = BLOCKED，SKIP 必须显式',
  '3. security/safety/privacy 永不豁免、永不 fast-skip；FAIL 永不可豁免',
  '4. 保护现有改动：不覆盖、不回滚、不格式化无关用户改动',
  '5. 最小副作用：未获授权不 commit/push/装依赖/杀进程',
  '6. 失败可见：FAIL/BLOCKED/SKIPPED 与 stale 证据必须如实报告'
];

async function hookSessionStart(ctx, payload) {
  const fingerprint = await gitFingerprint(ctx).catch(() => null);
  // 记录会话基线，供 Stop 完成门对账。
  await writeState(ctx, 'session.json', {
    version: 1,
    sessionId: payload.session_id ?? null,
    startedAt: nowIso(),
    baseCommit: fingerprint?.baseCommit ?? null,
    fingerprint: fingerprint?.fingerprint ?? null
  }).catch(() => {});
  const task = await getActiveTask(ctx).catch(() => null);
  const fast = await fastModeStatus(ctx).catch(() => ({ active: false, expired: false }));
  const changes = fingerprint?.degraded === false ? fingerprint.paths : [];
  const lines = [
    `[kimi-base] 治理运行时已激活（${TOOL_VERSION}）；hooks 是护栏不是沙箱。`,
    `项目：${path.basename(ctx.root)}`
  ];
  if (task) lines.push(`活跃任务：${task.id}（risk=${task.risk}）；owned：${task.ownedPaths.join(', ')}`);
  else lines.push('活跃任务：无（task start 建立账本后开始受治理开发）');
  if (changes.length) lines.push(`待审文件：工作树有 ${changes.length} 个未提交变更；长会话请先 /recap 再动手`);
  else lines.push('待审文件：工作树干净');
  if (fast.active) lines.push(`Fast Mode：生效至 ${fast.expiresAt}（protected 免疫）`);
  else if (fast.expired) lines.push('Fast Mode：已过期（旧 SKIPPED 回执不再算数）');
  else lines.push('Fast Mode：关闭');
  lines.push('核心纪律速览：');
  lines.push(...SIX_DISCIPLINES);
  // 压缩不纠偏（摘要把漂移带进新会话）：会话横幅顺带重注铁律+实时状态；
  // pre-compact 便签不变——重注入由 sessionStart 承担。hooks.injectInvariants 可关。
  if (ctx.hooks.injectInvariants) {
    const digest = await invariantsDigest(ctx).catch(() => null);
    if (digest) lines.push('', digest.text.trimEnd());
  }
  hookSay(ctx, lines.join('\n'));
}

async function hookStop(ctx) {
  const session = await readState(ctx, 'session.json', null);
  const fingerprint = await gitFingerprint(ctx).catch(() => null);
  if (!fingerprint || fingerprint.degraded) {
    hookSay(ctx, 'kimi-base Stop 门：非 git 仓，完成门降级为提醒——请自行确认改动已验证。');
    return;
  }
  const changed = fingerprint.paths;
  if (!changed.length) return; // 无代码改动，不拦
  const problems = [];
  const ledger = await readLedgerEntries(ctx);
  const freshReceipts = ledger.entries.filter((entry) => !entry.__corrupt && entry.kind === 'verification' && entry.fingerprint === fingerprint.fingerprint);
  if (!freshReceipts.length) problems.push('缺当前指纹下的 fresh receipt（先跑 gate）');
  if (!changed.includes('progress.md')) problems.push('代码已改但 progress.md 未进改动集（三文件同步）');
  if (!problems.length) return;
  const reason = `Stop 完成门拦截：${problems.join('；')}`;
  const key = sha256(`${fingerprint.fingerprint}\0${problems.join(';')}`);
  const limit = ctx.hooks.stopFuseLimit;
  const strikes = await updateState(ctx, 'stop-strikes.json', { version: 1, key: null, count: 0 }, (state) => {
    const count = state.key === key ? state.count + 1 : 1;
    return { version: 1, key, count, updatedAt: nowIso() };
  });
  // 保险丝：同一阻断指纹连拦 limit 次后，第 limit+1 次放行并醒目提示欠账。
  if (strikes.count > limit) {
    await appendGateLog(ctx, { kind: 'hook:stop', rule: 'stop-fuse-release', reason, decision: 'release', detail: `strikes=${strikes.count}` });
    hookSay(ctx, `kimi-base 醒目提示：同一阻断指纹已连拦 ${strikes.count} 次，保险丝放行。欠账仍在：${problems.join('；')}。请人工复核并补证据，不要把放行当作通过。`);
    return;
  }
  await appendGateLog(ctx, { kind: 'hook:stop', rule: 'completion-gate', reason, decision: 'block', detail: `strikes=${strikes.count}/${limit}` });
  hookDeny(`${reason}（第 ${strikes.count}/${limit} 次；同一指纹连拦 ${limit} 次后保险丝放行并记欠账）`);
}

function hookPromptSubmit(ctx, payload) {
  const prompt = String(payload.prompt ?? payload.tool_input?.prompt ?? '');
  if (!prompt) return;
  const lowered = prompt.toLowerCase();
  const hit = ctx.hooks.correctionKeywords.find((keyword) => lowered.includes(String(keyword).toLowerCase()));
  if (!hit) return;
  hookSay(ctx, `kimi-base：检测到用户修正信号（"${hit}"）。请先处理诉求；若确认为 AI 行为问题，按 feedback 流程去重记录（occurrences+1），不要静默略过。`);
}

function hookSubagentStop(ctx) {
  hookSay(ctx, 'kimi-base 验收提醒：勿信子代理自报——核对客观证据（文件现状、命令退出码、fresh receipt）再采信 DONE。');
}

async function hookPreCompact(ctx) {
  const task = await getActiveTask(ctx).catch(() => null);
  const fingerprint = await gitFingerprint(ctx).catch(() => null);
  let pendingChecks = [];
  if (task && fingerprint && !fingerprint.degraded) {
    const gate = await completionGate(ctx, task).catch(() => null);
    if (gate) pendingChecks = gate.gaps.map((gap) => `${gap.kind ?? '-'}:${gap.check ?? '-'} ${gap.reason}`);
  }
  const note = {
    version: 1,
    createdAt: nowIso(),
    baseCommit: fingerprint?.baseCommit ?? null,
    fingerprint: fingerprint?.fingerprint ?? null,
    activeTask: task ? { id: task.id, goal: task.goal, risk: task.risk, ownedPaths: task.ownedPaths, touchedPaths: task.touchedPaths } : null,
    pendingChecks,
    hint: '压缩前最后落盘：recap 时连同 progress.md / Product-Spec.md / Product-Spec-CHANGELOG.md 一起读'
  };
  // 与其他状态写同一路径：文件锁 + 原子写，防并发会话写出半文件。
  await writeState(ctx, 'compaction-note.json', note);
  hookSay(ctx, `kimi-base：压缩前状态已写入 .kimi-base/state/compaction-note.json（task=${task?.id ?? '无'}，待办检查 ${pendingChecks.length} 项）。`);
}

export async function dispatchHook(event) {
  const payload = await readStdinJson();
  if (!payload || payload.__malformed) {
    // 畸形输入：pre 类闸 fail-closed 风格报错，其余静默。
    if (event === 'pre-tool-use-bash' || event === 'pre-write') {
      process.stderr.write('kimi-base：hook 输入 JSON 畸形，按失败可见原则拦截\n');
      process.exitCode = 2;
    }
    return;
  }
  // 一律用 payload.cwd 找项目根；非 kimi-base 项目静默退出。
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const root = await findProjectRoot(cwd);
  if (!root) return;
  const ctx = await loadContext(root);
  switch (event) {
    case 'pre-tool-use-bash': return hookPreToolUseBash(ctx, payload);
    case 'pre-write': return hookPreWrite(ctx, payload);
    case 'stop': return hookStop(ctx);
    case 'prompt-submit': return hookPromptSubmit(ctx, payload);
    case 'subagent-stop': return hookSubagentStop(ctx);
    case 'pre-compact': return hookPreCompact(ctx);
    case 'session-start': return hookSessionStart(ctx, payload);
    default: throw usageError(`未知 hook 事件：${event}（可选 pre-tool-use-bash/pre-write/stop/prompt-submit/subagent-stop/pre-compact/session-start）`);
  }
}
