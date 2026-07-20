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

八模块保留为词汇，但切片按 ADD Phase 0-4 推进（产品能力），结构收敛按 RFC 0001 Appendix B / RFC 0002：

- **ADD Phase 0–4（能力）**：seam / catalog / gates / write path / surfaces — 大量已落地
- **RFC 结构 Phase 2–6**：ToolOutcome → events/tracer → turn 分解 → catalog split → assembly purge

推迟：Knowledge RAG、context compaction、autonomous exact-match writes、multi-model fallback、free-text episodic memory。

## 当前状态（2026-07-20）

### 已完成

- ADD 为架构基准（`docs/ADD.md`）；PRD v2 从属产品语境
- 项目骨架：Next.js 14 App Router + TS strict + Tailwind；Supabase 客户端 + RLS 迁移 0001–0009
- Turn seam：`turn()` 单入口、schema-versioned event stream、scripted fixtures、code scorer
- Catalog / resolver / query catalog / gates（input/tool/output/commit）/ proposal write path
- **RFC 0001 已合并（PR #72）**：
  - Step 0：`canonicalizeTurnEvents` + K1–K14 goldens + F1–F4 invariants
  - Phase 1：原子 `commit_proposal_and_insert_meal` / `void_proposal`、`not_committable` 折叠、ConfirmPorts、JWT sub assert、`proposalConfirm` 抽取、structured `commit` lineage
  - Review follow-ups #73–#76 已合入
- **Live smoke**：`npm run smoke:confirm` 在目标项目上 **PASSED**（migration 0009 已应用；commit / void / re-commit not_committable / missing）
- **RFC 0002 — ToolOutcome（Implemented）**：
  - `src/harness/toolOutcome.ts`：判别联合 + `toolGateFromOutcome` + `renderToolOutcome` + legacy bridge
  - loop/turn 只吃 `ToolOutcome`；gate 发 `reasonCode`；`SCHEMA_VERSION` 1.7.0
  - `log_meal` / `query_catalog` 直接 emit HandlerOutcome；infra → crash 终端（无 output/commit pass）
  - K10/K11 断言 `reasonCode`；chat 仍经由派生 `toolResult`
- **结构 Phase 3–6（RFC 0003 / Appendix B）Implemented**：
  - **Phase 3**：eval 评分以 `AnyTurnEvent` 为 SoT（`scoreSignalsFromTurnEvents`）；Tracer 降级为 side-channel
  - **Phase 4**：删除公开 `runTurn`；仅 `turn`/`consumeTurn` 为 seam 入口
  - **Phase 5**：`src/catalog/` 包根（`index.ts`）；in-memory QueryRunner 迁入 catalog；无 catalog→harness 反向依赖
  - **Phase 6**：`createTurnAssembly` fail-closed；chat/CLI 经 assembly 装配

### 进行中 / 下一步

- 产品表面加厚：Web confirm/edit UX、nightly live eval（非结构 Phase 3–6）
- ADD 产品 Phase 5 metric-gated 扩展（RAG 等）按指标触发

### 仍有的债务（非结构 Phase 3–6 blocker）

- 派生 `toolResult` 仍保留至 UI 迁移（RFC 0002 §2.6）
- TraceEvent 仍可用于 debug/legacy fixtures（评分主路径已不依赖）
- Web confirm/edit UX 与 nightly live eval 仍可加厚

### 运维备忘

```bash
# 应用 migration 0009（一次，Supabase SQL Editor 或迁移管线）
#   supabase/migrations/0009_commit_proposal_and_void.sql

# 写路径 live smoke（需 .env.local：URL + anon + service role）
npm run smoke:confirm
```
