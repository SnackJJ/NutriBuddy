# RFC 0001 — Step 0 安全网 + Phase 1 Confirm 路径安全

> Status: **Implemented** (merged PR #72, 2026-07-17).  
> **Not always-on agent context** — open only when working this path or its history.  
> Architecture source of truth: `docs/ADD.md`  
> Scope: Step 0 + Phase 1 only. Phases 2–6 are sequenced in Appendix B; Phase 2 design is `docs/rfc/0002-tool-outcome.md`.  
> Precedence: conflicts with AGENTS/BRIEFING/PRD status notes resolve to this RFC for Phase 1 work.  
> Live smoke: `npm run smoke:confirm` (requires migration 0009 on the target Supabase project).

## Why

Confirm path today has two C1 gaps that do not depend on any structural rewrite:

1. **Optional ports + silent fallback** — missing `proposalStore` / `sessionUserId` yields `pass` and a fake “confirmed/rejected” reply (`no store wired`).
2. **Non-atomic commit** — `proposalStore.commit` then `mealLogStore.insert` can leave `status=committed` with no ledger row.

Phase 1 closes both. Step 0 installs the regression net (C3 event stream + invariants) before semantics change.

### Completion bar (three ladders)

| Label | Required |
|-------|----------|
| **安全 seam 可用** | Step 0 invariants + this Phase 1 merged |
| **结构上收敛** | Phases 2–4 (out of scope here) |
| **卫生完成** | Phases 5–6 (out of scope here) |

Phase 1 is the only **correctness blocker**. Do not call the harness “safe on the write path” before it merges.

### Step 0 implementation order

1. Canonicalizer unit tests (bijective id + timestamp neutrality)  
2. K goldens (gate/verdict grain)  
3. F shells marked expected-to-change until Phase 1  

---

## 1. Step 0 — Fixture list (keep / fix)

Fixtures drive scripted `turn()` with fixed clock, in-memory stores implementing the **same public verdict contract as production** (see §1.1), and a scripted model adapter.

### 1.0 Golden granularity (binding)

Keep goldens freeze **gate / terminal-verdict structure**, not store-call choreography.

| Assert in golden (`AnyTurnEvent[]`, canonicalized) | Do **not** assert in golden |
|----------------------------------------------------|-----------------------------|
| Event types and order at seam grain: `turn_start` → (steps/gates) → `gate_verdict`* → `turn_end` | Number of store RPCs / awaits |
| Gate `checkpoint` + `verdict` + stable **reason code** | Free-text `evidence` that distinguishes impl-internal causes |
| Terminal `stopReason` and structured terminal payload fields that are part of the seam contract | Whether commit was one RPC or two client calls |
| Presence/absence of a write-proposal terminal | “Which store method ran” |

**Side-effect assertions** (ledger row exists, proposal status, no insert, no status change) live in **fixture code that queries the store/DB after the turn**, not in event evidence strings.

Rationale: Phase 1 replaces two awaits with one RPC. If goldens encode store-call grain, Phase 1 commit 1 becomes unreviewable churn. Gate/verdict grain stays stable across that rewrite (C3).

### 1.1 Production-aligned not-committable collapse (binding before freeze)

Under session-scoped client + RLS, user B cannot read user A’s proposal. The commit RPC returns **one** business rejection class. Therefore **K5 (cross-tenant), K6 (non-proposed), K7 (missing)** are **not distinguishable in production app-layer events**.

**Verdict contract (all implementations, including in-memory):**

| Case | Commit gate `verdict` | Stable reason code | Free-text evidence |
|------|----------------------|--------------------|--------------------|
| Cross-tenant / wrong owner | `block` | `not_committable` | Goldens assert **only** the reason code |
| Status ≠ `proposed` | `block` | `not_committable` | same |
| Unknown proposal id | `block` | `not_committable` | same |

**Reason source:** `CommitResult` / `VoidResult` discriminant `kind` (from RPC jsonb `status` via adapter). **Not** exception-message parsing.

- No `error` vs `block` hedge for K7.
- In-memory stores must not emit richer golden-asserted gate fields than production.
- Side effects for K5–K7: fixture asserts via store inspection — no status transition, no meal insert.
- Decline not-committable cases: same reason code. Infrastructure failures (F3): gate `error`.

### 1.2 Keep (semantics frozen at gate/verdict grain; golden before Phase 1)

| ID | Path | Setup sketch | Golden must observe | Store/side-effect (test code, not golden) |
|----|------|--------------|---------------------|-------------------------------------------|
| K1 | Normal utterance → final | Gated ports; scripted end_turn + TypedOutput | Seam order; output gate pass; commit pass; `turn_end` | — |
| K2 | Utterance → write_proposal | `log_meal` success | Terminal `write_proposal`; commit gate pass (proposal-only reason code) | Zero meal rows |
| K3 | Confirm success | Own `proposed`; confirm=true | Commit gate **pass**; terminal success; id lineage on structured fields | Ledger row with matching `proposal_id`; status `committed` |
| K4 | Reject success | Own `proposed`; confirm=false | Commit gate **pass**; terminal reject | Status `voided`; zero meal rows |
| K5 | Confirm cross-tenant | Proposal of A; session B | Commit gate **block** + reason `not_committable` | No status change; no insert |
| K6 | Confirm non-proposed | Already `committed`/`voided` | **Same golden shape as K5** for gate fields | No second insert; status unchanged |
| K7 | Confirm missing proposal | Unknown id | **Same golden shape as K5** for gate fields | No insert |
| K8 | Input gate prescriptive | Allergy + recommend intent | Input gate pass + refuse-and-cite directive | — |
| K9 | Input gate descriptive | Allergy + log intent | Advise directive; advisory path armed | — |
| K10 | typed_miss | Ambiguous/unknown on `log_meal` | Tool gate pass + miss reason code; no minted food id | — |
| K11 | typed_error | Invalid template / handler error | Tool gate **error** | — |
| K12 | Output gate retry → pass | First final fails; second passes | ≤2 regenerations; final pass | — |
| K13 | Output gate exhaust | Fail through max retries | `gate_blocked`; commit block | — |
| K14 | Untagged not recommendable | FoodRef without reviewed tags | Entity check block (fail closed) | — |

K5/K6/K7 may share one golden template for event shape; separate fixtures still exist for store side-effects.

### 1.3 Fault injection contract (in-memory store)

```ts
/** Test-only. In-memory ProposalStore must implement this; Supabase adapter must not. */
export interface FaultInjectable {
  /** Next commitProposalAndInsertMeal returns {kind:"error", cause}, with
   *  zero state change (proposal stays proposed; no meal row). One-shot. */
  failNextCommit(cause: string): void;
  /** Same for voidProposal. */
  failNextVoid(cause: string): void;
}
```

1. Injected failure runs **before the critical section** (or after full atomic rollback). In-memory must never expose “status committed / no meal” even on the fault path. F2 asserts final state only — not that insert was entered.
2. `failNext*` is one-shot and auto-resets. Fixtures must not rely on sticky failure.
3. **Sole** legal injection seam. No monkey-patch of store methods; no fixture subclass overrides for F2/F3.
4. Supabase path relies on **DB transactions** for F2 equivalence; F2/F3 fixtures target in-memory + turn mapping only.
5. **Type placement:** `FaultInjectable` lives in test double modules (`tests/helpers` or a dedicated test-only factory file). Production `ProposalStore` interface does **not** include fault methods. Factory: `createInMemoryProposalStore(): ProposalStore & FaultInjectable`. Turn depends only on `ProposalStore`.

### 1.4 Fix (invariants now; golden after Phase 1)

| ID | Path | Invariant (assert, not comment) |
|----|------|----------------------------------|
| F1 | Confirm ports incomplete | **Unrepresentable**: `ConfirmPorts` requires `proposalStore` + `sessionUserId` at type level; no runtime `no store wired` branch |
| F2 | Via `failNextCommit` | Returns `{kind:"error"}`; proposal still `proposed`; meal ledger zero new rows; commit gate **error** |
| F3 | Via `failNextVoid` | Returns `{kind:"error"}`; proposal still `proposed`; stream must **not** claim rejected/voided terminal; commit gate **error**, fail closed |
| F4 | Decline cross-tenant / missing / not proposed | Same as K5: gate `block` + `not_committable`; no void |

### 1.5 Standing invariants (every fixture)

- Commit / void only by **proposal id** through the writer path; model output never mutates ledger.
- Meal insert only from **confirmed** proposal bytes (lineage `proposal_id` set).
- Untagged foods never appear in released recommendation `foodRefs` (K14).
- Unit-bearing numbers in released TypedOutput must carry observation/resolver provenance.
- `userId` is never a model-fillable tool or RPC argument.

---

## 2. RPC signature & identity binding

### Production path (Supabase)

Turn path uses the **session-scoped** client (`createUserSupabase(accessToken)`), not service role.

**Business rejection is a normal return.** `raise` is only for unauthenticated and true infrastructure / invariant violations. Adapter does **not** parse exception messages for business outcomes.

```sql
-- migration 0009_commit_proposal_and_void.sql
-- meal_log_id serialized as JSON number; safe while id < 2^53 (identity column)

create or replace function public.commit_proposal_and_insert_meal(
  p_proposal_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_prop public.proposals%rowtype;
  v_meal_id bigint;
  v_updated int;
begin
  -- raise ONLY for auth/infra/invariant. Business rejection is a normal return.
  if v_uid is null then
    raise exception 'unauthenticated';
  end if;

  select * into v_prop
  from public.proposals
  where id = p_proposal_id
    and user_id = v_uid
    and status = 'proposed'
  for update;

  if not found then
    -- missing / cross-tenant (RLS-invisible) / already committed or voided.
    -- Deliberately indistinguishable (§1.1). No writes have occurred.
    return jsonb_build_object('status', 'not_committable');
  end if;

  update public.proposals
  set status = 'committed'
  where id = v_prop.id and status = 'proposed';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    -- Impossible after FOR UPDATE held a proposed row in this transaction:
    -- lock/invariant bug, not a business rejection. Must not look like not_committable.
    raise exception 'invariant: locked proposal changed status';
  end if;

  insert into public.meal_logs (
    user_id,
    food_name,
    portion_g,
    meal_type,
    kcal,
    protein_g,
    fat_g,
    carbs_g,
    proposal_id,
    food_id,
    match_type,
    allergen_tags
  ) values (
    v_prop.user_id,
    v_prop.food_name,
    v_prop.portion_g,
    v_prop.meal_type,
    v_prop.kcal,
    v_prop.protein_g,
    v_prop.fat_g,
    v_prop.carbs_g,
    v_prop.id,
    v_prop.food_id,
    v_prop.match_type,
    v_prop.allergen_tags
  )
  returning id into v_meal_id;

  return jsonb_build_object(
    'status', 'committed',
    'proposal_id', v_prop.id,
    'meal_log_id', v_meal_id
  );
end;
$$;

revoke all on function public.commit_proposal_and_insert_meal(text) from public;
grant execute on function public.commit_proposal_and_insert_meal(text) to authenticated;

create or replace function public.void_proposal(
  p_proposal_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'unauthenticated';
  end if;

  -- Single UPDATE takes a row lock. row_count=0 is legitimate not_committable
  -- (missing / cross-tenant / already voided or committed, including races).
  update public.proposals
  set status = 'voided'
  where id = p_proposal_id
    and user_id = v_uid
    and status = 'proposed';

  get diagnostics v_count = row_count;

  if v_count = 0 then
    return jsonb_build_object('status', 'not_committable');
  end if;

  return jsonb_build_object(
    'status', 'voided',
    'proposal_id', p_proposal_id
  );
end;
$$;

revoke all on function public.void_proposal(text) from public;
grant execute on function public.void_proposal(text) to authenticated;
```

Notes:

- `logged_at` / `created_at` use table defaults (`now()`).
- Allowed `raise` message whitelist: `unauthenticated`, `invariant: locked proposal changed status`. No business token (e.g. `not_committable`) may appear in `raise exception`.

### Binding rules

| Rule | Binding |
|------|---------|
| RPC args | **Only** `p_proposal_id`. Never `user_id` / `session_user_id`. |
| Identity source | `auth.uid()` from the caller JWT only. |
| Unauthenticated | `auth.uid() is null` → `raise exception 'unauthenticated'` → adapter `kind:"error"`. |
| Ownership | `user_id = auth.uid()` on SELECT/UPDATE predicates. |
| Privilege model | **`SECURITY INVOKER`**. No service-role client on this path. |
| Discriminator carrier | Business rejection via **normal return** `{status:'not_committable'}`. `raise` only for unauthenticated, invariant, and true infra. Adapter does not parse exception messages for business outcomes. |
| Two-function contract | Shared business status set: `committed \| voided \| not_committable`. Any third business status requires re-RFC. |
| DEFINER later | Reject unless re-RFC. |

### App-layer types and mapping

```ts
export type CommitResult =
  | {
      readonly kind: "committed";
      readonly proposalId: string;
      readonly mealLogId: number; // aligns with MealLogEntry.id
    }
  | { readonly kind: "not_committable" }
  | { readonly kind: "error"; readonly cause: string };

export type VoidResult =
  | { readonly kind: "voided"; readonly proposalId: string }
  | { readonly kind: "not_committable" }
  | { readonly kind: "error"; readonly cause: string };

export interface ProposalStore {
  commitProposalAndInsertMeal(proposalId: string): Promise<CommitResult>;
  voidProposal(proposalId: string): Promise<VoidResult>;
}
```

Gate mapping:

| `kind` | Commit gate |
|--------|-------------|
| `committed` / `voided` | **pass** |
| `not_committable` | **block**, reason `not_committable` |
| `error` | **error**; `cause` is human-readable evidence only — **turn never branches on `cause`** |

Supabase adapter:

- jsonb `status` is the **only** business discriminator.
- Maps **known keys only** (`status`, `proposal_id`, `meal_log_id`) — no raw jsonb spread into domain types.
- Any thrown exception → `{ kind: "error", cause }` (unauthenticated and network collapse together at this boundary; production confirm holds a session client).

In-memory / CLI stores implement the same interface and reason codes; commit is one critical section. Turn never calls `commit` + `insert` as two steps.

### sessionUserId ↔ JWT sub (assembly assert)

At turn assembly (chat route / future `createTurnAssembly`), assert JWT `sub` === `sessionUserId` before `turn()`. Mismatch fails the request; no RPC.

### Discriminator chain (contract summary)

```text
SQL jsonb.status
    → adapter maps known keys → CommitResult | VoidResult (.kind)
    → turn maps .kind → gate verdict + reason code
         ↗ raise (unauthenticated | invariant | infra)
              → catch → { kind: "error", cause } → gate error
                (cause never drives control flow)
```

Zero business-string parsing. In-memory and Supabase share `CommitResult` / `VoidResult`. Fine-grained ownership evidence cannot re-enter the event stream via exception text.

---

## 3. Port type shapes

```ts
export type GatedUtterancePorts = {
  readonly kind: "gated";
  readonly catalog: Catalog;
  readonly userContext: UserContext;
  // …adapter, tracer, tools, proposalStore for log_meal on utterance path, etc.
};

/** Test-only. Construct solely via tests/helpers. */
export type UngatedUtterancePorts = {
  readonly kind: "ungated";
};

export type UtterancePorts = GatedUtterancePorts | UngatedUtterancePorts;

/**
 * Confirm/reject short-circuit.
 * Required: proposalStore + sessionUserId only.
 * mealLogStore is NOT on this port — writes go only through proposalStore RPCs.
 */
export type ConfirmPorts = {
  readonly kind: "confirm";
  readonly proposalStore: ProposalStore;
  readonly sessionUserId: string;
  readonly clock?: () => Date;
};

export type TurnPorts = UtterancePorts | ConfirmPorts;
```

Notes:

- `sessionUserId` is used **only** for: (a) assembly JWT `sub` assert, (b) identifying the session subject on the event stream if needed. **Ownership is decided solely by RPC discriminant `kind`. Turn performs no pre-RPC ownership check** (no get-then-branch that would re-split K5/K6/K7).
- F1 type-level requirement: **`proposalStore` + `sessionUserId` only**.
- `ungatedTestPorts` under `tests/helpers/` only.
- Utterance path may still use meal list APIs for **reads**; outside `ConfirmPorts`.

---

## 4. Phase 1 deletion list

### Commit 1 — semantic fix

Delete or replace:

| Symbol / branch | Location (today) |
|-----------------|------------------|
| `no store wired` branch | `handleProposalConfirm` |
| Sequential `commit` + `insertMealLogFromProposal` | same |
| `declineProposalBestEffort` swallow | same |
| Pre-RPC ownership get-then-branch that emits distinct evidence | confirm path |
| Distinct golden-asserted evidence for K5/K6/K7 | tests |
| Optional confirm stores; `mealLogStore` on confirm ports | `TurnPorts` → `ConfirmPorts` |
| Confirm success without `proposalStore` tests | tests |

Add: migration 0009 (full bodies above), store methods + in-memory + `FaultInjectable` double, JWT assert, F1–F4 tests, K goldens green at gate grain.

### Commit 2 — move-only

Confirm short-circuit → `src/harness/proposalConfirm.ts`.  
**Canonicalized keep goldens zero diff** vs post–commit-1.

---

## PR discipline

1. Step 0 separate PR preferred: canonicalizer (+ tests) → K goldens → F shells (expected-to-change).  
2. Phase 1 PR = two commits (semantic, then move).  
3. Freeze feature work on confirm/write path until Phase 1 merges.  
4. Phases 2–6 not started until Phase 1 is green.

---

## Appendix A — Canonicalizer rules

Input: `readonly AnyTurnEvent[]`. Output: JSON-stable structure for snapshot compare.

| Field | Rule |
|-------|------|
| `timestamp` | `"<ts>"` |
| `latencyMs` / `costUsd` | Strip or `0` |
| `seq` / `schema` | Keep |
| Proposal / tool-call ids | **Bijective within one stream**: first seen → `"<id:0>"`, … Prefer structured keys (`proposalId`, `proposal_id`, tool call `id` / `tool_call_id`). |
| Free-text `evidence` | Prefer not golden-compared when reason code exists; if kept, rewrite known raw ids via the same bijection only |
| Reason codes (`not_committable`, etc.) | Keep exact |
| Catalog `foodId` seed ids | **Do not** bijection-normalize (fixture-stable ground truth) |

**Canonicalizer unit tests (required):**

1. Two events sharing one proposal id → same placeholder.  
2. Two distinct ids → two placeholders; first-seen order, not raw string sort.  
3. Cross-event structured id equality holds after canonicalize.  
4. Timestamp/latency-only changes → no snapshot diff.  
5. K5 vs K6 setups → identical canonical **gate** subsequence when comparing reason-code fields only.

---

## Appendix B — Explicit non-goals

- ToolOutcome (Phase 2), events.ts / tracer demotion (Phase 3), turn decomposition / delete `runTurn` (Phase 4), catalog split (Phase 5), full `createTurnAssembly` + legacy purge (Phase 6) — except minimal JWT/`sessionUserId` assert on existing assembly.

---

## Acceptance checklist (Phase 1 merge)

### After commit 1 (semantic)

- [ ] F2 via `FaultInjectable.failNextCommit` only  
- [ ] F3 via `FaultInjectable.failNextVoid` only  
- [ ] F1: `ConfirmPorts` requires `proposalStore` + `sessionUserId` (no `mealLogStore`)  
- [ ] RPC business rejection is normal return; migration 0009 `raise` whitelist only (`unauthenticated`, `invariant: locked proposal changed status`)  
- [ ] tests: no store-method monkey-patch for F2/F3  
- [ ] Chat: session JWT client + `sub` === `sessionUserId` assert  
- [ ] K5/K6/K7: `block` + `not_committable`; side-effects via store  
- [ ] K1–K14 goldens green at gate/verdict grain  
- [ ] Adapter maps known jsonb keys only; `mealLogId: number`

### After commit 2 (move-only)

- [ ] Canonicalized keep goldens **zero diff** vs post–commit-1  
- [ ] `handleProposalConfirm` gone from `turn.ts`  
- [ ] Deletion lists in both commit messages  
