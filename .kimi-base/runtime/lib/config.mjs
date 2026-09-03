// lib/config.mjs —— 项目根发现与配置严格校验（.kimi-base/harness.json）
// 移植自 pi-base config.ts 的严格校验风格：未知字段一律拒绝。

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HarnessError, assertKnownFields, assertPlainObject, assertPositiveInt, assertStringArray, pathExists, readJsonFile, relativeSafe } from './core.mjs';
import { RISKS } from './matrix.mjs';
import { ADAPTERS_REL, ARCH_BASELINE_REL, CATALOG_REL, CONFIG_REL, MATRIX_REL, STATE_DIR } from './paths.mjs';

const RETENTION_DEFAULTS = Object.freeze({
  evidenceMaxFiles: 300,
  evidenceMaxAgeDays: 30,
  contextMaxFiles: 50,
  sessionsMaxEntries: 200,
  gateLogMaxBytes: 4194304,
  ledgerMaxEntries: 1000 // 账本数据条目上限：超过即归档旧段并以 anchor 起新段
});

const OUTPUT_LIMIT_DEFAULTS = Object.freeze({
  hookChars: 4000,
  evidenceChars: 200000,
  modelChars: 60000
});

const LOCK_DEFAULTS = Object.freeze({ timeoutMs: 15000, staleMs: 120000, pollMs: 25 });

export const SECURITY_DEFAULTS = Object.freeze({
  dependencyDirs: ['node_modules', 'vendor', 'dist', 'build', 'out', '.venv', 'venv', 'target'],
  secretNames: ['.env', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials.json', '.netrc', '.npmrc', '.pypirc'],
  secretExtensions: ['.pem', '.key', '.p12', '.pfx', '.kdbx'],
  secretDirs: ['.ssh', '.aws', '.gnupg'],
  allowedSecretTemplates: ['.env.example', '.env.sample', '.env.template']
});

// 修正信号关键词默认值（中英双语），canonical 覆盖位是 feedback.signalKeywords
//（hooks.correctionKeywords 为废弃别名，仍可读）。
const CORRECTION_KEYWORDS_DEFAULT = Object.freeze([
  '不对', '错了', '不是这样', '重来', '你搞错了', '别这样', '以后不要', '不是我要的',
  'wrong', 'that\'s wrong', 'not what i', 'redo', 'do not do that again', 'try again'
]);

function validateServices(services) {
  if (services === undefined) return {};
  assertPlainObject(services, 'services');
  for (const [name, definition] of Object.entries(services)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new HarnessError(`非法服务名：${name}`, 'CONFIG_INVALID');
    assertPlainObject(definition, `services.${name}`);
    assertKnownFields(definition, new Set(['command', 'healthUrl', 'cwd', 'restart']), `services.${name}`);
    if (typeof definition.command !== 'string' || !definition.command.trim()) {
      throw new HarnessError(`services.${name}.command 必填`, 'CONFIG_INVALID');
    }
    if (definition.healthUrl !== undefined && (typeof definition.healthUrl !== 'string' || !/^https?:\/\//.test(definition.healthUrl))) {
      throw new HarnessError(`services.${name}.healthUrl 必须是 http(s) URL`, 'CONFIG_INVALID');
    }
    if (definition.cwd !== undefined) relativeSafe(definition.cwd, `services.${name}.cwd`);
    if (definition.restart !== undefined) {
      assertPlainObject(definition.restart, `services.${name}.restart`);
      assertKnownFields(definition.restart, new Set(['maxRestarts', 'windowSec', 'backoffMs', 'backoffMaxMs', 'healthFailures']), `services.${name}.restart`);
      for (const field of ['maxRestarts', 'windowSec', 'backoffMs', 'backoffMaxMs', 'healthFailures']) {
        if (definition.restart[field] !== undefined) assertPositiveInt(definition.restart[field], `services.${name}.restart.${field}`);
      }
    }
  }
  return services;
}

function validateHarnessConfig(config) {
  assertPlainObject(config, 'harness.json');
  assertKnownFields(config, new Set([
    'version', 'catalogFile', 'matrixFile', 'adrDir', 'rules',
    'outputLimits', 'context', 'catalog', 'locks', 'security', 'retention', 'services', 'hooks',
    // 模板形态的命名区段（兼容接受并映射到内部模型）
    'project', 'governance', 'quality', 'fastMode', 'feedback',
    // P4：需求可判定性/追溯 与 宪法执法率审计
    'spec', 'rulesAudit',
    // P6：变更预算（budget 动词的上限来源；全可选正整数）
    'budget'
  ]), 'harness.json');
  if (config.version !== 1) throw new HarnessError('harness.json 的 version 必须等于 1', 'CONFIG_INVALID');
  for (const field of ['catalogFile', 'matrixFile', 'adrDir']) {
    if (config[field] !== undefined) relativeSafe(config[field], field);
  }
  if (config.rules !== undefined) {
    assertStringArray(config.rules, 'rules', { allowEmpty: false });
    for (const rule of config.rules) relativeSafe(rule, 'rules 条目');
  }
  for (const [section, defaults] of [['outputLimits', OUTPUT_LIMIT_DEFAULTS], ['locks', LOCK_DEFAULTS]]) {
    if (config[section] === undefined) continue;
    assertPlainObject(config[section], section);
    assertKnownFields(config[section], new Set(Object.keys(defaults)), section);
    for (const field of Object.keys(config[section])) assertPositiveInt(config[section][field], `${section}.${field}`);
  }
  if (config.retention !== undefined) {
    assertPlainObject(config.retention, 'retention');
    assertKnownFields(config.retention, new Set([...Object.keys(RETENTION_DEFAULTS), 'evidenceDays', 'ledgerMaxEntries']), 'retention');
    for (const field of Object.keys(config.retention)) assertPositiveInt(config.retention[field], `retention.${field}`);
  }
  if (config.context !== undefined) {
    assertPlainObject(config.context, 'context');
    // defaultBudget 是 budgetTokens 的废弃别名（均可读，canonical 为 budgetTokens）。
    assertKnownFields(config.context, new Set(['defaultBudget', 'maxFileChars', 'maxFiles', 'budgetTokens', 'deny']), 'context');
    for (const field of ['defaultBudget', 'maxFileChars', 'maxFiles', 'budgetTokens']) {
      if (config.context[field] !== undefined) assertPositiveInt(config.context[field], `context.${field}`);
    }
    if (config.context.deny !== undefined) assertStringArray(config.context.deny, 'context.deny', { allowEmpty: false });
  }
  if (config.catalog !== undefined) {
    assertPlainObject(config.catalog, 'catalog');
    assertKnownFields(config.catalog, new Set(['maxTrackedPaths', 'maxChangedPaths', 'maxScanFiles']), 'catalog');
    for (const field of Object.keys(config.catalog)) assertPositiveInt(config.catalog[field], `catalog.${field}`);
  }
  if (config.security !== undefined) {
    assertPlainObject(config.security, 'security');
    assertKnownFields(config.security, new Set(Object.keys(SECURITY_DEFAULTS)), 'security');
    for (const field of Object.keys(config.security)) assertStringArray(config.security[field], `security.${field}`, { allowEmpty: false });
  }
  if (config.hooks !== undefined) {
    assertPlainObject(config.hooks, 'hooks');
    // stopFuseLimit 是 stopMaxBlocks 的废弃别名；correctionKeywords 是 feedback.signalKeywords 的废弃别名（均可读，canonical 优先）。
    assertKnownFields(config.hooks, new Set(['correctionKeywords', 'reviewAction', 'stopFuseLimit', 'stopMaxBlocks', 'injectInvariants']), 'hooks');
    if (config.hooks.correctionKeywords !== undefined) assertStringArray(config.hooks.correctionKeywords, 'hooks.correctionKeywords', { allowEmpty: false });
    if (config.hooks.reviewAction !== undefined && !['block', 'warn'].includes(config.hooks.reviewAction)) {
      throw new HarnessError('hooks.reviewAction 只能是 block 或 warn', 'CONFIG_INVALID');
    }
    if (config.hooks.stopFuseLimit !== undefined) assertPositiveInt(config.hooks.stopFuseLimit, 'hooks.stopFuseLimit');
    if (config.hooks.stopMaxBlocks !== undefined) assertPositiveInt(config.hooks.stopMaxBlocks, 'hooks.stopMaxBlocks');
    if (config.hooks.injectInvariants !== undefined && typeof config.hooks.injectInvariants !== 'boolean') {
      throw new HarnessError('hooks.injectInvariants 必须是布尔', 'CONFIG_INVALID');
    }
  }
  if (config.spec !== undefined) {
    assertPlainObject(config.spec, 'spec');
    assertKnownFields(config.spec, new Set(['requirementDirs', 'testGlobs', 'minCoverage']), 'spec');
    if (config.spec.requirementDirs !== undefined) {
      assertStringArray(config.spec.requirementDirs, 'spec.requirementDirs', { allowEmpty: false });
      for (const dir of config.spec.requirementDirs) relativeSafe(dir, 'spec.requirementDirs 条目');
    }
    if (config.spec.testGlobs !== undefined) {
      assertStringArray(config.spec.testGlobs, 'spec.testGlobs', { allowEmpty: false });
      for (const glob of config.spec.testGlobs) relativeSafe(glob, 'spec.testGlobs 条目');
    }
    if (config.spec.minCoverage !== undefined) {
      if (typeof config.spec.minCoverage !== 'number' || !(config.spec.minCoverage > 0) || config.spec.minCoverage > 1) {
        throw new HarnessError('spec.minCoverage 必须是 (0,1] 区间的小数', 'CONFIG_INVALID');
      }
    }
  }
  if (config.rulesAudit !== undefined) {
    assertPlainObject(config.rulesAudit, 'rulesAudit');
    assertKnownFields(config.rulesAudit, new Set(['maxUnenforced']), 'rulesAudit');
    if (config.rulesAudit.maxUnenforced !== undefined
      && (!Number.isInteger(config.rulesAudit.maxUnenforced) || config.rulesAudit.maxUnenforced < 0)) {
      throw new HarnessError('rulesAudit.maxUnenforced 必须是非负整数', 'CONFIG_INVALID');
    }
  }
  // 变更预算：全部字段可选的正整数上限；未配置 = 预算门未激活（budget 动词降级 exit 3）。
  if (config.budget !== undefined) {
    assertPlainObject(config.budget, 'budget');
    assertKnownFields(config.budget, new Set(['maxChangedFiles', 'maxChangedLines', 'maxModules', 'maxNewFiles']), 'budget');
    for (const field of Object.keys(config.budget)) assertPositiveInt(config.budget[field], `budget.${field}`);
  }
  if (config.project !== undefined) {
    assertPlainObject(config.project, 'project');
    assertKnownFields(config.project, new Set(['name', 'riskDefault']), 'project');
    if (config.project.name !== undefined && typeof config.project.name !== 'string') throw new HarnessError('project.name 必须是字符串', 'CONFIG_INVALID');
    if (config.project.riskDefault !== undefined && !RISKS.includes(config.project.riskDefault)) {
      throw new HarnessError('project.riskDefault 只能是 low/medium/high', 'CONFIG_INVALID');
    }
  }
  if (config.governance !== undefined) {
    assertPlainObject(config.governance, 'governance');
    assertKnownFields(config.governance, new Set(['attributes', 'protected', 'tiers']), 'governance');
    for (const field of ['attributes', 'protected', 'tiers']) {
      if (config.governance[field] !== undefined) assertStringArray(config.governance[field], `governance.${field}`, { allowEmpty: false });
    }
  }
  if (config.quality !== undefined) {
    assertPlainObject(config.quality, 'quality');
    assertKnownFields(config.quality, new Set(['riskChecks', 'runtimeValidityHours']), 'quality');
    if (config.quality.riskChecks !== undefined) {
      assertPlainObject(config.quality.riskChecks, 'quality.riskChecks');
      assertKnownFields(config.quality.riskChecks, new Set(RISKS), 'quality.riskChecks');
      for (const risk of RISKS) {
        if (config.quality.riskChecks[risk] !== undefined) {
          assertStringArray(config.quality.riskChecks[risk], `quality.riskChecks.${risk}`, { allowEmpty: false });
        }
      }
    }
    if (config.quality.runtimeValidityHours !== undefined) assertPositiveInt(config.quality.runtimeValidityHours, 'quality.runtimeValidityHours');
  }
  if (config.fastMode !== undefined) {
    assertPlainObject(config.fastMode, 'fastMode');
    assertKnownFields(config.fastMode, new Set(['defaultTtlHours']), 'fastMode');
    if (config.fastMode.defaultTtlHours !== undefined) assertPositiveInt(config.fastMode.defaultTtlHours, 'fastMode.defaultTtlHours');
  }
  if (config.feedback !== undefined) {
    assertPlainObject(config.feedback, 'feedback');
    assertKnownFields(config.feedback, new Set(['signalKeywords']), 'feedback');
    if (config.feedback.signalKeywords !== undefined) assertStringArray(config.feedback.signalKeywords, 'feedback.signalKeywords', { allowEmpty: false });
  }
  validateServices(config.services);
  return config;
}

// 项目根 = 含 .kimi-base/harness.json 的目录，自 start 向上查找。
// KIMI_BASE_ROOT 环境变量显式钉死项目根（fleet status 等子进程编排场景：
// 子进程 cwd 在成员仓内，向上查找可能撞上祖先仓的 harness.json——钉根后只认该目录）。
export async function findProjectRoot(start) {
  const pinned = process.env.KIMI_BASE_ROOT;
  if (pinned) {
    const root = path.resolve(pinned);
    return (await pathExists(path.join(root, CONFIG_REL))) ? root : null;
  }
  let cursor = path.resolve(start);
  for (;;) {
    if (await pathExists(path.join(cursor, CONFIG_REL))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export async function requireProjectRoot(start) {
  const root = await findProjectRoot(start);
  if (!root) {
    throw new HarnessError(`从 ${start} 向上未找到 ${CONFIG_REL}；请在 kimi-base 项目内运行，或用 --project 指定`, 'PROJECT_ROOT_NOT_FOUND');
  }
  return root;
}

export async function loadContext(projectRoot) {
  const root = await realpath(path.resolve(projectRoot));
  const configPath = path.join(root, CONFIG_REL);
  const config = validateHarnessConfig(await readJsonFile(configPath));
  return {
    root,
    configPath,
    config,
    stateDir: path.join(root, STATE_DIR),
    catalogPath: path.join(root, config.catalogFile ?? CATALOG_REL),
    matrixPath: path.join(root, config.matrixFile ?? MATRIX_REL),
    archBaselinePath: path.join(root, ARCH_BASELINE_REL),
    adaptersPath: path.join(root, ADAPTERS_REL),
    adrDir: config.adrDir ?? 'docs/adr',
    rules: config.rules ?? [],
    riskDefault: config.project?.riskDefault ?? 'low',
    projectName: config.project?.name ?? null,
    retention: {
      ...RETENTION_DEFAULTS,
      ...(config.retention?.evidenceDays ? { evidenceMaxAgeDays: config.retention.evidenceDays } : {}),
      ...(config.retention ?? {})
    },
    outputLimits: { ...OUTPUT_LIMIT_DEFAULTS, ...(config.outputLimits ?? {}) },
    locks: { ...LOCK_DEFAULTS, ...(config.locks ?? {}) },
    security: { ...SECURITY_DEFAULTS, ...(config.security ?? {}) },
    contextDefaults: {
      // canonical 旋钮是 context.budgetTokens；context.defaultBudget 是废弃别名（仍可读，优先级更低）。
      defaultBudget: config.context?.budgetTokens ?? config.context?.defaultBudget ?? 60000,
      maxFileChars: config.context?.maxFileChars ?? 20000,
      maxFiles: config.context?.maxFiles ?? 200
    },
    contextDenyGlobs: config.context?.deny ?? [],
    catalogLimits: { maxTrackedPaths: 100000, maxChangedPaths: 5000, maxScanFiles: 20000, ...(config.catalog ?? {}) },
    hooks: {
      // canonical 旋钮是 feedback.signalKeywords；hooks.correctionKeywords 是废弃别名（仍可读）。
      correctionKeywords: config.feedback?.signalKeywords ?? config.hooks?.correctionKeywords ?? [...CORRECTION_KEYWORDS_DEFAULT],
      reviewAction: config.hooks?.reviewAction ?? 'block',
      // canonical 旋钮是 hooks.stopMaxBlocks；hooks.stopFuseLimit 是废弃别名（仍可读）。
      stopFuseLimit: config.hooks?.stopMaxBlocks ?? config.hooks?.stopFuseLimit ?? 3,
      // sessionStart 横幅是否追加 invariants 摘要（压缩后再注入铁律；默认开）。
      injectInvariants: config.hooks?.injectInvariants ?? true
    },
    fastDefaults: { defaultTtlHours: config.fastMode?.defaultTtlHours ?? 24 },
    // 需求可判定性与追溯（spec lint / trace / spec view 的事实源）。
    spec: {
      requirementDirs: config.spec?.requirementDirs ?? ['Product-Spec.md'],
      testGlobs: config.spec?.testGlobs ?? ['tests/**'],
      minCoverage: config.spec?.minCoverage ?? 1
    },
    // rules-audit 的执法阈值：null = 纯建议（恒 exit 0）；数字 = 超限 exit 1。
    rulesAudit: { maxUnenforced: config.rulesAudit?.maxUnenforced ?? null },
    // 变更预算上限（budget 动词）；空对象 = 未配置（budget 降级 exit 3，绝不假绿）。
    budget: config.budget ?? {},
    riskChecks: config.quality?.riskChecks ?? null,
    // runtime 类证据（matrix check "class":"runtime"）的默认时间窗；检查级 runtimeValidityHours 优先。
    runtimeValidityHours: config.quality?.runtimeValidityHours ?? 24,
    services: config.services ?? {}
  };
}
