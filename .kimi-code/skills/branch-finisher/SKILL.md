---
name: branch-finisher
description: 当用户要求收尾当前分支、合并前整理、处理 worktree/detached HEAD 或结束本轮开发时使用。
type: prompt
whenToUse: 当用户说收尾、合并分支、这个分支弄完了、提 PR，或要切走做别的事时
---

# Branch Finisher — 分支收尾

## 目标

安全整理当前 Git/工作树状态、验证证据、文档同步和合并选择，不隐式 commit、push、rebase、merge 或清理 worktree。

## 流程

1. **探测**：repository root、status/branch、HEAD、upstream、ahead/behind、git dir/common dir、worktree 和 superproject。
2. **分类**：正常分支、detached HEAD、worktree、dirty tree、冲突中、无 upstream。
3. **收尾清单（逐项过，不过不合并）**：
   - **未提交改动**：`git status` 逐文件定性——该提交 / 该 stash / 该删（经用户确认）/ 该进 .gitignore；不留无名改动。
   - **未跑验证**：当前 diff 是否有新鲜的验证证据；harness 启用时 `node .kimi-base/runtime/kimi-base.mjs quality status` 看证据新鲜度与五性覆盖，`receipt verify` 看账本链完整性，`gate` 看质量门。没验证过的改动不许合并。
   - **文档同步**：progress.md（决策/完成/TODO 已记录）、Product-Spec.md + Product-Spec-CHANGELOG.md（需求变更已成对更新）、DEV-PLAN.md（Task 状态勾选）三处与本分支实际产出一致。
   - **交接文档**：分支若暂留，写清恢复入口——做到哪、下一步是什么、有哪些坑（进 progress.md 的 In Progress / Risks）。
4. 给用户最多 3 个选择：继续修复未通过项 / 准备本地提交或合并（展示精确文件、目标分支和新鲜验证）/ 保留当前分支或 worktree 并记录恢复入口。
5. 只有用户明确选择并授权后，才执行对应 Git 或远端动作；每一步后重新检查状态。

## 安全边界

- 不删除未合并分支或自己未创建/未确认的 worktree。
- dirty tree 不切分支、不 rebase、不覆盖文件。
- 不使用会批量丢弃或删除工作树内容的命令作为「清理」。
- push、force push、tag、PR/merge 和远端删除分别需要授权。
- 操作超时或中断后先核查本地/远端真实状态，不盲目重试。

## 回执

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Changed:
Verified:
Not verified:
Needs review by:
Evidence: <git status 输出位置 + 收尾清单逐项结论>
```

## 初始化

从探测开始。
