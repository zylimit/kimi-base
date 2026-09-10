// lib/cli.mjs —— CLI 分发与控制流（帮助文案与输出整形已下沉 lib/cli-help.mjs）

import path from 'node:path';
import process from 'node:process';
import { doctorCommand, isSourceRepo, manifestCommand, packCheckCommand } from './admin.mjs';
import { adrCheckRun, archBaselineWrite, archCheckRun, archTrend } from './arch.mjs';
import { assessBudget } from './budget.mjs';
import { lintCatalog } from './catalog.mjs';
import { CONTRACTS, CONTRACT_FLAG_EXTENSIONS, GLOBAL_FLAGS, STRENGTH_CONTRACT } from './cli-contracts.mjs';
import { printHelp, printResult } from './cli-help.mjs';
import { cochangeAnalysis } from './cochange.mjs';
import { findProjectRoot, loadContext, requireProjectRoot } from './config.mjs';
import { buildContextPack, impactAnalysis } from './context.mjs';
import { HarnessError, csv, nextStepFor, nowIso, parseCliArgs, usageError } from './core.mjs';
import { discoverCatalog, discoverWrite, initModulesAlias } from './discover.mjs';
import { fastModeSet } from './fast.mjs';
import { listFeedback, proposeFeedback, recordFeedback, scanFeedback, skipFeedback } from './feedback.mjs';
import { runFitness } from './fitness.mjs';
import { fleetImpact, fleetLint, fleetRecap, fleetStatus, requireFleet } from './fleet.mjs';
import { runGate } from './gate.mjs';
import { dispatchHook } from './hooks.mjs';
import { gateAudit, retentionPrune, riskScan, runDod } from './hygiene.mjs';
import { assertInstallSource, applyInstallPlan, applyUninstallPlan, assertSafeTarget, buildSourceManifest, mountGitHooks, planInstall, planUninstall } from './installer.mjs';
import { archiveProgress, invariantsDigest, recap, syncCheck } from './memory.mjs';
import { INSTALL_RECEIPT_REL, TASKS_FILE } from './paths.mjs';
import { attributeCoverage, completionGate, waiverCreate, waiverList } from './quality.mjs';
import { releaseReadiness } from './release.mjs';
import { REVIEW_STAGES, backlogAdd, backlogList, recordBlue, recordLens, reviewPack, reviewStart, reviewStatus, reviewTeam, reviewVerdict, stageOfLens } from './review.mjs';
import { agentsLint, rulesAudit, skillsLint, specLint, specView, traceRequirements } from './scan.mjs';
import { selftestCommand } from './selftest.mjs';
import { assertNoMaintenance, updateState } from './state.mjs';
import { BUILTIN_PROFILES, PROFILE_ORDER, loadStrengthConfig, recordDecision, resolveProfiles, resolveStrength, setStrengthProfile, strengthCompletionCheck } from './strength.mjs';
import { emptyTasks, getActiveTask, readTasks, taskCancel, taskStart } from './tasks.mjs';
import { receiptVerify } from './verify.mjs';

// 严格 flag 校验（退出码契约 v2：用法错误 exit 1）——单源派生自 cli-contracts.mjs（REQ-056）。
// 校验顺序：未知 flag → 重复 flag → 空值 flag → conflicts 互斥 → 位置参数上下界；
// 全部先于项目根解析（用法错误不该被 PROJECT_ROOT_NOT_FOUND 遮蔽）。

// 全部契约里的 value flag 名（含全局）：先扫一遍定位 verb，再按该 verb 的契约精确解析。
const VALUE_FLAG_NAMES_GLOBAL = new Set(Object.entries(GLOBAL_FLAGS).filter(([, spec]) => spec.kind === 'value').map(([name]) => name));
const VALUE_FLAG_NAMES = new Set(VALUE_FLAG_NAMES_GLOBAL);
for (const contract of [...Object.values(CONTRACTS), STRENGTH_CONTRACT]) {
  for (const [name, spec] of Object.entries(contract.flags)) if (spec.kind === 'value') VALUE_FLAG_NAMES.add(name);
}
// REQ-063 扩表 flag（单列于 CONTRACT_FLAG_EXTENSIONS）同样参与 value 吞值解析。
for (const extension of Object.values(CONTRACT_FLAG_EXTENSIONS)) {
  for (const [name, spec] of Object.entries(extension)) if (spec.kind === 'value') VALUE_FLAG_NAMES.add(name);
}

function firstVerbToken(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) return token;
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
    // 跳过 value flag 的值——但值恰好是已注册动词时不跳（--check manifest：
    // check 在 quality/waiver 契约里是 value flag，会把 manifest 吞成值、静默 help）。
    if (inline === undefined && VALUE_FLAG_NAMES.has(key) && !contractOf(argv[index + 1])) index += 1;
  }
  return undefined;
}

// 契约查表单源：strength（REQ-052）契约单列于 STRENGTH_CONTRACT（CONTRACTS 键集被 REQ-056
// 现状表行为测试锁定为 40 dispatch verb + help）。所有查表必须走本函数——直接查 CONTRACTS
// 会让 strength 的契约校验整体旁路（P3 评审 D4）。
function contractOf(verb) {
  return CONTRACTS[verb] ?? (verb === 'strength' ? STRENGTH_CONTRACT : undefined);
}

// REQ-063：动词的完整可接受 flag 集 = 契约 flags + 扩表 flags（CONTRACT_FLAG_EXTENSIONS）。
// 注意：未知 flag 报文的"支持的 flag"清单只列契约 flags（现状表测试逐集合锁定），
// 扩表 flag 在 <verb> --help 细则里披露。
function acceptedFlagsOf(verb) {
  const contract = contractOf(verb);
  return { ...contract?.flags, ...(CONTRACT_FLAG_EXTENSIONS[verb] ?? {}) };
}

function assertContract(verb, args, flags, duplicates, emptyValues) {
  const contract = contractOf(verb);
  if (!contract) return; // 未知动词走 default 分支报"未知动词"
  const accepted = acceptedFlagsOf(verb);
  const allowed = new Set([...Object.keys(accepted), ...Object.keys(GLOBAL_FLAGS)]);
  const listed = [...Object.keys(contract.flags), ...Object.keys(GLOBAL_FLAGS)];
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw usageError(`未知 flag：--${key}；动词 ${verb} 支持的 flag：${listed.map((item) => `--${item}`).join(' ')}`);
    }
  }
  for (const name of duplicates) {
    throw usageError(`动词 ${verb} 的 flag --${name} 重复出现（重复 flag 不允许，请只传一次）`);
  }
  for (const name of emptyValues) {
    throw usageError(`动词 ${verb} 的 flag --${name} 空值（--${name}= 不允许空值）`);
  }
  for (const group of contract.conflicts ?? []) {
    const present = group.filter((name) => flags[name] !== undefined && flags[name] !== false);
    if (present.length > 1) {
      throw usageError(`动词 ${verb} 的 flag ${present.map((name) => `--${name}`).join(' 与 ')} 互斥`);
    }
  }
  const { min, max } = contract.positional;
  if (args.length < min) {
    throw usageError(`动词 ${verb} 缺少位置参数（至少 ${min} 个，实得 ${args.length} 个）；用法：${contract.usage}`);
  }
  if (args.length > max) {
    throw usageError(`动词 ${verb} 位置参数越界：${args.slice(max).map((token) => `「${token}」`).join(' ')} 多余（最多 ${max} 个）；用法：${contract.usage}`);
  }
}

// stdin JSON 载荷（review blue / lens / backlog add 的输入信封）。
async function readStdinJson(what) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw usageError(`${what} 需要从 stdin 读 JSON 载荷`);
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${what} 的 stdin 不是合法 JSON`);
  }
}

// ---------------- strength 动词族（REQ-051/REQ-052，ADR-0008） ----------------

function strengthAxisLines(axes, sources = null) {
  return Object.keys(BUILTIN_PROFILES.explore).map((axis) => `${axis}: ${String(axes[axis])}${sources ? ` [${sources[axis]}]` : ''}`);
}

async function dispatchStrength(ctx, sub, flags) {
  if (sub === 'list') {
    // 内置档客观存在：无 strength.json 也 exit 0；有配置则附带自定义档（extends 合并后生效值）。
    const config = await loadStrengthConfig(ctx);
    const lines = ['内置档（explore → rapid → balanced → strict，逐轴单调）：'];
    for (const name of PROFILE_ORDER) lines.push(`- ${name}（内置）`, ...strengthAxisLines(BUILTIN_PROFILES[name]).map((line) => `    ${line}`));
    if (config) {
      const profiles = resolveProfiles(config);
      for (const name of Object.keys(config.customProfiles ?? {})) {
        lines.push(`- ${name}（自定义，extends ${config.customProfiles[name].extends}）`, ...strengthAxisLines(profiles[name].axes).map((line) => `    ${line}`));
      }
    } else {
      lines.push('（未配置 .kimi-base/strength.json——强度治理未开启；种子：.kimi-base/templates/strength.example.json）');
    }
    printResult('strength list', lines);
    return 0;
  }
  if (sub === 'status' || sub === 'explain') {
    const resolved = await resolveStrength(ctx, sub === 'explain' ? {
      risk: flags.risk !== undefined ? String(flags.risk) : undefined,
      operation: flags.operation !== undefined ? String(flags.operation) : undefined,
      paths: flags.paths !== undefined ? csv(flags.paths) : []
    } : {});
    await recordDecision(ctx, resolved);
    const lines = [
      `profile: ${resolved.active}（来源：${resolved.profileSource}）`,
      `rollout: ${resolved.rollout}${resolved.shadow ? '（shadow 影子模式：只报告不阻断，task complete 的 completionMode 不执法）' : ''}`,
      `policyHash: ${resolved.policyHash}`,
      `inputDigest: ${resolved.inputDigest}`,
      ...strengthAxisLines(resolved.axes, sub === 'explain' ? resolved.sources : null)
    ];
    if (sub === 'explain') {
      lines.push(resolved.reasons.length ? `floor 决策：${resolved.reasons.join('；')}` : 'floor 决策：无 floor 输入（来源全部 builtin/extends）');
    }
    printResult(`strength ${sub}`, lines);
    return 0;
  }
  if (sub === 'set') {
    if (flags.profile === undefined || flags.profile === true) throw usageError('strength set 需要 --profile <档名>');
    const result = await setStrengthProfile(ctx, String(flags.profile));
    printResult('strength set 完成', [
      `当前档：${result.profile}（写 .kimi-base/state/strength.json，覆盖 strength.json 的 profile）`,
      // D5/REQ-055：committed 模式 state 覆盖永不入库——clone/换机后 policyHash 按入库的
      // strength.json 重解析，旧回执会假陈旧。必须显式警告并给恢复一致的路径。
      ...(ctx.evidenceMode === 'committed'
        ? ['警告：evidence.mode=committed——state 覆盖（state/strength.json）是本地的，不随 git 入库；clone/换机后 policyHash 失配会使回执判陈旧。跨机一致请改 .kimi-base/strength.json 并提交，或在对端重跑 strength set --profile 恢复一致']
        : [])
    ]);
    return 0;
  }
  throw usageError(`未知 strength 子命令：${sub ?? '<缺>'}（list/status/set/explain）`);
}

async function dispatchCommand(argv) {
  const verb = firstVerbToken(argv);
  // strength（REQ-052）契约单列于 STRENGTH_CONTRACT：CONTRACTS 键集被 REQ-056 现状表
  // 行为测试锁定（40 dispatch verb + help），校验/解析派生方式与契约条目完全一致。
  const contract = verb ? contractOf(verb) : undefined;
  const valueFlags = new Set([...VALUE_FLAG_NAMES_GLOBAL, ...Object.entries(verb ? acceptedFlagsOf(verb) : {}).filter(([, spec]) => spec.kind === 'value').map(([name]) => name)]);
  const { positional, flags, duplicates, emptyValues } = parseCliArgs(argv, { valueFlags });
  const [, sub, ...rest] = positional;
  if (!verb || verb === 'help' || flags.help === true && !verb) {
    printHelp(null);
    return 0;
  }
  if (flags.help || flags.h) {
    printHelp(verb);
    return 0;
  }
  // 用法校验必须先于项目根解析（REQ-056）：未知/重复/空值 flag、互斥、位置参数越界。
  assertContract(verb, positional.slice(1), flags, duplicates, emptyValues);
  const projectStart = flags.project ? path.resolve(String(flags.project)) : process.cwd();
  // REQ-065：maintenance marker 存在期间治理动词一律拒跑（exit 3 降级语义）——
  // 维护中的安装面是未知态，任何治理判定都不可信。
  const needProject = async () => {
    const ctx = await loadContext(await requireProjectRoot(projectStart));
    await assertNoMaintenance(ctx.root);
    return ctx;
  };

  // strength（REQ-052）：独立于 switch 路由——selftest contractCheck 双向钉死的路由集
  // 与 CONTRACTS 键集同被现状表测试锁定，strength 待测试作者扩表后方可注册为 case。
  if (verb === 'strength') {
    const ctx = await needProject();
    return await dispatchStrength(ctx, sub, flags);
  }

  switch (verb) {
    case 'install':
    case 'upgrade':
    case 'uninstall': {
      const target = await assertSafeTarget(sub ?? flags.target);
      if (verb === 'uninstall') {
        const plan = await planUninstall(target);
        const result = await applyUninstallPlan(plan, Boolean(flags['dry-run']));
        const counts = {};
        for (const op of result.operations) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
        printResult('卸载完成', [`目标：${target}`, `操作统计：${JSON.stringify(counts)}`, result.dryRun ? '（dry-run，未落盘）' : '']);
        return 0;
      }
      await assertInstallSource();
      const sourceManifest = await buildSourceManifest();
      const plan = await planInstall(target, sourceManifest, verb);
      const result = await applyInstallPlan(plan, Boolean(flags['dry-run']));
      const counts = {};
      for (const op of result.operations) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
      const lines = [
        `目标：${target}`,
        `操作统计：${JSON.stringify(counts)}`,
        `回执：${INSTALL_RECEIPT_REL}`,
        result.dryRun ? '（dry-run，未落盘）' : ''
      ];
      // --hooks：显式请求挂载第二道闸（git hooks）。安装主事务已成功，
      // 挂载失败是可见降级（warning），不回滚安装。
      if (flags.hooks) {
        if (result.dryRun) {
          lines.push('hooks：（dry-run，未执行挂载）');
        } else {
          const mounted = await mountGitHooks(target);
          lines.push(mounted.mounted
            ? `hooks：已挂载 core.hooksPath=${mounted.hooksPath}（三钩子 chmod 755 + git add --chmod=+x${mounted.executableStaged ? ' 已入 index' : ' 入 index 失败，请手工 git add --chmod=+x'}）`
            : `warning：--hooks 未生效——${mounted.reason}；第二道闸未挂载（可稍后重跑 ${verb} . --hooks）`);
        }
      }
      printResult(`${verb === 'install' ? '安装' : '升级'}完成`, lines);
      return 0;
    }
    case 'manifest': {
      // --write 与 --check 互斥由契约 conflicts 集中校验（assertContract 已先行）。
      const mode = flags.write ? 'write' : 'check';
      // 源仓（kimi.plugin.json+.kimi-base/runtime+.kimi-code）优先走源仓模式；
      // 源仓自托管时根上也有 harness.json，不能让 findProjectRoot 抢成已安装模式。
      const projectRoot = (await isSourceRepo(projectStart)) ? null : await findProjectRoot(projectStart);
      const result = await manifestCommand(mode, projectRoot);
      printResult(result.ok ? `manifest ${mode} 通过` : `manifest ${mode} 失败`, [
        `模式：${result.scope === 'installed' ? '已安装项目' : '源仓'}；文件数：${result.files}；digest：${result.digest}`,
        ...(result.errors ?? [])
      ]);
      return result.ok ? 0 : 2;
    }
    case 'doctor': {
      const result = await doctorCommand(sub ?? (flags.target ? String(flags.target) : undefined));
      printResult(result.ok ? 'doctor 通过' : 'doctor 发现问题', [
        `模式：${result.mode}；目标：${result.target}`,
        ...result.errors.map((item) => `ERROR ${item}`),
        ...result.warnings.map((item) => `warning ${item}`)
      ]);
      return result.ok ? 0 : 2;
    }
    case 'pack-check': {
      const result = await packCheckCommand();
      printResult(result.ok ? 'pack-check 通过' : 'pack-check 失败', [
        `发布面文件数：${result.files}`,
        ...result.errors.map((item) => `ERROR ${item}`)
      ]);
      return result.ok ? 0 : 2;
    }
    case 'task': {
      const ctx = await needProject();
      if (sub === 'start') {
        const task = await taskStart(ctx, { goal: flags.goal, owned: flags.owned, risk: flags.risk, author: flags.author });
        printResult('任务已开始', [
          `id：${task.id}`,
          `risk：${task.risk}；owned：${task.ownedPaths.join(', ')}`,
          `基线：base=${task.baseline.baseCommit.slice(0, 12)} fp=${task.baseline.fingerprint.slice(0, 12)}（${Object.keys(task.baseline.knownHashes).length} 个文件快照${task.baseline.degraded ? '；非 git 降级' : ''}）`
        ]);
        return 0;
      }
      if (sub === 'status') {
        const state = await readTasks(ctx);
        const active = state.activeTaskId ? state.tasks[state.activeTaskId] : null;
        const lines = active
          ? [`active：${active.id}`, `目标：${active.goal}`, `risk：${active.risk}`, `owned：${active.ownedPaths.join(', ')}`, `已触碰：${active.touchedPaths.join(', ') || '无'}`, `创建于：${active.createdAt}`]
          : ['active：无'];
        const history = Object.values(state.tasks).filter((item) => item.status !== 'active').slice(-5);
        for (const item of history) lines.push(`历史：${item.id} ${item.status} ${item.completedAt ?? item.cancelledAt ?? ''}`);
        printResult('task status', lines);
        return 0;
      }
      if (sub === 'cancel') {
        const cancelled = await taskCancel(ctx);
        printResult('任务已取消', [`id：${cancelled.id}`]);
        return 0;
      }
      if (sub === 'complete') {
        const task = await getActiveTask(ctx);
        if (!task) throw usageError('当前没有 active 任务');
        // REQ-051：生效档 completionMode=forbidden 时完成门阻断（rollout=shadow 只报告不阻断）。
        const strength = await strengthCompletionCheck(ctx);
        const gate = await completionGate(ctx, task);
        const coverage = await attributeCoverage(ctx, {});
        const gaps = [...gate.gaps.map((item) => `[${item.kind ?? '-'}] ${item.check ?? '-'}：${item.reason}`)];
        for (const item of coverage.uncovered ?? []) gaps.push(`五性 uncovered：${item.attribute}(${item.tier}) ${item.reason}`);
        if (strength?.blocked) gaps.push(`completionMode: forbidden —— 当前强度档 ${strength.profile} 禁止 task complete（强度策略 rollout: enforce；切换档位：strength set --profile <档名>）`);
        if (!gate.ok || !coverage.ok || strength?.blocked) {
          printResult('完成门阻断（exit 2）', [`缺口 ${gaps.length} 项：`, ...gaps.map((item) => `- ${item}`)]);
          return 2;
        }
        await updateState(ctx, TASKS_FILE, emptyTasks(), (state) => {
          const current = state.tasks[task.id];
          return {
            ...state,
            activeTaskId: null,
            tasks: { ...state.tasks, [task.id]: { ...current, status: 'completed', completedAt: nowIso(), updatedAt: nowIso(), completion: { fingerprint: gate.fingerprint } } }
          };
        });
        printResult('任务完成', [`id：${task.id}`, `fingerprint：${gate.fingerprint.slice(0, 16)}`, '完成门：全部 required kinds 有 fresh 证据；五性覆盖通过']);
        return 0;
      }
      throw usageError(`未知 task 子命令：${sub ?? '<缺>'}（start/status/complete/cancel）`);
    }
    case 'gate': {
      const ctx = await needProject();
      const result = await runGate(ctx, { risk: flags.risk ? String(flags.risk) : undefined, kind: flags.kind ? String(flags.kind) : undefined, dryRun: Boolean(flags['dry-run']) });
      if (result.dryRun) {
        printResult('gate 计划（dry-run 不执行）', [
          `risk=${result.plan.risk} kinds=${result.plan.kinds.join(',')}`,
          ...result.plan.checks.map((item) => `- ${item.id}（${item.kind}）${item.display ?? '缺命令→BLOCKED'}`),
          ...result.plan.missingKinds.map((kind) => `- kind ${kind} 无任何检查 → BLOCKED`)
        ]);
        return 0;
      }
      printResult(`gate ${result.overall}`, [
        `risk=${result.plan.risk} fingerprint=${result.fingerprint.slice(0, 16)} fast=${result.fastActive}`,
        `统计：PASS=${result.counts.PASS} FAIL=${result.counts.FAIL} BLOCKED=${result.counts.BLOCKED} SKIPPED=${result.counts.SKIPPED}`,
        ...result.receipts.map((item) => {
          const line = `- ${item.status} ${item.checkId}（${item.checkKind}）${item.reason ? `：${item.reason}` : ''}${item.evidencePath ? ` 证据=${item.evidencePath}` : ''}`;
          // REQ-060：FAIL/BLOCKED 条目必须带可执行 nextStep（修复指令体），不得只报症状。
          if (item.status !== 'FAIL' && item.status !== 'BLOCKED') return line;
          const nextStep = item.status === 'FAIL'
            ? nextStepFor('gate-fail', { risk: result.plan.risk, checkId: item.checkId, command: item.argvDisplay })
            : nextStepFor('gate-blocked', { risk: result.plan.risk, checkId: item.checkId, kind: item.checkKind, command: item.argvDisplay, missingKind: item.checkId.endsWith(':__missing__') });
          return `${line}；nextStep：${nextStep}`;
        })
      ]);
      return result.overall === 'PASS' ? 0 : 2;
    }
    case 'quality':
    case 'waiver': {
      const ctx = await needProject();
      // 顶层 waiver 动词是 quality waiver 的别名（两种叫法都合法）。
      const effectiveSub = verb === 'waiver' ? 'waiver' : sub;
      const effectiveRest = verb === 'waiver' ? [sub, ...rest].filter(Boolean) : rest;
      if (effectiveSub === 'status') {
        const coverage = await attributeCoverage(ctx, {});
        printResult(coverage.ok ? 'quality status：覆盖通过' : 'quality status：存在 uncovered（exit 2）', [
          `范围：${coverage.scope}；fingerprint=${coverage.fingerprint.slice(0, 16)}`,
          ...coverage.attributes.map((item) => `- ${item.covered ? 'covered' : 'UNCOVERED'} ${item.attribute}(${item.tier}) [${item.modules.join(',')}] ${item.reason}${item.covered ? '' : `；nextStep：${nextStepFor('quality-uncovered', { attribute: item.attribute, reason: item.reason })}`}`),
          coverage.deferredByFastMode.length ? `Fast Mode 延期：${coverage.deferredByFastMode.join(', ')}` : ''
        ]);
        return coverage.ok ? 0 : 2;
      }
      if (effectiveSub === 'waiver') {
        const action = effectiveRest[0];
        if (action === 'create') {
          const waiver = await waiverCreate(ctx, { checkId: flags.check, approver: flags.approver, reason: flags.reason, expires: flags.expires, compensation: flags.compensation });
          printResult('waiver 已创建', [
            `id：${waiver.id}`, `check：${waiver.checkId}`, `fingerprint：${waiver.fingerprint.slice(0, 16)}`,
            `expires：${waiver.expiresAt}`, `approver：${waiver.approver}`, `compensation：${waiver.compensation}`
          ]);
          return 0;
        }
        if (action === 'list') {
          const waivers = await waiverList(ctx);
          printResult('waiver 列表', waivers.length
            ? waivers.map((item) => `- ${item.id} check=${item.checkId} ${item.validity.active ? '有效' : `失效（${item.validity.why}）`} expires=${item.expiresAt} approver=${item.approver}`)
            : ['（无 waiver）']);
          return 0;
        }
        throw usageError(`未知 waiver 动作：${action ?? '<缺>'}（create/list）`);
      }
      throw usageError(`未知 ${verb} 子命令：${effectiveSub ?? '<缺>'}（status/waiver）`);
    }
    case 'arch': {
      const ctx = await needProject();
      if (sub === 'check') {
        const result = await archCheckRun(ctx, { scan: Boolean(flags.scan) });
        printResult(result.ok ? 'arch check 通过' : 'arch check 发现违规（exit 1）', result.report.split('\n'));
        return result.ok ? 0 : 1;
      }
      if (sub === 'baseline') {
        if (!flags.write) throw usageError('arch baseline 需要 --write（可选 --reason "..."）');
        const result = await archBaselineWrite(ctx, flags.reason ? String(flags.reason) : undefined);
        printResult('arch baseline 已写入', [`路径：${result.path}`, `条目：${result.written}`, `清理 stale：${result.droppedStale}`]);
        return 0;
      }
      if (sub === 'trend') {
        const mode = flags.record ? 'record' : flags.gate ? 'gate' : null;
        if (!mode) throw usageError('arch trend 需要 --record 或 --gate');
        const result = await archTrend(ctx, mode);
        if (mode === 'record') {
          printResult('arch trend 已记录', [`快照：${JSON.stringify(result.recorded)}`, `累计快照：${result.total}`, `历史最优（bestEver 已持久化）：${JSON.stringify(result.bestEver)}`]);
          return 0;
        }
        printResult(result.ok ? 'arch trend --gate 通过' : 'arch trend --gate 触发棘轮（exit 1）', [
          result.report,
          result.firstRun ? '基线：无历史快照（baseline:true）' : `基线（逐指标历史最优）：${JSON.stringify(result.baseline)}`,
          `当前：${JSON.stringify(result.current)}`
        ]);
        return result.ok ? 0 : 1;
      }
      throw usageError(`未知 arch 子命令：${sub ?? '<缺>'}（check/baseline/trend）`);
    }
    case 'adr': {
      if (sub !== 'check') throw usageError(`未知 adr 子命令：${sub ?? '<缺>'}（check）`);
      const ctx = await needProject();
      const result = await adrCheckRun(ctx);
      printResult(result.ok ? 'adr check 通过' : 'adr check 发现幽灵引用（exit 1）', result.report.split('\n'));
      return result.ok ? 0 : 1;
    }
    case 'catalog': {
      const ctx = await needProject();
      if (sub === 'lint') {
        const result = await lintCatalog(ctx, flags.paths ? csv(flags.paths) : []);
        printResult(result.ok ? 'catalog lint 通过' : 'catalog lint 发现违规（exit 1）', [
          `路径总数：${result.total}；分类统计：${JSON.stringify(result.counts)}`,
          ...result.failures.slice(0, 100).map((item) => `- ${item.path}：${item.reason ?? item.classification}`)
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'discover') {
        const depth = flags.depth !== undefined ? Number(flags.depth) : 2;
        const level = flags.level !== undefined ? String(flags.level) : 'L1';
        const result = await discoverCatalog(ctx, { depth, level });
        if (!flags.write) {
          printResult('catalog discover（dry-run；--write 落盘）', [
            `级别：${result.level}（渐进采用阶梯 L0 最小钩子面 / L1 缺省现状 / L2 +五性·arch / L3 全量+fleet）`,
            `tracked ${result.trackedPaths} 路径 → 提案模块 ${result.proposedModules} 个；真实 import 边 ${result.realEdges} 条（未解析 specifier ${result.unresolvedSpecifiers} 个，如实计数）`,
            `检测到检查命令 ${result.detectedChecks.length} 个：${result.detectedChecks.map((item) => item.id).join(', ') || '无'}`,
            ...(result.fleet ? [`fleet：${result.fleet}`] : []),
            ...result.needsDecision.map((item) => `- needsDecision ${item.field}：${item.why}`),
            ...(result.stillUnmappedCount ? [`- 仍无归属 ${result.stillUnmappedCount} 个：${result.stillUnmapped.join(', ')}`] : []),
            JSON.stringify({ draft: result.draft, attributeProposals: result.attributeProposals, detectedChecks: result.detectedChecks, needsDecision: result.needsDecision }, null, 2)
          ]);
          return 0;
        }
        const written = await discoverWrite(ctx, result);
        printResult('catalog discover 已写入', [
          `级别：${result.level}`,
          `路径：${written.written}${written.isDraft ? '（已有 catalog，草案写为 draft——人工合并后才生效；绝不覆盖人工策展）' : ''}`,
          `模块数：${written.modules}；needsDecision ${result.needsDecision.length} 项待人决（见 dry-run 输出）`,
          ...(result.fleet ? [`fleet：${result.fleet}`] : [])
        ]);
        return 0;
      }
      throw usageError(`未知 catalog 子命令：${sub ?? '<缺>'}（lint/discover）`);
    }
    case 'fitness': {
      const ctx = await needProject();
      const paths = flags.path ? csv(flags.path) : rest.length ? [sub, ...rest] : [];
      const result = await runFitness(ctx, {
        paths: paths.length ? paths : undefined,
        staged: Boolean(flags.staged),
        all: Boolean(flags.all)
      });
      printResult(`fitness ${result.status}${result.ok ? '' : '（exit 1）'}`, result.report.split('\n').slice(1));
      return result.ok ? 0 : 1;
    }
    case 'impact': {
      const ctx = await needProject();
      const useGit = Boolean(flags.git);
      const paths = [sub, ...rest].filter(Boolean);
      if (!useGit && !paths.length) throw usageError('impact 需要路径参数或 --git');
      const result = await impactAnalysis(ctx, { paths: useGit ? undefined : paths, risk: flags.risk ? String(flags.risk) : undefined });
      printResult('impact 分析', [
        `变更路径：${result.changedPaths.length}；直接模块：${result.directModules.join(', ') || '无'}`,
        `受影响模块：${result.affectedModules.join(', ') || '无'}${result.expandedToAll ? `（保守扩散：${result.expansionReasons.join('；')}）` : ''}`,
        `检查计划（risk=${result.risk}，planHash=${result.planHash.slice(0, 16)}）：`,
        ...result.plan.checks.map((item) => `- ${item.id}（${item.kind}）← ${item.reasons.join(', ')}`)
      ]);
      return 0;
    }
    case 'context': {
      if (sub !== 'pack') throw usageError(`未知 context 子命令：${sub ?? '<缺>'}（pack）`);
      const ctx = await needProject();
      const pack = await buildContextPack(ctx, { budget: flags.budget ? Number(flags.budget) : undefined, focus: flags.focus });
      printResult('context pack 完成', [
        `packHash=${pack.packHash.slice(0, 16)}；预算 ${pack.budget.used}/${pack.budget.total} 字符${pack.budget.cappedBy ? `（请求 ${pack.budget.requested}，被 ${pack.budget.cappedBy} 封顶）` : ''}`,
        `入包 ${pack.included.length} 个；omitted ${pack.omitted.length} 个；存储：${pack.storedAt}`,
        ...pack.included.map((item) => `+ ${item.path}（${item.chars} 字符${item.truncated ? '，截断' : ''}）← ${item.why}`),
        ...pack.omitted.map((item) => `- omitted ${item.path}：${item.reason}`)
      ]);
      return 0;
    }
    case 'receipt': {
      if (sub !== 'verify') throw usageError(`未知 receipt 子命令：${sub ?? '<缺>'}（verify）`);
      const ctx = await needProject();
      const result = await receiptVerify(ctx);
      // 分级：篡改/断链/缺失/漂移 → exit 2；仅陈旧（链完好、指纹已移动）→ exit 4。
      const code = result.ok ? 0 : result.staleOnly ? 4 : 2;
      printResult(result.ok ? 'receipt verify 通过' : result.staleOnly ? 'receipt verify：证据已陈旧（exit 4）' : 'receipt verify 失败（exit 2）', [
        `账本条目：${result.entries}（归档段 ${result.archives}）；证据校验：${result.evidenceChecked}；链：${result.chain.intact ? '完好' : '断裂'}`,
        ...result.problems.map((item) => `- ${item}`),
        ...result.stale.map((item) => `- ${item}`),
        ...(result.notes ?? []).map((item) => `- note ${item}`),
        ...(result.staleNote ? [`- note ${result.staleNote}`] : [])
      ]);
      return code;
    }
    case 'review': {
      const ctx = await needProject();
      if (sub === 'start') {
        const result = await reviewStart(ctx, { base: flags.base });
        const session = result.session;
        printResult('评审会话已开启', [
          `绑定：${session.range ? `range ${session.range.base}...HEAD（head=${session.range.head.slice(0, 12)}）` : `diffHash=${session.diffHash.slice(0, 16)} base=${session.baseCommit.slice(0, 12)}`}；范围 ${session.scope.paths.length} 个路径`,
          `剖面：${session.profile}；召集 lens：${session.requiredLenses.map((name) => `${name}(阶段${stageOfLens(name)}:${REVIEW_STAGES[stageOfLens(name)]})`).join(' ')}`,
          ...(session.excludedLenses.length ? session.excludedLenses.map((item) => `- 剔除 ${item.lens}：${item.reason}`) : []),
          `轮次：第 ${session.lineage.length + 1} 轮（lineage ${session.lineage.length} 条）`,
          result.previousVerdict ? `上轮裁决：${result.previousVerdict.verdict}（已入 lineage）` : ''
        ]);
        return 0;
      }
      if (sub === 'blue') {
        const result = await recordBlue(ctx, await readStdinJson('review blue'));
        printResult('blue 自证已记录', [`claims：${result.claims} 条（自述只作红队靶子，不作通过依据）`]);
        return 0;
      }
      if (sub === 'lens') {
        const name = rest[0];
        if (!name) throw usageError('review lens 需要 lens 名（review lens <name> [--ad-hoc]，stdin 读 findings JSON）');
        const result = await recordLens(ctx, name, await readStdinJson('review lens'), { adHoc: Boolean(flags['ad-hoc']), reviewer: flags.reviewer });
        if (result.refused) {
          printResult('lens 报到被拒（exit 1）', [`stageGated:${result.stageGated === true}`, result.reason]);
          return 1;
        }
        printResult('lens 已报到', [
          `lens：${result.lens}${result.adHoc ? '（ad-hoc 额外证据，不占应到清单）' : ''}；findings：${result.findings}（error=${result.counts.error} warning=${result.counts.warning} info=${result.counts.info}）${result.unable ? '；unable:true' : ''}`
        ]);
        return 0;
      }
      if (sub === 'verdict') {
        const result = await reviewVerdict(ctx, { reviewer: flags.reviewer, notes: flags.notes });
        printResult(`评审裁决：${result.verdict}`, [
          `round=${result.round}/${result.maxRounds}；stage=${result.stage}（${REVIEW_STAGES[result.stage]}）；final:${result.final}`,
          `authorshipEnforced:${result.authorshipEnforced}`,
          // 降级场景（authorshipEnforced=false）selfReview 仍会计算——只在真拒判时打印，防 ACCEPT 与拒判文案同屏矛盾。
          ...(result.verdict === 'SELF_REVIEW_REJECTED' && result.selfReview?.length ? [`作者自审：lens 执行者 ${result.selfReview.join(', ')} 属于本 diff 作者集（task 作者 ∪ range 提交者）——拒出 ACCEPT，请换独立评审者重报 lens 后再裁决`] : []),
          ...result.errorFindings.slice(0, 20).map((finding) => `- error [${finding.lens}] ${finding.location ?? finding.reproduction ?? ''}：${finding.message}`),
          ...(result.unableLenses.length ? [`无法结论的应到 lens：${result.unableLenses.join(', ')}`] : []),
          ...(result.escalate ? ['escalate:true'] : []),
          result.receipt ? `回执：已写入账本与 receipts 镜像（kind:review id=${result.receipt.id}）` : '回执：未写（非终审 ACCEPT 或其他裁决；消费者只认回执，不认本退出码）',
          `建议：${result.advice}`
        ]);
        return result.exitCode;
      }
      if (sub === 'status') {
        const result = await reviewStatus(ctx);
        const session = result.session;
        printResult('review status', [
          `新鲜度：${result.fresh ? 'fresh' : `stale（${result.staleReason}）`}；当前阶段：${result.stage}（${REVIEW_STAGES[result.stage]}）`,
          `绑定：${session.range ? `range ${session.range.base}...${session.range.head.slice(0, 12)}` : `diffHash=${session.diffHash.slice(0, 16)}`}；剖面：${session.profile ?? 'team'}`,
          `已报到：${result.reported.join(', ') || '无'}；未报到：${result.pending.join(', ') || '无'}`,
          `blue：${session.blue ? `已自证（${session.blue.claims.length} 条）` : '未自证'}；裁决：${session.verdict ? `${session.verdict.verdict}（round ${session.verdict.round}）` : '未裁决'}`,
          `backlog 结转：${result.carriedBacklog} 条${result.expiredBacklog ? `（${result.expiredBacklog} 条已过期）` : ''}`
        ]);
        return 0;
      }
      if (sub === 'team') {
        const result = await reviewTeam(ctx);
        printResult('评审团队', [
          `来源：${result.source === 'session' ? '当前会话（召集时定格）' : '按当前变更面现算'}；剖面：${result.profile}`,
          ...result.required.map((name) => `- 召集 ${name}（阶段 ${stageOfLens(name)}：${REVIEW_STAGES[stageOfLens(name)]}）`),
          ...result.excluded.map((item) => `- 剔除 ${item.lens}：${item.reason}`)
        ]);
        return 0;
      }
      if (sub === 'backlog') {
        const action = rest[0];
        if (action === 'add') {
          const result = await backlogAdd(ctx, await readStdinJson('review backlog add'));
          printResult('backlog 已入账', [`id：${result.entry.id}；owner：${result.entry.owner}；expiry：${result.entry.expiry}；累计 ${result.count} 条（跨会话存活）`]);
          return 0;
        }
        if (action === 'list') {
          const result = await backlogList(ctx);
          printResult('backlog 列表', result.count
            ? result.entries.map((entry) => `- ${entry.id} [${entry.lens}] ${entry.summary}（owner=${entry.owner} expiry=${entry.expiry}${entry.expired ? ' 已过期' : ''}）`)
            : ['（无 backlog 条目）']);
          return 0;
        }
        throw usageError(`未知 review backlog 动作：${action ?? '<缺>'}（add/list）`);
      }
      if (sub === 'pack') {
        const result = await reviewPack(ctx);
        printResult('评审证据包已生成', [
          `路径：${result.packPath}${result.spillPath ? `；diff 溢出：${result.spillPath}` : ''}`,
          `范围：${result.base}...HEAD（base 来源 ${result.baseSource}）；commit ${result.commits} 个；diff ${result.diffLines} 行`,
          `删除审计：${result.deleted.length ? result.deleted.join(', ') : '无'}；未跟踪：${result.untracked.length ? result.untracked.join(', ') : '无'}`
        ]);
        return 0;
      }
      throw usageError(`未知 review 子命令：${sub ?? '<缺>'}（start/blue/lens/verdict/status/team/backlog/pack）`);
    }
    case 'fast': {
      const ctx = await needProject();
      const action = sub ?? 'status';
      if (!['on', 'off', 'status'].includes(action)) throw usageError('fast 需要 on [hours]|off|status');
      const hours = rest[0] ? Number(rest[0]) : undefined;
      const result = await fastModeSet(ctx, action, hours);
      if (action === 'status') {
        const remainHours = result.active ? Math.max(0, (result.expiresMs - Date.now()) / 3600000) : 0;
        printResult('fast status', [
          result.active
            ? `Fast Mode 生效中：至 ${result.expiresAt}（剩余约 ${remainHours.toFixed(1)} 小时 / TTL ${Math.ceil(remainHours)}h）`
            : result.expired ? `Fast Mode 已过期（${result.expiresAt}），视同关闭` : 'Fast Mode 关闭（off）',
          'protected 属性/kind（security/safety/privacy）免疫；SKIPPED 留痕',
          'fast 门不能关闭 task/release：借账须 fast off 后重跑完整 gate 偿还'
        ]);
      } else {
        printResult(`fast ${action} 完成`, action === 'on'
          ? [`生效至 ${result.expiresAt}`, '借账提醒：窗口内的 SKIPPED 带 fastWindow 印记，不能关闭 task/release；还债 = fast off 后重跑完整 gate']
          : ['已关闭']);
      }
      return 0;
    }
    case 'risk': {
      if (sub && sub !== 'scan') throw usageError(`未知 risk 子命令：${sub}`);
      const ctx = await needProject();
      const result = await riskScan(ctx);
      printResult(result.ok ? 'risk scan：无高危' : 'risk scan：存在高危项', [
        `active 任务：${result.activeTask ?? '无'}；证据文件：${result.evidenceCount}`,
        ...(result.risks.length ? result.risks.map((item) => `- [${item.level}] ${item.kind}：${item.detail}`) : ['- 未发现风险'])
      ]);
      return result.ok ? 0 : 2;
    }
    case 'gate-audit': {
      const ctx = await needProject();
      const result = await gateAudit(ctx);
      printResult('gate-audit', [
        `拦截记录总数：${result.totalInterceptions}`,
        ...result.rules.map((item) => `- ${item.kind}:${item.rule} 拦截 ${item.count} 次（${item.firstTs ?? '?'} ~ ${item.lastTs ?? '?'}）`),
        ...(result.neverFired.length ? [`从未拦过的闸（要么拿证据要么撤掉）：`, ...result.neverFired.map((item) => `- ${item.kind}:${item.rule}`)] : ['全部已知闸均有拦截记录']),
        result.guidance
      ]);
      return 0;
    }
    case 'retention': {
      if (sub !== 'prune') throw usageError(`未知 retention 子命令：${sub ?? '<缺>'}（prune）`);
      const ctx = await needProject();
      const result = await retentionPrune(ctx, { dryRun: Boolean(flags['dry-run']) });
      printResult(`retention prune ${result.dryRun ? '（dry-run）' : '完成'}`, [
        `evidence：保留 ${result.evidence.kept}，删除 ${result.evidence.deleted.length}`,
        ...result.evidence.deleted.slice(0, 20).map((item) => `- 删 ${item}`),
        `context：保留 ${result.context.kept}，删除 ${result.context.deleted.length}`,
        ...result.notes
      ]);
      return 0;
    }
    case 'hook': {
      if (!sub) throw usageError('hook 需要事件名（见 hook --help）');
      await dispatchHook(sub);
      return process.exitCode ?? 0;
    }
    case 'init-modules': {
      // 废弃别名（P6 起 catalog discover 取代）：转发并响亮注明，不静默改语义。
      process.stderr.write('警告：init-modules 已废弃，转发 catalog discover（语义已并轨）；请改用 catalog discover [--write]\n');
      const ctx = await needProject();
      const result = await initModulesAlias(ctx, Boolean(flags.write));
      if (result.dryRun) {
        printResult('catalog discover（dry-run；--write 落盘）', [
          `tracked ${result.result.trackedPaths} 路径 → 提案模块 ${result.result.proposedModules} 个；真实 import 边 ${result.result.realEdges} 条`,
          JSON.stringify({ draft: result.result.draft, attributeProposals: result.result.attributeProposals, detectedChecks: result.result.detectedChecks }, null, 2)
        ]);
      } else {
        printResult('catalog discover 已写入', [`路径：${result.written.written}${result.written.isDraft ? '（已有 catalog，写为 draft）' : ''}；模块数：${result.written.modules}`]);
      }
      return 0;
    }
    case 'recap': {
      const ctx = await needProject();
      const result = await recap(ctx, { budget: flags.budget !== undefined ? Number(flags.budget) : undefined });
      printResult(`recap（派生视图，不信任何摘要；${result.chars}/${result.budget} 字符${result.truncated ? '；已截断' : ''}）`, result.text.split('\n'));
      return 0;
    }
    case 'invariants': {
      const ctx = await needProject();
      const digest = await invariantsDigest(ctx);
      // 摘要即全部输出（自包含 ≤1200 字符），供压缩后直接重注入。
      process.stdout.write(digest.text);
      return 0;
    }
    case 'archive': {
      const ctx = await needProject();
      const parseKeep = (name) => {
        if (flags[name] === undefined) return undefined;
        const parsed = Number(flags[name]);
        if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`archive 的 --${name} 必须是非负整数`);
        return parsed;
      };
      const result = await archiveProgress(ctx, { apply: Boolean(flags.apply), keepDone: parseKeep('keep-done'), keepNotes: parseKeep('keep-notes') });
      printResult(`archive ${result.applied ? '完成' : '（dry-run，未落盘；加 --apply 落盘）'}`, [
        `progress.md ${result.bytes} 字节（上限 ${result.maxBytes}）；Done ${result.doneEntries} 条（保留 ${result.keepDone}）；Notes ${result.noteEntries} 条（保留 ${result.keepNotes}）`,
        ...(result.plan ?? []).map((item) => `- ${item.section}：共 ${item.total} 条，保留最新 ${item.keep} 条，移动最旧 ${item.moving} 条`),
        result.moved
          ? `合计移动 ${result.moved} 条${result.applied ? ` → ${result.archive}（## Archived 日期段），活体文件已留指针行` : ''}`
          : `— ${result.reason}`
      ]);
      return 0;
    }
    case 'sync-check': {
      const ctx = await needProject();
      const result = await syncCheck(ctx, { staged: Boolean(flags.staged), paths: flags.paths ? csv(flags.paths) : undefined });
      printResult(result.ok ? 'sync-check 通过' : 'sync-check 发现违例（exit 1）', [
        `变更面 ${result.changed} 个路径（source=${result.source}）；governed 模块路径 ${result.governed} 个；progress.md ${result.ledgerInChange ? '在' : '不在'}改动集`,
        ...(result.catalogNote ? [`note ${result.catalogNote}`] : []),
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.message}`)
      ]);
      return result.ok ? 0 : 1;
    }
    case 'spec': {
      const ctx = await needProject();
      if (sub === 'lint') {
        const result = await specLint(ctx);
        if (result.degraded) {
          printResult('spec lint 降级（exit 3）', [result.reason]);
          return 3;
        }
        printResult(result.ok ? 'spec lint 通过' : 'spec lint 发现违例（exit 1）', [
          `需求文件 ${result.files} 个；声明需求 ${result.counts.requirements} 条；error ${result.counts.error} / warning ${result.counts.warning}`,
          ...result.findings.slice(0, 100).map((item) => `- ${item.severity} [${item.code}] ${item.file ? `${item.file}${item.line ? `:${item.line}` : ''} ` : ''}${item.message}`)
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'view') {
        const result = await specView(ctx, {
          paths: flags.paths ? csv(flags.paths) : undefined,
          all: Boolean(flags.all),
          budget: flags.budget !== undefined ? Number(flags.budget) : undefined
        });
        if (result.degraded) {
          printResult('spec view 降级（exit 3）', [result.reason]);
          return 3;
        }
        printResult(`spec view（渲染 ${result.rendered} 条/省略显式 ${result.omitted.length} 条；${result.chars}/${result.budget} 字符）`, result.text.split('\n'));
        return 0;
      }
      throw usageError(`未知 spec 子命令：${sub ?? '<缺>'}（lint/view）`);
    }
    case 'trace': {
      const ctx = await needProject();
      const result = await traceRequirements(ctx);
      if (result.degraded) {
        printResult('trace 降级（exit 3）', [result.reason]);
        return 3;
      }
      printResult(result.ok ? 'trace 通过' : 'trace 未达门禁（exit 1）', [
        `覆盖率 ${(result.coverage * 100).toFixed(1)}%（verified ${result.verified}/${result.total}；门槛 ${(result.minCoverage * 100).toFixed(0)}%）`,
        ...(result.planned ? [`规划中需求 ${result.planned} 条（不计入覆盖率）：${result.plannedIds.join(', ')}`] : []),
        ...(result.plannedWithTests?.length ? [`[PLANNED_HAS_TESTS] 已被测试引用但仍标 planned（实现落地的同 commit 摘除标记）：${result.plannedWithTests.join(', ')}`] : []),
        ...(result.unverified.length ? [`未被测试引用的需求：${result.unverified.join(', ')}`] : []),
        ...(result.dangling.length ? ['悬空引用（代码/测试点名了未声明的 id）：', ...result.dangling.map((item) => `- ${item.id} ← ${item.file}`)] : []),
        ...(result.danglingInDocsCount ? [`文档悬空引用 ${result.danglingInDocsCount} 处（仅报告不拦）：`, ...result.danglingInDocs.map((item) => `- ${item.id} ← ${item.file}`)] : []),
        result.advice,
        `trace 摘要：${JSON.stringify({ ok: result.ok, coverage: result.coverage, minCoverage: result.minCoverage, total: result.total, verified: result.verified, planned: result.planned ?? 0 })}`
      ]);
      return result.ok ? 0 : 1;
    }
    case 'rules-audit': {
      const ctx = await needProject();
      const result = await rulesAudit(ctx, { files: flags.files ? csv(flags.files) : undefined });
      printResult(result.ok ? 'rules-audit 通过' : 'rules-audit 超阈（exit 1）', [
        `规则 ${result.counts.total} 条：enforced ${result.counts.enforced} / 声明 prompt-only ${result.counts.declaredPromptOnly} / 无执法 ${result.counts.unenforced}；执法率 ${(result.enforcementRatio * 100).toFixed(1)}%；阈值 ${result.counts.maxUnenforced ?? '未设（纯建议）'}`,
        ...result.findings.slice(0, 50).map((item) => `- [${item.code}] ${item.file}:${item.line} ${item.message}`),
        result.advice
      ]);
      return result.ok ? 0 : 1;
    }
    case 'skills-lint': {
      const ctx = await needProject();
      const result = await skillsLint(ctx);
      printResult(result.ok ? 'skills-lint 通过' : 'skills-lint 发现违例（exit 1）', [
        `skill ${result.counts.skills} 个；error ${result.counts.error} / warning ${result.counts.warning}${result.note ? `；${result.note}` : ''}`,
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.file ? `${item.file} ` : ''}${item.message}`)
      ]);
      return result.ok ? 0 : 1;
    }
    case 'agents-lint': {
      const ctx = await needProject();
      const result = await agentsLint(ctx);
      printResult(result.ok ? 'agents-lint 通过' : 'agents-lint 发现违例（exit 1）', [
        `AGENTS.md ${result.bytes} 字节（预算 ≤6000，REQ-059）`,
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.file ? `${item.file} ` : ''}${item.message}`)
      ]);
      return result.ok ? 0 : 1;
    }
    case 'dod': {
      const ctx = await needProject();
      const result = await runDod(ctx);
      // REQ-062 分层分组显示：inner（commit 前秒级可阻塞）→ middle（评审级可阻塞）→
      // outer（趋势健康信号性，FAIL 响亮可见但不阻断判定）。
      const TIER_LABELS = { inner: 'commit 前秒级可阻塞', middle: '评审级可阻塞', outer: '趋势健康信号性（FAIL 不阻断）' };
      const lines = [
        `统计：PASS=${result.counts.PASS} FAIL=${result.counts.FAIL} DEGRADED=${result.counts.DEGRADED} STALE=${result.counts.STALE}${result.counts.OUTER_FAIL ? `（其中 outer 层信号性 FAIL=${result.counts.OUTER_FAIL}，不阻断）` : ''}`
      ];
      for (const tier of ['inner', 'middle', 'outer']) {
        const group = result.steps.filter((step) => (step.tier ?? 'middle') === tier);
        if (!group.length) continue;
        lines.push(`== ${tier} 层（${TIER_LABELS[tier]}）==`);
        for (const step of group) {
          lines.push(`- ${step.status} ${step.id}（exit ${step.exitCode ?? 'N/A'}，${(step.durationMs / 1000).toFixed(1)}s）${step.reason ? `：${step.reason}` : ''}${step.note ? `；note ${step.note}` : ''}${step.nextStep ? `；nextStep：${step.nextStep}` : ''}`);
          for (const line of step.outputTail ?? []) lines.push(`    ${line}`);
        }
      }
      if (result.untiered?.length) lines.push(`warning：以下 matrix 检查缺 tier，已保守归入 middle 层（可阻塞）：${result.untiered.join(', ')}——请补标 tier（gate --dry-run 配置期面会强制）`);
      if (result.deduped?.length) lines.push(`note：matrix 检查 ${result.deduped.join(', ')} 与静态电池同 id 且同命令面，已去重（以电池步骤为准，同一检查只跑一遍）`);
      if (result.collapsed?.length) lines.push(`note：matrix 检查 ${result.collapsed.join(', ')} 与静态电池同 id 但命令面不同，已各自执行且同结果 PASS——重复确认折叠显示，不占步骤行（异结果会响亮单列）`);
      if (result.counts.OUTER_FAIL) lines.push(`outer 层 FAIL ${result.counts.OUTER_FAIL} 个：趋势健康信号，响亮可见但不阻断 dod 判定（inner/middle 层 FAIL 才阻断）`);
      if (result.counts.FAIL > result.counts.OUTER_FAIL) lines.push('存在 FAIL 步骤：dod 未达成（exit 2）');
      else if (result.counts.DEGRADED) lines.push('存在 DEGRADED 步骤：降级不是通过（exit 3），请补配置后重跑');
      if (result.counts.STALE) lines.push('存在 STALE 步骤：证据陈旧不是完整性失败——新鲜度归 release 管（receipt-fresh），完整性归 dod 管；dod 不因此阻断，但发布前必须刷新证据');
      // 头条诚实（修复轮）：outer 有 FAIL 时不得是裸「dod 通过」——必须带限定与计数。
      const headline = result.ok
        ? (result.counts.OUTER_FAIL
          ? `dod 通过（inner/middle 全绿；outer 有 ${result.counts.OUTER_FAIL} 项 FAIL 响亮可见——趋势健康信号不阻断）`
          : 'dod 通过')
        : result.counts.FAIL > result.counts.OUTER_FAIL ? 'dod 未达成（exit 2）' : 'dod 降级（exit 3）';
      printResult(headline, lines);
      return result.exitCode;
    }
    case 'cochange': {
      const ctx = await needProject();
      const result = await cochangeAnalysis(ctx, {
        limit: flags.limit !== undefined ? Number(flags.limit) : undefined,
        minPairs: flags['min-pairs'] !== undefined ? Number(flags['min-pairs']) : undefined,
        ratio: flags.ratio !== undefined ? Number(flags.ratio) : undefined
      });
      printResult(result.ok ? 'cochange 通过' : 'cochange 发现边界嫌疑（exit 1）', [
        `窗口 ${result.commits} 个提交：可分析 ${result.analysed}，横扫排除 ${result.sweeping}；涉及模块 ${result.modules} 个`,
        ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.message}`),
        `建议：${result.advice}`
      ]);
      return result.ok ? 0 : 1;
    }
    case 'budget': {
      const ctx = await needProject();
      const result = await assessBudget(ctx, {
        staged: Boolean(flags.staged),
        baseline: flags.baseline ? String(flags.baseline) : null
      });
      if (result.degraded) {
        printResult('budget 降级（exit 3）', [result.reason, `指标：${JSON.stringify(result.metrics)}`]);
        return 3;
      }
      printResult(result.ok ? 'budget 通过' : 'budget 超支（exit 1）', [
        `口径：${result.source}；指标：${JSON.stringify(result.metrics)}；上限：${JSON.stringify(result.limits)}`,
        ...result.findings.map((item) => `- 超限 ${item.metric}：实际 ${item.actual} > 上限 ${item.limit}`),
        result.advice
      ]);
      return result.ok ? 0 : 1;
    }
    case 'fleet': {
      // fleet 治理仓群（组级 fleet.json），不要求当前目录是 kimi-base 项目。
      const state = await requireFleet(projectStart, flags.fleet ? String(flags.fleet) : null);
      if (sub === 'lint') {
        const result = fleetLint(state);
        printResult(result.ok ? 'fleet lint 通过' : 'fleet lint 发现违例（exit 1）', [
          `fleet：${state.file}；仓库 ${result.counts.repos} 个；契约 ${result.counts.contracts} 个；error ${result.counts.error} / warning ${result.counts.warning}`,
          ...result.findings.map((item) => `- ${item.severity} [${item.code}] ${item.message}`)
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'impact') {
        const contract = rest[0];
        if (!contract) throw usageError('fleet impact 需要契约 id（fleet impact <contract>）');
        const result = fleetImpact(state, contract);
        if (result.degraded) {
          printResult('fleet impact 降级（exit 3）', [result.reason, `已知契约：${result.known.join(', ') || '无'}`]);
          return 3;
        }
        printResult(`fleet impact：${result.contract}`, [
          `提供方：${result.provider}；版本：${result.versions.map((item) => `${item.version}(${item.status}${item.sunset ? ` sunset=${item.sunset}` : ''})`).join(', ')}`,
          `直接消费者：${result.directConsumers.join(', ') || '无'}；传递消费者：${result.transitiveConsumers.join(', ') || '无'}`,
          ...result.propagation.map((item) => `- 传播 ${item.from} --${item.via}--> ${item.to}`),
          `coordinationCost = ${result.coordinationCost}（必须一起发布的仓数——这个数字就是决策）`,
          `建议：${result.advice}`
        ]);
        return 0;
      }
      if (sub === 'status') {
        const result = await fleetStatus(state, { deep: Boolean(flags.deep) });
        const rowLine = (row) => {
          const healthy = row.exists && row.installed && row.doctorOk && (!result.deep || row.dodOk !== false);
          const detail = !row.exists ? `路径不存在（${row.path}）`
            : !row.installed ? '未安装 kimi-base 引擎'
            : `doctor exit ${row.doctorExit}${result.deep ? `；dod exit ${row.dodExit}` : ''}${row.note ? `；${row.note}` : ''}`;
          return `- ${healthy ? 'OK' : '问题'} ${row.id}：${detail}`;
        };
        printResult(result.ok ? 'fleet status 通过' : 'fleet status 有问题仓（exit 1）', [
          `fleet：${state.file}；仓库 ${result.repos} 个${result.deep ? '（--deep 含 dod）' : ''}`,
          ...result.rows.map(rowLine),
          ...(result.problems.length ? [`问题仓：${result.problems.join(', ')}`] : [])
        ]);
        return result.ok ? 0 : 1;
      }
      if (sub === 'recap') {
        const result = await fleetRecap(state, { budget: flags.budget !== undefined ? Number(flags.budget) : undefined });
        printResult(`fleet recap（${result.chars}/${result.budget} 字符${result.truncated ? '；已截断' : ''}）`, result.text.split('\n'));
        return 0;
      }
      throw usageError(`未知 fleet 子命令：${sub ?? '<缺>'}（lint/impact/status/recap）`);
    }
    case 'release': {
      const ctx = await needProject();
      const result = await releaseReadiness(ctx);
      printResult(result.ready ? 'release：READY' : 'release：NOT READY（exit 2）', [
        result.never,
        `强度 floor：${result.strength}`,
        ...result.items.map((item) => `- [${item.ok ? 'x' : ' '}] ${item.id}${item.blocking ? '（阻断）' : '（建议）'}${item.detail ? `——${item.detail}` : ''}`),
        result.ready
          ? '全部阻断条件成立。人可以据此签字、打 tag、发布。'
          : `阻断项：${result.blockers.join('、')}——先修复再谈发布。`
      ]);
      return result.ready ? 0 : 2;
    }
    case 'feedback': {
      const ctx = await needProject();
      if (sub === 'record') {
        const result = await recordFeedback(ctx, { topic: flags.topic, type: flags.type, description: flags.description, scores: flags.scores, evidence: flags.evidence });
        printResult(`feedback 已${result.created ? '记录' : '去重合并'}`, [
          `条目：${result.path}`,
          `occurrences：${result.occurrences}${result.created ? '' : '（同主题去重 +1）'}；索引：.kimi-base/feedback/FEEDBACK-INDEX.md（机器维护）`,
          ...result.warnings.map((warning) => `warning ${warning}`)
        ]);
        return 0;
      }
      if (sub === 'list') {
        const result = await listFeedback(ctx);
        if (!result.count) {
          printResult('feedback list：无条目', ['.kimi-base/feedback 为空或不存在（共 0 条）；记录入口：feedback record --topic <主题> --type <五类之一> --description <描述>', ...result.warnings.map((warning) => `warning ${warning}`)]);
          return 0;
        }
        printResult(`feedback list（${result.count} 条）`, [
          ...result.entries.map((entry) =>
            `- topic=${entry.topic} type=${entry.type} occurrences=${entry.occurrences} graduated=${entry.graduated} skipped=${entry.skipped} updated=${entry.updated ?? '-'}${entry.template ? '（示例模板）' : ''}`),
          ...result.warnings.map((warning) => `warning ${warning}`)
        ]);
        return 0;
      }
      if (sub === 'scan') {
        const result = await scanFeedback(ctx);
        const lines = [`扫描条目 ${result.scanned} 个（graduated/skipped 不计入候选面）`];
        if (result.graduation.length) {
          lines.push('毕业候选（occurrences≥3，未毕业未跳过）：');
          for (const entry of result.graduation) lines.push(`- [候选] ${entry.topic} type=${entry.type} occurrences=${entry.occurrences} — 证据：${entry.file}`);
        }
        if (result.clusters.length) {
          lines.push('聚类候选（同失败模式 type 跨 ≥3 个主题）：');
          for (const cluster of result.clusters) lines.push(`- [聚类] type=${cluster.type} 跨 ${cluster.topics.length} 个主题：${cluster.topics.join(', ')}`);
        }
        if (result.newSkills.length) {
          lines.push('新 skill 候选（repeated-operation 且 occurrences≥5，无 Skill 覆盖信号）：');
          for (const entry of result.newSkills) lines.push(`- [新 skill 候选] ${entry.topic} occurrences=${entry.occurrences} — 证据：${entry.file}`);
        }
        if (!result.graduation.length && !result.clusters.length && !result.newSkills.length) lines.push('无候选（全部条目未达阈值或已 graduated/skipped）');
        lines.push(...result.warnings.map((warning) => `warning ${warning}`));
        printResult('feedback scan（不改任何规则与有效条目；损坏条目隔离并警告）', lines);
        return 0;
      }
      if (sub === 'propose') {
        if (flags.skip !== undefined) {
          if (flags.skip === true) throw usageError('feedback propose --skip 需要 topic 值（--skip <topic>）');
          const skipped = await skipFeedback(ctx, String(flags.skip));
          printResult('feedback 已标记 skipped', [
            `条目：${skipped.path}（skipped:true；之后 scan/propose 不再报该主题）`,
            ...skipped.warnings.map((warning) => `warning ${warning}`)
          ]);
          return 0;
        }
        const result = await proposeFeedback(ctx);
        const lines = [
          '目标层优先级：可执行 check > fitness 规则 > skill 步骤 > AGENTS.md 散文（check 不开火零成本，散文每请求都付费）',
          '机制红线：引擎永不自动改规则——以下均为提议（proposal），落地恒需人工确认'
        ];
        if (!result.proposals.length) {
          lines.push('无候选可提议（先跑 feedback scan 查看候选面）');
        }
        lines.push(...result.warnings.map((warning) => `warning ${warning}`));
        let index = 0;
        for (const proposal of result.proposals) {
          index += 1;
          if (proposal.cluster) {
            lines.push(
              `提议 ${index} [聚类] type=${proposal.type} 跨 ${proposal.topics.length} 个主题：${proposal.topics.join(', ')}`,
              `  目标层：${proposal.layer}——${proposal.hint}`
            );
          } else {
            lines.push(
              `提议 ${index} [毕业候选${proposal.newSkill ? '＋新 skill 候选' : ''}] feedback id=${proposal.topic} type=${proposal.type} occurrences=${proposal.occurrences} 证据=${proposal.file}`,
              `  目标层：${proposal.layer}——${proposal.hint}`
            );
          }
        }
        printResult('feedback propose（结构化提议，未落盘任何规则）', lines);
        return 0;
      }
      throw usageError(`未知 feedback 子命令：${sub ?? '<缺>'}（record/list/scan/propose）`);
    }
    case 'selftest': {
      const result = await selftestCommand();
      return result.ok ? 0 : 1;
    }
    default:
      throw usageError(`未知动词：${verb}；运行 --help 查看全部动词`);
  }
}

export async function main() {
  try {
    const code = await dispatchCommand(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    if (error instanceof HarnessError) {
      // 退出码契约 v2 标签：1=用法/违例 2=治理阻断 3=降级 4=陈旧证据
      const label = { 1: '错误', 2: '治理阻断', 3: '降级', 4: '陈旧证据' }[error.exitCode] ?? '错误';
      process.stderr.write(`${label}[${error.code}] ${error.message}\n`);
      if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      process.exitCode = error.exitCode;
    } else {
      // 未预期异常 = 引擎错误（exit 3）：显式报错，绝不静默吞错。
      process.stderr.write(`内部错误[ENGINE_ERROR] ${error?.stack ?? error?.message ?? String(error)}\n`);
      process.exitCode = 3;
    }
  }
}
