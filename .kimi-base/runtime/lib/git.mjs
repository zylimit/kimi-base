// lib/git.mjs —— Git 测量（NUL 分隔、有界输出、截断即坏测量）

import path from 'node:path';
import { HarnessError, degradedError, fileDigest, runProcess, sha256, toPosix } from './core.mjs';
import { STATE_DIR } from './paths.mjs';

const GIT_MAX_OUTPUT = 268435456; // 256MB；超出即拒绝绑定截断测量
export const NON_GIT_FINGERPRINT = 'DEGRADED:NON_GIT';

export async function git(ctx, args, { allowFailure = false, timeoutMs = 30000 } = {}) {
  const result = await runProcess('git', args, { cwd: ctx.root, timeoutMs, maxOutput: GIT_MAX_OUTPUT });
  if (result.outputTruncated) {
    throw new HarnessError(`git 输出超过 ${GIT_MAX_OUTPUT} 字节（${args.join(' ')}）；拒绝绑定截断的测量`, 'GIT_OUTPUT_TRUNCATED');
  }
  if (result.status === 'BLOCKED') {
    if (allowFailure) return result;
    throw new HarnessError(`git 无法执行：${result.error?.message ?? result.stderr}`, 'GIT_BLOCKED');
  }
  if (result.exitCode !== 0 && !allowFailure) {
    throw new HarnessError(`git 执行失败（${args.join(' ')}）：${result.stderr.trim()}`, 'GIT_FAILED');
  }
  return result;
}

export async function gitInfo(ctx) {
  const inside = await git(ctx, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.status !== 'PASS' || inside.stdout.trim() !== 'true') {
    return { isGit: false, baseCommit: NON_GIT_FINGERPRINT, unborn: false, note: '不是 git 工作树；git 保证降级' };
  }
  const head = await git(ctx, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  return {
    isGit: true,
    baseCommit: head.exitCode === 0 ? head.stdout.trim() : 'UNBORN',
    unborn: head.exitCode !== 0,
    note: head.exitCode === 0 ? null : '无提交仓库（unborn HEAD）'
  };
}

export function splitZero(value) {
  return value.split('\0').filter(Boolean).map((item) => toPosix(item));
}

// 运行时状态目录永不绑定质量证据。
export function excludeStatePaths(paths) {
  return paths.filter((item) => item !== `${STATE_DIR}/.gitignore` && !item.startsWith(`${STATE_DIR}/`));
}

export async function changedPaths(ctx) {
  const info = await gitInfo(ctx);
  if (!info.isGit) return { ...info, paths: [], staged: [], unstaged: [], untracked: [] };
  const [stagedRaw, unstagedRaw, untrackedRaw] = await Promise.all([
    git(ctx, ['diff', '--cached', '--name-only', '-z', '--', '.']),
    git(ctx, ['diff', '--name-only', '-z', '--', '.']),
    git(ctx, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
  ]);
  const [staged, unstaged, untracked] = [stagedRaw, unstagedRaw, untrackedRaw]
    .map((result) => excludeStatePaths(splitZero(result.stdout)));
  const paths = [...new Set([...staged, ...unstaged, ...untracked])].sort();
  return { ...info, paths, staged: [...new Set(staged)].sort(), unstaged: [...new Set(unstaged)].sort(), untracked: [...new Set(untracked)].sort() };
}

export async function trackedPaths(ctx, maxPaths = 100000) {
  const info = await gitInfo(ctx);
  if (!info.isGit) return { ...info, paths: [], truncated: false, total: 0 };
  const result = await git(ctx, ['ls-files', '-z', '--', '.']);
  const all = excludeStatePaths(splitZero(result.stdout)).sort();
  return { ...info, paths: all.slice(0, maxPaths), truncated: all.length > maxPaths, total: all.length };
}

// 证据指纹：baseCommit + 每个变更文件的内容摘要有序拼接。任何字节变化都使旧证据 stale。
export async function gitFingerprint(ctx) {
  const changes = await changedPaths(ctx);
  if (!changes.isGit) {
    return { ...changes, fingerprint: NON_GIT_FINGERPRINT, diffHash: NON_GIT_FINGERPRINT, degraded: true };
  }
  const parts = [`base:${changes.baseCommit}`];
  for (const relative of changes.paths) {
    const digest = await fileDigest(path.join(ctx.root, relative));
    parts.push(`${relative}\0${digest ?? 'missing'}`);
  }
  const diffHash = sha256(parts.join('\n'));
  return {
    ...changes,
    diffHash,
    fingerprint: sha256(`${changes.baseCommit}\0${diffHash}`),
    degraded: false
  };
}

// 需要 git 新鲜度的操作：非 git 仓一律降级 exit 3（无法测量），绝不假 PASS。
export async function requireGit(ctx, operation) {
  const info = await gitInfo(ctx);
  if (!info.isGit) {
    throw degradedError(`降级：非 git 仓，无法测量——${operation} 需要 git 工作树以绑定证据指纹（${info.note}）`, 'NON_GIT_BLOCKED', { operation });
  }
  return info;
}
