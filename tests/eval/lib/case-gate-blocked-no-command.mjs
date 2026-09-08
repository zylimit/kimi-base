#!/usr/bin/env node
// ============================================================================
// case-gate-blocked-no-command —— REQ-013/NFR-005 行为锚：缺命令的检查必须
// BLOCKED（绝不假绿），gate exit 2。夹具矩阵中的检查不带 command。
// ============================================================================

import process from 'node:process';
import { governedRepo, runEngine, cleanup, out } from './fixtures.mjs';

const dir = governedRepo({
  checks: [{ id: 'no-command', kind: 'static', tier: 'inner' }]
});
try {
  const r = runEngine(dir, ['gate']);
  if (r.code !== 2) {
    process.stderr.write(`case-gate-blocked-no-command: 缺命令检查必须 BLOCKED 且 gate exit 2，实得 ${r.code}\n${out(r)}\n`);
    process.exit(1);
  }
  if (!out(r).includes('BLOCKED')) {
    process.stderr.write(`case-gate-blocked-no-command: gate 输出必须点名 BLOCKED（缺命令不假绿）\n${out(r)}\n`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  cleanup(dir);
}
