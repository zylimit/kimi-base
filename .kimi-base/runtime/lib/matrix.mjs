// lib/matrix.mjs —— 验证矩阵（verification-matrix.json）

import { ATTRIBUTE_NAMES, PROTECTED_ATTRIBUTES } from './catalog.mjs';
import { HarnessError, assertKnownFields, assertPlainObject, assertStringArray, readJsonFile, relativeSafe, usageError } from './core.mjs';

export const CHECK_KINDS = ['static', 'unit', 'integration', 'build', 'security', 'smoke'];
const PROTECTED_KINDS = new Set(['security', 'safety']);
export const RISKS = ['low', 'medium', 'high'];
export const BUILTIN_CHECKS = new Set(['fitness', 'arch-check', 'adr-check', 'catalog-lint']);

export function isProtectedCheck(check) {
  return PROTECTED_KINDS.has(check.kind) || (check.attributes ?? []).some((item) => PROTECTED_ATTRIBUTES.has(item));
}

export function validateMatrix(matrix, riskChecks = null) {
  assertPlainObject(matrix, 'verification-matrix');
  assertKnownFields(matrix, new Set(['version', 'riskKinds', 'checks']), 'verification-matrix');
  if (matrix.version !== 1) throw new HarnessError('verification-matrix 的 version 必须等于 1', 'MATRIX_INVALID');
  // 风险→检查的映射有两个合法来源：matrix.riskKinds（kind 维度）或
  // harness.json quality.riskChecks（检查 id 维度）；至少其一。
  if (matrix.riskKinds === undefined && !riskChecks) {
    throw new HarnessError('verification-matrix 缺 riskKinds，且 harness.json 无 quality.riskChecks；无法推导风险层检查集', 'MATRIX_INVALID');
  }
  if (matrix.riskKinds !== undefined) {
    assertPlainObject(matrix.riskKinds, 'riskKinds');
    assertKnownFields(matrix.riskKinds, new Set(RISKS), 'riskKinds');
    for (const risk of RISKS) {
      const kinds = matrix.riskKinds[risk];
      if (!Array.isArray(kinds)) throw new HarnessError(`riskKinds.${risk} 必须是数组`, 'MATRIX_INVALID');
      for (const kind of kinds) if (!CHECK_KINDS.includes(kind)) throw new HarnessError(`riskKinds.${risk} 含未知 kind：${kind}`, 'MATRIX_INVALID');
      matrix.riskKinds[risk] = [...new Set(kinds)];
    }
    // 累积并集：更高风险必须包含更低风险的全部 kind。
    for (const kind of matrix.riskKinds.low) {
      if (!matrix.riskKinds.medium.includes(kind)) throw new HarnessError(`riskKinds.medium 必须包含 low 的 ${kind}（风险累积并集）`, 'MATRIX_INVALID');
    }
    for (const kind of matrix.riskKinds.medium) {
      if (!matrix.riskKinds.high.includes(kind)) throw new HarnessError(`riskKinds.high 必须包含 medium 的 ${kind}（风险累积并集）`, 'MATRIX_INVALID');
    }
    if (!matrix.riskKinds.high.includes('security')) throw new HarnessError('riskKinds.high 必须包含 security', 'MATRIX_INVALID');
  }
  if (!Array.isArray(matrix.checks)) throw new HarnessError('checks 必须是数组', 'MATRIX_INVALID');
  const ids = new Set();
  for (const check of matrix.checks) {
    assertPlainObject(check, `check ${check?.id ?? '?'}`);
    assertKnownFields(check, new Set([
      'id', 'kind', 'class', 'command', 'executable', 'args', 'builtin', 'cwd', 'platform',
      'timeoutMs', 'timeoutSec', 'dependsOn', 'resourceLocks', 'required', 'allowFastSkip',
      'attributes', 'runtimeValidityHours', 'note'
    ]), `check ${check.id ?? '?'}`);
    if (typeof check.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(check.id)) throw new HarnessError(`非法检查 id：${check.id}`, 'MATRIX_INVALID');
    if (ids.has(check.id)) throw new HarnessError(`检查 id 重复：${check.id}`, 'MATRIX_INVALID');
    ids.add(check.id);
    if (!CHECK_KINDS.includes(check.kind)) throw new HarnessError(`检查 ${check.id} 的 kind 非法：${check.kind}`, 'MATRIX_INVALID');
    // command 允许为空字符串：运行时按 BLOCKED 报（缺命令 = BLOCKED，绝不假绿）。
    const hasCommand = typeof check.command === 'string' && check.command.trim();
    const hasExecutable = typeof check.executable === 'string' && check.executable.trim();
    const hasBuiltin = typeof check.builtin === 'string' && check.builtin;
    if ([Boolean(hasCommand), Boolean(hasExecutable), Boolean(hasBuiltin)].filter(Boolean).length > 1) {
      throw new HarnessError(`检查 ${check.id} 的 command/executable/builtin 互斥`, 'MATRIX_INVALID');
    }
    if (check.command !== undefined && typeof check.command !== 'string') throw new HarnessError(`${check.id}.command 必须是字符串`, 'MATRIX_INVALID');
    if (hasBuiltin && !BUILTIN_CHECKS.has(check.builtin)) throw new HarnessError(`检查 ${check.id} 的 builtin 未知：${check.builtin}`, 'MATRIX_INVALID');
    if (check.args !== undefined) assertStringArray(check.args, `${check.id}.args`);
    if (check.cwd !== undefined) relativeSafe(check.cwd, `${check.id}.cwd`);
    if (check.timeoutSec !== undefined) {
      if (!Number.isInteger(check.timeoutSec) || check.timeoutSec < 1 || check.timeoutSec > 3600) {
        throw new HarnessError(`${check.id}.timeoutSec 必须是 1..3600 的整数`, 'MATRIX_INVALID');
      }
      check.timeoutMs = check.timeoutSec * 1000;
      delete check.timeoutSec;
    }
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 3600000)) {
      throw new HarnessError(`${check.id}.timeoutMs 必须是 100..3600000 的整数`, 'MATRIX_INVALID');
    }
    if (check.note !== undefined && typeof check.note !== 'string') throw new HarnessError(`${check.id}.note 必须是字符串`, 'MATRIX_INVALID');
    if (check.platform !== undefined) {
      assertStringArray(check.platform, `${check.id}.platform`, { allowEmpty: false });
      if (check.platform.some((item) => !['win32', 'linux', 'darwin'].includes(item))) throw new HarnessError(`${check.id}.platform 非法`, 'MATRIX_INVALID');
    }
    for (const field of ['dependsOn', 'resourceLocks']) {
      if (check[field] !== undefined) assertStringArray(check[field], `${check.id}.${field}`, { allowEmpty: false });
    }
    if (check.required !== undefined && typeof check.required !== 'boolean') throw new HarnessError(`${check.id}.required 必须是布尔`, 'MATRIX_INVALID');
    if (check.allowFastSkip !== undefined && typeof check.allowFastSkip !== 'boolean') throw new HarnessError(`${check.id}.allowFastSkip 必须是布尔`, 'MATRIX_INVALID');
    if (check.attributes !== undefined) {
      assertStringArray(check.attributes, `${check.id}.attributes`, { allowEmpty: false });
      for (const attribute of check.attributes) {
        if (!ATTRIBUTE_NAMES.has(attribute)) throw new HarnessError(`${check.id}.attributes 含未知属性：${attribute}`, 'MATRIX_INVALID');
      }
      check.attributes = [...new Set(check.attributes)];
    }
    if (check.runtimeValidityHours !== undefined && (!Number.isInteger(check.runtimeValidityHours) || check.runtimeValidityHours <= 0)) {
      throw new HarnessError(`${check.id}.runtimeValidityHours 必须是正整数`, 'MATRIX_INVALID');
    }
    // class: "runtime" = 运行类证据（压测/拨测测的是部署中的系统）：
    // 回执带 validUntil（createdAt + runtimeValidityHours ?? quality.runtimeValidityHours），
    // 时间窗内不随树指纹过期；窗口过期即不 fresh。省略 class = 默认指纹绑定行为不变。
    if (check.class !== undefined && check.class !== 'runtime') {
      throw new HarnessError(`${check.id}.class 只能是 "runtime"（省略则为默认的树指纹绑定证据）`, 'MATRIX_INVALID');
    }
    if (check.runtimeValidityHours !== undefined && check.class !== 'runtime') {
      throw new HarnessError(`${check.id}.runtimeValidityHours 只对 class:"runtime" 的检查有意义`, 'MATRIX_INVALID');
    }
  }
  for (const check of matrix.checks) {
    for (const dependency of check.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new HarnessError(`检查 ${check.id} 依赖未知检查：${dependency}`, 'MATRIX_UNKNOWN_CHECK');
    }
  }
  // 保护约束：protected 检查声明 allowFastSkip 在配置期就拒绝（语法层面不可表示）。
  // 双通道判定（isProtectedCheck）：kind/class 与 attributes 任一命中 protected 即拒绝——
  // 只看 kind 会让"认领 privacy 属性的 static 检查"漏网（dsh 已知盲区，P6 修掉）。
  for (const check of matrix.checks) {
    if (check.allowFastSkip && isProtectedCheck({ kind: check.kind, attributes: check.attributes ?? [] })) {
      throw new HarnessError(`检查 ${check.id} 属 protected（security/safety/privacy，kind 或认领属性命中），不允许 allowFastSkip`, 'MATRIX_INVALID');
    }
  }
  // riskChecks（id 维度）校验：引用必须真实、累积并集、high 必含 security kind 检查。
  if (riskChecks) {
    const seen = { low: [], medium: [], high: [] };
    for (const risk of RISKS) {
      const list = riskChecks[risk] ?? [];
      for (const id of list) if (!ids.has(id)) throw new HarnessError(`quality.riskChecks.${risk} 引用未知检查：${id}`, 'MATRIX_UNKNOWN_CHECK');
      seen[risk] = [...new Set(list)];
    }
    for (const id of seen.low) if (!seen.medium.includes(id)) throw new HarnessError(`riskChecks.medium 必须包含 low 的 ${id}（风险累积并集）`, 'MATRIX_INVALID');
    for (const id of seen.medium) if (!seen.high.includes(id)) throw new HarnessError(`riskChecks.high 必须包含 medium 的 ${id}（风险累积并集）`, 'MATRIX_INVALID');
    const byId = new Map(matrix.checks.map((check) => [check.id, check]));
    if (!seen.high.some((id) => byId.get(id)?.kind === 'security')) {
      throw new HarnessError('quality.riskChecks.high 必须包含至少一个 security kind 检查', 'MATRIX_INVALID');
    }
  }
  return matrix;
}

export async function loadMatrix(ctx) {
  return validateMatrix(await readJsonFile(ctx.matrixPath), ctx.riskChecks);
}

// 拓扑排序（dependsOn），环即配置错误。
export function topoOrderChecks(checks) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const temporary = new Set();
  const permanent = new Set();
  const result = [];
  function visit(id) {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new HarnessError(`检查依赖环：${id}`, 'MATRIX_CYCLE');
    temporary.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    if (byId.has(id)) result.push(byId.get(id));
  }
  for (const id of byId.keys()) visit(id);
  return result;
}

// 风险 R 的有效 kind 集 = low..R 的并集（风险累积）。
export function kindsForRisk(matrix, risk) {
  const cutoff = RISKS.indexOf(risk);
  if (cutoff === -1) throw usageError(`非法风险层：${risk}（可选 ${RISKS.join('/')}）`);
  const kinds = [];
  for (let index = 0; index <= cutoff; index += 1) {
    for (const kind of matrix.riskKinds[RISKS[index]]) if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

// 统一的"风险层 → 检查计划"推导：
// - matrix.riskKinds（kind 维度）：kind 并集选出检查；被选 kind 零检查 = missingKinds（BLOCKED）。
// - harness.json quality.riskChecks（id 维度）：id 并集直选检查；id 本身就位，无 missingKinds。
export function requiredPlan(ctx, matrix, risk, onlyKind = null) {
  if (!RISKS.includes(risk)) throw usageError(`非法风险层：${risk}（可选 ${RISKS.join('/')}）`);
  if (onlyKind && !CHECK_KINDS.includes(onlyKind)) throw usageError(`--kind 只能是 ${CHECK_KINDS.join('/')}`);
  if (matrix.riskKinds) {
    const kinds = onlyKind ? [onlyKind] : kindsForRisk(matrix, risk);
    const checks = matrix.checks.filter((check) => kinds.includes(check.kind));
    const missingKinds = kinds.filter((kind) => !checks.some((check) => check.kind === kind));
    return { checks, missingKinds, kinds, source: 'riskKinds' };
  }
  const cutoff = RISKS.indexOf(risk);
  const ids = [];
  for (let index = 0; index <= cutoff; index += 1) {
    for (const id of ctx.riskChecks[RISKS[index]] ?? []) if (!ids.includes(id)) ids.push(id);
  }
  let checks = matrix.checks.filter((check) => ids.includes(check.id));
  if (onlyKind) checks = checks.filter((check) => check.kind === onlyKind);
  return { checks, missingKinds: [], kinds: [...new Set(checks.map((check) => check.kind))], source: 'riskChecks' };
}
