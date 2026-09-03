// lib/budget.mjs —— budget：变更爆炸半径预算门
//
// 移植自 dsh-base quality.mjs assessBudget。超预算不是被禁止——是一个信号：
// 变更必须拆分，或经 plan mode + ADR 显式升级。永不靠放宽预算消红。

import { classifyPath, loadCatalog } from './catalog.mjs';
import { HarnessError, usageError } from './core.mjs';
import { changedPaths, excludeStatePaths, git, gitInfo, splitZero } from './git.mjs';

// 固定话术（任务书指定逐字）：超预算的出路是拆分或升级，不是放宽数字。
const OVER_BUDGET_ADVICE = '超出预算意味着拆分变更或升级——永不靠放宽预算消红';

// numstat 求和：added+removed 行。二进制行（"-\t-\t..."）不计入行数。
function sumNumstat(text) {
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+/.exec(line);
    if (match) { added += Number(match[1]); removed += Number(match[2]); }
  }
  return { added, removed, lines: added + removed };
}

export async function assessBudget(ctx, { staged = false, baseline = null } = {}) {
  if (staged && baseline) throw usageError('budget 的 --staged 与 --baseline 互斥');
  const limits = ctx.budget ?? {};
  const configured = Object.keys(limits).length > 0;

  const info = await gitInfo(ctx);
  if (!info.isGit) {
    throw new HarnessError('降级：非 git 仓，无法测量——budget 需要 git 工作树来计量变更面', 'NON_GIT_BLOCKED', 3);
  }

  // 变更面三种来源：--staged 看暂存区；--baseline <ref> 看 <ref>...HEAD 的提交区间；
  // 默认看整个工作树对 HEAD（与指纹口径一致：暂存+未暂存都算，不让 staged 变更报零）。
  let changed;
  let numstatText;
  let source;
  if (baseline) {
    const ref = await git(ctx, ['rev-parse', '--verify', `${baseline}^{commit}`], { allowFailure: true });
    if (ref.exitCode !== 0) throw usageError(`budget --baseline 的 ref 不存在或不是提交：${baseline}`);
    const names = await git(ctx, ['diff', '--name-only', '-z', `${baseline}...HEAD`, '--', '.']);
    changed = excludeStatePaths(splitZero(names.stdout)).sort();
    numstatText = (await git(ctx, ['diff', '--numstat', `${baseline}...HEAD`, '--', '.'])).stdout;
    source = `baseline ${baseline}...HEAD`;
  } else if (staged) {
    const changes = await changedPaths(ctx);
    changed = changes.staged;
    numstatText = (await git(ctx, ['diff', '--cached', '--numstat', '--', '.'])).stdout;
    source = 'staged';
  } else {
    const changes = await changedPaths(ctx);
    changed = changes.paths;
    numstatText = info.unborn
      ? (await git(ctx, ['diff', '--cached', '--numstat', '--', '.'])).stdout
      : (await git(ctx, ['diff', '--numstat', 'HEAD', '--', '.'])).stdout;
    source = 'worktree';
  }
  const untracked = excludeStatePaths(splitZero(
    (await git(ctx, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).stdout
  ));

  // modulesTouched 依赖 catalog；catalog 缺失时该指标不可测量——若配了 maxModules
  // 上限则整门降级（缺测量绝不假绿），否则如实按 null 报告。
  const catalog = await loadCatalog(ctx).catch((error) => {
    if (error.code === 'JSON_READ_FAILED') return null;
    throw error;
  });
  let modulesTouched = null;
  if (catalog) {
    modulesTouched = new Set(changed
      .map((item) => classifyPath(catalog, item))
      .filter((entry) => entry.classification === 'mapped')
      .map((entry) => entry.module)).size;
  }

  const { added, removed, lines } = sumNumstat(numstatText);
  const metrics = {
    changedFiles: changed.length,
    changedLines: lines,
    added,
    removed,
    modulesTouched,
    newFiles: untracked.length
  };

  if (!configured) {
    return {
      ok: false,
      degraded: true,
      reason: 'harness.json 未配置 budget 段（maxChangedFiles/maxChangedLines/maxModules/maxNewFiles）——预算门未激活；未配置不是通过',
      source,
      metrics,
      limits
    };
  }
  if (limits.maxModules !== undefined && modulesTouched === null) {
    return {
      ok: false,
      degraded: true,
      reason: 'module-catalog.json 缺失：modulesTouched 无法测量，而 budget.maxModules 已配置——缺测量不按通过报',
      source,
      metrics,
      limits
    };
  }

  const findings = [];
  const check = (metric, actual, limit) => {
    if (limit !== undefined && limit !== null && actual !== null && actual > limit) {
      findings.push({ metric, actual, limit });
    }
  };
  check('changedFiles', metrics.changedFiles, limits.maxChangedFiles);
  check('changedLines', metrics.changedLines, limits.maxChangedLines);
  check('modulesTouched', metrics.modulesTouched, limits.maxModules);
  check('newFiles', metrics.newFiles, limits.maxNewFiles);

  return {
    ok: findings.length === 0,
    degraded: false,
    source,
    metrics,
    limits,
    findings,
    advice: findings.length ? OVER_BUDGET_ADVICE : '变更在声明的预算之内。'
  };
}
