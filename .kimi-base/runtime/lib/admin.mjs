// lib/admin.mjs —— manifest / doctor / pack-check

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadCatalog } from './catalog.mjs';
import { findProjectRoot, loadContext } from './config.mjs';
import { HarnessError, TOOL_VERSION, atomicWrite, pathExists, readJsonFile, runProcess, sha256, toPosix, usageError } from './core.mjs';
import { FITNESS_MAX_BYTES } from './fitness.mjs';
import { MANAGED_ENTRIES, SEED_ENTRIES, SOURCE_MANIFEST, SOURCE_ROOT, buildSourceManifest, isStableAsset, managedFileHash, manifestDigestOf, manifestTextOf, readInstalledManifest, safeManagedPath, validateManifestShape, walkAssetFiles } from './installer.mjs';
import { loadMatrix } from './matrix.mjs';
import { CONFIG_REL, INSTALL_MANIFEST_REL, STATE_DIR } from './paths.mjs';

// ---------- manifest / doctor / pack-check ----------

// 源仓模式：复制面 = .kimi-base/ 与 .kimi-code/（见 installer MANAGED_ENTRIES/SEED_ENTRIES），manifest 落在源仓根。
async function manifestSource(mode) {
  const generated = await buildSourceManifest();
  const manifestPath = path.join(SOURCE_ROOT, SOURCE_MANIFEST);
  if (mode === 'write') {
    await atomicWrite(manifestPath, manifestTextOf(generated));
    return { ok: true, mode, scope: 'source', files: generated.files.length, digest: generated.digest, path: SOURCE_MANIFEST };
  }
  const existing = validateManifestShape(await readJsonFile(manifestPath), '源 manifest');
  const ok = manifestTextOf(existing) === manifestTextOf(generated);
  return {
    ok,
    mode: 'check',
    scope: 'source',
    files: generated.files.length,
    digest: generated.digest,
    errors: ok ? [] : ['FRAMEWORK-MANIFEST.json 已漂移；请运行 manifest --write 重新生成']
  };
}

// 已安装项目模式：清单面 = install-manifest 记录的受管文件，对当前内容重哈希。
async function manifestInstalled(mode, projectRoot) {
  const root = await realpath(projectRoot);
  const installed = await readInstalledManifest(root);
  if (!installed) throw new HarnessError(`未找到 ${INSTALL_MANIFEST_REL}；该项目未经 kimi-base install`, 'NOT_INSTALLED');
  const files = [];
  for (const entry of installed.files) {
    const absolute = await safeManagedPath(root, entry.path);
    const current = await managedFileHash(absolute);
    files.push({ path: entry.path, sha256: current ?? 'missing', bytes: entry.bytes });
  }
  const generated = { version: 1, tool: TOOL_VERSION, hashAlgorithm: 'sha256-lf-v1', files, digest: manifestDigestOf(files) };
  const manifestPath = path.join(root, SOURCE_MANIFEST);
  if (mode === 'write') {
    await atomicWrite(manifestPath, manifestTextOf(generated));
    return { ok: true, mode, scope: 'installed', files: files.length, digest: generated.digest, path: SOURCE_MANIFEST };
  }
  const existing = await readJsonFile(manifestPath, { required: false });
  if (!existing) {
    return { ok: false, mode: 'check', scope: 'installed', files: files.length, digest: generated.digest, errors: ['FRAMEWORK-MANIFEST.json 不存在；请先 manifest --write 建立基线'] };
  }
  const ok = manifestTextOf(existing) === manifestTextOf(generated);
  const drifted = ok ? [] : existing.files
    .map((entry, index) => (generated.files[index] && generated.files[index].sha256 !== entry.sha256 ? entry.path : null))
    .filter(Boolean);
  return {
    ok,
    mode: 'check',
    scope: 'installed',
    files: files.length,
    digest: generated.digest,
    errors: ok ? [] : [`FRAMEWORK-MANIFEST.json 已漂移（漂移/缺失文件：${drifted.slice(0, 20).join(', ') || '见详情'}）；请人工核对后 manifest --write 重基线`]
  };
}

export async function manifestCommand(mode, projectRoot) {
  if (projectRoot) return manifestInstalled(mode, projectRoot);
  return manifestSource(mode);
}

// agents/skills frontmatter 形状校验：name kebab-case、description ≤180。
export function parseFrontmatter(text) {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) return null;
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.+?)\s*$/);
    return field ? [field[1], field[2].replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')] : null;
  }).filter(Boolean));
}

async function validateAgentsSkills(root, errors, warnings) {
  const agentsDir = path.join(root, '.kimi-code', 'agents');
  let agentFiles = [];
  try {
    agentFiles = (await readdir(agentsDir)).filter((name) => name.endsWith('.md')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const file of agentFiles) {
    const meta = parseFrontmatter(await readFile(path.join(agentsDir, file), 'utf8'));
    if (!meta) {
      errors.push(`agents/${file}：缺 frontmatter`);
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(meta.name ?? '')) errors.push(`agents/${file}：name 非 kebab-case：${meta.name ?? '缺失'}`);
    if (meta.name !== file.replace(/\.md$/, '')) warnings.push(`agents/${file}：name(${meta.name}) 与文件名不一致`);
    if (!meta.description) errors.push(`agents/${file}：缺 description`);
    else if ([...meta.description].length > 180) errors.push(`agents/${file}：description 超过 180 字符`);
  }
  const skillsDir = path.join(root, '.kimi-code', 'skills');
  let skillDirs = [];
  try {
    skillDirs = (await readdir(skillsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const dir of skillDirs) {
    const file = path.join(skillsDir, dir, 'SKILL.md');
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') errors.push(`skills/${dir}：缺 SKILL.md`);
      else throw error;
      continue;
    }
    const meta = parseFrontmatter(text);
    if (!meta) {
      errors.push(`skills/${dir}/SKILL.md：缺 frontmatter`);
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(meta.name ?? '')) errors.push(`skills/${dir}：name 非 kebab-case：${meta.name ?? '缺失'}`);
    if (meta.name !== dir) errors.push(`skills/${dir}：frontmatter name(${meta.name}) 必须等于目录名`);
    if (!meta.description) errors.push(`skills/${dir}：缺 description`);
    else if ([...meta.description].length > 180) errors.push(`skills/${dir}：description 超过 180 字符`);
  }
  return { agents: agentFiles.length, skills: skillDirs.length };
}

async function doctorInstalled(ctx) {
  const errors = [];
  const warnings = [];
  // 1. 配置可解析且通过严格校验（loadContext 已做）；目录文件再点名确认。
  for (const [label, filePath] of [['harness.json', ctx.configPath], ['module-catalog.json', ctx.catalogPath], ['verification-matrix.json', ctx.matrixPath]]) {
    if (!(await pathExists(filePath))) errors.push(`必需文件缺失：${label}（${toPosix(path.relative(ctx.root, filePath))}）`);
  }
  await loadCatalog(ctx).then(() => {}).catch((error) => errors.push(`module-catalog 校验失败：${error.message}`));
  await loadMatrix(ctx).then(() => {}).catch((error) => errors.push(`verification-matrix 校验失败：${error.message}`));
  if (await pathExists(ctx.adaptersPath)) {
    await readJsonFile(ctx.adaptersPath).then(() => {}).catch((error) => errors.push(`adapters.json 无法解析：${error.message}`));
  }
  // 2. 安装完整性：manifest 哈希比对（缺失=error；哈希不同=用户定制 warning）。
  const installed = await readInstalledManifest(ctx.root);
  if (!installed) {
    warnings.push(`无 ${INSTALL_MANIFEST_REL}：未经 install 安装或清单被删`);
  } else {
    let customized = 0;
    for (const entry of installed.files) {
      const current = await managedFileHash(await safeManagedPath(ctx.root, entry.path));
      if (current === null) errors.push(`安装文件缺失：${entry.path}`);
      else if (current !== entry.sha256) {
        customized += 1;
        warnings.push(`用户定制（与框架基线不同）：${entry.path}`);
      }
    }
    if (customized) warnings.push(`共 ${customized} 个文件被用户定制；upgrade 时将为新版本写 *.kimi-base-new 旁路`);
  }
  // 3. agents/skills frontmatter 形状。
  const counts = await validateAgentsSkills(ctx.root, errors, warnings);
  // 4. rules 指针：harness.json rules 数组 + AGENTS.md 中引用的 .kimi-base/rules/*.md。
  for (const rule of ctx.rules) {
    if (!(await pathExists(path.join(ctx.root, rule)))) errors.push(`rules 指针文件缺失：${rule}`);
  }
  const agentsMd = path.join(ctx.root, 'AGENTS.md');
  if (await pathExists(agentsMd)) {
    const text = await readFile(agentsMd, 'utf8');
    for (const match of text.matchAll(/\.kimi-base\/rules\/[\w.-]+\.md/g)) {
      if (!(await pathExists(path.join(ctx.root, match[0])))) errors.push(`AGENTS.md 引用的 rules 文件缺失：${match[0]}`);
    }
  }
  // 5. state 目录 .gitignore。
  if (await pathExists(ctx.stateDir)) {
    const ignore = path.join(ctx.stateDir, '.gitignore');
    if (!(await pathExists(ignore))) warnings.push(`${STATE_DIR}/ 缺 .gitignore（运行时状态可能误入 git）`);
  }
  // 6. 第二道闸挂载状态：git 仓内 core.hooksPath 应指向 .kimi-base/githooks（只警告不失败）。
  const insideGit = await runProcess('git', ['-C', ctx.root, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 15000 });
  if (insideGit.status === 'PASS' && insideGit.exitCode === 0 && insideGit.stdout.trim() === 'true') {
    const hooksPath = await runProcess('git', ['-C', ctx.root, 'config', '--get', 'core.hooksPath'], { timeoutMs: 15000 });
    const value = hooksPath.exitCode === 0 ? hooksPath.stdout.trim() : '';
    if (value !== '.kimi-base/githooks') {
      warnings.push(`第二道闸未挂载：core.hooksPath=${value || '<未设置>'}（应为 .kimi-base/githooks）；挂载：node .kimi-base/runtime/kimi-base.mjs install . --hooks`);
    }
  }
  return { errors, warnings, counts };
}

async function doctorSource() {
  const errors = [];
  const warnings = [];
  // 源仓 = 含 kimi.plugin.json + .kimi-base/runtime + .kimi-code 的仓库（插件与引擎同源）。
  for (const entry of ['kimi.plugin.json', '.kimi-base/runtime', '.kimi-code']) {
    if (!(await pathExists(path.join(SOURCE_ROOT, entry)))) errors.push(`源仓缺 ${entry}`);
  }
  const manifest = await manifestCommand('check').catch((error) => ({ ok: false, errors: [error.message] }));
  if (!manifest.ok) errors.push(...(manifest.errors ?? ['manifest 校验失败']));
  // 源仓种子配置与 frontmatter 直接校验。
  for (const name of ['harness.example.json', 'module-catalog.example.json', 'verification-matrix.example.json']) {
    const filePath = path.join(SOURCE_ROOT, '.kimi-base', name);
    if (!(await pathExists(filePath))) {
      warnings.push(`.kimi-base/${name} 缺失（种子尚未就位）`);
      continue;
    }
    await readJsonFile(filePath).then(() => {}).catch((error) => errors.push(`.kimi-base/${name} 无法解析：${error.message}`));
  }
  await validateAgentsSkills(SOURCE_ROOT, errors, warnings);
  return { errors, warnings, manifest };
}

// 源仓判定：插件清单 + 引擎 + agents/skills 三件套（kimi.plugin.json 不随安装分发，
// 故已安装项目永不误判为源仓）。源仓自托管时（根上同时有 harness.json）源仓优先。
export async function isSourceRepo(dir) {
  return await pathExists(path.join(dir, 'kimi.plugin.json'))
    && await pathExists(path.join(dir, '.kimi-base', 'runtime'))
    && await pathExists(path.join(dir, '.kimi-code'));
}

export async function doctorCommand(targetArgument) {
  const target = targetArgument ? path.resolve(targetArgument) : await findProjectRoot(process.cwd());
  if (!target) throw usageError('doctor 需要目标目录（含 .kimi-base/harness.json 的项目根，或 kimi-base 源仓）');
  const isSource = await isSourceRepo(target);
  const isInstalled = !isSource && await pathExists(path.join(target, CONFIG_REL));
  if (!isInstalled && !isSource) {
    throw usageError(`doctor 目标既不是 kimi-base 安装（无 ${CONFIG_REL}）也不是源仓（无 kimi.plugin.json+.kimi-base/runtime+.kimi-code）：${target}`);
  }
  if (isSource) {
    const { errors, warnings } = await doctorSource();
    return { mode: 'source', target, ok: errors.length === 0, errors, warnings };
  }
  const ctx = await loadContext(target);
  const { errors, warnings, counts } = await doctorInstalled(ctx);
  return { mode: 'installed', target: ctx.root, ok: errors.length === 0, errors, warnings, counts };
}

// pack-check：发布面审计——无 state/、无私密 feedback、无 .kimi-base-new、manifest 完整、无泄漏。
export async function packCheckCommand() {
  const errors = [];
  const manifest = await manifestSource('check').catch((error) => ({ ok: false, errors: [error.message] }));
  if (!manifest.ok) errors.push(...(manifest.errors ?? ['manifest 校验失败']));
  // 发布面 = package.json files 清单（缺省退化为安装复制面：受管面 + 种子源文件）。
  let surface = [];
  const pkg = await readJsonFile(path.join(SOURCE_ROOT, 'package.json'), { required: false });
  if (pkg?.files && Array.isArray(pkg.files)) {
    for (const entry of pkg.files) {
      const absolute = path.join(SOURCE_ROOT, entry);
      const info = await stat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) surface.push(...await walkAssetFiles(absolute, SOURCE_ROOT));
      else surface.push(toPosix(entry));
    }
  } else {
    for (const entry of [...MANAGED_ENTRIES, ...SEED_ENTRIES.map((seed) => seed.source)]) {
      const absolute = path.join(SOURCE_ROOT, entry);
      const info = await stat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) surface.push(...await walkAssetFiles(absolute, SOURCE_ROOT));
      else surface.push(entry);
    }
  }
  surface = [...new Set(surface)].sort();
  const forbidden = surface.filter((item) => !isStableAsset(item));
  if (forbidden.length) errors.push(`发布面含禁入文件：${forbidden.slice(0, 20).join(', ')}`);
  // 泄漏扫描：token/私钥/个人路径。
  const leakPatterns = [
    ['token', /\b(sk|pk|rk|sess)-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bA(?:KIA|SIA)[0-9A-Z]{16}\b/],
    ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['个人路径', /\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\s"']+/]
  ];
  for (const relative of surface.filter(isStableAsset)) {
    const absolute = path.join(SOURCE_ROOT, relative);
    let text;
    try {
      const buffer = await readFile(absolute);
      if (buffer.includes(0) || buffer.length > FITNESS_MAX_BYTES) continue;
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    for (const [label, pattern] of leakPatterns) {
      if (pattern.test(text)) errors.push(`泄漏扫描命中（${label}）：${relative}`);
    }
  }
  return { ok: errors.length === 0, files: surface.filter(isStableAsset).length, errors };
}

