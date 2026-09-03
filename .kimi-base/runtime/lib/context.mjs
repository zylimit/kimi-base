// lib/context.mjs —— impact 影响分析 与 context pack 预算化上下文包

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeImpact, loadCatalog, matchesGlob } from './catalog.mjs';
import { HarnessError, atomicWrite, csv, degradedError, normalizeRepoPath, nowIso, sha256, stableJson, toPosix } from './core.mjs';
import { changedPaths, trackedPaths } from './git.mjs';
import { loadMatrix, requiredPlan, topoOrderChecks } from './matrix.mjs';
import { STATE_DIR } from './paths.mjs';
import { stateFile } from './state.mjs';
import { getActiveTask } from './tasks.mjs';

// 变更路径 → 模块归属 → 反向依赖闭包 → 受影响检查计划（planHash 含 risk）。
export async function impactAnalysis(ctx, options = {}) {
  const matrix = await loadMatrix(ctx);
  const impact = await analyzeImpact(ctx, options);
  const risk = options.risk ?? (await getActiveTask(ctx))?.risk ?? ctx.riskDefault ?? 'medium';
  const catalog = await loadCatalog(ctx);
  const checkIds = new Set();
  const reasons = {};
  for (const check of requiredPlan(ctx, matrix, risk).checks) {
    checkIds.add(check.id);
    (reasons[check.id] ??= []).push(`risk:${risk}`);
  }
  for (const module of catalog.modules.filter((item) => impact.affectedModules.includes(item.id))) {
    for (const id of module.verification ?? []) {
      if (!matrix.checks.some((check) => check.id === id)) throw new HarnessError(`模块 ${module.id} 的 verification 引用未知检查：${id}`, 'MATRIX_UNKNOWN_CHECK');
      checkIds.add(id);
      (reasons[id] ??= []).push(`module:${module.id}`);
    }
  }
  const ordered = topoOrderChecks(matrix.checks).filter((check) => checkIds.has(check.id));
  const plan = {
    risk,
    affectedModules: impact.affectedModules,
    expandedToAll: impact.expandedToAll,
    checks: ordered.map((check) => ({ id: check.id, kind: check.kind, reasons: reasons[check.id] ?? [] }))
  };
  const planHash = sha256(stableJson({ ...plan, catalogHash: impact.catalogHash }));
  return { ...impact, risk, plan, planHash };
}

// context pack 的 DENY 清单：凭据永不入包（进 LLM 上下文等于外发）。
function contextDenied(ctx, relativePath) {
  const target = normalizeRepoPath(relativePath);
  const pieces = target.toLowerCase().split('/');
  const base = pieces.at(-1);
  if (pieces.includes('.git')) return 'git 元数据';
  if (target.startsWith(`${STATE_DIR}/`)) return '运行时状态';
  if (ctx.security.dependencyDirs.some((item) => pieces.includes(item.toLowerCase()))) return '依赖/构建目录';
  if (ctx.security.secretDirs.some((item) => pieces.includes(item.toLowerCase()))) return '凭据目录';
  if (ctx.security.allowedSecretTemplates.map((item) => item.toLowerCase()).includes(base)) return null;
  if (ctx.security.secretNames.map((item) => item.toLowerCase()).includes(base)) return '秘密文件';
  if (base.startsWith('.env')) return '环境秘密文件';
  if (ctx.security.secretExtensions.some((item) => base.endsWith(item.toLowerCase()))) return '私钥/证书扩展名';
  if (base.includes('secret') || base.includes('credential')) return '文件名含 secret/credential';
  // 配置追加的 DENY glob（harness.json context.deny）。
  if ((ctx.contextDenyGlobs ?? []).some((pattern) => matchesGlob(target, pattern))) return '配置 DENY 清单命中';
  return null;
}

export async function buildContextPack(ctx, options = {}) {
  const requested = Number.isInteger(options.budget) && options.budget >= 1000 ? options.budget : ctx.contextDefaults.defaultBudget;
  // outputLimits.modelChars 是模型-facing 输出的硬顶：显式 --budget 也不得突破（防上下文灌爆）。
  const budget = Math.min(requested, ctx.outputLimits.modelChars);
  const budgetCapped = budget < requested;
  const focusGlobs = csv(options.focus);
  const tracked = await trackedPaths(ctx, ctx.catalogLimits.maxTrackedPaths).catch(() => ({ isGit: false, paths: [] }));
  const changes = await changedPaths(ctx).catch(() => ({ isGit: false, paths: [] }));
  let impact = null;
  if (changes.isGit) {
    impact = await analyzeImpact(ctx, {}).catch(() => null);
  }
  const catalog = await loadCatalog(ctx).catch(() => null);
  const priority = [];
  const seen = new Set();
  const push = (relative, why) => {
    const key = toPosix(relative);
    if (!seen.has(key)) {
      seen.add(key);
      priority.push({ path: key, why });
    }
  };
  // 优先级：focus 命中 > 受影响模块的 capsule/contracts/tests > 当前变更文件。
  if (focusGlobs.length && tracked.isGit) {
    for (const relative of tracked.paths) {
      if (focusGlobs.some((pattern) => matchesGlob(relative, pattern))) push(relative, `focus:${focusGlobs.find((pattern) => matchesGlob(relative, pattern))}`);
    }
  }
  if (catalog && impact) {
    for (const module of catalog.modules.filter((item) => impact.affectedModules.includes(item.id))) {
      if (module.capsule) push(module.capsule, `capsule:${module.id}`);
      for (const contract of module.contracts ?? []) push(contract, `contract:${module.id}`);
      for (const test of module.tests ?? []) push(test, `test:${module.id}`);
    }
  }
  for (const relative of changes.paths ?? []) push(relative, 'changed');
  if (!focusGlobs.length && !tracked.isGit) {
    throw degradedError('降级：非 git 仓，无法测量——context pack 无法确定选面；请用 --focus 显式指定（不假造上下文）', 'NON_GIT_BLOCKED');
  }
  const included = [];
  const omitted = [];
  let used = 0;
  for (const item of priority.slice(0, ctx.contextDefaults.maxFiles)) {
    const deny = contextDenied(ctx, item.path);
    if (deny) {
      omitted.push({ ...item, reason: `DENY 清单：${deny}` });
      continue;
    }
    let buffer;
    try {
      buffer = await readFile(path.join(ctx.root, item.path));
    } catch {
      omitted.push({ ...item, reason: '文件缺失或不可读' });
      continue;
    }
    if (buffer.includes(0)) {
      omitted.push({ ...item, reason: '二进制文件' });
      continue;
    }
    let text = buffer.toString('utf8');
    let truncated = false;
    const perFileCap = Math.min(ctx.contextDefaults.maxFileChars, Math.max(0, budget - used));
    if (text.length > perFileCap) {
      if (perFileCap < 200) {
        omitted.push({ ...item, reason: '预算耗尽' });
        continue;
      }
      text = text.slice(0, perFileCap);
      truncated = true;
    }
    included.push({ ...item, content: text, chars: text.length, truncated });
    used += text.length;
    if (used >= budget) {
      // 其余全部进 omitted，显式报告不静默丢弃。
      for (const rest of priority.slice(priority.indexOf(item) + 1)) omitted.push({ ...rest, reason: '预算耗尽' });
      break;
    }
  }
  for (const rest of priority.slice(ctx.contextDefaults.maxFiles)) omitted.push({ ...rest, reason: '文件数量上限' });
  const pack = {
    version: 1,
    kind: 'context-pack',
    createdAt: nowIso(),
    budget: { total: budget, used, ...(budgetCapped ? { requested, cappedBy: 'outputLimits.modelChars' } : {}) },
    focus: focusGlobs,
    impact: impact ? { directModules: impact.directModules, affectedModules: impact.affectedModules, expandedToAll: impact.expandedToAll } : null,
    included: included.map((item) => ({ path: item.path, why: item.why, chars: item.chars, truncated: item.truncated, content: item.content })),
    omitted: omitted.map(({ path: itemPath, why, reason }) => ({ path: itemPath, why, reason }))
  };
  const packHash = sha256(stableJson({ ...pack, included: pack.included.map((item) => ({ ...item, content: sha256(item.content) })) }));
  const finalPack = { ...pack, packHash };
  const outPath = stateFile(ctx, path.join('context', `pack-${packHash.slice(0, 16)}.json`));
  await atomicWrite(outPath, finalPack);
  return { ...finalPack, storedAt: toPosix(path.relative(ctx.root, outPath)) };
}
