// lib/bindings.mjs —— Receipt v2 绑定面（REQ-053，ADR-0009）
// 回执在 fingerprint（diffHash）之外增绑三面：policyHash（strength resolveStrength 输出）/
// engineHash（执行引擎 runtime 树 LF 归一化哈希）/catalogHash（module-catalog.json 内容哈希）。
// 无对应配置时键存在、值显式 null——区分「无配置」与「实现忘了绑」。
// 引擎变了，「它验证过」的含义就变了：任何一侧漂移，旧回执 stale（exit 4），链完好不算篡改。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './core.mjs';
import { normalizedBytes, walkAssetFiles } from './installer.mjs';
import { loadStrengthConfig, resolveStrength } from './strength.mjs';

// 本文件位于 <引擎>/.kimi-base/runtime/lib/bindings.mjs；引擎树 = 上一级 runtime/。
// 绑的是「正在执行的这份引擎」，与项目根的 .kimi-base/runtime 是否同源无关
//（测试会把引擎副本装进夹具仓，改副本一个字节就必须使旧回执 stale）。
const ENGINE_RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// engineHash：runtime 树逐文件 LF 归一化 sha256，组合口径与 manifest digest 一致
//（path\0sha256\0bytes 行拼接再 sha256）。state/ 等运行态天然不在 runtime 树内。
export async function engineTreeHash() {
  const lines = [];
  for (const relative of await walkAssetFiles(ENGINE_RUNTIME_DIR, ENGINE_RUNTIME_DIR)) {
    const bytes = normalizedBytes(await readFile(path.join(ENGINE_RUNTIME_DIR, relative)));
    lines.push(`${relative}\0${sha256(bytes)}\0${bytes.length}\n`);
  }
  return sha256(lines.join(''));
}

export async function bindingSurfaces(ctx) {
  // policyHash：无 strength.json = 强度治理未开启 → 显式 null（不是伪造哈希）。
  const strengthConfig = await loadStrengthConfig(ctx);
  const policyHash = strengthConfig ? (await resolveStrength(ctx, {})).policyHash : null;
  // catalogHash：module-catalog.json 内容哈希（LF 归一化）；无 catalog → 显式 null。
  let catalogHash = null;
  try {
    catalogHash = sha256(normalizedBytes(await readFile(ctx.catalogPath)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { policyHash, engineHash: await engineTreeHash(), catalogHash };
}
