# NutriBuddy — 项目行动记录

> 完整 PRD 在 `docs/PRD-v2.md`（2026-06-25 grilling 后重写），v1 保留在 `docs/PRD.md`。

## 已确定

- **原则**：自建 harness 机械（loop/context/memory/verification/trace），库只填管线（调模型/存向量/rerank）
- **不做**：LangGraph/CrewAI 等框架、拍照录入、native App（初期）、端侧推理/RL（归 NutriMind）
- **语言**：TypeScript（全栈）
- **技术栈**：Next.js + Supabase（Postgres + pgvector）+ 自建 agent harness
- **Agent 拓扑**：单 agent + 确定性预处理 + post-gate（ADR 0001，经 NutriOrion 对抗性验证后维持）
- **Loop**：ReAct + CodeAct 混合，SQL 用模板注入
- **数据**：USDA FoodData Central + NIH ODS + USDA Dietary Guidelines
- **场景**：英文西式饮食，Web 应用，开源
- **Eval**：三层评分（代码评 + LLM judge + 人校准），M1 只用代码评

## 模块

八模块（M1 搭六块）：Loop / ContextAssembler / ToolRegistry / MemoryStore / Tracer / ModelAdapter

推迟到 M2：Retriever（路 B 知识 RAG）、独立 Verifier 模块

## 当前状态

- PRD v2 完成（`docs/PRD-v2.md`）
- ADR 0001 经对抗性验证后加强
- CONTEXT.md 已建立
- M1 Issues 待创建
