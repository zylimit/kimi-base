#!/usr/bin/env node
// ============================================================================
// run-tests —— 跨 Node 版本的测试启动器（独立审计脚本，禁止 import 引擎）
//
// Node 20 的 --test 不展开 glob（"tests/*.test.mjs" 会被当字面路径而失败），
// Node 22+ 才自己 glob。本启动器用标准库展开并传显式文件清单，
// 同一条命令在 20/22/24、Windows/Linux 行为一致。
// 没有测试可跑 = 什么都没有被证明 → exit 3（不假绿）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const dir = path.join(process.cwd(), 'tests');
if (!fs.existsSync(dir)) {
  process.stderr.write(`run-tests: 没有 tests 目录（${dir}）——没有测试可跑 = 什么都没证明（exit 3）\n`);
  process.exit(3);
}
const files = fs.readdirSync(dir)
  .filter((name) => /\.test\.mjs$/.test(name))
  .sort()
  .map((name) => path.join('tests', name));

if (files.length === 0) {
  process.stderr.write('run-tests: tests/ 下没有 *.test.mjs——没有测试可跑 = 什么都没证明（exit 3）\n');
  process.exit(3);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
const code = result.status === null ? 1 : result.status;
process.stderr.write(`run-tests: ${files.length} 个测试文件，exit ${code}\n`);
process.exit(code);
