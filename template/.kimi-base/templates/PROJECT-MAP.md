# Project Map

<!--
填写指引：
- 全仓一页图：模块、公共契约、owners、验证入口、依赖方向。
- 机器可读事实以 .kimi-base/module-catalog.json 为权威；本文件是人读的导航图。
- 与 catalog 冲突时以 catalog（及 arch check 实测）为准，并回改本文件。
-->

## 模块总览

| Module | 职责（一句话） | Layer | Owners | 验证入口 |
|---|---|---|---|---|
| <id> | | | | <命令/目录> |

## 分层与依赖方向

<层级列表 + 一句话方向规则，如：interface → application → domain → contracts；依赖只许指向同层或更低层。>

## 公共契约

| Contract | 路径 | 提供方 | 消费方 | 变更策略 |
|---|---|---|---|---|
| | | | | <如：只加不改 / 版本化> |

## 红线（禁止依赖摘要）

| From | To | 原因 |
|---|---|---|
| | | <与 catalog forbiddenDependencies 保持一致> |
