---
name: kimi-base
description: kimi-base harness 会话路由：检测项目治理标记并装载对应工作流纪律
type: prompt
whenToUse: 每个会话开始时自动加载（插件 sessionStart）；非 kimi-base 项目中保持静默
---

# kimi-base 会话路由

本 skill 由插件 sessionStart 在每个会话启动时加载。它不做治理动作，只负责：
检测当前项目是否为 kimi-base 项目 —— 不是则全程静默；是则装载治理状态并按用户意图路由。

## 第一步：检测项目标记（必须最先执行）

用 Glob 或 Bash 检查当前项目根是否存在 `.kimi-base/harness.json`：

- **不存在** → 这是别的项目。立即结束本 skill：不输出任何内容、不执行任何命令、
  不在回复中提及 kimi-base。
- **存在** → 继续下一步。

## 第二步：装载治理状态（仅 kimi-base 项目）

0. 引擎解析（先探测再运行）：优先项目内引擎 `.kimi-base/runtime/kimi-base.mjs`；
   项目内不存在时（未 setup 或安装不完整），检查环境变量 `KIMI_PLUGIN_ROOT`
   是否已设置且其下 `.kimi-base/runtime/kimi-base.mjs` 真实存在——`KIMI_PLUGIN_ROOT`
   只保证注入插件 hook 进程，Agent 的 Bash 环境未必有，必须先探测再使用，存在才用
   受管引擎跑 `install` / `doctor` 完成首次接入。两者都找不到时如实报告
   "治理引擎不可用"并继续，不静默、不中断会话。
1. 读 `.kimi-base/harness.json`（项目名、模块边界、治理配置）。
2. 用第 0 步解析出的引擎路径（记为 KB）依次运行：
   - `node <KB> task status`
   - `node <KB> quality status`
   - `node <KB> fast status`
   （项目内引擎缺失且 KIMI_PLUGIN_ROOT 不可用时，跳过本步并在横幅标注"治理引擎不可用"）
3. 向用户输出简短横幅（≤6 行）：项目名 / 活跃任务 / fast mode 状态 / 待验证项（gate 四态摘要）。
   某条命令失败时在横幅对应位置标注"治理引擎不可用"并继续，不要中断会话。

## 第三步：意图路由

意图 → skill 的路由表单源定义在 `.kimi-base/rules/intent-routing.md`——**完整读取该文件再路由**（口径：1% 相关即调用，不等用户明说；多命中按表序装载）。

## 恢复规则（会话恢复 / 上下文压缩后必须执行）

满足任一条件即视为"恢复会话"：用户提到"继续 / 上次 / 恢复"，或对话开头出现压缩摘要。
恢复时必须读齐以下材料才算恢复完成，缺一不可：

1. `progress.md`
2. `Product-Spec.md`
3. `Product-Spec-CHANGELOG.md`
4. `.kimi-base/state/compaction-note.json`（若存在）

读齐后先向用户复述"上次做到哪、下一步是什么"，再继续工作。
文件缺失时如实说明缺口，不要编造。

## 上下文预算纪律

- 主 Agent 不亲自读大文件全文（日志、锁文件、生成物、>500 行的源码）。
- 探索性搜索、泛读、汇总一律外包给 explore / researcher 子代理，主 Agent 只消费结论。
- 只有必须精读的文件（治理四件、当前任务直接相关的源码）才进主上下文。
