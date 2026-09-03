#!/usr/bin/env node
// ============================================================================
// kimi-base 治理运行时（零第三方依赖、Node >= 18、ESM）
//
// 用法：node .kimi-base/runtime/kimi-base.mjs <verb> [args] [--project <dir>]
// 项目根：含 .kimi-base/harness.json 标记文件的目录（从 --project 或 cwd 向上查找）。
//
// 退出码契约 v2：
//   0 = 成功 / PASS
//   1 = 用法错误（含未知 flag）或规则违例（catalog lint / fitness / adr / arch 发现违规）
//   2 = 治理阻断（gate / 完成门 / quality status / 篡改·断链·缺失 / doctor / pack-check / manifest / install）
//   3 = 降级（非 git 仓无法测量，绝不假绿）或引擎内部错误
//   4 = 陈旧证据（receipt verify：链完好但指纹已移动）
//   hook outward 契约保持 0（放行）/ 2（拦截）。
//
// 哲学：诚实降级——缺工具 = BLOCKED 绝不假绿；非 git 仓 = 降级（exit 3）不假 PASS；
// 内部错误显式报错（exit 3）。所有消息使用中文。
//
// 本文件仅为薄入口：实现在 ./lib/*.mjs（core/paths/config/state/git/catalog/
// matrix/ledger/tasks/fast/gate/quality/review/arch/fitness/context/memory/scan/
// hygiene/classifier/hooks/installer/admin/verify/selftest/cli）。
//
// 供体移植说明：本运行时融合了 codex-base（harness/lib 19 模块）、pi-base
// （config 严格校验、gates 四态、waiver、baseline 对账、pi-supervisor）与
// cursor-base（语义化 shell 分类器、哈希链账本、事务安装器）的治理逻辑；
// 宿主专属部分（codex hooks 注册、pi SDK、cursor hooks.json 协议）一律未搬。
// ============================================================================

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { main } from './lib/cli.mjs';

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
