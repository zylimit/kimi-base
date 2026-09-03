#!/usr/bin/env node
// ============================================================================
// kimi-base supervisor —— 开发态进程守护（单文件、零依赖、Node >= 18）
//
// 用途：给长生命周期的开发服务（dev server / worker / db proxy）提供韧性：
//   宕机自动拉起（指数退避，500ms 基数封顶 30s）；
//   HTTP 健康探针连败 3 次杀掉"活着但不服务"的进程；
//   重启风暴熔断（600s 窗口超 10 次置 crashed 停手 = 失败可见）；
//   日志 5MB 轮转；确认 liftoff 才报 started；stop.flag 轮询跨平台停止；
//   只 kill 自己启动的进程。
//
// 明确声明：这不是生产 init 系统。生产请用 systemd / k8s / 真实编排器。
//
// 配置来源：.kimi-base/harness.json 的 services：
//   "services": { "web": { "command": "npm run dev", "healthUrl": "http://127.0.0.1:3000/health", "cwd": "." } }
//
// 用法：
//   node runtime/supervisor.mjs start <name> [--project <dir>]
//   node runtime/supervisor.mjs stop <name>
//   node runtime/supervisor.mjs status [name]
//   node runtime/supervisor.mjs logs <name> [--lines 80]
//
// 退出码：0 成功；1 错误（含用法错误，与引擎约定一致）。
// ============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 日志 5MB 轮转
const BACKOFF_BASE_MS = 500; // 退避基数
const BACKOFF_MAX_MS = 30000; // 退避封顶
const BREAKER_MAX_RESTARTS = 10; // 熔断：窗口内最多重启次数
const BREAKER_WINDOW_SEC = 600; // 熔断窗口
const HEALTH_FAILURES_LIMIT = 3; // 健康探针连败上限

// ---------------------------------------------------------------------------
// 项目根与状态目录
// ---------------------------------------------------------------------------

function findProjectRoot(start) {
  let cursor = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.kimi-base', 'harness.json'))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function projectRoot(flags) {
  const start = typeof flags.project === 'string' ? flags.project : process.cwd();
  const root = findProjectRoot(start);
  if (!root) die(`未找到 .kimi-base/harness.json（自 ${start} 向上）；supervisor 只在 kimi-base 项目内工作`, 1);
  return root;
}

function baseDir(root) {
  return path.join(root, '.kimi-base', 'state', 'supervisor');
}

function safeName(name) {
  const value = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return value === '' || value === '.' || value === '..' ? '' : value;
}

function nameDir(root, name) {
  return path.join(baseDir(root), name);
}

function readConfig(root) {
  const configPath = path.join(root, '.kimi-base', 'harness.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    die(`无法读取 ${configPath}：${error.message}`, 1);
  }
  return parsed?.services ?? {};
}

function serviceDefinition(root, name) {
  const services = readConfig(root);
  const definition = services[name];
  if (!definition) die(`未知服务：${name}；请在 .kimi-base/harness.json 的 services 中定义（name→{command, healthUrl, cwd}）`, 1);
  if (typeof definition.command !== 'string' || !definition.command.trim()) die(`services.${name}.command 缺失`, 1);
  const cwd = path.resolve(root, definition.cwd ?? '.');
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    die(`services.${name}.cwd 逃逸仓库：${definition.cwd}`, 1);
  }
  const restart = definition.restart ?? {};
  return {
    command: definition.command,
    cwd,
    healthUrl: typeof definition.healthUrl === 'string' ? definition.healthUrl : null,
    maxRestarts: restart.maxRestarts ?? BREAKER_MAX_RESTARTS,
    windowSec: restart.windowSec ?? BREAKER_WINDOW_SEC,
    backoffMs: restart.backoffMs ?? BACKOFF_BASE_MS,
    backoffMaxMs: restart.backoffMaxMs ?? BACKOFF_MAX_MS,
    healthFailures: restart.healthFailures ?? HEALTH_FAILURES_LIMIT
  };
}

// ---------------------------------------------------------------------------
// 状态与日志
// ---------------------------------------------------------------------------

function readState(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(nameDir(root, name), 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 原子写：半写的状态文件会让后续所有 status 说谎。
function writeState(root, name, state) {
  const dir = nameDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, path.join(dir, 'state.json'));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logPath(root, name) {
  return path.join(nameDir(root, name), 'service.log');
}

function rotateIfLarge(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`); // 只留一代；更早历史随轮转销毁
    }
  } catch { /* 轮转失败绝不能拖垮被守护的服务 */ }
}

function logLine(root, name, message) {
  const file = logPath(root, name);
  rotateIfLarge(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] [supervisor] ${message}\n`, 'utf8');
  } catch { /* 尽力而为 */ }
}

// 只 kill 自己启动的进程；POSIX 用负 pid 杀整个进程组（子进程 detached 成组）。
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
      }, 3000).unref();
    }
  } catch { /* 已退出 */ }
}

function probe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// __run：被 start 以 detached 方式拉起的守护循环（不手工调用）
// ---------------------------------------------------------------------------

function runLoop(root, name, definition) {
  const dir = nameDir(root, name);
  const stopFlag = path.join(dir, 'stop.flag');
  const restartTimes = [];
  let child = null;
  let stopping = false;
  let healthFails = 0;

  const state = (patch) => {
    const current = readState(root, name) ?? {};
    writeState(root, name, {
      ...current,
      name,
      command: definition.command,
      cwd: definition.cwd,
      healthUrl: definition.healthUrl,
      supervisorPid: process.pid,
      restarts: restartTimes.length,
      ...patch,
      updatedAt: new Date().toISOString()
    });
  };

  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    logLine(root, name, `停止：${reason}`);
    if (child?.pid) killTree(child.pid);
    state({ status: 'stopped', childPid: null, stoppedAt: new Date().toISOString(), stopReason: reason });
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const startChild = () => {
    rotateIfLarge(logPath(root, name));
    const out = fs.openSync(logPath(root, name), 'a');
    child = spawn(definition.command, {
      cwd: definition.cwd,
      shell: true,
      detached: process.platform !== 'win32', // 独立进程组，killTree(-pid) 才能收割孙进程
      stdio: ['ignore', out, out]
    });
    fs.closeSync(out);
    healthFails = 0;
    logLine(root, name, `子进程启动 pid=${child.pid} cmd=${definition.command}`);
    state({ status: 'running', childPid: child.pid, startedAt: new Date().toISOString() });
    child.on('exit', (code, signal) => {
      if (stopping) return;
      logLine(root, name, `子进程退出 code=${code} signal=${signal ?? 'none'}`);
      state({ status: 'backoff', childPid: null, lastExit: { code, signal, at: new Date().toISOString() } });
      scheduleRestart(`exit code=${code}`);
    });
  };

  const scheduleRestart = (why) => {
    const now = Date.now();
    restartTimes.push(now);
    while (restartTimes.length && now - restartTimes[0] > definition.windowSec * 1000) restartTimes.shift();
    if (restartTimes.length > definition.maxRestarts) {
      // 熔断：重启风暴说明故障不是瞬态。停手并把证据（日志尾部）留给人看。
      logLine(root, name, `熔断：${definition.windowSec}s 窗口内重启 ${restartTimes.length} 次，停手等待人工介入`);
      state({ status: 'crashed', childPid: null, breaker: { restarts: restartTimes.length, windowSec: definition.windowSec } });
      process.exit(1);
    }
    const delay = Math.min(definition.backoffMs * 2 ** (restartTimes.length - 1), definition.backoffMaxMs);
    logLine(root, name, `第 ${restartTimes.length} 次重启，退避 ${delay}ms（${why}）`);
    setTimeout(() => { if (!stopping) startChild(); }, delay);
  };

  // 注视节拍：stop.flag 轮询（跨平台停止，不玩信号游戏）+ 健康探针。
  // 该 interval 刻意不 unref——它是守护循环在子进程重启间隙的存活理由。
  let lastProbe = 0;
  setInterval(async () => {
    if (stopping) return;
    if (fs.existsSync(stopFlag)) {
      try { fs.unlinkSync(stopFlag); } catch { /* 忽略 */ }
      shutdown('stop.flag');
      return;
    }
    if (definition.healthUrl && child?.pid && Date.now() - lastProbe >= 5000) {
      lastProbe = Date.now();
      const ok = await probe(definition.healthUrl);
      if (ok) {
        healthFails = 0;
        return;
      }
      healthFails += 1;
      logLine(root, name, `健康探针失败（${healthFails}/${definition.healthFailures}）：${definition.healthUrl}`);
      if (healthFails >= definition.healthFailures) {
        // 活着但不服务 = 宕机的另一种形态，exit 处理器看不到：杀掉走重启路径。
        logLine(root, name, `健康熔断：杀掉僵死子进程 pid=${child.pid}`);
        healthFails = 0;
        const pid = child.pid;
        child.removeAllListeners('exit');
        killTree(pid);
        state({ status: 'backoff', childPid: null, lastExit: { code: null, signal: 'health-probe', at: new Date().toISOString() } });
        scheduleRestart('健康探针连败');
      }
    }
  }, 1000);

  startChild();
}

// ---------------------------------------------------------------------------
// CLI 动词
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; index += 1; }
    } else positional.push(token);
  }
  return { flags, positional };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function cmdStart(flags, name) {
  if (!name) die('start 需要服务名：supervisor.mjs start <name>', 1);
  const root = projectRoot(flags);
  const definition = serviceDefinition(root, name);
  const existing = readState(root, name);
  if (existing && existing.status === 'running' && pidAlive(existing.supervisorPid)) {
    die(`服务 ${name} 已在守护中（supervisor pid ${existing.supervisorPid}）；请先 stop`, 1);
  }
  fs.mkdirSync(nameDir(root, name), { recursive: true });
  try { fs.unlinkSync(path.join(nameDir(root, name), 'stop.flag')); } catch { /* 无残留 */ }
  const child = spawn(process.execPath, [SELF, '__run', name, '--project', root], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  // 确认 liftoff 才报 started：报"已启动"但 pid 已死是假绿。
  const deadline = Date.now() + 5000;
  const wait = () => {
    const current = readState(root, name);
    if (current && current.supervisorPid && pidAlive(current.supervisorPid)) {
      emit({ ok: true, name, supervisorPid: current.supervisorPid, childPid: current.childPid ?? null, status: current.status, log: path.relative(root, logPath(root, name)) });
      return;
    }
    if (Date.now() > deadline) die(`supervisor 5 秒内未报告存活状态；请查 ${path.relative(root, logPath(root, name))}`, 1);
    setTimeout(wait, 150);
  };
  wait();
}

function cmdStop(flags, name) {
  if (!name) die('stop 需要服务名：supervisor.mjs stop <name>', 1);
  const root = projectRoot(flags);
  const current = readState(root, name);
  if (!current) die(`没有 ${name} 的状态记录`, 1);
  fs.writeFileSync(path.join(nameDir(root, name), 'stop.flag'), `${new Date().toISOString()}\n`, 'utf8');
  if (current.supervisorPid && pidAlive(current.supervisorPid)) {
    try { process.kill(current.supervisorPid, 'SIGTERM'); } catch { /* stop.flag 会兜住 */ }
  }
  if (current.childPid && pidAlive(current.childPid)) killTree(current.childPid);
  const deadline = Date.now() + 6000;
  const wait = () => {
    const latest = readState(root, name);
    const supervisorGone = !latest?.supervisorPid || !pidAlive(latest.supervisorPid);
    const childGone = !latest?.childPid || !pidAlive(latest.childPid);
    if (supervisorGone && childGone) {
      emit({ ok: true, name, status: 'stopped' });
      return;
    }
    if (Date.now() > deadline) die(`stop 6 秒内未收敛（supervisor=${supervisorGone ? '已停' : '存活'} child=${childGone ? '已停' : '存活'}）`, 1);
    setTimeout(wait, 200);
  };
  wait();
}

function cmdStatus(flags, name) {
  const root = projectRoot(flags);
  let names = [];
  try {
    names = fs.readdirSync(baseDir(root)).filter((entry) => fs.existsSync(path.join(baseDir(root), entry, 'state.json')));
  } catch {
    names = [];
  }
  if (name) names = names.filter((entry) => entry === name);
  const services = names.map((entry) => {
    const current = readState(root, entry) ?? {};
    const supervisorAlive = pidAlive(current.supervisorPid);
    const childAlive = pidAlive(current.childPid);
    // 状态记录可能比进程活得久（掉电、kill -9）：存活判断以 pid 为准而非最后写入的状态。
    const status = current.status === 'stopped' || current.status === 'crashed' ? current.status
      : supervisorAlive ? (childAlive ? 'running' : (current.status ?? 'backoff')) : 'dead';
    return {
      name: entry, status, supervisorPid: current.supervisorPid ?? null, supervisorAlive,
      childPid: current.childPid ?? null, childAlive, restarts: current.restarts ?? 0,
      command: current.command ?? null, healthUrl: current.healthUrl ?? null,
      lastExit: current.lastExit ?? null, updatedAt: current.updatedAt ?? null,
      log: path.relative(root, logPath(root, entry))
    };
  });
  emit({ ok: true, services });
}

function cmdLogs(flags, name) {
  if (!name) die('logs 需要服务名：supervisor.mjs logs <name> [--lines 80]', 1);
  const root = projectRoot(flags);
  const lines = Number.isInteger(Number(flags.lines)) && Number(flags.lines) > 0 ? Number(flags.lines) : 80;
  let text;
  try {
    text = fs.readFileSync(logPath(root, name), 'utf8');
  } catch {
    die(`没有 ${name} 的日志`, 1);
  }
  const tail = text.split('\n').filter(Boolean).slice(-lines);
  process.stdout.write(`${tail.join('\n')}\n`);
}

function usage() {
  return [
    '用法：node runtime/supervisor.mjs <verb> [name] [--project <dir>]',
    '  start <name>     按 harness.json services.<name> 拉起并守护（确认 liftoff 才报 started）',
    '  stop <name>      stop.flag 轮询停止（跨平台；只 kill 自己启动的进程）',
    '  status [name]    查看服务状态（存活以 pid 为准）',
    '  logs <name>      查看日志尾部 [--lines 80]',
    '声明：这是开发态守护，不是生产 init 系统。'
  ].join('\n');
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const [verb, nameArg] = positional;
const name = safeName(nameArg);
switch (verb) {
  case 'start': cmdStart(flags, name); break;
  case 'stop': cmdStop(flags, name); break;
  case 'status': cmdStatus(flags, nameArg ? name : null); break;
  case 'logs': cmdLogs(flags, name); break;
  case '__run': {
    const root = projectRoot(flags);
    if (!name) die('__run 需要服务名', 1);
    runLoop(root, name, serviceDefinition(root, name));
    break;
  }
  default: die(usage(), 1);
}
