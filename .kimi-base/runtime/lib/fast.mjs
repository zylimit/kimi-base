// lib/fast.mjs —— Fast Mode（限时质量旁路；protected 免疫；每个 skip 留痕）

import { randomUUID } from 'node:crypto';
import { nowIso, usageError } from './core.mjs';
import { FAST_FILE } from './paths.mjs';
import { readState, writeState } from './state.mjs';

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
