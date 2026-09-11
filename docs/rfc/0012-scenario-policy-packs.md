# RFC 0012 — 场景策略包（Skill）设计

> 状态：**Proposed**（2026-07-26）。**V1.1 内容** —— V1.0 不做，不阻塞任何 S1–S5 ticket。
> 来源：原文是 `docs/rfc/0006-cloud-runtime-architecture.md` §8，2026-07-26 评审建议搬出（内容未改，仅重编号）。
> 关联：`docs/adr/0001`（领域专长用 skill / 领域 context 包挂在同一个主 agent，不新增 agent）、`docs/research/agent-skills-design-patterns.md`、`docs/rfc/0009` §4（策略版本 delta 复用同一套报告索引）。

## 1. 背景：Skill 在架构中的位置

V1 的 skill **不是**新的一层控制流，而是**同一主 agent 的策略包**（ADR 0001 已授权该路径）：

```
turn input → 场景判定（模型选择或轻量分类）
   → 载入场景策略包：context 片段 + 允许的模板集 + 闸门强度 + 回答模板 + 检索范围
   → 仍然走同一个 loop、同一个 seam、同一套四道闸
```

- 策略包 = 数据（可版本化的文件/表行），**不是代码路径**。
- 策略包**不可覆盖**：安全闸、catalog 数字来源、写入规则、身份绑定。这些是硬编码不变量。
- 用户自定义 = 在该 schema 允许的字段内改（偏好、模板选择、检索范围），经校验后入库；非法值 fail-closed 回落到默认包。
- **不走 n8n / LangGraph 式可视化编排**：把安全关键的控制流放进可视化图，等于把安全论证从代码里搬到图里，闸的纯函数性与"每条行为都是 typed event"都会失效。

### 1.1 形态

采用 Agent Skills 的**三层成本模型**（描述常驻、正文按需、引用文件更按需）作为设计约束 —— 常驻成本只等于每条 skill 的 `description`，所以候选集必须小：

```
skills/
  log-meal/          SKILL.md（描述 + 程序性知识）+ policy.yaml + references/ + evals/
  nutrition-query/
  recommend/
  weekly-plan/
  review-reflect/
```

- `SKILL.md` frontmatter 只有 `name` / `description`，且 description 要回答"**何时用**"，不是"是什么"。
- `policy.yaml` 是机器可读的策略：`triggers`（触发意图与排除条件）、`tools.allow` / `tools.deny`（**只能收窄，不能扩张**）、`gates`（可被代码校验的约束声明）、`output.template`。
- `evals/` 放该场景的离线回归集。

### 1.2 选择机制：确定性路由优先，模型选择兜底

**不让模型从全量 skill 列表里自由挑选。** 两段式：代码先依据 typed event + 会话状态算出**候选集**（上一条是 pending confirm → 只开放 confirm/edit；用户提到过敏 → 强制 safety 路径），模型只在候选集内选择或要求澄清。候选集上限经验值是 5 条 —— 因为描述是线性常驻成本。

### 1.3 权威阶梯：谁能覆盖谁

| 层级 | 谁写 | 内容 |
| --- | --- | --- |
| **平台层（不可被 skill 或用户覆盖）** | 代码 | 数字必须来自 catalog observation；写入必须经确认；每轮恰好一个终态事件；过敏/药物冲突拒答；医疗建议拒答 |
| **开发者层（skill 声明，代码校验）** | 策略包 | 工具白名单、输出模板 id、澄清策略、引用要求、语气 |
| **用户层（表 + schema 校验）** | 用户 | 过敏原与忌口、宗教/伦理约束、目标、份量单位、偏好餐次、烹饪时间上限 |
| **禁止** | 任何人 | 改闸门、绕过确认、直接写库、放宽数值来源 |

**用户"自定义场景"= 填结构化偏好，不是写 prompt。** 开放用户自建时应限制为一个受 schema 校验的 `ScenarioSpec`（触发意图 + 偏好覆盖 + 输出模板），而不是一段自由文本 —— 自然语言政策包会在生成过程中随时生效，可能打乱有序流程（这是厂商自己文档化的副作用）。

### 1.4 评测与版本化

三层分开测（沿用外部调研的结论）：

1. **确定性断言**（跑现有 `turn` 缝隙）：数字都带来源、无确认不得 commit、过敏必拒、恰好一个终态事件 —— 回归集，要求接近 100%。
2. **路由混淆矩阵**：每个 skill 写 should-trigger / should-not-trigger 提示集，测命中率（这是 skill 最常见的退化点）。
3. **输出质量**：rubric + 人标校准，用 **pass^k** 而非 pass@k 报告（单次 75% 成功率下 pass^3 只剩约 42%）；评"产出了什么"而非"调用顺序"。

版本化：`policy.yaml` 带 semver，`SKILL.md` 与 `references/` 记内容哈希，并把 `(skill_id, version, hash)` 写进**每一轮事件流** —— 这样"哪一版策略产生了这个结果"永远可追溯，离线回放才有意义（它是 `docs/rfc/0006` §10 步骤 5「自进化闭环」的前提；本条 RFC 属 V1.1，V1.0 不做）。
