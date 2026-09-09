#!/usr/bin/env node
// ============================================================================
// ui-slop —— AI slop UI 静态检查（独立审计脚本，禁止 import 引擎，REQ-078）
//
// AI 生成界面的 slop 有确定性可检测信号：禁字体（Inter/Roboto 无语义理由）、
// 紫蓝渐变 tell 色族与 Tailwind 坡道类、营销套话文案为 error；硬编码 hex 不经
// token/变量、毛玻璃反射性使用、圆角大阴影卡片全家桶、emoji 当图标为
// warning。规则清单在 ui-slop-rules.json（数据驱动，随设计演进只改数据文件）。
//
// 用法：node .kimi-base/audit/ui-slop.mjs
// 抑制：同行或上一行注释 ui-slop:ignore（留痕，理由写进注释，无全局开关）。
// 退出码：0 干净（允许 warning）/ 1 有 error 命中 / 3 降级（规则文件缺失损坏、
// 非 git 仓——拒绝猜测文件集）；无前端文件 exit 0 但 SKIPPED 显式（放行≠通过）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(HERE, 'ui-slop-rules.json');
const MAX_BYTES = 1024 * 1024;

/** 降级出口：stdout 单行 JSON + stderr 人类摘要，exit 3（SKIPPED 不是 PASS） */
function degraded(reason, detail) {
  process.stderr.write(`ui-slop: ${detail}（exit 3，降级响亮声明——SKIPPED 不是 PASS）\n`);
  process.stdout.write(`${JSON.stringify({ command: 'ui-slop', ok: false, degraded: true, reason, findings: [], counts: { error: 0, warning: 0 } })}\n`);
  process.exit(3);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
} catch (e) {
  degraded('rules-file-unreadable', `规则文件缺失或损坏（${RULES_PATH}）：${e.message}`);
}

const problems = [];
if (!Array.isArray(config.extensions) || config.extensions.length === 0) problems.push('extensions 必须是非空数组');
if (!Array.isArray(config.rules) || config.rules.length === 0) problems.push('rules 必须是非空数组');
const excludeRes = [];
for (const pattern of config.exclude ?? []) {
  try { excludeRes.push(new RegExp(pattern, 'i')); } catch (e) { problems.push(`exclude 正则非法 ${pattern}: ${e.message}`); }
}
const rules = [];
for (const rule of config.rules ?? []) {
  if (!rule.id || !rule.pattern || !rule.message || !['error', 'warning'].includes(rule.severity)) {
    problems.push(`规则条目不完整（需 id/severity∈{error,warning}/pattern/message）：${JSON.stringify(rule)}`);
    continue;
  }
  try {
    rules.push({
      ...rule,
      re: new RegExp(rule.pattern, rule.flags ?? 'i'),
      exemptRe: rule.exempt ? new RegExp(rule.exempt, 'i') : null,
      exemptFilesRe: rule.exemptFiles ? new RegExp(rule.exemptFiles, 'i') : null
    });
  } catch (e) {
    problems.push(`规则 ${rule.id} 正则非法：${e.message}`);
  }
}
if (problems.length > 0) degraded('rules-file-invalid', `规则文件校验失败：${problems.join('；')}`);

const suppression = typeof config.suppression === 'string' && config.suppression ? config.suppression : 'ui-slop:ignore';
const SUPPRESS = new RegExp(suppression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const extensions = new Set(config.extensions.map((ext) => ext.toLowerCase()));

// 扫描面钉根（评审 W2）：子目录下运行时 `git ls-files` 只列子树却报 ok:true 是假绿。
// 用 rev-parse --show-toplevel 钉到仓根，全仓扫描并在输出标注扫描面。
let scanRoot;
try {
  scanRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  degraded('not-a-git-repo', '非 git 仓——拒绝猜测文件集');
}

let all;
try {
  all = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: scanRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
} catch {
  degraded('not-a-git-repo', '非 git 仓——拒绝猜测文件集');
}

const targets = all.filter((file) => {
  const ext = path.extname(file).toLowerCase();
  if (!extensions.has(ext)) return false;
  return !excludeRes.some((re) => re.test(file));
});

if (targets.length === 0) {
  process.stderr.write('ui-slop: SKIPPED——无前端文件（放行 ≠ 全部通过）\n');
  process.stdout.write(`${JSON.stringify({ command: 'ui-slop', ok: true, skipped: true, reason: 'no-frontend-files', scanRoot, scanned: 0, findings: [], counts: { error: 0, warning: 0 } })}\n`);
  process.exit(0);
}

// 安全（评审修复轮 trust）：git ls-files 会列出 symlink，statSync/readFileSync 跟随之——
// 仓内 symlink 指向仓外时"扫描面=仓根"的承诺被打破（命中行摘录还会进 CI 日志）。
// symlink 先 realpath 校验：解析出仓一律跳过并计数留痕；断链走既有 catch 静默跳过口径。
const skippedSymlinks = [];
const findings = [];
for (const file of targets) {
  const absolute = path.join(scanRoot, file);
  let text;
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      const real = fs.realpathSync(absolute);
      const relative = path.relative(scanRoot, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        skippedSymlinks.push(file);
        continue;
      }
    }
    if (fs.statSync(absolute).size > MAX_BYTES) {
      findings.push({ file, line: 0, rule: 'oversized', severity: 'warning', message: '文件大于 1MB，未扫描' });
      continue;
    }
    text = fs.readFileSync(absolute, 'utf8');
  } catch { continue; }
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (SUPPRESS.test(line) || (index > 0 && SUPPRESS.test(lines[index - 1]))) continue;
    for (const rule of rules) {
      if (rule.exemptFilesRe && rule.exemptFilesRe.test(file)) continue;
      if (rule.exemptRe && rule.exemptRe.test(line)) continue;
      if (!rule.re.test(line)) continue;
      findings.push({
        file,
        line: index + 1,
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        excerpt: line.trim().slice(0, 120)
      });
    }
  }
}

for (const finding of findings) {
  process.stderr.write(`${finding.severity === 'error' ? ' ERR  ' : ' warn '}${finding.rule.padEnd(26)}${finding.file}:${finding.line}  ${finding.excerpt ?? finding.message}\n`);
}
const errors = findings.filter((finding) => finding.severity === 'error');
process.stdout.write(`${JSON.stringify({
  command: 'ui-slop',
  ok: errors.length === 0,
  scanRoot,
  scanned: targets.length,
  skippedSymlinks: skippedSymlinks.length,
  findings: findings.slice(0, 100),
  counts: { error: errors.length, warning: findings.length - errors.length }
})}\n`);
process.stderr.write(`ui-slop: 扫描面=仓根 ${scanRoot}；${targets.length} 个前端文件，${errors.length} 个 error，${findings.length - errors.length} 个 warning${skippedSymlinks.length ? `；${skippedSymlinks.length} 个出仓 symlink 已跳过（${skippedSymlinks.join(', ')}）` : ''}\n`);
process.exit(errors.length === 0 ? 0 : 1);
