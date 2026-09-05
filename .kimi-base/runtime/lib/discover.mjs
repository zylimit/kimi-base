// lib/discover.mjs —— catalog discover：从仓库事实推导 module-catalog 草案
//
// 移植自 dsh-base graph.mjs discoverCatalog。让 Agent 手写模块地图等于让它转抄
// 仓库里已有的事实：目录结构、真实 import 边、构建清单都是可读的。引擎读出来
// 提出完整草案，人的工作从"撰写"变成"批改"。
//
// 它绝不替人决定后果：猜出来的属性档位比没有更糟——猜高了门乱拦，猜低了门是
// 摆设。凡引擎无法诚实推导的字段一律进 needsDecision，绝不猜。

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanRealEdges } from './arch.mjs';
import { HarnessError, atomicWrite, readJsonFile, toPosix, usageError } from './core.mjs';
import { trackedPaths } from './git.mjs';

const SOURCE_ROOTS = ['src', 'lib', 'app', 'apps', 'packages', 'services', 'internal', 'cmd', 'pkg', 'modules', 'components'];
const NON_SOURCE = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  '.git', '.kimi-base', '.kimi-code', '.github', '.venv', 'venv', '__pycache__']);

// 全局候选：变更应扩散到全模块的构建/配置清单（存在才列入）。
const GLOBAL_CANDIDATES = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'poetry.lock',
  'requirements.txt', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Makefile',
  'Dockerfile', 'docker-compose.yml', '.gitignore', '.gitattributes', '.editorconfig'
];

// ignored 候选：always=true 的条目无论路径是否存在都列出——脚手架自身足迹在
// 治理启用的一刻就存在，草案若不归类它，刚写下的文件自己就没有归属。
const IGNORE_CANDIDATES = [
  { pattern: '.kimi-code/**', reason: 'kimi-base 注入的 agents/skills 载荷；由 skills-lint/doctor 治理', always: true },
  { pattern: 'progress.md', reason: '项目记忆；每个会话都改，若按模块归类会让每次 gate 全量扩散', always: true },
  { pattern: 'progress.archive.md', reason: '归档项目记忆', always: true },
  { pattern: 'AGENTS.md', reason: '项目宪法；宿主注入它，它不改变任何产品行为', always: true },
  { pattern: 'README.md', reason: '人类入口文档；不改变行为' },
  { pattern: 'CHANGELOG.md', reason: '发布叙事；不是任何检查的输入' },
  { pattern: 'LICENSE', reason: '法律文本；仅随显式人工决策变更' },
  { pattern: 'docs/**', reason: '散文文档；由 spec lint / adr check 治理而非 impact 扩散' },
  { pattern: '.github/**', reason: 'CI 定义；按配置审查' }
];

// 读构建清单，报告这个项目真实拥有的检查命令（matrix 草案素材）。
async function detectCommands(ctx, trackedSet) {
  const existsTracked = (relative) => trackedSet.has(toPosix(relative));
  const readTracked = async (relative) => {
    try {
      return await readFile(path.join(ctx.root, relative), 'utf8');
    } catch { return null; }
  };
  const found = [];
  const pkgRaw = await readTracked('package.json');
  if (pkgRaw !== null) {
    let pkg = null;
    try { pkg = JSON.parse(pkgRaw); } catch { pkg = null; }
    const scripts = (pkg && pkg.scripts) || {};
    const runner = existsTracked('pnpm-lock.yaml') ? 'pnpm' : existsTracked('yarn.lock') ? 'yarn' : 'npm run';
    for (const [id, names] of [['unit', ['test', 'tests', 'jest', 'vitest']], ['lint', ['lint', 'eslint']], ['types', ['typecheck', 'tsc', 'types']], ['build', ['build', 'compile']]]) {
      const hit = names.find((name) => scripts[name]);
      if (hit) found.push({ id, kind: id === 'unit' ? 'unit' : id === 'build' ? 'build' : 'static', command: `${runner} ${hit}`, source: `package.json scripts.${hit}` });
    }
    if (found.length === 0) found.push({ id: 'unit', kind: 'unit', command: 'node --test', source: 'package.json 无 test 脚本；假定为 node 内置 runner' });
  }
  if (existsTracked('pyproject.toml') || existsTracked('pytest.ini') || existsTracked('setup.cfg')) {
    found.push({ id: 'unit', kind: 'unit', command: 'pytest -q', source: 'python 项目布局' });
    found.push({ id: 'lint', kind: 'static', command: 'ruff check .', source: 'python 项目布局（ruff 是常见选择；用别的请替换）' });
  }
  if (existsTracked('go.mod')) {
    found.push({ id: 'unit', kind: 'unit', command: 'go test ./...', source: 'go.mod' });
    found.push({ id: 'lint', kind: 'static', command: 'go vet ./...', source: 'go.mod' });
  }
  if (existsTracked('Cargo.toml')) {
    found.push({ id: 'unit', kind: 'unit', command: 'cargo test', source: 'Cargo.toml' });
    found.push({ id: 'lint', kind: 'static', command: 'cargo clippy -- -D warnings', source: 'Cargo.toml' });
  }
  if (existsTracked('Makefile')) {
    const mk = (await readTracked('Makefile')) ?? '';
    for (const target of ['test', 'lint', 'build']) {
      if (new RegExp(`^${target}:`, 'm').test(mk)) found.push({ id: target === 'test' ? 'unit' : target, kind: target === 'build' ? 'build' : target === 'test' ? 'unit' : 'static', command: `make ${target}`, source: `Makefile target ${target}` });
    }
  }
  const seen = new Set();
  return found.filter((command) => (seen.has(command.id) ? false : (seen.add(command.id), true)));
}

// catalog 模块 id 的合法化：^[a-z][a-z0-9-]*$，碰撞加序号。
function sanitizeModuleId(raw, taken) {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'm-$1') || 'module';
  let id = base;
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`;
  taken.add(id);
  return id;
}

// 持有文件的公共目录前缀（按路径段对齐；单文件即其 dirname）。
function commonDirPrefix(files) {
  const dirs = files.map((file) => file.split('/').slice(0, -1));
  const prefix = [];
  for (let index = 0; ; index += 1) {
    const segment = dirs[0][index];
    if (segment === undefined || !dirs.every((dir) => dir[index] === segment)) break;
    prefix.push(segment);
  }
  return prefix.join('/');
}

// id 推导只剥**一个**前导源码根段（容器目录），其后原样保名——dsh 剥所有段，
// 会把恰好叫 app/lib 的模块抹成 'packages-app' 这种回退 id（供体怪癖，此处修正）。
function moduleIdOf(prefix) {
  const segments = prefix.split('/');
  const stripped = SOURCE_ROOTS.includes(segments[0]) ? segments.slice(1) : segments;
  return stripped.join('-') || prefix.replace(/\//g, '-');
}

// 递归放置：root 全图唯一是硬不变量——同 root 双模块会让 classifyPath 同深度 tie
// 报 overlap（deepest-wins 无法仲裁同深度）。root 被占时按下一路径段细分；散在
// 已占 root 直属的文件无更深目录可细分，上移到最近的空闲祖先 root，paths 重基为
// 相对该祖先的逐文件列表（归属由 paths 精确表达，owningModule/classifyPath 按
// paths 仲裁；祖先全被占的病态情形留原 root 精确列表兜底，paths 互斥仍可仲裁）。
// 终止性：细分每轮更深且文件深度有界；同目录 ≥2 文件早已成组，深层桶必落在空闲目录。
function placeWithUniqueRoot(files, topDir, taken, emit) {
  const root = commonDirPrefix(files) || topDir;
  if (!taken.has(root)) {
    taken.add(root);
    emit(root, files, ['**']);
    return;
  }
  const loose = files.filter((file) => file.slice(0, file.lastIndexOf('/')) === root);
  if (loose.length) {
    const ancestors = [];
    for (let current = root; current.includes('/'); current = current.slice(0, current.lastIndexOf('/'))) {
      ancestors.push(current.slice(0, current.lastIndexOf('/')));
    }
    ancestors.push('.');
    const home = ancestors.find((candidate) => !taken.has(candidate));
    if (home !== undefined) {
      taken.add(home);
      const offset = home === '.' ? 0 : home.length + 1;
      emit(home, loose, loose.map((file) => file.slice(offset)).sort());
    } else {
      emit(root, loose, loose.map((file) => file.slice(root.length + 1)).sort());
    }
  }
  const deeper = files.filter((file) => !loose.includes(file));
  const buckets = new Map();
  for (const file of deeper) {
    const segment = file.slice(root.length + 1).split('/')[0];
    if (!buckets.has(segment)) buckets.set(segment, []);
    buckets.get(segment).push(file);
  }
  for (const bucket of buckets.values()) placeWithUniqueRoot(bucket, topDir, taken, emit);
}

// 按源码目录前缀把 tracked 路径分组成候选模块。
// 与 dsh 的差异：先剔除命中 ignore 候选的路径再分组——dsh 会把 docs/ 同时放进
// 模块提案与 ignored（草案自相矛盾），这里分组前就排除，草案不自欺。
function proposeModules(paths, depth, excluded) {
  const candidates = paths.filter((item) => !excluded(item));
  const groups = new Map();
  for (const item of candidates) {
    const parts = item.split('/');
    if (NON_SOURCE.has(parts[0])) continue;
    if (parts.length < 2) continue;
    let prefix = null;
    if (SOURCE_ROOTS.includes(parts[0]) && parts.length > 2) {
      prefix = parts.slice(0, Math.min(depth + 1, parts.length - 1)).join('/');
    } else if (SOURCE_ROOTS.includes(parts[0])) {
      prefix = parts[0];
    } else if (parts.length > 2 && !parts[0].startsWith('.')) {
      prefix = parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
    }
    if (!prefix) continue;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(item);
  }
  // 单文件组不是模块，是文件。
  const grouped = [...groups.entries()]
    .filter(([, files]) => files.length >= 2)
    .map(([prefix, files]) => ({
      rawId: moduleIdOf(prefix),
      root: prefix,
      files
    }));

  // 兜底：任何持有真实文件的顶层目录也是模块。少了这一步草案会留下无归属路径，
  // 而无归属路径能逃过一切定向门——这正是 catalog lint 存在要抓的故障。
  const covered = new Set(grouped.flatMap((group) => group.files));
  const rest = new Map();
  for (const item of candidates) {
    if (covered.has(item)) continue;
    const parts = item.split('/');
    if (parts.length < 2) continue;
    if (NON_SOURCE.has(parts[0])) continue;
    if (!rest.has(parts[0])) rest.set(parts[0], []);
    rest.get(parts[0]).push(item);
  }
  // 兜底放置保 root 唯一：单文件深层组（<2 文件被丢弃）坠入顶层兜底时，root 若
  // 停在顶层目录会与既有同 root 分组模块撞出 (root, paths) 完全相同的重复模块
  // （校准现场 src/src-2），同 root 双模块还是 lint overlap 的结构性来源。
  const takenRoots = new Set(grouped.map((group) => group.root));
  for (const [dir, files] of rest) {
    placeWithUniqueRoot(files, dir, takenRoots, (root, placed, patterns) => {
      grouped.push({ rawId: moduleIdOf(root), root, files: placed, paths: patterns });
    });
  }
  const taken = new Set();
  return grouped.map((group) => ({ ...group, id: sanitizeModuleId(group.rawId, taken) }));
}

// Tarjan 迭代版强连通分量（真实仓模块数百，递归实现有爆栈风险）。
// deps: Map<id, Set<id>>。返回分量数组；size>1 的分量即依赖环。
function stronglyConnectedComponents(ids, deps) {
  const indexOf = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let nextIndex = 0;
  for (const start of ids) {
    if (indexOf.has(start)) continue;
    indexOf.set(start, nextIndex);
    lowlink.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);
    const work = [{ id: start, next: [...(deps.get(start) ?? [])] }];
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.next.length) {
        const child = frame.next.pop();
        if (!indexOf.has(child)) {
          indexOf.set(child, nextIndex);
          lowlink.set(child, nextIndex);
          nextIndex += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ id: child, next: [...(deps.get(child) ?? [])] });
        } else if (onStack.has(child)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id), indexOf.get(child)));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowlink.set(parent.id, Math.min(lowlink.get(parent.id), lowlink.get(frame.id)));
      if (lowlink.get(frame.id) === indexOf.get(frame.id)) {
        const component = [];
        let member = null;
        while (member !== frame.id) {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        }
        components.push(component);
      }
    }
  }
  return components;
}

// 属性提案信号：模块处理了"出事有后果"的东西。提案带证据，永远不是决定。
const ATTRIBUTE_SIGNALS = [
  { attribute: 'security', re: /\b(auth|authn|authz|jwt|oauth|token|password|passwd|credential|secret|crypto|cipher|permission|rbac|acl|session|signin|login)\b/i },
  { attribute: 'privacy', re: /\b(email|phone|mobile|address|birthday|birthdate|ssn|passport|id_card|idcard|personal|gdpr|consent|pii|subject_?rights)\b/i },
  { attribute: 'safety', re: /\b(actuator|motor|valve|relay|dispense|dose|throttle|brake|servo|emergency_?stop|interlock|watchdog)\b/i },
  { attribute: 'reliability', re: /\b(transaction|idempoten|exactly_?once|consistency|reconcil|ledger|balance)\b/i },
  { attribute: 'resilience', re: /\b(circuit_?break|backoff|jitter|bulkhead|fallback|degrade|rate_?limit|throttl)\b/i },
  { attribute: 'security', re: /\b(payment|invoice|charge|refund|billing|payout|settlement)\b/i }
];

// 属性描述的是生产代码在做什么。讨论个人数据的规格文档、提到 billing 的测试
// 夹具是在谈论主题，不是在做这件事。匹配它们会产生"tests 是 security-critical
// 因为夹具写了 billing"这种提案——输出是噪音的提案系统会教会用户无视一切提案，
// 包括真的那些。所以：只看生产源码，且单词命中绝不给阻断档。
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.py', '.go',
  '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.scala', '.c', '.h', '.cc', '.cpp', '.sql']);
const NON_PRODUCTION = /(^|\/)(tests?|__tests__|spec|fixtures?|mocks?|examples?|docs?)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.woff', '.woff2', '.ttf', '.mp4', '.bin', '.exe', '.dll', '.lock', '.map', '.snap']);

// 从生产源码的可见信号提出属性提案，每条带证据。提案永不是决定：
// 档位封顶 high；单文件单词的弱信号如实带 confidence 报告，不断言。
async function proposeAttributes(ctx, modules, { maxFilesPerModule = 300, maxBytes = 200000 } = {}) {
  const proposals = {};
  for (const module of modules) {
    const hits = {};
    for (const file of module.files.slice(0, maxFilesPerModule)) {
      const extension = path.posix.extname(file).toLowerCase();
      if (!CODE_EXT.has(extension)) continue;
      if (NON_PRODUCTION.test(file)) continue;
      if (SKIP_EXT.has(extension)) continue;
      let text;
      try {
        const info = await stat(path.join(ctx.root, file));
        if (info.size > maxBytes) continue;
        const buffer = await readFile(path.join(ctx.root, file));
        if (buffer.includes(0)) continue;
        text = buffer.toString('utf8');
      } catch { continue; }
      const haystack = `${file}\n${text.slice(0, 20000)}`;
      for (const signal of ATTRIBUTE_SIGNALS) {
        const match = signal.re.exec(haystack);
        if (!match) continue;
        const key = signal.attribute;
        if (!hits[key]) hits[key] = { files: new Set(), terms: new Set(), evidence: [] };
        hits[key].files.add(file);
        hits[key].terms.add(match[0].toLowerCase());
        if (hits[key].evidence.length < 3) hits[key].evidence.push(`${file}: ${match[0]}`);
      }
    }
    const kept = {};
    for (const [attribute, hit] of Object.entries(hits)) {
      // 一个文件里的一个词是线索不是信号。两个独立文件或两个不同词才值得人看一眼。
      const strong = hit.files.size >= 2 || hit.terms.size >= 2;
      if (!strong) continue;
      kept[attribute] = {
        proposedTier: 'high',
        confidence: hit.files.size >= 3 && hit.terms.size >= 2 ? 'medium' : 'low',
        files: hit.files.size,
        terms: [...hit.terms],
        evidence: hit.evidence,
        note: '关键词命中只是去看一眼的理由，永远不是决定。档位要按"这里出事代价多大"来确认。'
      };
    }
    if (Object.keys(kept).length) proposals[module.id] = kept;
  }
  return proposals;
}

// 从仓库已有事实提出完整 catalog 草案；诚实推导不了的字段进 needsDecision。
export async function discoverCatalog(ctx, { depth = 2 } = {}) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 6) {
    throw usageError('catalog discover 的 --depth 必须是 1..6 的整数');
  }
  const tracked = await trackedPaths(ctx, ctx.catalogLimits.maxTrackedPaths);
  if (!tracked.isGit) {
    throw new HarnessError('降级：非 git 仓，无法测量——catalog discover 需要 git（git ls-files 枚举 tracked 路径）', 'NON_GIT_BLOCKED', 3);
  }
  if (tracked.paths.length === 0) {
    throw new HarnessError('降级：无 tracked 文件；先提交项目再谈发现它的结构', 'DISCOVER_EMPTY_TREE', 3);
  }

  // 命中的 ignore 候选先于分组确定：这些路径不参与模块提案（见 proposeModules 注）。
  const activeIgnored = IGNORE_CANDIDATES.filter((entry) => entry.always
    || (entry.pattern.includes('*')
      ? tracked.paths.some((item) => item.startsWith(entry.pattern.split('*')[0]))
      : tracked.paths.includes(entry.pattern)));
  const ignoredMatchers = activeIgnored.map((entry) => entry.pattern);
  const excluded = (item) => ignoredMatchers.some((pattern) => {
    if (!pattern.includes('*')) return item === pattern;
    // 分组前的粗排除只需要前缀语义（候选都是 <dir>/** 或裸文件）。
    return item.startsWith(pattern.split('*')[0]);
  });

  const proposed = proposeModules(tracked.paths, depth, excluded);
  if (proposed.length === 0) {
    throw new HarnessError(
      '降级：没有任何目录持有 ≥2 个 tracked 源码文件，无法提出模块。先写代码，或传 --depth 1。',
      'DISCOVER_NO_MODULES', 3
    );
  }

  // 提案模块间的真实 import 边决定 dependsOn：草案图从第一次运行就贴合代码。
  const probe = { modules: proposed.map((module) => ({ id: module.id, root: module.root, paths: ['**'], dependsOn: [] })), layers: [], globalPaths: [], ignored: [] };
  let scan = await scanRealEdges(ctx, probe);

  // 环处理：互 import 的模块组成强连通分量，原样写进 dependsOn 会让 catalog lint
  // 随后 DFS 报环（校准现场 61 个环）。SCC 凝聚为单模块——合并是草案对人工的
  // 欠债声明（needsDecision），拆环（改 import 方向/下沉共享代码）是人的决定。
  // 凝聚—让位—重扫跑到无环收敛（上限 16 轮）：让位细分改变归属结构必须重扫，
  // 而重扫可能暴露占根模块内部 import 图碎块化后的新环，单遍凝聚不够。
  let modules = proposed;
  const condensations = [];
  const buildDeps = (edges, mods) => {
    const map = new Map(mods.map((module) => [module.id, new Set()]));
    for (const edge of edges) map.get(edge.from)?.add(edge.to);
    return map;
  };
  let deps = buildDeps(scan.edges, modules);
  for (let round = 0; round < 16; round += 1) {
    const cyclic = stronglyConnectedComponents(modules.map((module) => module.id), deps)
      .filter((component) => component.length > 1);
    if (cyclic.length === 0) break;
    // 每轮只凝聚一个 SCC 并即重算：同轮多 SCC 时，先处理 component 的 occupant
    // 让位可能把"同时是后处理 component 成员"的模块移出 modules（同轮快照的
    // 成员查找落空即 TypeError 崩溃）——逐 component 重算剩余模块集是结构性解法。
    const component = cyclic[0];
    {
      const owner = new Map();
      const takenIds = new Set(modules.map((module) => module.id));
      let resplit = false;
      const kept = [...component].sort()[0];
      for (const id of component) owner.set(id, kept);
      const members = modules.filter((module) => component.includes(module.id));
      const target = members.find((module) => module.id === kept);
      // 合并模块的覆盖面 = 各成员覆盖面的并集：root 退到公共前缀，paths 枚举各成员
      // 子树 glob；root==公共前缀的成员（环内含散文件组）在共享前缀下禁止退裸 **——
      // 裸 ** 会顺 root 前缀吞下环外邻居模块的全部子树（校准现场 overlap=68%），
      // 该成员逐文件枚举，覆盖面 = 成员文件并集，不多一寸。
      // 公共前缀按成员 root 路径段求（root='.' 视为零段，不给 './' 假目录）。
      const rootSegs = members.map((module) => (module.root === '.' ? [] : module.root.split('/')));
      const prefixSegs = [];
      for (let index = 0; ; index += 1) {
        const segment = rootSegs[0][index];
        if (segment === undefined || !rootSegs.every((segments) => segments[index] === segment)) break;
        prefixSegs.push(segment);
      }
      const prefix = prefixSegs.join('/');
      // root 冲突仲裁：非成员模块占着公共前缀 root 时它让位（root 全图唯一不变量；
      // 已凝聚模块不让位——击碎既有凝聚会引入振荡）。让位后归属结构变了，实边
      // 扫描基于旧结构，必须重扫（见下方 resplit）。
      const occupant = modules.find((module) => !component.includes(module.id) && !module.condensed
        && (module.root === prefix || (prefix === '' && module.root === '.')));
      if (occupant) {
        modules = modules.filter((module) => module.id !== occupant.id);
        takenIds.delete(occupant.id);
        const takenRoots = new Set(modules.map((module) => module.root));
        takenRoots.add(prefix || '.');
        placeWithUniqueRoot(occupant.files, occupant.root, takenRoots, (root, files, patterns) => {
          const id = sanitizeModuleId(moduleIdOf(root), takenIds);
          modules.push({ id, rawId: id, root, files, paths: patterns });
        });
        resplit = true;
      }
      const shared = modules.some((module) => !component.includes(module.id)
        && (prefix === '' || module.root === prefix || module.root.startsWith(`${prefix}/`)));
      // paths 沿用成员既有枚举按新公共前缀重基，不得从 member.root 重推 root/**：
      // 成员可能已被上一轮凝聚/让位收窄（如 a/**、b/** 或逐文件列表），重推会把
      // 覆盖面膨胀成整棵子树、幻影吞并非成员文件且 lint/arch 全绿不披露。
      const patterns = [];
      for (const member of members) {
        const memberPaths = member.paths ?? ['**'];
        // root='.' 成员的 paths 本就是仓根相对：原样保留不重基——否则 rel='.'
        // 会产出 './src/...' 永不匹配的破坏 pattern（root='.' 配裸 ** 被 lint
        // catch-all 禁令拒绝，一律逐文件枚举为合法形态）。
        if (member.root === '.') {
          patterns.push(...(memberPaths.includes('**') ? member.files : memberPaths));
          continue;
        }
        const rel = prefix ? member.root.slice(prefix.length).replace(/^\//, '') : member.root;
        if (!rel && memberPaths.includes('**')) {
          // root==公共前缀且覆盖面是整棵树：共享前缀下禁止退裸 **，逐文件枚举。
          if (shared) {
            for (const file of member.files) patterns.push(prefix ? file.slice(prefix.length + 1) : file);
          } else {
            patterns.push('**');
          }
          continue;
        }
        for (const pattern of memberPaths) patterns.push(rel ? `${rel}/${pattern}` : pattern);
      }
      target.root = prefix || '.';
      target.paths = [...new Set(patterns)].sort();
      target.files = [...new Set(members.flatMap((module) => module.files))].sort();
      target.condensed = true;
      condensations.push({ id: kept, merged: [...component].sort(), resplit: Boolean(occupant) });
      modules = modules.filter((module) => module.id === kept || !component.includes(module.id));
      if (resplit) {
        // 让位细分改变了模块结构：基于旧结构的实边归属作废，按最终结构重扫一遍。
        // 代价只在发生让位的仓发生；换个错归属/丢边的 dependsOn 草案不值得省。
        const rescanProbe = { modules: modules.map((module) => ({ id: module.id, root: module.root, paths: module.paths ?? ['**'], dependsOn: [] })), layers: [], globalPaths: [], ignored: [] };
        scan = await scanRealEdges(ctx, rescanProbe);
        deps = buildDeps(scan.edges, modules);
      } else {
        // 重建依赖图：SCC 内部边消失，环外边映射到凝聚节点——图必为 DAG。
        const condensed = new Map(modules.map((module) => [module.id, new Set()]));
        for (const [from, targets] of deps) {
          const mappedFrom = owner.get(from) ?? from;
          for (const to of targets) {
            const mappedTo = owner.get(to) ?? to;
            if (mappedFrom !== mappedTo) condensed.get(mappedFrom)?.add(mappedTo);
          }
        }
        deps = condensed;
      }
    }
  }
  // 16 轮未收敛是病态配置（凝聚/让位振荡）：不假装无环，残余环写 needsDecision 待人工。
  const residualCycles = stronglyConnectedComponents(modules.map((module) => module.id), deps)
    .filter((component) => component.length > 1);

  // 分层跟随提案图里的最长依赖路径，在凝聚后的 DAG 上计算（有环时上面的 SCC
  // 凝聚已先把图压成 DAG，此处 depthOf 的 seen 兜底只是防御）。名字是位置性的
  // （tier-N），刻意不发明 "domain"/"infra"——那会读起来像发现而不是猜测。
  // 方向对齐 kimi 规则「只允许依赖同层或更内层（层索引更小）」：level 0（无依赖）
  // 是最内层 tier-1，依赖深度越大层号越大——dsh 的"tier-1 outermost"命名方向在
  // kimi 的层规则下会让草案自带 layer-direction 违规，故翻转（已知供体差异）。
  const level = new Map();
  const depthOf = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const value = [...(deps.get(id) || [])].reduce((max, next) => Math.max(max, depthOf(next, seen) + 1), 0);
    level.set(id, value);
    return value;
  };
  for (const module of modules) depthOf(module.id);
  const maxLevel = Math.max(0, ...level.values());
  const layers = [];
  for (let index = 0; index <= maxLevel; index += 1) layers.push(`tier-${index + 1}`);

  const detectedChecks = await detectCommands(ctx, new Set(tracked.paths));

  const covered = new Set();
  for (const module of modules) for (const file of module.files) covered.add(file);
  const globals = GLOBAL_CANDIDATES.filter((candidate) => tracked.paths.includes(candidate));
  // 自定义 catalogFile 不在 .kimi-base/ 隐式全局面内时，显式列入——本命令保存后它就存在。
  const catalogRel = toPosix(path.relative(ctx.root, ctx.catalogPath));
  if (!catalogRel.startsWith('.kimi-base/') && !globals.includes(catalogRel)) globals.push(catalogRel);
  const ignored = activeIgnored.map((entry) => ({ pattern: entry.pattern, reason: entry.reason }));
  // .kimi-base/** 是 classifyPath 的隐式全局（框架自有配置面），草案无需也不应再归类它。
  const implicitGlobal = (item) => item.startsWith('.kimi-base/');
  let stillUnmapped = tracked.paths.filter((item) =>
    !covered.has(item) && !globals.includes(item) && !excluded(item) && !implicitGlobal(item));

  // 没有任何归属的根级文件一律 global：它的变更扩散到每个模块。
  // 过度测试便宜；无归属路径能逃过每道门。
  for (const item of stillUnmapped.filter((entry) => !entry.includes('/'))) {
    if (!globals.includes(item)) globals.push(item);
  }
  stillUnmapped = stillUnmapped.filter((item) => item.includes('/'));

  const draft = {
    version: 1,
    layers,
    globalPaths: globals.sort(),
    ignored,
    modules: modules.map((module) => ({
      id: module.id,
      root: module.root,
      paths: module.paths ?? ['**'],
      layer: `tier-${(level.get(module.id) || 0) + 1}`,
      dependsOn: [...(deps.get(module.id) || [])].sort(),
      owners: [],
      provides: [],
      attributes: {},
      verification: []
    }))
  };

  const needsDecision = [
    { field: 'modules[].attributes', why: '没有指派任何五性档位。猜 "security: critical" 会让门乱拦；猜 "low" 会让门成摆设。从处理凭据、个人数据、钱或物理动作的模块开始声明。' },
    { field: 'modules[].forbiddenDependencies', why: '没有禁止任何边。禁令是"绝不允许发生"的承诺，不是"尚未发生"的观察——引擎拒绝替你做这个承诺。' },
    { field: 'layers', why: '分层按位置命名（tier-1 最内层 = 无依赖基础层，沿最长依赖路径递增）。改成你自己的词汇，并确认方向是你想要的。' },
    { field: 'verification-matrix.json', why: 'detectedChecks 只是提案；把它们接进 verification-matrix.json 的 checks 与 riskKinds/riskChecks 是人的决定（high 必须含 security kind）。' }
  ];
  if (condensations.length) {
    const resplitNote = condensations.some((item) => item.resplit)
      ? '公共前缀 root 被环外模块占用时已令其让位细分（root 全图唯一），实边按最终结构重扫。' : '';
    needsDecision.push({
      field: 'modules[].dependsOn',
      why: `检测到 ${condensations.length} 个依赖环，已按强连通分量（SCC）凝聚为单模块：${condensations.map((item) => item.merged.join(' ↔ ')).join('；')}。环内模块共享覆盖面与层号，SCC 内部边已从 dependsOn 移除；共享前缀下凝聚模块 paths 枚举成员子树与散文件，不用裸 **。${resplitNote}拆环（改 import 方向或下沉共享代码）是人工决定，引擎不替你做。`
    });
  }
  if (residualCycles.length) {
    needsDecision.push({
      field: 'modules[].dependsOn',
      why: `凝聚—让位—重扫 16 轮未收敛（病态配置），仍残余 ${residualCycles.length} 个依赖环：${residualCycles.map((component) => component.join(' ↔ ')).join('；')}。引擎不假装无环——请人工拆环后重跑 discover。`
    });
  }
  if (detectedChecks.length === 0) {
    needsDecision.unshift({ field: 'checks', why: '没有识别到任何构建清单，检测不到检查命令。在有任何检查之前，每道 gate 都报 BLOCKED——这是正确的：什么都没跑。' });
  }

  return {
    ok: true,
    draft,
    attributeProposals: await proposeAttributes(ctx, modules),
    trackedPaths: tracked.paths.length,
    proposedModules: modules.length,
    detectedChecks,
    realEdges: scan.edges.length,
    unresolvedSpecifiers: scan.unresolvedImports,
    stillUnmapped: stillUnmapped.slice(0, 50),
    stillUnmappedCount: stillUnmapped.length,
    needsDecision
  };
}

// --write：已有 catalog 时写 *.draft.json（绝不覆盖人工策展的 catalog），否则直接落盘。
export async function discoverWrite(ctx, result) {
  const existing = await readJsonFile(ctx.catalogPath, { required: false });
  const target = existing
    ? ctx.catalogPath.replace(/\.json$/, '.draft.json')
    : ctx.catalogPath;
  await atomicWrite(target, result.draft);
  return {
    written: toPosix(path.relative(ctx.root, target)),
    isDraft: Boolean(existing),
    modules: result.draft.modules.length
  };
}

// init-modules 的转发实现（P6 起 catalog discover 取代之）：语义并轨 discover。
export async function initModulesAlias(ctx, write) {
  const result = await discoverCatalog(ctx, {});
  if (!write) return { dryRun: true, result };
  const written = await discoverWrite(ctx, result);
  return { dryRun: false, result, written };
}
