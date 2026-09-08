#!/usr/bin/env node
// ============================================================================
// case-suite-growth —— capability 爬坡探针：REQ-066 的演化目标是 regression
// 防回退套持续增厚到 ≥30 任务（当前落地基线 20）。未达标只报告不阻断。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { REPO } from './fixtures.mjs';

const TARGET = 30;
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'eval', 'manifest.json'), 'utf8'));
const count = Array.isArray(manifest.regression) ? manifest.regression.length : 0;
if (count < TARGET) {
  process.stderr.write(`case-suite-growth: regression 套 ${count} < 目标 ${TARGET}（爬坡中，不阻断）\n`);
  process.exit(1);
}
process.exit(0);
