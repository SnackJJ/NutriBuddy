# NutriBuddy — PRD v2

> 2026-06-25，经 `/grill-with-docs` 全面挑战原 PRD 后重写。
> 原 PRD v1 保留在 `docs/PRD.md`，作为历史参考。
>
> 2026-07-05 架构收敛：`docs/ADD.md` 是当前架构基准。本文保留产品目标与里程碑语境；凡与 ADD 冲突处，以 ADD 为准。

## 0. 项目定位

**一句话**：一个自建 agent harness 驱动的个人营养顾问，帮用户从海量权威营养数据中提取与个人情况相关的、有据可查的建议。

**核心价值**：

- 用户不用自己去翻 NIH ODS、USDA 数据库——agent 帮你查、帮你算、帮你对照
- 用户有过敏/用药等约束——agent 记在心里，推荐时自动排除
- 每个建议都有据可查——数字来自数据库，建议来自权威指南

**目标用户**：初期为开发者本人，开源后为有类似需求的英文用户（西式饮食场景）。

## 1. 目标与非目标

### 目标（Goals）

1. **搭建完整的 agent harness**：亲手拥有 control loop、context 组装、memory、verification、tracing 五块核心机械
2. **让 harness 可量化地提升可靠性**：通过 eval 体系证明"我的 harness 比裸调 LLM 更可靠"
3. **做出一个自己真正会用的工具**：帮自己在日常饮食决策中省去手动查数据的时间

### 非目标（Non-Goals）

- ❌ 端侧推理 / 小模型 RL 适配（归 NutriMind 项目）
- ❌ LangGraph / CrewAI 等框架
- ❌ 拍照识别 / 多模态录入
- ❌ Native App（初期）
- ❌ 中餐覆盖（M1 只做英文西式饮食）
- ❌ 多 agent 编排（ADN 0001 经对抗性验证后维持单 agent）

## 2. 架构

### 2.1 拓扑：单 Agent + 确定性代码 + Gates

```
Tagged turn input（utterance | proposal confirmation）
  → [Turn seam] 注入 model/store/catalog/clock ports
  → [Input gate] 约束扫描与 directive 注入
  → [ContextAssembler] pinned region + dynamic region
  → [Single Agent Loop] ReAct + typed query catalog
  → [Tool/Output/Commit gates] deterministic verdict events
  → Exactly one terminal event（final / clarification / write proposal / refusal / error）
```

核心原则：模型负责选择和叙述；事实、数字、实体、写入都由确定性代码定义和校验。食品实体只能来自 resolver minted catalog id；数字只能来自 query catalog observation；写入只能来自用户确认过的 stored proposal。

### 2.2 Loop：ReAct + Typed Query Catalog

- **ReAct**：处理歧义、追问、工具选择、write proposal 等交互决策。
- **Typed query catalog**：模型只发出 template id + typed parameters；executor 渲染 reviewed SQL 并返回 schema-declared observation。模型不从零写 SQL，不做营养数字心算。
- **Step budget**：`MAX_STEPS=8`。预算耗尽必须产出 typed stop reason 和 deterministic refusal，不允许静默截断。
- **Terminal protocols**：clarification request 和 write proposal 都是 terminal events；用户回复或确认是下一次 turn input。
- **Buffered release**：最终回答先完整生成并过 output gate；不做 token streaming。UI 可流式展示 step events。

### 2.3 八个模块与当前切片

| 模块                 | 当前架构职责                                                                                  | 推迟的                         |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| **Loop**             | 单 turn orchestration；ReAct + typed query catalog；8 step budget；terminal event discipline   | —                              |
| **ContextAssembler** | pinned region（system contracts + catalog signatures + profile/rules snapshot）+ dynamic region | compaction                     |
| **ToolRegistry**     | `query_catalog` / `get_food_nutrition` / proposal-only `log_meal`                              | autonomous exact-match writes  |
| **MemoryStore**      | profile constraints、meal ledger、proposals、reference data                                    | free-text episodic memory      |
| **Verifier/Gates**   | input/tool/output/commit gates；所有 verdict 都是 typed event                                  | semantic gate beyond backstop  |
| **Tracer**           | schema-versioned per-turn event stream + append-only session log                               | —                              |
| **Retriever**        | **全推迟**：知识 RAG 不参与安全正确性                                                          | metric-gated knowledge RAG     |
| **ModelAdapter**     | 模型作为 port；scripted adapter 跑 CI，live adapter 跑 nightly                                  | 多模型路由与 fallback provider |

## 3. 数据策略

### 3.1 三层数据

| 层             | 内容                                                   | 存储 / 运行时形态                                    | 当前策略 |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------- | -------- |
| **硬约束规则** | 药物-营养素相互作用（warfarin+vitamin K 等），20-30 条 | Supabase/Postgres，pinned user's applicable subset   | 早建     |
| **营养数据**   | curated 食材 per-100g values、allergen tags、aliases、portion aliases | USDA snapshot ingestion → local catalog tables       | 早建     |
| **权威知识**   | NIH ODS / USDA 膳食指南全文                            | 下载→chunk→embed→pgvector                            | 推迟     |
| **个人数据**   | profile constraints、meal ledger、proposals            | Supabase/Postgres，append-only / immutable where needed | 早建     |

### 3.2 Typed Query Catalog

高频查询提供 reviewed templates，并在 context 中暴露 template signatures。模型只能选择 template id 和 typed parameters；executor 校验 enum/date/user scope 后渲染 SQL。用户 id 由 authenticated session 绑定，不能由模型填入。

### 3.3 食物标准化

用户输入 "a bowl of rice" → deterministic resolver（exact → alias → fuzzy threshold）+ portion-alias table → catalog FoodRef + grams。多候选、低置信、未知食物返回 typed miss，要求 clarification；模型不能 mint food id。

### 3.4 写入策略

`log_meal` 只创建 immutable proposal，不直接写 meal ledger。用户确认时，下一次 turn 以 structured proposal confirmation 进入 seam，短路模型调用，由 deterministic commit path 按 proposal id 写入。profile constraints 没有 agent write path，只能走 validated profile API。

## 4. Eval 体系

### 4.1 三层评分

| 层            | 评分方式                                           | 成本       | 触发             |
| ------------- | -------------------------------------------------- | ---------- | ---------------- |
| **代码评**    | 约束违反率、工具调用率、数字来源合规率、越界转向率 | 零         | 每次 CI          |
| **LLM judge** | 个性化、合理性、完整性                             | 中等       | PR 时            |
| **人评**      | 校准 LLM judge + 争议 case                         | 高（时间） | 每周 10-20% 样本 |

### 4.2 M1 eval 集

- 20-30 条手工 query，覆盖：简单查询、含约束、数字幻觉诱导、跨域冲突、边界值、模糊食物
- 先量 baseline（裸调 LLM 无 harness）
- 每条 query 定义 `expected: { must_call_tools: [...], must_not_contain: [...], max_turns: N }`

## 5. 技术栈

| 层         | 选型                                             |
| ---------- | ------------------------------------------------ |
| 全栈       | TypeScript                                       |
| 前端       | Next.js（Web 应用，界面友好，开源）              |
| 后端/Agent | Next.js API route 内跑 harness                   |
| 数据库     | Supabase（Postgres + pgvector）                  |
| 模型       | v1: DeepSeek / 通义千问 API；后续可选 Claude/GPT |
| 可观测     | 自建 Tracer + 结构化 event log                   |

## 6. 里程碑

### Phase 0（当前）：Seam and Vocabulary

**范围**：schema-versioned event envelope、tagged turn input、ports、turn skeleton、scripted-model fixture、scorer over events。

**验收**：一个 scripted utterance turn 和一个 scripted confirmation turn 在 CI 中零网络运行，且只按 typed events 评分。

### Phase 1：Grounding Substrate

**范围**：local catalog seed、reviewed allergen tags、alias/portion tables、resolver cascade、typed query catalog、least-privilege read path。

### Phase 2：Gated Read Path

**范围**：input/tool/output gates、regenerate-then-refuse、two-region context、observation caps、step-event streaming。

### Phase 3：Write Path

**范围**：proposal store/state machine、write-proposal terminal event、confirmation short-circuit、ledger lineage、edit-rate metrics。

### Phase 4：Surfaces and Tenancy

**范围**：Web chat driving the seam、confirm/edit UI、profile management、auth/RLS、per-session trace scoping、nightly live eval。

### 原 M1 验收场景：最小可靠闭环

**范围**：Loop + ContextAssembler + ToolRegistry + MemoryStore(profile) + Tracer + ModelAdapter

**验收**：

> "I ate 200g chicken breast and a bowl of rice for lunch. How much protein did I get, and what's a good snack to reach my protein target?"
> 系统：查 local catalog/reference tables → 计算摄入 → 对比目标 → 推荐零食 → **不含过敏原 → 有据可查**

**交付物**：

- 可本地运行的 Next.js Web 应用
- 20-30 条 eval 集 + baseline 数据
- 代码评自动化（CI）

### Metric-Gated Extensions

- Knowledge RAG：只有当 answer-quality demand 足够明确时进入。
- Context compaction：只有 context telemetry 证明 observation caps 不够时进入。
- Autonomous exact-match writes：只有 exact-match proposal edit rate 接近 0 时进入；fuzzy writes 永久确认。
- Multi-model routing/fallback：可用性指标触发。
- 趋势聚合：在 meal ledger 和 query catalog 稳定后进入。
- Free-text episodic memory：没有具体 consumer 前不进入。

## 7. 与 NutriMind 的关系

- NutriBuddy 的 Tracer 输出结构化 trajectory → 未来可被 NutriMind 的 RL 训练消费
- 两个项目代码独立，架构选择互不约束
- NutriMind 的端侧/RL 目标是远期愿景，不影响 NutriBuddy 的 ADD/Phase 决策

## 8. 关键 ADR

- `docs/adr/0001-main-agent-plus-retrieval-subagent.md` — 单 agent + 检索 subagent（经 NutriOrion 对抗性验证后维持，补充研究依据）
