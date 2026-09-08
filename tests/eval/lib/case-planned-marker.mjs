#!/usr/bin/env node
// ============================================================================
// case-planned-marker —— REQ-067 行为锚：planned 标记缺 phase 编号必须被
// spec lint 判 PLANNED_NO_PHASE 且 exit 1（语法解析门禁不失灵）。
// ============================================================================

import process from 'node:process';
import { specRepo, runEngine, cleanup, out } from './fixtures.mjs';

// 夹具需求 id 拼接构造：字面量 REQ-\d+ 会被本仓 trace 当悬空引用扫描命中。
const FAKE_REQ = 'REQ-' + '901';

const dir = specRepo({
  'specs/a.md': [
    '# 需求',
    '',
    `- ${FAKE_REQ} 当用户触发该场景时，系统必须完成 ${FAKE_REQ} 对应的行为。`,
    '  验收：测试引用该 id 并断言行为。',
    '  状态：planned',
    '',
  ].join('\n')
});
try {
  const r = runEngine(dir, ['spec', 'lint']);
  if (r.code !== 1) {
    process.stderr.write(`case-planned-marker: 裸 planned 必须 exit 1，实得 ${r.code}\n${out(r)}\n`);
    process.exit(1);
  }
  if (!r.stdout.includes('PLANNED_NO_PHASE')) {
    process.stderr.write(`case-planned-marker: 必须报 PLANNED_NO_PHASE\n${out(r)}\n`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  cleanup(dir);
}
