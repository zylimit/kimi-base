// lib/ledger.mjs —— 证据账本与回执（ledger.jsonl 哈希链 + receipts/<check>.json）
// chain = sha256(prev_chain + '\0' + contentHash)；断链即篡改，fail-closed。
// 轮转（codex-base 模式）：数据条目超过 retention.ledgerMaxEntries 时，
// 旧段整体归档为 ledger-archive-<ts>.jsonl，新段首行写 anchor
// {kind:'anchor', at, count, chain}（chain = 旧段链尾，contentHash 防篡改），
// 后续条目自 anchor.chain 续链，跨段可验。

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { atomicWrite, boundedText, contentHashOf, nowIso, readJsonFile, sha256, toPosix } from './core.mjs';
import { LEDGER_FILE } from './paths.mjs';
import { stateFile, withFileLock } from './state.mjs';

export const CHAIN_GENESIS = 'GENESIS';
export function chainLink(previous, contentHash) {
  return sha256(`${previous}\0${contentHash}`);
}

const LEDGER_ARCHIVE_PATTERN = /^ledger-archive-.+\.jsonl$/;

async function countLedgerArchives(ctx) {
  try {
    return (await readdir(ctx.stateDir)).filter((name) => LEDGER_ARCHIVE_PATTERN.test(name)).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function readLedgerEntries(ctx) {
  const filePath = stateFile(ctx, LEDGER_FILE);
  const archives = await countLedgerArchives(ctx);
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], corrupt: false, archives };
    throw error;
  }
  const entries = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ __corrupt: true, line: index + 1 });
    }
  }
  return { entries, corrupt: entries.some((entry) => entry.__corrupt), archives };
}

export function verifyLedgerChain(entries, options = {}) {
  const archives = options.archives ?? 0;
  // 截断检测（fail-closed 双向）：有归档段就必须有 anchor 续链；有 anchor 就必须有归档段。
  if (archives > 0 && (entries.length === 0 || entries[0]?.kind !== 'anchor')) {
    return { intact: false, brokenAt: 0, reason: '存在归档段但当前账本缺首行 anchor（账本被截断或清空）' };
  }
  if (archives === 0 && entries.length > 0 && entries[0]?.kind === 'anchor') {
    return { intact: false, brokenAt: 0, reason: 'anchor 存在但找不到任何归档段（anchor 被伪造或归档被删）' };
  }
  let previous = CHAIN_GENESIS;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.__corrupt) return { intact: false, brokenAt: index, reason: `第 ${index + 1} 行无法解析` };
    if (entry.kind === 'anchor') {
      if (index !== 0) return { intact: false, brokenAt: index, reason: 'anchor 只能位于账本首行' };
      if (typeof entry.chain !== 'string' || !Number.isInteger(entry.count) || typeof entry.at !== 'string') {
        return { intact: false, brokenAt: index, reason: 'anchor 缺 chain/count/at 字段' };
      }
      if (entry.contentHash !== contentHashOf(entry)) {
        return { intact: false, brokenAt: index, reason: 'anchor 内容哈希不匹配（anchor 被篡改）' };
      }
      previous = entry.chain; // 锚点携带上一段链尾，跨段续链
      continue;
    }
    if (typeof entry.contentHash !== 'string' || typeof entry.chain !== 'string') {
      return { intact: false, brokenAt: index, reason: '记录缺 contentHash/chain 字段' };
    }
    if (entry.contentHash !== contentHashOf(entry)) {
      return { intact: false, brokenAt: index, reason: '记录内容哈希不匹配（被篡改）' };
    }
    if (entry.chain !== chainLink(previous, entry.contentHash)) {
      return { intact: false, brokenAt: index, reason: '哈希链断裂（记录被删改或重排）' };
    }
    previous = entry.chain;
  }
  return { intact: true, brokenAt: null, reason: null };
}

// 追加一条带链记录（整个函数在文件锁内完成，链尾读取与追加原子化）。
export async function appendLedgerRecord(ctx, record) {
  const filePath = stateFile(ctx, LEDGER_FILE);
  return withFileLock(`${filePath}.lock`, ctx.locks, async () => {
    let previous = CHAIN_GENESIS;
    let lines = [];
    try {
      const text = await readFile(filePath, 'utf8');
      lines = text.split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]);
          if (typeof parsed.chain === 'string') { previous = parsed.chain; break; }
        } catch { /* 跳过坏行继续找链尾 */ }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const chained = { ...record, chain: chainLink(previous, record.contentHash) };
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(chained)}\n`, 'utf8');
    // 轮转：数据条目超过 retention.ledgerMaxEntries 时归档旧段、anchor 起新段。
    const cap = ctx.retention?.ledgerMaxEntries;
    if (Number.isInteger(cap) && cap > 0) {
      const isDataLine = (line) => {
        try { return JSON.parse(line).kind !== 'anchor'; } catch { return true; } // 坏行按数据行计，宁可早轮转
      };
      const dataCount = lines.filter(isDataLine).length + 1;
      if (dataCount > cap) {
        let retiredCount = dataCount;
        if (lines.length) {
          try {
            const first = JSON.parse(lines[0]);
            if (first?.kind === 'anchor' && Number.isInteger(first.count)) retiredCount = first.count + dataCount;
          } catch { /* 首行坏行按无 anchor 处理 */ }
        }
        const archivePath = stateFile(ctx, `ledger-archive-${Date.now()}-${randomBytes(3).toString('hex')}.jsonl`);
        await rename(filePath, archivePath);
        const anchor = { kind: 'anchor', at: nowIso(), count: retiredCount, chain: chained.chain };
        const anchored = { ...anchor, contentHash: contentHashOf(anchor) };
        await appendFile(filePath, `${JSON.stringify(anchored)}\n`, 'utf8');
      }
    }
    return chained;
  });
}

export function receiptFileName(checkId) {
  return `${checkId.replace(/[^a-z0-9-]/g, '_')}.json`;
}

export async function writeReceiptFile(ctx, record) {
  const filePath = stateFile(ctx, path.join('receipts', receiptFileName(record.checkId)));
  await atomicWrite(filePath, record);
}

// 每个 check 的最新回执（receipts/ 目录即最新态索引；同 check 后续 FAIL 覆盖旧 PASS）。
export async function latestReceipts(ctx) {
  const directory = stateFile(ctx, 'receipts');
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const map = new Map();
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const value = await readJsonFile(path.join(directory, name), { required: false });
    if (value && typeof value.checkId === 'string') map.set(value.checkId, value);
  }
  return map;
}

// 证据落盘：脱敏 + 有界；返回相对路径与内容哈希。
export async function writeEvidence(ctx, checkId, text) {
  const stamp = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const filePath = stateFile(ctx, path.join('evidence', `${checkId}-${stamp}.log`));
  const body = `${boundedText(text, ctx.outputLimits.evidenceChars)}\n`;
  await atomicWrite(filePath, body);
  const bytes = await readFile(filePath);
  return {
    evidencePath: toPosix(path.relative(ctx.root, filePath)),
    evidenceSha256: sha256(bytes),
    evidenceBytes: bytes.length
  };
}
