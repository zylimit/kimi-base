// lib/installer.mjs —— 安装事务（install/upgrade/uninstall）
// 复制面 = 源仓 .kimi-base/{runtime,rules,templates,audit,githooks} + .kimi-base/{adapters.json,state.README} + .kimi-code/（恒等映射）
// + 种子文件（*.example.json → 目标同名配置；templates/AGENTS.md → AGENTS.md）。
// LF 归一化 SHA-256 区分"框架基线 vs 用户定制"；staging + 逐文件备份 +
// post-hash 校验 + 失败逆序 rollback；KIMI_BASE_INSTALL_FAIL_AFTER 故障注入。

import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { HarnessError, TOOL_VERSION, atomicWrite, normalizeLf, nowIso, pathExists, readJsonFile, runProcess, sha256, toPosix, usageError } from './core.mjs';
import { INSTALL_MANIFEST_REL, INSTALL_RECEIPT_REL, STATE_DIR } from './paths.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// 本文件位于 <源仓>/.kimi-base/runtime/lib/installer.mjs；源仓根向上三级。
export const SOURCE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..', '..');
export const SOURCE_MANIFEST = 'FRAMEWORK-MANIFEST.json';

// 受管面（哈希跟踪，升级覆盖/定制写旁路）：源布局 = 安装布局（恒等映射）。
// 注意：.kimi-base/state/ 是运行时产物不入复制面；源仓自身治理配置
//（harness.json/module-catalog.json/verification-matrix.json 非 example 版）永不发布。
export const MANAGED_ENTRIES = [
  '.kimi-base/runtime',
  '.kimi-base/rules',
  '.kimi-base/templates',
  '.kimi-base/audit',
  '.kimi-base/githooks',
  '.kimi-base/adapters.json',
  '.kimi-base/state.README',
  // example 种子源也随载荷发布（受管、恒等映射）：已安装项目重跑 install/upgrade 时
  // 复制面校验需要它们在场（dsh 同款：catalog.example.json 随 .dsh/base/ 分发）。
  '.kimi-base/harness.example.json',
  '.kimi-base/module-catalog.example.json',
  '.kimi-base/verification-matrix.example.json',
  '.kimi-code'
];
// 种子文件：仅 install 且目标缺省时写入；upgrade 永不覆盖；uninstall 仅当哈希仍等于原始种子才删。
export const SEED_ENTRIES = [
  { source: '.kimi-base/harness.example.json', path: '.kimi-base/harness.json' },
  { source: '.kimi-base/module-catalog.example.json', path: '.kimi-base/module-catalog.json' },
  { source: '.kimi-base/verification-matrix.example.json', path: '.kimi-base/verification-matrix.json' },
  { source: '.kimi-base/templates/AGENTS.md', path: 'AGENTS.md' }
];

function normalizedBytes(bytes) {
  if (bytes.includes(0)) return bytes;
  return Buffer.from(normalizeLf(bytes.toString('utf8')), 'utf8');
}

export async function managedFileHash(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) return `symlink:${await realpath(filePath)}`;
    if (!info.isFile()) throw new HarnessError(`受管路径不是普通文件：${filePath}`, 'MANAGED_NOT_FILE');
    return sha256(normalizedBytes(await readFile(filePath)));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 复制面/发布面白名单：排除运行时状态、源仓自身治理配置（仅 *.example.json 种子发布）、
// *.kimi-base-new 旁路、临时与系统文件、私密 feedback（feedback/ 仅保留
// FEEDBACK-INDEX.md 与 templates/）。
export function isStableAsset(relativePath) {
  const value = toPosix(relativePath);
  if (!value || value.includes('../')) return false;
  if (/(?:^|\/)\.kimi-base\/state\//.test(value)) return false;
  if (['.kimi-base/harness.json', '.kimi-base/module-catalog.json', '.kimi-base/verification-matrix.json'].includes(value)) return false;
  if (/\.kimi-base-new(?:-.*)?$/.test(value)) return false;
  if (/(?:\.tmp|\.temp|\.log|\.bak)$/.test(value)) return false;
  if (/(?:^|\/)\.DS_Store$/.test(value) || /(?:^|\/)Thumbs\.db$/.test(value)) return false;
  const feedback = value.match(/(?:^|\/)feedback\/(.+)$/);
  if (feedback) {
    const rest = feedback[1];
    if (rest !== 'FEEDBACK-INDEX.md' && !rest.startsWith('templates/')) return false;
  }
  return true;
}

export async function walkAssetFiles(root, base) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkAssetFiles(absolute, base));
    else if (entry.isFile()) files.push(toPosix(path.relative(base, absolute)));
    else throw new HarnessError(`不支持的脚手架资产（symlink/特殊文件）：${absolute}`, 'ASSET_UNSUPPORTED');
  }
  return files;
}

// 复制面文件全集：{source: 源仓相对路径, path: 目标项目相对路径, seed?}。
// 受管面恒等映射 <源仓>/X → <target>/X；种子文件按 SEED_ENTRIES 改名落地。
async function copySurfaceEntries() {
  const entries = [];
  for (const managed of MANAGED_ENTRIES) {
    const absolute = path.join(SOURCE_ROOT, managed);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new HarnessError(`源仓复制面缺失：${managed}`, 'SOURCE_SURFACE_MISSING');
    if (info.isDirectory()) {
      for (const relative of await walkAssetFiles(absolute, SOURCE_ROOT)) entries.push({ source: relative, path: relative });
    } else {
      entries.push({ source: managed, path: managed });
    }
  }
  for (const seed of SEED_ENTRIES) entries.push({ source: seed.source, path: seed.path, seed: true });
  const seen = new Set();
  const result = [];
  for (const entry of entries.filter((item) => isStableAsset(item.source)).sort((a, b) => a.path.localeCompare(b.path))) {
    if (seen.has(entry.path)) throw new HarnessError(`复制面目标路径冲突：${entry.path}`, 'SURFACE_CONFLICT');
    seen.add(entry.path);
    result.push(entry);
  }
  return result;
}

// install/upgrade 前置：源仓复制面必须完整（ MANAGED_ENTRIES + 种子源文件 ）。
export async function assertInstallSource() {
  for (const entry of [...MANAGED_ENTRIES, ...SEED_ENTRIES.map((seed) => seed.source)]) {
    if (!(await pathExists(path.join(SOURCE_ROOT, entry)))) {
      throw new HarnessError(`源仓复制面缺失：${entry}（${SOURCE_ROOT}）`, 'SOURCE_SURFACE_MISSING');
    }
  }
}

export function manifestDigestOf(files) {
  return sha256(files.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes}\n`).join(''));
}

export async function buildSourceManifest() {
  const files = [];
  for (const entry of await copySurfaceEntries()) {
    const bytes = normalizedBytes(await readFile(path.join(SOURCE_ROOT, entry.source)));
    files.push({ path: entry.path, source: entry.source, sha256: sha256(bytes), bytes: bytes.length, ...(entry.seed ? { seed: true } : {}) });
  }
  return { version: 1, tool: TOOL_VERSION, hashAlgorithm: 'sha256-lf-v1', files, digest: manifestDigestOf(files) };
}

export const manifestTextOf = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// 受管路径落点：词法校验 + 逐段 realpath 防逃逸。
export async function safeManagedPath(target, managedPath) {
  if (typeof managedPath !== 'string' || !managedPath || path.isAbsolute(managedPath)
    || /^[A-Za-z]:[\\/]/.test(managedPath) || /^[/\\]{2}/.test(managedPath) || managedPath.includes('\\')) {
    throw new HarnessError(`不安全的受管路径：${String(managedPath)}`, 'UNSAFE_MANAGED_PATH');
  }
  const segments = managedPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new HarnessError(`不安全的受管路径：${managedPath}`, 'UNSAFE_MANAGED_PATH');
  }
  const root = path.resolve(target);
  const destination = path.resolve(root, ...segments);
  if (!isWithin(root, destination) || destination === root) throw new HarnessError(`受管路径逃逸目标：${managedPath}`, 'UNSAFE_MANAGED_PATH');
  let physicalRoot = root;
  try {
    physicalRoot = await realpath(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let current = root;
  for (const segment of segments) {
    current = path.resolve(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    let physical;
    try {
      physical = await realpath(current);
    } catch (error) {
      if (info.isSymbolicLink()) throw new HarnessError(`受管路径含悬空符号链接：${managedPath}`, 'UNSAFE_MANAGED_PATH');
      throw error;
    }
    if (!isWithin(physicalRoot, physical)) throw new HarnessError(`受管路径解析到目标之外：${managedPath}`, 'UNSAFE_MANAGED_PATH');
  }
  return destination;
}

export async function assertSafeTarget(targetArgument) {
  if (!targetArgument) throw usageError('需要显式目标目录：install|upgrade|uninstall <target>');
  const target = path.resolve(targetArgument);
  if (target === path.parse(target).root) throw new HarnessError('拒绝把文件系统根目录作为目标', 'UNSAFE_TARGET');
  if (target === path.resolve(homedir())) throw new HarnessError('拒绝把用户主目录作为目标', 'UNSAFE_TARGET');
  const source = path.resolve(SOURCE_ROOT);
  // 只有"脚手架源仓"才禁止自我安装：源仓根带 kimi.plugin.json；已安装项目
  // 用自带的引擎重跑 install/upgrade（含 install . --hooks 挂载第二道闸）必须允许。
  const sourceIsScaffold = await pathExists(path.join(source, 'kimi.plugin.json'));
  if (sourceIsScaffold && (target === source || isWithin(source, target) || isWithin(target, source))) {
    throw new HarnessError('拒绝把脚手架源仓本身（或其上下级）作为安装目标', 'UNSAFE_TARGET');
  }
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new HarnessError('目标已存在但不是目录', 'UNSAFE_TARGET');
    const [physicalTarget, physicalSource] = await Promise.all([realpath(target), realpath(source)]);
    if (sourceIsScaffold && (physicalTarget === physicalSource || isWithin(physicalSource, physicalTarget) || isWithin(physicalTarget, physicalSource))) {
      throw new HarnessError('目标经符号链接解析到源仓内部/外部环绕，拒绝', 'UNSAFE_TARGET');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

export function validateManifestShape(value, label) {
  if (!value || value.version !== 1 || value.hashAlgorithm !== 'sha256-lf-v1'
    || !Array.isArray(value.files) || typeof value.digest !== 'string') {
    throw new HarnessError(`${label} 必填字段非法`, 'MANIFEST_INVALID');
  }
  const seen = new Set();
  for (const entry of value.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
      || !Number.isInteger(entry.bytes) || entry.bytes < 0 || seen.has(entry.path)) {
      throw new HarnessError(`${label} 含非法文件条目：${entry?.path ?? '<未知>'}`, 'MANIFEST_INVALID');
    }
    seen.add(entry.path);
  }
  if (!/^[a-f0-9]{64}$/.test(value.digest) || value.digest !== manifestDigestOf(value.files)) {
    throw new HarnessError(`${label} 摘要不匹配`, 'MANIFEST_INVALID');
  }
  return value;
}

export async function readInstalledManifest(target) {
  const manifestPath = await safeManagedPath(target, INSTALL_MANIFEST_REL);
  const value = await readJsonFile(manifestPath, { required: false });
  return value ? validateManifestShape(value, '已安装 manifest') : null;
}

async function conflictSidecarPath(target, relativePath, sourceHash) {
  const preferredRelative = `${relativePath}.kimi-base-new`;
  const preferred = await safeManagedPath(target, preferredRelative);
  const preferredHash = await managedFileHash(preferred);
  if (preferredHash === null || preferredHash === sourceHash) return { relative: preferredRelative, absolute: preferred };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let index = 0; index < 10000; index += 1) {
    const suffix = index ? `-${index}` : '';
    const relative = `${preferredRelative}-${sourceHash.slice(0, 12)}-${stamp}${suffix}`;
    const absolute = await safeManagedPath(target, relative);
    if (await managedFileHash(absolute) === null) return { relative, absolute };
  }
  throw new HarnessError(`无法为 ${relativePath} 分配冲突旁路文件名`, 'SIDECAR_ALLOC_FAILED');
}

async function copyNormalizedAtomic(source, destination) {
  const info = await stat(source);
  await atomicWrite(destination, normalizedBytes(await readFile(source)), info.mode);
}

async function backupFileInto(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return (await stat(source)).mode;
}

async function safeRemoveTree(target, candidate, requiredNamePrefix) {
  const root = path.resolve(target);
  const resolved = path.resolve(candidate);
  if (!isWithin(root, resolved) || resolved === root || !path.basename(resolved).startsWith(requiredNamePrefix)) {
    throw new HarnessError(`拒绝不安全的递归清理：${resolved}`, 'UNSAFE_CLEANUP');
  }
  await rm(resolved, { recursive: true, force: true });
}

// 安装计划：未定制→安全升级；已定制→保留并写旁路；obsolete 仅未定制才删。
// sourceManifest.files 条目：{path: 目标相对路径, source: 源仓相对路径, sha256, bytes, seed?}。
// 种子（seed）：仅 install 且目标缺省时写入；upgrade 永不覆盖；uninstall 走通用哈希比对
//（哈希仍等于原始种子才删，用户改过的一律保留）。
export async function planInstall(target, sourceManifest, action) {
  const oldManifest = await readInstalledManifest(target);
  const oldByPath = new Map((oldManifest?.files ?? []).map((entry) => [entry.path, entry]));
  const sourcePaths = new Set(sourceManifest.files.map((entry) => entry.path));
  const operations = [];
  for (const entry of sourceManifest.files) {
    const destination = await safeManagedPath(target, entry.path);
    const current = await managedFileHash(destination);
    if (entry.seed) {
      if (action === 'install' && current === null) {
        operations.push({ kind: 'create', path: entry.path, source: entry.source, expectedHash: entry.sha256 });
      } else {
        operations.push({ kind: 'unchanged', path: entry.path });
      }
      continue;
    }
    if (current === entry.sha256) {
      operations.push({ kind: 'unchanged', path: entry.path });
      continue;
    }
    if (current === null) {
      operations.push({ kind: 'create', path: entry.path, source: entry.source, expectedHash: entry.sha256 });
      continue;
    }
    if (oldByPath.get(entry.path)?.sha256 === current) {
      operations.push({ kind: 'update', path: entry.path, source: entry.source, expectedHash: entry.sha256 });
      continue;
    }
    // 用户已定制：保留原文件，写 *.kimi-base-new 旁路。
    const sidecar = await conflictSidecarPath(target, entry.path, entry.sha256);
    operations.push({ kind: 'preserve', path: sidecar.relative, source: entry.source, originalPath: entry.path, expectedHash: entry.sha256 });
  }
  if (action === 'upgrade' && oldManifest) {
    for (const oldEntry of oldManifest.files) {
      if (sourcePaths.has(oldEntry.path)) continue;
      const destination = await safeManagedPath(target, oldEntry.path);
      const current = await managedFileHash(destination);
      if (current === null) continue;
      if (current === oldEntry.sha256) operations.push({ kind: 'remove-obsolete', path: oldEntry.path });
      else operations.push({ kind: 'preserve-obsolete', path: oldEntry.path });
    }
  }
  // 安装清单（确定性内容，不含时间戳——幂等性的前提）。
  const installedManifest = {
    version: 1,
    tool: TOOL_VERSION,
    hashAlgorithm: 'sha256-lf-v1',
    files: sourceManifest.files.map(({ path: itemPath, sha256: itemHash, bytes }) => ({ path: itemPath, sha256: itemHash, bytes })),
    digest: sourceManifest.digest
  };
  const manifestContent = manifestTextOf(installedManifest);
  const manifestOp = {
    kind: 'install-manifest',
    path: INSTALL_MANIFEST_REL,
    content: manifestContent,
    expectedHash: sha256(normalizedBytes(Buffer.from(manifestContent, 'utf8')))
  };
  // state 目录 .gitignore：运行时状态永不进 git。
  const gitignoreContent = '*\n!.gitignore\n';
  const gitignoreOp = {
    kind: 'state-gitignore',
    path: `${STATE_DIR}/.gitignore`,
    content: gitignoreContent,
    expectedHash: sha256(normalizedBytes(Buffer.from(gitignoreContent, 'utf8')))
  };
  for (const op of [manifestOp, gitignoreOp]) {
    const current = await managedFileHash(await safeManagedPath(target, op.path));
    operations.push(current === op.expectedHash ? { kind: 'unchanged', path: op.path } : op);
  }
  return { action, target, oldManifest, sourceManifest, operations };
}

const MUTATION_KINDS = new Set(['create', 'update', 'preserve', 'remove-obsolete', 'install-manifest', 'state-gitignore']);

// 回滚后清理空目录（故障注入测试要求完整回滚后无残留）。
async function cleanupEmptyDirs(target, appliedDestinations) {
  const dirs = new Set();
  for (const destination of appliedDestinations) {
    let cursor = path.dirname(destination);
    while (isWithin(target, cursor) && cursor !== target) {
      dirs.add(cursor);
      cursor = path.dirname(cursor);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
  }
}

export async function applyInstallPlan(plan, dryRun) {
  if (dryRun) return { ok: true, dryRun: true, action: plan.action, target: plan.target, operations: plan.operations };
  await mkdir(plan.target, { recursive: true });
  const installId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const staging = await safeManagedPath(plan.target, `${STATE_DIR}/install-staging-${installId}`);
  await mkdir(staging, { recursive: true });
  const applied = [];
  const rollbackErrors = [];
  const postVerify = [];
  const failAfter = Number.parseInt(process.env.KIMI_BASE_INSTALL_FAIL_AFTER ?? '0', 10);
  let mutationCount = 0;
  const startedAt = nowIso();
  try {
    for (const [index, operation] of plan.operations.entries()) {
      if (!MUTATION_KINDS.has(operation.kind)) continue;
      const destination = await safeManagedPath(plan.target, operation.path);
      const previousHash = await managedFileHash(destination);
      let backup = null;
      let previousMode = null;
      if (previousHash !== null) {
        backup = path.join(staging, 'backup', String(index));
        previousMode = await backupFileInto(destination, backup);
      }
      applied.push({ destination, backup, previousMode });
      if (operation.kind === 'remove-obsolete') await rm(destination, { force: true });
      else if (operation.kind === 'install-manifest' || operation.kind === 'state-gitignore') await atomicWrite(destination, operation.content);
      else await copyNormalizedAtomic(path.join(SOURCE_ROOT, operation.source), destination);
      mutationCount += 1;
      if (Number.isFinite(failAfter) && failAfter > 0 && mutationCount >= failAfter) {
        throw new HarnessError(`故障注入：KIMI_BASE_INSTALL_FAIL_AFTER=${failAfter} 触发`, 'INSTALL_FAULT_INJECTED');
      }
    }
    for (const operation of plan.operations.filter((item) => MUTATION_KINDS.has(item.kind))) {
      const actual = await managedFileHash(await safeManagedPath(plan.target, operation.path));
      const ok = operation.kind === 'remove-obsolete' ? actual === null : actual === operation.expectedHash;
      postVerify.push({ kind: operation.kind, path: operation.path, ok });
      if (!ok) throw new HarnessError(`安装后哈希校验失败：${operation.path}`, 'INSTALL_POST_VERIFY_FAILED');
    }
    // 回执每次都重写（state 簿记属正常变化；受管资产不变才是幂等语义）。
    const receipt = {
      version: 1,
      installId,
      action: plan.action,
      status: 'committed',
      target: plan.target,
      sourceDigest: plan.sourceManifest.digest,
      startedAt,
      completedAt: nowIso(),
      operations: plan.operations.map(({ kind, path: itemPath, originalPath }) => ({ kind, path: itemPath, ...(originalPath ? { originalPath } : {}) })),
      postVerify
    };
    await atomicWrite(await safeManagedPath(plan.target, INSTALL_RECEIPT_REL), receipt);
    await safeRemoveTree(plan.target, staging, 'install-staging-');
    return { ok: true, dryRun: false, ...receipt };
  } catch (error) {
    for (const item of [...applied].reverse()) {
      try {
        if (item.backup) await atomicWrite(item.destination, await readFile(item.backup), item.previousMode);
        else await rm(item.destination, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${item.destination}: ${rollbackError.message}`);
      }
    }
    if (!rollbackErrors.length) {
      await safeRemoveTree(plan.target, staging, 'install-staging-').catch(() => {});
      await cleanupEmptyDirs(plan.target, applied.map((item) => item.destination)).catch(() => {});
    }
    // 失败回执总是落盘：它是安装事故的唯一审计痕迹。
    const receipt = {
      version: 1, installId, action: plan.action,
      status: rollbackErrors.length ? 'rollback-incomplete' : 'rolled-back',
      target: plan.target, sourceDigest: plan.sourceManifest.digest,
      startedAt, completedAt: nowIso(), error: error.message, rollbackErrors
    };
    await atomicWrite(await safeManagedPath(plan.target, INSTALL_RECEIPT_REL), receipt).catch(() => {});
    throw new HarnessError(`${error.message}；${rollbackErrors.length ? `回滚不完整：${rollbackErrors.join(' | ')}` : '全部受管变更已逆序回滚'}`, 'INSTALL_ROLLED_BACK');
  }
}

export async function planUninstall(target) {
  const manifest = await readInstalledManifest(target);
  if (!manifest) throw new HarnessError(`未找到安装清单 ${INSTALL_MANIFEST_REL}；该目标不是 kimi-base 安装`, 'NOT_INSTALLED');
  const operations = [];
  for (const entry of manifest.files) {
    const current = await managedFileHash(await safeManagedPath(target, entry.path));
    if (current === null) continue;
    operations.push({ kind: current === entry.sha256 ? 'remove' : 'preserve-modified', path: entry.path });
  }
  operations.push({ kind: 'remove', path: INSTALL_MANIFEST_REL });
  return { action: 'uninstall', target, manifest, operations };
}

export async function applyUninstallPlan(plan, dryRun) {
  if (dryRun) return { ok: true, dryRun: true, action: 'uninstall', target: plan.target, operations: plan.operations };
  const installId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const staging = await safeManagedPath(plan.target, `${STATE_DIR}/install-staging-${installId}`);
  await mkdir(staging, { recursive: true });
  const applied = [];
  try {
    for (const [index, operation] of plan.operations.entries()) {
      if (operation.kind !== 'remove') continue;
      const destination = await safeManagedPath(plan.target, operation.path);
      if (await managedFileHash(destination) === null) continue;
      const backup = path.join(staging, 'backup', String(index));
      const previousMode = await backupFileInto(destination, backup);
      applied.push({ destination, backup, previousMode });
      await rm(destination, { force: true });
    }
    for (const operation of plan.operations.filter((item) => item.kind === 'remove')) {
      if (await managedFileHash(await safeManagedPath(plan.target, operation.path)) !== null) {
        throw new HarnessError(`卸载校验失败：${operation.path} 仍存在`, 'UNINSTALL_VERIFY_FAILED');
      }
    }
    await safeRemoveTree(plan.target, staging, 'install-staging-');
    // 清理空受管目录。
    const directories = new Set();
    for (const operation of plan.operations.filter((item) => item.kind === 'remove')) {
      let directory = path.posix.dirname(operation.path);
      while (directory && directory !== '.') {
        directories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
    for (const relative of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      try {
        await rmdir(await safeManagedPath(plan.target, relative));
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
    return { ok: true, dryRun: false, action: 'uninstall', target: plan.target, operations: plan.operations };
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...applied].reverse()) {
      try {
        await atomicWrite(item.destination, await readFile(item.backup), item.previousMode);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.destination}: ${rollbackError.message}`);
      }
    }
    if (!rollbackErrors.length) await safeRemoveTree(plan.target, staging, 'install-staging-').catch(() => {});
    throw new HarnessError(`${error.message}；${rollbackErrors.length ? `回滚不完整：${rollbackErrors.join(' | ')}` : '全部删除已逆序回滚'}`, 'UNINSTALL_ROLLED_BACK');
  }
}

// ---------- git hooks 挂载（install/upgrade --hooks） ----------

export const HOOKS_PATH = '.kimi-base/githooks';
export const HOOK_FILES = ['pre-commit', 'pre-push', 'commit-msg'];

// 把第二道闸挂上目标的 git：core.hooksPath 指向复制面 + 三钩子 chmod 755 +
// git add --chmod=+x（让可执行位进 index，跨平台存活）。
// 目标是"显式请求的增强"而非安装前置：非 git 仓/无 git → 响亮降级（mounted:false
// + reason），绝不让 install 主事务因此回滚。
export async function mountGitHooks(target) {
  const git = (args) => runProcess('git', ['-C', target, ...args], { timeoutMs: 15000 });
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 'PASS' || inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return { mounted: false, reason: '目标不是 git 仓（或 git 不可用）' };
  }
  const configured = await git(['config', 'core.hooksPath', HOOKS_PATH]);
  if (configured.status !== 'PASS' || configured.exitCode !== 0) {
    return { mounted: false, reason: `git config core.hooksPath 失败：${configured.stderr.trim() || configured.error?.message}` };
  }
  for (const hook of HOOK_FILES) {
    // Windows 上 chmod 基本无操作，可执行位靠下面的 git add --chmod=+x 进 index。
    await chmod(path.join(target, HOOKS_PATH, hook), 0o755).catch(() => {});
  }
  const stagedAdd = await git(['add', '--chmod=+x', ...HOOK_FILES.map((hook) => `${HOOKS_PATH}/${hook}`)]);
  return {
    mounted: true,
    hooksPath: HOOKS_PATH,
    executableStaged: stagedAdd.status === 'PASS' && stagedAdd.exitCode === 0
  };
}
