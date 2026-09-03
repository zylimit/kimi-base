// lib/memory.mjs —— 记忆法动词：recap / invariants / archive / sync-check
//
// 记忆若无界生长就不再是记忆：超过一定体量没人读，agent 读了也是把上下文花在
// 历史而不是工作上。所以 recap/invariants 是**派生**的预算化视图（读工件现算，
// 不信任何摘要——压缩摘要把漂移一起带进新会话），archive 让活体账本保持小巧
// 且只增不删，sync-check 把三文件同步从提示词纪律落成机械执法。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyPath, loadCatalog } from './catalog.mjs';
import { atomicWrite, degradedError, normalizeLf, normalizeRepoPath, nowIso } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { changedPaths, git } from './git.mjs';
import { riskScan } from './hygiene.mjs';
import { readLedgerEntries, verifyLedgerChain } from './ledger.mjs';
import { getActiveTask } from './tasks.mjs';

export const MEMORY_DEFAULTS = Object.freeze({
  ledger: 'progress.md',
  archive: 'progress.archive.md',
  maxBytes: 24000,
  keepDone: 40,
  keepNotes: 30,
  recapBudget: 6000,
  invariantsBudget: 1200,
  entryClip: 200
});

const SECTION_HEADING = /^##\s+(.+?)\s*$/;
// 条目行：连字符子弹或有序列表（Pinned 段在本仓是编号条目）。
const ENTRY_LINE = /^\s*(?:-|\d+\.)\s+\S/;

/** 把 progress.md 切成 "## " 段，保序留原始行。 */
export function parseMemorySections(text) {
  const sections = [];
  let current = null;
  for (const line of normalizeLf(text).split('\n')) {
    const match = SECTION_HEADING.exec(line);
    if (match) {
      current = { title: match[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

const entriesOf = (section) => (section ? section.lines.filter((line) => ENTRY_LINE.test(line)) : []);
const sectionNamed = (sections, name) =>
  sections.find((section) => section.title.toLowerCase().startsWith(name.toLowerCase())) ?? null;

/** 条目裁剪：一条记忆条目可带证据指针拖得很长，三条就能吃光预算——这正是 recap 存在的理由。 */
const clip = (line, max = MEMORY_DEFAULTS.entryClip) =>
  line.length <= max ? line : `${line.slice(0, max - 3).trimEnd()}...`;

async function readMemoryFile(ctx, relative) {
  try {
    return normalizeLf(await readFile(path.join(ctx.root, relative), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw degradedError(`降级：${relative} 缺失——项目记忆不存在，无法派生恢复视图（不假造内容）`, 'NO_MEMORY_FILE');
    }
    throw error;
  }
}

// Position 块：全部现算（git/任务账本/账本/ fast 窗口），一个字都不引用任何摘要。
async function positionLines(ctx) {
  const lines = [];
  const changes = await changedPaths(ctx).catch(() => ({ isGit: false, paths: [], note: 'git 不可用' }));
  if (changes.isGit) {
    const branch = await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    lines.push(`- 分支 ${branch.stdout?.trim() || '未知'} @ ${changes.baseCommit.slice(0, 12)}；未提交变更 ${changes.paths.length} 个路径`);
  } else {
    lines.push(`- 非 git 仓：git 派生状态降级（${changes.note}）`);
  }
  const task = await getActiveTask(ctx).catch(() => null);
  lines.push(`- 活跃任务：${task ? `${task.id}（risk=${task.risk}）— ${clip(task.goal, 80)}` : '无'}`);
  const ledger = await readLedgerEntries(ctx).catch(() => ({ entries: [], corrupt: false, archives: 0 }));
  const lastVerification = [...ledger.entries].reverse().find((entry) => !entry.__corrupt && entry.kind === 'verification');
  lines.push(`- 最近 gate：${lastVerification ? `${lastVerification.status} ${lastVerification.checkId} @ ${lastVerification.createdAt}` : '从未运行'}`);
  const fast = await fastModeStatus(ctx).catch(() => ({ active: false, expired: false }));
  lines.push(`- Fast Mode：${fast.active ? `开启至 ${fast.expiresAt}（protected 免疫；skip 是欠账不是豁免）` : fast.expired ? '已过期（视同关闭）' : '关闭'}`);
  return lines;
}

/**
 * recap：一个有界答案回答"现在到哪了"。
 * 只读当前活着的状态，成本是项目年龄的常数函数。条目顺序约定：
 * Pinned/In Progress/TODO/Risks 取段首（重要性序），Done 取段首（本仓约定新条目在上），
 * Decisions 取段尾（只追加，新的在后）。
 */
export async function recap(ctx, options = {}) {
  const budget = Number.isInteger(options.budget) && options.budget >= 200 ? options.budget : MEMORY_DEFAULTS.recapBudget;
  const text = await readMemoryFile(ctx, MEMORY_DEFAULTS.ledger);
  const sections = parseMemorySections(text);
  const pick = (name, limit, fromEnd = false) => {
    const entries = entriesOf(sectionNamed(sections, name));
    return (fromEnd ? entries.slice(-limit) : entries.slice(0, limit)).map((line) => clip(line));
  };
  const todo = entriesOf(sectionNamed(sections, 'TODO'));
  const todoPriority = (priority) => todo
    .filter((line) => new RegExp(`^\\s*-\\s+\\[P${priority}\\]\\[OPEN\\]`).test(line))
    .slice(0, 10)
    .map((line) => clip(line));
  const risks = await riskScan(ctx).catch(() => ({ risks: [] }));

  const blocks = [];
  const push = (title, lines) => { if (lines?.length) blocks.push(`## ${title}\n${lines.join('\n')}`); };
  push('Position（现算，不信摘要）', await positionLines(ctx));
  push('Pinned（铁律）', pick('Pinned', 12));
  push('In Progress', pick('In Progress', 8));
  push('TODO P0', todoPriority(0));
  push('TODO P1', todoPriority(1));
  push('Decisions（最近 5 条）', pick('Decisions', 5, true));
  push('Done（最近 6 条）', pick('Done', 6));
  push('Risks & Assumptions', pick('Risks', 8));
  if (risks.risks?.length) push('Decay signals（risk scan）', risks.risks.slice(0, 8).map((risk) => clip(`- [${risk.level}] ${risk.kind}：${risk.detail}`)));

  let body = `# recap — ${nowIso()}\n\n${blocks.join('\n\n')}\n`;
  let truncated = false;
  if (body.length > budget) {
    // 截断注记也占预算：总量绝不突破 budget，截断必须显式。
    const note = `\n\n...[recap 截断于 ${budget} 字符预算；其余见 ${MEMORY_DEFAULTS.ledger}]\n`;
    body = body.slice(0, Math.max(0, budget - note.length)) + note;
    truncated = true;
  }
  return { ok: true, text: body, chars: body.length, budget, truncated };
}

// ── invariants ─────────────────────────────────────────────────────────────
// 压缩不纠偏：摘要会把漂移原样带进新会话。对策是最小不可豁免集 + 改变其含义的
// 实时状态，小到每个阶段边界和任何压缩之后都值得重读一遍。派生自活状态，不会像
// 粘贴的提醒那样腐烂。

const LAWS = Object.freeze([
  '1. 证据优先：说出能证明它的命令 → 现跑 → 读完整输出与退出码 → 确认支撑该结论 → 才准说；DONE/口头成功不算。',
  '2. 绝不假绿：缺工具/缺命令/非 git 仓 = BLOCKED 或可见降级；exit 3 不是通过；SKIP 必须显式。',
  '3. 保护底线：security/safety/privacy 永不豁免、永不 fast-skip；waiver 只豁免"跑不了"，不豁免"跑挂了"。',
  '4. hooks 是护栏不是沙箱（fail-open）：最后防线是权限审批与人工复核。',
  '5. 三文件同步：治理代码与 progress.md 同 commit；Product-Spec.md 与 Product-Spec-CHANGELOG.md 同 commit（sync-check 执法）。'
]);

export async function invariantsDigest(ctx, budget = MEMORY_DEFAULTS.invariantsBudget) {
  const task = await getActiveTask(ctx).catch(() => null);
  const fast = await fastModeStatus(ctx).catch(() => ({ active: false, expired: false }));
  const ledger = await readLedgerEntries(ctx).catch(() => ({ entries: [], corrupt: false, archives: 0 }));
  const chain = verifyLedgerChain(ledger.entries, { archives: ledger.archives });
  const last = [...ledger.entries].reverse().find((entry) => !entry.__corrupt && entry.kind === 'verification');
  const state = [
    `- 活跃任务：${task ? `${task.id}（risk=${task.risk}）` : '无'}`,
    fast.active ? `- FAST MODE 开启至 ${fast.expiresAt}：证据是延期不是豁免；交付前 fast off 并重跑 gate` : null,
    `- 最近 gate：${last ? `${last.status} ${last.checkId} @ ${last.createdAt}` : '从未运行'}`,
    chain.intact ? null : '- 账本断链：此前一切验证视同未证明，重跑 gate'
  ].filter(Boolean);
  let body = `# Invariants（压缩后与阶段边界必读）\n\n${LAWS.join('\n')}\n\n## 实时状态\n${state.join('\n')}\n`;
  let truncated = false;
  if (body.length > budget) {
    body = `${body.slice(0, Math.max(0, budget - 16))}\n...[已截断]\n`;
    truncated = true;
  }
  return { text: body, chars: body.length, budget, truncated };
}

// ── archive ────────────────────────────────────────────────────────────────
// 历史只增不删：条目移动而非消失，归档条目永不改写；活体文件留指针行。

const POINTER_LINE = `- 更早的 Done/Notes 条目已归档至 [${MEMORY_DEFAULTS.archive}](${MEMORY_DEFAULTS.archive})（只增不删，归档条目永不改写）。`;

export async function archiveProgress(ctx, options = {}) {
  const keepDone = Number.isInteger(options.keepDone) && options.keepDone >= 0 ? options.keepDone : MEMORY_DEFAULTS.keepDone;
  const keepNotes = Number.isInteger(options.keepNotes) && options.keepNotes >= 0 ? options.keepNotes : MEMORY_DEFAULTS.keepNotes;
  const text = await readMemoryFile(ctx, MEMORY_DEFAULTS.ledger);
  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n');

  // 单趟扫描记录 Done/Notes 段的条目行号（段内约定新条目在上，尾部即最旧）。
  const entryLines = { Done: [], Notes: [] };
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = SECTION_HEADING.exec(lines[index]);
    if (heading) {
      current = heading[1].toLowerCase();
      continue;
    }
    if (!current || !ENTRY_LINE.test(lines[index])) continue;
    const key = current.startsWith('done') ? 'Done' : current.startsWith('notes') ? 'Notes' : null;
    if (key) entryLines[key].push(index);
  }

  const overBytes = bytes > MEMORY_DEFAULTS.maxBytes;
  const moving = {
    Done: entryLines.Done.length > keepDone ? entryLines.Done.slice(keepDone) : [],
    Notes: entryLines.Notes.length > keepNotes ? entryLines.Notes.slice(keepNotes) : []
  };
  const movingCount = moving.Done.length + moving.Notes.length;
  const report = {
    bytes, maxBytes: MEMORY_DEFAULTS.maxBytes,
    doneEntries: entryLines.Done.length, keepDone,
    noteEntries: entryLines.Notes.length, keepNotes,
    overBytes
  };
  if (!overBytes && movingCount === 0) {
    return { ok: true, applied: false, moved: 0, reason: 'nothing to archive', ...report };
  }
  if (movingCount === 0) {
    // 体积超限但条目数都在保留线内：自动归档无能为力，如实报告而非静默。
    return { ok: true, applied: false, moved: 0, reason: `文件 ${bytes} 字节超限但 Done/Notes 条目数均在保留线内；请人工精简长条目`, ...report };
  }
  const plan = [
    moving.Done.length ? { section: 'Done', total: entryLines.Done.length, keep: keepDone, moving: moving.Done.length } : null,
    moving.Notes.length ? { section: 'Notes', total: entryLines.Notes.length, keep: keepNotes, moving: moving.Notes.length } : null
  ].filter(Boolean);
  if (!options.apply) {
    return { ok: true, applied: false, moved: movingCount, plan, ...report };
  }

  const stamp = nowIso().slice(0, 10);
  const archivePath = path.join(ctx.root, MEMORY_DEFAULTS.archive);
  let archive;
  try {
    archive = normalizeLf(await readFile(archivePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    archive = '# 归档项目记忆\n\n只增不删。归档条目永不改写；修正 = 在活体 progress.md 里写新条目。\n';
  }
  archive += `\n## Archived ${stamp}\n`;
  for (const name of ['Done', 'Notes']) {
    if (!moving[name].length) continue;
    archive += `\n### ${name}\n\n${moving[name].map((index) => lines[index]).join('\n')}\n`;
  }
  await atomicWrite(archivePath, archive);

  const movedSet = new Set([...moving.Done, ...moving.Notes]);
  const firstMoved = Math.min(...movedSet);
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index === firstMoved) out.push(POINTER_LINE);
    if (movedSet.has(index)) continue;
    out.push(lines[index]);
  }
  await atomicWrite(path.join(ctx.root, MEMORY_DEFAULTS.ledger), out.join('\n'));
  return { ok: true, applied: true, moved: movingCount, plan, archive: MEMORY_DEFAULTS.archive, ...report };
}

// ── sync-check ─────────────────────────────────────────────────────────────
// 三文件同步的机械执法：治理代码动而记忆不动 = 下一个会话无法从这次提交恢复；
// 需求动而变更史不动 = 移动了需求却没留下理由，不可评审。

const PRODUCT_SPEC = 'Product-Spec.md';
const PRODUCT_SPEC_CHANGELOG = 'Product-Spec-CHANGELOG.md';

export async function syncCheck(ctx, options = {}) {
  let changed;
  let source;
  if (options.paths?.length) {
    changed = [...new Set(options.paths.map(normalizeRepoPath))].sort();
    source = 'explicit';
  } else {
    const changes = await changedPaths(ctx);
    if (!changes.isGit) {
      throw degradedError('降级：非 git 仓，无法测量——sync-check 需要 git 变更面；或用 --paths 显式指定', 'NON_GIT_BLOCKED');
    }
    changed = options.staged ? changes.staged : changes.paths;
    source = options.staged ? 'staged' : 'worktree';
  }
  // governed = 归类为模块的路径（catalog 缺失时治理面无法测量：按零 governed 继续并如实标注，
  // Spec↔CHANGELOG 对账是纯路径规则，不依赖 catalog，仍然执法）。
  let governed = [];
  let catalogNote = null;
  const catalog = await loadCatalog(ctx).catch((error) => {
    catalogNote = `catalog 不可用（${error.code ?? error.message}）：governed 面按零计`;
    return null;
  });
  if (catalog) governed = changed.filter((item) => classifyPath(catalog, item).classification === 'mapped');

  const findings = [];
  const has = (item) => changed.includes(item);
  if (governed.length && !has(MEMORY_DEFAULTS.ledger)) {
    findings.push({
      severity: 'error',
      code: 'MEMORY_BEHIND_CODE',
      sample: governed.slice(0, 5),
      message: `${governed.length} 个治理内文件变更而 ${MEMORY_DEFAULTS.ledger} 未进改动集；记录改了什么与证据，否则下个会话无法从本次提交恢复`
    });
  }
  const specChanged = has(PRODUCT_SPEC);
  const changelogChanged = has(PRODUCT_SPEC_CHANGELOG);
  if (specChanged && !changelogChanged) {
    findings.push({
      severity: 'error',
      code: 'SPEC_WITHOUT_CHANGELOG',
      sample: [PRODUCT_SPEC],
      message: `${PRODUCT_SPEC} 变更而 ${PRODUCT_SPEC_CHANGELOG} 未同改；移动了需求却没记录理由的变更不可评审`
    });
  }
  if (changelogChanged && !specChanged) {
    findings.push({
      severity: 'warning',
      code: 'CHANGELOG_WITHOUT_SPEC',
      message: `${PRODUCT_SPEC_CHANGELOG} 变更而 ${PRODUCT_SPEC} 未动；确认该条目描述了真实发生的事`
    });
  }
  const errors = findings.filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    source,
    changed: changed.length,
    governed: governed.length,
    ledgerInChange: has(MEMORY_DEFAULTS.ledger),
    findings,
    catalogNote,
    counts: { error: errors.length, warning: findings.length - errors.length }
  };
}
