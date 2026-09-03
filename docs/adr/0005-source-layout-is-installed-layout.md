# ADR-0005：源布局 = 安装布局（自托管，template/ 消亡）

状态：Accepted · 日期：2026-09-02 · 决策者：用户 + 主 Agent
Enforced-by: manifest-check, pack-check, unit

## 背景

v1 把交付面放在 `template/`，本仓自用治理另有一套——同一份资产维护两份，复制面与自用面必然漂移（改一份忘另一份），且本仓从不用自己发出去的布局，dogfood 是空话。dsh-base 的单目录布局证明：源布局与安装布局合一可行。

## 决策

1. `template/` 消亡。载荷即 `.kimi-base/`（runtime / rules / templates / audit / githooks / adapters + `*.example.json` 种子）+ `.kimi-code/`——仓库里的样子就是装到目标项目里的样子。
2. **本仓自托管**：本仓自己的 `harness.json` / `module-catalog.json` / `verification-matrix.json` 治理 kimi-base 自身（永不进安装面）；安装面只发 `*.example.json` 种子。
3. **种子语义**：种子只在目标缺失时落地；upgrade 永不覆盖已落地配置；uninstall 仅删未被用户改动过的文件。
4. 安装器为受管恒等映射 + 事务（staging/备份/逆序 rollback）；复制面白名单由 `FRAMEWORK-MANIFEST.json` 钉死，改任何载荷文件必须同 commit 重生成（`manifest --write`），否则 `manifest --check` 红。
5. 引擎拆分为薄路由入口 + `lib/` 模块（源布局与单文件引擎的可维护性阈值同时解决）。

## 备选与拒绝理由

- 维持 template/ 双份 → 拒绝：双份维护必然漂移；dogfood 不到交付面。
- 安装时模板渲染（占位符替换）→ 拒绝：恒等复制可字节级测（manifest 哈希）；渲染引入"源与安装物不同"的验证盲区。
- 三配置也进安装面 → 拒绝：目标项目的治理配置是它的主权资产；种子语义保证装后不覆盖。

## 后果

- 本仓每次 dogfood 都在实测交付面；载荷缺陷在本仓先疼。
- 纪律成本：载荷改动与 manifest 重生成同 commit（AGENTS.md 布局铁律第 1 条机械执法）。
