// lib/paths.mjs —— 路径与状态文件名常量（单一口径）

// 状态/配置路径常量：全模块唯一事实源，避免各处漂移。

export const STATE_DIR = '.kimi-base/state';
export const CONFIG_REL = '.kimi-base/harness.json';
export const CATALOG_REL = '.kimi-base/module-catalog.json';
export const MATRIX_REL = '.kimi-base/verification-matrix.json';
export const ARCH_BASELINE_REL = '.kimi-base/arch-baseline.json';
export const ADAPTERS_REL = '.kimi-base/adapters.json';

export const LEDGER_FILE = 'ledger.jsonl';
export const TASKS_FILE = 'tasks.json';
export const FAST_FILE = 'fast-mode.json';
export const WAIVERS_FILE = 'waivers.json';
export const ARCH_TREND_FILE = 'arch-trend.json';
export const REVIEW_SESSION_FILE = 'review/session.json';
export const REVIEW_BACKLOG_FILE = 'review-backlog.json';

export const INSTALL_MANIFEST_REL = `${STATE_DIR}/install-manifest.json`;
export const INSTALL_RECEIPT_REL = `${STATE_DIR}/install-receipt.json`;
