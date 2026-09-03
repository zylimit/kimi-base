// lib/scan.mjs —— 静态扫描：spec lint / trace / spec view / rules-audit / skills-lint / agents-lint
//
// 需求文档必须可判定而不是形容词堆（spec lint）；每条需求必须被测试引用才算
// 验证过（trace，覆盖门禁）；宪法里不点名执法点的规则不是规则，是祷文
// （rules-audit）；skill/agent 资产的契约漂移由 lint 机械拦截。
//
// 对称规则（dsh 缺陷修正）：只为同时声明的 id 族扫描引用——REQ 与 NFR 都声明
// 也都扫描，不存在第三族（dsh 曾扫 HAZ/THR 却从不声明，dangling 必然误报）。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './admin.mjs';
import { matchesGlob } from './catalog.mjs';
import { normalizeLf, normalizeRepoPath, toPosix } from './core.mjs';
import { FITNESS_RULES } from './fitness.mjs';
import { changedPaths, trackedPaths } from './git.mjs';
import { BUILTIN_CHECKS, loadMatrix } from './matrix.mjs';

// ════════════════════════════════════════════════════════════════════════════
// spec lint —— 需求可判定性
// ════════════════════════════════════════════════════════════════════════════

// kimi 同时接受裸形式（REQ-001）与领域形式（REQ-<AREA>-001，如认证域）——相对 dsh 的刻意偏离。
const REQ_ID = /\b((?:REQ|NFR)-(?:[A-Z]{2,6}-)?\d{3,4})\b/;
const NORMATIVE = /(SHALL|MUST|必须|不得|应当)/;
const EARS = /(\bWHEN\b|\bWHILE\b|\bIF\b|\bWHERE\b|当|若)/i;
// 可度量目标 = 数字携带单位或被数名词："250 ms"、"99.9 %"、"0 个第三方依赖"。
const METRIC = /\b\d+(?:\.\d+)?\s*(?:%|[A-Za-z][A-Za-z/_-]*)/;
const ACCEPTANCE = /(Acceptance|验收|Given|Verification|验证)/i;
const PLACEHOLDERS = ['TBD', 'TODO', '待补充', '待定'];
// ASCII 占位符按"独立成词"判定：两侧若是字母数字/'/'/引号书名号，说明它只是行文中
// 被枚举的名字（如 "Pinned/Decisions/TODO/In Progress" 这种段名清单），不是没写完的占位。
const PLACEHOLDER_ASCII = /(?<![\w/「『"'])(?:TBD|TODO)(?![\w/」』"'])/;
const PLACEHOLDER_CJK = /待补充|待定/;
const AMBIGUOUS = [
  'user-friendly', 'robust', 'scalable', 'efficient', 'appropriate', 'reasonable',
  'as needed', 'and so on', 'flexible', 'easy to use', 'high performance',
  'best effort', 'if possible', 'as fast as possible',
  '尽快', '友好', '合理', '适当', '良好', '灵活', '易用', '尽可能'
];
const BLOCK_LINES = 14; // 一个需求的"块" = id 所在行起 14 行

/** requirementDirs 条目既可以是 .md 文件也可以是目录（目录递归取 *.md）。 */
async function requirementFiles(ctx) {
  const files = [];
  const walk = async (absolute, relative) => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(absolute, entry.name);
      const childRel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(toPosix(childRel));
    }
  };
  for (const entry of ctx.spec.requirementDirs) {
    const absolute = path.join(ctx.root, entry);
    const info = await stat(absolute).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) await walk(absolute, toPosix(entry));
    else if (info.isFile() && /\.md$/i.test(entry)) files.push(toPosix(entry));
  }
  // 模板是骨架不是需求来源；变更史引用 id 而不声明 id。两者都不按需求文档 lint。
  return [...new Set(files)].filter((file) => !/TEMPLATE/i.test(file) && !/CHANGELOG/i.test(file)).sort();
}

export async function specLint(ctx) {
  const files = await requirementFiles(ctx);
  if (!files.length) {
    return { degraded: true, reason: `需求目录无任何 .md 文件：${ctx.spec.requirementDirs.join(', ')}`, findings: [], ids: [], documents: [] };
  }
  const findings = [];
  const seen = new Map();
  const ids = [];
  const corpus = [];

  for (const file of files) {
    const text = normalizeLf(await readFile(path.join(ctx.root, file), 'utf8'));
    corpus.push(text);
    const lines = text.split('\n');
    for (const placeholder of PLACEHOLDERS) {
      const pattern = /[\u4e00-\u9fff]/.test(placeholder) ? PLACEHOLDER_CJK : PLACEHOLDER_ASCII;
      const index = lines.findIndex((line) => pattern.test(line) && line.includes(placeholder));
      if (index >= 0) {
        findings.push({ file, line: index + 1, severity: 'error', code: 'PLACEHOLDER', message: `需求文档含占位符 "${placeholder}"；写了一半的需求比没有更糟` });
      }
    }
    for (let index = 0; index < lines.length; index += 1) {
      const match = REQ_ID.exec(lines[index]);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) {
        if (seen.get(id) !== file) {
          findings.push({ file, line: index + 1, severity: 'error', code: 'DUPLICATE_ID', id, message: `${id} 已在 ${seen.get(id)} 声明；id 只增不复用` });
        }
        continue;
      }
      seen.set(id, file);
      ids.push({ id, file, line: index + 1 });
      const block = lines.slice(index, Math.min(lines.length, index + BLOCK_LINES)).join('\n');
      if (!NORMATIVE.test(block)) {
        findings.push({ file, line: index + 1, severity: 'error', code: 'NOT_NORMATIVE', id, message: `${id} 无规范关键词（SHALL/MUST/必须/不得/应当）；不约束任何东西的需求无法验证` });
      }
      if (id.startsWith('REQ-') && !EARS.test(block)) {
        findings.push({ file, line: index + 1, severity: 'warning', code: 'NO_TRIGGER', id, message: `${id} 未声明触发条件（WHEN/WHILE/IF/WHERE/当/若）；EARS 形式让测试用例不言自明` });
      }
      if (id.startsWith('NFR-') && !METRIC.test(block)) {
        findings.push({ file, line: index + 1, severity: 'error', code: 'NO_METRIC', id, message: `${id} 未声明可度量目标（数字+单位）；不可测量的质量需求无法上门禁` });
      }
      const lowered = block.toLowerCase();
      const ambiguous = AMBIGUOUS.find((word) => lowered.includes(word.toLowerCase()));
      if (ambiguous) {
        findings.push({ file, line: index + 1, severity: 'warning', code: 'AMBIGUOUS', id, message: `${id} 使用歧义词 "${ambiguous}"；换成可判定表述` });
      }
      if (!ACCEPTANCE.test(block)) {
        findings.push({ file, line: index + 1, severity: 'error', code: 'NO_ACCEPTANCE', id, message: `${id} 无验收证据（Acceptance/验收/Given/Verification/验证）；没有验收，"完成"只是观点` });
      }
    }
  }

  // 每个治理属性必须在语料中有着落（声明或书面出范围），否则治理无人认领。
  const allText = corpus.join('\n').toLowerCase();
  const attributes = ctx.config.governance?.attributes ?? ['resilience', 'security', 'safety', 'privacy', 'reliability'];
  for (const attribute of attributes) {
    if (!allText.includes(attribute.toLowerCase())) {
      findings.push({ severity: 'warning', code: 'ATTRIBUTE_UNADDRESSED', attribute, message: `需求语料未提及治理属性 "${attribute}"；陈述它，或书面声明出范围` });
    }
  }

  const errors = findings.filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    files: files.length,
    documents: files,
    ids,
    findings,
    counts: { error: errors.length, warning: findings.length - errors.length, requirements: ids.length }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// trace —— 需求 → 代码/测试 追溯门禁
// ════════════════════════════════════════════════════════════════════════════

const ID_RE = /\b((?:REQ|NFR)-(?:[A-Z]{2,6}-)?\d{3,4})\b/g;
const TRACE_MAX_BYTES = 512 * 1024;
// 文档引用未声明的 id 只报告不失败（行文可以举例）；代码/测试引用未声明 id = 失败，
// 因为它点名了一个已不存在的需求。
const DOC_GLOBS = ['docs/**', '.kimi-base/templates/**', '.kimi-code/**', 'plugin/**', '*.md'];

export async function traceRequirements(ctx) {
  const spec = await specLint(ctx);
  if (spec.degraded) return { degraded: true, reason: spec.reason };
  const declared = new Map(spec.ids.map((item) => [item.id, { id: item.id, file: item.file, line: item.line, tests: [], code: [] }]));
  const requirementSet = new Set(spec.documents);

  const tracked = await trackedPaths(ctx, ctx.catalogLimits.maxTrackedPaths);
  if (!tracked.isGit) return { degraded: true, reason: '非 git 仓，无法枚举 tracked 文件——trace 无法测量（不假绿）' };
  if (tracked.truncated) return { degraded: true, reason: `tracked 路径 ${tracked.total} 超上限被截断——坏测量不按干净报` };
  // tracked ∪ 未跟踪（exclude-standard）：追溯是工作树事实门，提交前的新测试文件
  // 里的引用必须立刻可见，否则覆盖率在开发中撒谎、提交后才变绿。
  const extras = await changedPaths(ctx).catch(() => ({ untracked: [] }));
  const candidates = [...new Set([...tracked.paths, ...(extras.untracked ?? [])])].sort();

  const dangling = [];
  const danglingInDocs = [];
  for (const file of candidates) {
    if (requirementSet.has(file)) continue;
    let text;
    try {
      const info = await stat(path.join(ctx.root, file));
      if (info.size > TRACE_MAX_BYTES) continue;
      text = await readFile(path.join(ctx.root, file), 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue;
    ID_RE.lastIndex = 0;
    const hits = new Set();
    let match;
    while ((match = ID_RE.exec(text)) !== null) hits.add(match[1]);
    if (!hits.size) continue;
    const isTest = ctx.spec.testGlobs.some((glob) => matchesGlob(file, glob));
    const isDoc = DOC_GLOBS.some((glob) => matchesGlob(file, glob));
    for (const id of hits) {
      const record = declared.get(id);
      if (!record) {
        (isDoc ? danglingInDocs : dangling).push({ id, file });
        continue;
      }
      (isTest ? record.tests : record.code).push(file);
    }
  }

  const rows = [...declared.values()].map((record) => ({
    id: record.id,
    definedIn: record.file,
    line: record.line,
    tests: record.tests.slice(0, 10),
    code: record.code.slice(0, 10),
    testCount: record.tests.length,
    codeCount: record.code.length,
    verified: record.tests.length > 0,
    implemented: record.code.length > 0
  }));
  const unverified = rows.filter((row) => !row.verified);
  const minCoverage = ctx.spec.minCoverage;
  const coverage = rows.length ? (rows.length - unverified.length) / rows.length : 0;
  return {
    ok: coverage >= minCoverage && dangling.length === 0,
    coverage: Number(coverage.toFixed(4)),
    minCoverage,
    total: rows.length,
    verified: rows.length - unverified.length,
    unverified: unverified.map((row) => row.id),
    dangling: dangling.slice(0, 50),
    danglingInDocs: danglingInDocs.slice(0, 50),
    danglingInDocsCount: danglingInDocs.length,
    rows,
    advice: unverified.length
      ? '每条需求必须被至少一个测试引用：把 id 写进测试名或注释，链接即可机器核查'
      : '每条已声明需求都有至少一个测试引用'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// spec view —— 预算化需求摘要（规格是唯一不归档的记忆，只能少读不能全读）
// ════════════════════════════════════════════════════════════════════════════

export async function specView(ctx, options = {}) {
  const budget = Number.isInteger(options.budget) && options.budget >= 200 ? options.budget : 6000;
  const trace = await traceRequirements(ctx);
  if (trace.degraded) return { degraded: true, reason: trace.reason };

  let selected = trace.rows;
  let scope = 'all';
  let filterPaths = null;
  if (!options.all) {
    if (options.paths?.length) {
      filterPaths = [...new Set(options.paths.map(normalizeRepoPath))];
      scope = 'paths';
    } else {
      const changes = await changedPaths(ctx);
      if (!changes.isGit) {
        return { degraded: true, reason: '非 git 仓且无 --paths：无法确定过滤面；用 --all 读全量' };
      }
      filterPaths = changes.paths;
      scope = 'changed';
    }
    const set = new Set(filterPaths);
    selected = trace.rows.filter((row) => [...row.tests, ...row.code].some((file) => set.has(file)));
  }

  const titleCache = new Map();
  const titleOf = async (row) => {
    if (!titleCache.has(row.definedIn)) {
      titleCache.set(row.definedIn, normalizeLf(await readFile(path.join(ctx.root, row.definedIn), 'utf8')).split('\n'));
    }
    const lines = titleCache.get(row.definedIn);
    const raw = lines[row.line - 1] ?? lines.find((line) => line.includes(row.id)) ?? '';
    const cleaned = raw.replace(/^\s*(?:-|\d+\.)\s+/, '').replace(row.id, '').trim();
    return cleaned.length <= 160 ? cleaned : `${cleaned.slice(0, 157).trimEnd()}...`;
  };

  const headerLines = [
    `# 需求摘要（${scope === 'all' ? '全量' : `过滤面 ${scope}：${(filterPaths ?? []).slice(0, 10).join(', ') || '空'}`}）`,
    `选中 ${selected.length}/${trace.total} 条已声明需求`,
    ''
  ];
  let used = headerLines.join('\n').length;
  const entries = [];
  const omitted = [];
  for (const row of selected) {
    const entry = `- ${row.id} ${await titleOf(row)} —— 测试验证：${row.verified ? 'yes' : 'no'}（${row.definedIn}:${row.line}）`;
    if (used + entry.length + 1 > budget) {
      omitted.push(row.id);
      continue;
    }
    entries.push(entry);
    used += entry.length + 1;
  }
  // 省略必须显式，永不静默截断。
  const footer = omitted.length ? `\n预算外显式省略 ${omitted.length} 条：${omitted.join(', ')}（提高 --budget 或收窄 --paths）` : '';
  const body = `${headerLines.join('\n')}${entries.join('\n')}${footer}\n`;
  return {
    ok: true,
    scope,
    total: trace.total,
    selected: selected.map((row) => row.id),
    rendered: entries.length,
    omitted,
    chars: body.length,
    budget,
    text: body
  };
}

// ════════════════════════════════════════════════════════════════════════════
// rules-audit —— 宪法执法率：不点名执法点又不承认无执法的规则，会拉低有执法规则的遵从度
// ════════════════════════════════════════════════════════════════════════════

// 引擎动词面（rules-audit 的"执法点"词表之一；新增动词必须同步此处）。
export const ENGINE_VERBS = new Set([
  'install', 'upgrade', 'uninstall', 'manifest', 'doctor', 'pack-check', 'task', 'gate',
  'quality', 'waiver', 'arch', 'adr', 'catalog', 'fitness', 'impact', 'context',
  'receipt', 'review', 'fast', 'risk', 'gate-audit', 'retention', 'hook',
  'init-modules', 'selftest', 'help',
  'recap', 'invariants', 'archive', 'sync-check', 'spec', 'trace', 'rules-audit',
  'skills-lint', 'agents-lint'
]);

const RULE_LINE = /^\s*(?:\d+\.|-|\|)\s+\S/;
const PROMPT_ONLY = /(提示词|prompt[- ]only|\(P\))/i;
const SECTION = /^#{2,3}\s+(.+?)\s*$/;
const MIN_RULE_CHARS = 25;

function enforcementTokens(line, known) {
  const found = [];
  const pattern = /`([^`]{2,80})`/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const bare = match[1].trim()
      .replace(/^node\s+\.kimi-base\/runtime\/kimi-base\.mjs\s+/, '')
      .replace(/^node\s+kimi-base\.mjs\s+/, '')
      .replace(/^npm\s+run\s+/, '')
      .split(/[\s|]/)[0];
    if (known.has(bare)) found.push(bare);
  }
  return found;
}

export async function rulesAudit(ctx, options = {}) {
  const matrix = await loadMatrix(ctx).catch(() => null);
  const known = new Set([
    ...(matrix?.checks ?? []).map((check) => check.id),
    ...BUILTIN_CHECKS,
    ...FITNESS_RULES.map((rule) => rule.id),
    ...ENGINE_VERBS
  ]);
  const targets = options.files?.length ? options.files.map(normalizeRepoPath) : ['AGENTS.md'];
  const rows = [];
  for (const file of targets) {
    let text;
    try {
      text = normalizeLf(await readFile(path.join(ctx.root, file), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const lines = text.split('\n');
    let section = '(preamble)';
    let inFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const heading = SECTION.exec(line);
      if (heading) { section = heading[1]; continue; }
      if (!RULE_LINE.test(line) || line.trim().length < MIN_RULE_CHARS) continue;
      const tokens = enforcementTokens(line, known);
      const declared = PROMPT_ONLY.test(line) || PROMPT_ONLY.test(lines[index + 1] ?? '') || PROMPT_ONLY.test(section);
      rows.push({
        file,
        line: index + 1,
        section,
        state: tokens.length ? 'enforced' : declared ? 'declared-prompt-only' : 'unenforced',
        enforcedBy: tokens,
        text: line.trim().slice(0, 140)
      });
    }
  }
  const enforced = rows.filter((row) => row.state === 'enforced');
  const declared = rows.filter((row) => row.state === 'declared-prompt-only');
  const silent = rows.filter((row) => row.state === 'unenforced');
  // 默认纯建议：执法率量的是诚实不是正确——第一天就把无执法规则变成阻断闸，
  // 那本身就是一条背后什么都没有的规则，正是本命令要点名的失效。
  const max = ctx.rulesAudit.maxUnenforced ?? Infinity;
  const findings = silent.map((row) => ({
    severity: 'error', code: 'RULE_UNENFORCED', file: row.file, line: row.line,
    message: `规则未点名执法点也未自认 prompt-only："${row.text}"。绑定到命令、标记提示词纪律，或删掉——无执法规则会与有执法规则争夺注意力`
  }));
  return {
    ok: silent.length <= max,
    counts: {
      total: rows.length,
      enforced: enforced.length,
      declaredPromptOnly: declared.length,
      unenforced: silent.length,
      maxUnenforced: max === Infinity ? null : max
    },
    enforcementRatio: rows.length ? Number((enforced.length / rows.length).toFixed(3)) : 1,
    rows,
    findings,
    advice: silent.length
      ? `${silent.length} 条规则背后没有任何执法。每一条都在拉低有执法规则的遵从度`
      : '每条规则要么点名执法点，要么承认自己是提示词纪律'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// skills-lint —— .kimi-code/skills 契约（取代 skill-description-lint.sh）
// ════════════════════════════════════════════════════════════════════════════

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_ERROR_CHARS = 500;
const DESCRIPTION_WARN_CHARS = 220;
const SKILL_WARN_BYTES = 24 * 1024;

export async function skillsLint(ctx) {
  const skillsRoot = path.join(ctx.root, '.kimi-code', 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entries) {
    return { ok: true, skills: 0, findings: [], counts: { error: 0, warning: 0, skills: 0 }, note: '.kimi-code/skills 不存在（无资产可 lint）' };
  }
  const findings = [];
  const skills = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(skillsRoot, entry.name, 'SKILL.md');
    const rel = `.kimi-code/skills/${entry.name}/SKILL.md`;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') findings.push({ file: rel, severity: 'error', code: 'NO_SKILL_MD', message: `skill 目录 ${entry.name} 缺 SKILL.md；发现机制只认 <name>/SKILL.md` });
      else throw error;
      continue;
    }
    const meta = parseFrontmatter(text);
    if (!meta) {
      findings.push({ file: rel, severity: 'error', code: 'BAD_FRONTMATTER', message: '缺 YAML frontmatter 或形状非法' });
      continue;
    }
    if (!meta.name) {
      findings.push({ file: rel, severity: 'error', code: 'NO_NAME', message: 'frontmatter 缺 name' });
    } else {
      if (!KEBAB.test(meta.name)) findings.push({ file: rel, severity: 'error', code: 'NAME_NOT_KEBAB', message: `name "${meta.name}" 必须 kebab-case` });
      if (meta.name !== entry.name) findings.push({ file: rel, severity: 'error', code: 'NAME_MISMATCH', message: `name "${meta.name}" ≠ 目录名 "${entry.name}"；发现与加载不一致会使 skill 静默失效` });
    }
    if (!meta.description) {
      findings.push({ file: rel, severity: 'error', code: 'NO_DESCRIPTION', message: 'frontmatter 缺 description——它是目录里模型唯一可见的路由信号' });
    } else {
      const chars = [...meta.description].length;
      if (chars > DESCRIPTION_ERROR_CHARS) findings.push({ file: rel, severity: 'error', code: 'DESCRIPTION_TOO_LONG', message: `description ${chars} 字符，超过 ${DESCRIPTION_ERROR_CHARS} 硬顶` });
      else if (chars > DESCRIPTION_WARN_CHARS) findings.push({ file: rel, severity: 'warning', code: 'DESCRIPTION_LONG', message: `description ${chars} 字符（>${DESCRIPTION_WARN_CHARS}）；每个会话每次请求都要为它付费` });
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > SKILL_WARN_BYTES) findings.push({ file: rel, severity: 'warning', code: 'SKILL_LARGE', message: `skill 体积 ${bytes} 字节（>${SKILL_WARN_BYTES}），加载即全额付费；细节移到 references/ 并链接` });
    skills.push({ name: meta.name ?? entry.name, dir: entry.name, bytes });
  }
  const names = skills.map((skill) => skill.name);
  for (const name of [...new Set(names.filter((item, index) => names.indexOf(item) !== index))]) {
    findings.push({ severity: 'error', code: 'DUPLICATE_SKILL', message: `skill 名 "${name}" 重复；近层会静默遮蔽远层` });
  }
  const errors = findings.filter((item) => item.severity === 'error');
  return { ok: errors.length === 0, skills: skills.length, findings, counts: { error: errors.length, warning: findings.length - errors.length, skills: skills.length } };
}

// ════════════════════════════════════════════════════════════════════════════
// agents-lint —— 根 AGENTS.md 契约（每次请求都重发，体积是税）
// ════════════════════════════════════════════════════════════════════════════

const AGENTS_WARN_BYTES = 12000;
const AGENTS_ERROR_BYTES = 16000;

export async function agentsLint(ctx) {
  const findings = [];
  const file = path.join(ctx.root, 'AGENTS.md');
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(await readFile(file, 'utf8'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    findings.push({ severity: 'error', code: 'NO_ROOT_AGENTS', message: '项目根缺 AGENTS.md；宿主没有可注入的宪法' });
    return { ok: false, bytes: 0, findings, counts: { error: 1, warning: 0 } };
  }
  if (bytes > AGENTS_ERROR_BYTES) {
    findings.push({ file: 'AGENTS.md', severity: 'error', code: 'ROOT_AGENTS_OVERSIZE', message: `AGENTS.md ${bytes} 字节（>${AGENTS_ERROR_BYTES}）；宪法只放不变量，流程下沉 skills/rules` });
  } else if (bytes > AGENTS_WARN_BYTES) {
    findings.push({ file: 'AGENTS.md', severity: 'warning', code: 'ROOT_AGENTS_LARGE', message: `AGENTS.md ${bytes} 字节（>${AGENTS_WARN_BYTES}，逼近 ${AGENTS_ERROR_BYTES} 上限）；每次请求都全额重发` });
  }
  const errors = findings.filter((item) => item.severity === 'error');
  return { ok: errors.length === 0, bytes, findings, counts: { error: errors.length, warning: findings.length - errors.length } };
}
