# NutriBuddy — 项目行动记录

> 架构原则以 `docs/ADD.md` 为准。`docs/PRD-v2.md` 保留产品目标和旧里程碑语境；凡与 ADD 冲突处，一律按 ADD 走。v1 保留在 `docs/PRD.md`。

## 已确定

- **原则**：自建 harness 机械（loop/context/memory/verification/trace），库只填管线（调模型/存向量/rerank）
- **不做**：LangGraph/CrewAI 等框架、拍照录入、native App（初期）、端侧推理/RL（归 NutriMind）
- **语言**：TypeScript（全栈）
- **技术栈**：Next.js + Supabase（Postgres + pgvector）+ 自建 agent harness
- **Agent 拓扑**：单 agent；模型只选择和叙述，事实/数字/实体/写入由确定性代码定义和校验
- **最高测试缝**：单 turn boundary；tagged input + injected ports → schema-versioned typed event stream → exactly one terminal event
- **Loop**：ReAct + typed query catalog；模型发 template id + typed params，不从零写 SQL、不做营养数字心算
- **数据**：USDA FoodData Central 作为 snapshot ingestion source；runtime 读 local catalog/reference tables。NIH ODS / USDA Dietary Guidelines RAG 推迟，按指标触发
- **场景**：英文西式饮食，Web 应用，开源
- **Eval**：三层评分（代码评 + LLM judge + 人校准），M1 只用代码评

## 模块

八模块保留为词汇，但切片按 ADD Phase 0-4 推进：

- **Phase 0**：schema-versioned event envelope、tagged turn input、ports、turn skeleton、scripted model fixture、scorer over events
- **Phase 1**：local catalog seed、reviewed allergen tags、alias/portion tables、resolver cascade、typed query catalog、least-privilege read path
- **Phase 2**：input/tool/output gates、regenerate-then-refuse、two-region context、observation caps、step-event streaming
- **Phase 3**：proposal store/state machine、write-proposal terminal event、confirmation short-circuit、ledger lineage
- **Phase 4**：Web chat driving the seam、confirm/edit UI、profile API、auth/RLS、session trace scoping、nightly live eval

推迟：Knowledge RAG、context compaction、autonomous exact-match writes、multi-model fallback、free-text episodic memory。

## 当前状态

- ADD 已成为当前架构基准（`docs/ADD.md`）
- PRD v2 已改为从属产品语境（`docs/PRD-v2.md`）
- ADR 0001 经对抗性验证后加强
- CONTEXT.md 已建立
- 自建 harness 切片推进中（Loop/ContextAssembler/ModelAdapter/Tracer/CLI，issue #1）
- 项目骨架已就绪（issue #3）：Next.js 14 App Router + TS strict + Tailwind + ESLint/Prettier；
  Supabase 客户端 `src/lib/supabase.ts`（server service-role / browser anon，含单测）；
  环境变量见 `.env.local.example`。`npm run dev` 可启动（`next build` 已验证编译通过）。
- Eval 代码评层已就绪（issue #6，PRD §4.1/§4.2）：`src/eval/` = 25 条手工 query（五类失败模式各 5 条）
  + `CodeScorer`（纯 TS 断言，读 TraceEvent[]：must_call_tools / must_not_contain /
  should_ask_clarification / should_be_blocked）+ runner + `npm run eval`（pending 模式打印
  toolless baseline，`-- --strict` 接真实 producer 后做 CI 回归闸）。Tracer 词表新增
  `tool_call` / `post_gate_blocked`（待 ToolRegistry/Verifier 切片产出）。
- 当前代码仍有旧架构债务：direct `logMeal`、旧 TraceEvent/AgentEvent 分裂、stub nutrition、缺 query catalog/local catalog/proposal confirmation short-circuit。
- ADD Phase 0-4 issues 待创建。
