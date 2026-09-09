// lib/review-dirty.mjs —— review 机械闸的脏标记状态（REQ-080）
//
// 机制：PostToolUse(Edit/Write) 观察型 hook 把代码文件置脏（state/review-dirty.json）；
// Stop 完成门在脏标记仍在工作树变更集时阻断并指引派发 review；终审 ACCEPT 按会话范围清脏。
// 脏标记是账本不是闸本身：闸在 Stop，清脏只由评审裁决触发，防"自报已评审"。
// 本模块只依赖 core/paths/state——hooks 与 review 双侧共用，不得引入治理业务模块（防循环）。

import path from 'node:path';
import { nowIso, toPosix } from './core.mjs';
import { REVIEW_DIRTY_FILE } from './paths.mjs';
import { readState, updateState } from './state.mjs';

// 代码文件扩展名白名单（小写、不带点）：评审对象是代码改动；
// 文档（md/txt）、数据（json/yaml/toml）与治理元数据不置脏。
export const CODE_EXTENSIONS = Object.freeze(new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'm', 'mm', 'swift',
  'rb', 'php', 'lua', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hrl', 'clj', 'fs', 'fsx', 'vb', 'pl', 'pm',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'sql',
  'vue', 'svelte', 'css', 'scss', 'less', 'html', 'htm', 'xml'
]));

export function isCodePath(relative) {
  return CODE_EXTENSIONS.has(path.posix.extname(relative).slice(1).toLowerCase());
}

// 归一为仓内相对 posix 路径；仓外/仓根本身/.git/.kimi-base（治理面与状态）一律返回 null。
export function dirtyCandidate(root, cwd, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  const relative = toPosix(path.relative(root, absolute));
  if (!relative || relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative)) return null;
  const pieces = relative.split('/');
  if (pieces.includes('.git') || pieces[0] === '.kimi-base') return null;
  return relative;
}

export async function readDirty(ctx) {
  const state = await readState(ctx, REVIEW_DIRTY_FILE, { version: 1, files: {} });
  if (state.version !== 1 || typeof state.files !== 'object' || state.files === null || Array.isArray(state.files)) {
    return { version: 1, files: {} }; // 形状非法按空处理（readState 已隔离 JSON 腐化）
  }
  return state;
}

export async function markDirty(ctx, relatives, tool) {
  if (!relatives.length) return null;
  return updateState(ctx, REVIEW_DIRTY_FILE, { version: 1, files: {} }, (state) => {
    const files = (state.version === 1 && state.files && typeof state.files === 'object' && !Array.isArray(state.files)) ? { ...state.files } : {};
    for (const relative of relatives) files[relative] = { editedAt: nowIso(), tool: tool ?? null };
    return { version: 1, files };
  });
}

// 剪枝：脏标记 ∩ 当前变更集。已提交/已还原的文件不再拦 Stop（防陈旧标记永久误拦）。
// 返回仍在变更集内的脏文件清单（已排序）；有剪枝时落盘。
export async function pruneDirty(ctx, livePaths) {
  const live = new Set(livePaths);
  let survivors = [];
  await updateState(ctx, REVIEW_DIRTY_FILE, { version: 1, files: {} }, (state) => {
    const files = (state.version === 1 && state.files && typeof state.files === 'object' && !Array.isArray(state.files)) ? state.files : {};
    const next = {};
    for (const [relative, meta] of Object.entries(files)) {
      if (live.has(relative)) next[relative] = meta;
    }
    survivors = Object.keys(next).sort();
    return { version: 1, files: next };
  });
  return survivors;
}

// 终审 ACCEPT 清脏：只清评审会话范围内的文件（范围外的脏标记是另一笔账）。
export async function clearDirtyForPaths(ctx, scopePaths) {
  const scope = new Set(scopePaths ?? []);
  if (!scope.size) return;
  await updateState(ctx, REVIEW_DIRTY_FILE, { version: 1, files: {} }, (state) => {
    const files = (state.version === 1 && state.files && typeof state.files === 'object' && !Array.isArray(state.files)) ? state.files : {};
    const next = {};
    for (const [relative, meta] of Object.entries(files)) {
      if (!scope.has(relative)) next[relative] = meta;
    }
    return { version: 1, files: next };
  });
}
