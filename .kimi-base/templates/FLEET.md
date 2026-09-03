# FLEET：仓群契约治理

一仓一服务、每仓小到单个 agent 装得下全模型，是对上下文墙的正确答案。但它不是
免费的：复杂度不消失，只是从文件间依赖搬到**仓间契约**。分布式单核就诞生在这个
面上——而单个仓库内部看不见这个面。`fleet.json` 把这个面变成显式声明图，
`fleet` 动词把它变成可执行的治理。

fleet.json 是**组级文件**（放在各仓的共同祖先目录），不是仓级配置：
installer 不种子它，它也不进任何单仓的 .kimi-base/。

## 1. fleet.json 模式

```json
{
  "version": 1,
  "name": "my-fleet",
  "repos": [
    {
      "id": "billing-api",
      "path": "billing-api",
      "owners": ["@payments-team"],
      "provides": [
        {
          "contract": "billing-api",
          "version": "2.3.0",
          "kind": "http",
          "status": "active",
          "adr": "docs/adr/0007-billing-v2.md"
        },
        {
          "contract": "billing-api",
          "version": "1.4.0",
          "kind": "http",
          "status": "deprecated",
          "sunset": "2026-12-31",
          "adr": "docs/adr/0007-billing-v2.md"
        }
      ],
      "consumes": [
        { "contract": "ledger-events", "version": "2.x" },
        { "contract": "stripe-api", "version": "*", "external": true }
      ]
    }
  ]
}
```

- `kind`：http | grpc | event | schema | library | file | other。
- `status`：active | deprecated | retired。deprecated **必须**带 sunset 日期——
  没人必须行动的废弃是永久的（`fleet lint` 报 DEPRECATED_WITHOUT_SUNSET，error）。
- 消费 fleet 外的契约：标 `external: true`，否则 DANGLING_CONSUME（error）。
- 版本选择器：精确版本、`*`/`any`、`2.x`/`2` 前缀；其余不匹配报 UNPROVIDED_VERSION（error）。
- 每个已发布契约指一条 ADR（CONTRACT_WITHOUT_ADR，warning）；同一契约只能有一个
  提供方（CONTRACT_MULTIPLE_OWNERS，error）；无人消费且未标 public/external 的契约
  是 ORPHAN_CONTRACT（warning）；跨仓契约环是 CONTRACT_CYCLE（warning）——环意味着
  这些仓无法独立发布，而那是拆仓的全部意义。

## 2. 纪律（不可谈判）

1. **已发布的契约版本永不原地改。** 新版本与旧版本**并排发布**，声明 sunset
   日期，迁移完所有消费者，才退役。
2. 破坏性变更前先跑 `fleet impact <contract>`：`coordinationCost` 是必须一起
   发布的仓数。**这个数字就是决策**，不是事后注脚。
3. 边界由共变判定，不由行数判定：仓内跑 `cochange`，高耦合无声明边 =
   BOUNDARY_SUSPECT；接受耦合要在 catalog `cochange.accepted` 写书面理由。
4. `fleet status [--deep]` 是组级体检：逐仓跑各自的 doctor（--deep 加 dod），
   任一仓有问题 exit 1。发布窗口前跑它，不凭印象。

## 3. 命令速查

```bash
node .kimi-base/runtime/kimi-base.mjs fleet lint                 # 清单校验
node .kimi-base/runtime/kimi-base.mjs fleet impact billing-api   # 波及面 + coordinationCost
node .kimi-base/runtime/kimi-base.mjs fleet status --deep        # 组级体检
node .kimi-base/runtime/kimi-base.mjs fleet recap                # 组级"现在到哪了"
# 定位：--fleet <path> > KIMI_BASE_FLEET > 自 cwd 向上逐级查找
```
