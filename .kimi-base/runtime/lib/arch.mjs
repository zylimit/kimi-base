// lib/arch.mjs —— 架构防腐（arch check / baseline / trend、adr check）

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { dependencyCycles, loadCatalog } from './catalog.mjs';
import { HarnessError, atomicWrite, degradedError, nowIso, readJsonFile, sha256, toPosix, usageError } from './core.mjs';
import { FITNESS_RULES } from './fitness.mjs';
import { trackedPaths } from './git.mjs';
import { BUILTIN_CHECKS, loadMatrix } from './matrix.mjs';
import { ARCH_TREND_FILE } from './paths.mjs';
import { readState, writeState } from './state.mjs';

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.py', '.go', '.java', '.kt', '.kts', '.cs', '.rs', '.rb', '.php', '.swift', '.scala'
]);
const JS_RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_SOURCE_BYTES = 1500000;

// 多语言 import 正则表（移植自 pi-base/cursor-base 供体）。
const IMPORT_PATTERNS = [
  { extensions: /\.(m|c)?(j|t)sx?$/, patterns: [
    /\bimport\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[\w*{}\n\r\t, ]+\s+)?from\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ] },
  { extensions: /\.py$/, patterns: [/^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm, /^[ \t]*import[ \t]+([.\w]+)/gm] },
  { extensions: /\.go$/, patterns: [/^[ \t]*(?:[\w.]+\s+)?"([^"]+)"/gm] },
  { extensions: /\.(java|kt|kts|scala)$/, patterns: [/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm] },
  { extensions: /\.cs$/, patterns: [/^[ \t]*using[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;/gm] },
  { extensions: /\.rs$/, patterns: [/^[ \t]*use[ \t]+([\w:]+)/gm] },
  { extensions: /\.rb$/, patterns: [/\brequire(?:_relative)?\s+["']([^"']+)["']/g] },
  { extensions: /\.php$/, patterns: [/^[ \t]*use[ \t]+([\w\\]+)/gm] },
  { extensions: /\.swift$/, patterns: [/^[ \t]*import[ \t]+([\w.]+)/gm] }
];

export function extractImports(filePath, content) {
  const found = new Set();
  for (const group of IMPORT_PATTERNS) {
    if (!group.extensions.test(filePath)) continue;
    for (const pattern of group.patterns) {
      pattern.lastIndex = 0;
      let match = pattern.exec(content);
      while (match) {
        if (match[1]) found.add(match[1]);
        match = pattern.exec(content);
      }
    }
  }
  return [...found];
}

// 模块归属：root 前缀最深者胜（root='.' 的模块不参与实边归属，避免吞掉一切边）。
function owningModule(catalog, relativePath) {
  const target = toPosix(relativePath);
  let best = null;
  for (const module of catalog.modules) {
    if (module.root === '.' || module.root === '') continue;
    const root = module.root.replace(/\/$/, '');
    if (target === root || target.startsWith(`${root}/`)) {
      if (!best || root.length > best.root.length) best = module;
    }
  }
  return best;
}

// 相对 import 解析到 tracked 文件；NodeNext 的 .js->.ts 回写必须支持，否则 TS 图全 unresolved。
function resolveRelativeImport(fromFile, specifier, trackedSet) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (!base || base === '..' || base.startsWith('../')) return null;
  const candidates = [base, ...JS_RESOLUTION_EXTENSIONS.map((extension) => base + extension)];
  const rewritten = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  if (rewritten !== base) for (const extension of JS_RESOLUTION_EXTENSIONS) candidates.push(rewritten + extension);
  for (const extension of JS_RESOLUTION_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  candidates.push(`${base}.py`, `${base}/__init__.py`);
  for (const candidate of candidates) if (trackedSet.has(candidate)) return candidate;
  return null;
}

// 裸 specifier 归属：provides 前缀或 root 路径前缀，最长前缀胜。
function moduleForSpecifier(catalog, specifier) {
  let best = null;
  let bestLength = -1;
  for (const module of catalog.modules) {
    const prefixes = [...(module.provides ?? []), ...(module.root !== '.' ? [module.root] : [])];
    for (const prefix of prefixes) {
      if (specifier !== prefix && !specifier.startsWith(`${prefix}/`) && !specifier.startsWith(`${prefix}.`)) continue;
      if (prefix.length > bestLength) { best = module; bestLength = prefix.length; }
    }
  }
  return best;
}

function layerIndex(catalog, module) {
  if (!Array.isArray(catalog.layers) || !module?.layer) return null;
  const index = catalog.layers.indexOf(module.layer);
  return index === -1 ? null : index;
}

function violationFingerprintOf(violation) {
  return sha256(`${violation.kind}\0${violation.from}\0${violation.to ?? ''}`);
}

// 声明图违规：环 + 声明即禁令（禁令赢）+ 声明边的分层方向。
function declaredGraphViolations(catalog) {
  const byId = new Map(catalog.modules.map((module) => [module.id, module]));
  const violations = [];
  for (const cycle of dependencyCycles(catalog)) {
    violations.push({ kind: 'dependency-cycle', from: cycle[0], to: cycle.at(-1), detail: `依赖环：${cycle.join(' -> ')}` });
  }
  for (const module of catalog.modules) {
    for (const forbidden of module.forbiddenDependencies ?? []) {
      if (module.dependsOn.includes(forbidden)) {
        violations.push({ kind: 'forbidden-dependency', from: module.id, to: forbidden, detail: '声明的依赖同时被 forbiddenDependencies 禁止（禁令赢）' });
      }
    }
    const fromLayer = layerIndex(catalog, module);
    if (fromLayer === null) continue;
    for (const dependency of module.dependsOn) {
      const toLayer = layerIndex(catalog, byId.get(dependency));
      if (toLayer !== null && toLayer > fromLayer) {
        violations.push({ kind: 'layer-direction', from: module.id, to: dependency, detail: `层 "${module.layer}" 只允许依赖同层或更内层，却依赖了 "${byId.get(dependency).layer}"` });
      }
    }
  }
  return violations;
}

// 实边扫描：git ls-files 优先于目录遍历；只统计跨模块边；unresolved 如实计数。
// 导出给 catalog discover 作探针：草案模块的 dependsOn 从真实 import 边推导，
// 让草案图从第一天起就贴合代码，而不是第一次漂移后才对齐。
export async function scanRealEdges(ctx, catalog) {
  const tracked = await trackedPaths(ctx, ctx.catalogLimits.maxTrackedPaths);
  if (!tracked.isGit) throw degradedError('降级：非 git 仓，无法测量——arch 实边扫描需要 git（git ls-files）', 'NON_GIT_BLOCKED');
  const trackedSet = new Set(tracked.paths);
  const candidates = tracked.paths.filter((item) => SOURCE_EXTENSIONS.has(path.posix.extname(item).toLowerCase()));
  const scanned = candidates.slice(0, ctx.catalogLimits.maxScanFiles);
  const edges = new Map();
  let parsedFiles = 0;
  let unresolvedImports = 0;
  for (const relative of scanned) {
    const fromModule = owningModule(catalog, relative);
    if (!fromModule) continue;
    let text;
    try {
      const info = await stat(path.join(ctx.root, relative));
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) continue;
      const buffer = await readFile(path.join(ctx.root, relative));
      if (buffer.includes(0)) continue;
      text = buffer.toString('utf8');
    } catch {
      continue; // 已删除但 tracked 或不可读的路径不携带 import 边
    }
    parsedFiles += 1;
    for (const specifier of extractImports(relative, text)) {
      let toModule = null;
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(relative, specifier, trackedSet);
        if (!resolved) { unresolvedImports += 1; continue; }
        toModule = owningModule(catalog, resolved);
      } else {
        toModule = moduleForSpecifier(catalog, specifier);
        if (!toModule) unresolvedImports += 1;
      }
      if (!toModule || toModule.id === fromModule.id) continue;
      const key = `${fromModule.id}\0${toModule.id}`;
      const edge = edges.get(key) ?? { from: fromModule.id, to: toModule.id, count: 0, examples: [] };
      edge.count += 1;
      if (edge.examples.length < 3) edge.examples.push(`${relative} -> ${specifier}`);
      edges.set(key, edge);
    }
  }
  return {
    edges: [...edges.values()].sort((left, right) => `${left.from}/${left.to}`.localeCompare(`${right.from}/${right.to}`)),
    scannedFiles: parsedFiles,
    candidateFiles: candidates.length,
    truncated: candidates.length > scanned.length || tracked.truncated,
    unresolvedImports
  };
}

// 实边违规：禁边 > 分层 > 未声明。
function realEdgeViolations(catalog, scan) {
  const byId = new Map(catalog.modules.map((module) => [module.id, module]));
  const violations = [];
  for (const edge of scan.edges) {
    const fromModule = byId.get(edge.from);
    const toModule = byId.get(edge.to);
    if ((fromModule.forbiddenDependencies ?? []).includes(edge.to)) {
      violations.push({ kind: 'forbidden-dependency', from: edge.from, to: edge.to, detail: `真实 import 边命中禁令（${edge.examples[0]}）` });
      continue;
    }
    const fromLayer = layerIndex(catalog, fromModule);
    const toLayer = layerIndex(catalog, toModule);
    if (fromLayer !== null && toLayer !== null && toLayer > fromLayer) {
      violations.push({ kind: 'layer-direction', from: edge.from, to: edge.to, detail: `真实 import 边违反分层方向（${edge.examples[0]}）` });
      continue;
    }
    if (!fromModule.dependsOn.includes(edge.to)) {
      violations.push({ kind: 'undeclared-dependency', from: edge.from, to: edge.to, detail: `真实 import 边未在 dependsOn 声明（${edge.examples[0]}）` });
    }
  }
  return violations;
}

export async function readArchBaseline(ctx) {
  const baseline = await readJsonFile(ctx.archBaselinePath, { required: false });
  if (baseline === null) return { version: 1, entries: [] };
  if (baseline.version !== 1 || !Array.isArray(baseline.entries)) throw new HarnessError('arch-baseline.json 非法', 'ARCH_BASELINE_INVALID');
  for (const entry of baseline.entries) {
    if (typeof entry?.fingerprint !== 'string' || typeof entry?.from !== 'string' || typeof entry?.to !== 'string'
      || typeof entry?.reason !== 'string' || !entry.reason.trim()) {
      throw new HarnessError('arch-baseline 每条必须带 fingerprint/from/to/reason（进 git 可评审）', 'ARCH_BASELINE_INVALID');
    }
  }
  return baseline;
}

export async function archCheckRun(ctx, options = {}) {
  const catalog = await loadCatalog(ctx);
  const declared = declaredGraphViolations(catalog);
  let scan = null;
  let real = [];
  let unusedDeclarations = [];
  if (options.scan) {
    scan = await scanRealEdges(ctx, catalog);
    real = realEdgeViolations(catalog, scan);
    // 声明但无实边 = warning（可见不拦）。
    const actualPairs = new Set(scan.edges.map((edge) => `${edge.from}\0${edge.to}`));
    for (const module of catalog.modules) {
      for (const dependency of module.dependsOn) {
        if (!actualPairs.has(`${module.id}\0${dependency}`)) unusedDeclarations.push({ from: module.id, to: dependency });
      }
    }
  }
  const violations = [...declared, ...real].map((item) => ({ ...item, fingerprint: violationFingerprintOf(item) }));
  const baseline = await readArchBaseline(ctx);
  const baselined = new Map(baseline.entries.map((entry) => [entry.fingerprint, entry]));
  const fresh = violations.filter((item) => !baselined.has(item.fingerprint));
  const tolerated = violations.filter((item) => baselined.has(item.fingerprint));
  // 已还清的 baseline 条目 = stale，要求删除（棘轮只许降不许升；留着等于预授权新债）。
  const stale = options.scan
    ? baseline.entries.filter((entry) => !violations.some((item) => item.fingerprint === entry.fingerprint))
    : [];
  const notes = [];
  if (!options.scan) notes.push('未加 --scan：只校验声明图（环/禁令/分层），未扫描真实 import 边');
  if (scan) {
    if (scan.truncated) notes.push(`实边扫描被截断（${scan.scannedFiles}/${scan.candidateFiles}），覆盖不完整按坏测量对待`);
    notes.push(`未解析 import 计数：${scan.unresolvedImports}（如实报告，不算违规也不算通过）`);
  }
  const ok = fresh.length === 0 && stale.length === 0;
  const lines = [
    `arch check：声明图违规 ${declared.length}；实边违规 ${real.length}；新债 ${fresh.length}；baseline 容忍 ${tolerated.length}；stale ${stale.length}`,
    ...fresh.map((item) => `- 新债[${item.kind}] ${item.from} -> ${item.to}：${item.detail}`),
    ...tolerated.map((item) => `- 容忍[${item.kind}] ${item.from} -> ${item.to}（baseline：${baselined.get(item.fingerprint)?.reason ?? ''}）`),
    ...stale.map((item) => `- stale ${item.from} -> ${item.to}：债务已还清，请 arch baseline --write 收缩基线`),
    ...unusedDeclarations.map((item) => `- warning 声明但无实边：${item.from} -> ${item.to}`),
    ...notes.map((item) => `- note ${item}`)
  ];
  return { ok, violations, fresh, tolerated, stale, unusedDeclarations, scan, notes, report: lines.join('\n') };
}

export async function archBaselineWrite(ctx, reason) {
  const result = await archCheckRun(ctx, { scan: true });
  const existing = await readArchBaseline(ctx);
  const existingReasons = new Map(existing.entries.map((entry) => [entry.fingerprint, entry.reason]));
  const entries = [];
  const lacking = [];
  for (const violation of result.violations) {
    const preserved = existingReasons.get(violation.fingerprint);
    const finalReason = preserved ?? (reason?.trim() || null);
    if (!finalReason) {
      lacking.push(`${violation.kind}:${violation.from}->${violation.to}`);
      continue;
    }
    entries.push({ fingerprint: violation.fingerprint, kind: violation.kind, from: violation.from, to: violation.to, reason: finalReason });
  }
  if (lacking.length) {
    throw usageError(`以下 ${lacking.length} 条违规缺书面理由；请用 --reason "..." 为新增债务给出理由（每条必须带 reason 才可入 baseline）：\n${lacking.map((item) => `- ${item}`).join('\n')}`);
  }
  entries.sort((left, right) => `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`));
  const body = { version: 1, updatedAt: nowIso(), entries };
  await atomicWrite(ctx.archBaselinePath, body);
  return { written: entries.length, droppedStale: existing.entries.length - entries.filter((entry) => existingReasons.has(entry.fingerprint)).length, path: toPosix(path.relative(ctx.root, ctx.archBaselinePath)) };
}

// 漂移棘轮：--record 落快照；--gate 用当前指标对比**逐指标历史最优**（best-ever，
// dsh-base 语义）——只许比历史最好成绩更好，还债后回弹（含借新还旧的 debt-swap）即拦。
const TREND_GATED_FIELDS = ['violations', 'fresh', 'cycles'];

async function archTrendMetrics(ctx) {
  const result = await archCheckRun(ctx, { scan: true });
  return {
    ts: nowIso(),
    violations: result.violations.length,
    fresh: result.fresh.length,
    tolerated: result.tolerated.length,
    stale: result.stale.length,
    cycles: result.violations.filter((item) => item.kind === 'dependency-cycle').length,
    edges: result.scan?.edges.length ?? 0,
    scannedFiles: result.scan?.scannedFiles ?? 0
  };
}

export async function archTrend(ctx, mode) {
  const state = await readState(ctx, ARCH_TREND_FILE, { version: 1, snapshots: [] });
  if (mode === 'record') {
    const metrics = await archTrendMetrics(ctx);
    const snapshots = [...state.snapshots, metrics].slice(-200);
    await writeState(ctx, ARCH_TREND_FILE, { version: 1, snapshots });
    return { mode, recorded: metrics, total: snapshots.length };
  }
  const current = await archTrendMetrics(ctx);
  // 无快照：gate 不构成阻断，明示按基线建立处理（baseline:true），先 --record 后棘轮生效。
  if (!state.snapshots.length) {
    return {
      mode,
      ok: true,
      firstRun: true,
      baseline: null,
      current,
      regressions: [],
      report: 'arch trend --gate：无历史快照，本次通过（baseline:true——先 arch trend --record 建立基线后棘轮生效）'
    };
  }
  // 逐指标历史最小值：与"最近一次"比较会漏掉 debt-swap（还一笔旧债加一笔新债、净零放行）。
  const best = {};
  for (const field of TREND_GATED_FIELDS) {
    best[field] = Math.min(...state.snapshots.map((snapshot) => snapshot[field] ?? 0));
  }
  const regressions = [];
  for (const field of TREND_GATED_FIELDS) {
    if (current[field] > best[field]) regressions.push(`${field}: 历史最优 ${best[field]} -> 当前 ${current[field]}`);
  }
  return {
    mode,
    ok: regressions.length === 0,
    firstRun: false,
    baseline: best,
    current,
    regressions,
    report: regressions.length
      ? `架构漂移棘轮触发（超越历史最优即新债）：${regressions.join('；')}`
      : '架构漂移棘轮通过：违规指标未超越历史最优'
  };
}

// ADR 执法引用：活跃 ADR 必须有 Enforced-by: 行；引用必须是真实存在的 check/fitness 规则，
// 或显式 manual: 前缀；幽灵引用 FAIL。
export async function adrCheckRun(ctx) {
  const adrDir = path.join(ctx.root, ctx.adrDir);
  let files;
  try {
    files = (await readdir(adrDir)).filter((name) => name.endsWith('.md')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, checked: 0, inactive: true, failures: [], warnings: [], report: `adr check：${ctx.adrDir}/ 不存在，未激活（PASS）` };
    }
    throw error;
  }
  const matrix = await loadMatrix(ctx);
  const checkIds = new Set(matrix.checks.map((check) => check.id));
  const fitnessIds = new Set(FITNESS_RULES.map((rule) => rule.id));
  const builtinIds = new Set([...BUILTIN_CHECKS]);
  const failures = [];
  const warnings = [];
  let active = 0;
  for (const file of files) {
    const text = await readFile(path.join(adrDir, file), 'utf8');
    if (/^Status:\s*(superseded|deprecated|rejected|已取代|废弃|已拒绝)/im.test(text)) continue;
    active += 1;
    const lines = [...text.matchAll(/^Enforced-by:\s*(.+)$/gim)].map((match) => match[1].trim());
    if (!lines.length) {
      failures.push(`${file}：缺 Enforced-by 行——活跃 ADR 必须声明执法者（或显式 manual:）`);
      continue;
    }
    for (const line of lines) {
      for (const item of line.split(',').map((value) => value.trim()).filter(Boolean)) {
        if (item.startsWith('manual:')) continue;
        if (!checkIds.has(item) && !fitnessIds.has(item) && !builtinIds.has(item)) {
          failures.push(`${file}：Enforced-by 引用了不存在的检查/规则 "${item}"（幽灵引用）`);
        }
      }
    }
  }
  const report = [
    `adr check：活跃 ADR ${active} 条；幽灵引用/缺失 ${failures.length} 条`,
    ...failures.map((item) => `- FAIL ${item}`),
    ...warnings.map((item) => `- warning ${item}`)
  ].join('\n');
  return { ok: failures.length === 0, checked: active, failures, warnings, report };
}
