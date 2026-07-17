# NutriBuddy — Project Briefing

> **Archived.** Snapshot prepared for an early codebase review (2026-07). Implementation status and module lists are outdated. Architecture source of truth is `docs/ADD.md`; product context lives in `docs/PRD-v2.md`. Kept only as historical reference.

> Original note: Review briefing for the then-current codebase. If this briefing or older PRDs conflict with the ADD, follow the ADD.

## 1. What This Is

NutriBuddy is a personal nutrition advisor built on a hand-rolled agent harness. The user asks nutrition questions in English (Western diet context). A single agent — not a multi-agent swarm — queries local nutrition/reference tables derived from USDA snapshots, checks user allergies/medication constraints, and returns evidence-backed answers.

**Tech stack:** TypeScript, Next.js 14 (App Router), Supabase (Postgres + pgvector), DeepSeek API (OpenAI-compatible).

**Non-goals (explicitly ruled out):** LangGraph/CrewAI frameworks, native apps, photo input, on-device inference (that's NutriMind — a separate project), multi-agent orchestration, Chinese cuisine coverage.

## 2. Architecture

### 2.1 Topology: Single Agent + Deterministic Machinery

```
Tagged turn input (utterance | proposal confirmation)
  → [Turn seam] injected ports: model, stores, catalog/resolver, clock
  → [Input gate] deterministic constraint scan + directive injection
  → [ContextAssembler] pinned contracts/catalog/profile + dynamic conversation/observations
  → [Agent Loop] ReAct + typed query catalog, MAX_STEPS=8
  → [Tool/Output/Commit gates] deterministic verdict events
  → Exactly one terminal event: final / clarification / write proposal / refusal / error
```

**Why single agent (ADR 0001):** Multi-agent topology N× the reliability failure surface. Every agent added is another place where constraint violations and hallucinated numbers can slip through. The nutrition Q&A main path is narrow, step-dependent — the anti-pattern for multi-agent. Research backing: NutriOrion's parallel domain-agent approach has zero production deployments; Stanford 2026 showed separate domain optimization *reduces* system accuracy (85.5% → 67.7%); NeurIPS 2025 MAST study found 41-87% of multi-agent failures stem from specification problems and inter-agent coordination errors.

### 2.2 Loop: ReAct + Typed Query Catalog

- **ReAct** — Thought → Act → Observe cycle for decisions requiring intermediate results (write operations, ambiguity resolution, user clarification).
- **Typed query catalog** — The model emits a template id plus typed parameters. The executor validates the call, binds identity from the authenticated session, renders reviewed SQL, and returns schema-declared observations. The model never writes SQL from scratch and never does nutrition arithmetic.
- **Terminal protocols** — Clarification requests and write proposals end the turn. Proposal confirmation enters the next turn as structured input and short-circuits the model.

### 2.3 Module Map Under the ADD

| Module | Current Responsibility | Deferred |
|--------|------------------------|----------|
| **Loop** | Single-turn orchestration, ReAct, typed query catalog calls, 8-step budget, terminal event discipline | — |
| **ContextAssembler** | Pinned system contracts/catalog signatures/profile snapshot + dynamic conversation and capped observations | Compaction |
| **ToolRegistry** | `query_catalog`, `get_food_nutrition`, proposal-only `log_meal` | Autonomous exact-match writes |
| **MemoryStore** | Profile constraints, meal ledger, immutable proposals, reference data | Free-text episodic memory |
| **Gates** | Input/tool/output/commit gates; every verdict is a typed event | Semantic gate beyond lexical backstop |
| **Tracer** | Schema-versioned per-turn typed event stream + append-only per-session log | — |
| **Retriever** | Deferred; knowledge RAG is not on the safety path | Metric-gated knowledge RAG |
| **ModelAdapter** | Model as injected port; scripted adapter for CI and live adapter for nightly compliance runs | Multi-model routing/fallback |

### 2.4 Data Strategy

| Layer | Content | Runtime Shape |
|-------|---------|---------------|
| Hard constraints | 20-30 drug-nutrient interaction rules (e.g. warfarin + vitamin K) | Supabase/Postgres; user's applicable subset pinned in context |
| Nutrition/reference data | Per-100g values, allergen tags, aliases, portion aliases | USDA snapshot ingestion → local catalog tables |
| Knowledge | NIH ODS / USDA Dietary Guidelines full text | Deferred RAG, metric-gated |
| User data | Profile constraints, meal ledger, immutable proposals | Supabase/Postgres, scoped by authenticated user/session |

## 3. Current Implementation Snapshot

### 3.1 What Exists (~3,550 lines src/, 21 test files)

**Harness core (`src/harness/`):**

- `loop.ts` (302 lines) — Current ReAct loop as async generator. This is the main migration target toward the ADD seam: tagged turn input + injected ports + typed events + one terminal event.
- `contextAssembler.ts` (112 lines) — Two-region context: pinned (AOT, byte-stable for prompt cache) + dynamic (conversation + tool results). System message layout designed for cache hit maximization.
- `gate.ts` (307 lines) — Current pre/post gate implementation. Under ADD this should become deterministic input/tool/output/commit gates emitting typed verdict events.
- `tracer.ts` (41 lines) — In-memory turn trace: step/payload/render. Used by CLI for `--trace` output.
- `eventLog.ts` (122 lines) — Persistent JSONL event sourcing (traces/{sessionId}.jsonl). Immutable, append-only. Designed for future RL training consumption by NutriMind.
- `modelAdapter.ts` (91 lines) — DeepSeek V4 adapter. Two tiers (flash/pro). Key/env injection for testability. Single model, no routing.
- `foodNutrition.ts` (133 lines) — Built-in stub for ~50 foods. Under ADD this evolves into a local catalog/resolver backed by snapshot ingestion, not a runtime USDA API client.
- `logMeal.ts` (210 lines) — Current direct logging tool. Under ADD this must become proposal-only; confirmation commits by proposal id through the deterministic turn short-circuit.
- `types.ts` (82 lines) — Shared narrow types: ChatMessage, ModelAdapter interface, AgentEvent, ToolCall, TerminalResult, ToolHandler.

**Library (`src/lib/`):**

- `drugInteractions.ts` (96 lines) — Drug-nutrient interaction query. Normalizes drug names, matches against Supabase table. InteractionStore interface injectable for testing.
- `memoryStore.ts` (221 lines) — Append-only versioned user profile. ProfileGateway port (current/close/append). Supabase implementation included. Clock injection for deterministic tests.
- `mealLogStore.ts` — Meal log persistence.
- `profileApi.ts`, `profileValidation.ts` — Profile API routes + Zod validation.
- `supabase.ts` — Supabase client (server service-role + browser anon). `.env.local.example` for config.
- `chatHelpers.ts`, `ensureHostOnBase.ts` — Utilities.

**Eval system (`src/eval/`):**

- `dataset.ts` (238 lines) — 25 hand-written queries across 5 failure-mode categories: simple (5), constrained (6), numeric hallucination inducement (5), cross-domain drug-nutrient conflicts (5), edge cases (4). Each case defines expected constraints.
- `scorer.ts` (88 lines) — CodeScorer: pure TS assertions on TraceEvent[]. Checks: mustCallTools, mustNotContain, shouldAskClarification, shouldBeBlocked. Zero LLM cost. Runs every CI.
- `types.ts` (133 lines) — EvalCase, ScoreResult, BareResult, HarnessResult, ComparisonRow, EvalSummary, EvalReport types.
- `runner.ts`, `bare-runner.ts`, `harness-runner.ts` — Dual runner: bare LLM (toolless baseline) vs harness. `npm run eval` prints comparison; `--strict` gates CI.
- `checks.ts`, `metrics.ts`, `reporter.ts` — Supporting eval utilities.

**CLI (`src/cli.ts`, 82 lines) —** Single-turn driver: `echo "..." | npx tsx src/cli.ts --trace`. DI-friendly for testing.

**Testing:** 21 test files under `tests/`. Vitest runner. Covers harness core, eval, lib. `npm run typecheck` passes. `npm run build` verified.

### 3.2 What's Missing (M1 gaps)

- **ADD seam migration** — `runTurn` still exposes the older loop shape. It needs tagged input, injected ports, schema-versioned typed events, and exactly one terminal event.
- **Typed event vocabulary** — `TraceEvent`, `AgentEvent`, and `EventLog` need consolidation around the ADD event stream.
- **ToolRegistry integration** — Individual tool handlers exist, but `query_catalog` and catalog/resolver ports are not implemented.
- **Local catalog ingestion** — `foodNutrition.ts` is stub-only. The ADD calls for USDA snapshot ingestion into local tables, not runtime USDA calls.
- **Proposal write path** — `logMeal` still persists meal logs directly. It needs proposal storage, proposal terminal events, and deterministic confirmation commit.
- **User-facing web UI** — Next.js App Router scaffold exists but no chat UI, no profile form. Only CLI is runnable.
- **Supabase migrations** — `drug_nutrient_interactions` and `user_profile` schemas not yet created as migration files.
- **Profile → Gate wiring** — `UserContext` is defined but no caller wires real profile data into `runTurn`. Gate exists but untested end-to-end.
- **Phase issues** — ADD Phase 0-4 issues not yet created/prioritized.

## 4. Design Decisions (Challenge These)

These are the load-bearing ADD decisions to challenge only by reopening the ADD, not by editing downstream docs in isolation.

1. **Single agent, not multi-agent** — The topology depends on one agent holding all interaction context. Deterministic gates, typed events, and the proposal confirmation short-circuit are the safety mechanism, not separate verifier agents.

2. **Typed query catalog over model-authored SQL** — The model selects reviewed templates; it never authors SQL. This trades flexibility for deterministic safety.

3. **Output gate as structural checks plus lexical backstop** — Recommendation FoodRefs, numeric provenance, advisory RuleRefs, and grounded prose checks must all emit verdict events.

4. **Profile as Versioned Rows, not a Graph** — MemoryStore uses append-only versioned rows (valid_from/valid_to). User profile changes are a linear history, not a graph of related facts. This matters when "what did the user believe when they asked X" becomes a question.

5. **Knowledge RAG deferred** — Retriever is not on the safety path. It enters only when answer-quality metrics justify it.

6. **No streaming** — ModelAdapter returns full responses. Loop yields events at step granularity, not token granularity. UI will feel slow for tool-calling turns.

7. **Supabase as sole runtime data store** — No Redis, no queue, no blob storage. Profile constraints, interaction rules, proposals, meal ledger, reference tables, and eventual embeddings all live in Postgres. Simple but couples everything to one DB.

8. **DeepSeek-only, no model fallback** — If DeepSeek API is down, the app is down. No circuit breaker, no fallback provider.

## 5. Open Risks

- **Legacy implementation mismatch** — Current code still has direct `logMeal`, older trace shapes, and stub nutrition data. These must migrate to the ADD seam/event/proposal/catalog model.
- **Catalog review throughput** — Untagged foods are loggable but not recommendable. Recommendation coverage depends on reviewed allergen tags.
- **Typed output discipline** — Numeric provenance and advisory checks require the model to return typed final output, not just prose.
- **Context window growth** — No compaction in M1. Tool call/result pairs accumulate. With MAX_STEPS=8 and 3 tools per step, the working set balloons.
- **Eval to real-world gap** — 25 hand-written queries cover 5 categories. Real users will find failure modes not represented. The eval is a regression gate, not a safety proof.

## 6. Codebase Quick Reference

```
src/
  harness/
    loop.ts              — ReAct loop (async generator, 302 lines)
    contextAssembler.ts  — Prompt assembly (pinned + dynamic, 112 lines)
    gate.ts              — Pre/post safety gates (307 lines)
    tracer.ts            — In-memory turn tracer (41 lines)
    eventLog.ts          — Persistent JSONL event log (122 lines)
    modelAdapter.ts      — DeepSeek V4 adapter (91 lines)
    foodNutrition.ts     — Nutrition stub (133 lines)
    logMeal.ts           — Meal logging tool (210 lines)
    types.ts             — Shared types (82 lines)
  lib/
    drugInteractions.ts  — Drug-nutrient interaction queries (96 lines)
    memoryStore.ts       — Append-only versioned profile (221 lines)
    supabase.ts          — Supabase client factory
    mealLogStore.ts      — Meal log persistence
    profileApi.ts        — Profile API routes
    profileValidation.ts — Zod schemas
  eval/
    dataset.ts           — 25 eval queries (238 lines)
    scorer.ts            — CodeScorer (88 lines)
    types.ts             — Eval types (133 lines)
    runner.ts, bare-runner.ts, harness-runner.ts, index.ts
    checks.ts, metrics.ts, reporter.ts
  cli.ts                 — CLI driver (82 lines)
tests/                   — 21 test files (Vitest)
docs/
  ADD.md                 — Architectural source of truth
  PRD-v2.md              — Product goals and milestone context; subordinate to ADD
  PRD.md                 — Original PRD
  adr/0001-main-agent-plus-retrieval-subagent.md  — Topology decision
  agents/                — Issue tracker, triage labels, domain config
```

`npm run dev` starts Next.js. `npm run eval` runs eval (pending mode = toolless baseline). `npx tsx src/cli.ts --trace "query"` runs a single turn.
