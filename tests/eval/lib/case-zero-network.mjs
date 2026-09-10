#!/usr/bin/env node
// ============================================================================
// case-zero-network —— capability 探针：NFR-004「治理引擎必须 100% 无网络访问
// （node:http/https/net 引用 0 处；supervisor 的健康探针是其职责内唯一例外）」
// 的机械化。窄白名单即条文本身：仅 .kimi-base/runtime/supervisor.mjs 且仅
// node:http / node:https 两个 import 豁免；其余文件、其余协议（net/tls/dgram）
// 一律算命中。白名单不得扩大——新增豁免必须先改 Product-Spec.md NFR-004 条文
// （本头注释引用条文留痕，防豁免蔓延）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { REPO } from './fixtures.mjs';

const NETWORK = /(?:from|import)\s*\(?\s*['"](node:(?:http|https|net|dgram|tls))['"]/g;
const ALLOWED_FILE = '.kimi-base/runtime/supervisor.mjs'; // NFR-004 括号内明示的唯一例外
const ALLOWED_IMPORTS = new Set(['node:http', 'node:https']); // 健康探针只用这两个协议
const runtimeDir = path.join(REPO, '.kimi-base', 'runtime');
const hits = [];
const exemptions = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mjs')) {
      const rel = path.relative(REPO, p).split(path.sep).join('/');
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(NETWORK)) {
        if (rel === ALLOWED_FILE && ALLOWED_IMPORTS.has(m[1])) exemptions.push(`${rel}: ${m[1]}`);
        else hits.push(`${rel}: ${m[1]}`);
      }
    }
  }
};
walk(runtimeDir);
if (exemptions.length > 0) {
  process.stderr.write(`case-zero-network: NFR-004 职责内例外 ${exemptions.length} 处（${exemptions.join('；')}）——豁免面固定不得扩大\n`);
}
if (hits.length > 0) {
  process.stderr.write(`case-zero-network: runtime 树仍有豁免外网络 import（${hits.length} 处）：\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.exit(0);
