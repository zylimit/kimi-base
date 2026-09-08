#!/usr/bin/env node
// ============================================================================
// case-gate-blocks-fail —— REQ-013 行为锚：矩阵中真实失败的检查必须使
// gate exit 2（阻断语义），绝不放行。夹具内检查命令恒失败（exit 1），
// gate 若不阻断（exit 0）即本任务红。
// ============================================================================

import process from 'node:process';
import { governedRepo, runEngine, cleanup, out } from './fixtures.mjs';

const dir = governedRepo({
  checks: [{ id: 'always-fail', kind: 'static', tier: 'inner', command: 'node -e "process.exit(1)"' }]
});
try {
  const r = runEngine(dir, ['gate']);
  if (r.code !== 2) {
    process.stderr.write(`case-gate-blocks-fail: gate 对 FAIL 检查必须 exit 2（阻断），实得 ${r.code}\n${out(r)}\n`);
    process.exit(1);
  }
  if (!out(r).includes('FAIL')) {
    process.stderr.write(`case-gate-blocks-fail: gate 输出必须点名 FAIL\n${out(r)}\n`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  cleanup(dir);
}
