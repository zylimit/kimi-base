---
description: 汇总 kimi-base 项目状态报告（任务/质量/fast/未提交改动）
---
依次运行并汇总为一份简短的项目状态报告：

1. `node .kimi-base/runtime/kimi-base.mjs task status`（活跃任务）
2. `node .kimi-base/runtime/kimi-base.mjs quality status`（属性覆盖）
3. `node .kimi-base/runtime/kimi-base.mjs fast status`（fast mode）
4. `git status --short`（未提交改动；非 git 仓则注明）

报告分四节：任务 / 质量 / fast mode / 未提交改动，末尾给一句"下一步建议"。
某条命令失败就在对应节标注失败原因，不要中断整体汇报。$ARGUMENTS 为用户补充关注点。
