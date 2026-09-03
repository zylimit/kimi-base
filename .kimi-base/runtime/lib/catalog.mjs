// lib/catalog.mjs —— 模块目录（module-catalog.json）：声明式架构事实

import path from 'node:path';
import { HarnessError, assertKnownFields, assertPlainObject, assertStringArray, degradedError, normalizeRepoPath, readJsonFile, sha256, stableJson, toPosix } from './core.mjs';
import { changedPaths, trackedPaths } from './git.mjs';

// 五性治理：核心五属性 + 扩展属性；六档强制力。
export const ATTRIBUTE_NAMES = new Set([
  'resilience', 'security', 'safety', 'privacy', 'reliability',
  'availability', 'performance', 'maintainability'
]);
const ATTRIBUTE_TIERS = new Set(['critical', 'high', 'medium', 'low', 'minimal', 'none']);
export const GOVERNED_TIERS = new Set(['critical', 'high']);
// 保护底线（P6 起 privacy 入列）：永不豁免、永不 fast-skip；waiver 创建期与运行期双重写死。
export const PROTECTED_ATTRIBUTES = new Set(['security', 'safety', 'privacy']);
export const TIER_RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, critical: 5 };

// 评审 lens/剖面名册：schema 校验的唯一事实源（review.mjs 的 LENS_LIBRARY/REVIEW_PROFILES 以此为准）。
export const REVIEW_LENS_NAMES = new Set([
  'correctness', 'architecture', 'maintainability',
  'testing', 'performance',
  'reliability', 'resilience', 'security', 'privacy'
]);
export const REVIEW_PROFILE_NAMES = new Set(['personal', 'team', 'production', 'regulated']);

// catalog.review 段：结构化对抗评审的选拔与裁决旋钮（全部可选；缺省 = 不启用完成门评审要求）。
function validateReviewSection(review) {
  assertPlainObject(review, 'review');
  assertKnownFields(review, new Set(['profile', 'lenses', 'maxRounds', 'requireStructured']), 'review');
  if (review.profile !== undefined && !REVIEW_PROFILE_NAMES.has(review.profile)) {
    throw new HarnessError(`review.profile 非法：${String(review.profile)}（可选 ${[...REVIEW_PROFILE_NAMES].join('/')}）`, 'CATALOG_INVALID');
  }
  if (review.lenses !== undefined) {
    assertStringArray(review.lenses, 'review.lenses');
    for (const lens of review.lenses) {
      if (!REVIEW_LENS_NAMES.has(lens)) throw new HarnessError(`review.lenses 含未知 lens：${lens}`, 'CATALOG_INVALID');
    }
  }
  if (review.maxRounds !== undefined && (!Number.isInteger(review.maxRounds) || review.maxRounds < 1 || review.maxRounds > 10)) {
    throw new HarnessError('review.maxRounds 必须是 1..10 的整数', 'CATALOG_INVALID');
  }
  if (review.requireStructured !== undefined && typeof review.requireStructured !== 'boolean') {
    throw new HarnessError('review.requireStructured 必须是布尔', 'CATALOG_INVALID');
  }
  return review;
}

// glob 编译缓存：覆盖判定会对每个 tracked 路径测试每个模式，重编译曾是 60 万行级
// 仓库的主要耗时；缓存后 lint/impact 满足性能预算。
const GLOB_CACHE = new Map();

function compileGlob(pattern) {
  let source = '';
  const value = toPosix(pattern);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*') {
      if (value[index + 1] === '*') {
        index += 1;
        source += value[index + 1] === '/' ? '(?:.*/)?' : '.*';
        if (value[index + 1] === '/') index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function globRegex(pattern) {
  let compiled = GLOB_CACHE.get(pattern);
  if (!compiled) {
    compiled = compileGlob(pattern);
    if (GLOB_CACHE.size >= 10000) GLOB_CACHE.clear();
    GLOB_CACHE.set(pattern, compiled);
  }
  return compiled;
}

export function matchesGlob(relativePath, pattern) {
  return globRegex(pattern).test(toPosix(relativePath));
}

function moduleMatches(module, relativePath) {
  const target = toPosix(relativePath);
  // 模板系模块：paths 直接是仓根 glob。
  if (module.repoRooted) return module.paths.some((pattern) => matchesGlob(target, pattern));
  const root = module.root === '.' ? '' : module.root.replace(/\/$/, '');
  if (root && target !== root && !target.startsWith(`${root}/`)) return false;
  const inside = root ? target.slice(root.length).replace(/^\//, '') : target;
  return module.paths.some((pattern) => matchesGlob(inside, pattern));
}

// catalog.cochange 段：共变耦合的既受清单与样本门槛（全部可选）。
// accepted 是留痕决策（与 none/minimal 定档同级）：[[moduleA, moduleB, "理由"]]，理由必填。
function validateCochangeSection(cochange, knownModuleIds) {
  assertPlainObject(cochange, 'cochange');
  assertKnownFields(cochange, new Set(['accepted', 'minSample']), 'cochange');
  if (cochange.minSample !== undefined
    && (!Number.isInteger(cochange.minSample) || cochange.minSample < 1)) {
    throw new HarnessError('cochange.minSample 必须是正整数', 'CATALOG_INVALID');
  }
  if (cochange.accepted !== undefined) {
    if (!Array.isArray(cochange.accepted)) throw new HarnessError('cochange.accepted 必须是数组', 'CATALOG_INVALID');
    for (const entry of cochange.accepted) {
      if (!Array.isArray(entry) || entry.length !== 3
        || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
        || typeof entry[2] !== 'string' || !entry[2].trim()) {
        throw new HarnessError('cochange.accepted 每条必须是 [moduleA, moduleB, "理由"] 三元组（理由必填——接受耦合是留痕决策）', 'CATALOG_INVALID');
      }
      if (entry[0] === entry[1]) throw new HarnessError(`cochange.accepted 自指条目：${entry[0]}`, 'CATALOG_INVALID');
      for (const id of [entry[0], entry[1]]) {
        if (!knownModuleIds.has(id)) throw new HarnessError(`cochange.accepted 引用未知模块：${id}`, 'CATALOG_UNKNOWN_DEPENDENCY');
      }
    }
  }
  return cochange;
}

// 属性声明：字符串档位，或 { tier, reason } 对象；none/minimal 必须带书面 reason。
function parseAttributeDeclaration(value, label) {
  let tier;
  let reason;
  if (typeof value === 'string') {
    tier = value;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    assertKnownFields(value, new Set(['tier', 'reason']), label);
    tier = value.tier;
    reason = value.reason;
  } else {
    throw new HarnessError(`${label} 必须是档位字符串或 {tier, reason} 对象`, 'CATALOG_INVALID');
  }
  if (!ATTRIBUTE_TIERS.has(tier)) throw new HarnessError(`${label} 档位非法：${String(tier)}`, 'CATALOG_INVALID');
  if ((tier === 'none' || tier === 'minimal') && (typeof reason !== 'string' || !reason.trim())) {
    throw new HarnessError(`${label} 档位 ${tier} 必须附书面理由；退出治理是留痕决策不是零成本默认`, 'CATALOG_UNJUSTIFIED_TIER');
  }
  return { tier, reason: reason ?? null };
}

function validateCatalog(catalog) {
  assertPlainObject(catalog, 'module-catalog');
  assertKnownFields(catalog, new Set(['version', 'layers', 'globalPaths', 'ignored', 'modules', 'review', 'cochange']), 'module-catalog');
  if (catalog.version !== 1 || !Array.isArray(catalog.modules)) {
    throw new HarnessError('module-catalog 的 version/modules 非法', 'CATALOG_INVALID');
  }
  if (catalog.review !== undefined) validateReviewSection(catalog.review);
  if (catalog.layers !== undefined) {
    assertStringArray(catalog.layers, 'layers', { allowEmpty: false });
    if (new Set(catalog.layers).size !== catalog.layers.length) throw new HarnessError('layers 不得重复', 'CATALOG_INVALID');
  }
  assertStringArray(catalog.globalPaths ?? [], 'globalPaths', { allowEmpty: false });
  for (const pattern of catalog.globalPaths ?? []) {
    if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new HarnessError(`globalPaths 逃逸仓库：${pattern}`, 'CATALOG_INVALID');
  }
  if (!Array.isArray(catalog.ignored ?? [])) throw new HarnessError('ignored 必须是数组', 'CATALOG_INVALID');
  for (const entry of catalog.ignored ?? []) {
    if (!entry || typeof entry.pattern !== 'string' || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new HarnessError('每个 ignored 条目都必须带 reason', 'CATALOG_INVALID');
    }
    if (entry.pattern.split(/[\\/]/).includes('..') || path.isAbsolute(entry.pattern)) throw new HarnessError(`ignored 模式逃逸仓库：${entry.pattern}`, 'CATALOG_INVALID');
  }
  const ids = new Set();
  for (const module of catalog.modules) {
    assertPlainObject(module, `module ${module?.id ?? module?.name ?? '?'}`);
    assertKnownFields(module, new Set([
      'id', 'name', 'root', 'paths', 'dependsOn', 'forbiddenDependencies', 'layer', 'shared',
      'owners', 'provides', 'attributes', 'contracts', 'capsule', 'tests', 'verification'
    ]), `module ${module.id ?? module.name ?? '?'}`);
    // 两种合法形态：{id, root, paths:[root 内 glob]}（codex 系）或 {name, paths:[仓根 glob]}（模板系）。
    const rawId = module.id ?? module.name;
    if (module.id !== undefined && module.name !== undefined) throw new HarnessError(`模块 ${rawId} 不得同时给 id 与 name`, 'CATALOG_INVALID');
    if (!/^[a-z][a-z0-9-]*$/.test(rawId ?? '')) throw new HarnessError(`非法模块 id：${rawId}`, 'CATALOG_INVALID');
    if (ids.has(rawId)) throw new HarnessError(`模块 id 重复：${rawId}`, 'CATALOG_INVALID');
    ids.add(rawId);
    module.id = rawId;
    delete module.name;
    assertStringArray(module.paths ?? [], `${module.id}.paths`, { allowEmpty: false });
    module.paths = module.paths ?? [];
    let repoRooted = false;
    if (module.root === undefined) {
      // 模板系：paths 是仓根 glob；root 取所有模式的静态公共前缀。
      repoRooted = true;
      const staticPrefix = (pattern) => toPosix(pattern).split('/').filter((seg) => !seg.includes('*') && !seg.includes('?'));
      const prefixLists = module.paths.map(staticPrefix);
      let common = prefixLists[0] ?? [];
      for (const list of prefixLists.slice(1)) {
        let index = 0;
        while (index < common.length && index < list.length && common[index] === list[index]) index += 1;
        common = common.slice(0, index);
      }
      module.root = common.length ? common.join('/') : '.';
    } else {
      module.root = module.root === '.' ? '.' : normalizeRepoPath(module.root);
    }
    module.repoRooted = repoRooted;
    for (const label of ['dependsOn', 'owners', 'provides', 'contracts', 'tests', 'verification']) {
      assertStringArray(module[label] ?? [], `${module.id}.${label}`, { allowEmpty: false });
      module[label] = module[label] ?? [];
    }
    if (module.forbiddenDependencies !== undefined) assertStringArray(module.forbiddenDependencies, `${module.id}.forbiddenDependencies`, { allowEmpty: false });
    if (typeof module.shared !== 'boolean') module.shared = Boolean(module.shared);
    if (module.layer !== undefined) {
      if (typeof module.layer !== 'string' || !module.layer) throw new HarnessError(`${module.id}.layer 必须是非空字符串`, 'CATALOG_INVALID');
      if (!Array.isArray(catalog.layers) || !catalog.layers.includes(module.layer)) {
        throw new HarnessError(`${module.id}.layer "${module.layer}" 未在 catalog.layers 中声明`, 'CATALOG_INVALID');
      }
    }
    if (module.attributes !== undefined) {
      assertPlainObject(module.attributes, `${module.id}.attributes`);
      const parsed = {};
      for (const [attribute, declaration] of Object.entries(module.attributes)) {
        if (!ATTRIBUTE_NAMES.has(attribute)) throw new HarnessError(`${module.id}.attributes 含未知属性：${attribute}`, 'CATALOG_INVALID');
        parsed[attribute] = parseAttributeDeclaration(declaration, `${module.id}.attributes.${attribute}`);
      }
      module.attributes = parsed;
    } else {
      module.attributes = {};
    }
    if (module.capsule !== undefined && module.capsule !== null) module.capsule = normalizeRepoPath(module.capsule);
    for (const pattern of module.paths) {
      if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new HarnessError(`模块路径逃逸 root：${module.id}:${pattern}`, 'CATALOG_INVALID');
    }
    // 拒绝 catch-all：根模块配裸 ** 会把覆盖缺口全部掩盖掉。
    if ((module.root === '.' || module.root === '') && module.paths.some((item) => item === '**' || item === '**/*')) {
      throw new HarnessError(`根模块 ${module.id} 使用裸 ** catch-all，会掩盖覆盖缺口`, 'CATALOG_CATCH_ALL');
    }
  }
  for (const module of catalog.modules) {
    for (const dependency of module.dependsOn) {
      if (!ids.has(dependency)) throw new HarnessError(`模块 ${module.id} 依赖未知模块：${dependency}（DANGLING_DEP）`, 'CATALOG_UNKNOWN_DEPENDENCY');
    }
    for (const forbidden of module.forbiddenDependencies ?? []) {
      if (!ids.has(forbidden)) throw new HarnessError(`模块 ${module.id} 禁止依赖未知模块：${forbidden}`, 'CATALOG_UNKNOWN_DEPENDENCY');
    }
  }
  if (catalog.cochange !== undefined) validateCochangeSection(catalog.cochange, ids);
  return catalog;
}

export async function loadCatalog(ctx) {
  return validateCatalog(await readJsonFile(ctx.catalogPath));
}

// 声明图依赖环：DFS 灰栈。声明图已腐化时必须报告而非隐藏。
export function dependencyCycles(catalog) {
  const byId = new Map(catalog.modules.map((module) => [module.id, module]));
  const cycles = [];
  const state = new Map();
  const stack = [];
  function visit(id) {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, 'active');
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  }
  for (const module of catalog.modules) visit(module.id);
  return cycles;
}

// 路径归类：ignored > globalPaths（含 .kimi-base/** 隐式全局）> module > unmapped。
// sync-check 的"governed"定义即 classification === 'mapped'（模块路径，不含 globalPaths）。
export function classifyPath(catalog, relativePath) {
  const target = normalizeRepoPath(relativePath);
  const ignored = (catalog.ignored ?? []).find((entry) => matchesGlob(target, entry.pattern));
  if (ignored) return { path: target, classification: 'ignored', reason: ignored.reason, modules: [] };
  // .kimi-base/** 是框架自有配置面，隐式全局（trackedPaths 已排除 state/）。
  const globalPatterns = ['.kimi-base/**', ...(catalog.globalPaths ?? [])];
  if (globalPatterns.some((pattern) => matchesGlob(target, pattern))) {
    return { path: target, classification: 'global', reason: '全局路径', modules: [] };
  }
  const matches = catalog.modules.filter((module) => moduleMatches(module, target));
  if (!matches.length) return { path: target, classification: 'unmapped', reason: '没有任何模块模式命中', modules: [] };
  matches.sort((left, right) => right.root.length - left.root.length || left.id.localeCompare(right.id));
  const deepestLength = matches[0].root.length;
  const deepest = matches.filter((item) => item.root.length === deepestLength);
  if (deepest.length > 1) {
    return { path: target, classification: 'overlap', reason: '同深度多个模块命中（OVERLAP）', modules: deepest.map((item) => item.id) };
  }
  return { path: target, classification: 'mapped', reason: '最深有效模块命中', module: deepest[0].id, modules: matches.map((item) => item.id) };
}

export async function lintCatalog(ctx, explicitPaths = []) {
  const catalog = await loadCatalog(ctx);
  const tracked = await trackedPaths(ctx, ctx.catalogLimits.maxTrackedPaths);
  if (!tracked.isGit && explicitPaths.length === 0) {
    throw degradedError('降级：非 git 仓，无法测量——catalog lint 需要 git（git ls-files 枚举 tracked 路径）；请用 --paths 显式指定', 'NON_GIT_BLOCKED');
  }
  const paths = [...new Set([...tracked.paths, ...explicitPaths.map(normalizeRepoPath)])].sort();
  const entries = paths.map((item) => classifyPath(catalog, item));
  const counts = {};
  for (const item of entries) counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  const failures = entries.filter((item) => item.classification === 'unmapped' || item.classification === 'overlap');
  if (tracked.truncated) failures.push({ path: '<tracked-path-limit>', classification: 'truncated', reason: `tracked 路径数 ${tracked.total} 超过上限，按坏测量处理` });
  for (const cycle of dependencyCycles(catalog)) {
    failures.push({ path: '<dependency-cycle>', classification: 'cycle', reason: `模块依赖环：${cycle.join(' -> ')}` });
  }
  return { ok: failures.length === 0, catalogHash: sha256(stableJson(catalog)), total: paths.length, counts, failures, entries, truncated: tracked.truncated };
}

function reverseGraph(catalog) {
  const graph = new Map(catalog.modules.map((module) => [module.id, new Set()]));
  for (const module of catalog.modules) {
    for (const dependency of module.dependsOn) graph.get(dependency)?.add(module.id);
  }
  return graph;
}

function reverseDependencyClosure(catalog, directIds) {
  const graph = reverseGraph(catalog);
  const affected = new Set(directIds);
  const queue = [...directIds];
  while (queue.length) {
    const current = queue.shift();
    for (const consumer of graph.get(current) ?? []) {
      if (!affected.has(consumer)) {
        affected.add(consumer);
        queue.push(consumer);
      }
    }
  }
  return [...affected].sort();
}

// 影响分析：unmapped/shared/global/截断一律保守扩散到全模块——宁可全跑不可漏测。
export async function analyzeImpact(ctx, options = {}) {
  const catalog = await loadCatalog(ctx);
  const discovered = options.paths
    ? { isGit: true, paths: options.paths.map(normalizeRepoPath), truncated: Boolean(options.truncated), note: '显式路径' }
    : await changedPaths(ctx);
  if (!options.paths && !discovered.isGit) {
    throw degradedError('降级：非 git 仓，无法测量——impact --git 需要 git 工作树；请显式给路径（impact <paths...>）', 'NON_GIT_BLOCKED');
  }
  const limit = ctx.catalogLimits.maxChangedPaths;
  const changes = {
    ...discovered,
    paths: discovered.paths.slice(0, limit),
    truncated: Boolean(discovered.truncated || discovered.paths.length > limit),
    total: discovered.paths.length
  };
  const classifications = changes.paths.map((item) => classifyPath(catalog, item));
  const direct = [...new Set(classifications.filter((item) => item.classification === 'mapped').map((item) => item.module))].sort();
  const directModules = catalog.modules.filter((module) => direct.includes(module.id));
  const expansionReasons = [];
  if (changes.truncated) expansionReasons.push('变更路径清单被截断');
  if (classifications.some((item) => item.classification === 'global')) expansionReasons.push('全局路径变更');
  if (classifications.some((item) => item.classification === 'unmapped' || item.classification === 'overlap')) expansionReasons.push('存在 unmapped/overlap 路径');
  if (directModules.some((module) => module.shared)) expansionReasons.push('shared 模块变更');
  const all = catalog.modules.map((module) => module.id).sort();
  const affectedModules = expansionReasons.length ? all : reverseDependencyClosure(catalog, direct);
  return {
    catalogHash: sha256(stableJson(catalog)),
    changedPaths: changes.paths,
    classifications,
    directModules: direct,
    affectedModules,
    expandedToAll: expansionReasons.length > 0,
    expansionReasons,
    truncated: changes.truncated
  };
}
