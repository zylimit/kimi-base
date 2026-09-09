#!/usr/bin/env node
// ============================================================================
// plan-lint —— DEV-PLAN.md 无占位符机械检查（独立审计脚本，禁止 import 引擎，REQ-079）
//
// 计划里的占位符与偷懒引用是"没写完假装写完"：占位词表与 spec lint 同源
// （TBD/TODO 独立成词 + 待补充/待定）；"类似 Task N"/"同 Task N"/「同上任务」式
// 引用把思考外包给一个编号，计划无法独立成立。命中即 exit 1 并带 file:line 点名。
//
// 判定口径（写清边界，宁可漏报不误报）：
// - 围栏代码块（``` / ~~~，闭 fence 同字符且长度 ≥ 开）内一律豁免——示例与草稿
//   合法携带占位词。
// - 行内注释豁免：剔除同行 <!-- ... --> 区段；`//`（前一个字符不是 `:`，以免误伤
//   URL 的 `://`）起至行尾视为注释不参与匹配。
// - 编号条目交叉引用豁免：`TBD|TODO` 独立成词命中后紧跟 `#<数字>`（可隔空白）的，
//   是"TODO #7"式指向已编号条目的引用——但**悬空编号不豁免**（评审 W1）：
//   progress.md 存在时，被引编号必须在其中出现过（含 `[#N]` 条目形态，Done 历史
//   提及也算——编号条目的唯一事实源是 progress.md）；无 progress.md 时本规则不激活
//   （宁可漏报不误报）。否则"TODO #999"只是把占位外包给一个不存在的编号，照判占位词。
//
// 用法：node .kimi-base/audit/plan-lint.mjs
// 退出码：0 干净 / 1 有命中 / 3 降级（非 git 仓拒绝猜测；无 DEV-PLAN.md 响亮降级，
// 绝不假绿——放行 ≠ 全部通过）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const PLAN_FILE = 'DEV-PLAN.md';

/** 降级出口：stdout 单行 JSON + stderr 人类摘要，exit 3（SKIPPED 不是 PASS） */
function degraded(reason, detail) {
  process.stderr.write(`plan-lint: ${detail}（exit 3，降级响亮声明——SKIPPED 不是 PASS）\n`);
  process.stdout.write(`${JSON.stringify({ command: 'plan-lint', ok: false, degraded: true, reason, findings: [] })}\n`);
  process.exit(3);
}

// git 仓判定与钉根（评审修复轮，口径同 ui-slop 的 W2 修复）：子目录运行时以
// process.cwd() 相对路径读 DEV-PLAN.md 会把"仓根有计划"误报成"无计划"（假降级），
// 或 lint 到子目录自己的 DEV-PLAN.md（扫描面随 cwd 收缩 = 假绿）。一律钉到仓根。
let repoRoot;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  degraded('not-a-git-repo', '非 git 仓——拒绝猜测');
}

let text;
try {
  text = fs.readFileSync(path.join(repoRoot, PLAN_FILE), 'utf8');
} catch {
  degraded('no-dev-plan', `仓根无 ${PLAN_FILE}——计划缺失不能当成计划干净`);
}

// 占位词表与 spec lint（runtime/lib/scan.mjs）同源：ASCII 独立成词 + CJK 裸词。
const PLACEHOLDER_ASCII = /(?<![\w/「『"'])(?:TBD|TODO)(?![\w/」』"'])/g;
const PLACEHOLDER_CJK = /待补充|待定/g;
const LAZY_REFERENCE = /类似\s*Task|同\s*Task|同上任务/g;
// 编号条目交叉引用：占位词命中后紧跟 `#<数字>`（可隔空白）是引用不是占位——
// 前提是被引编号在 progress.md 有定义（progress.md 缺失时本规则不激活，照旧豁免）。
const ITEM_REFERENCE = /^\s*#(\d+)/;
// fence 开闭记字符与长度：闭 fence 必须同字符且长度 ≥ 开（口径同 spec lint）。
const FENCE = /^\s*(`{3,}|~{3,})/;

// 编号定义面（评审 W1）：progress.md 是唯一事实源，被引编号须在其中出现过（钉仓根读取）。
// 读不到 progress.md → definedNumbers = null → 规则不激活（宁可漏报不误报）。
let definedNumbers = null;
try {
  const progressText = fs.readFileSync(path.join(repoRoot, 'progress.md'), 'utf8');
  definedNumbers = new Set([...progressText.matchAll(/#(\d+)/g)].map((match) => match[1]));
} catch { /* 无 progress.md：编号豁免规则不激活 */ }

/** 行内注释口径：剔除 <!-- --> 区段；`//`（前字符非 `:`）起至行尾为注释 */
function stripInlineComments(line) {
  const noHtml = line.replace(/<!--.*?-->/g, '');
  const slash = noHtml.indexOf('//');
  if (slash >= 0 && noHtml[slash - 1] !== ':') return noHtml.slice(0, slash);
  return noHtml;
}

function collect(line, lineNo, re, rule, findings) {
  for (const match of line.matchAll(re)) {
    if (rule === 'placeholder') {
      const ref = ITEM_REFERENCE.exec(line.slice(match.index + match[0].length));
      if (ref && (definedNumbers === null || definedNumbers.has(ref[1]))) continue;
    }
    findings.push({ file: PLAN_FILE, line: lineNo, rule, excerpt: line.trim().slice(0, 120) });
  }
}

const findings = [];
let fence = null; // 开 fence 的 { char, length }；null = 不在 fence 内
const lines = text.split('\n');
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const fenceMatch = FENCE.exec(line);
  if (fence) {
    if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
    continue; // 围栏内一律豁免
  }
  if (fenceMatch) {
    fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    continue;
  }
  const body = stripInlineComments(line);
  collect(body, index + 1, PLACEHOLDER_ASCII, 'placeholder', findings);
  collect(body, index + 1, PLACEHOLDER_CJK, 'placeholder', findings);
  collect(body, index + 1, LAZY_REFERENCE, 'lazy-task-reference', findings);
}

for (const finding of findings) {
  process.stderr.write(` ERR  ${finding.rule.padEnd(20)}${finding.file}:${finding.line}  ${finding.excerpt}\n`);
}
process.stdout.write(`${JSON.stringify({ command: 'plan-lint', ok: findings.length === 0, file: PLAN_FILE, scanRoot: repoRoot, findings: findings.slice(0, 100) })}\n`);
process.stderr.write(`plan-lint: ${PLAN_FILE} ${lines.length} 行，${findings.length} 个命中\n`);
process.exit(findings.length === 0 ? 0 : 1);
