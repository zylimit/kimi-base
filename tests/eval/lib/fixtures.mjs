// ============================================================================
// fixtures —— eval 行为任务共用的最小夹具构造（仅 node: stdlib）。
//
// 与 tests/ 行为测试同纪律：临时 git 仓、真实 CLI 子进程、断言退出码；
// 不依赖 .kimi-base/state/ 残留。被评测仓根来自 KIMI_BASE_EVAL_REPO。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

export const REPO = process.env.KIMI_BASE_EVAL_REPO;
if (!REPO) {
  process.stderr.write('fixtures: KIMI_BASE_EVAL_REPO 未设置（本套件只能经 run-eval 调用）\n');
  process.exit(1);
}
export const ENGINE = path.join(REPO, '.kimi-base', 'runtime', 'kimi-base.mjs');

export function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function git(dir, ...args) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'kimi-base-eval',
      GIT_AUTHOR_EMAIL: 'kimi-base-eval@example.com',
      GIT_COMMITTER_NAME: 'kimi-base-eval',
      GIT_COMMITTER_EMAIL: 'kimi-base-eval@example.com',
      GIT_INIT_DEFAULT_BRANCH: 'main',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
    }
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
}

/** 受治理最小仓：harness + catalog + 验证矩阵 + 业务文件（全部提交） */
export function governedRepo({ checks }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-base-eval-fixture-'));
  write(dir, '.kimi-base/harness.json', JSON.stringify({ version: 1 }, null, 2));
  write(dir, '.kimi-base/module-catalog.json', JSON.stringify({
    version: 1, modules: [{ id: 'app', root: 'src', paths: ['**'] }]
  }, null, 2));
  write(dir, '.kimi-base/verification-matrix.json', JSON.stringify({
    version: 1,
    riskKinds: { low: ['static'], medium: ['static'], high: ['static', 'security'] },
    checks
  }, null, 2));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'eval fixture: governed repo');
  return dir;
}

/** spec 夹具：harness（spec 段指向 specs/ 目录）+ 给定文档（全部提交） */
export function specRepo(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-base-eval-spec-'));
  write(dir, '.kimi-base/harness.json', JSON.stringify({
    version: 1,
    spec: { requirementDirs: ['specs'], testGlobs: ['tests/**'], minCoverage: 1.0 }
  }, null, 2));
  for (const [rel, content] of Object.entries(docs)) write(dir, rel, content);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'eval fixture: spec repo');
  return dir;
}

export function runEngine(cwd, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, NO_COLOR: '1' }
  });
  if (r.error) throw new Error(`引擎启动失败（${args.join(' ')}）：${r.error.message}`);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const out = (r) => `${r.stdout}\n${r.stderr}`;

export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    process.stderr.write(`fixtures: 临时目录清理失败（残留由 OS 回收）: ${dir} — ${e.code ?? e.message}\n`);
  }
}
