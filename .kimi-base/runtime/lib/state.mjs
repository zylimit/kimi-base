// lib/state.mjs —— 状态文件、跨进程锁与腐化隔离

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { HarnessError, atomicWrite, nowIso, readJsonFile, sleep } from './core.mjs';

export function stateFile(ctx, relativeName) {
  if (path.isAbsolute(relativeName) || relativeName.split(/[\\/]/).includes('..')) {
    throw new HarnessError(`不安全的状态路径：${relativeName}`, 'UNSAFE_STATE_PATH');
  }
  return path.join(ctx.stateDir, relativeName);
}

// 腐化状态文件既不允许被悄悄重建（可审计），也不允许卡死引擎（韧性）：
// 挪到 *.corrupt-<ts> 并记 quarantine.jsonl，调用方从默认值继续，事件保持可见。
async function quarantineState(ctx, filePath, error) {
  const quarantined = `${filePath}.corrupt-${Date.now()}`;
  await rename(filePath, quarantined);
  try {
    await mkdir(ctx.stateDir, { recursive: true });
    await appendFile(path.join(ctx.stateDir, 'quarantine.jsonl'), `${JSON.stringify({
      ts: nowIso(), file: path.basename(filePath), quarantinedAs: path.basename(quarantined),
      error: String(error?.message ?? error).slice(0, 400)
    })}\n`, 'utf8');
  } catch { /* 隔离记账是尽力而为；rename 已保住证据 */ }
  return quarantined;
}

export async function quarantineEvents(ctx) {
  try {
    const text = await readFile(path.join(ctx.stateDir, 'quarantine.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { ts: null, file: 'unknown', error: '无法解析的隔离记录' }; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function lockOwnerAlive(lockPath) {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!Number.isInteger(value.pid) || value.pid <= 0) return false;
    try { process.kill(value.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  } catch {
    return false;
  }
}

// 跨进程文件锁：wx 创建 + ownerToken 认领释放；stale 窗口后且属主已死才接管。
export async function withFileLock(lockPath, options, callback) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const staleMs = options.staleMs ?? 120000;
  const pollMs = options.pollMs ?? 25;
  const started = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  const ownerToken = randomUUID();
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken, createdAt: nowIso() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw new HarnessError(`无法获取锁 ${lockPath}：${error.message}`, 'LOCK_FAILED');
      const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > staleMs && !(await lockOwnerAlive(lockPath))) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new HarnessError(`等待锁超时：${lockPath}`, 'LOCK_TIMEOUT');
      await sleep(pollMs);
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current.ownerToken === ownerToken) await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function readState(ctx, relativeName, defaultValue = undefined) {
  const filePath = stateFile(ctx, relativeName);
  let value;
  try {
    value = await readJsonFile(filePath, { required: false });
  } catch (error) {
    if (error.code !== 'JSON_PARSE_FAILED') throw error;
    await quarantineState(ctx, filePath, error);
    return defaultValue;
  }
  return value === null ? defaultValue : value;
}

export async function writeState(ctx, relativeName, value) {
  const filePath = stateFile(ctx, relativeName);
  return withFileLock(`${filePath}.lock`, ctx.locks, async () => {
    await atomicWrite(filePath, value);
    return value;
  });
}

export async function updateState(ctx, relativeName, defaultValue, updater) {
  const filePath = stateFile(ctx, relativeName);
  return withFileLock(`${filePath}.lock`, ctx.locks, async () => {
    let current = defaultValue;
    try {
      current = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof SyntaxError) {
          await quarantineState(ctx, filePath, error);
          current = defaultValue;
        } else throw error;
      }
    }
    const next = await updater(current);
    if (next === undefined) throw new HarnessError(`状态更新器对 ${relativeName} 返回了 undefined`, 'STATE_UPDATE_FAILED');
    await atomicWrite(filePath, next);
    return next;
  });
}
