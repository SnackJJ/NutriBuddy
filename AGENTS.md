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

## 当前状态（2026-07-17）

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

### 进行中 / 下一步

- **RFC 0002 — ToolOutcome**（`docs/rfc/0002-tool-outcome.md`）：工具结果从 stringly `ToolResult` 收敛为判别联合；tool gate 只读 `kind`，不再 JSON 字符串嗅探
- 结构序列仍按 RFC 0001 Appendix B：Phase 3 events/tracer demotion → Phase 4 turn 分解 / 删 `runTurn` → Phase 5 catalog split → Phase 6 `createTurnAssembly` + legacy purge

### 仍有的债务（非 Phase 1 正确性 blocker）

- `ToolResult.result: string` + ad-hoc `parseHandlerResult`（RFC 0002 目标）
- `TraceEvent` / `AgentEvent` / `AnyTurnEvent` 三套词表并存；eval scorer 仍偏 TraceEvent
- `runTurn` 与 `turn` 双入口遗留
- ConfirmPorts 类型完备，但 utterance 路径仍是扁平 `TurnPorts` bag（Phase 6 assembly 收敛）
- Web confirm/edit UX 与 nightly live eval 仍可加厚

### 运维备忘

```bash
# 应用 migration 0009（一次，Supabase SQL Editor 或迁移管线）
#   supabase/migrations/0009_commit_proposal_and_void.sql

# 写路径 live smoke（需 .env.local：URL + anon + service role）
npm run smoke:confirm
```
