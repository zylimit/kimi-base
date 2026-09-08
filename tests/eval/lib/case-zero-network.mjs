#!/usr/bin/env node
// ============================================================================
// case-zero-network —— capability 爬坡探针：NFR-004 的终态目标是治理引擎
// 全树零网络 import；当前 supervisor.mjs 的健康探针（node:http/https）是
// 职责内例外，故本任务当前允许失败（记录爬坡起点，不阻断）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { REPO } from './fixtures.mjs';

const NETWORK = /(?:from|import)\s*\(?\s*['"](node:(?:http|https|net|dgram|tls))['"]/g;
const runtimeDir = path.join(REPO, '.kimi-base', 'runtime');
const hits = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mjs')) {
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(NETWORK)) hits.push(`${path.relative(REPO, p)}: ${m[1]}`);
    }
  }
};
walk(runtimeDir);
if (hits.length > 0) {
  process.stderr.write(`case-zero-network: runtime 树仍有网络 import（${hits.length} 处）：\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.exit(0);
