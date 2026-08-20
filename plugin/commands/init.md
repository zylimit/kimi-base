---
description: 在当前项目安装 kimi-base 项目面并引导补全配置
---
在当前项目安装 kimi-base 项目面：

1. 定位 kimi-base 运行时：插件根（或仓库根）下含 `runtime/kimi-base.mjs` 的目录，可用 Glob 查找确认。
2. 运行：`node <插件根>/runtime/kimi-base.mjs install . $ARGUMENTS`
3. 安装失败则原样转述输出并停止，不要手工补文件。
4. 成功后引导用户补全两份配置：
   - `.kimi-base/harness.json`：项目名、模块边界、治理开关；
   - `.kimi-base/module-catalog.json`：文件 → 模块映射与档位。
5. 先读出现有内容，再逐项向用户提问补全；模块划分依据真实目录结构，不要凭空编造。
