// lib/state.mjs —— 状态文件、跨进程锁与腐化隔离

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { HarnessError, atomicWrite, degradedError, nowIso, pathExists, readJsonFile, sleep } from './core.mjs';
import { MAINTENANCE_MARKER_REL } from './paths.mjs';

export function stateFile(ctx, relativeName) {
  if (path.isAbsolute(relativeName) || relativeName.split(/[\\/]/).includes('..')) {
    throw new HarnessError(`不安全的状态路径：${relativeName}`, 'UNSAFE_STATE_PATH');
  }
  return path.join(ctx.stateDir, relativeName);
}

// 腐化状态文件既不允许被悄悄重建（可审计），也不允许卡死引擎（韧性）：
// 挪到 *.corrupt-<ts> 并记 quarantine.jsonl，调用方从默认值继续，事件保持可见。
// REQ-061：唯一隔离原语——任何运行态 JSON 读取点的损坏处理都必须走这里（ledger 头锚、
// receipts 等绕过 readState/updateState 的直读点同），禁止发明第二套隔离机制。
export async function quarantineState(ctx, filePath, error) {
  const quarantined = `${filePath}.corrupt-${Date.now()}`;
  try {
    await rename(filePath, quarantined);
  } catch (renameError) {
    // 并发竞抢容忍：多进程同时隔离同一损坏文件时赢家已完成 rename，输家拿 ENOENT——
    // 源已消失即视为隔离完成（证据已在赢家的 .corrupt-<ts> 里，记账由赢家负责）；
    // 源仍在却 rename ENOENT 属异常，不吞；ENOENT 以外的错误一律照抛。
    if (renameError.code !== 'ENOENT') throw renameError;
    if (await pathExists(filePath)) throw renameError;
    return quarantined;
  }
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

// ---------- REQ-065 maintenance marker（安装/升级维护锁） ----------

// marker 存在 = install/upgrade 事务正在进行或上次中断（进程被杀来不及清理）。
// 存在期间 doctor 与治理动词（gate 等）拒跑并点名 marker——exit 3 降级语义：
// 维护中的安装面是未知态，任何治理判定都不可信，绝不假绿。
export async function readMaintenanceMarker(root) {
  try {
    return JSON.parse(await readFile(path.join(root, MAINTENANCE_MARKER_REL), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return { reason: '（marker 不可解析，按维护中处理）' };
    throw error;
  }
}

export async function assertNoMaintenance(root) {
  const marker = await readMaintenanceMarker(root);
  if (!marker) return;
  throw degradedError(
    `maintenance marker 存在（${MAINTENANCE_MARKER_REL}${marker.since ?? marker.startedAt ? `，since ${marker.since ?? marker.startedAt}` : ''}）：安装/升级维护进行中或上次未完成（${marker.reason ?? '未注明原因'}）——治理动词拒跑，确认维护完成后移除该 marker 再重跑`,
    'MAINTENANCE_MODE'
  );
}
