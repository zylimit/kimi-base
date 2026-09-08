#!/usr/bin/env node
// ============================================================================
// run-at-repo —— eval 任务辅助：以被评测仓为 cwd 执行仓内脚本，转发退出码。
//
// run-eval 的 judge.command 统一在临时目录执行（夹具与仓隔离）；本助手把
// 「对本仓跑一条引擎/审计命令」封装为可移植的一行：
//   node tests/eval/lib/run-at-repo.mjs <仓内脚本路径> [args...]
// 被评测仓根来自 run-eval 注入的 KIMI_BASE_EVAL_REPO。
// ============================================================================

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repo = process.env.KIMI_BASE_EVAL_REPO;
if (!repo) {
  process.stderr.write('run-at-repo: KIMI_BASE_EVAL_REPO 未设置（本助手只能经 run-eval 调用）\n');
  process.exit(1);
}
const [script, ...rest] = process.argv.slice(2);
if (!script) {
  process.stderr.write('用法：node run-at-repo.mjs <仓内脚本路径> [args...]\n');
  process.exit(1);
}
const r = spawnSync(process.execPath, [path.join(repo, script), ...rest], {
  cwd: repo,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' }
});
// 子进程输出转发到 stderr（run-eval 的 stdout 末行是 JSON 契约，不可污染）。
if (r.stdout) process.stderr.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.error) {
  process.stderr.write(`run-at-repo: 启动失败（${script}）：${r.error.message}\n`);
  process.exit(1);
}
process.exit(r.status ?? 1);
