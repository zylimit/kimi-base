# 派单契约细则（单源定义）

**命中本指针必须完整读取再行动，不得凭指针行猜测内容。**

## 派单包七字段

主 Agent 的每次派单必须写齐七字段；缺任何一项，子代理不得开工，以 `NEEDS_CONTEXT` 回传缺哪项：

1. **Goal**：要达成什么（一个可独立判定的行为切片）
2. **Scope**：允许改动的文件/目录，精确到路径
3. **Out of Scope**：明确不许碰的范围
4. **Existing Pattern**：必须遵循的既有模式/契约/命名，附位置指针
5. **Verification**：验收命令与预期结果（具体命令，不是「跑一下测试」）
6. **Escalation**：卡住时的升级路径（缺哪份上下文、找谁、是否换更强模型重派）
7. **Business Context（业务上下文）**：为什么做 / 谁受益 / 相关规则与例外

### Business Context 规则（REQ-070）

- 主 Agent 从 Product-Spec 抄录对应 REQ 的动机/受益人字段**原文**，不转述、不缩水。
- fresh 实例（子代理）**不许自行猜测**业务含义：字段缺失，或内容与实现/审查/测试发现矛盾时，回 `NEEDS_CONTEXT` 或在回执中产出「需求存疑」条目（见对应 skill 的「需求存疑回流」节）。
- 无 Spec 的小任务可标「无」，但必须一句话说明为什么不需要业务上下文。

## 交接声明（所有子代理统一适用）

你的最后一条消息就是交付给主 Agent 的完整交接（Kimi 自定义子代理没有内置交接框架）：主 Agent 看不到你的中间过程，只能看到这最后一条消息——它必须自含全部结论与证据句柄。

## 回执信封六字段

子代理回传必须以回执信封开头。信封骨架与字段语义只在此定义；各 skill/agent 只补充本角色的填充口径，不重复定义骨架：

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Changed: <新建/修改的文件列表>
Verified: <已验证项，逐项附命令 + 退出码 + 关键输出>
Not verified: <未验证项，诚实列出>
Needs review by: <需要谁复核什么，及原因>
Evidence: <证据句柄：路径 / 命令输出位置 / commit / 时间戳>
```

- **Status 四态**：DONE=干净完成；DONE_WITH_CONCERNS=完成但有顾虑（逐条列出）；NEEDS_CONTEXT=缺输入，点名缺哪项；BLOCKED=被环境/权限阻断。BLOCKED 是诚实不是失败。
- 不得用「应该没问题」「之前跑过」替代当前证据；Evidence 必须绑定当前 diff 指纹。
