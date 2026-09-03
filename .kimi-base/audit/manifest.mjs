#!/usr/bin/env node
// ============================================================================
// manifest --check —— FRAMEWORK-MANIFEST.json 独立校验（禁止 import 引擎）
//
// 复制面完整性审计：对每个受管资产重算 LF 归一化 SHA-256，与仓根
// FRAMEWORK-MANIFEST.json 对账；漂移/新增/缺失 → exit 1 并点名。
// 与引擎 lib/installer.mjs 是刻意重复的两份实现：审计者与被审计者独立，
// 引擎内部缺陷无法让本检查沉默。
//
// 用法：node .kimi-base/audit/manifest.mjs [--check]（默认即 --check）
// ============================================================================

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

// 受管面（恒等映射目录 + 单文件）与种子（源文件 → 目标名）。与 installer 的定义
// 逐字对齐是职责而不是 Bug：两边必须独立演化时发现对方漂移。
const MANAGED_DIRS = ['.kimi-base/runtime', '.kimi-base/rules', '.kimi-base/templates', '.kimi-base/audit', '.kimi-base/githooks', '.kimi-code'];
const MANAGED_FILES = ['.kimi-base/adapters.json', '.kimi-base/state.README', '.kimi-base/harness.example.json', '.kimi-base/module-catalog.example.json', '.kimi-base/verification-matrix.example.json'];
const SEEDS = [
  ['.kimi-base/harness.example.json', '.kimi-base/harness.json'],
  ['.kimi-base/module-catalog.example.json', '.kimi-base/module-catalog.json'],
  ['.kimi-base/verification-matrix.example.json', '.kimi-base/verification-matrix.json'],
  ['.kimi-base/templates/AGENTS.md', 'AGENTS.md']
];
const MANIFEST = 'FRAMEWORK-MANIFEST.json';

// 发布面白名单（与 installer.isStableAsset 同语义的独立实现）。
function isStableAsset(rel) {
  const value = rel.split(path.sep).join('/');
  if (!value || value.includes('../')) return false;
  if (/(?:^|\/)\.kimi-base\/state\//.test(value)) return false;
  if (['.kimi-base/harness.json', '.kimi-base/module-catalog.json', '.kimi-base/verification-matrix.json'].includes(value)) return false;
  if (/\.kimi-base-new(?:-.*)?$/.test(value)) return false;
  if (/(?:\.tmp|\.temp|\.log|\.bak)$/.test(value)) return false;
  if (/(?:^|\/)\.DS_Store$/.test(value) || /(?:^|\/)Thumbs\.db$/.test(value)) return false;
  const feedback = value.match(/(?:^|\/)feedback\/(.+)$/);
  if (feedback && feedback[1] !== 'FEEDBACK-INDEX.md' && !feedback[1].startsWith('templates/')) return false;
  return true;
}

function sha256Lf(buffer) {
  if (buffer.includes(0)) return { sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
  const normalized = Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  return { sha256: crypto.createHash('sha256').update(normalized).digest('hex'), bytes: normalized.length };
}

function walk(absolute, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) walk(child, base, out);
    else if (entry.isFile()) out.push(path.relative(base, child).split(path.sep).join('/'));
    else out.push(`${path.relative(base, child).split(path.sep).join('/')}<unsupported-asset>`);
  }
}

const arg = process.argv[2];
if (arg !== undefined && arg !== '--check') {
  process.stderr.write(`manifest: 未知参数 ${arg}（只支持 --check）\n`);
  process.exit(1);
}

// 现算复制面。
const present = [...MANAGED_DIRS, ...MANAGED_FILES, ...SEEDS.map(([source]) => source)].filter((rel) => fs.existsSync(rel));
if (present.length === 0) {
  process.stderr.write('manifest: 当前目录没有任何 kimi-base 复制面（exit 3——这里不是源仓，SKIPPED 不是 PASS）\n');
  process.exit(3);
}
const sources = [];
for (const dir of MANAGED_DIRS) walk(dir, '.', sources);
sources.push(...MANAGED_FILES.filter((rel) => fs.existsSync(rel)));
const entries = [];
const problems = [];
for (const source of sources.filter(isStableAsset)) {
  if (source.endsWith('<unsupported-asset>')) {
    problems.push({ kind: 'unsupported-asset', path: source });
    continue;
  }
  entries.push({ path: source, ...sha256Lf(fs.readFileSync(source)) });
}
for (const [source, target] of SEEDS) {
  if (!fs.existsSync(source)) continue;
  entries.push({ path: target, ...sha256Lf(fs.readFileSync(source)) });
}
entries.sort((a, b) => a.path.localeCompare(b.path));
const digest = crypto.createHash('sha256').update(entries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes}\n`).join('')).digest('hex');

if (!fs.existsSync(MANIFEST)) {
  process.stderr.write(`manifest: ${MANIFEST} 不存在——先跑 node .kimi-base/runtime/kimi-base.mjs manifest --write 建基线\n`);
  process.stdout.write(`${JSON.stringify({ command: 'manifest', ok: false, reason: 'manifest-absent' })}\n`);
  process.exit(1);
}

let recorded;
try {
  recorded = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (error) {
  process.stderr.write(`manifest: ${MANIFEST} 无法解析：${error.message}\n`);
  process.exit(1);
}
const recordedMap = new Map((recorded.files ?? []).map((entry) => [entry.path, entry]));
const currentMap = new Map(entries.map((entry) => [entry.path, entry]));
const changed = [];
const added = [];
const removed = [];
for (const [file, entry] of currentMap) {
  if (!recordedMap.has(file)) added.push(file);
  else if (recordedMap.get(file).sha256 !== entry.sha256) changed.push(file);
}
for (const file of recordedMap.keys()) {
  if (!currentMap.has(file)) removed.push(file);
}
if (typeof recorded.digest === 'string' && recorded.digest !== digest) {
  // digest 不一致而逐文件一致 = 清单本身被拼接篡改，单独点名。
  if (!changed.length && !added.length && !removed.length) problems.push({ kind: 'digest-mismatch', path: MANIFEST });
}

const ok = changed.length === 0 && added.length === 0 && removed.length === 0 && problems.length === 0;
for (const file of changed) process.stderr.write(`DRIFT    ${file}\n`);
for (const file of added) process.stderr.write(`ADDED    ${file}\n`);
for (const file of removed) process.stderr.write(`REMOVED  ${file}\n`);
for (const problem of problems) process.stderr.write(`PROBLEM  ${problem.kind}  ${problem.path}\n`);
if (!ok) process.stderr.write('manifest: 复制面与基线不一致——人工核对后跑 node .kimi-base/runtime/kimi-base.mjs manifest --write 重基线\n');
process.stdout.write(`${JSON.stringify({ command: 'manifest', ok, files: entries.length, changed, added, removed, problems, digest })}\n`);
process.stderr.write(`manifest: 现算 ${entries.length} 个文件，digest ${digest.slice(0, 12)}，${ok ? '与基线一致' : '存在漂移'}\n`);
process.exit(ok ? 0 : 1);
