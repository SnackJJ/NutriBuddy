# NutriBuddy — PRD v2

> 2026-06-25，经 `/grill-with-docs` 全面挑战原 PRD 后重写。
> 原 PRD v1 保留在 `docs/PRD.md`，作为历史参考。

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

### 2.1 拓扑：单 Agent + 确定性预处理 + Post-Gate

```
用户请求
  → [Pre-gate] 代码层取过敏/用药/禁忌（确定性 SQL，不走 RAG）
  → [ContextAssembler] pinned region（system + profile + SQL 模板）+ 当前轮
  → [单 Agent Loop] ReAct + CodeAct 混合
  → [Post-gate] 输出 ∩ 禁忌 ≠ ∅ → 硬拦 fail loud
  → 返回用户
```

### 2.2 Loop：ReAct + CodeAct 混合

- **CodeAct**：批量数据查询（profile + 今日饮食 + 营养计算），模型生成 SQL（基于注入的模板），harness 在限制环境中执行
- **ReAct**：需要根据中间结果判断的操作（写操作、异常处理、追问用户）

### 2.3 八个模块（M1 实际搭建六块）

| 模块 | M1 做什么 | 推迟的 |
|------|---------|--------|
| **Loop** | ReAct + CodeAct 混合循环，MAX_STEPS=5 | — |
| **ContextAssembler** | pinned region（system prompt + user profile + SQL 模板）+ 当前轮 | compaction |
| **ToolRegistry** | `execute_query`（CodeAct SQL 执行器，模板白名单）+ `log_meal` + `get_food_nutrition` | — |
| **MemoryStore** | profile 层（过敏、用药、目标），确定性 SQL | 情景记忆 |
| **Verifier** | pre-gate + post-gate（几行 `if`，不拆独立模块） | 独立 Verifier 模块、覆盖判停 |
| **Tracer** | 不可变仅追加事件日志，结构化 trajectory | — |
| **Retriever** | **全推迟**：M1 不需要语义 RAG，所有关键数据确定性查询 | 路 B 知识 RAG |
| **ModelAdapter** | DeepSeek / 通义千问，OpenAI-compatible 接口 | 多模型路由 |

## 3. 数据策略

### 3.1 三层数据

| 层 | 内容 | 存储 | M1？ |
|---|------|------|------|
| **硬约束规则** | 药物-营养素相互作用（warfarin+vitamin K 等），20-30 条 | SQL 表 | ✅ M1 建 |
| **营养数据** | 基础食材营养值 | USDA FoodData Central API | ✅ M1 接 |
| **权威知识** | NIH ODS / USDA 膳食指南全文 | 下载→chunk→embed→pgvector | ❌ M2 |
| **个人数据** | 用户 profile（过敏/用药/目标/身体指标） | Supabase Postgres | ✅ M1 建 |

### 3.2 SQL 模板注入

高频查询提供预验证模板，注入 system prompt。模型填空（参数），不从零写 SQL。

### 3.3 食物标准化

用户输入 "a bowl of rice" → `normalize_food`（LLM fuzzy match + USDA 查库）→ `{food: "rice, white, cooked", portion_g: 150}`

## 4. Eval 体系

### 4.1 三层评分

| 层 | 评分方式 | 成本 | 触发 |
|---|---------|------|------|
| **代码评** | 约束违反率、工具调用率、数字来源合规率、越界转向率 | 零 | 每次 CI |
| **LLM judge** | 个性化、合理性、完整性 | 中等 | PR 时 |
| **人评** | 校准 LLM judge + 争议 case | 高（时间） | 每周 10-20% 样本 |

### 4.2 M1 eval 集

- 20-30 条手工 query，覆盖：简单查询、含约束、数字幻觉诱导、跨域冲突、边界值、模糊食物
- 先量 baseline（裸调 LLM 无 harness）
- 每条 query 定义 `expected: { must_call_tools: [...], must_not_contain: [...], max_turns: N }`

## 5. 技术栈

| 层 | 选型 |
|---|------|
| 全栈 | TypeScript |
| 前端 | Next.js（Web 应用，界面友好，开源） |
| 后端/Agent | Next.js API route 内跑 harness |
| 数据库 | Supabase（Postgres + pgvector） |
| 模型 | v1: DeepSeek / 通义千问 API；后续可选 Claude/GPT |
| 可观测 | 自建 Tracer + 结构化 event log |

## 6. 里程碑

### M1（当前）：最小可靠闭环

**范围**：Loop + ContextAssembler + ToolRegistry + MemoryStore(profile) + Tracer + ModelAdapter

**验收**：
> "I ate 200g chicken breast and a bowl of rice for lunch. How much protein did I get, and what's a good snack to reach my protein target?"
> 系统：查 USDA → 计算摄入 → 对比目标 → 推荐零食 → **不含过敏原 → 有据可查**

**交付物**：
- 可本地运行的 Next.js Web 应用
- 20-30 条 eval 集 + baseline 数据
- 代码评自动化（CI）

### M2：知识 RAG + Verifier 模块化

- 下载 NIH ODS / USDA 指南 → chunk → embed → pgvector
- 独立 Verifier 模块（覆盖判停、约束闸、数字核实）
- LLM judge 接入 eval 流程
- 多用户支持（Supabase Auth）

### M3：记忆增强 + 趋势分析

- 情景记忆（对话历史语义检索）
- 趋势聚合（周/月营养报告）
- compaction（长对话上下文管理）

## 7. 与 NutriMind 的关系

- NutriBuddy 的 Tracer 输出结构化 trajectory → 未来可被 NutriMind 的 RL 训练消费
- 两个项目代码独立，架构选择互不约束
- NutriMind 的端侧/RL 目标是远期愿景，不影响 NutriBuddy 的 M1-M3 决策

## 8. 关键 ADR

- `docs/adr/0001-main-agent-plus-retrieval-subagent.md` — 单 agent + 检索 subagent（经 NutriOrion 对抗性验证后维持，补充研究依据）
