// lib/release.mjs —— release：发布就绪 composite 判定
//
// 移植自 dsh-base context.mjs releaseReadiness。发布是 HIGH 级人工动作：
// 本命令永不打 tag、永不 push、永不建分支。它只做一件事——把人要签字的证据
// 组装出来，让人基于与门禁相同的事实做决定，而不是基于回忆。
// 静态电池唯一定义在 lib/hygiene.mjs DOD_STEPS（与 dod 动词共享，禁止第二份拷贝）。

import { contentHashOf } from './core.mjs';
import { fastModeStatus } from './fast.mjs';
import { git, gitFingerprint, requireGit } from './git.mjs';
import { DOD_STEPS, riskScan, runDod } from './hygiene.mjs';
import { latestReceipts, readLedgerEntries } from './ledger.mjs';
import { syncCheck } from './memory.mjs';
import { backlogList } from './review.mjs';
import { receiptVerify } from './verify.mjs';

// DOD_STEPS 长度仅用于报告；从 hygiene 单源读取，禁止硬编码第二份。
const DOD_STEP_COUNT = DOD_STEPS.length;

// 包裹单步：引擎内部错误不得让 release 假绿——按降级条件记账（阻断发布）。
async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, degraded: true, reason: `引擎错误：${error?.message ?? error}` };
  }
}

export async function releaseReadiness(ctx) {
  // release 的"receipt-fresh / fast-debt"条件都绑指纹——非 git 仓无法测量，降级 exit 3。
  await requireGit(ctx, 'release');
  const condition = (id, result, blocking, detail) => ({
    id,
    ok: Boolean(result) && result.ok !== false && !result.degraded,
    blocking,
    detail: detail || (result && result.reason) || null
  });

  const items = [];

  // 1. 静态电池（dod 同一份定义，子进程跑真实 CLI）。DEGRADED 也是未证明，阻断。
  //    STALE 不阻断（陈旧 ≠ 完整性失败）但必须在细节里响亮可见。
  const dod = await attempt(() => runDod(ctx));
  items.push(condition('dod-static', dod, true,
    dod.exitCode === 0
      ? `静态电池 ${dod.counts?.PASS ?? 0}/${DOD_STEP_COUNT} PASS${dod.counts?.STALE ? `，${dod.counts.STALE} 步 STALE（陈旧非完整性失败；新鲜度见 receipt-fresh）` : ''}`
      : `未全绿：${(dod.steps ?? []).filter((step) => step.status !== 'PASS').map((step) => `${step.id}=${step.status}`).join('、') || dod.reason}`));

  // 2. fast 窗口必须关闭（开着的窗口 = 证据正在延期）。
  const fast = await attempt(() => fastModeStatus(ctx));
  items.push(condition('fast-mode-closed', { ok: fast.ok !== false && !fast.active }, true,
    fast.active ? `窗口开启至 ${fast.expiresAt}` : fast.expired ? `窗口已过期（${fast.expiresAt}），视同关闭` : '关闭'));

  // 3. fast 欠账必须已还：最近一次 gate（最新指纹批次）不得带 fastWindow/SKIPPED 印记。
  const debt = await attempt(async () => {
    const ledger = await readLedgerEntries(ctx);
    const verifications = ledger.entries.filter((entry) => !entry.__corrupt && entry.kind === 'verification');
    const newest = verifications.at(-1);
    if (!newest) return { ok: true, reason: '从未跑过 gate（receipt-fresh 条件会单独拦）' };
    const batch = verifications.filter((entry) => entry.fingerprint === newest.fingerprint);
    const stamped = batch.filter((entry) => entry.fastWindow || entry.status === 'SKIPPED');
    if (stamped.length) {
      return { ok: false, reason: `最近一次 gate 是 fast-mode 借账（${stamped.map((entry) => entry.checkId).join('、')} 带 fast 印记）；先 fast off 再重跑完整 gate 还债` };
    }
    return { ok: true, reason: '最近一次 gate 是完整运行' };
  });
  items.push(condition('fast-debt-repaid', debt, true));

  // 4. 账本链与证据完好（receipt verify 的篡改/断链/缺失/漂移面）。只判完整性问题、
  //    不判陈旧：stale 是新鲜度问题，归 receipt-fresh 条件管（判据与本注释一致）。
  const verify = await attempt(() => receiptVerify(ctx));
  items.push(condition('ledger-intact', { ok: (verify.problems ?? []).length === 0 && !verify.degraded }, true,
    verify.problems?.length
      ? verify.problems.slice(0, 3).join('；')
      : `${verify.entries ?? 0} 条账本条目，链完好${verify.stale?.length ? `；${verify.stale.length} 条回执陈旧（陈旧非完整性问题，由 receipt-fresh 判定）` : ''}`));

  // 5. 存在绑定当前指纹的 fresh 回执（PASS 验证 / ACCEPT 评审；runtime 窗口内也算；
  //    range 评审回执 range.head === 当前 HEAD 也算——提交后评审绑定的就是那个范围）。
  const fresh = await attempt(async () => {
    const fingerprint = await gitFingerprint(ctx);
    const head = await git(ctx, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    const headSha = head.exitCode === 0 ? head.stdout.trim() : null;
    const receipts = await latestReceipts(ctx);
    const now = Date.now();
    const isFresh = (receipt) => {
      if (receipt.contentHash !== contentHashOf(receipt)) return false;
      if (typeof receipt.validUntil === 'string' && receipt.validUntil) return Date.parse(receipt.validUntil) > now;
      // range 评审回执绑定提交范围：HEAD 未移动即 fresh（评审对象是已提交的 diff，不随工作树指纹移动）。
      if (receipt.kind === 'review' && receipt.range && headSha && receipt.range.head === headSha) return true;
      return receipt.fingerprint === fingerprint.fingerprint;
    };
    const good = [...receipts.values()].filter((receipt) => isFresh(receipt)
      && (receipt.status === 'PASS' || (receipt.kind === 'review' && receipt.verdict === 'ACCEPT')));
    if (!good.length) return { ok: false, reason: '当前指纹下没有任何 fresh PASS/ACCEPT 回执；跑 gate（高风险变更另需 review verdict 终审 ACCEPT；已提交的改动用 review start --base <ref> 做 range 评审绑定当前 HEAD）' };
    return { ok: true, reason: `${good.length} 个 fresh 回执绑定当前指纹（${fingerprint.fingerprint.slice(0, 12)}…）或 range.head=HEAD` };
  });
  items.push(condition('receipt-fresh', fresh, true));

  // 6. 三文件同步必须干净（代码动而记忆不动 = 下个会话无法恢复）。
  const sync = await attempt(() => syncCheck(ctx, {}));
  items.push(condition('sync-clean', sync, true,
    sync.ok ? `${sync.changed} 个变更路径，progress.md 同步` : (sync.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code).join('、') || sync.reason));

  // 7. 评审 backlog 不得有过期条目（挂账有截止日；过期债不许带进发布）。
  const backlog = await attempt(() => backlogList(ctx));
  items.push(condition('review-backlog', { ok: backlog.ok !== false && (backlog.expired ?? 0) === 0 }, true,
    `${backlog.count ?? 0} 条挂账，${backlog.expired ?? 0} 条过期`));

  // 8. 风险扫描（建议项，不阻断——发现要看得见，但不替人做决定）。
  const risk = await attempt(() => riskScan(ctx));
  items.push(condition('risk-scan', risk, false,
    risk.risks ? `${risk.risks.filter((item) => item.level === 'high').length} 高 / ${risk.risks.filter((item) => item.level === 'medium').length} 中 / ${risk.risks.filter((item) => item.level === 'info').length} 低` : risk.reason));

  const blockers = items.filter((item) => item.blocking && !item.ok);
  const warnings = items.filter((item) => !item.blocking && !item.ok);
  const ready = blockers.length === 0;

  return {
    ok: ready,
    ready,
    blockers: blockers.map((item) => item.id),
    warnings: warnings.map((item) => item.id),
    items,
    // 明示边界：本命令永远不执行发布动作。
    never: '本命令永不打 tag、永不 push、永不建分支——那些是 HIGH 级人工动作；这里只组装证据。'
  };
}
