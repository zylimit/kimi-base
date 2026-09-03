// lib/verify.mjs —— receipt verify（账本链 + 证据重哈希 + 新鲜度分级）
// 分级语义（退出码契约 v2）：
//   篡改/断链/缺失/漂移（TAMPERED/BROKEN/MISSING/DRIFT）→ 治理阻断 exit 2；
//   链完好但回执绑定的指纹/基线已移动（STALE）→ exit 4；
//   非 git 仓跳过指纹陈旧检测（无法测量，如实注明）。
// runtime 类回执（validUntil/time-window-<N>h）在窗口内不按指纹判 stale；窗口过期即 stale。
// range 评审回执（kind:review + range.head）绑定提交范围而非工作树指纹：HEAD 未移动即不 stale
//（评审对象是已提交的 diff），HEAD 移动才 stale。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHashOf, isPathInside, sha256 } from './core.mjs';
import { gitFingerprint } from './git.mjs';
import { latestReceipts, readLedgerEntries, receiptFileName, verifyLedgerChain } from './ledger.mjs';

export async function receiptVerify(ctx, options = {}) {
  const now = options.now ?? Date.now();
  const ledger = await readLedgerEntries(ctx);
  const chain = verifyLedgerChain(ledger.entries, { archives: ledger.archives });
  const problems = [];
  if (!chain.intact) problems.push(`BROKEN 哈希链断于第 ${chain.brokenAt + 1} 条：${chain.reason}`);
  let checked = 0;
  const latestByCheck = new Map();
  for (const entry of ledger.entries) {
    if (entry.__corrupt || entry.kind === 'anchor') continue;
    latestByCheck.set(entry.checkId, entry);
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
        problems.push(`MISSING ${entry.checkId}：证据文件缺失 ${entry.evidencePath}`);
        continue;
      }
      throw error;
    }
    if (sha256(bytes) !== entry.evidenceSha256) problems.push(`TAMPERED ${entry.checkId}：证据文件哈希不匹配 ${entry.evidencePath}`);
  }
  // receipts/ 目录是账本最新态的镜像索引；镜像与账本尾不一致 = drift。
  const receiptsMap = await latestReceipts(ctx);
  for (const [checkId, receipt] of receiptsMap) {
    if (receipt.contentHash !== contentHashOf(receipt)) {
      problems.push(`TAMPERED receipts/${receiptFileName(checkId)}：内容哈希不匹配`);
      continue;
    }
    const tail = latestByCheck.get(checkId);
    if (tail && tail.contentHash !== receipt.contentHash) {
      problems.push(`DRIFT ${checkId}：receipts/ 镜像与账本尾不一致`);
    }
  }
  // 陈旧检测：链完好、无篡改，但最新回执绑定的指纹已移动 = STALE（exit 4，区别于篡改）。
  const stale = [];
  let staleNote = null;
  const fingerprint = await gitFingerprint(ctx).catch(() => null);
  if (!fingerprint || fingerprint.degraded) {
    staleNote = '非 git 仓：无法测量指纹移动，跳过陈旧检测（降级可见）';
  } else {
    for (const [checkId, receipt] of receiptsMap) {
      if (receipt.contentHash !== contentHashOf(receipt)) continue; // 已按 TAMPERED 记账
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
    stale,
    staleNote
  };
}
