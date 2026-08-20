---
description: 体检当前项目的 kimi-base 安装并逐条修复报告的问题
---
1. 运行 `node .kimi-base/runtime/kimi-base.mjs doctor $ARGUMENTS`
   （项目内 runtime 缺失时，改用插件根的 `runtime/kimi-base.mjs`）。
2. 对报告中的每个问题逐条修复：缺文件 → 重新 install 或按提示补；配置非法 → 修正后重跑。
3. 每修一条重跑一次 doctor 验证，直到 exit 0 或剩余问题确需用户决策。
4. 汇总输出：已修复项 / 待用户决策项，并说明各自依据。
