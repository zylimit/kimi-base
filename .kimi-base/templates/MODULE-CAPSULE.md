# Module Capsule: <module-id>

<!--
填写指引：
- 每模块一份 capsule，放在模块根目录或 docs/modules/<module-id>.md，catalog 的 capsule 字段指向它。
- capsule 是 context pack 的模块级摘要——写给「没读过这个模块的 fresh 执行者」看的一页纸。
- 只写稳定事实；易变细节（行数、函数清单）不写，写了必漂移。
-->

- Purpose: <一句话职责——这个模块为什么存在>
- Public contracts: <对外暴露的接口/schema 路径清单（contracts/ 下的文件）>
- Dependencies: <dependsOn 的模块 id + 各依赖什么能力>
- Consumers: <谁在用我（模块 id 或「未知，需 impact 确认」）>
- Owned paths: <paths glob，与 catalog 一致>
- Test entry points: <跑哪些命令/目录能验证我>
- Known risks: <已知的坑、遗留债、危险区>
