# OPERATIONS：运维手册

所有命令形如 `node .kimi-base/runtime/kimi-base.mjs <verb>`（源仓内为 `runtime/kimi-base.mjs`）。退出码：0=成功/PASS，1=用法或内部错误，2=治理阻断。

## 1. 安装与自检

| 命令 | 说明 |
| --- | --- |
| `install <target> [--dry-run]` | 事务安装项目面（staging/备份/rollback） |
| `upgrade <target>` | 升级框架文件；用户定制写 `*.kimi-base-new` 旁路 |
| `uninstall <target>` | 仅删除仍等于基线的文件 |
| `doctor [target]` | 完整性自检（哈希/frontmatter/指针/JSON） |
| `manifest --write\|--check` | 生成/校验 FRAMEWORK-MANIFEST.json |
| `pack-check` | 发布面泄漏审计 |
| `selftest` | 引擎冒烟 |

## 2. 日常开发循环

```bash
node .kimi-base/runtime/kimi-base.mjs task start --goal "实现 X" --owned "src/x/**" --risk medium
# ……编码……
node .kimi-base/runtime/kimi-base.mjs impact --git        # 影响面
node .kimi-base/runtime/kimi-base.mjs gate                # 受影响检查→回执
node .kimi-base/runtime/kimi-base.mjs quality status      # 五性覆盖判定
node .kimi-base/runtime/kimi-base.mjs task complete       # 完成门
```

## 3. 架构看护

- `catalog lint`：路径归属/禁 catch-all/定档理由。
- `arch check [--scan]`：实边对账。违规分级：禁边 > 分层 > 未声明。
- `arch baseline --write`：固化存量债（每条带 reason）；已还清条目会标 stale 催删。
- `arch trend --record|--gate`：漂移快照与棘轮门（CI/发布前跑 --gate）。
- `adr check`：ADR 的 `Enforced-by:` 必须指向真实检查或 `manual:`。

## 4. 质量属性

- `quality status`：覆盖判定（反证压过佐证；critical/high 缺证据 exit 2）。
- `quality waiver create --check K --approver 人 --reason 因 --expires ISO --compensation 补偿`：只豁免 BLOCKED/SKIPPED；security/safety 禁词拒绝；绑指纹，过期自失效。
- `fitness [--path]`：五规则扫描。

## 5. Fast Mode

- `fast on [小时数]` / `fast off` / `fast status`：限时旁路（默认 24h），仅跳过声明 `allowFastSkip:true` 的非保护检查；每次 skip 留痕；security/safety 免疫。

## 6. 风险与卫生

- `risk scan`：状态腐化/死锁残留/stale 基线/脏树。
- `gate-audit`：死闸审计——长期零拦截的闸要么拿出证据要么撤掉。
- `retention prune`：按 retention 策略销毁过期证据（保护被 receipt 引用的）。
- `receipt verify`：账本链校验；断链 fail-closed（视同未验证）。

## 7. 服务守护（开发态）

- `services` 在 harness.json 声明；`supervisor.mjs start|stop|status|logs <name>`。
- 退避拉起/健康探针/重启风暴熔断/日志轮转；只 kill 自己启动的进程；**不是生产 init**。

## 8. 故障恢复

| 症状 | 处置 |
| --- | --- |
| 压缩/重启后状态丢失 | `/kimi-base:recap`：读 progress+Spec+CHANGELOG+compaction-note |
| Stop 门连续误拦 | 同一指纹 3 次后自动放行；查 gate-log 定位欠账 |
| receipt 被判 stale | 指纹变了（有改动）；重跑 `gate` |
| 账本断链 | `receipt verify` 定位断点；断链后 quality status 视同未验证，重跑检查 |
| 安装中途失败 | 自动逆序 rollback；残留 staging 在 `.kimi-base/state/install-*`，人工清理 |
| hook 不生效 | 确认插件已安装且 `/plugins` 中启用；确认项目根有 `.kimi-base/harness.json`；`kimi doctor` 查配置 |
