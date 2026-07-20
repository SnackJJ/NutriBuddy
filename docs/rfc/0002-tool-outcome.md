# RFC 0002 — Phase 2 ToolOutcome（工具结果类型收敛）

> Status: **Implemented** (2026-07-20) — Slices A–C landed; D no-op (scorer already name-based).  
> Note: `ToolHandler` may still return `string` for **eval/test stubs only**; production handlers return `HandlerOutcome`. Dispatch bridges strings via `normalizeLegacyToolResult`.  
> Prior: Frozen 2026-07-17; amended 2026-07-19; **Codex gpt-5.6-sol xhigh** reviews applied 2026-07-20.  
> Architecture source of truth: `docs/ADD.md`  
> Predecessor: `docs/rfc/0001-phase1-confirm-safety.md` (Implemented, PR #72).  
> Scope: **Phase 2 only** — ToolOutcome + tool-gate mapping. Phases 3–6 stay named, not designed here.  
> Regression net: keep K goldens / F invariants at gate/verdict grain (RFC 0001); add ToolOutcome unit + tool-gate table tests.  
> **Authority:** This document is the only binding contract for implementers. Do not invent kinds, render rules, or control-flow at code time.

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
| `src/harness/types.ts` `ToolHandler` | `Promise<string>` only |
| `src/harness/turn.ts` `parseHandlerResult` | JSON.parse + key sniffing for tool gate |
| `src/harness/turn.ts` `createToolGateVerdict` | `checkName` always `tool_gate_check`; kind only in free-text `evidence` |
| `src/harness/turn.ts` `parseWriteProposalData` | `log_meal` proposal payload re-parsed from result string (confirm-path **upstream**) |
| `src/harness/turn.ts` `parseQueryCatalogObservation` | observation re-parsed from result string |
| `src/harness/loop.ts` `dispatchTool` | wraps handler string; **does not catch** handler throws |
| `src/harness/loop.ts` `submit_answer` | not in tools Map; observe carries human-readable string; turn still emits tool gate |
| Handlers (`logMeal`, query catalog) | invent JSON error/miss shapes; **catch-all** converts infra throws into business JSON strings |
| `app/chat/page.tsx` | consumes `agentEvent.toolResult.name` / `.result` |
| Eval | K11 asserts `checkName === "tool_gate_check"`; CodeScorer reads tool **names** from tracer act events (`tool_call` payloads), not tool result JSON |
| Known terminal gaps (out of scope to fully close) | pre-start abort throw; adapter throws in loop; uncaught confirmation-store throws |

---

## 2. Target contract

### 2.1 ToolOutcome (binding)

```ts
/** JSON-serializable value (structured clone / JSON.stringify safe). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Discriminated tool outcome — produced by dispatch (and, after Slice C, handlers).
 * Never produced by the model.
 *
 * `name` is ALWAYS stamped by dispatch from `ToolCall.name`. Migrated handlers
 * return the outcome body without a caller-selectable name (see HandlerOutcome).
 */
export type ToolOutcome =
  | {
      readonly kind: "ok";
      readonly name: string;
      /** Complete JSON-serializable payload rendered to the model when structured. */
      readonly data: JsonValue;
      /** When present, sole source for numeric/advisory observation collection. */
      readonly observation?: Observation;
    }
  | {
      readonly kind: "typed_miss";
      readonly name: string;
      /** Short human summary (often the `error` field today). */
      readonly message: string;
      /**
       * Complete JSON-serializable payload rendered to the model.
       * MUST preserve HEAD fidelity (match_type, catalog_snapshot, candidates, …).
       */
      readonly data: JsonValue;
      /** Optional resolver candidates (also typically inside data). */
      readonly candidates?: readonly JsonValue[];
    }
  | {
      readonly kind: "typed_error";
      readonly name: string;
      readonly message: string;
      /**
       * Complete JSON-serializable payload rendered to the model.
       * MUST preserve HEAD fidelity (templateId, availableTemplates, type:"error", …).
       */
      readonly data: JsonValue;
    }
  | {
      readonly kind: "dispatch_error";
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "infra_error";
      readonly name: string;
      /** Internal cause for traces — NOT raw-exposed in compatibility UI string. */
      readonly cause: string;
    };

/** What a migrated handler returns (name stamped by dispatch). */
export type HandlerOutcome =
  | Omit<Extract<ToolOutcome, { kind: "ok" }>, "name">
  | Omit<Extract<ToolOutcome, { kind: "typed_miss" }>, "name">
  | Omit<Extract<ToolOutcome, { kind: "typed_error" }>, "name">;
```

Rules:

1. **Loop boundary only sees `ToolOutcome`.** After Slice C, handlers return `HandlerOutcome` (or still strings until migrated — then only via §2.3.1 bridge).
2. **`name` ownership:** Dispatch is the sole owner of `outcome.name` and stamps it from `ToolCall.name`. Handlers must not supply a contradictory name.
3. **JSON-serializability (binding):** Every payload that will appear on an observe event (`data`, nested fields used for render) **MUST** be JSON-serializable. Dispatch validates before emission (e.g. `JSON.stringify` round-trip or equivalent). A non-serializable handler outcome is converted to `infra_error` with a safe cause string.
4. **`renderToolOutcome` is total** for every valid `ToolOutcome` (see §2.1.1). Full fidelity for structured kinds lives on `data` + trace; the rendered string is what the model and deprecated `toolResult.result` see.
5. **Tool gate maps only `kind` → verdict + stable `reasonCode`** (see §2.2). No `JSON.parse` of result strings inside the gate.
6. **`dispatch_error`:** unknown tool / schema / arg-validation failure **before** the handler runs.
7. **`infra_error`:** unexpected throw after handler entry, non-serializable payload, or true infrastructure failure **not** reclassified as business kind. After Slice C, handlers must **not** catch-all swallow infra into business JSON (see §8.1).
8. **AgentEvent.observe** carries `toolOutcome: ToolOutcome`. **`toolResult` is derived** for this RFC’s lifetime (§2.6). Goldens assert structured kind / `reasonCode`, not raw evidence as kind.
9. **No `tool_call_id` on ToolOutcome.** Act/observe pairing remains positional. Intentional omission.

#### 2.1.1 `renderToolOutcome` rules (binding — required for Slice A)

| Kind | Render rule |
|------|-------------|
| `ok` | If `data` is a `string`, return it as-is (preserves non-JSON legacy and human strings such as `describeSubmitAnswerResult`). Otherwise `JSON.stringify(data)` (stable key order not required; content must match HEAD semantic payload for migrated handlers). |
| `typed_miss` | `JSON.stringify(data)` — `data` is the full miss object (same fields as today’s resolver miss JSON). |
| `typed_error` | `JSON.stringify(data)` — full error object (e.g. `{type:"error", templateId, message, availableTemplates}`). |
| `dispatch_error` | Return `message` (same family as today’s dispatch error result strings). |
| `infra_error` | Return a **fixed user-safe string** that does **not** embed raw `cause`: `"tool failed due to an internal error; please retry"`. Full `cause` stays on the structured outcome / trace only. |

Unit tests in Slice A must snapshot at least: ok-object, ok-string, typed_miss with candidates, typed_error with availableTemplates, dispatch_error, infra_error (safe string), **submit_answer ok with TypedOutput projection data**, **submit_answer ok with `data: null`**.

**Serializability helper (Slice A may include; Slice B must use):** reject cycles and non-finite numbers (`NaN`/`Infinity`); validate both `data` and optional `observation` payloads before observe emission.

### 2.2 Tool gate mapping (binding)

```ts
export type ToolGateReasonCode =
  | "tool_ok"
  | "typed_miss"
  | "typed_error"
  | "dispatch_error"
  | "infra_error";
```

| `ToolOutcome.kind` | Gate `verdict` | `reasonCode` | Model continues? |
|--------------------|----------------|--------------|------------------|
| `ok` | `pass` | `tool_ok` | yes |
| `typed_miss` | `pass` | `typed_miss` | yes (clarification) |
| `typed_error` | `error` | `typed_error` | yes (within **MAX_STEPS** only — no separate retry counter) |
| `dispatch_error` | `error` | `dispatch_error` | yes |
| `infra_error` | `error` | `infra_error` | **no** — fail-closed terminal (§2.5) |

#### Reason-code carrier (frozen)

- **`checkName` stays `tool_gate_check`** for all tool-gate verdicts (HEAD + K11).
- New field on `TurnGateVerdictEvent`: `readonly reasonCode?: string`. For tool-gate rows, **`reasonCode` is required** and is exactly one of `ToolGateReasonCode`.
- Free-text `evidence` is human-only; goldens assert `verdict` + `checkName` + `reasonCode` (and/or `toolOutcome.kind`), not evidence regexes for kind.
- Other gates may leave `reasonCode` undefined; this RFC freezes tool-gate only.

#### Mapper signature (Slice A binding)

```ts
export type ToolGateFromOutcome = {
  readonly checkpoint: "tool";
  readonly verdict: "pass" | "error"; // tool gate has no block row
  readonly checkName: "tool_gate_check";
  readonly reasonCode: ToolGateReasonCode;
  readonly evidence: string; // human-only; not golden grain
};

export function toolGateFromOutcome(outcome: ToolOutcome): ToolGateFromOutcome;
export function renderToolOutcome(outcome: ToolOutcome): string;
```

Evidence strings should remain roughly human-readable (may change); must not be golden grain.

### 2.3 Compatibility with keep goldens

- K10 / K11 stay at gate/verdict grain, extended with **`reasonCode`**.
- Canonicalizer: keep structured `toolOutcome.kind`; do not bijection-normalize kinds.
- Structured ids under `ok.data` / nested proposal paths enter RFC 0001 Appendix A bijection. Canonicalizer **must** normalize both top-level `proposal_id` / `proposalId` and nested `toolOutcome.data.proposal.id` (and equivalent snake paths) once observe carries structured data.
- **Freeze new tool-path goldens only with Slice B** (same PR as wiring). No half-migrated main.

### 2.3.1 Legacy handler bridge — Slice B only (binding)

HEAD handlers return `Promise<string>`. Slice B requires every gated observe to carry `ToolOutcome` before handlers migrate in Slice C.

**Single dispatch-owned normalizer** (no other module parses legacy result strings for kind):

```ts
function normalizeLegacyToolResult(name: string, raw: string): ToolOutcome
```

| Input | Output kind | Notes |
|-------|-------------|--------|
| non-JSON string | `ok` | `data` is the original string |
| JSON object with `type === "error"` | `typed_error` | `message` is the parsed `message` field when it is a string; otherwise the exact HEAD fallback **`"typed error result"`**. **`data` = entire object** |
| JSON object with string `error` and `match_type` starting with `miss_` | `typed_miss` | `message` from `error`; **`data` = entire object**; `candidates` from object if array |
| JSON object with string `error` but no miss marker | `typed_error` | `message` from `error`; **`data` = entire object** |
| any other parsed JSON value | `ok` | `data` is that value (must be JsonValue; else infra) |
| handler throw after entry | `infra_error` | `cause` is a **sanitized** public diagnostic (see §2.5) — not raw `Error.message` / `String(err)` |

Also:

- Unknown tool / pre-handler schema validation → `dispatch_error` (not via this normalizer).
- **`query_catalog` observation (Slice B bridge):** when `name === "query_catalog"` and the parsed value is an observation result, `normalizeLegacyToolResult` **MUST** also set `outcome.observation` to the same **capped** observation contained in `data`. `data` remains the entire parsed object. This is the only Slice-B extraction; no later module re-parses `raw` for observation.
- Bridge is **deleted in Slice C** once all production handlers return `HandlerOutcome`.
- Do not leave half tools on strings without going through this single bridge.

### 2.4 Paths that are not ordinary tools Map handlers (binding)

#### `submit_answer`

- Not in tools Map. After Slice B, observe **must** carry `toolOutcome`.
- **Kind:** `ok`, `name: "submit_answer"` (stamped by the **loop** terminal path, not `dispatchTool` — exception to “dispatch owns name”).
- **`data` (binding):**  
  - `null` **only** when `parseSubmitAnswerArgs` returns `null` (empty prose **and** empty refs; reply falls back to model content).  
  - Otherwise a **JSON-safe plain-object projection** of `TypedOutput`, with undefined optional keys omitted. The projection preserves complete `prose`, `foodRefs`, and `ruleRefs` values.  
  - **`TurnResult.output` remains the original `TypedOutput`** (not the projection).  
  - Dispatch/loop validates the projection before emission; an invalid projection becomes `infra_error`.  
  - Do **not** treat non-empty prose-only as `data: null`.
- **Render:** for `name === "submit_answer"`, `renderToolOutcome` uses existing `describeSubmitAnswerResult` semantics (import or re-implement identically) on the logical TypedOutput/null, not bare `JSON.stringify` of the projection — so chat/tool cards stay stable.
- Gate: `ok` → `pass` / `tool_ok`. Never reclassify null as `dispatch_error`.
- Slice A tests should include render cases for submit_answer with structured projection data and with `null`.

#### `log_meal` / write-proposal extraction (confirm-path upstream)

- Today: `parseWriteProposalData(toolResult.result)` when name is `log_meal`.
- **Frozen `ok.data` shape:** the **parsed object currently emitted by `proposalResponse`** in `logMeal.ts` (snake_case: `proposal_id`, nested `proposal.id`, `nutrition_summary`, …).
- `parseWriteProposalData(data: unknown)` becomes a **structural validator** on that object only (no string parse when `toolOutcome` present).
- Canonicalizer: normalize `proposal_id` and nested `toolOutcome.data.proposal.id` (and `proposalId` aliases).
- **Forbidden:** dual source of truth (string result **and** structured data) after bridge deletion.

#### Query catalog observation

- Today: `parseQueryCatalogObservation(result: string)`.
- **Sole gate source for numeric/advisory observations:** `outcome.observation` on `ok` for `query_catalog`.
  - It is the **same capped** observation exposed for gates; uncapped observation remains trace-only (HEAD behavior).
  - **`ok.data` is not a second gate observation source.**
- Must not re-parse result strings when `toolOutcome` is present.
- By end of Slice C: `turn.ts` has **zero** residual `JSON.parse` of tool result strings.

### 2.5 `infra_error` turn-level semantics (binding)

**HEAD reality:** `dispatchTool` does not catch handler throws; handlers often catch-all; uncaught throw can tear the generator without `TurnEndEvent`.

**Frozen policy:**

1. Dispatch boundary converts post-entry throws / non-serializable outcomes to  
   `{ kind: "infra_error", name, cause }` — never re-throw through the generator for that path.
2. **`cause` sanitization (binding):** `cause` is a **sanitized diagnostic string safe to include in the public turn-event stream** (observe is NDJSON’d to the browser). Raw `Error.message` / `String(err)` text **MUST NOT** enter `ToolOutcome`, `toolResult`, gate evidence, or `TurnResult.reply`. Raw diagnostics may be recorded only in a **server-side** trace or log. Public `cause` may be a fixed code such as `"internal_error"` (or a small allowlisted enum); implementers must not invent per-exception message passthrough.
3. Required event / control-flow sequence:

   ```
   act → observe(infra_error) → tool gate error (reasonCode: infra_error)
        → turn_end(stopReason: "crash")
   ```

4. After `infra_error` on a tool call:
   - **Stop remaining tool calls** in the same model response.
   - Model receives **no later ReAct step**.
   - **Do not** emit output-gate summary or commit-gate “pass/committed” for this terminal.
   - A **previously captured write proposal must not override** `crash` (today `write_proposal` can overwrite stopReason — forbidden after infra).
5. `TurnResult` for crash: `stopReason: "crash"`, `steps` = current step count, **non-empty** user-displayable `reply` (retry message). Do not put raw infra details in `reply` or in `renderToolOutcome`.
6. Reuse `StopReason` value **`crash`** — no new stop reason in this RFC.
7. **Out of scope (document honestly, do not “fix by accident”):** pre-start abort throw; model adapter throws; uncaught confirmation-store throws on confirm path. If left as today, they may still violate exactly-one-terminal; closing them is not required for Phase 2 acceptance unless touched.

Business failures (§8.1) are never `infra_error`.

### 2.6 `toolResult` deprecation and UI (binding)

```ts
toolResult = {
  name: outcome.name,
  result: renderToolOutcome(outcome),
  dispatchError: outcome.kind === "dispatch_error" ? true : undefined,
};
```

- Chat may keep reading `.name` / `.result`.
- **Removing `toolResult` is not allowed** in this RFC.
- **`SCHEMA_VERSION`:** HEAD is `1.6.0` → bump to **`1.7.0` in Slice B** when observe gains `toolOutcome` and gate verdicts gain `reasonCode`.

---

## 3. Implementation slices (commit order)

### Slice A — Type + pure mappers (no production wiring)

1. Add `src/harness/toolOutcome.ts`: types + `renderToolOutcome` + `toolGateFromOutcome` (+ optional `isJsonValue` / serializability helper used later by dispatch).
2. Unit tests: §2.2 full kind → `{ checkpoint, verdict, checkName, reasonCode }` table; §2.1.1 render snapshots.
3. Zero wiring into loop/turn/handlers.
4. `parseHandlerResult` remains until B/C.

### Slice B — Loop / turn consume ToolOutcome

1. Dispatch returns `ToolOutcome` (via bridge for string handlers + throw catch).
2. Every gated observe carries `toolOutcome`; derive `toolResult` (§2.6).
3. Tool gate = `toolGateFromOutcome` only; emit `reasonCode`; include `checkpoint: "tool"`.
4. `submit_answer` observe uses §2.4.
5. Query observation from `outcome.observation` only; log_meal proposal from structured `ok.data` validator.
6. `infra_error` sequence §2.5 (no output/commit pass; no proposal override).
7. SCHEMA_VERSION → `1.7.0`.
8. Canonicalizer nested proposal id paths.
9. K10/K11 + tool-gate tests green **same PR** (`reasonCode` asserts).

### Slice C — Handler migration

1. `log_meal`, `query_catalog` emit `HandlerOutcome` per §8.1; remove catch-all that turns infra into business JSON (or rethrow / map explicitly).
2. Delete `normalizeLegacyToolResult` and `parseHandlerResult` and residual result-string JSON.parse in `turn.ts`.
3. Keep derived `toolResult`.

### Slice D — Eval (minimal)

1. CodeScorer: tool names from act/`tool_call` traces — **expected no-op** for result JSON.
2. Only touch if a concrete assertion needs structured kind. No eval system rewrite.

Order: **A → B → C → D** (D may be empty). Serial preferred.

---

## 4. Non-goals

| Deferred | Item |
|----------|------|
| Phase 3 | TraceEvent / AgentEvent merge; tracer demotion |
| Phase 4 | Delete `runTurn`; deeper turn decomposition |
| Phase 5 | Catalog package split |
| Phase 6 | `createTurnAssembly` + port-bag purge |
| Later | Chat UI migration off `toolResult` |
| Never here | New tools, RAG, model routing |
| Out of scope | Fully unifying abort / adapter / confirm-store throws → terminal |

---

## 5. Acceptance checklist

- [ ] `ToolOutcome` exported; loop boundary uses it (post B)
- [ ] Tool gate: zero `JSON.parse` of tool result strings
- [ ] `turn.ts`: no residual result-string `JSON.parse` by end of C
- [ ] §2.2 unit table including `reasonCode` + `checkpoint: "tool"`
- [ ] `renderToolOutcome` snapshots per §2.1.1
- [ ] `TurnGateVerdictEvent.reasonCode` on tool gate; `checkName` remains `tool_gate_check`
- [ ] K10 / K11 green with `reasonCode`
- [ ] `submit_answer` observe: `ok` with TypedOutput | null per §2.4
- [ ] Write-proposal path uses structured `ok.data` (proposalResponse shape)
- [ ] Query gates use `outcome.observation` only
- [ ] `infra_error` → observe + tool gate error + sole terminal `crash`; no output/commit pass; no proposal override
- [ ] Derived `toolResult` present; chat tool cards do not regress
- [ ] SCHEMA_VERSION `1.7.0` in Slice B
- [ ] `npm test` + `npm run typecheck` green
- [ ] `npm run smoke:confirm` green (confirm path / migration 0009 untouched)
- [ ] Confirm short-circuit unchanged

---

## 6. Risk notes

- Render fidelity: model sees same factual content as today’s JSON strings for structured tools.
- Partial migration: only the single B bridge parses legacy strings.
- `infra_error` vs `typed_error`: do not collapse; crash control-flow must beat proposal override.
- Confirm upstream: `log_meal` extraction footgun.
- Wider test inventory than K10/K11: turn tests may assert evidence text; loop tests exact `toolResult.result`; handler tests parse returned JSON — update with B/C as needed.
- Catch-all handlers block real `infra_error` until C changes them.

---

## 7. Suggested issues / tickets

1. **Slice A** — `toolOutcome.ts` + unit table + render snapshots  
2. **Slice B** — dispatch bridge + turn gate/observe/infra crash + SCHEMA 1.7.0 + K10/K11  
3. **Slice C** — migrate log_meal / query_catalog; delete bridge  
4. **Slice D** — scorer residual if any  

Blocking edges: 1 → 2 → 3 → 4.

---

## 8. Failure mode → kind (frozen)

| Source | Kind | Notes |
|--------|------|-------|
| Loop `ToolSchema` / arg validation before handler | `dispatch_error` | |
| Unknown tool name | `dispatch_error` | |
| `submit_answer` with TypedOutput (incl. prose-only empty refs) | `ok` | data = TypedOutput |
| `submit_answer` parse null (empty prose and refs) | `ok` | data = null; gate pass |
| `log_meal` resolver miss (`match_type` miss_*) | `typed_miss` | clarification path; full data object |
| `query_catalog` / food_lookup unknown food_id | `typed_error` | invalid/minted id; **not** clarification |
| Unknown query template (after handler entry; structured error) | `typed_error` | preserve `availableTemplates` in data |
| Template-specific parameter validation after entry | `typed_error` | |
| Handler-local business error JSON (`type:"error"` or `error` without miss) | `typed_error` | |
| ProposalStore / QueryRunner / unexpected throw after entry | `infra_error` | after C: remove catch-all that converts these to business JSON |
| Non-JSON-serializable outcome payload | `infra_error` | |

Implementers may add rows with file:line during C if new paths appear; changing an existing row’s kind is a behavior change requiring an RFC amend.

### 8.2 Wording clarifications (frozen)

- “Retry within budget” = remaining steps under **MAX_STEPS** only.
- `typed_miss.candidates`: prefer existing log_meal candidate objects; may also live inside `data`.
- No `tool_call_id` on ToolOutcome.

### 8.3 Canonicalizer / golden timing

- Tool-path golden updates land **with Slice B**.
- K10 evidence-regex → `reasonCode` / kind in that same PR.

---

## 9. Slice entry conditions

| Slice | Entry |
|-------|--------|
| **A** | This document treated as binding for types, render rules §2.1.1, mapper §2.2 |
| **B** | A merged/green; §2.3.1 bridge + §2.4–2.6 + §2.5 control-flow binding |
| **C** | B merged/green; §8 table applied; catch-all removal planned |
| **D** | C merged/green or empty if scorer needs nothing |

**Slice A may start** under this document.

---

## 10. Amend log

| Date | Change |
|------|--------|
| 2026-07-17 | Initial freeze |
| 2026-07-19 | reasonCode carrier; submit_answer; proposal path; infra crash; toolResult derive |
| 2026-07-20 | **Codex gpt-5.6-sol xhigh:** full `data` on miss/error; JSON-serializability; render rules; legacy bridge algorithm; observation sole source; proposalResponse shape; infra sequence (no output/commit/proposal override); submit_answer null vs prose-only; §8 classifications; SCHEMA 1.7.0; checkpoint on mapper; HandlerOutcome / name stamping |
| 2026-07-20 | **Codex r2:** bridge sets `query_catalog` `observation`; typed_error message fallback `"typed error result"`; submit_answer JSON projection of TypedOutput; public sanitized `cause`; Slice A may start; B blocked until these applied (now applied) |
