#!/usr/bin/env node
// ============================================================================
// case-install-doctor —— capability 爬坡探针：REQ-002/REQ-004 端到端——
// 把源仓安装进空目录（种子落地 + install-receipt），再用安装面自带引擎
// 跑 doctor 自检必须 exit 0。失败只报告不阻断。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { ENGINE, cleanup, out } from './fixtures.mjs';

const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-base-eval-install-'));
try {
  const install = spawnSync(process.execPath, [ENGINE, 'install', target], {
    cwd: path.dirname(target), encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1' }
  });
  if (install.status !== 0) {
    process.stderr.write(`case-install-doctor: install 必须 exit 0，实得 ${install.status}\n${install.stdout ?? ''}\n${install.stderr ?? ''}\n`);
    process.exit(1);
  }
  for (const rel of ['.kimi-base/harness.json', '.kimi-base/state/install-receipt.json', 'AGENTS.md']) {
    if (!fs.existsSync(path.join(target, rel))) {
      process.stderr.write(`case-install-doctor: 安装后缺 ${rel}\n`);
      process.exit(1);
    }
  }
  const doctor = spawnSync(process.execPath,
    [path.join(target, '.kimi-base', 'runtime', 'kimi-base.mjs'), 'doctor', '.'], {
      cwd: target, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NO_COLOR: '1' }
    });
  if (doctor.status !== 0) {
    process.stderr.write(`case-install-doctor: 安装面 doctor 必须 exit 0，实得 ${doctor.status}\n${out(doctor)}\n`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  cleanup(target);
}
