// lib/tasks.mjs —— 任务账本（tasks.json，单 active 任务，ownedPaths SHA-256 基线）

import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HarnessError, csv, fileDigest, normalizeRepoPath, nowIso, usageError } from './core.mjs';
import { changedPaths, gitFingerprint, trackedPaths } from './git.mjs';
import { RISKS } from './matrix.mjs';
import { TASKS_FILE } from './paths.mjs';
import { readState, stateFile, updateState } from './state.mjs';

export function emptyTasks() {
  return { version: 1, activeTaskId: null, tasks: {} };
}

export async function readTasks(ctx) {
  const state = await readState(ctx, TASKS_FILE, emptyTasks());
  if (state.version !== 1 || !state.tasks || typeof state.tasks !== 'object') {
    throw new HarnessError('任务账本状态非法', 'STATE_CORRUPT');
  }
  return state;
}

export async function getActiveTask(ctx) {
  const state = await readTasks(ctx);
  return state.activeTaskId ? state.tasks[state.activeTaskId] ?? null : null;
}

function taskOwns(task, relativePath) {
  const target = normalizeRepoPath(relativePath);
  return task.ownedPaths.some((owned) => target === owned || target.startsWith(`${owned.replace(/\/$/, '')}/`));
}

async function digestOwnedPaths(ctx, ownedPaths) {
  // 基线快照：ownedPaths 覆盖到的所有现存文件的内容摘要。
  const tracked = await trackedPaths(ctx, ctx.catalogLimits.maxTrackedPaths).catch(() => ({ paths: [], isGit: false }));
  const dirty = await changedPaths(ctx).catch(() => ({ paths: [] }));
  const candidates = new Set();
  const owns = (item) => ownedPaths.some((owned) => item === owned || item.startsWith(`${owned.replace(/\/$/, '')}/`));
  for (const item of [...tracked.paths, ...dirty.paths]) if (owns(item)) candidates.add(item);
  for (const owned of ownedPaths) {
    const absolute = path.join(ctx.root, owned);
    const info = await lstat(absolute).catch(() => null);
    if (info?.isFile()) candidates.add(owned);
  }
  const knownHashes = {};
  for (const relative of [...candidates].sort()) {
    knownHashes[relative] = await fileDigest(path.join(ctx.root, relative));
  }
  return knownHashes;
}

export async function taskStart(ctx, input) {
  const goal = String(input.goal ?? '').trim();
  if (!goal) throw usageError('task start 需要 --goal "..."');
  const ownedPaths = csv(input.owned).map(normalizeRepoPath);
  if (!ownedPaths.length) throw usageError('task start 需要 --owned "glob,glob"（至少一个拥有路径）');
  const risk = String(input.risk ?? '').trim();
  if (!RISKS.includes(risk)) throw usageError(`task start 需要 --risk low|medium|high`);
  const fingerprint = await gitFingerprint(ctx);
  const knownHashes = await digestOwnedPaths(ctx, [...new Set(ownedPaths)].sort());
  const now = nowIso();
  const task = {
    id: `task-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`,
    goal,
    risk,
    ownedPaths: [...new Set(ownedPaths)].sort(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
    baseline: {
      baseCommit: fingerprint.baseCommit,
      fingerprint: fingerprint.fingerprint,
      diffHash: fingerprint.diffHash,
      degraded: fingerprint.degraded,
      knownHashes
    },
    touchedPaths: [],
    completion: null
  };
  await updateState(ctx, TASKS_FILE, emptyTasks(), (state) => {
    if (state.activeTaskId) throw new HarnessError(`已存在 active 任务：${state.activeTaskId}；请先 complete 或 cancel`, 'TASK_ACTIVE_EXISTS');
    return { ...state, activeTaskId: task.id, tasks: { ...state.tasks, [task.id]: task } };
  });
  return task;
}

export async function taskCancel(ctx) {
  let cancelled;
  await updateState(ctx, TASKS_FILE, emptyTasks(), (state) => {
    if (!state.activeTaskId) throw new HarnessError('当前没有 active 任务', 'TASK_NOT_ACTIVE');
    const task = state.tasks[state.activeTaskId];
    cancelled = { ...task, status: 'cancelled', cancelledAt: nowIso(), updatedAt: nowIso() };
    return { ...state, activeTaskId: null, tasks: { ...state.tasks, [task.id]: cancelled } };
  });
  return cancelled;
}

// 写前对账：owned 路径的内容哈希若偏离基线且非本任务已认领的写入，说明任务外力量改过。
// tasks.json 腐化/被隔离时对账能力缺失：放行但返回 degraded（调用方必须响亮留痕，不得静默）。
export async function prewriteReconcile(ctx, relativePath) {
  let degraded = null;
  try {
    JSON.parse(await readFile(stateFile(ctx, TASKS_FILE), 'utf8'));
  } catch (error) {
    // SyntaxError（JSON 腐化）→ 降级；ENOENT（尚未建账）→ 正常；其余 I/O 错误上抛。
    if (error instanceof SyntaxError) degraded = { file: TASKS_FILE, error: String(error.message).slice(0, 200) };
    else if (error.code !== 'ENOENT') throw error;
  }
  const task = await getActiveTask(ctx); // readState 会把腐化文件隔离为 *.corrupt-<ts> 并给空账本
  if (!task || !taskOwns(task, relativePath)) return { task, owned: Boolean(task && taskOwns(task, relativePath)), conflict: null, degraded };
  if (task.touchedPaths.includes(relativePath)) return { task, owned: true, conflict: null, degraded };
  const current = await fileDigest(path.join(ctx.root, relativePath));
  const known = Object.hasOwn(task.baseline.knownHashes, relativePath) ? task.baseline.knownHashes[relativePath] : null;
  if (current !== known) {
    return { task, owned: true, conflict: { path: relativePath, known, current }, degraded };
  }
  // 认领本次写入：之后的重复写不再视为外部改动（无 PostWrite 事件，这是诚实边界）。
  await updateState(ctx, TASKS_FILE, emptyTasks(), (state) => {
    const currentTask = state.activeTaskId ? state.tasks[state.activeTaskId] : null;
    if (!currentTask) return state;
    const touched = [...new Set([...currentTask.touchedPaths, relativePath])].sort();
    return { ...state, tasks: { ...state.tasks, [currentTask.id]: { ...currentTask, touchedPaths: touched, updatedAt: nowIso() } } };
  });
  return { task, owned: true, conflict: null, degraded };
}
