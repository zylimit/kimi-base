// lib/review.mjs —— 结构化对抗评审（结构化分歧评审协议）
// 哲学：共识是失效模式——廉价的一致通过不是评审。裁决是计算出来的：
// 未报告的 lens 不能被豁免，报出 error 的 lens 不能被干净 lens 投票压过。
// 会话绑定它评审的那棵树（diffHash）或那个提交范围（range.head）：
// 任何字节变化都使会话 stale（exit 4）。
// backlog 独立于会话持久（state/review-backlog.json）：重开评审不冲掉债务；
// security/safety/privacy 类发现永不可进 backlog——backlog 不得沦为设计所拒绝的那种 waiver。

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { archCheckRun } from './arch.mjs';
import { assessBudget } from './budget.mjs';
import { TIER_RANK, analyzeImpact, loadCatalog } from './catalog.mjs';
import { HarnessError, atomicWrite, boundedText, contentHashOf, degradedError, nowIso, sha256, staleError, toPosix, usageError } from './core.mjs';
import { runFitness } from './fitness.mjs';
import { changedPaths, git, gitFingerprint, requireGit, splitZero } from './git.mjs';
import { appendLedgerRecord, writeReceiptFile } from './ledger.mjs';
import { REVIEW_BACKLOG_FILE, REVIEW_SESSION_FILE } from './paths.mjs';
import { readState, stateFile, updateState, writeState } from './state.mjs';
import { loadStrengthConfig, resolveStrength } from './strength.mjs';
import { getActiveTask } from './tasks.mjs';

// finding.location 锚定结尾行号（兼容 Windows 路径 D:\src\x.ts:12——不排斥路径中的冒号与反斜杠）。
const LOCATION_PATTERN = /:(\d+)(:\d+)?$/;
// 受保护发现禁词：启发式而非保证——命中即拒，未命中不代表安全。
const BACKLOG_FORBIDDEN = /security|safety|privacy|pii|secret|credential|密码|密钥|凭据/i;
const LENS_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const FINDING_MESSAGE_LIMIT = 2000;

// 阶段即预算：便宜评审没过的代码不配吃贵评审；阶段门控就是这个预算的执行机构。
export const REVIEW_STAGES = Object.freeze({ 1: 'code', 2: 'functional', 3: 'trust' });

// 评审团：九个 lens，各管一类失效模式。attribute 是该 lens 代言的治理属性——
// 受影响模块都没给它定档时召集对应评审只会产出挑刺，挑刺是评审 loop 失去信任的方式。
// correctness 无属性：它是每次评审的地板，永不收缩。
export const LENS_LIBRARY = Object.freeze({
  correctness: {
    stage: 1,
    attribute: null,
    asks: ['需求说的做到了吗：边界（空/越界/null）与错误路径，不只是 happy path', '与既有规则或 Spec 是否自相矛盾']
  },
  architecture: {
    stage: 1,
    attribute: 'maintainability',
    asks: ['改动是否待在声明边界内；新增依赖边是否进了 catalog；分层方向是否合规']
  },
  maintainability: {
    stage: 1,
    attribute: 'maintainability',
    asks: ['下一个人不考古能否看懂：重复、死代码、名不副实的命名、只解释 what 不解释 why 的注释']
  },
  testing: {
    stage: 2,
    attribute: 'reliability',
    asks: ['没有这个修复测试会红吗；每个用例是否可追溯到锚点；失败是分类了还是被重试掩盖']
  },
  performance: {
    stage: 2,
    attribute: 'performance',
    asks: ['增长路径上的复杂度级别；每次调用分配了什么；是否满足书面预算而非感觉快']
  },
  reliability: {
    stage: 3,
    attribute: 'reliability',
    asks: ['部分失败时怎样：效果幂等吗；错误被处理还是上抛；有没有被静默吞掉的东西']
  },
  resilience: {
    stage: 3,
    attribute: 'resilience',
    asks: ['每个外呼是否有超时；每次重试是否有带退避的预算；每个队列/缓存是否有上限；降级模式是否声明']
  },
  security: {
    stage: 3,
    attribute: 'security',
    asks: ['STRIDE 过一遍本改动触碰的信任边界：认证、授权、注入点、密钥、传输、供应链']
  },
  privacy: {
    stage: 3,
    attribute: 'privacy',
    asks: ['触碰/记录/导出/留存了什么个人数据；依据是什么；删除能否被证明']
  }
});

// 剖面 = 这个项目的风险值得多大的评审团。个人工具与支付系统用同一台引擎，但绝不是同一个评审团。
export const REVIEW_PROFILES = Object.freeze({
  personal: ['correctness'],
  team: ['correctness', 'testing', 'architecture'],
  production: ['correctness', 'testing', 'architecture', 'security', 'reliability', 'performance'],
  regulated: Object.keys(LENS_LIBRARY)
});

export function stageOfLens(name) {
  return LENS_LIBRARY[name]?.stage ?? 1;
}

// 当前阶段（lens 报告门禁用）：无召集 lens 的阶段不是闸门，跳过；首个有召集但未齐报的阶段即当前阶段。
export function currentStage(session) {
  const reported = new Set(Object.keys(session.lenses ?? {}));
  const required = session.requiredLenses ?? [];
  let stage = 1;
  for (;;) {
    const atStage = required.filter((name) => stageOfLens(name) === stage);
    if (atStage.length && atStage.some((name) => !reported.has(name))) return stage;
    if (stage >= 3) return stage;
    stage += 1;
  }
}

// 属性收缩：受影响模块均未把该 lens 的属性定档 ≥ low 即剔除（correctness 无属性永不剔除）。
// 属性只能收缩团队，不能扩张：全定 high 的项目不会因此召集所有人。
function shrinkByAttributes(catalog, affectedModules, base) {
  const modules = (catalog?.modules ?? []).filter((module) => affectedModules.includes(module.id));
  const required = [];
  const excluded = [];
  for (const name of base) {
    const lens = LENS_LIBRARY[name];
    if (!lens) continue; // 配置期已校验 lens 名；此处仅防御
    if (!lens.attribute || modules.length === 0) {
      required.push(name);
      continue;
    }
    const kept = modules.some((module) => (TIER_RANK[module.attributes?.[lens.attribute]?.tier ?? 'none'] ?? 0) >= TIER_RANK.low);
    if (kept) required.push(name);
    else excluded.push({ lens: name, reason: `受影响模块均未将 ${lens.attribute} 定档 ≥ low（属性只能收缩团队，不能扩张）` });
  }
  return { required, excluded };
}

// 团队选拔：显式 lenses 非空则显式集胜出，否则剖面定团；随后属性收缩。
export function selectReviewTeam(catalog, affectedModules) {
  const config = catalog?.review ?? null;
  const explicit = Array.isArray(config?.lenses) && config.lenses.length ? config.lenses : null;
  const profile = explicit ? 'explicit' : (config?.profile ?? 'team');
  const base = explicit ?? (REVIEW_PROFILES[config?.profile ?? 'team'] ?? REVIEW_PROFILES.team);
  const { required, excluded } = shrinkByAttributes(catalog, affectedModules, base);
  return { required, excluded, profile };
}

// REQ-057：strength.json 存在时召集由强度策略轴驱动——reviewLenses（full=九 lens 全集 /
// minimal=correctness 地板 / standard=team 相当集；none 同 minimal，correctness 永不落空），
// reviewRounds 存进 session 作 maxRounds。catalog 四剖面退为无 strength.json 时的别名；
// 与 catalog 显式 lenses 冲突时 strength 胜出并注明。随后照常套属性收缩。
async function selectReviewTeamWithStrength(ctx, catalog, affected) {
  const strengthConfig = await loadStrengthConfig(ctx);
  if (!strengthConfig) return { ...selectReviewTeam(catalog, affected), maxRounds: null, strength: null };
  const resolved = await resolveStrength(ctx, {});
  const lensesAxis = resolved.axes.reviewLenses;
  const base = lensesAxis === 'full' ? Object.keys(LENS_LIBRARY)
    : lensesAxis === 'minimal' || lensesAxis === 'none' ? ['correctness']
    : REVIEW_PROFILES.team;
  const { required, excluded } = shrinkByAttributes(catalog, affected, base);
  const overrodeCatalogLenses = Array.isArray(catalog?.review?.lenses) && catalog.review.lenses.length > 0;
  return {
    required,
    excluded,
    profile: `strength:${resolved.active}`,
    maxRounds: resolved.axes.reviewRounds,
    strength: {
      profile: resolved.active,
      reviewLenses: lensesAxis,
      reviewStages: resolved.axes.reviewStages,
      policyHash: resolved.policyHash,
      ...(overrodeCatalogLenses ? { note: 'catalog.review.lenses 显式集与强度策略轴冲突：strength 胜出（显式集未生效）' } : {})
    }
  };
}

export async function readReviewSession(ctx) {
  const session = await readState(ctx, REVIEW_SESSION_FILE, null);
  if (session !== null && (session.version !== 1 || typeof session.diffHash !== 'string')) {
    throw new HarnessError('评审会话状态非法', 'STATE_CORRUPT');
  }
  return session;
}

// 新鲜度：工作树模式比对 diffHash（任何字节变化即 stale）；range 模式只要求 HEAD 未移动
// （评审对象是提交范围，工作树编辑不改变已提交的 diff）。
async function sessionFreshness(ctx, session) {
  if (session.range) {
    const head = await git(ctx, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    const current = head.exitCode === 0 ? head.stdout.trim() : null;
    if (current !== session.range.head) {
      return { fresh: false, why: `HEAD 已移动（评审绑定 range.head ${session.range.head.slice(0, 12)}，当前 ${current ? current.slice(0, 12) : '无提交'}）` };
    }
    return { fresh: true };
  }
  const fingerprint = await gitFingerprint(ctx);
  if (fingerprint.diffHash !== session.diffHash) return { fresh: false, why: '工作树已变化（diffHash 漂移）' };
  return { fresh: true };
}

async function requireFreshSession(ctx, operation) {
  const session = await readReviewSession(ctx);
  if (!session) throw usageError(`当前没有评审会话；先 review start（${operation}）`);
  const fresh = await sessionFreshness(ctx, session);
  if (!fresh.fresh) throw staleError(`评审会话已陈旧：${fresh.why}；请重新 review start`, 'STALE_EVIDENCE');
  return session;
}

async function loadCatalogOrNull(ctx) {
  return loadCatalog(ctx).catch((error) => {
    if (error.code === 'JSON_READ_FAILED') return null; // 无 catalog = 无显式选拔面：剖面默认 team，不收缩
    throw error;
  });
}

// 开启评审会话。重开时把上一轮的裁决摘要追加进 lineage（跨轮存活），然后重新绑定指纹。
export async function reviewStart(ctx, options = {}) {
  await requireGit(ctx, 'review start');
  const baseRef = options.base ? String(options.base).trim() : null;
  let diffHash;
  let baseCommit;
  let scopePaths;
  let range = null;
  if (baseRef) {
    const resolved = await git(ctx, ['rev-parse', '--verify', `${baseRef}^{commit}`], { allowFailure: true });
    if (resolved.exitCode !== 0) throw usageError(`无效的 --base ref：${baseRef}`);
    const head = await git(ctx, ['rev-parse', '--verify', 'HEAD']);
    const headSha = head.stdout.trim();
    const patch = await git(ctx, ['diff', '--no-color', '--no-ext-diff', `${baseRef}...HEAD`]);
    if (!patch.stdout.trim()) {
      throw degradedError(`range ${baseRef}...HEAD 为空：没有可评审的提交差异（no-change）`, 'REVIEW_NO_CHANGE');
    }
    const names = await git(ctx, ['diff', '--name-only', '-z', `${baseRef}...HEAD`]);
    range = { base: baseRef, head: headSha, hash: sha256(patch.stdout) };
    diffHash = range.hash;
    baseCommit = headSha;
    scopePaths = splitZero(names.stdout).sort();
  } else {
    const fingerprint = await gitFingerprint(ctx);
    if (fingerprint.paths.length === 0) {
      throw degradedError('工作树与 HEAD 一致：没有可评审的改动（no-change）；评审提交范围请用 review start --base <ref>', 'REVIEW_NO_CHANGE');
    }
    diffHash = fingerprint.diffHash;
    baseCommit = fingerprint.baseCommit;
    scopePaths = fingerprint.paths;
  }
  const catalog = await loadCatalogOrNull(ctx);
  let affected = [];
  if (catalog) {
    const impact = await analyzeImpact(ctx, range ? { paths: scopePaths } : {});
    affected = impact.affectedModules;
  }
  const team = await selectReviewTeamWithStrength(ctx, catalog, affected);
  if (!team.required.length) {
    throw usageError(`评审团队为空：召集的 lens 全部被属性收缩剔除（${team.excluded.map((item) => item.lens).join(', ')}）；请检查 catalog review 配置或模块定档`);
  }
  const previous = await readReviewSession(ctx);
  const lineage = [...(previous?.lineage ?? [])];
  if (previous?.verdict) {
    lineage.push({
      at: previous.verdict.at,
      verdict: previous.verdict.verdict,
      diffHash: previous.diffHash,
      errorCount: previous.verdict.errorCount ?? 0,
      round: lineage.length + 1
    });
  }
  const session = {
    version: 1,
    diffHash,
    baseCommit,
    startedAt: nowIso(),
    scope: { paths: scopePaths },
    range,
    profile: team.profile,
    requiredLenses: team.required,
    excludedLenses: team.excluded,
    ...(team.maxRounds !== null ? { maxRounds: team.maxRounds } : {}),
    ...(team.strength ? { strength: team.strength } : {}),
    lineage,
    blue: null,
    lenses: {},
    verdict: null
  };
  await writeState(ctx, REVIEW_SESSION_FILE, session);
  return { session, previousVerdict: previous?.verdict ?? null };
}

// Blue 自证：自述只作红队靶子，不作通过依据；无证据的 claim 只是观点，整批拒绝。
export async function recordBlue(ctx, payload) {
  const session = await requireFreshSession(ctx, 'review blue');
  const claims = Array.isArray(payload?.claims) ? payload.claims : null;
  if (!claims || claims.length === 0) {
    throw usageError('review blue 需要 stdin JSON：{"claims":[{"claim","evidence"},...]}（至少一条 claim）');
  }
  const bad = claims.filter((claim) => !claim
    || typeof claim.claim !== 'string' || !claim.claim.trim()
    || typeof claim.evidence !== 'string' || !claim.evidence.trim());
  if (bad.length) {
    throw usageError(`${bad.length} 条 claim 缺 claim 或 evidence（无证据的自证只是观点）；整批拒绝`);
  }
  session.blue = {
    at: nowIso(),
    claims: claims.map((claim) => ({ claim: claim.claim.trim(), evidence: claim.evidence.trim() }))
  };
  await writeState(ctx, REVIEW_SESSION_FILE, session);
  return { claims: session.blue.claims.length };
}

function validateFindings(payload) {
  if (payload?.findings !== undefined && !Array.isArray(payload.findings)) {
    throw usageError('findings 必须是数组');
  }
  const findings = payload?.findings ?? [];
  for (const [index, finding] of findings.entries()) {
    const label = `findings[${index}]`;
    if (!finding || typeof finding !== 'object') throw usageError(`${label} 必须是对象`);
    if (!['error', 'warning', 'info'].includes(finding.severity)) {
      throw usageError(`${label}.severity 必须是 error|warning|info`);
    }
    if (typeof finding.message !== 'string' || !finding.message.trim()) {
      throw usageError(`${label}.message 必须是非空字符串`);
    }
    const location = typeof finding.location === 'string' && LOCATION_PATTERN.test(finding.location);
    const reproduction = typeof finding.reproduction === 'string' && Boolean(finding.reproduction.trim());
    // 给不出落点（file:line）或复现路径的发现不算 finding——防空喊；一条非法整批拒绝。
    if (!location && !reproduction) {
      throw usageError(`${label} 既无 file:line 落点（location 须匹配 :行号 结尾，兼容 Windows 路径）也无复现路径（reproduction）；整批拒绝`);
    }
  }
  if (payload?.unable === true && (typeof payload.unableReason !== 'string' || !payload.unableReason.trim())) {
    throw usageError('unable:true 必须附 unableReason（无法结论的理由——否则就是白卷）');
  }
  return findings.map((finding) => ({
    severity: finding.severity,
    message: boundedText(finding.message.trim(), FINDING_MESSAGE_LIMIT),
    ...(typeof finding.location === 'string' && finding.location.trim() ? { location: finding.location.trim() } : {}),
    ...(typeof finding.reproduction === 'string' && finding.reproduction.trim() ? { reproduction: boundedText(finding.reproduction.trim(), FINDING_MESSAGE_LIMIT) } : {})
  }));
}

// 单个 lens 报到。非召集 lens 一律拒绝，除非 --ad-hoc（额外证据通道：永不计入应到清单、
// 不受阶段门控——被属性收缩挡在门外的 lens 若真发现问题，必须有上报通道——但 error 仍压过一切）。
export async function recordLens(ctx, name, payload, options = {}) {
  const session = await requireFreshSession(ctx, 'review lens');
  const lensName = String(name ?? '').trim();
  if (!LENS_NAME_PATTERN.test(lensName)) throw usageError(`非法 lens 名：${name}`);
  // --ad-hoc 只对非召集 lens 生效；已召集 lens 携带该标志不改变语义（仍受阶段门控、仍占应到清单）。
  const convened = session.requiredLenses.includes(lensName);
  const adHoc = Boolean(options.adHoc) && !convened;
  if (!convened && !adHoc) {
    throw usageError(`lens ${lensName} 不在本轮召集清单（${session.requiredLenses.join(', ')}）；确需上报请用 --ad-hoc（记为额外证据，error 仍计入裁决）`);
  }
  const findings = validateFindings(payload);
  if (!adHoc) {
    const stage = stageOfLens(lensName);
    const current = currentStage(session);
    if (stage > current) {
      // 阶段门控：贵 lens 不得先于便宜 lens 开闸（贵评审花在没通过便宜评审的代码上是浪费）。
      return {
        refused: true,
        stageGated: true,
        lens: lensName,
        stage,
        currentStage: current,
        reason: `lens ${lensName} 属阶段 ${stage}（${REVIEW_STAGES[stage]}），当前处于阶段 ${current}（${REVIEW_STAGES[current]}）；请先报齐前序阶段的 lens`
      };
    }
  }
  const reviewer = typeof options.reviewer === 'string' && options.reviewer.trim() ? options.reviewer.trim() : null;
  session.lenses[lensName] = {
    at: nowIso(),
    adHoc,
    // REQ-057：lens 执行者身份入会话（authorship 账本）——verdict 据此拒作者自审。
    ...(reviewer ? { reviewer } : {}),
    unable: Boolean(payload?.unable),
    unableReason: typeof payload?.unableReason === 'string' && payload.unableReason.trim() ? payload.unableReason.trim() : null,
    findings
  };
  await writeState(ctx, REVIEW_SESSION_FILE, session);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { refused: false, lens: lensName, adHoc, findings: findings.length, counts, unable: session.lenses[lensName].unable };
}

// 裁决：计算出来的，不是声明出来的。
// 阻断（exit 1）：blue 未自证；或尚无任何一个阶段齐报时前沿阶段 lens 未报到。
// 任一 error 发现（召集或 ad-hoc）→ FIX_REQUIRED（exit 2）；应到 lens 报 unable → NEEDS_MORE_EVIDENCE（exit 3）；
// 否则 ACCEPT（exit 0）。回执只在 ACCEPT 且终审（frontier 不存在：阶段 3 已齐报，或更晚阶段无召集 lens）时写入。
export async function reviewVerdict(ctx, options = {}) {
  const session = await requireFreshSession(ctx, 'review verdict');
  const reviewer = typeof options.reviewer === 'string' && options.reviewer.trim() ? options.reviewer.trim() : 'main-agent';
  const notes = typeof options.notes === 'string' ? options.notes : '';
  const reported = new Set(Object.keys(session.lenses));
  const blockers = [];
  if (!session.blue) blockers.push('blue 尚未自证（review blue）');
  // 连续齐报推进到哪个阶段：空阶段跳过；首个有召集但未齐报的阶段即前沿。
  let completeThrough = 0;
  let frontier = null;
  for (let stage = 1; stage <= 3; stage += 1) {
    const atStage = session.requiredLenses.filter((name) => stageOfLens(name) === stage);
    if (!atStage.length) continue;
    if (atStage.every((name) => reported.has(name))) completeThrough = stage;
    else { frontier = stage; break; }
  }
  if (frontier !== null && completeThrough === 0) {
    const missing = session.requiredLenses.filter((name) => stageOfLens(name) === frontier && !reported.has(name));
    blockers.push(`阶段 ${frontier}（${REVIEW_STAGES[frontier]}）应到 lens 未报到：${missing.join(', ')}`);
  }
  if (blockers.length) {
    throw new HarnessError(`评审裁决被阻断：${blockers.join('；')}`, 'REVIEW_BLOCKED', 1, { blockers });
  }
  // REQ-057 authorship 执法：作者集 = active task 作者 ∪（range 模式）range 内提交者（git author name）；
  // 执行者集 = 各 lens 报到记录的执行者。两侧都有数据才谈得上执法；任一侧无数据必须
  // 诚实输出 authorshipEnforced:false（不假绿）。执行者 ∈ 作者集 = 作者自审，拒出 ACCEPT。
  // 身份串归一（trim+小写）是匹配地板：改名大小写不得绕过拒判（P5 评审 W1）。
  const normalizeIdentity = (name) => name.trim().toLowerCase();
  const task = await getActiveTask(ctx);
  const authors = new Set();
  if (typeof task?.author === 'string' && task.author.trim()) authors.add(normalizeIdentity(task.author));
  // range 作者集采集失败 = 身份数据不完整：authorshipEnforced 如实降 false，绝不静默按已执法报。
  let authorsComplete = true;
  if (session.range) {
    const log = await git(ctx, ['log', '--format=%an', `${session.range.base}..${session.range.head}`], { allowFailure: true });
    if (log.exitCode === 0) {
      for (const name of log.stdout.split('\n').map((item) => item.trim()).filter(Boolean)) authors.add(normalizeIdentity(name));
    } else {
      authorsComplete = false;
    }
  }
  // 执行者集只统计应到 lens：ad-hoc 是补充证据通道——其发现计入裁决，其执行者不参与独立性判定（P5 评审 W3）。
  const executors = new Map(); // 归一化身份 → 原始串（拒判输出点名用）
  for (const report of Object.values(session.lenses)) {
    if (report.adHoc) continue;
    if (typeof report.reviewer === 'string' && report.reviewer.trim()) {
      executors.set(normalizeIdentity(report.reviewer), report.reviewer.trim());
    }
  }
  const selfReview = [...executors.entries()].filter(([key]) => authors.has(key)).map(([, original]) => original);
  const authorshipEnforced = authorsComplete && authors.size > 0 && executors.size > 0;
  const errorFindings = Object.entries(session.lenses).flatMap(([lens, report]) =>
    (report.findings ?? []).filter((finding) => finding.severity === 'error').map((finding) => ({ lens, ...finding })));
  const unableRequired = session.requiredLenses.filter((name) => session.lenses[name]?.unable);
  const stage = frontier ?? completeThrough;
  const final = frontier === null;
  let verdict;
  let exitCode;
  if (authorshipEnforced && selfReview.length) { verdict = 'SELF_REVIEW_REJECTED'; exitCode = 2; }
  else if (errorFindings.length) { verdict = 'FIX_REQUIRED'; exitCode = 2; }
  else if (unableRequired.length) { verdict = 'NEEDS_MORE_EVIDENCE'; exitCode = 3; }
  else { verdict = 'ACCEPT'; exitCode = 0; }
  const catalog = await loadCatalogOrNull(ctx);
  // REQ-057：强度策略轴驱动时 maxRounds 以会话开启时定格的 reviewRounds 为准。
  const maxRounds = session.maxRounds ?? catalog?.review?.maxRounds ?? 3;
  const round = (session.lineage ?? []).length + 1;
  // 同一改动反复被拒是关于标准的信息，不是再试一次的指令：到上限即升级给人。
  const escalate = verdict === 'FIX_REQUIRED' && round >= maxRounds;
  session.verdict = {
    at: nowIso(),
    verdict,
    reviewer,
    notes,
    round,
    escalate,
    stage,
    final,
    errorCount: errorFindings.length,
    unableLenses: unableRequired,
    authorshipEnforced,
    ...(selfReview.length ? { selfReview } : {})
  };
  await writeState(ctx, REVIEW_SESSION_FILE, session);
  let receipt = null;
  if (verdict === 'ACCEPT' && final) {
    const fingerprint = await gitFingerprint(ctx);
    const taskId = task?.id ?? `review-${fingerprint.fingerprint.slice(0, 8)}`;
    const reportedNames = Object.keys(session.lenses).sort();
    const counts = { error: 0, warning: 0, info: 0 };
    for (const report of Object.values(session.lenses)) {
      for (const finding of report.findings ?? []) counts[finding.severity] += 1;
    }
    receipt = {
      version: 1,
      kind: 'review',
      id: `rcpt-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`,
      checkId: taskId.startsWith('review-') ? taskId : `review-${taskId}`,
      taskId,
      reviewer,
      verdict: 'ACCEPT',
      final: true,
      // 消费者只认回执：诚实标注必须进回执本体，不能只在 CLI 输出（P5 评审 W2）。
      authorshipEnforced,
      round,
      lenses: reportedNames,
      requiredLenses: [...session.requiredLenses].sort(),
      findings: counts,
      diffHash: session.diffHash,
      fingerprint: fingerprint.fingerprint,
      baseCommit: session.baseCommit,
      ...(session.range ? { range: session.range } : {}),
      notes,
      createdAt: nowIso()
    };
    const complete = { ...receipt, contentHash: contentHashOf(receipt) };
    await appendLedgerRecord(ctx, complete);
    await writeReceiptFile(ctx, complete);
    receipt = complete;
  }
  const advice = escalate
    ? `第 ${round}/${maxRounds} 轮仍 FIX_REQUIRED：停止重试，交由人类裁决——要么改动错了要么标准错了，再来一轮分辨不出是哪个`
    : verdict === 'SELF_REVIEW_REJECTED'
      ? '作者自审拒判：本 diff 的作者不能兼任 lens 执行者；请由作者集之外的独立评审者重报 lens 后重新裁决'
      : verdict === 'ACCEPT'
        ? (final ? '全部阶段通过：应到 lens 齐报且无 error 发现' : `阶段 ${completeThrough}（${REVIEW_STAGES[completeThrough]}）已通过；报齐阶段 ${frontier}（${REVIEW_STAGES[frontier]}）的 lens 以推进终审`)
        : verdict === 'FIX_REQUIRED'
          ? '修复 error 发现后重新 review start；报出 error 的 lens 不被干净 lens 投票压过'
          : '有 lens 无法得出结论：补齐它需要的证据再判，不要绕过';
  return { verdict, exitCode, final, stage, round, maxRounds, escalate, errorFindings, unableLenses: unableRequired, authorshipEnforced, selfReview, receipt, advice };
}

export async function reviewStatus(ctx) {
  const session = await readReviewSession(ctx);
  if (!session) throw degradedError('当前没有评审会话（review start 开启）', 'REVIEW_NO_SESSION');
  const fresh = await sessionFreshness(ctx, session);
  const stage = currentStage(session);
  const reported = Object.keys(session.lenses).sort();
  const pending = session.requiredLenses.filter((name) => !session.lenses[name]);
  const backlog = await readBacklog(ctx);
  const now = Date.now();
  return {
    session,
    fresh: fresh.fresh,
    staleReason: fresh.fresh ? null : fresh.why,
    stage,
    reported,
    pending,
    carriedBacklog: backlog.entries.length,
    expiredBacklog: backlog.entries.filter((entry) => Date.parse(entry.expiry) <= now).length
  };
}

// 团队预览：有会话报会话召集时定格的团队（那是实际生效的）；无会话按当前变更面现算。
export async function reviewTeam(ctx) {
  const session = await readReviewSession(ctx);
  if (session) {
    return { source: 'session', profile: session.profile ?? 'team', required: session.requiredLenses, excluded: session.excludedLenses ?? [] };
  }
  await requireGit(ctx, 'review team');
  const catalog = await loadCatalogOrNull(ctx);
  let affected = [];
  if (catalog) {
    const impact = await analyzeImpact(ctx, {});
    affected = impact.affectedModules;
  }
  const team = selectReviewTeam(catalog, affected);
  return { source: 'live', profile: team.profile, required: team.required, excluded: team.excluded };
}

// ── backlog（state/review-backlog.json，跨会话持久；重开评审不冲掉债务）──────────────

export async function readBacklog(ctx) {
  const state = await readState(ctx, REVIEW_BACKLOG_FILE, { version: 1, entries: [] });
  if (state.version !== 1 || !Array.isArray(state.entries)) throw new HarnessError('评审 backlog 状态非法', 'STATE_CORRUPT');
  return state;
}

export async function backlogAdd(ctx, payload) {
  await requireFreshSession(ctx, 'review backlog add');
  const missing = ['owner', 'expiry', 'summary', 'lens'].filter((field) => typeof payload?.[field] !== 'string' || !payload[field].trim());
  if (missing.length) throw usageError(`backlog 条目缺字段：${missing.join(', ')}（stdin JSON：{owner, expiry, summary, lens, location?}）`);
  const expiry = Date.parse(payload.expiry);
  if (!Number.isFinite(expiry)) throw usageError('expiry 必须是 ISO 时间（如 2026-09-01T00:00:00Z）');
  if (expiry <= Date.now()) throw usageError('expiry 必须是未来时间；没有截止日的债永远没人还');
  const summary = payload.summary.trim();
  // 受保护发现永不可进 backlog：backlog 不得沦为设计所拒绝的那种 waiver。
  // 该正则是启发式，不是保证——命中即拒，未命中不代表内容安全。
  if (BACKLOG_FORBIDDEN.test(summary)) {
    throw new HarnessError('security/safety/privacy 类发现永不可进 backlog（禁词命中；启发式拦截）；受保护发现必须修复或升级，不得挂账', 'REVIEW_BACKLOG_PROTECTED', 1);
  }
  const entry = {
    id: `bl-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`,
    at: nowIso(),
    owner: payload.owner.trim(),
    expiry: new Date(expiry).toISOString(),
    lens: payload.lens.trim(),
    summary: boundedText(summary, FINDING_MESSAGE_LIMIT),
    ...(typeof payload.location === 'string' && payload.location.trim() ? { location: payload.location.trim() } : {})
  };
  const next = await updateState(ctx, REVIEW_BACKLOG_FILE, { version: 1, entries: [] }, (state) => {
    if (state.version !== 1 || !Array.isArray(state.entries)) throw new HarnessError('评审 backlog 状态非法', 'STATE_CORRUPT');
    return { ...state, entries: [...state.entries, entry] };
  });
  return { entry, count: next.entries.length };
}

export async function backlogList(ctx) {
  const backlog = await readBacklog(ctx);
  const now = Date.now();
  const entries = backlog.entries.map((entry) => ({ ...entry, expired: Date.parse(entry.expiry) <= now }));
  return { count: entries.length, expired: entries.filter((entry) => entry.expired).length, entries };
}

// ── review pack：lens 代理消费的证据包（base ref 解析：最新 tag → origin/main → HEAD~1 → 根提交）──

// REQ-057：静态现存发现入包——fitness / arch check / budget 三源的当前结果直接摆给 lens，
// 免得评审代理把引擎已经知道的问题再发现一遍。每源各包 try/catch：采集失败如实标注，
// 不炸包（pack 是证据汇集，不是闸；失败标注本身就是证据）。
// 扫描面对准评审对象（P5 评审 W4）：range 会话时 fitness 扫 range 变更文件集、budget 以
// range.base 为基线——range 评审的改动已提交、工作树干净，走工作树变更面会扫 0 文件静默漏报；
// arch check 是声明图全仓校验（不消费 changedPaths），无变更面可对准，保持现状。
async function collectStaticFindings(ctx, session = null) {
  const rangePaths = session?.range ? session.scope.paths : null;
  const rangeBase = session?.range ? session.range.base : null;
  const sources = [];
  try {
    const result = rangePaths?.length ? await runFitness(ctx, { paths: rangePaths }) : await runFitness(ctx, {});
    sources.push({ source: 'fitness', lines: result.report.split('\n') });
  } catch (error) {
    sources.push({ source: 'fitness', lines: [`采集失败：${error.message}`] });
  }
  try {
    const result = await archCheckRun(ctx, {});
    sources.push({ source: 'arch check', lines: result.report.split('\n') });
  } catch (error) {
    sources.push({ source: 'arch check', lines: [`采集失败：${error.message}`] });
  }
  try {
    const result = rangeBase ? await assessBudget(ctx, { baseline: rangeBase }) : await assessBudget(ctx, {});
    sources.push({
      source: 'budget',
      lines: result.degraded
        ? [`降级：${result.reason}`]
        : result.findings.length
          ? result.findings.map((finding) => `- 超限 ${finding.metric}：实际 ${finding.actual} > 上限 ${finding.limit}`)
          : ['无超支发现（变更在声明的预算之内）']
    });
  } catch (error) {
    sources.push({ source: 'budget', lines: [`采集失败：${error.message}`] });
  }
  return sources;
}

export async function reviewPack(ctx) {
  await requireGit(ctx, 'review pack');
  const head = await git(ctx, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (head.exitCode !== 0) throw degradedError('无提交仓库（unborn HEAD）：review pack 需要至少一个提交', 'REVIEW_UNBORN');
  const headSha = head.stdout.trim();
  let base = null;
  let baseSource = null;
  const tag = await git(ctx, ['describe', '--tags', '--abbrev=0'], { allowFailure: true });
  if (tag.exitCode === 0 && tag.stdout.trim()) {
    base = tag.stdout.trim();
    baseSource = 'tag';
  }
  if (!base) {
    const originMain = await git(ctx, ['rev-parse', '--verify', 'origin/main'], { allowFailure: true });
    if (originMain.exitCode === 0) {
      base = 'origin/main';
      baseSource = 'origin/main';
    }
  }
  if (!base) {
    const previous = await git(ctx, ['rev-parse', '--verify', 'HEAD~1'], { allowFailure: true });
    if (previous.exitCode === 0) {
      base = 'HEAD~1';
      baseSource = 'HEAD~1';
    }
  }
  if (!base) {
    const roots = await git(ctx, ['rev-list', '--max-parents=0', 'HEAD']);
    base = roots.stdout.split('\n')[0].trim();
    baseSource = 'root-commit';
  }
  const baseSha = (await git(ctx, ['rev-parse', '--verify', `${base}^{commit}`])).stdout.trim();
  const rangeSpec = `${base}...HEAD`;
  const commits = (await git(ctx, ['log', '--oneline', `${base}..HEAD`])).stdout.split('\n').filter(Boolean);
  const diffstat = (await git(ctx, ['diff', '--stat', rangeSpec])).stdout.trim();
  const deleted = splitZero((await git(ctx, ['diff', '--diff-filter=D', '--name-only', '-z', rangeSpec])).stdout).sort();
  const changes = await changedPaths(ctx);
  const fullDiff = (await git(ctx, ['diff', '--no-color', '--no-ext-diff', rangeSpec])).stdout;
  const diffLines = fullDiff.trim() ? fullDiff.trimEnd().split('\n').length : 0;
  const epoch = Date.now();
  const directory = stateFile(ctx, 'review');
  const packPath = path.join(directory, `review-pack-${epoch}.md`);
  // W4：静态发现对准评审对象——有 range 会话时扫描面取自会话（scope.paths / range.base）。
  const session = await readReviewSession(ctx);
  const staticFindings = await collectStaticFindings(ctx, session);
  let spillPath = null;
  let diffSection;
  if (diffLines > 800) {
    spillPath = path.join(directory, `diff-${epoch}.patch`);
    await atomicWrite(spillPath, fullDiff);
    diffSection = `diff 过大（${diffLines} 行 > 800），完整补丁见 ${toPosix(path.relative(ctx.root, spillPath))}`;
  } else {
    diffSection = `\`\`\`diff\n${fullDiff.trimEnd()}\n\`\`\``;
  }
  const body = [
    '# 评审证据包',
    '',
    `- 生成：${nowIso()}`,
    `- 范围：${base}...HEAD（${baseSha.slice(0, 12)}...${headSha.slice(0, 12)}）`,
    `- base 来源：${baseSource}`,
    '',
    '## Commit 清单',
    ...(commits.length ? commits.map((line) => `- ${line}`) : ['（无新 commit）']),
    '',
    '## diffstat',
    '```',
    diffstat || '（无改动）',
    '```',
    '',
    '## 删除审计（被删除文件——重点核有无误删既有防线）',
    ...(deleted.length ? deleted.map((file) => `- ${file}`) : ['（无删除文件）']),
    '',
    '## 未跟踪文件',
    ...(changes.untracked.length ? changes.untracked.map((file) => `- ${file}`) : ['（无）']),
    '',
    `## 静态现存发现（fitness / arch check / budget 当前结果；扫描面：${session?.range ? `range ${session.range.base}...${session.range.head.slice(0, 12)} 变更文件集` : '工作树变更面'}；采集失败如实标注）`,
    ...staticFindings.flatMap((entry) => ['', `### ${entry.source}`, ...entry.lines]),
    '',
    `## 完整 diff（${diffLines} 行）`,
    diffSection,
    ''
  ].join('\n');
  await atomicWrite(packPath, body);
  return {
    packPath: toPosix(path.relative(ctx.root, packPath)),
    spillPath: spillPath ? toPosix(path.relative(ctx.root, spillPath)) : null,
    base,
    baseSource,
    baseSha,
    headSha,
    commits: commits.length,
    diffLines,
    deleted,
    untracked: changes.untracked
  };
}
