// lib/fleet.mjs —— fleet 层：跨仓契约治理（全量移植自 dsh-base lib/fleet.mjs）
//
// 一仓一服务、每仓小到单个 agent 装得下全模型，是对上下文的正确答案。但它不是
// 免费的：复杂度不消失，从文件间依赖搬到仓间契约。分布式单核就诞生在这个面上，
// 而单个仓库内部什么都看不见。
//
// 本模块用与单仓引擎相同的规则治理这个面：显式声明图 + 实测现实 + 测不到就
// 拒不报绿。fleet.json 是组级文件（不进 installer 种子），经 --fleet 标志、
// KIMI_BASE_FLEET 环境变量或自 cwd 向上逐级查找定位。

import fs from 'node:fs';
import path from 'node:path';
import { HarnessError, nowIso, readJsonFile, runProcess } from './core.mjs';

export const FLEET_FILE = 'fleet.json';

const CONTRACT_KINDS = ['http', 'grpc', 'event', 'schema', 'library', 'file', 'other'];
const CONTRACT_STATUS = ['active', 'deprecated', 'retired'];

// 定位 fleet 清单：显式路径 > KIMI_BASE_FLEET 环境变量 > 自 start 向上最近祖先。
export function findFleet(start = process.cwd(), explicit = null) {
  const candidate = explicit || process.env.KIMI_BASE_FLEET || null;
  if (candidate) {
    const resolved = path.resolve(candidate);
    const file = resolved.endsWith('.json') ? resolved : path.join(resolved, FLEET_FILE);
    return fs.existsSync(file) ? file : null;
  }
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, FLEET_FILE);
    if (fs.existsSync(file)) return file;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadFleet(start = process.cwd(), explicit = null) {
  const file = findFleet(start, explicit);
  if (!file) return { present: false, file: null, fleet: null };
  const fleet = await readJsonFile(file, { required: false });
  if (fleet === null) {
    throw new HarnessError(`fleet.json 不是合法 JSON：${file}`, 'FLEET_INVALID', 3);
  }
  return { present: true, file, fleet, root: path.dirname(file) };
}

const repoPath = (fleetRoot, repo) => path.resolve(fleetRoot, repo.path || repo.id);

/** 每个契约 id 的提供者清单（含声明的版本）。 */
function providerIndex(fleet) {
  const index = new Map();
  for (const repo of fleet.repos || []) {
    for (const provided of repo.provides || []) {
      if (!provided || !provided.contract) continue;
      if (!index.has(provided.contract)) index.set(provided.contract, []);
      index.get(provided.contract).push({ repo: repo.id, ...provided });
    }
  }
  return index;
}

/** 消费方的版本选择器与提供方版本的匹配。 */
function versionMatches(offered, wanted) {
  if (!wanted || wanted === '*' || wanted === 'any') return true;
  if (offered === wanted) return true;
  // "2.x" 与 "2" 接受任何 2.* 提供。不做更聪明的事：fleet 清单是声明，
  // 会猜测的解析器会把真实的不匹配藏起来。
  const wantedBase = String(wanted).replace(/\.x$/i, '');
  return String(offered) === wantedBase || String(offered).startsWith(`${wantedBase}.`);
}

// ── lint ────────────────────────────────────────────────────────────────────

export function fleetLint(state) {
  const fleet = state.fleet;
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });

  if (!Array.isArray(fleet.repos) || fleet.repos.length === 0) {
    add('error', 'NO_REPOS', 'fleet 没有声明任何仓库；没有可治理的对象');
    return { ok: false, findings, counts: { error: 1, warning: 0, repos: 0, contracts: 0 } };
  }

  const ids = new Set();
  for (const repo of fleet.repos) {
    if (!repo.id) { add('error', 'REPO_ID_MISSING', '存在没有 id 的仓库条目'); continue; }
    if (ids.has(repo.id)) add('error', 'DUPLICATE_REPO', `仓库 id 重复："${repo.id}"`, { repo: repo.id });
    ids.add(repo.id);
    if (!Array.isArray(repo.owners) || repo.owners.length === 0) {
      add('warning', 'NO_OWNER', `仓库 "${repo.id}" 没有声明 owner；没有 owner 的契约变更时无人可协商`, { repo: repo.id });
    }
    const dir = repoPath(state.root, repo);
    if (!fs.existsSync(dir)) {
      add('error', 'REPO_MISSING', `仓库 "${repo.id}" 声明于 ${repo.path}，但该路径不存在`, { repo: repo.id });
    } else if (!fs.existsSync(path.join(dir, '.git'))) {
      add('warning', 'REPO_NOT_GIT', `仓库 "${repo.id}" 不是 git 工作树；它自身的治理会降级`, { repo: repo.id });
    }
    for (const contract of repo.provides || []) {
      if (!contract.contract) { add('error', 'CONTRACT_ID_MISSING', `仓库 "${repo.id}" 提供了一个无 id 的契约`, { repo: repo.id }); continue; }
      if (!contract.version) add('error', 'CONTRACT_NO_VERSION', `契约 "${contract.contract}"（"${repo.id}"）没有声明版本`, { repo: repo.id });
      if (contract.kind && !CONTRACT_KINDS.includes(contract.kind)) add('error', 'UNKNOWN_CONTRACT_KIND', `契约 "${contract.contract}" 的 kind 未知："${contract.kind}"`, { repo: repo.id });
      if (contract.status && !CONTRACT_STATUS.includes(contract.status)) add('error', 'UNKNOWN_CONTRACT_STATUS', `契约 "${contract.contract}" 的 status 未知："${contract.status}"`, { repo: repo.id });
      if (contract.status === 'deprecated' && !contract.sunset) {
        add('error', 'DEPRECATED_WITHOUT_SUNSET', `契约 "${contract.contract}@${contract.version}" 已废弃却没有 sunset 日期；没人必须行动的废弃是永久的`, { repo: repo.id });
      }
      if (!contract.adr && contract.status !== 'retired') {
        add('warning', 'CONTRACT_WITHOUT_ADR', `契约 "${contract.contract}@${contract.version}" 没有指明 ADR；已发布的契约是架构承诺`, { repo: repo.id });
      }
    }
  }

  const providers = providerIndex(fleet);
  for (const [contract, list] of providers) {
    const owners = new Set(list.map((item) => item.repo));
    if (owners.size > 1) {
      add('error', 'CONTRACT_MULTIPLE_OWNERS', `契约 "${contract}" 由 ${[...owners].join('、')} 同时提供；所有权必须无歧义`, { contract });
    }
  }

  const consumedBy = new Map();
  for (const repo of fleet.repos) {
    for (const consumed of repo.consumes || []) {
      if (!consumed || !consumed.contract) { add('error', 'CONSUME_ID_MISSING', `仓库 "${repo.id}" 消费了一个无 id 的契约`, { repo: repo.id }); continue; }
      if (!consumedBy.has(consumed.contract)) consumedBy.set(consumed.contract, []);
      consumedBy.get(consumed.contract).push({ repo: repo.id, version: consumed.version });

      const offers = providers.get(consumed.contract);
      if (!offers) {
        if (consumed.external) continue;
        add('error', 'DANGLING_CONSUME', `仓库 "${repo.id}" 消费了 "${consumed.contract}"，但本 fleet 没有任何仓库提供它；声明提供者，或把该条目标记 external`, { repo: repo.id, contract: consumed.contract });
        continue;
      }
      const match = offers.find((offer) => versionMatches(offer.version, consumed.version));
      if (!match) {
        add('error', 'UNPROVIDED_VERSION', `仓库 "${repo.id}" 消费 "${consumed.contract}@${consumed.version || 'any'}"，但提供方只有 ${offers.map((offer) => offer.version).join('、')}`, { repo: repo.id, contract: consumed.contract });
        continue;
      }
      if (match.status === 'retired') {
        add('error', 'CONSUMING_RETIRED', `仓库 "${repo.id}" 正在消费已退役的 "${consumed.contract}@${match.version}"`, { repo: repo.id, contract: consumed.contract });
      } else if (match.status === 'deprecated') {
        const past = match.sunset && new Date(match.sunset) < new Date();
        add(past ? 'error' : 'warning', past ? 'SUNSET_PASSED' : 'CONSUMING_DEPRECATED',
          `仓库 "${repo.id}" 正在消费已废弃的 "${consumed.contract}@${match.version}"`
          + (match.sunset ? `（sunset ${match.sunset}${past ? '，已过期' : ''}）` : ''),
          { repo: repo.id, contract: consumed.contract });
      }
    }
  }

  for (const [contract, list] of providers) {
    if (!consumedBy.has(contract) && !list.some((item) => item.external || item.public)) {
      add('warning', 'ORPHAN_CONTRACT', `契约 "${contract}" 由 "${list[0].repo}" 提供但 fleet 内无人消费；退役它，或标记 public`, { contract });
    }
  }

  // 契约图中的环是分布式单核的签名：这些服务无法独立发布——而那本是拆仓的全部意义。
  const cycles = contractCycles(fleet);
  for (const cycle of cycles) {
    add('warning', 'CONTRACT_CYCLE', `跨仓契约环：${cycle.join(' -> ')}；这些仓库无法独立发布`);
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  return {
    ok: errors.length === 0,
    findings,
    counts: {
      error: errors.length,
      warning: findings.length - errors.length,
      repos: fleet.repos.length,
      contracts: providers.size,
      cycles: cycles.length
    }
  };
}

export function contractCycles(fleet) {
  const providers = providerIndex(fleet);
  const edges = new Map();
  for (const repo of fleet.repos || []) {
    const targets = new Set();
    for (const consumed of repo.consumes || []) {
      const offers = providers.get(consumed.contract);
      if (!offers) continue;
      for (const offer of offers) if (offer.repo !== repo.id) targets.add(offer.repo);
    }
    edges.set(repo.id, [...targets]);
  }
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const index = stack.indexOf(id);
      if (index >= 0) cycles.push([...stack.slice(index), id]);
      return;
    }
    state.set(id, 1); stack.push(id);
    for (const next of edges.get(id) || []) if (edges.has(next)) visit(next);
    stack.pop(); state.set(id, 2);
  };
  for (const id of edges.keys()) visit(id);
  return cycles;
}

// ── impact ──────────────────────────────────────────────────────────────────

/**
 * 一次契约变更波及哪些仓库。
 *
 * 先直接消费者，再沿这些消费者自己发布的契约做传递闭包：对底层契约的破坏性
 * 变更会在边缘浮出水面，协调成本就是这个集合的大小。
 */
export function fleetImpact(state, contractId) {
  const fleet = state.fleet;
  const providers = providerIndex(fleet);
  const offers = providers.get(contractId);
  if (!offers) {
    return { ok: false, degraded: true, reason: `本 fleet 没有任何仓库提供 "${contractId}"`, known: [...providers.keys()].sort() };
  }

  const byRepo = new Map((fleet.repos || []).map((repo) => [repo.id, repo]));
  const consumersOf = (contract) => (fleet.repos || [])
    .filter((repo) => (repo.consumes || []).some((consumed) => consumed.contract === contract))
    .map((repo) => repo.id);

  const direct = consumersOf(contractId);
  const reached = new Set(direct);
  const queue = [...direct];
  const chain = [];
  while (queue.length) {
    const id = queue.shift();
    const repo = byRepo.get(id);
    if (!repo) continue;
    for (const provided of repo.provides || []) {
      for (const next of consumersOf(provided.contract)) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
        chain.push({ via: provided.contract, from: id, to: next });
      }
    }
  }

  const owner = offers[0].repo;
  return {
    ok: true,
    contract: contractId,
    provider: owner,
    versions: offers.map((offer) => ({ version: offer.version, status: offer.status || 'active', sunset: offer.sunset || null })),
    directConsumers: direct.sort(),
    transitiveConsumers: [...reached].filter((id) => !direct.includes(id)).sort(),
    affectedRepos: [owner, ...[...reached]].filter((value, index, array) => array.indexOf(value) === index).sort(),
    propagation: chain,
    coordinationCost: reached.size + 1,
    advice: reached.size === 0
      ? `本 fleet 没有消费者；变更对 ${owner} 是局部的`
      : `这里的破坏性变更是一次跨 ${reached.size + 1} 个仓库的协同发布。新旧版本并排发布，声明 sunset 日期，所有消费者迁移完毕才退役。`
  };
}

// ── status 与 recap ─────────────────────────────────────────────────────────

// 在成员仓内跑该仓自己的引擎。KIMI_BASE_ROOT 钉死项目根：成员仓嵌在别的
// kimi-base 项目里时，向上查找会撞错根（见 lib/config.mjs findProjectRoot）。
async function runIn(dir, args, timeoutMs = 120000) {
  const engine = path.join(dir, '.kimi-base', 'runtime', 'kimi-base.mjs');
  if (!fs.existsSync(engine)) return { installed: false, code: null, stdout: '', stderr: '' };
  const result = await runProcess(process.execPath, [engine, ...args], {
    cwd: dir,
    timeoutMs,
    maxOutput: 400000,
    env: { ...process.env, KIMI_BASE_ROOT: dir }
  });
  return {
    installed: true,
    code: result.status === 'BLOCKED' ? null : result.exitCode,
    blocked: result.status === 'BLOCKED',
    timedOut: result.timedOut === true,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

/** 每仓一行有界答案：是否已治理、健康、同步。 */
export async function fleetStatus(state, { deep = false } = {}) {
  const rows = [];
  for (const repo of state.fleet.repos || []) {
    const dir = repoPath(state.root, repo);
    const row = { id: repo.id, path: repo.path, exists: fs.existsSync(dir), installed: false };
    if (!row.exists) { rows.push(row); continue; }
    const doctor = await runIn(dir, ['doctor']);
    row.installed = doctor.installed;
    if (doctor.installed) {
      row.doctorExit = doctor.code;
      row.doctorOk = doctor.code === 0;
      if (doctor.timedOut) row.note = 'doctor 超时（120s）';
      if (doctor.code !== 0) {
        const tail = `${doctor.stdout}\n${doctor.stderr}`.split('\n').filter(Boolean).slice(-5);
        row.doctorTail = tail;
      }
    }
    if (deep && row.installed) {
      const dod = await runIn(dir, ['dod'], 600000);
      row.dodExit = dod.code;
      row.dodOk = dod.code === 0;
    }
    rows.push(row);
  }
  const problems = rows.filter((row) => !row.exists || !row.installed || row.doctorOk === false
    || (deep && row.installed && row.dodOk === false));
  return {
    ok: problems.length === 0,
    repos: rows.length,
    rows,
    problems: problems.map((row) => row.id),
    deep
  };
}

/** fleet 级的"现在到哪了"：每仓一个有界块（取该仓 recap 的前 5 条 dash 行）。 */
export async function fleetRecap(state, { budget = 8000, perRepo = 700 } = {}) {
  const blocks = [];
  let truncated = false;
  for (const repo of state.fleet.repos || []) {
    const dir = repoPath(state.root, repo);
    if (!fs.existsSync(dir)) { blocks.push(`## ${repo.id}\n- MISSING at ${repo.path}`); continue; }
    const result = await runIn(dir, ['recap', '--budget', String(perRepo)]);
    if (!result.installed) { blocks.push(`## ${repo.id}\n- 未安装（无 .kimi-base/runtime/kimi-base.mjs）`); continue; }
    if (result.code !== 0) { blocks.push(`## ${repo.id}\n- recap 不可用（exit ${result.code ?? 'N/A'}）`); continue; }
    // kimi 的 recap 输出是人类文本：首行是状态头，正文里 Position/摘录都是 dash 行。
    const position = result.stdout.split('\n').filter((line) => line.startsWith('- ')).slice(0, 5).join('\n');
    blocks.push(`## ${repo.id}\n${position || '- 无记忆记录'}`);
  }
  let body = `# Fleet recap - ${nowIso()}\n\n${blocks.join('\n\n')}\n`;
  if (body.length > budget) { body = `${body.slice(0, budget)}\n\n...[fleet recap 截断于 ${budget} 字符预算]\n`; truncated = true; }
  return { ok: true, repos: (state.fleet.repos || []).length, chars: body.length, budget, truncated, text: body };
}

// fleet 动词的公共前置：定位并加载 fleet.json。找不到 = 单仓模式，降级 exit 3。
export async function requireFleet(cwd, explicit) {
  const state = await loadFleet(cwd, explicit);
  if (!state.present) {
    throw new HarnessError(
      `未找到 ${FLEET_FILE}（--fleet 标志 / KIMI_BASE_FLEET 环境变量 / 自 cwd 向上查找均无果）；fleet 动词治理的是仓群，单仓模式无需它`,
      'FLEET_NOT_FOUND', 3
    );
  }
  return state;
}
