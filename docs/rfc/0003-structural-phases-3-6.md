# RFC 0003 — Structural Phases 3–6 (tickets)

> Status: **Implemented** (2026-07-20).  
> **Not always-on agent context** — open only when working structural package boundaries or this history.  
> Authority: `docs/rfc/0001-phase1-confirm-safety.md` Appendix B; non-goals of RFC 0002.  
> Numbering: **structural** Phases 3–6 (not ADD product Phase 0–4).

## Blocking edges

```
3 (events/tracer demotion) → 4 (delete runTurn) → 5 (catalog split) → 6 (createTurnAssembly)
```

## Tickets

### T3 — Phase 3: single turn-event surface for scoring

**Outcome:** Tool/gate correctness for eval goldens and code scorers is derived from `AnyTurnEvent[]` (schema-versioned turn stream), not from `TraceEvent` tool_call/gate_block vocabulary as primary truth. Tracer remains an optional debug side-channel.

**Slices:**
- T3a: `extractEvalSignals(events)` + `scoreCase` / harness path consume turn-event facts
- T3b: Document tracer demotion; keep record/render for debug; no dual-truth in scorers

**Done when:** `npm test` + typecheck green; scorer tests drive turn-event facts or real `turn()` streams.

### T4 — Phase 4: one turn entry

**Outcome:** Delete or unexport `runTurn`; all production/test call sites use `turn` / `consumeTurn`.

**Done when:** grep shows no live call sites; suite green.

### T5 — Phase 5: catalog package boundary

**Outcome:** `src/catalog/` is the package root for catalog/resolver/query-template ground truth; harness imports through that boundary; no reverse catalog→harness ownership of SQL/template SoT.

**Done when:** `src/catalog/index.ts` exports public surface; harness/eval import ground truth from catalog package; suite green.

### T6 — Phase 6: typed turn assembly

**Outcome:** `createTurnAssembly` builds utterance/confirm ports with fail-closed incomplete assembly (ConfirmPorts spirit); chat/CLI use it.

**Done when:** incomplete assembly fails closed with tests; happy paths still emit one terminal; smoke:confirm green when env present.

## Non-goals

- Product RAG / multi-model / autonomous writes
- Reopening RFC 0001 confirm RPC or RFC 0002 ToolOutcome contracts
- LLM-judge eval rewrite
