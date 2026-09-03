// lib/cochange.mjs —— cochange：用 git 历史测量模块共变耦合
//
// 移植自 dsh-base graph.mjs coChange。边界对不对不由行数判断，由"哪些模块
// 实际一起变"判断：高耦合且没有声明边 = 边界画错了；接受它需要在
// catalog.cochange.accepted 里写书面理由——与属性退出治理同级的留痕决策。

import { classifyPath, loadCatalog } from './catalog.mjs';
import { HarnessError, usageError } from './core.mjs';
import { git, gitInfo } from './git.mjs';

// git log 输出的提交分隔哨兵（不能出现在路径里）。
const SENTINEL = '@@KIMI-COMMIT@@';

export async function cochangeAnalysis(ctx, { limit = 500, minPairs = 3, ratio = 0.5, maxModulesPerCommit = 8 } = {}) {
  for (const [name, value, valid] of [
    ['--limit', limit, (v) => Number.isInteger(v) && v >= 1 && v <= 100000],
    ['--min-pairs', minPairs, (v) => Number.isInteger(v) && v >= 1 && v <= 10000]
  ]) {
    if (!valid(value)) throw usageError(`cochange 的 ${name} 非法：${value}`);
  }
  if (!(typeof ratio === 'number' && ratio > 0 && ratio <= 1)) {
    throw usageError(`cochange 的 --ratio 必须是 (0,1] 区间的小数：${ratio}`);
  }
  const info = await gitInfo(ctx);
  if (!info.isGit) {
    throw new HarnessError('降级：非 git 仓，无法测量——cochange 需要 git 历史来测量耦合', 'NON_GIT_BLOCKED', 3);
  }
  if (info.unborn) {
    throw new HarnessError('降级：仓库尚无提交（unborn HEAD）——没有历史就没有耦合可测', 'COCHANGE_NO_HISTORY', 3);
  }
  const catalog = await loadCatalog(ctx);

  const log = await git(ctx, ['-c', 'core.quotePath=false', 'log', '-n', String(limit), '--no-merges',
    '--name-only', `--pretty=format:${SENTINEL}%H`], { timeoutMs: 60000 });

  const commits = [];
  let current = null;
  for (const line of log.stdout.split('\n')) {
    if (line.startsWith(SENTINEL)) {
      current = { sha: line.slice(SENTINEL.length), paths: [] };
      commits.push(current);
      continue;
    }
    const item = line.trim();
    if (item && current) current.paths.push(item);
  }

  const byId = new Map((catalog.modules ?? []).map((module) => [module.id, module]));
  const solo = new Map();
  const pairs = new Map();
  let analysed = 0;
  let sweeping = 0;

  for (const commit of commits) {
    const modules = [...new Set(commit.paths
      .map((item) => classifyPath(catalog, item))
      .filter((entry) => entry.classification === 'mapped')
      .map((entry) => entry.module))].sort();
    if (modules.length === 0) continue;
    // 发版提交或全仓格式化触碰一切，对耦合什么都没说。排除它必须被报告，绝不静默。
    if (modules.length > maxModulesPerCommit) { sweeping += 1; continue; }
    analysed += 1;
    for (const id of modules) solo.set(id, (solo.get(id) ?? 0) + 1);
    for (let index = 0; index < modules.length; index += 1) {
      for (let other = index + 1; other < modules.length; other += 1) {
        const key = `${modules[index]}|${modules[other]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  const declared = (a, b) => {
    const ma = byId.get(a);
    const mb = byId.get(b);
    return Boolean((ma && (ma.dependsOn ?? []).includes(b)) || (mb && (mb.dependsOn ?? []).includes(a)));
  };

  const rows = [];
  for (const [key, count] of pairs) {
    const [a, b] = key.split('|');
    const denominator = Math.min(solo.get(a) ?? 1, solo.get(b) ?? 1);
    const coupling = denominator ? count / denominator : 0;
    rows.push({
      a, b, coChanges: count,
      commitsA: solo.get(a) ?? 0,
      commitsB: solo.get(b) ?? 0,
      coupling: Number(coupling.toFixed(3)),
      declaredEdge: declared(a, b),
      layerA: byId.get(a)?.layer ?? null,
      layerB: byId.get(b)?.layer ?? null
    });
  }
  rows.sort((left, right) => right.coupling - left.coupling || right.coChanges - left.coChanges);

  // 接受耦合是留痕决策：带书面理由，保持可见（降级为 warning 而不是消失）。
  const accepted = new Map();
  for (const entry of catalog.cochange?.accepted ?? []) {
    accepted.set([entry[0], entry[1]].sort().join('|'), entry[2]);
  }

  const findings = [];
  const minSample = catalog.cochange?.minSample ?? 30;
  if (analysed < minSample) {
    findings.push({
      severity: 'warning',
      code: 'LOW_CONFIDENCE',
      message: `只有 ${analysed} 个提交携带了模块变更，低于得出结论所需的 ${minSample}；以下一切结果按提示对待，不是测量`
    });
  }
  for (const row of rows) {
    if (row.coChanges < minPairs || row.coupling < ratio) continue;
    const key = [row.a, row.b].sort().join('|');
    if (accepted.has(key)) {
      findings.push({
        severity: 'warning',
        code: 'ACCEPTED_COUPLING',
        pair: [row.a, row.b],
        coupling: row.coupling,
        coChanges: row.coChanges,
        message: `${row.a} 与 ${row.b} 耦合度 ${Math.round(row.coupling * 100)}%，已接受：${accepted.get(key)}`
      });
      continue;
    }
    findings.push({
      severity: row.declaredEdge ? 'warning' : 'error',
      code: row.declaredEdge ? 'HIGH_COUPLING' : 'BOUNDARY_SUSPECT',
      pair: [row.a, row.b],
      coupling: row.coupling,
      coChanges: row.coChanges,
      message: `${row.a} 与 ${row.b} 在 ${Math.min(row.commitsA, row.commitsB)} 个提交中共同变更 ${row.coChanges} 次（${Math.round(row.coupling * 100)}%）`
        + (row.declaredEdge
          ? '；依赖已声明，但这种耦合度意味着它们无法独立发布'
          : '；两者之间没有声明的依赖——要么边界画错了，要么声明图不完整')
    });
  }

  // 从不与任何东西共变的模块是抽成独立仓库的最安全候选。
  const isolated = (catalog.modules ?? [])
    .filter((module) => (solo.get(module.id) ?? 0) >= minPairs)
    .filter((module) => ![...pairs.keys()].some((key) => key.split('|').includes(module.id)))
    .map((module) => module.id);

  const errors = findings.filter((finding) => finding.severity === 'error');
  return {
    ok: errors.length === 0,
    commits: commits.length,
    analysed,
    sweeping,
    modules: solo.size,
    top: rows.slice(0, 20),
    findings,
    isolatedModules: isolated,
    counts: { error: errors.length, warning: findings.length - errors.length },
    advice: isolated.length
      ? `从不与任何模块共变的模块是抽成独立仓库的最安全候选：${isolated.join(', ')}`
      : '在这个窗口内没有任何模块完全独立；抽走任何一个都是一次协同发布。'
  };
}
