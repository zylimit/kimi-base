// lib/strength.mjs —— 强度策略引擎（REQ-051/REQ-052，ADR-0008）
//
// 模型：四内置档（explore/rapid/balanced/strict）× 12 封闭控制轴；自定义档 extends 具名档
// 逐轴只收紧（降级配置期报 STRENGTH_WEAKENING exit 1）；四类 floor（risk/operation/保护属性/
// 路径）只升不降、冲突逐轴取最高；rollout=shadow 只报告不阻断；每次解析写有界 decision log
// （policyRevision/inputDigest/reasons）；policyHash = sha256(LF 归一化 canonical JSON)。
// 复杂度纪律（ADR-0008 第 9 条）：无逐命令投影层、无日历级校验。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCatalog, moduleMatches } from './catalog.mjs';
import { HarnessError, atomicWrite, degradedError, normalizeLf, nowIso, readJsonFile, sha256, stableJson, usageError } from './core.mjs';
import { STRENGTH_CONFIG_REL, STRENGTH_DECISIONS_FILE, STRENGTH_STATE_FILE } from './paths.mjs';
import { quarantineState, stateFile } from './state.mjs';

// ---------------- 封闭轴集与档序（REQ-051；轴集封闭，未知轴配置期拒绝） ----------------

export const AXES = Object.freeze([
  'verificationBreadth', 'testStrength', 'reviewerMode', 'reviewStages', 'reviewLenses',
  'reviewRounds', 'evidenceLevel', 'deferralMode', 'completionMode', 'requireSpecTrace',
  'contextBudgetChars', 'budgetMaxFiles'
]);

// 弱→强档序；null = 数值轴（正整数，越大越强）。
export const AXIS_ORDER = Object.freeze({
  verificationBreadth: Object.freeze(['none', 'direct', 'affected', 'all']),
  testStrength: Object.freeze(['none', 'smoke', 'unit', 'full']),
  reviewerMode: Object.freeze(['none', 'self', 'independent', 'staged']),
  reviewStages: Object.freeze([0, 1, 2, 3]),
  reviewLenses: Object.freeze(['none', 'minimal', 'standard', 'full']),
  reviewRounds: Object.freeze([1, 2, 3]),
  evidenceLevel: Object.freeze(['none', 'bound', 'policy-bound', 'attested']),
  deferralMode: Object.freeze(['loan', 'disabled']),
  completionMode: Object.freeze(['forbidden', 'low-risk', 'standard', 'strict']),
  requireSpecTrace: Object.freeze([false, true]),
  contextBudgetChars: null,
  budgetMaxFiles: null
});

export const PROFILE_ORDER = Object.freeze(['explore', 'rapid', 'balanced', 'strict']);

export const BUILTIN_PROFILES = Object.freeze({
  explore: Object.freeze({
    verificationBreadth: 'none', testStrength: 'none', reviewerMode: 'none', reviewStages: 0,
    reviewLenses: 'none', reviewRounds: 1, evidenceLevel: 'none', deferralMode: 'loan',
    completionMode: 'forbidden', requireSpecTrace: false, contextBudgetChars: 20000, budgetMaxFiles: 5
  }),
  rapid: Object.freeze({
    verificationBreadth: 'direct', testStrength: 'smoke', reviewerMode: 'self', reviewStages: 1,
    reviewLenses: 'minimal', reviewRounds: 1, evidenceLevel: 'bound', deferralMode: 'loan',
    completionMode: 'low-risk', requireSpecTrace: false, contextBudgetChars: 40000, budgetMaxFiles: 20
  }),
  balanced: Object.freeze({
    verificationBreadth: 'affected', testStrength: 'unit', reviewerMode: 'independent', reviewStages: 2,
    reviewLenses: 'standard', reviewRounds: 2, evidenceLevel: 'policy-bound', deferralMode: 'loan',
    completionMode: 'standard', requireSpecTrace: true, contextBudgetChars: 60000, budgetMaxFiles: 50
  }),
  strict: Object.freeze({
    verificationBreadth: 'all', testStrength: 'full', reviewerMode: 'staged', reviewStages: 3,
    reviewLenses: 'full', reviewRounds: 3, evidenceLevel: 'attested', deferralMode: 'disabled',
    completionMode: 'strict', requireSpecTrace: true, contextBudgetChars: 100000, budgetMaxFiles: 200
  })
});

// 内建默认 floor 映射（ADR-0008 第 4 条）：只升不降，冲突取最高档。
export const RISK_FLOOR = Object.freeze({ low: 'rapid', medium: 'balanced', high: 'strict', critical: 'strict' });
export const OPERATION_FLOOR = Object.freeze({ develop: 'rapid', complete: 'balanced', package: 'strict', release: 'strict', deploy: 'strict' });
const PROTECTED_ATTRIBUTES = Object.freeze(['security', 'safety', 'privacy']);
const PROTECTED_TIERS = new Set(['high', 'critical']);
const TRUST_BOUNDARY_SEGMENTS = new Set(['auth', 'security', 'secrets']);

const ROLLOUT_MODES = Object.freeze(['enforce', 'shadow']);
const DECISION_LOG_MAX = 200;

// 轴值强度秩：枚举轴按档序下标，数值轴按数值。
export function axisRank(axis, value) {
  const order = AXIS_ORDER[axis];
  if (order === undefined) throw new HarnessError(`未知控制轴：${axis}（轴集封闭，合法轴：${AXES.join(' ')}）`, 'STRENGTH_UNKNOWN_AXIS');
  if (order === null) return value;
  return order.indexOf(value);
}

function validateAxisValue(axis, value, label) {
  const order = AXIS_ORDER[axis];
  if (order === undefined) {
    throw new HarnessError(`${label} 含未知控制轴：${axis}（轴集封闭，合法轴：${AXES.join(' ')}）`, 'STRENGTH_UNKNOWN_AXIS');
  }
  if (order === null) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HarnessError(`${label}：轴 ${axis} 的值必须是正整数，实得 ${JSON.stringify(value)}`, 'STRENGTH_INVALID_AXIS_VALUE');
    }
    return;
  }
  if (!order.some((item) => item === value)) {
    throw new HarnessError(
      `${label}：轴 ${axis} 的值 ${JSON.stringify(value)} 非法（档序：${order.map((item) => JSON.stringify(item)).join(' < ')}）`,
      'STRENGTH_INVALID_AXIS_VALUE'
    );
  }
}

// ---------------- 配置严格校验（类比 harness.json 风格：未知字段/非法取值配置期爆炸） ----------------

export function validateStrengthConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new HarnessError('strength.json 必须是对象', 'CONFIG_INVALID');
  }
  for (const key of Object.keys(config)) {
    if (!['version', 'profile', 'rollout', 'customProfiles', '_comment'].includes(key)) {
      throw new HarnessError(`strength.json 含未知字段：${key}`, 'CONFIG_UNKNOWN_FIELD');
    }
  }
  if (config.version !== 1) throw new HarnessError('strength.json 的 version 必须等于 1', 'CONFIG_INVALID');
  if (config.profile !== undefined && typeof config.profile !== 'string') {
    throw new HarnessError('strength.json 的 profile 必须是字符串（档名）', 'CONFIG_INVALID');
  }
  if (config.rollout !== undefined && !ROLLOUT_MODES.includes(config.rollout)) {
    throw new HarnessError(`strength.json 的 rollout 非法：${JSON.stringify(config.rollout)}（合法：${ROLLOUT_MODES.join('/')}）`, 'CONFIG_INVALID');
  }
  if (config.customProfiles !== undefined) {
    if (!config.customProfiles || typeof config.customProfiles !== 'object' || Array.isArray(config.customProfiles)) {
      throw new HarnessError('strength.json 的 customProfiles 必须是对象', 'CONFIG_INVALID');
    }
    for (const [name, profile] of Object.entries(config.customProfiles)) {
      const label = `customProfiles.${name}`;
      // 与内置档同名 = 遮蔽：静默回落内置档会让"收紧"假象成立（P3 评审 D3）——配置期拒绝。
      if (PROFILE_ORDER.includes(name)) {
        throw new HarnessError(`${label} 与内置档同名（遮蔽内置档属配置错误：改名或删除该自定义档）`, 'CONFIG_INVALID');
      }
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new HarnessError(`${label} 必须是对象`, 'CONFIG_INVALID');
      for (const key of Object.keys(profile)) {
        if (!['extends', 'axes', '_comment'].includes(key)) throw new HarnessError(`${label} 含未知字段：${key}`, 'CONFIG_UNKNOWN_FIELD');
      }
      if (typeof profile.extends !== 'string' || !profile.extends) throw new HarnessError(`${label}.extends 必填（具名档）`, 'CONFIG_INVALID');
      if (profile.axes !== undefined) {
        if (!profile.axes || typeof profile.axes !== 'object' || Array.isArray(profile.axes)) {
          throw new HarnessError(`${label}.axes 必须是对象`, 'CONFIG_INVALID');
        }
        for (const [axis, value] of Object.entries(profile.axes)) validateAxisValue(axis, value, `${label}.axes`);
      }
    }
  }
  return config;
}

// extends 解析：递归展开继承链（内置档为根），逐轴只收紧——任何降级配置期报
// STRENGTH_WEAKENING exit 1。返回 { [档名]: { axes, overridden:Set } }（overridden =
// 被某级自定义档显式收紧的轴，explain 来源标注 extends 的依据）。
export function resolveProfiles(config) {
  const customs = config.customProfiles ?? {};
  const known = (name) => PROFILE_ORDER.includes(name) || Object.hasOwn(customs, name);
  const resolved = {};
  for (const name of PROFILE_ORDER) resolved[name] = { axes: { ...BUILTIN_PROFILES[name] }, overridden: new Set() };
  const visiting = new Set();
  const resolveCustom = (name) => {
    if (resolved[name]) return resolved[name];
    if (visiting.has(name)) throw new HarnessError(`customProfiles.${name} 的 extends 链成环`, 'CONFIG_INVALID');
    visiting.add(name);
    const profile = customs[name];
    if (!known(profile.extends)) {
      throw new HarnessError(`customProfiles.${name}.extends 指向未知档：${profile.extends}（合法：${[...PROFILE_ORDER, ...Object.keys(customs)].join(' ')}）`, 'CONFIG_INVALID');
    }
    const base = PROFILE_ORDER.includes(profile.extends) ? resolved[profile.extends] : resolveCustom(profile.extends);
    const axes = { ...base.axes };
    const overridden = new Set(base.overridden);
    for (const [axis, value] of Object.entries(profile.axes ?? {})) {
      if (axisRank(axis, value) < axisRank(axis, base.axes[axis])) {
        throw new HarnessError(
          `STRENGTH_WEAKENING：customProfiles.${name}.axes.${axis} = ${JSON.stringify(value)} 低于基线 ${profile.extends} 的 ${JSON.stringify(base.axes[axis])}（extends 只收紧，降级配置期拒绝）`,
          'STRENGTH_WEAKENING'
        );
      }
      axes[axis] = value;
      overridden.add(axis);
    }
    visiting.delete(name);
    resolved[name] = { axes, overridden };
    return resolved[name];
  };
  for (const name of Object.keys(customs)) resolveCustom(name);
  return resolved;
}

// ---------------- floor：只升不降，逐轴取最高，逐轴标来源 ----------------

// 纯函数：把一个 floor 档并入当前生效轴；返回 { axes, sources, raised }。
export function mergeFloor(axes, sources, kind, floorProfileName) {
  const floorAxes = BUILTIN_PROFILES[floorProfileName];
  const next = { ...axes };
  const nextSources = { ...sources };
  const raised = [];
  for (const axis of AXES) {
    if (axisRank(axis, floorAxes[axis]) > axisRank(axis, next[axis])) {
      next[axis] = floorAxes[axis];
      nextSources[axis] = `floor:${kind}`;
      raised.push(axis);
    }
  }
  return { axes: next, sources: nextSources, raised };
}

// 路径 floor：治理面 .kimi-base/** 与信任边界（auth/security/secrets 路径段）→ strict。
function pathFloorProfile(paths) {
  for (const item of paths) {
    const normalized = String(item).replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized === '.kimi-base' || normalized.startsWith('.kimi-base/')) return 'strict';
    if (normalized.split('/').some((segment) => TRUST_BOUNDARY_SEGMENTS.has(segment.toLowerCase()))) return 'strict';
  }
  return null;
}

// 属性 floor：受影响模块（--paths 命中模块）声明 security/safety/privacy @ high+ → strict。
// 语义单源走 loadCatalog 归一化 + moduleMatches（P3 评审 D1/D2）：裸读 JSON 会把合法对象形
// 声明 {tier, reason} String 成 "[object Object]"（永不命中），裸 matchesGlob 会拿 codex 系
// 模块的 root 内 glob 去匹配仓根相对路径（永不命中）。
// 注意：导出供 selftest 锁定"形状非法响亮报错"分支（P3 R2 评审发现）。
export async function attributeFloorProfile(ctx, paths) {
  if (!paths.length) return null;
  const raw = await readJsonFile(ctx.catalogPath, { required: false });
  if (!raw) return null;
  // catalog 存在但形状非法：响亮报错而非静默跳过属性 floor（保护属性 floor 失效若无声，
  // 等于在"永不豁免"面上开了个假绿后门；与 catalog lint 同语义）。
  if (!Array.isArray(raw.modules)) {
    throw new HarnessError('catalog 存在但 modules 非数组（catalog lint 同款校验）；属性 floor 拒绝静默跳过', 'CATALOG_INVALID');
  }
  // catalog 存在即走正规校验（root/repoRooted 归一化、属性声明解析为 {tier, reason}）；
  // catalog 非法时 CATALOG_INVALID 响亮报错，不静默跳过属性 floor。
  const catalog = await loadCatalog(ctx);
  for (const module of catalog.modules) {
    const attributes = module.attributes ?? {};
    if (!PROTECTED_ATTRIBUTES.some((attribute) => PROTECTED_TIERS.has(String(attributes[attribute]?.tier ?? '').toLowerCase()))) continue;
    if (paths.some((item) => moduleMatches(module, String(item)))) return 'strict';
  }
  return null;
}

// ---------------- 配置/状态加载 ----------------

// 无 strength.json = 治理未开启：返回 null（调用方决定 list 放行 / status·set·explain exit 3 /
// task complete 跳过）。配置存在但非法 = exit 1 配置错误。
export async function loadStrengthConfig(ctx) {
  const config = await readJsonFile(path.join(ctx.root, STRENGTH_CONFIG_REL), { required: false });
  return config ? validateStrengthConfig(config) : null;
}

async function readStrengthState(ctx) {
  let state;
  try {
    state = await readJsonFile(stateFile(ctx, STRENGTH_STATE_FILE), { required: false });
  } catch (error) {
    // REQ-061：运行态 JSON 损坏走 quarantine 原语（隔离保证据+事件记账）；
    // 强度态决定门禁档位，损坏必须当场响亮报错（fail-closed），不得静默按默认档继续。
    if (error.code !== 'JSON_PARSE_FAILED') throw error;
    await quarantineState(ctx, stateFile(ctx, STRENGTH_STATE_FILE), error);
    throw error;
  }
  if (state === null) return null;
  if (!state || typeof state.profile !== 'string') {
    throw new HarnessError(`${STRENGTH_STATE_FILE} 形状非法（需要 {profile}）`, 'CONFIG_INVALID');
  }
  return state;
}

function floorInputs({ risk, operation } = {}) {
  if (risk !== undefined && !Object.hasOwn(RISK_FLOOR, risk)) {
    throw usageError(`strength 的 --risk 非法：${risk}（合法：${Object.keys(RISK_FLOOR).join('/')}）`);
  }
  if (operation !== undefined && !Object.hasOwn(OPERATION_FLOOR, operation)) {
    throw usageError(`strength 的 --operation 非法：${operation}（合法：${Object.keys(OPERATION_FLOOR).join('/')}）`);
  }
  return { risk, operation };
}

// 当前档解析 + floor 合并。inputs: { risk?, operation?, paths? }（explain 的 floor 演示入参）。
export async function resolveStrength(ctx, inputs = {}) {
  const config = await loadStrengthConfig(ctx);
  if (!config) {
    throw degradedError(
      `强度治理未开启：缺 ${STRENGTH_CONFIG_REL}（内置四档客观存在，见 strength list；接入：复制种子 .kimi-base/templates/strength.example.json → ${STRENGTH_CONFIG_REL}）`,
      'STRENGTH_NOT_ENABLED'
    );
  }
  const profiles = resolveProfiles(config);
  const state = await readStrengthState(ctx);
  const active = state?.profile ?? config.profile ?? 'balanced';
  if (!profiles[active]) {
    const legal = Object.keys(profiles).join(' ');
    throw new HarnessError(`当前生效档未知：${active}（来源：${state ? 'state 覆盖' : 'strength.json profile'}；合法：${legal}）`, 'CONFIG_INVALID');
  }
  const rollout = config.rollout ?? 'enforce';
  const { risk, operation } = floorInputs(inputs);
  const paths = (inputs.paths ?? []).map(String);

  const axes = { ...profiles[active].axes };
  const sources = {};
  for (const axis of AXES) sources[axis] = profiles[active].overridden.has(axis) ? 'extends' : 'builtin';
  const reasons = [];
  // 固定顺序 risk → operation → attribute → path；逐轴取最高（内置档逐轴单调，故等价于取最高 floor 档）。
  const floors = [];
  if (risk !== undefined) floors.push({ kind: 'risk', profile: RISK_FLOOR[risk], label: `--risk ${risk}` });
  if (operation !== undefined) floors.push({ kind: 'operation', profile: OPERATION_FLOOR[operation], label: `--operation ${operation}` });
  const attributeFloor = await attributeFloorProfile(ctx, paths);
  if (attributeFloor) floors.push({ kind: 'attribute', profile: attributeFloor, label: '受影响模块声明保护属性 high+' });
  const pathFloor = pathFloorProfile(paths);
  if (pathFloor) floors.push({ kind: 'path', profile: pathFloor, label: '路径命中治理面/信任边界' });
  let current = { axes, sources };
  for (const floor of floors) {
    const merged = mergeFloor(current.axes, current.sources, floor.kind, floor.profile);
    if (merged.raised.length) reasons.push(`floor:${floor.kind}（${floor.label}）→ ${floor.profile} 档下限，抬升 ${merged.raised.length} 轴`);
    current = { axes: merged.axes, sources: merged.sources };
  }

  // policyHash = sha256(LF 归一化 canonical JSON)：同配置同选择稳定，改任一轴值即变。
  const policyHash = sha256(normalizeLf(stableJson({
    version: 1,
    rollout,
    active,
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, entry]) => [name, entry.axes]))
  })));
  const inputDigest = sha256(stableJson({ profile: active, risk: risk ?? null, operation: operation ?? null, paths }));
  return {
    active,
    profileSource: state ? 'state 覆盖（strength set）' : 'strength.json profile',
    rollout,
    shadow: rollout === 'shadow',
    axes: current.axes,
    sources: current.sources,
    reasons,
    policyHash,
    policyRevision: policyHash,
    inputDigest,
    profiles
  };
}

// ---------------- decision log（有界 ≤200 条，原子重写） ----------------

// 已知限制（P3 评审 info 项）：保序截断必须读-改-写全量重写，两个进程并发解析会互相覆盖
// 丢条目。当前调用点（strength status/explain、task complete 完成门）均为单进程串行短操作，
// 且决策日志是留痕 best-effort——若未来引入并发写入方，需改追加写 + 定期压实。
export async function recordDecision(ctx, resolved) {
  const file = stateFile(ctx, STRENGTH_DECISIONS_FILE);
  let lines = [];
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  lines.push(JSON.stringify({
    ts: nowIso(),
    policyRevision: resolved.policyRevision,
    inputDigest: resolved.inputDigest,
    profile: resolved.active,
    rollout: resolved.rollout,
    reasons: resolved.reasons
  }));
  if (lines.length > DECISION_LOG_MAX) lines = lines.slice(-DECISION_LOG_MAX);
  await atomicWrite(file, `${lines.join('\n')}\n`);
  return file;
}

// ---------------- strength set / task complete 集成 ----------------

export async function setStrengthProfile(ctx, name) {
  const config = await loadStrengthConfig(ctx);
  if (!config) {
    throw degradedError(`强度治理未开启：缺 ${STRENGTH_CONFIG_REL}，无法 set（接入：复制种子 .kimi-base/templates/strength.example.json）`, 'STRENGTH_NOT_ENABLED');
  }
  const profiles = resolveProfiles(config);
  if (!profiles[name]) {
    throw usageError(`未知强度档：${name}；合法档：${Object.keys(profiles).join(' ')}`);
  }
  await atomicWrite(stateFile(ctx, STRENGTH_STATE_FILE), { version: 1, profile: name, updatedAt: nowIso() });
  return { profile: name };
}

// task complete 完成门集成（REQ-051）：生效档 completionMode=forbidden 且 rollout=enforce → 阻断。
// 返回 null = 治理未开启（跳过）；shadow = 只报告不阻断（绝不输出 completionMode 字样）。
export async function strengthCompletionCheck(ctx) {
  const config = await loadStrengthConfig(ctx);
  if (!config) return null;
  const resolved = await resolveStrength(ctx, {});
  await recordDecision(ctx, resolved);
  return {
    blocked: !resolved.shadow && resolved.axes.completionMode === 'forbidden',
    shadow: resolved.shadow,
    profile: resolved.active
  };
}
