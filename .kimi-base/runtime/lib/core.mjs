// lib/core.mjs —— 通用工具（错误、哈希、JSON、路径、子进程）、TOOL_VERSION、配置断言助手

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const TOOL_VERSION = 'kimi-base/2.0.0';

export class HarnessError extends Error {
  constructor(message, code = 'HARNESS_ERROR', exitCode = 1, details = undefined) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

// 用法错误（exit 1）：含未知 flag、非法入参、配置非法
export function usageError(message) {
  return new HarnessError(message, 'USAGE', 1);
}

// 治理阻断（exit 2）：gate FAIL / BLOCKED / 完成门缺口 / uncovered / 篡改·断链·缺失 / doctor / pack-check / manifest 漂移
export function blockedError(message, code = 'GOVERNANCE_BLOCKED', details = undefined) {
  return new HarnessError(message, code, 2, details);
}

// 降级（exit 3）：无法完成测量（典型：非 git 仓无法绑定证据指纹）。绝不假绿。
export function degradedError(message, code = 'DEGRADED', details = undefined) {
  return new HarnessError(message, code, 3, details);
}

// 陈旧证据（exit 4）：链完好无篡改，但回执绑定的指纹/基线已移动。
export function staleError(message, code = 'STALE_EVIDENCE', details = undefined) {
  return new HarnessError(message, code, 4, details);
}

export function normalizeLf(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

// 稳定序列化：键排序，保证 contentHash 与计划哈希可复现。
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// 内容哈希：剔除 contentHash 与 chain（链位置元数据不参与记录自身完整性）。
export function contentHashOf(record) {
  const copy = { ...record };
  delete copy.contentHash;
  delete copy.chain;
  return sha256(stableJson(copy));
}

export async function readJsonFile(filePath, { required = true } = {}) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw new HarnessError(`无法读取 JSON 文件：${filePath}：${error.message}`, 'JSON_READ_FAILED');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HarnessError(`JSON 文件无法解析：${filePath}：${error.message}`, 'JSON_PARSE_FAILED');
  }
}

// 原子写：临时文件 + rename，任何中断都不会留下半写文件。
export async function atomicWrite(filePath, value, mode = undefined) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const body = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, body, mode === undefined ? undefined : { mode });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new HarnessError(`原子写失败：${filePath}：${error.message}`, 'ATOMIC_WRITE_FAILED');
  }
}

// 证据脱敏：token/key/secret/password 等模式一律遮蔽后才允许落盘或输出。
export function redactSecrets(value) {
  let text = String(value ?? '');
  const patterns = [
    /\b(sk|pk|rk|sess)-[A-Za-z0-9_-]{12,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    /\b((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|mssql):\/\/)[^@\s"']+@/gi,
    /\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|KIMI_API_KEY|MOONSHOT_API_KEY)\s*[=:]\s*[^\s"']+/gi,
    /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi,
    /([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi,
    /(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,"']+/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, (match, prefix) => (prefix ? `${prefix}[已脱敏]` : '[已脱敏]'));
  }
  return text;
}

export function boundedText(value, limit, suffix = '\n...[截断]') {
  const clean = redactSecrets(value);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

// 有界尾部（与 boundedText 对偶：保尾不保头——尾部才是 decision-relevant 判定行）。
// 先脱敏再截取（E3 评审 info 面：截取边缘不会把一条密钥切成可见碎片——脱敏在完整文本上
// 做完整正则匹配，碎片风险在「先切后脱敏」顺序才存在）。
export function boundedTail(value, limit, prefix = '[截断]…') {
  const clean = redactSecrets(value);
  if (clean.length <= limit) return clean;
  return `${prefix}${clean.slice(-limit)}`;
}

export function toPosix(value) {
  return String(value).split(path.sep).join('/').replace(/^\.\//, '');
}

export function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 仓内相对路径归一化；拒绝绝对路径与逃逸。
export function normalizeRepoPath(value) {
  const normalized = toPosix(path.posix.normalize(toPosix(String(value))));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new HarnessError(`不安全的仓库相对路径：${value}`, 'UNSAFE_PATH');
  }
  return normalized;
}

// 写目标解析：realpath 逐段防逃逸（symlink 目标必须在仓内）。
export async function resolveForWrite(repoRoot, inputPath) {
  const absolute = path.resolve(repoRoot, String(inputPath));
  const realRoot = await realpath(repoRoot);
  if (!isPathInside(realRoot, absolute)) {
    throw new HarnessError(`写目标在工作区之外：${inputPath}`, 'OUTSIDE_WORKSPACE', 2);
  }
  let cursor = absolute;
  while (cursor !== path.dirname(cursor)) {
    try {
      const existing = await realpath(cursor);
      if (!isPathInside(realRoot, existing)) {
        throw new HarnessError(`写目标经符号链接逃逸出工作区：${inputPath}`, 'OUTSIDE_WORKSPACE', 2);
      }
      return { absolute, realRoot, existingAncestor: existing };
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (error.code !== 'ENOENT') throw error;
      cursor = path.dirname(cursor);
    }
  }
  throw new HarnessError(`无法为 ${inputPath} 找到安全祖先目录`, 'UNSAFE_PATH');
}

// 文件摘要：symlink 记目标，缺失记 null，目录/特殊文件记模式。
export async function fileDigest(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) return `symlink:${await realpath(filePath)}`;
    if (!info.isFile()) return `${info.mode}:${info.size}`;
    return sha256(await readFile(filePath));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 子进程执行：四态结果（PASS/FAIL/BLOCKED），输出有界，超时可杀。
export async function runProcess(executable, args, options = {}) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutput = options.maxOutput ?? 200000;
  return await new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let outputTruncated = false;
    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ status: 'BLOCKED', error, exitCode: null, signal: null, stdout: '', stderr: '', durationMs: Date.now() - started, outputTruncated, timedOut });
      return;
    }
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      // 截断必须可见：被截断的输出若照样哈希，会把错误字节绑进证据。
      if (combined.length > maxOutput) outputTruncated = true;
      return combined.subarray(0, maxOutput);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'BLOCKED', error, exitCode: null, signal: null, stdout: stdout.toString(), stderr: stderr.toString(), durationMs: Date.now() - started, outputTruncated, timedOut });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'BLOCKED' : exitCode === 0 ? 'PASS' : 'FAIL',
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - started,
        outputTruncated,
        timedOut
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ } }, 1000).unref();
    }, timeoutMs);
    timer.unref();
  });
}

// REQ-056：valueFlags 声明哪些 flag 消费字符串值（契约表 kind:'value'）。
// boolean/未知 flag 一律不吞后续裸 token——裸 token 留在 positional 由契约校验归类，
// 修复"boolean flag 把下一个裸 token 吞成自己的值"导致的静默错跑。
export function parseCliArgs(argv, { valueFlags } = {}) {
  const takesValue = valueFlags ?? new Set();
  const positional = [];
  const flags = {};
  const duplicates = [];
  const emptyValues = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (Object.prototype.hasOwnProperty.call(flags, rawKey) && !duplicates.includes(rawKey)) {
      duplicates.push(rawKey);
    }
    if (inline !== undefined) {
      flags[rawKey] = inline;
      if (inline === '' && !emptyValues.includes(rawKey)) emptyValues.push(rawKey);
    } else if (takesValue.has(rawKey) && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      flags[rawKey] = argv[++index];
    } else {
      flags[rawKey] = true;
    }
  }
  return { positional, flags, duplicates, emptyValues };
}

export function csv(value) {
  if (Array.isArray(value)) return value;
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nowIso() {
  return new Date().toISOString();
}

// REQ-060 修复指令体：gate/dod/quality 的 FAIL/BLOCKED/UNCOVERED 条目必须指给 agent
// 一个具体可执行动作（重跑命令或配置文件路径），不允许"请检查"式空泛指引——
// 错误信息本身就是给 agent 的修复指令。唯一定义处，禁止各处自写。
export function nextStepFor(kind, context = {}) {
  const rerunGate = `node .kimi-base/runtime/kimi-base.mjs gate${context.risk ? ` --risk ${context.risk}` : ''}`;
  switch (kind) {
    case 'gate-fail':
      return `修复该检查的失败原因后重跑取证：\`${rerunGate}\`（本检查命令：${context.command ?? `见 .kimi-base/verification-matrix.json 中 ${context.checkId} 的定义`}）`;
    case 'gate-blocked':
      if (context.missingKind) {
        return `在 .kimi-base/verification-matrix.json 的 checks[] 为 kind ${context.kind} 增加至少一个带 command/executable/builtin 的检查，然后重跑 \`${rerunGate}\``;
      }
      if (!context.command) {
        return `在 .kimi-base/verification-matrix.json 为检查 ${context.checkId} 配置 command/executable/builtin 字段（缺命令 = BLOCKED，绝不假绿），然后重跑 \`${rerunGate}\``;
      }
      return `排除执行障碍（平台/依赖/启动失败，见本条 reason）后重跑 \`${rerunGate}\`；本检查命令：${context.command}`;
    case 'quality-uncovered':
      if (String(context.reason ?? '').includes('未接线')) {
        return `在 .kimi-base/verification-matrix.json 增加 attributes 含 "${context.attribute}" 的检查完成接线，然后重跑 \`${rerunGate}\` 产出 fresh PASS 证据`;
      }
      return `重跑 \`${rerunGate}\` 产出 ${context.attribute} 认领检查的 fresh PASS 证据（有 FAIL 反证先修该检查；账本断链先查 .kimi-base/state/ledger.jsonl）`;
    case 'dod-step':
      return `按本条输出尾部修复后重跑该步验证：\`node .kimi-base/runtime/kimi-base.mjs ${(context.args ?? []).join(' ')}\`，修复完成后全量重跑 \`node .kimi-base/runtime/kimi-base.mjs dod\``;
    default:
      throw new HarnessError(`未知 nextStep 类别：${kind}`, 'NEXTSTEP_KIND_UNKNOWN');
  }
}

export function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError(`${label} 必须是对象`, 'CONFIG_INVALID');
  }
}

export function assertKnownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HarnessError(`${label} 含未知字段：${key}`, 'CONFIG_UNKNOWN_FIELD');
  }
}

export function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new HarnessError(`${label} 必须是正整数`, 'CONFIG_INVALID');
}

export function assertStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || (!allowEmpty && !item.trim()))) {
  throw new HarnessError(`${label} 必须是字符串数组`, 'CONFIG_INVALID');
  }
}

export function relativeSafe(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new HarnessError(`${label} 必须是仓内相对路径`, 'CONFIG_INVALID');
  }
}
