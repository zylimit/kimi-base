---
name: skill-builder
description: 当用户要求创建新 Skill，或进化引擎第四层提议新增框架技能时使用。
type: prompt
whenToUse: 当用户要求创建、修改 Skill，或进化引擎的新 Skill 提议获用户确认后
---

# Skill Builder — 新 Skill 工程化

## 任务

根据用户描述的需求或进化引擎的第四层提议，创建符合 Kimi 原生格式与框架规范的新 Skill。确保新 Skill 和现有 Skill 结构一致、风格统一、可像积木一样即插即用。

## 依赖检测

- 必需：无
- 可选：`.kimi-base/feedback/` 中的相关记录 → 如来自进化引擎提议，读取原始 feedback 了解需求背景

## 第一性原则

**模板优先**：先读 `${KIMI_SKILL_DIR}/templates/skill-template.md` 骨架，按结构填充，不从零开始写。

**参照现有**：创建前先读 1-2 个已有 Skill 作为参照，保持风格一致，不发明新格式。

**行为红绿先行**：Skill 是行为补丁，不是愿望清单。创建或大改 Skill 前必须先写 2-3 个会诱发错误行为的压力场景；能跑行为测试时先记录 baseline 失败，再用 Skill 内容堵住失败路径，最后复测通过。

**可自动化优先**：能用 doctor/selftest/hook/regex 静态检查拦住的规则，不只写进 Skill；文档负责判断，脚本负责机械约束。

**最小必要**：只创建需要的 Section。不为「看起来完整」加空内容或无关规则。

**来源可追溯**：从外部仓库、Skill、Prompt 或模板吸收内容时，记录来源 URL/路径、ref、访问日期、许可证和实际读过的文件；没有打开的来源不引用。

**复制处理显式（copy treatment 分级）**：外部内容逐项标为 `vendored_intact`（原样搬入）/ `vendored_modified`（改后搬入，注明改了什么）/ `synthesized`（消化后重写）/ `referenced_only`（只引用不复制）/ `excluded`（明确排除及原因）。许可证未知/不兼容、包含密钥/会话/运行态/隐藏安装行为的内容默认不复制。

**联网优先**：新 Skill 涉及不熟悉的领域，先 WebSearch 了解该领域最佳实践和常见问题，再设计维度清单和策略。

## Kimi 原生格式（硬约束）

- 目录式：`.kimi-code/skills/<name>/SKILL.md` + 可选 `templates/` `references/` `scripts/` 子目录
- frontmatter 必填 `name` + `description`；`name` 必须等于目录名（kebab-case）
- `description` ≤ 180 字符，触发式写法（「当……时使用」/「由……时使用」），**禁止写成流程摘要**——不得含「通过/分阶段/输出/生成/执行/支持/内置/维护」等流程词，防止模型读摘要而不加载全文
- `type: prompt`（可自动调用）或 `flow`（仅手动 `/skill:<name>`）
- 正文引用本 skill 子文件一律用 `${KIMI_SKILL_DIR}`；参数用 `$<name>` / `$ARGUMENTS`
- 正文中文

写完必跑 lint：`bash ${KIMI_SKILL_DIR}/scripts/skill-description-lint.sh`（校验全仓 skill 的 name/description 合规）。

## 创建规范

**Section 分类**：

- 必须有：`## 任务`、`## 依赖检测`、`## 第一性原则`、`## 初始化`
- 推荐有：`## 输出风格`、`## <领域>维度清单`、`## <领域>策略`
- 按需有：`## 信息充足度判断`（收集/分析型）、`## 回退策略`（发布/部署类）、多模式工作流程、压力场景

**交互模式参照**（按模式不按领域找参照）：

- 对话采集型 → product-spec-builder
- 自主分析型 → dev-planner、code-review
- 执行操作型 → dev-builder、release-builder
- 诊断修复型 → bug-fixer

## 工作流程

1. **需求收集**：这个 Skill 解决什么问题？什么时候触发？输入是什么？产出是什么？来自进化引擎提议 → 先读原始 feedback。
2. **参照现有**：按交互模式读 1-2 个最近邻 Skill。参照来自外部时，先建立最小来源清单（来源定位/ref/访问日期/许可证/实际读过的文件/每项 copy treatment/排除项）——未完成来源清单前，不直接复制外部内容。
3. **确定结构**：读 skill-template 骨架，选定 Section 集。
4. **设计行为红绿场景**：列出 2-3 个压力场景——触发语句 / 易错行为（没有这 Skill 时 Agent 会怎么偷懒、误判或越界）/ 期望行为。必须覆盖最危险的失败模式，不写泛泛的 happy path。环境允许时用 `bash ${KIMI_SKILL_DIR}/scripts/test-skill-behavior.sh` 跑 baseline 红 → 写 Skill → 复测绿；不能自动化的写入 Skill 自检清单并说明原因。
5. **填充内容**：逐 Section 填写。
6. **创建文件**：`.kimi-code/skills/<name>/` 下创建 SKILL.md 与必要子文件。自检：
   - name == 目录名？description ≤180 且无流程摘要词？lint 脚本过？
   - 压力场景中的易错行为是否都有明确规则拦截？
   - 能自动化检查的规则是否已落 doctor/selftest/hook，或说明为什么暂不自动化？
7. **登记**：提示主 Agent 在主控指令（AGENTS.md）中补充该 Skill 的触发条件与可用技能行——登记本身由主 Agent 执行。

## 初始化

执行第 1 步需求收集。
