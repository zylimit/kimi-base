---
description: fast mode 开关与查询（security/safety/privacy 永不豁免）
---
1. 运行 `node .kimi-base/runtime/kimi-base.mjs fast $ARGUMENTS`
   （$ARGUMENTS 为 on / off / status，为空时默认 status）。
2. 向用户转述结果：当前开关状态、剩余 TTL、豁免范围。
3. 必须明确告知：fast mode 只豁免流程性检查，**security / safety 类检查永不豁免**，
   到期自动关闭，无需手工 off。
4. 必须明确告知：**fast 是借账不是折扣**——窗口内的 SKIPPED 带 `fastWindow` 印记，
   不能关闭 task，也不能通过 release；还债路径唯一：`fast off` 后重跑完整 `gate`。
