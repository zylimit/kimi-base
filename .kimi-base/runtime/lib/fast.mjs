// lib/fast.mjs —— Fast Mode（限时质量旁路；protected 免疫；每个 skip 留痕）

import { randomUUID } from 'node:crypto';
import { nowIso, usageError } from './core.mjs';
import { FAST_FILE } from './paths.mjs';
import { readState, writeState } from './state.mjs';

// REQ-054/ADR-0009：fast 证据贷款账本视图。账本（ledger.jsonl 哈希链）是债务的唯一事实源：
// kind=deferred 条目 = 一笔借账；唯一偿还 = 其后同检查 kind=verification 且无 fastWindow
// 印记的 fresh PASS。关窗、窗口过期、删除 fast-mode.json 均不清债——债必须被证据偿还，
// 而不是被动作抹除。
// G1：fastWindow 印记的 SKIPPED 回执是 deferred 的旁证（每笔 deferred 都由一条 SKIPPED 产生）——
// deferred 尾行被截断灭迹（连锚带尾一起删）时，债务视图不得随之失声。
export function fastDebtOf(entries) {
  const outstanding = new Map();
  for (const entry of entries) {
    if (entry.__corrupt || entry.kind === 'anchor') continue;
    if (entry.kind === 'deferred' && typeof entry.checkId === 'string') {
      outstanding.set(entry.checkId, entry);
    } else if (entry.kind === 'verification' && typeof entry.checkId === 'string') {
      if (entry.status === 'PASS' && !entry.fastWindow) {
        outstanding.delete(entry.checkId);
      } else if (entry.status === 'SKIPPED' && entry.fastWindow && !outstanding.has(entry.checkId)) {
        outstanding.set(entry.checkId, { ...entry, windowId: entry.windowId ?? entry.fastWindow });
      }
    }
  }
  return [...outstanding.values()];
}

export async function fastModeStatus(ctx, now = Date.now()) {
  const state = await readState(ctx, FAST_FILE, { version: 1, enabled: false, enabledAt: null, expiresAt: null, windowId: null });
  const expires = state.expiresAt ? Date.parse(state.expiresAt) : (state.expiresEpoch ? state.expiresEpoch * 1000 : 0);
  return {
    ...state,
    active: Boolean(state.enabled && typeof state.windowId === 'string' && state.windowId && expires > now),
    expired: Boolean(state.enabled && expires <= now),
    expiresMs: expires
  };
}

export async function fastModeSet(ctx, action, hours = undefined) {
  if (action === 'status') return fastModeStatus(ctx);
  if (action === 'off') {
    return writeState(ctx, FAST_FILE, { version: 1, enabled: false, enabledAt: null, expiresAt: null, expiresEpoch: null, windowId: null, updatedAt: nowIso() });
  }
  const ttl = hours ?? ctx.fastDefaults.defaultTtlHours;
  if (action !== 'on' || !Number.isFinite(ttl) || ttl < 1 || ttl > 720) {
    throw usageError('fast on [hours]：小时数必须是 1..720（默认 24 或 fastMode.defaultTtlHours）');
  }
  const enabledAt = nowIso();
  const expiresMs = Date.now() + ttl * 3600000;
  return writeState(ctx, FAST_FILE, {
    version: 1,
    enabled: true,
    enabledAt,
    expiresAt: new Date(expiresMs).toISOString(),
    expiresEpoch: Math.floor(expiresMs / 1000),
    windowId: randomUUID(),
    updatedAt: enabledAt
  });
}
