// lib/verify.mjs —— receipt verify（账本链 + 证据重哈希 + 新鲜度分级）
// 分级语义（退出码契约 v2）：
//   篡改/断链/缺失/漂移（TAMPERED/BROKEN/MISSING/DRIFT）→ 治理阻断 exit 2；
//   链完好但回执绑定的指纹/基线已移动（STALE）→ exit 4；
//   非 git 仓跳过指纹陈旧检测（无法测量，如实注明）。
// runtime 类回执（validUntil/time-window-<N>h）在窗口内不按指纹判 stale；窗口过期即 stale。
// range 评审回执（kind:review + range.head）绑定提交范围而非工作树指纹：HEAD 未移动即不 stale
//（评审对象是已提交的 diff），HEAD 移动才 stale。
// Receipt v2（REQ-053/ADR-0009）：回执另绑 policyHash/engineHash/catalogHash 三面；任一面漂移
// → STALE 并点名漂移面（链完好不算篡改）。v1 旧回执（缺新字段）按 v1 绑定面判定，缺字段不谎报篡改。
// committed 证据模式（REQ-055）：只动 .kimi-base/state/** 的证据入库提交不算漂移——证据绑定的
// 是代码内容而非提交计数；clone 换机后可直接验链。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bindingSurfaces } from './bindings.mjs';
import { contentHashOf, isPathInside, sha256, stableJson } from './core.mjs';
import { excludeStatePaths, git, gitFingerprint, splitZero } from './git.mjs';
import { latestReceipts, readLedgerEntries, readLedgerHead, receiptFileName, reconcileLedgerHead, verifyLedgerHistory } from './ledger.mjs';

// Receipt v2 绑定面清单：[字段, 中文面名]——stale 报告必须点名漂移的绑定面。
const BINDING_SURFACES = [
  ['policyHash', '策略（strength 解析输出）'],
  ['engineHash', '引擎（runtime 树 LF 归一化哈希）'],
  ['catalogHash', '架构图（module-catalog 内容）']
];

// committed 模式：HEAD 前进但非 state 路径零差异且工作树无非 state 变更 = 证据入库提交，
// 不使回执 stale。无法测量（基线提交不存在/diff 失败）→ 保守 false（维持 stale）。
// 导出供 selftest 反向锁定（无条件 true 变异会把「代码提交也算证据入库」假绿）。
export async function isEvidenceOnlyAdvance(ctx, receipt, fingerprint) {
  if (ctx.evidenceMode !== 'committed') return false;
  if (fingerprint.degraded || !Array.isArray(fingerprint.paths) || fingerprint.paths.length > 0) return false;
  const hex = /^[0-9a-f]{40}$/;
  if (!hex.test(receipt.baseCommit ?? '') || !hex.test(fingerprint.baseCommit ?? '')) return false;
  const diff = await git(ctx, ['diff', '--name-only', '-z', receipt.baseCommit, fingerprint.baseCommit, '--', '.'], { allowFailure: true });
  if (diff.status !== 'PASS' || diff.exitCode !== 0) return false;
  return excludeStatePaths(splitZero(diff.stdout)).length === 0;
}

export async function receiptVerify(ctx, options = {}) {
  const now = options.now ?? Date.now();
  const ledger = await readLedgerEntries(ctx);
  // E2：全史鉴权（归档段逐段重放 + anchor count/链尾对账），不是只验当前段——
  // 归档被剔除条目、伪造归档混入都是篡改。
  const chain = await verifyLedgerHistory(ctx);
  const problems = [];
  const notes = [];
  if (!chain.intact) problems.push(`BROKEN 账本哈希链校验失败：${chain.reason}`);
  // F2：head 锚对账（链是前缀可截断的——删尾行后剩余链合法，锚是唯一长度事实源）。
  // 旧版账本无锚：降级 note 可见，不谎报篡改。
  const head = await readLedgerHead(ctx);
  const headCheck = reconcileLedgerHead(chain, head);
  if (!headCheck.ok) problems.push(`TAMPERED ${headCheck.reason}`);
  else if (headCheck.note) notes.push(headCheck.note);
  let checked = 0;
  // 证据重哈希走当前段（retention 会清旧证据文件，归档段的重哈希会把合法清理误判 MISSING）；
  // 镜像对账锚点走全史可信前缀（F1：轮转把某 check 的账本条目全部归档后，对账不得失锚）。
  const latestByCheck = new Map();
  const historyByCheck = new Map(); // checkId → Set<contentHash>（可信全史，识别镜像回滚）
  for (const entry of chain.trusted) {
    // anchor 是轮转元数据；deferred 是贷款账本条目（REQ-054）——两者都不镜像到 receipts/，
    // 不参与镜像漂移对账（receipts/ 镜像的只是 verification/review 回执）。
    if (entry.__corrupt || entry.kind === 'anchor' || entry.kind === 'deferred') continue;
    latestByCheck.set(entry.checkId, entry);
    if (typeof entry.contentHash === 'string') {
      if (!historyByCheck.has(entry.checkId)) historyByCheck.set(entry.checkId, new Set());
      historyByCheck.get(entry.checkId).add(entry.contentHash);
    }
  }
  for (const entry of ledger.entries) {
    if (entry.__corrupt || entry.kind === 'anchor' || entry.kind === 'deferred') continue;
    if (!entry.evidencePath) continue;
    checked += 1;
    const absolute = path.resolve(ctx.root, entry.evidencePath);
    if (!isPathInside(ctx.root, absolute)) {
      problems.push(`TAMPERED ${entry.checkId}：证据路径逃逸仓库 ${entry.evidencePath}`);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // committed 模式（REQ-055/D3）：外部证据日志永不入库（脱敏边界），clone/换机后物理
        // 缺失是设计使然——decision-relevant 证据以回执内联摘要（summary/evidenceTail）
        // + evidenceSha256 随 git 走，外部 .log 降级为本地参考，缺失不判 MISSING。
        if (ctx.evidenceMode === 'committed') {
          notes.push(`${entry.checkId}：外部证据日志未随库迁移（${entry.evidencePath}）——内联摘要/尾部与 evidenceSha256 已在回执内，.log 仅本地参考`);
          continue;
        }
        problems.push(`MISSING ${entry.checkId}：证据文件缺失 ${entry.evidencePath}`);
        continue;
      }
      throw error;
    }
    if (sha256(bytes) !== entry.evidenceSha256) problems.push(`TAMPERED ${entry.checkId}：证据文件哈希不匹配 ${entry.evidencePath}`);
  }
  // receipts/ 目录是账本最新态的镜像索引。
  // - 镜像 contentHash == 账本尾：一致，无需多言。
  // - 镜像哈希在该 check 账本历史中（但非尾）：回滚 → DRIFT。
  // - 镜像哈希不在账本历史（账本外自洽镜像）：字段级对账账本尾条目——
  //   镜像只能比账本条目**少键**（v1 回执缺 v2 三键是合法兼容形态）；
  //   多出任一账本条目没有的键（E1：注入 validUntil 之类洗白 stale 的旁路）或共享键值不一致
  //   → TAMPERED（凭空伪造 fail-closed）。对账一致后，validUntil/range 等豁免分支的取值
  //   才与账本条目一致——豁免永不作用于伪造字段。
  const receiptsMap = await latestReceipts(ctx);
  for (const [checkId, receipt] of receiptsMap) {
    if (receipt.contentHash !== contentHashOf(receipt)) {
      problems.push(`TAMPERED receipts/${receiptFileName(checkId)}：内容哈希不匹配`);
      continue;
    }
    const tail = latestByCheck.get(checkId);
    if (!tail || tail.contentHash === receipt.contentHash) continue;
    if (historyByCheck.get(checkId)?.has(receipt.contentHash)) {
      problems.push(`DRIFT ${checkId}：receipts/ 镜像与账本尾不一致（镜像回滚到账本旧条目）`);
      continue;
    }
    const extra = [];
    const mismatches = [];
    for (const key of Object.keys(receipt)) {
      if (key === 'contentHash' || key === 'chain') continue; // 链位置元数据不参与对账
      if (!(key in tail)) { extra.push(key); continue; } // 多塞键：镜像不得比账本条目多键
      if (stableJson(receipt[key]) !== stableJson(tail[key])) mismatches.push(key);
    }
    if (extra.length || mismatches.length) {
      const parts = [];
      if (extra.length) parts.push(`多塞键 ${extra.join('、')}（账本条目无此键）`);
      if (mismatches.length) parts.push(`字段 ${mismatches.join('、')} 不一致`);
      problems.push(`TAMPERED receipts/${receiptFileName(checkId)}：镜像与账本尾条目字段级对账失败（${parts.join('；')}——凭空伪造的镜像）`);
    }
  }
  // 陈旧检测：链完好、无篡改，但最新回执绑定的指纹已移动 = STALE（exit 4，区别于篡改）。
  const stale = [];
  let staleNote = null;
  const fingerprint = await gitFingerprint(ctx).catch(() => null);
  if (!fingerprint || fingerprint.degraded) {
    staleNote = '非 git 仓：无法测量指纹移动，跳过陈旧检测（降级可见）';
  } else {
    // Receipt v2 绑定面按「键存在」判定版本：v1 旧回执（缺新字段）按 v1 语义判定，
    // 缺字段不是篡改证据；v2 回执任一面漂移 = stale 且点名漂移面。
    let bindings = null;
    const currentBindings = async () => {
      bindings ??= await bindingSurfaces(ctx);
      return bindings;
    };
    const short = (value) => (typeof value === 'string' ? `${value.slice(0, 12)}…` : String(value));
    for (const [checkId, receipt] of receiptsMap) {
      if (receipt.contentHash !== contentHashOf(receipt)) continue; // 已按 TAMPERED 记账
      // 策略/引擎/架构图绑定面：与指纹/range/runtime 窗口正交，v2 回执一律核验。
      for (const [field, label] of BINDING_SURFACES) {
        if (!(field in receipt)) continue; // v1 回执无此绑定面
        const current = (await currentBindings())[field];
        if (receipt[field] !== current) {
          // policyHash 失配常见根因：strength set 的 state 覆盖是本地的（不入库），换机后
          // 按入库的 strength.json 重解析即失配——报文必须给恢复一致的偿还路径（D5）。
          const guidance = field === 'policyHash'
            ? '；偿还路径：strength set --profile <档名> 恢复与回执一致，或重跑 gate 绑定当前策略'
            : '';
          stale.push(`STALE ${checkId}：${field} 已漂移（${label}绑定面变化：receipt ${short(receipt[field])} ≠ 当前 ${short(current)}）${guidance}`);
        }
      }
      if (typeof receipt.validUntil === 'string' && receipt.validUntil) {
        // runtime 类：窗口内不随指纹判 stale；窗口过期即 stale。
        if (Date.parse(receipt.validUntil) <= now) {
          stale.push(`STALE ${checkId}：runtime 证据窗口已过期（${receipt.timeWindow ?? 'time-window'} 至 ${receipt.validUntil}）`);
        }
        continue;
      }
      // range 评审回执：绑定的是提交范围（range.head）而非工作树指纹——HEAD 未移动即不 stale。
      if (receipt.kind === 'review' && typeof receipt.range?.head === 'string' && receipt.range.head) {
        if (receipt.range.head !== fingerprint.baseCommit) {
          stale.push(`STALE ${checkId}：评审绑定的 range.head 已移动（receipt ${receipt.range.head.slice(0, 12)}… ≠ 当前 HEAD ${String(fingerprint.baseCommit).slice(0, 12)}…）`);
        }
        continue;
      }
      if (typeof receipt.fingerprint === 'string' && receipt.fingerprint !== fingerprint.fingerprint) {
        // committed 模式：证据入库提交（只动 .kimi-base/state/**）不算漂移（REQ-055）。
        if (await isEvidenceOnlyAdvance(ctx, receipt, fingerprint)) continue;
        stale.push(`STALE ${checkId}：回执绑定的指纹已移动（receipt ${receipt.fingerprint.slice(0, 12)}… ≠ 当前 ${fingerprint.fingerprint.slice(0, 12)}…）`);
      }
    }
  }
  return {
    ok: problems.length === 0 && stale.length === 0,
    // staleOnly = true：无篡改/断链/缺失，仅证据陈旧 → exit 4（区别于治理阻断 exit 2）。
    staleOnly: problems.length === 0 && stale.length > 0,
    entries: ledger.entries.length,
    archives: ledger.archives,
    evidenceChecked: checked,
    chain,
    problems,
    notes,
    stale,
    staleNote
  };
}
