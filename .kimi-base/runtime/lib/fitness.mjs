// lib/fitness.mjs —— fitness 五规则（内置零依赖文本级防线）
// 抑制：同行注释 kimi-base-ignore: <rule>（留痕）。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TIER_RANK, loadCatalog } from './catalog.mjs';
import { degradedError, normalizeRepoPath } from './core.mjs';
import { changedPaths, trackedPaths } from './git.mjs';
import { STATE_DIR } from './paths.mjs';

const FITNESS_IGNORE_MARKER = 'kimi-base-ignore';
const FITNESS_MAX_FILES = 2000;
export const FITNESS_MAX_BYTES = 1048576;
const FITNESS_MAX_FINDINGS = 200;

const SECRET_LITERAL_PATTERNS = [
  /\b(sk|pk|rk|sess)-[A-Za-z0-9_-]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(password|passwd|secret|api[_-]?key|access[_-]?key)\s*[=:]\s*["'][^"']{8,}["']/i
];

const PII_PATTERNS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\b1[3-9]\d{9}\b/, // 手机号（中国大陆）
  /\b\d{17}[\dXx]\b/, // 身份证
  /\b\d{16,19}\b/ // 银行卡号
];

export const FITNESS_RULES = [
  {
    id: 'no-secret-literal',
    severity: 'error',
    attributes: ['security'],
    test: (line) => SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(line)),
    message: '疑似凭据字面量；请移入密钥管理并轮换'
  },
  {
    id: 'no-pii-in-logs',
    severity: 'error',
    attributes: ['privacy'],
    test: (line) => /\b(?:console\.(?:log|info|warn|error|debug)|log(?:ger)?\.(?:log|info|warn|error|debug)|print(?:ln)?|fmt\.Print\w*)\s*[.(]/.test(line)
      && PII_PATTERNS.some((pattern) => pattern.test(line)),
    message: '日志语句携带 email/手机号/身份证/卡号模式；请记录稳定的假名标识'
  },
  {
    id: 'no-silent-failure',
    severity: 'error',
    attributes: ['reliability'],
    test: (line) => /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line) || /except[^:\n]*:\s*(?:pass|\.\.\.)\s*$/.test(line),
    message: '空 catch/except-pass：故障被吞成没人上报的错误答案'
  },
  {
    id: 'no-unbounded-retry',
    severity: 'warning',
    attributes: ['resilience'],
    test: (line) => /\b(?:while\s*\(\s*true\s*\)|while\s+True\s*:|for\s*\(\s*;;\s*\))/.test(line) && /\b(?:retry|reconnect|attempt|poll)\b/i.test(line),
    message: '无退避上限的重试循环：瞬时故障会放大成持续冲击'
  },
  {
    id: 'no-unreferenced-deferral',
    severity: 'warning',
    attributes: ['safety'],
    minimumTier: 'high', // 仅 safety>=high 模块生效
    test: (line) => /\b(?:TODO|FIXME|XXX|HACK)\b/.test(line) && !/\b(?:issue|ticket|#\d+|[A-Z]+-\d+)\b/.test(line),
    message: 'safety>=high 模块中未挂单的 TODO/FIXME：没人认领的欠账'
  }
];

const FITNESS_TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.kts', '.cs', '.php', '.swift', '.scala', '.sh', '.ps1', '.psm1',
  '.sql', '.yaml', '.yml', '.toml', '.json', '.md', '.txt', '.cfg', '.ini'
]);

function fitnessScannable(ctx, relative) {
  const pieces = relative.toLowerCase().split('/');
  const base = pieces.at(-1);
  if (pieces.includes('.git') || relative.startsWith(`${STATE_DIR}/`)) return false;
  if (ctx.security.dependencyDirs.some((item) => pieces.includes(item.toLowerCase()))) return false;
  if (ctx.security.allowedSecretTemplates.map((item) => item.toLowerCase()).includes(base)) return true;
  if (ctx.security.secretNames.map((item) => item.toLowerCase()).includes(base) || base.startsWith('.env')) return false;
  if (ctx.security.secretExtensions.some((item) => base.endsWith(item.toLowerCase()))) return false;
  const extension = path.posix.extname(base);
  return extension === '' || FITNESS_TEXT_EXTENSIONS.has(extension);
}

function fitnessSuppressed(line, ruleId) {
  const match = line.match(/kimi-base-ignore(?::\s*([\w,\s-]+))?/);
  if (!match) return false;
  if (!match[1]) return true;
  return match[1].split(',').map((item) => item.trim()).includes(ruleId);
}

// fitness 模块归属（root='.' 模块也参与作用域，与 arch 实边归属不同）。
function fitnessModuleOf(catalog, relative) {
  let best = null;
  let bestLength = -1;
  for (const module of catalog.modules) {
    const contains = module.root === '.' || relative === module.root || relative.startsWith(`${module.root}/`);
    if (!contains) continue;
    const length = module.root === '.' ? 0 : module.root.length;
    if (length > bestLength) { best = module; bestLength = length; }
  }
  return best;
}

export async function runFitness(ctx, options = {}) {
  let paths;
  let scope;
  if (options.paths?.length) {
    paths = options.paths.map(normalizeRepoPath);
    scope = 'paths';
  } else if (options.all) {
    // 全仓 = tracked ∪ 未跟踪（exclude-standard），与 trace 同口径：工作树事实，不信暂存边界。
    const tracked = await trackedPaths(ctx);
    if (!tracked.isGit) throw degradedError('降级：非 git 仓，无法测量——fitness --all 需要 git 枚举全仓路径；请用 --path 显式指定扫描范围', 'NON_GIT_BLOCKED');
    const extras = await changedPaths(ctx);
    paths = [...new Set([...tracked.paths, ...extras.untracked])].sort();
    scope = 'all';
  } else if (options.staged) {
    const changes = await changedPaths(ctx);
    if (!changes.isGit) throw degradedError('降级：非 git 仓，无法测量——fitness --staged 需要 git 暂存区；请用 --path 显式指定扫描范围', 'NON_GIT_BLOCKED');
    paths = changes.staged;
    scope = 'staged';
  } else {
    const changes = await changedPaths(ctx);
    if (!changes.isGit) throw degradedError('降级：非 git 仓，无法测量——fitness 默认扫描变更面需要 git；请用 --path 显式指定扫描范围', 'NON_GIT_BLOCKED');
    paths = changes.paths;
    scope = 'changed';
  }
  const catalog = await loadCatalog(ctx).catch(() => null);
  const findings = [];
  const suppressedFindings = [];
  const skipped = [];
  let scanned = 0;
  for (const relative of paths.slice(0, FITNESS_MAX_FILES)) {
    if (!fitnessScannable(ctx, relative)) {
      skipped.push({ path: relative, reason: '秘密文件/依赖目录/非文本路径' });
      continue;
    }
    let buffer;
    try {
      buffer = await readFile(path.join(ctx.root, relative));
    } catch {
      continue;
    }
    if (buffer.includes(0) || buffer.length > FITNESS_MAX_BYTES) {
      skipped.push({ path: relative, reason: buffer.length > FITNESS_MAX_BYTES ? '文件体积超限' : '二进制文件' });
      continue;
    }
    scanned += 1;
    const owner = catalog ? fitnessModuleOf(catalog, relative) : null;
    const lines = buffer.toString('utf8').split('\n');
    for (let index = 0; index < lines.length && findings.length < FITNESS_MAX_FINDINGS; index += 1) {
      for (const rule of FITNESS_RULES) {
        if (rule.minimumTier) {
          // 仅当所属模块把规则关联属性定档 >= minimumTier 时才生效。
          const active = rule.attributes.some((attribute) => {
            const tier = owner?.attributes?.[attribute]?.tier;
            return tier && TIER_RANK[tier] >= TIER_RANK[rule.minimumTier];
          });
          if (!active) continue;
        }
        if (!rule.test(lines[index])) continue;
        const record = { rule: rule.id, severity: rule.severity, path: relative, line: index + 1, message: rule.message, module: owner?.id ?? null };
        if (fitnessSuppressed(lines[index], rule.id)) suppressedFindings.push(record);
        else findings.push(record);
      }
    }
  }
  const errors = findings.filter((item) => item.severity === 'error');
  const warnings = findings.filter((item) => item.severity === 'warning');
  const status = errors.length > 0 ? 'FAIL' : 'PASS';
  const report = [
    `fitness：${status}；扫描 ${scanned} 文件（scope=${scope}）；error ${errors.length} / warning ${warnings.length} / 抑制留痕 ${suppressedFindings.length}`,
    ...findings.slice(0, 100).map((item) => `- ${item.severity} [${item.rule}] ${item.path}:${item.line} ${item.message}`),
    ...suppressedFindings.slice(0, 20).map((item) => `- suppressed [${item.rule}] ${item.path}:${item.line}（kimi-base-ignore 留痕）`),
    ...(paths.length > FITNESS_MAX_FILES || findings.length >= FITNESS_MAX_FINDINGS ? ['- note 扫描/发现数量达上限，结果被截断'] : [])
  ].join('\n');
  return { status, ok: status === 'PASS', scannedFiles: scanned, findings, suppressed: suppressedFindings, skipped: skipped.slice(0, 50), report };
}
