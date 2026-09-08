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
import { fastDebtOf } from './fast.mjs';
import { LEDGER_FILE, LEDGER_HEAD_FILE } from './paths.mjs';
import { stateFile, quarantineState, withFileLock } from './state.mjs';

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

// 全史鉴权（REQ-054/E2）：归档段（文件名时间戳前缀字典序=时序）+ 当前段逐段重放哈希链，
// 段首 anchor 必须满足三重对账——chain == 上一段链尾（归档被删改/伪造归档混入即断）、
// count == 此前各段数据条目数（剔除条目即对不上）、contentHash 自洽。
// 返回 trusted = 断点之前的可信前缀条目：下游视图（fastDebtOf 债务判定）只信可信前缀——
// 伪造归档里的假偿还条目不得清债。
export async function verifyLedgerHistory(ctx) {
  let archiveNames;
  try {
    archiveNames = (await readdir(ctx.stateDir)).filter((name) => LEDGER_ARCHIVE_PATTERN.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') archiveNames = [];
    else throw error;
  }
  const segmentNames = [...archiveNames, LEDGER_FILE];
  const trusted = [];
  let previous = CHAIN_GENESIS;
  let retiredBefore = 0; // 此前各段的数据条目累计（anchor.count 的对账基准）
  for (const [segIndex, name] of segmentNames.entries()) {
    const label = segIndex < archiveNames.length ? `归档段 ${name}` : '当前段';
    let text;
    try {
      text = await readFile(path.join(ctx.stateDir, name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' && segIndex === archiveNames.length) {
        if (archiveNames.length) {
          return { intact: false, reason: `存在归档段但当前账本 ${LEDGER_FILE} 缺失（账本被截断或清空）`, trusted };
        }
        return { intact: true, reason: null, trusted }; // 空账本：无证据不等于有篡改
      }
      throw error;
    }
    const lines = text.split('\n').filter(Boolean);
    // 截断检测（fail-closed 双向之一）：有归档段，当前段就必须以 anchor 续链。
    if (segIndex === archiveNames.length && archiveNames.length > 0) {
      let firstKind = null;
      try { firstKind = lines.length ? JSON.parse(lines[0])?.kind : null; } catch { /* 坏行由主循环如实报 */ }
      if (firstKind !== 'anchor') {
        return { intact: false, reason: '存在归档段但当前账本缺首行 anchor（账本被截断或清空）', trusted };
      }
    }
    for (const [lineIndex, line] of lines.entries()) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return { intact: false, reason: `${label} 第 ${lineIndex + 1} 行无法解析`, trusted };
      }
      if (entry.kind === 'anchor') {
        if (lineIndex !== 0) return { intact: false, reason: `${label} 第 ${lineIndex + 1} 行：anchor 只能位于段首`, trusted };
        if (segIndex === 0) return { intact: false, reason: `${label} 出现 anchor 但此前没有任何归档段（anchor 被伪造或归档被删）`, trusted };
        if (typeof entry.chain !== 'string' || !Number.isInteger(entry.count) || typeof entry.at !== 'string') {
          return { intact: false, reason: `${label} anchor 缺 chain/count/at 字段`, trusted };
        }
        if (entry.contentHash !== contentHashOf(entry)) {
          return { intact: false, reason: `${label} anchor 内容哈希不匹配（anchor 被篡改）`, trusted };
        }
        if (entry.chain !== previous) {
          return { intact: false, reason: `${label} anchor 链尾与上一段不衔接（归档段被删改或伪造归档混入）`, trusted };
        }
        if (entry.count !== retiredBefore) {
          return { intact: false, reason: `${label} anchor.count=${entry.count} 与此前退役数据条目数 ${retiredBefore} 不一致（归档被剔除条目或伪造归档混入）`, trusted };
        }
        previous = entry.chain; // 锚点携带上一段链尾，跨段续链
        trusted.push(entry);
        continue;
      }
      if (typeof entry.contentHash !== 'string' || typeof entry.chain !== 'string') {
        return { intact: false, reason: `${label} 第 ${lineIndex + 1} 行缺 contentHash/chain 字段`, trusted };
      }
      if (entry.contentHash !== contentHashOf(entry)) {
        return { intact: false, reason: `${label} 第 ${lineIndex + 1} 行内容哈希不匹配（被篡改）`, trusted };
      }
      if (entry.chain !== chainLink(previous, entry.contentHash)) {
        return { intact: false, reason: `${label} 第 ${lineIndex + 1} 行哈希链断裂（记录被删改/重排/伪造）`, trusted };
      }
      previous = entry.chain;
      retiredBefore += 1;
      trusted.push(entry);
    }
  }
  return { intact: true, reason: null, trusted };
}

// ---------------- head 锚（F2：尾部截断检测） ----------------
// 链是前缀可截断的：删掉尾行后剩余链仍是合法前缀，纯链校验无从发现。每次追加后原子写
// ledger-head.json（链尾 chain + 数据条目数 + fast 债务快照），verify/risk 对账锚与实际链尾。
// 诚实边界（残余风险，与 docs/PROTOCOLS.md 同步声明）：锚同样是本地文件，无密钥的本地账本
// 只能 tamper-evident——决心改写者可以连锚带链一起重写；committed 模式把锚纳入 git 史，
// 改写必须与提交史对账，才是真正的缓解。

export async function readLedgerHead(ctx) {
  const filePath = stateFile(ctx, LEDGER_HEAD_FILE);
  try {
    return await readJsonFile(filePath, { required: false });
  } catch (error) {
    // REQ-061：锚不可解析走 quarantine 原语——隔离原件为 .corrupt-<ts> 保留 forensic
    // 证据并记事件（risk scan 经 state-quarantined 响亮浮出），不只在内存里打标静默兜底。
    // 内存返回值仍按伪造面对账（"锚被篡改"高危告警与隔离并存），不假绿。
    if (error.code === 'JSON_PARSE_FAILED') await quarantineState(ctx, filePath, error);
    return { __corrupt: true };
  }
}

// 追加/轮转后重建 head 锚（调用方已持有账本写锁；全史重读此刻必然 intact）。
async function writeLedgerHead(ctx) {
  const history = await verifyLedgerHistory(ctx);
  const head = {
    version: 1,
    kind: 'ledger-head',
    chain: history.trusted.length ? history.trusted.at(-1).chain : CHAIN_GENESIS,
    entries: history.trusted.filter((entry) => entry.kind !== 'anchor').length,
    fastDebt: fastDebtOf(history.trusted).map((debt) => ({ checkId: debt.checkId, windowId: debt.windowId ?? null })),
    updatedAt: nowIso()
  };
  await atomicWrite(stateFile(ctx, LEDGER_HEAD_FILE), { ...head, contentHash: contentHashOf(head) });
}

// 锚对账（verify 与 risk 共用单源）：链重放 + 锚一致性。
// 新旧账本判别器（G1）：v2 绑定键（REQ-053 起每个回执必带，无配置显式 null）或
// kind=deferred（REQ-054）只可能由带锚引擎写入——此类账本无锚 = 锚被删除（灭迹），判篡改；
// 只有纯 v1 旧账本（全无 v2 键且无 deferred）缺锚才降级 note（不谎报），下次追加自动建锚。
export function reconcileLedgerHead(history, head) {
  const tailChain = history.trusted.length ? history.trusted.at(-1).chain : null;
  const dataCount = history.trusted.filter((entry) => entry.kind !== 'anchor').length;
  if (!head) {
    if (dataCount > 0) {
      const requiresAnchor = history.trusted.some((entry) =>
        !entry.__corrupt && entry.kind !== 'anchor'
        && (entry.kind === 'deferred'
          || 'policyHash' in entry || 'engineHash' in entry || 'catalogHash' in entry));
      if (requiresAnchor) {
        return { ok: false, head: null, reason: `head 锚（${LEDGER_HEAD_FILE}）缺失，但账本含 v2 绑定键/deferred 条目（必出自带锚引擎）——锚被删除（尾部截断灭迹）` };
      }
      return { ok: true, head: null, note: `无 ${LEDGER_HEAD_FILE}（特性前旧账本）：尾部截断不可检测，下次账本追加自动建立 head 锚` };
    }
    return { ok: true, head: null };
  }
  if (head.__corrupt || head.contentHash !== contentHashOf(head)) {
    return { ok: false, head: null, reason: `head 锚（${LEDGER_HEAD_FILE}）内容哈希不匹配或不可解析（锚被篡改）` };
  }
  if (head.chain !== tailChain || head.entries !== dataCount) {
    const short = (value) => (typeof value === 'string' ? `${value.slice(0, 12)}…` : String(value));
    return {
      ok: false,
      head,
      reason: `head 锚对账失败：锚记链尾 ${short(head.chain)} / ${head.entries} 条 ≠ 实际链尾 ${short(tailChain)} / ${dataCount} 条（账本尾部被截断或锚被伪造）`
    };
  }
  return { ok: true, head };
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
    // F2：每次追加后重建 head 锚（链尾+条目数+债务快照）——尾部截断检测的唯一事实源。
    await writeLedgerHead(ctx);
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

// 证据可见性模式（REQ-055/ADR-0009）：state/.gitignore 内容按 harness.json evidence.mode 区分。
// local（默认）：整个 state/ 永不进 git（零负担）。
// committed：账本与回执放行进入 git 视野（可提交、clone 后直接 receipt verify）；
// 证据日志本体（evidence/*.log）与其余运行态永远保持 git-ignored——入的是判定与链，不是原料。
export function stateGitignoreContent(mode) {
  if (mode === 'committed') {
    return '*\n!.gitignore\n!ledger.jsonl\n!ledger-head.json\n!ledger-archive-*.jsonl\n!receipts/\n!receipts/**\n';
  }
  return '*\n!.gitignore\n';
}

// 让 state/.gitignore 与当前证据模式一致（幂等：内容相同不重写）。
export async function ensureStateGitignore(ctx) {
  const filePath = stateFile(ctx, '.gitignore');
  const content = stateGitignoreContent(ctx.evidenceMode ?? 'local');
  let current = null;
  try {
    current = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== content) await atomicWrite(filePath, content);
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
    let value;
    try {
      value = await readJsonFile(path.join(directory, name), { required: false });
    } catch (error) {
      // REQ-061：回执同为运行态 JSON——损坏走 quarantine 原语（隔离+记账），
      // 被隔离的回执按"无 fresh 证据"处理（完成门/quality 缺口响亮可见），不拖死读者。
      if (error.code !== 'JSON_PARSE_FAILED') throw error;
      await quarantineState(ctx, path.join(directory, name), error);
      continue;
    }
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
