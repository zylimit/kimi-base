// lib/feedback.mjs —— feedback 四层进化引擎（REQ-058 / ADR-0010）
//
// record/list/scan/propose 四动词把"经验记录→毕业候选→结构化提议"从纯提示词纪律
// 落成机器维护面：frontmatter 七键（type/description/created/updated/occurrences/
// graduated/skipped）与 FEEDBACK-INDEX.md 由本模块单一写入，索引不再是手工台账。
// 机制红线（ADR-0010）：引擎永不自动改规则——scan 不改任何规则与有效条目，propose 只输出
// 提议（唯一写操作是 --skip 在被拒条目上记 skipped:true），落地恒需人工确认。
// 韧性（P6 修复轮）：record/skip 的读-改-写由跨进程文件锁互斥（并发不丢计数）；
// 损坏条目（缺 frontmatter）按 state.mjs quarantine 精神重命名为 <条目>.corrupt-<ts>
// 并输出警告——四动词照常工作，不静默丢证据，也不让一条坏条目拖死整个进化面。

import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './admin.mjs';
import { HarnessError, atomicWrite, pathExists, usageError } from './core.mjs';
import { withFileLock } from './state.mjs';

// 五类信号 type 机器 token（feedback-writer 五类观察维度）。
export const FEEDBACK_TYPES = Object.freeze([
  'user-correction', 'uncovered-scenario', 'repeated-operation', 'quality-issue', 'skill-effectiveness'
]);

export const FEEDBACK_DIR_REL = '.kimi-base/feedback';
export const FEEDBACK_INDEX_REL = `${FEEDBACK_DIR_REL}/FEEDBACK-INDEX.md`;

// frontmatter 七键的规范键序（record/重写时固定此序，额外键（如 private）原样保留在尾部）。
const FRONTMATTER_KEYS = ['type', 'description', 'created', 'updated', 'occurrences', 'graduated', 'skipped'];

const today = () => new Date().toISOString().slice(0, 10);

// topic 归一化：trim + 小写 + 连续空白/下划线折叠为单连字符 + 连续连字符折叠为单连字符
// （"Flaky Test"、"flaky--test"、"flaky-test" 是同主题）；同主题判定 = 归一化后字符串相等。
// 归一化结果即条目文件名，故必须同时是安全文件名（小写字母/数字/连字符）。
export function normalizeTopic(raw) {
  const topic = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
    throw usageError(`feedback topic 非法：「${String(raw)}」——归一化（trim+小写+空白/下划线折叠为连字符）后须为 小写字母/数字/连字符，实得「${topic}」`);
  }
  return topic;
}

function feedbackDir(ctx) {
  return path.join(ctx.root, '.kimi-base', 'feedback');
}

// frontmatter 值与正文分离：值解析复用 admin.parseFrontmatter（单源），本函数只负责切出正文。
function splitEntry(text, label) {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  const fm = parseFrontmatter(text);
  if (!match || !fm) throw new HarnessError(`feedback 条目缺 frontmatter：${label}`, 'FEEDBACK_ENTRY_INVALID');
  return { fm, body: text.slice(match[0].length) };
}

// 损坏条目隔离（state.mjs quarantine 精神）：重命名为 <条目>.corrupt-<ts>，证据留痕不静默删除，
// 隔离后不再以 .md 参与读取。并发下两个读取方竞抢同一条目时，后到者 ENOENT = 已被隔离，静默放过。
async function quarantineEntry(absolute, rel) {
  const quarantined = `${absolute}.corrupt-${Date.now()}`;
  try {
    await rename(absolute, quarantined);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return `${rel} 损坏（缺 frontmatter 或形状非法），已隔离为 ${path.basename(quarantined)}（不删证据，不再参与读取）`;
}

function serializeEntry(fm, body) {
  const extras = Object.keys(fm).filter((key) => !FRONTMATTER_KEYS.includes(key));
  const lines = [...FRONTMATTER_KEYS, ...extras].filter((key) => fm[key] !== undefined).map((key) => `${key}: ${fm[key]}`);
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

function toEntry(fm, topic, file) {
  const occurrences = Number(fm.occurrences ?? '1');
  return {
    topic,
    file,
    type: fm.type ?? '(未知)',
    description: fm.description ?? '',
    occurrences: Number.isInteger(occurrences) && occurrences >= 1 ? occurrences : 1,
    graduated: fm.graduated === 'true',
    skipped: fm.skipped === 'true',
    created: fm.created ?? null,
    updated: fm.updated ?? null
  };
}

// 读全部条目。templates/ 子目录是安装载荷的示例模板（isStableAsset 白名单形态），
// 只在 list 里可见；scan/propose 的候选面恒为 feedback/ 根的真实条目。
async function readEntries(ctx, { includeTemplates = false } = {}) {
  const dir = feedbackDir(ctx);
  const files = [];
  let names = [];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of names) {
    if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'FEEDBACK-INDEX.md') {
      files.push({ absolute: path.join(dir, entry.name), rel: `${FEEDBACK_DIR_REL}/${entry.name}`, topic: entry.name.replace(/\.md$/, '') });
    }
  }
  if (includeTemplates) {
    let templates = [];
    try {
      templates = await readdir(path.join(dir, 'templates'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of templates.filter((item) => item.endsWith('.md')).sort()) {
      files.push({ absolute: path.join(dir, 'templates', name), rel: `${FEEDBACK_DIR_REL}/templates/${name}`, topic: `templates/${name.replace(/\.md$/, '')}`, template: true });
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const entries = [];
  const warnings = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = splitEntry(await readFile(file.absolute, 'utf8'), file.rel);
    } catch (error) {
      // 一条坏条目不得拖死整个进化面：隔离 + 警告，其余条目照常。
      if (error instanceof HarnessError && error.code === 'FEEDBACK_ENTRY_INVALID') {
        const warning = await quarantineEntry(file.absolute, file.rel);
        if (warning) warnings.push(warning);
        continue;
      }
      throw error;
    }
    entries.push({ ...toEntry(parsed.fm, file.topic, file.rel), template: Boolean(file.template) });
  }
  return { entries, warnings };
}

// INDEX 由引擎单一维护：每次写入操作（record/--skip）后从条目全集现算重写。
async function writeIndex(ctx) {
  const { entries, warnings } = await readEntries(ctx);
  const lines = [
    '# FEEDBACK-INDEX',
    '',
    '机器维护：`feedback record` / `feedback propose --skip` 是唯一写入口，请勿手工编辑。',
    '',
    ...(entries.length
      ? entries.map((entry) => `- [${entry.topic}](${entry.topic}.md) — type: ${entry.type} — occurrences: ${entry.occurrences} — updated: ${entry.updated ?? '-'} — graduated: ${entry.graduated} — skipped: ${entry.skipped}`)
      : ['（暂无条目）'])
  ];
  await atomicWrite(path.join(ctx.root, FEEDBACK_INDEX_REL), `${lines.join('\n')}\n`);
  return warnings;
}

// 损坏条目如果恰好是 record/skip 的目标条目：隔离后按新建/缺失语义处理（不拖死写入路径）。
async function readEntryOrQuarantine(absolute, rel, warnings) {
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return splitEntry(text, rel);
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'FEEDBACK_ENTRY_INVALID') {
      const warning = await quarantineEntry(absolute, rel);
      if (warning) warnings.push(warning);
      return null;
    }
    throw error;
  }
}

// 计数口径：occurrences 必须是正整数才递增；非法值（负数/非数）按 0 起计——
// 负计数 +1 递增永不毕业的静默死条在此终结（宁重计不滥计）。
function nextOccurrences(raw) {
  const base = Number(raw);
  return (Number.isInteger(base) && base >= 1 ? base : 0) + 1;
}

// feedback record：同主题（归一化判定）去重 occurrences+1、updated 刷新、INDEX 同步。
// 读-改-写全程在跨进程文件锁内（并发 record 不丢计数）；先校验全部输入再落盘，
// INDEX 与条目在同一把锁内原子推进——命令失败即未计数，可安全重试。
export async function recordFeedback(ctx, { topic, type, description }) {
  for (const [name, value] of [['topic', topic], ['type', type], ['description', description]]) {
    if (value === undefined || value === true || String(value).trim() === '') {
      throw usageError(`feedback record 需要 --${name} <值>（record --topic <主题> --type <五类之一> --description <描述>）`);
    }
  }
  const typeValue = String(type);
  if (!FEEDBACK_TYPES.includes(typeValue)) {
    throw usageError(`非法 feedback type：${typeValue}；合法集（五类信号）：${FEEDBACK_TYPES.join(' / ')}`);
  }
  const normalized = normalizeTopic(topic);
  const date = today();
  const desc = String(description).replace(/\s+/g, ' ').trim();
  await mkdir(feedbackDir(ctx), { recursive: true });
  const rel = `${FEEDBACK_DIR_REL}/${normalized}.md`;
  const absolute = path.join(ctx.root, rel);
  return withFileLock(path.join(ctx.stateDir, 'feedback.lock'), ctx.locks, async () => {
    const warnings = [];
    const existing = await readEntryOrQuarantine(absolute, rel, warnings);
    let occurrences;
    let created;
    if (existing) {
      occurrences = nextOccurrences(existing.fm.occurrences);
      created = false;
      const logLine = `- ${date}：${desc}`;
      const trimmed = existing.body.trimEnd();
      const nextBody = /## 出现记录/.test(trimmed) ? `${trimmed}\n${logLine}\n` : `${trimmed}\n\n## 出现记录\n${logLine}\n`;
      await atomicWrite(absolute, serializeEntry({ ...existing.fm, occurrences: String(occurrences), updated: date }, nextBody));
    } else {
      occurrences = 1;
      created = true;
      const fm = { type: typeValue, description: desc, created: date, updated: date, occurrences: '1', graduated: 'false', skipped: 'false' };
      const body = `\n## 信号\n${desc}\n\n## 教训\n（待总结——由 propose 提议、人工确认后毕业）\n\n## 出现记录\n- ${date}：${desc}\n`;
      await atomicWrite(absolute, serializeEntry(fm, body));
    }
    warnings.push(...await writeIndex(ctx));
    return { path: rel, occurrences, created, warnings };
  });
}

export async function listFeedback(ctx) {
  const { entries, warnings } = await readEntries(ctx, { includeTemplates: true });
  return { entries, count: entries.length, warnings };
}

// feedback scan：毕业候选检测（不改任何规则与有效条目；损坏条目会被隔离并警告——
// 这是读取路径上唯一的写操作，目的是让坏条目退场而不是拖死扫描）。
//   毕业候选：occurrences≥3 且未 graduated 未 skipped（宁漏不滥）；
//   聚类候选：同 type（失败模式）跨 ≥3 个不同 topic；
//   新 skill 候选：type=repeated-operation（无 Skill 覆盖信号）且 occurrences≥5。
export async function scanFeedback(ctx) {
  const { entries, warnings } = await readEntries(ctx);
  const active = entries.filter((entry) => !entry.graduated && !entry.skipped);
  const graduation = active.filter((entry) => entry.occurrences >= 3);
  const newSkills = active.filter((entry) => entry.type === 'repeated-operation' && entry.occurrences >= 5);
  const byType = new Map();
  for (const entry of active) {
    if (!byType.has(entry.type)) byType.set(entry.type, []);
    byType.get(entry.type).push(entry.topic);
  }
  const clusters = [...byType.entries()]
    .filter(([, topics]) => new Set(topics).size >= 3)
    .map(([type, topics]) => ({ type, topics: [...new Set(topics)].sort() }));
  return { graduation, newSkills, clusters, scanned: active.length, warnings };
}

// 目标层映射（优先级：可执行 check > fitness 规则 > skill 步骤 > AGENTS.md 散文——
// check 不开火零成本，散文每请求都付费）。映射本身是实现判断，排序正确性由评审把关。
const TARGET_LAYER = {
  'quality-issue': { layer: 'check', hint: '质量问题优先落成可执行 check（不开火零成本）；无法机械判定的降为 fitness 规则' },
  'user-correction': { layer: 'fitness', hint: '行为纠正优先落成 fitness 规则；不可机械判定的才降为 AGENTS.md 散文' },
  'uncovered-scenario': { layer: 'skill', hint: '未覆盖场景 → 补对应 skill 的步骤（该 skill 缺指引）' },
  'repeated-operation': { layer: 'skill', hint: '重复操作 → skill 步骤；occurrences≥5 时提议新建 skill' },
  'skill-effectiveness': { layer: 'skill', hint: '效能评估 → 回写被评 skill 的步骤优化' }
};

// feedback propose：对每个候选产结构化提议（目标层 + 证据指针），只输出不落盘规则文件。
export async function proposeFeedback(ctx) {
  const scan = await scanFeedback(ctx);
  const newSkillTopics = new Set(scan.newSkills.map((entry) => entry.topic));
  const seen = new Set();
  const proposals = [];
  for (const entry of [...scan.graduation, ...scan.newSkills]) {
    if (seen.has(entry.topic)) continue;
    seen.add(entry.topic);
    const target = TARGET_LAYER[entry.type] ?? { layer: 'AGENTS.md', hint: '未映射类型 → 兜底散文层（人工判断是否可上移）' };
    proposals.push({ ...entry, layer: target.layer, hint: target.hint, newSkill: newSkillTopics.has(entry.topic) });
  }
  for (const cluster of scan.clusters) {
    const target = TARGET_LAYER[cluster.type] ?? { layer: 'AGENTS.md', hint: '未映射类型 → 兜底散文层' };
    proposals.push({ cluster: true, type: cluster.type, topics: cluster.topics, layer: target.layer, hint: target.hint });
  }
  return { proposals, scanned: scan.scanned, warnings: scan.warnings };
}

// feedback propose --skip：被拒提议记 frontmatter skipped:true（不删条目），
// 之后 scan/propose 不再报该主题。写路径与 record 同一把锁互斥。
export async function skipFeedback(ctx, rawTopic) {
  const topic = normalizeTopic(rawTopic);
  const rel = `${FEEDBACK_DIR_REL}/${topic}.md`;
  const absolute = path.join(ctx.root, rel);
  return withFileLock(path.join(ctx.stateDir, 'feedback.lock'), ctx.locks, async () => {
    const warnings = [];
    const existing = await readEntryOrQuarantine(absolute, rel, warnings);
    if (!existing) throw usageError(`feedback propose --skip：条目不存在或已损坏隔离：${topic}（${rel}）`);
    await atomicWrite(absolute, serializeEntry({ ...existing.fm, skipped: 'true', updated: today() }, existing.body));
    warnings.push(...await writeIndex(ctx));
    return { path: rel, topic, warnings };
  });
}
