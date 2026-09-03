// lib/classifier.mjs —— 危险命令分类器（语义化解析，穿透 wrapper 与嵌套 shell）
// 移植自 codex-base hooks.mjs / cursor-base harness.mts。
// 判定三档：deny（恒 exit 2）/ review（默认 exit 2，可配 warn）/ allow。

import path from 'node:path';
import { git } from './git.mjs';

// 分类器规则 id 单一事实源：gate-audit 的已知闸清单由此派生，规则改名/新增不会悄悄腐烂。
export const CLASSIFIER_RULES = Object.freeze({
  // deny 级（恒拦）
  rmRf: 'rm-rf',
  gitResetHard: 'git-reset-hard',
  gitCleanForce: 'git-clean-force',
  gitForcePush: 'git-force-push',
  recursiveForcedDeletion: 'recursive-forced-deletion',
  machineShutdown: 'machine-shutdown',
  diskFormat: 'disk-format',
  forkBomb: 'fork-bomb',
  blockDeviceWrite: 'block-device-write',
  recursiveSystemChmod: 'recursive-system-chmod',
  // review 级（默认拦，可配 reviewAction=warn 降级提示）
  remotePipeToShell: 'remote-pipe-to-shell',
  gitPush: 'git-push',
  packagePublish: 'package-publish',
  // 敏感信息（classifySensitiveCommand）
  secretEgress: 'secret-egress',
  secretRead: 'secret-read',
  secretCopy: 'secret-copy'
});
// pre-tool-use-bash 闸的完整规则面（deny + review + 敏感信息三类都经此 hook 落地）。
export const PRE_BASH_RULE_IDS = Object.freeze(Object.values(CLASSIFIER_RULES));

const WRAPPER_SKIP_VALUE = new Map([
  ['sudo', new Set(['-u', '-g', '-h', '-p', '--user', '--group'])],
  ['doas', new Set(['-u'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '-n', '--class', '--classdata'])],
  ['stdbuf', new Set([])],
  ['timeout', new Set(['-k', '-s', '--kill-after', '--signal'])]
]);
const PLAIN_WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'builtin']);
const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'busybox']);
const REMOTE_FETCHERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'fetch']);
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'python', 'python3', 'perl', 'ruby', 'node']);

function normalizeCmdName(value) {
  return path.win32.basename(path.posix.basename(String(value ?? ''))).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
}

// POSIX 风格 tokenizer：回答"运行的是哪个程序、带哪些参数"，裸正则答不可靠。
function shellTokens(command) {
  const tokens = [];
  let value = '';
  let quote = null;
  let dynamic = false;
  const push = () => {
    if (value) tokens.push({ kind: 'word', value, dynamic });
    value = '';
    dynamic = false;
  };
  const text = String(command ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      else {
        if (character === '$' || character === '`') dynamic = true;
        value += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      if (character === '\n' || character === '\r') tokens.push({ kind: 'op', value: ';' });
      continue;
    }
    if (character === '>' || character === ';' || character === '|' || character === '&' || character === '<') {
      push();
      const pair = text.slice(index, index + 2);
      if (pair === '>>' || pair === '||' || pair === '&&') index += 1;
      tokens.push({ kind: character === '>' || character === '<' ? 'redirect' : 'op', value: pair === '>>' || pair === '||' || pair === '&&' ? pair : character });
      continue;
    }
    if (character === '$' || character === '`' || character === '*' || character === '?') dynamic = true;
    value += character;
  }
  push();
  return tokens;
}

function segmentsWithJoiners(command) {
  const segments = [{ joiner: null, tokens: [] }];
  for (const token of shellTokens(command)) {
    if (token.kind === 'op') segments.push({ joiner: token.value, tokens: [] });
    else segments.at(-1).tokens.push(token);
  }
  return segments.filter((segment) => segment.tokens.length);
}

// wrapper 穿透：sudo/env/timeout 不得掩盖真实程序（`timeout 5 git reset --hard`
// 曾被误分类为"运行名为 5 的程序"）。
function effectiveWords(segment) {
  const words = segment.filter((token) => token.kind === 'word');
  let index = 0;
  while (index < words.length) {
    const raw = words[index].value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) { index += 1; continue; }
    const name = normalizeCmdName(raw);
    if (PLAIN_WRAPPERS.has(name)) { index += 1; continue; }
    if (name === 'env') {
      index += 1;
      while (index < words.length && (words[index].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value))) index += 1;
      continue;
    }
    if (WRAPPER_SKIP_VALUE.has(name)) {
      const valueFlags = WRAPPER_SKIP_VALUE.get(name);
      index += 1;
      while (index < words.length && words[index].value.startsWith('-')) {
        index += valueFlags.has(words[index].value) ? 2 : 1;
      }
      if (name === 'timeout' && index < words.length && /^\d/.test(words[index].value)) index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function nestedShellPayloads(words) {
  if (!words.length) return [];
  const name = normalizeCmdName(words[0].value);
  const payloads = [];
  if (NESTED_SHELLS.has(name)) {
    for (let index = 1; index < words.length - 1; index += 1) {
      if (words[index].value === '-c' || words[index].value === '-lc') payloads.push(words[index + 1].value);
    }
  }
  return payloads;
}

function rootishTarget(words) {
  return words.some((token) => {
    if (token.kind !== 'word' || token.value.startsWith('-')) return false;
    const value = token.value.replace(/["']/g, '');
    return value === '/' || value === '/*' || value === '~' || value === '~/' || /^[A-Za-z]:[\\/]?\*?$/.test(value)
      || (token.dynamic && /^\$(?:HOME|USERPROFILE)\/?$/.test(value));
  });
}

// git 允许长选项的不模糊缩写（`git reset --har` 就是 `--hard`）：
// 对规则关心的长选项做前缀归一，缩写形态不得逃逸拦截。
const GIT_RULE_LONG_OPTIONS = Object.freeze(['--hard', '--force', '--mirror', '--force-with-lease', '--force-if-includes']);

function resolveGitRuleOption(arg) {
  if (!arg.startsWith('--')) return arg;
  const eqAt = arg.indexOf('=');
  const name = eqAt === -1 ? arg : arg.slice(0, eqAt);
  if (GIT_RULE_LONG_OPTIONS.includes(name)) return arg;
  if (name.length <= 2) return arg; // 裸 "--" 不是缩写
  const candidates = GIT_RULE_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (candidates.length !== 1) return arg; // 歧义缩写：git 自身也会拒绝，保持原样
  return eqAt === -1 ? candidates[0] : `${candidates[0]}=${arg.slice(eqAt + 1)}`;
}

function gitInvocationOf(words) {
  const values = words.map((token) => token.value);
  let index = 1;
  const optionsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
  while (index < values.length && values[index].startsWith('-')) {
    const option = values[index];
    if (optionsWithValue.has(option)) index += 2;
    else index += 1;
  }
  if (index >= values.length) return { subcommand: null, args: [] };
  return { subcommand: values[index].toLowerCase(), args: values.slice(index + 1).map(resolveGitRuleOption) };
}

// deny 级：不可逆破坏。review 级：远端副作用/凭据外发（可配置降级为提示）。
export function classifyDangerousCommand(command, depth = 0) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim();
  const R = CLASSIFIER_RULES;
  const denyRules = [
    [R.gitResetHard, /\bgit\b[^\n|;&]*\breset\s+--hard\b/i, 'git reset --hard 会丢弃工作'],
    [R.gitCleanForce, /\bgit\b[^\n|;&]*\bclean\b[^\n|;&]*(?:-[^\s]*[fdx])/i, 'git clean 带删除旗标会丢弃未跟踪文件'],
    [R.gitForcePush, /\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*(?:--force\b|--mirror\b|\s-f\b)(?![-\w]*-with-lease)/i, '强制推送会摧毁远端历史；如需请显式 --force-with-lease 并获授权'],
    [R.recursiveForcedDeletion, /\bRemove-Item\b[^\n]*(?:-Recurse[^\n]*-Force|-Force[^\n]*-Recurse)/i, '递归强制删除被拦截'],
    [R.machineShutdown, /\b(?:shutdown|reboot|Restart-Computer|Stop-Computer)\b/i, '关机/重启命令被拦截'],
    [R.diskFormat, /\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart|format\s+[A-Za-z]:)\b/i, '磁盘格式化命令被拦截'],
    [R.forkBomb, /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, 'fork 炸弹模式被拦截'],
    [R.blockDeviceWrite, /\bdd\b[^\n|;&]*\bof=(?:\/dev\/|\\\\\.\\)/i, '写裸块设备被拦截']
  ];
  for (const [rule, pattern, reason] of denyRules) if (pattern.test(text)) return { action: 'deny', rule, reason };
  let previousFetches = false;
  for (const { joiner, tokens } of segmentsWithJoiners(command)) {
    const words = effectiveWords(tokens);
    const name = words.length ? normalizeCmdName(words[0].value) : '';
    if (depth < 3) {
      for (const payload of nestedShellPayloads(words)) {
        const nested = classifyDangerousCommand(payload, depth + 1);
        if (nested.action !== 'allow') return nested;
      }
    }
    if (joiner === '|' && previousFetches && SHELL_INTERPRETERS.has(name)) {
      return { action: 'review', rule: R.remotePipeToShell, reason: '把远端内容直接管进解释器（curl|sh 类），默认拦截' };
    }
    const git = name === 'git' ? gitInvocationOf(words) : null;
    if (git?.subcommand === 'reset' && git.args.includes('--hard')) return { action: 'deny', rule: R.gitResetHard, reason: 'git reset --hard 会丢弃工作' };
    if (git?.subcommand === 'clean' && git.args.some((flag) => /^-[^-]*[fdx]/i.test(flag))) return { action: 'deny', rule: R.gitCleanForce, reason: 'git clean 带删除旗标会丢弃未跟踪文件' };
    if (git?.subcommand === 'push' && git.args.some((flag) => flag === '--force' || flag === '--mirror' || flag === '-f')) {
      return { action: 'deny', rule: R.gitForcePush, reason: '强制推送会摧毁远端历史；如需请显式 --force-with-lease 并获授权' };
    }
    if (git?.subcommand === 'push') return { action: 'review', rule: R.gitPush, reason: 'git push 是远端副作用，默认拦截（可配置降级为提示）' };
    const flags = words.slice(1).filter((token) => token.value.startsWith('-') || token.value.startsWith('/')).map((token) => token.value);
    if (name === 'rm') {
      const recursive = flags.some((flag) => flag === '--recursive' || /^-[^-]*[rR]/.test(flag));
      const forced = flags.some((flag) => flag === '--force' || /^-[^-]*f/.test(flag));
      if (recursive && forced) return { action: 'deny', rule: R.rmRf, reason: 'rm 递归强制删除被拦截' };
    }
    if (['del', 'erase', 'rd', 'rmdir'].includes(name)
      && flags.some((flag) => /^\/s$/i.test(flag)) && flags.some((flag) => /^\/q$/i.test(flag))) {
      return { action: 'deny', rule: R.recursiveForcedDeletion, reason: '递归静默删除被拦截' };
    }
    if ((name === 'chmod' || name === 'chown')
      && flags.some((flag) => flag === '--recursive' || /^-[^-]*R/.test(flag)) && rootishTarget(words.slice(1))) {
      return { action: 'deny', rule: R.recursiveSystemChmod, reason: '对系统根做递归权限/属主变更被拦截' };
    }
    if (name === 'dd' && words.some((token) => /^of=(?:\/dev\/|\\\\\.\\)/i.test(token.value))) {
      return { action: 'deny', rule: R.blockDeviceWrite, reason: '写裸块设备被拦截' };
    }
    if (['npm', 'pnpm', 'yarn'].includes(name) && words.slice(1).some((token) => token.value === 'publish')) {
      return { action: 'review', rule: R.packagePublish, reason: '包发布是远端副作用，默认拦截' };
    }
    previousFetches = REMOTE_FETCHERS.has(name);
  }
  return { action: 'allow', rule: null, reason: null };
}

const SECRET_READERS = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'strings', 'base64', 'xxd', 'od', 'grep', 'rg', 'awk', 'sed', 'cut', 'get-content', 'gc', 'select-string', 'findstr']);
const SECRET_COPIERS = new Set(['cp', 'copy', 'mv', 'move', 'install', 'copy-item', 'move-item', 'rsync']);
// docker/podman run --env-file 会把秘密灌进容器环境，视同外发面。
const EGRESS_COMMANDS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'scp', 'sftp', 'ssh', 'rsync', 'ftp', 'telnet', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'aws', 'az', 'gcloud', 'gsutil', 'docker', 'podman']);

export function isSecretBasename(ctx, value) {
  const base = path.win32.basename(path.posix.basename(String(value ?? ''))).toLowerCase();
  if (!base) return false;
  if (ctx.security.allowedSecretTemplates.map((item) => item.toLowerCase()).includes(base)) return false;
  if (ctx.security.secretNames.map((item) => item.toLowerCase()).includes(base)) return true;
  if (base.startsWith('.env')) return true;
  return ctx.security.secretExtensions.some((item) => base.endsWith(item.toLowerCase()));
}

// 融合形态（-d@.env、--data=@.env、file=@id_rsa）会把路径藏进选项里，先拆再比对。
function secretTokensOf(ctx, tokens) {
  const hits = [];
  for (const token of tokens) {
    if (token.kind !== 'word') continue;
    const candidates = [token.value];
    const atMatch = token.value.match(/@([^@\s]+)$/);
    if (atMatch) candidates.push(atMatch[1]);
    const assignMatch = token.value.match(/^[^=\s]+=@?(.+)$/);
    if (assignMatch) candidates.push(assignMatch[1]);
    if (candidates.some((candidate) => isSecretBasename(ctx, candidate))) hits.push(token.value);
  }
  return hits;
}

// 凭据外泄追踪：跨管道继承（cat id_rsa | nc host 也算外泄）。
// 读者/复制者不提前返回：先记录，若后续管道段出现外发命令则升级报 secret-egress。
export function classifySensitiveCommand(ctx, command) {
  const R = CLASSIFIER_RULES;
  const segments = segmentsWithJoiners(command);
  let pipedSecret = false;
  let firstFinding = null;
  for (const { joiner, tokens } of segments) {
    if (joiner !== '|') pipedSecret = false;
    const words = effectiveWords(tokens);
    const name = words.length ? normalizeCmdName(words[0].value) : '';
    const secrets = secretTokensOf(ctx, words.slice(1));
    if (EGRESS_COMMANDS.has(name) && (secrets.length || (joiner === '|' && pipedSecret))) {
      return { action: 'review', rule: R.secretEgress, reason: `疑似凭据外发：${secrets[0] ?? '管道携带的秘密内容'} 流向网络命令 ${name}` };
    }
    if (!firstFinding && SECRET_READERS.has(name) && secrets.length) {
      firstFinding = { action: 'review', rule: R.secretRead, reason: `读取秘密文件进入会话：${secrets[0]}` };
    }
    if (!firstFinding && SECRET_COPIERS.has(name) && secrets.length) {
      firstFinding = { action: 'review', rule: R.secretCopy, reason: `复制秘密文件：${secrets[0]}` };
    }
    if (secrets.length) pipedSecret = true;
  }
  return firstFinding ?? { action: 'allow', rule: null, reason: null };
}
