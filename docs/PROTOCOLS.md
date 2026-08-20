# PROTOCOLS：字段级协议

## 1. 派单包（主 Agent → 子代理，六字段）

```
Goal: 要达成什么（可判定）
Scope: 精确到文件路径的工作范围
Out of Scope: 明确不碰什么
Existing Pattern: 应遵循的现有模式/文件指针
Verification: 验收命令（具体可执行）
Escalation: 什么情况升级回主 Agent
```

## 2. 回执信封（子代理 → 主 Agent，六字段）

```
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Changed: 变更文件清单
Verified: 已验证项 + 命令 + 结果
Not verified: 未验证项（诚实留白）
Needs review by: 建议复核者
Evidence: 证据句柄（commit/路径/命令/receipt 文件）
```

纪律：回传=结论+证据句柄，不贴全文；"翻证据外包、下判断自留"。

## 3. 验证回执（receipt）

runtime 实际字段（`.kimi-base/state/receipts/<checkId>.json` 最新态索引 + `ledger.jsonl` 全量链）：

```json
{
  "task": "T-…",
  "checkId": "unit",
  "kind": "unit",
  "risk": "medium",
  "fingerprint": "sha256:…",
  "planHash": "sha256:…",
  "argvHash": "sha256:…",
  "argvDisplay": "npm test",
  "status": "PASS|FAIL|BLOCKED|SKIPPED",
  "exitCode": 0,
  "durationMs": 1234,
  "reason": "…",
  "summary": "≤2000 字符摘要",
  "evidencePath": "state/evidence/unit-….log",
  "evidenceSha256": "sha256:…",
  "evidenceBytes": 0,
  "toolVersion": "…",
  "createdAt": "…",
  "contentHash": "sha256:…"
}
```

绑定规则：fingerprint 变化即 stale；同 check 后续 FAIL 覆盖旧 PASS；`SKIPPED` 仅在 fast mode + 检查声明 `allowFastSkip:true` + 非 protected（security/safety kind 或属性）时出现，且留痕；长证据（>4000 字符）脱敏后落 evidence 文件，回执只带摘要与哈希。

## 4. 证据账本链

`ledger.jsonl` 每行一条完整回执记录（含 `contentHash`）；链字段 `chain = sha256(prev_chain + '\0' + contentHash)`（首条以 GENESIS 常量起链）。断链 fail-closed：`receipt verify` 报 TAMPERED/MISSING/DRIFT，`quality status` 视同未验证。

## 5. waiver

存储于 `.kimi-base/state/waivers.json`（`{version:1, waivers:[…]}`），单条字段：

```json
{
  "version": 1,
  "kind": "waiver",
  "id": "waiver-<时间戳>-<随机>",
  "checkId": "integration",
  "fingerprint": "sha256:…",
  "approver": "张三",
  "reason": "测试环境依赖外部服务",
  "expiresAt": "2026-09-01T00:00:00Z",
  "compensation": "每日手动跑 staging 验证",
  "createdAt": "…",
  "contentHash": "sha256:…"
}
```

硬规则（创建期+运行期双重写死）：检查 id/kind/attributes 命中禁词（security|safety|secret|credential|destructive）或属 protected → 拒绝创建；当前指纹下已有 FAIL 回执 → 拒绝（跑挂了必须修，不能请假）；过期/跨指纹/内容哈希不匹配 → 自动失效。

## 6. gate-log

`gate-log.jsonl` 每行：`{ts, hook, event, target(脱敏), decision(allow|block), reason}`。gate-audit 据此判定死闸。

## 7. fast-mode.json

`{"enabled": true, "expires_epoch": 1736668800, "by": "user", "reason": "…"}`；过期即关闭；保护 kind 不受理。

## 8. compaction-note.json

`{"baseCommit", "activeTask", "pendingChecks", "decisions", "risks", "nextCommand", "writtenAt"}`——压缩前最后落盘，recap 时优先读取。
