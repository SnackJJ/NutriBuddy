# NutriBuddy — 项目行动记录

> 完整 PRD 在 `docs/PRD.md`，本文只记录已确定的决策和当前待办。

## 已确定

- **原则**：自建 harness 机械（loop/context/memory/verification/trace），库只填管线（调模型/存向量/rerank）
- **不做**：LangGraph/CrewAI 等框架、拍照录入、native App（初期）
- **技术栈**：Next.js + Supabase + 自建 agent harness；模型 v1 用 API → v2 端侧 Qwen
- **八模块**：Loop / ContextAssembler / ToolRegistry / MemoryStore / Retriever / Verifier / Tracer / ModelAdapter

## 待讨论 / 待定

- [ ] 编程语言选型：Python 先迭代 harness → 再挂 Next.js，还是直接用 TS 写？
- [ ] M1 起步顺序：先搭哪几块跑最小闭环？
- [ ] 营养数据库选型（USDA / Open Food Facts / 自建？）
- [ ] 权威知识源清单（NIH ODS / 中国膳食指南 / 其他？）
- [ ] eval 集规模和覆盖范围

## Agent skills

### Issue tracker

GitHub Issues，PR 作为需求入口（开启）。See `docs/agents/issue-tracker.md`.

### Triage labels

默认标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文：`CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.

## 当前状态

- 仓库初始化完成，PRD v1 在 `docs/PRD.md`
- Agent skills 配置完成
- 自建 harness 切片推进中（Loop/ContextAssembler/ModelAdapter/Tracer/CLI，issue #1）
- 项目骨架已就绪（issue #3）：Next.js 14 App Router + TS strict + Tailwind + ESLint/Prettier；
  Supabase 客户端 `src/lib/supabase.ts`（server service-role / browser anon，含单测）；
  环境变量见 `.env.local.example`。`npm run dev` 可启动（`next build` 已验证编译通过）。
