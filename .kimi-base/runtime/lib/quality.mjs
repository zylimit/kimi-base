// lib/quality.mjs —— 五性覆盖判定与质量豁免（quality status / waiver）
// 三铁则：反证压过佐证；声明未接线 = 可见缺口；protected（security/safety/privacy）永不豁免。

import { randomBytes } from 'node:crypto';
import { GOVERNED_TIERS, PROTECTED_ATTRIBUTES, TIER_RANK, analyzeImpact, loadCatalog } from './catalog.mjs';
import { HarnessError, blockedError, contentHashOf, nowIso, usageError } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { NON_GIT_FINGERPRINT, gitFingerprint, requireGit } from './git.mjs';
import { latestReceipts, readLedgerEntries, verifyLedgerChain } from './ledger.mjs';
import { isProtectedCheck, loadMatrix, requiredPlan } from './matrix.mjs';
import { WAIVERS_FILE } from './paths.mjs';
import { readState, updateState } from './state.mjs';
import { getActiveTask } from './tasks.mjs';

async function readWaivers(ctx) {
  const state = await readState(ctx, WAIVERS_FILE, { version: 1, waivers: [] });
  if (state.version !== 1 || !Array.isArray(state.waivers)) throw new HarnessError('waivers 状态非法', 'STATE_CORRUPT');
  return state.waivers;
}

function waiverValid(waiver, fingerprint, now = Date.now()) {
  if (!waiver || waiver.contentHash !== contentHashOf(waiver)) return { active: false, why: '内容哈希不匹配' };
  if (waiver.fingerprint !== fingerprint) return { active: false, why: 'fingerprint 已漂移（跨指纹自动失效）' };
  if (Date.parse(waiver.expiresAt) <= now) return { active: false, why: '已过期' };
  return { active: true, why: '有效' };
}

// 保护词表（P6 起含 privacy/pii/隐私/个人信）：作用于目标检查的 id/kind/attributes，
// 也作用于 waiver 自身的 reason/compensation 文本——在理由里谈论隐私的豁免同样拒绝。
const WAIVER_FORBIDDEN_PATTERN = /security|safety|privacy|pii|secret|credential|destructive|隐私|个人信/i;

export async function waiverCreate(ctx, input) {
  const matrix = await loadMatrix(ctx);
  const check = matrix.checks.find((item) => item.id === input.checkId);
  if (!check) throw usageError(`未知检查：${input.checkId}（不在 verification-matrix.json 中）`);
  // 禁词命中即拒绝（创建期写死；运行期 waiverValid 之外还有 protected 判断兜底）。
  const haystack = `${check.id} ${check.kind} ${(check.attributes ?? []).join(' ')} ${input.reason ?? ''} ${input.compensation ?? ''}`;
  if (WAIVER_FORBIDDEN_PATTERN.test(haystack) || isProtectedCheck(check)) {
    throw blockedError(`检查 ${check.id} 命中保护词（security/safety/privacy/pii/secret/credential/destructive/隐私/个人信），永不可豁免`, 'WAIVER_FORBIDDEN');
  }
  for (const [field, label] of [['approver', '--approver'], ['reason', '--reason'], ['expires', '--expires'], ['compensation', '--compensation']]) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw usageError(`waiver create 需要 ${label}`);
  }
  const expires = Date.parse(input.expires);
  if (!Number.isFinite(expires)) throw usageError('--expires 必须是 ISO 时间（如 2026-09-01T00:00:00Z）');
  if (expires <= Date.now()) throw usageError('--expires 必须是未来时间');
  await requireGit(ctx, 'waiver create');
  const fingerprint = await gitFingerprint(ctx);
  // 已执行的 FAIL 永不可豁免：只可豁免 BLOCKED/SKIPPED。
  const latest = (await latestReceipts(ctx)).get(check.id);
  if (latest && latest.fingerprint === fingerprint.fingerprint && latest.status === 'FAIL') {
    throw blockedError(`检查 ${check.id} 存在当前指纹下的已执行 FAIL 回执：跑挂了必须修，不能请假`, 'WAIVER_FAIL_UNWAIVABLE');
  }
  const waiver = {
    version: 1,
    kind: 'waiver',
    id: `waiver-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`,
    checkId: check.id,
    fingerprint: fingerprint.fingerprint,
    approver: input.approver.trim(),
    reason: input.reason.trim(),
    expiresAt: new Date(expires).toISOString(),
    compensation: input.compensation.trim(),
    createdAt: nowIso()
  };
  const complete = { ...waiver, contentHash: contentHashOf(waiver) };
  await updateState(ctx, WAIVERS_FILE, { version: 1, waivers: [] }, (state) => ({ ...state, waivers: [...state.waivers, complete] }));
  return complete;
}

export async function waiverList(ctx) {
  const fingerprint = await gitFingerprint(ctx).catch(() => ({ fingerprint: NON_GIT_FINGERPRINT }));
  const waivers = await readWaivers(ctx);
  return waivers.map((waiver) => ({ ...waiver, validity: waiverValid(waiver, fingerprint.fingerprint) }));
}

// 当前指纹下某检查的最新回执状态。
// runtime 类证据（回执带 validUntil/time-window-<N>h）测的是部署中的系统而非这棵树：
// 时间窗内有效、不随树指纹移动；窗口过期即不 fresh（与指纹无关）。fresh FAIL 仍是反证。
function latestFreshStatus(receiptsMap, checkId, fingerprint, now = Date.now()) {
  const receipt = receiptsMap.get(checkId);
  if (!receipt) return { state: 'missing', receipt: null };
  if (receipt.contentHash !== contentHashOf(receipt)) return { state: 'invalid', receipt };
  if (typeof receipt.validUntil === 'string' && receipt.validUntil) {
    if (Date.parse(receipt.validUntil) > now) {
      return { state: receipt.status, receipt, timeWindow: receipt.timeWindow ?? null };
    }
    return { state: 'missing', receipt, windowExpired: true };
  }
  if (receipt.fingerprint !== fingerprint) return { state: 'missing', receipt };
  return { state: receipt.status, receipt };
}

export async function attributeCoverage(ctx, options = {}) {
  const now = options.now ?? Date.now();
  await requireGit(ctx, 'quality status');
  // catalog/matrix 缺失时诚实降级而非报错：无声明即无受治理属性（可见 note）。
  const catalog = await loadCatalog(ctx).catch((error) => {
    if (error.code === 'JSON_READ_FAILED') return null;
    throw error;
  });
  const matrix = await loadMatrix(ctx).catch((error) => {
    if (error.code === 'JSON_READ_FAILED') return null;
    throw error;
  });
  const fingerprint = await gitFingerprint(ctx);
  const task = await getActiveTask(ctx);
  const degradeNotes = [];
  if (!catalog) degradeNotes.push('module-catalog.json 缺失：五性判定未激活（无声明面）');
  if (!matrix) degradeNotes.push('verification-matrix.json 缺失：无认领面，受治理属性一律 uncovered');
  let scopeModules;
  let scopeNote;
  if (!catalog) {
    scopeModules = [];
    scopeNote = '无 catalog';
  } else if (task) {
    const impact = await analyzeImpact(ctx, {});
    scopeModules = catalog.modules.filter((module) => impact.affectedModules.includes(module.id));
    scopeNote = `active 任务 ${task.id} 的影响面`;
  } else {
    scopeModules = catalog.modules;
    scopeNote = '无 active 任务：全量模块';
  }
  const governed = new Map();
  for (const module of scopeModules) {
    for (const [attribute, declaration] of Object.entries(module.attributes ?? {})) {
      if (!GOVERNED_TIERS.has(declaration.tier)) continue;
      const current = governed.get(attribute) ?? { tier: declaration.tier, modules: [] };
      if (TIER_RANK[declaration.tier] > TIER_RANK[current.tier]) current.tier = declaration.tier;
      current.modules.push(module.id);
      governed.set(attribute, current);
    }
  }
  const fast = await fastModeStatus(ctx, now);
  const receiptsMap = await latestReceipts(ctx);
  const waivers = await readWaivers(ctx);
  const ledger = await readLedgerEntries(ctx);
  const chain = verifyLedgerChain(ledger.entries, { archives: ledger.archives });
  const results = [];
  const deferred = [];
  for (const [attribute, info] of [...governed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (fast.active && !PROTECTED_ATTRIBUTES.has(attribute)) {
      deferred.push(attribute);
      results.push({ attribute, tier: info.tier, modules: info.modules.sort(), covered: true, deferred: true, reason: 'Fast Mode 延期（欠账可见，不算证据）', checks: [] });
      continue;
    }
    const claiming = (matrix?.checks ?? []).filter((check) => (check.attributes ?? []).includes(attribute));
    if (!claiming.length) {
      results.push({ attribute, tier: info.tier, modules: info.modules.sort(), covered: false, reason: '声明未接线：没有任何检查在 matrix 中认领该属性', checks: [] });
      continue;
    }
    const checkStates = [];
    let anyPass = false;
    let counterEvidence = null;
    let allCoveredByWaiverOrPass = true;
    const windowLabels = [];
    const expiredWindows = [];
    for (const check of claiming) {
      const fresh = latestFreshStatus(receiptsMap, check.id, fingerprint.fingerprint, now);
      const waiver = waivers.find((item) => item.checkId === check.id);
      const waiverState = waiver ? waiverValid(waiver, fingerprint.fingerprint) : { active: false };
      if (fresh.state === 'FAIL') counterEvidence = check.id;
      if (fresh.state === 'PASS') anyPass = true;
      if (fresh.timeWindow) windowLabels.push(`${check.id} ${fresh.timeWindow}（至 ${fresh.receipt.validUntil}）`);
      if (fresh.windowExpired) expiredWindows.push(`${check.id} ${fresh.receipt.timeWindow ?? 'time-window'} 已过期（${fresh.receipt.validUntil}）`);
      // 每个认领检查要么 fresh PASS，要么 BLOCKED/SKIPPED 且持有有效 waiver。
      const passOrWaived = fresh.state === 'PASS' || (waiverState.active && ['BLOCKED', 'SKIPPED'].includes(fresh.state));
      if (!passOrWaived) allCoveredByWaiverOrPass = false;
      checkStates.push({ id: check.id, state: fresh.state, waived: waiverState.active, timeWindow: fresh.timeWindow ?? null, windowExpired: Boolean(fresh.windowExpired) });
    }
    let covered = anyPass && !counterEvidence;
    let reason = covered ? '存在 fresh PASS 认领证据' : '无 fresh PASS 认领证据';
    if (counterEvidence) {
      covered = false;
      reason = `检查 ${counterEvidence} 存在 FAIL 反证（反证压过佐证）`;
    } else if (!covered && allCoveredByWaiverOrPass && claiming.length) {
      covered = true;
      reason = '全部认领检查为 fresh PASS 或持有效 waiver（豁免的是跑不了，不是跑挂了）';
    }
    if (windowLabels.length) reason += `；runtime 证据窗口内有效：${windowLabels.join('、')}`;
    if (expiredWindows.length) reason += `；runtime 证据已过期：${expiredWindows.join('、')}`;
    if (!chain.intact) {
      covered = false;
      reason = `证据账本哈希链断裂（fail-closed 视同未验证）：${chain.reason}`;
    }
    results.push({ attribute, tier: info.tier, modules: info.modules.sort(), covered, deferred: false, reason, checks: checkStates });
  }
  const uncovered = results.filter((item) => !item.covered);
  return {
    ok: uncovered.length === 0,
    scope: scopeNote,
    fingerprint: fingerprint.fingerprint,
    governed: results.length > 0,
    attributes: results,
    uncovered,
    degradeNotes,
    deferredByFastMode: deferred.sort(),
    ledgerChain: chain
  };
}

// 完成门：风险层 required kinds 全部 fresh，否则列出缺口（exit 2）。
// fast 门不能关闭 task：fastWindow 印记的 SKIPPED 一律是缺口（借账不是折扣），
// 还债路径唯一——fast off 后重跑完整 gate。有效 waiver 覆盖 BLOCKED 不变。
export async function completionGate(ctx, task, options = {}) {
  const now = options.now ?? Date.now();
  await requireGit(ctx, 'task complete');
  const matrix = await loadMatrix(ctx);
  const fingerprint = await gitFingerprint(ctx);
  const ledger = await readLedgerEntries(ctx);
  const chain = verifyLedgerChain(ledger.entries, { archives: ledger.archives });
  const plan = requiredPlan(ctx, matrix, task.risk);
  const receiptsMap = await latestReceipts(ctx);
  const waivers = await readWaivers(ctx);
  const gaps = [];
  const satisfied = [];
  for (const kind of plan.missingKinds) {
    gaps.push({ kind, check: null, reason: `kind ${kind} 未配置任何检查（缺命令 = BLOCKED）` });
  }
  for (const check of plan.checks) {
    const fresh = latestFreshStatus(receiptsMap, check.id, fingerprint.fingerprint, now);
    const waiver = waivers.find((item) => item.checkId === check.id);
    const waiverState = waiver ? waiverValid(waiver, fingerprint.fingerprint) : { active: false, why: '无 waiver' };
    let ok = false;
    let reason = '';
    if (fresh.state === 'PASS') {
      ok = true;
      reason = fresh.timeWindow ? `fresh PASS（${fresh.timeWindow} 窗口内，至 ${fresh.receipt.validUntil}）` : 'fresh PASS';
    }
    else if (fresh.state === 'FAIL') { ok = false; reason = 'fresh FAIL（已执行的失败永不可豁免）'; }
    else if (fresh.state === 'SKIPPED') {
      // fast 是借账不是折扣：带 fastWindow 印记的 SKIPPED 永远不能关闭 task——
      // 唯一还债路径是 fast off 后重跑完整 gate（release 的 fast-debt-repaid 同样不认 fast 印记）。
      if (fresh.receipt?.fastWindow) {
        reason = 'fast 借账回执（fastWindow 印记）不算证据：fast 门不能关闭 task/release；fast off 后重跑完整 gate 还债';
      }
      else if (waiverState.active) { ok = true; reason = '有效 waiver 覆盖 SKIPPED'; }
      else reason = 'SKIPPED 不算证据';
    } else if (fresh.state === 'BLOCKED') {
      if (waiverState.active) { ok = true; reason = '有效 waiver 覆盖 BLOCKED'; }
      else reason = fresh.receipt?.reason ? `BLOCKED：${fresh.receipt.reason}` : 'BLOCKED';
    } else if (fresh.state === 'invalid') {
      reason = '回执内容哈希不匹配（疑似篡改）';
    } else if (fresh.windowExpired) {
      reason = `runtime 证据窗口已过期（${fresh.receipt?.timeWindow ?? 'time-window'} 至 ${fresh.receipt?.validUntil}；过期即不 fresh）`;
    } else {
      reason = '缺 fresh receipt（当前指纹下未执行）';
    }
    const entry = { kind: check.kind, check: check.id, state: fresh.state, reason };
    if (check.required === false && fresh.state === 'missing') continue; // 可选检查未跑不拦
    if (ok) satisfied.push(entry);
    else if (check.required === false && fresh.state !== 'FAIL') { satisfied.push({ ...entry, optional: true }); }
    else gaps.push(entry);
  }
  if (!chain.intact) {
    gaps.push({ kind: null, check: null, reason: `证据账本哈希链断裂：${chain.reason}（fail-closed 视同未验证）` });
  }
  // 结构化对抗评审：catalog 声明 review 段且 requireStructured !== false 且任务 risk=high 时，
  // 需要当前指纹下带 lens 覆盖的终审 ACCEPT 评审回执；无 review 段 = 无新要求（向后兼容）。
  if (task.risk === 'high') {
    const catalog = await loadCatalog(ctx).catch((error) => {
      if (error.code === 'JSON_READ_FAILED') return null;
      throw error;
    });
    if (catalog?.review && catalog.review.requireStructured !== false) {
      const reviews = [...receiptsMap.values()].filter((receipt) => receipt.kind === 'review' && receipt.verdict === 'ACCEPT' && receipt.final === true);
      const fresh = reviews.filter((receipt) => receipt.contentHash === contentHashOf(receipt)
        && receipt.fingerprint === fingerprint.fingerprint
        && Array.isArray(receipt.lenses) && receipt.lenses.length > 0);
      if (!fresh.length) {
        gaps.push({
          kind: 'review',
          check: null,
          reason: reviews.length
            ? '评审回执不满足 fresh 终审 ACCEPT（指纹已移动/内容哈希不匹配/无 lens 覆盖）；重跑 review start → blue → lens → verdict'
            : '高风险任务缺结构化评审回执：review start → review blue → review lens → review verdict（终审 ACCEPT 才写回执；消费者只认回执，不认 verdict 退出码）'
        });
      } else {
        satisfied.push({ kind: 'review', check: 'review', state: 'ACCEPT', reason: `fresh 终审 ACCEPT 评审回执（lens：${fresh[0].lenses.join(', ')}）` });
      }
    }
  }
  return { ok: gaps.length === 0, kinds: plan.kinds, satisfied, gaps, fingerprint: fingerprint.fingerprint, ledgerChain: chain };
}
