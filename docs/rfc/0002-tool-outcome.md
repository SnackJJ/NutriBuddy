# RFC 0002 — Phase 2 ToolOutcome（工具结果类型收敛）

> Status: **Frozen for implementation** (2026-07-17).  
> Architecture source of truth: `docs/ADD.md`  
> Predecessor: `docs/rfc/0001-phase1-confirm-safety.md` (Implemented, PR #72).  
> Scope: **Phase 2 only** — ToolOutcome + tool-gate mapping. Phases 3–6 stay named, not designed here.  
> Regression net: keep K goldens / F invariants at gate/verdict grain (RFC 0001); add ToolOutcome unit + tool-gate table tests.

## Why

Confirm path is fail-closed and atomic (RFC 0001). The **utterance / tool path** still carries safety-relevant outcomes as free-text JSON in `ToolResult.result: string`. The tool gate re-parses those strings (`parseHandlerResult`) to invent `typed_error` vs `typed_miss` vs success. That breaks the same contract Phase 1 fixed on the write path:

1. **Stringly outcomes** — scorer and gate depend on JSON shape sniffing, not a discriminant.
2. **Duplicate truth** — handlers already know miss vs error; the gate rediscovers it from text.
3. **C3 risk** — evidence strings and parse edge cases can drift goldens without a real behavior change.

Phase 2 closes this before larger refactors (events/tracer demotion, turn decomposition).

### Completion bar (three ladders, same as RFC 0001)

| Label | Required |
|-------|----------|
| **安全 seam 可用** | RFC 0001 + this Phase 2 merged |
| **结构上收敛** | Phases 3–4 (out of scope here) |
| **卫生完成** | Phases 5–6 (out of scope here) |

Do not start Phase 3 until Phase 2 goldens are green.

---

## 1. Problem inventory (today)

| Location | Smell |
|----------|--------|
| `src/harness/types.ts` `ToolResult` | `result: string` + optional `dispatchError` |
| `src/harness/turn.ts` `parseHandlerResult` | JSON.parse + key sniffing for tool gate |
| `src/harness/loop.ts` tool dispatch | always stringifies handler output into observe events |
| Handlers (`logMeal`, query catalog, …) | each invents its own JSON error/miss shape |
| Eval / goldens | tool gate evidence free-text; reason codes only partial |

---

## 2. Target contract

### 2.1 ToolOutcome (binding)

```ts
/** Discriminated tool outcome — produced by handlers / dispatch, never by the model. */
export type ToolOutcome =
  | {
      readonly kind: "ok";
      readonly name: string;
      /** Opaque payload for the model-facing string render + optional structured observation. */
      readonly data: unknown;
      /** When present, flows into numeric/advisory observation collection. */
      readonly observation?: Observation;
    }
  | {
      readonly kind: "typed_miss";
      readonly name: string;
      readonly message: string;
      /** Optional resolver candidates for clarification. */
      readonly candidates?: readonly unknown[];
    }
  | {
      readonly kind: "typed_error";
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "dispatch_error";
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "infra_error";
      readonly name: string;
      readonly cause: string;
    };
```

Rules:

1. **Handlers return `ToolOutcome` (or a typed subtype)** — not bare strings. A thin adapter may keep `string` for one PR if it immediately wraps into `ok` / parse-once at the handler boundary, but the **loop boundary** must only see `ToolOutcome`.
2. **Model-facing text** is a pure function `renderToolOutcome(outcome): string` used when stuffing role:`tool` messages. Full fidelity stays on the outcome + trace.
3. **Tool gate maps only `kind` → verdict + stable reason code** (see §2.2). No `JSON.parse` of `result` inside the gate.
4. **`dispatch_error`** is reserved for unknown tool / schema failure before the handler runs. **`infra_error`** is reserved for thrown infrastructure (timeout, DB down). Handlers must not throw business misses as exceptions.
5. **AgentEvent.observe** carries `toolOutcome: ToolOutcome` (structured). Optional deprecated `toolResult?: ToolResult` may remain for one release with a derive helper; goldens assert on structured kind, not raw string.

### 2.2 Tool gate mapping (binding)

| `ToolOutcome.kind` | Gate `verdict` | Stable reason code (`checkName` or evidence code) | Model continues? |
|--------------------|----------------|-----------------------------------------------------|------------------|
| `ok` | `pass` | `tool_ok` | yes |
| `typed_miss` | `pass` | `typed_miss` | yes (clarification path) |
| `typed_error` | `error` | `typed_error` | yes (model may retry within budget) |
| `dispatch_error` | `error` | `dispatch_error` | yes (typed error observation to model) |
| `infra_error` | `error` | `infra_error` | **no** — turn may terminate fail-closed (existing abort/error policy) |

Free-text evidence may include the message for humans; **goldens assert reason code / kind only**, same philosophy as RFC 0001 §1.0.

### 2.3 Compatibility with keep goldens

- K10 (typed_miss) / K11 (typed_error) stay at **gate/verdict grain**.
- Implementation may change evidence strings; reason codes must remain stable once frozen in this RFC.
- Canonicalizer: if structured `toolOutcome.kind` appears on events, keep it; do not bijection-normalize kinds.

---

## 3. Implementation slices (commit order)

### Slice A — Type + pure mappers (no behavior change in handlers yet)

1. Add `ToolOutcome` + `renderToolOutcome` + `toolGateFromOutcome` in a small module (e.g. `src/harness/toolOutcome.ts`).
2. Unit tests: table of kind → gate verdict / reason code.
3. `parseHandlerResult` becomes a **deprecated bridge** used only until handlers migrate (or deleted in same PR if all call sites migrate).

### Slice B — Loop / turn consume ToolOutcome

1. Dispatch returns `ToolOutcome`; observe events carry it.
2. Tool gate calls `toolGateFromOutcome` only.
3. Observation collection reads `outcome.observation` / structured ok data — not re-parse when possible.
4. K10/K11 + existing tool gate tests green.

### Slice C — Handler migration

1. `log_meal`, `query_catalog`, nutrition handlers emit ToolOutcome kinds directly.
2. Delete string-sniffing bridge.
3. SCHEMA_VERSION minor bump if event payload shape for observe changes in a consumer-visible way.

### Slice D — Eval alignment (minimal)

1. CodeScorer / cases that key off tool success may read turn events’ structured kind when available.
2. **Do not** rewrite the whole eval system (that touches Phase 3 tracer demotion).

---

## 4. Non-goals (this RFC)

| Deferred to | Item |
|-------------|------|
| Phase 3 | Merge TraceEvent / AgentEvent into turn event vocabulary; demote tracer |
| Phase 4 | Delete `runTurn`; deeper turn decomposition |
| Phase 5 | Catalog package split |
| Phase 6 | Full `createTurnAssembly` + legacy port-bag purge |
| Never here | New tools, RAG, model routing, UI |

---

## 5. Acceptance checklist

- [ ] `ToolOutcome` exported; handlers/loop boundary use it
- [ ] Tool gate has **zero** `JSON.parse` of tool result strings
- [ ] Mapping table §2.2 covered by unit tests
- [ ] K10 / K11 goldens green at gate grain (reason codes stable)
- [ ] Full `npm test` + `npm run typecheck` green
- [ ] `npm run smoke:confirm` still green (confirm path untouched)
- [ ] No behavior change to confirm short-circuit / migration 0009

---

## 6. Risk notes

- **Render fidelity**: model must still see the same factual content it saw as JSON strings; snapshot a few tool renders in unit tests.
- **Partial migration**: do not leave half the tools on strings and half on outcomes without a single dispatch adapter.
- **infra_error vs typed_error**: infra terminates or hard-errors; typed_error is business-shaped and recoverable in-budget — do not collapse them.

---

## 7. Suggested issues

1. ToolOutcome type + gate mapper + unit table  
2. Loop/turn observe payload + delete parseHandlerResult from gate path  
3. Migrate log_meal / query_catalog handlers  
4. K10/K11 golden + scorer touch-up  

Serial preferred if the same files thrash; otherwise 1 → (2 ∥ 3 after 1) → 4.
