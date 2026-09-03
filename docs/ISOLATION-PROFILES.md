# ISOLATION-PROFILES：隔离档案与诚实声明

## 1. 隔离层级表

| 层级 | 形态 | 何时用 | 保证 |
| --- | --- | --- | --- |
| L0 当前工作区 | 默认 | 日常开发 | 仅 hooks 护栏（fail-open）与权限审批 |
| L1 Git worktree | `.worktrees/` 下独立工作树 | 高风险重构、并行实验 | 文件系统级分支隔离；必须 gitignore；不删非本框架创建的 worktree |
| L2 外部沙箱/容器 | Docker/VM，用户自备 | 不可信代码、危险试验 | OS 级隔离；kimi-base 不提供也不假装提供 |
| L3 无隔离 | — | — | 始终明确告知：宿主无沙箱保证 |

规则：不声称 Docker 级隔离除非真在容器里；并行写要求文件所有权不相交（catalog 分区即判定依据）。

## 2. 护栏能力诚实声明

| 机制 | 是什么 | 不是什么 |
| --- | --- | --- |
| Kimi hooks（PreToolUse/Stop） | 防误操作护栏，exit 2 阻断明确危险 | 不是沙箱；**fail-open**：脚本异常/超时默认放行 |
| 危险命令分类器 | 语义解析降低绕过面（wrapper/管道/嵌套 shell） | 正则与解析总有漏；混淆命令可能穿透 |
| path 校验（越界写拦截） | realpath 防逃逸的应用层检查 | 不是 OS 锁；不防直接 shell 写 |
| 证据账本哈希链 | 本地篡改可检测 | 不是密码学签名；有写权限者可整体重写 |
| Kimi 权限审批（manual/yolo/auto + permission.rules） | **真正的最后防线** | yolo/auto 下防线大幅后移，自行评估 |

## 3. 权限模式建议

| 模式 | 适用 |
| --- | --- |
| manual | 默认；生产仓、发布操作、高危命令 |
| yolo | 受信任的本地批处理；配合 deny 规则（`Bash(rm -rf*)`、`Bash(git push*)`…） |
| auto | 仅限 L2 容器内或完全可弃环境 |

建议基线（写入用户级 `~/.kimi-code/config.toml`，项目面不替用户决定）：

```toml
[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "ask"
pattern = "Bash(git push*)"
```

## 4. 数据边界

- `.kimi-base/state/` 全部 git-ignored（安装器自动写 .gitignore）。
- evidence 落盘前正则脱敏；context pack DENY 清单（.env/*.pem/id_rsa/.ssh/.aws）永不入 LLM 上下文包。
- feedback 私密标记内容不进发布包；make-release 泄漏扫描非零退出。
- 会话目录（~/.kimi-code/sessions/）含提示词与输出，属本地调试材料，勿直接提交公开仓库。

## 5. 三面执法模型

同一套治理在三个面各有一道闸，互补而非冗余——每一面诚实声明自己能保证什么、不能保证什么：

| 面 | 时机 | 形态 | 诚实边界 |
| --- | --- | --- | --- |
| 插件 hooks（`hook <event>`） | 工具调用时 | 护栏：危险命令分类、写前对账、Stop 完成门 | **fail-open**：脚本异常/超时默认放行；不是沙箱 |
| git hooks（`.kimi-base/githooks/`，`install --hooks` 挂载） | 提交/推送时 | **本地 fail-closed**：pre-commit 静态电池、pre-push 跑 `dod`+`gate`、commit-msg 废话拦截 | `--no-verify` 可绕（HIGH 级行为）；机器无 node 时响亮放行（SKIPPED 不是 PASS） |
| CI 门禁（`.github/workflows/ci.yml` / 采纳者复制 `templates/github-gate.yml`） | 合并时 | **合并权威**：独立审计脚本 + dod + 测试 + 棘轮，全矩阵（OS×Node） | 不可绕——本地绕过在这里现形 |

要点：git hooks 跑的静态检查与 CI 是同一组定义（`dod` 的 DOD_STEPS 是唯一事实源），本地红 = CI 红，没有"本地能过 CI 才挂"的惊喜；CI 里的 `.kimi-base/audit/` 脚本不 import 引擎，引擎自身的缺陷无法让审计沉默。
