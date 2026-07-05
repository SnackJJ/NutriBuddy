# NutriBuddy — Architecture Decision Document

> Source of truth for NutriBuddy architecture as of 2026-07-05. Downstream documents may preserve product context or implementation status, but conflicts resolve in favor of this ADD.

Consolidates the briefing, the Round 1 harness design, and the Round 1b deepening into one reference. Where synthesis forced a decision the rounds left open, the section says so with a *(new decision)* marker.

## Safety Thesis

NutriBuddy guarantees that every safety-relevant fact in a released answer traces to deterministic machinery, not model memory. The model narrates; the tool layer asserts facts; gates check structure. Concretely: food entities exist only as catalog ids the resolver minted — the model cannot invent one; numbers exist only as observation values that reviewed query templates computed — the model does no arithmetic; mutations exist only as proposals a user confirmed — the model writes nothing autonomously. C1 (a wrong allergen or drug-nutrient answer injures; a refusal merely annoys) entails fail-closed blocking on the recommendation surface. C2 (numbers come from data, per the numeric-hallucination eval category) entails the no-arithmetic contract and numeric provenance checking. C3 (the eval is deterministic) entails that every gate is a pure check emitting a typed verdict the scorer reads directly — no safety property depends on a stochastic judge. One sentence governs the whole design: the model chooses among options that deterministic code defines; it never authors the option space.

## The Testing Seam

One seam: the turn boundary. A single turn function takes a tagged input — free-text utterance or structured proposal confirmation — plus injected ports for the model adapter, every store, the food catalog with its resolver, and the clock. It yields an ordered, schema-versioned stream of typed events ending in exactly one terminal event: final answer, clarification request, write proposal, refusal, or error. Everything the harness does appears in that stream; everything external enters through a port. Both eval runners and both surfaces (CLI, web chat) drive this same function. Nothing above the seam holds logic. Nothing below it reaches the network, database, or clock except through its port.

Five consequences drive the rest of this document:

1. A behavior that matters must be a typed event. Gate verdicts, proposals, stop reasons — if the scorer cannot see it in the stream, it does not exist (C3).
2. The model is a port. A scripted adapter makes full turns deterministic in CI; the live adapter measures the model nightly. Same runner, same scorer, same event schema.
3. Multi-turn protocols decompose into single-turn invocations. Clarification and write proposal are terminal events; confirmation is a turn *input*, not a second endpoint. Seam count stays at one.
4. Deterministic actions never route through the model. A confirmation input short-circuits: no model call, deterministic commit by proposal id, events still emitted through the seam. *(New decision — Round 1b left the confirmation transport unspecified. A model-mediated commit makes the one action the user explicitly approved stochastic, which C1 forbids.)*
5. External data sources leave the hot path. USDA becomes snapshot ingestion feeding local tables, because a port that calls a rate-limited external API cannot back a deterministic CI turn. *(New decision — detailed under Data Pipeline.)*

The profile-management API sits outside the seam by design. It is the one write path the agent cannot reach; it needs ordinary endpoint tests, not harness evals.

## Architecture

### Loop

Single agent. Hybrid control flow: ReAct for interactive decisions — ambiguity, clarification, write proposals — and catalog invocation for reads, where the model emits a template id plus parameters and the executor renders reviewed SQL. What Round 1 called CodeAct survives as this typed query catalog: the load-bearing property was always server-side computation landing derived numbers in observations (C2), never model-authored SQL.

Step budget: eight. The deepest eval case — cross-domain drug-nutrient — needs three grounding calls plus composition; eight gives 2× headroom. Budget exhaustion emits a typed stop reason and the deterministic refusal template, never a silent truncation.

Clarification requests and write proposals are terminal events. The turn ends, the user answers, the next turn gets fresh budget. Ambiguity resolution therefore never competes with the step cap.

Two contracts bind the model. **No arithmetic:** every derived quantity — portion scaling, weekly sums, week-over-week differences — arrives as an observation column, because model mental math is where invented numbers enter (C2). **Typed final output:** prose plus recommendation FoodRefs plus advisory RuleRefs. Free prose is unauditable; typed fields are gateable.

The loop buffers the full answer before release. Token streaming and a blocking output gate are mutually exclusive — a streamed violation cannot be retracted (C1). The async generator's step events stream instead ("checking interactions… fetching salmon…"), masking latency without shipping unvetted tokens.

### Context

Two regions. **Pinned, byte-stable:** system prompt with both contracts, template catalog signatures, profile snapshot with version stamp, and the user's applicable drug-nutrient rules — the full rule table holds 20–30 rows, so the user's subset always fits. Constraints pin rather than arrive via a fetch tool because a tool call can be skipped, and the constrained eval category is precisely the test for a skipped fetch. Byte stability feeds the provider prefix cache.

**Dynamic:** conversation, capped tool observations, and the pending-proposal digest when one exists — a free-text edit ("make it brown rice") requires the model to see what it edits; the edit produces a superseding proposal, never a mutation of the stored one.

Growth control: the assembler caps observations — canonical rendering, top-k rows, byte ceiling — while full fidelity flows to the trace. The answer needs a summary; the eval and the RL consumer need everything; the destinations split. Cross-turn: sliding window over conversation; everything durable — constraints, meals, proposals — lives in Postgres, not chat history. Compaction stays out of scope until context telemetry demands it.

### Tools

A shared deterministic **resolver** underlies the tool set; it is a library, not a tool. Cascade: exact match → alias table → fuzzy with threshold. Exact and alias hits proceed. A single dominant fuzzy candidate proceeds with its match type recorded, and the answer must name the resolved entity. Multiple candidates, sub-threshold scores, or unknown foods return a typed miss with top-k candidates, and the model asks. Portion phrases convert through a per-food portion-alias table — the model never converts "a bowl" in its head (C2). The model proposes strings; it cannot mint a food id. The catalog is the gate.

**get_food_nutrition** — resolves free text; returns food id, per-100g values, allergen tags, match type. Unknown food: typed error observation, never a guess. Read-only.

**query_catalog** — the model supplies template id and parameters; the executor validates (typed date ranges; nutrient identifiers as enum-whitelisted parameters interpolated server-side from reviewed code) and renders reviewed SQL. Seven templates cover the eval-implied load: single food lookup, meal summary by range, daily totals, weekly totals, daily average over range, range comparison with the difference as an observed column, top-k by nutrient. Each template declares a result schema with unit-bearing column names, so the numeric gate and the scorer parse known shapes (C3). Execution runs under a SELECT-only role on whitelisted views with statement timeout, row cap, and single-statement rule — the substrate beneath the template boundary, catching bugs *in* the boundary. Malformed SQL is unrepresentable; an invalid template call returns a typed error observation listing the catalog, and the model retries within budget. The user id is never a model-fillable parameter; the executor binds it from the authenticated session.

**log_meal** — proposes only. Resolves entities, computes nutrition server-side, stores an immutable proposal, and emits the write-proposal terminal event showing resolved entities ("2 large eggs, 100 g, 143 kcal — confirm?"). Commit happens only through the confirmation short-circuit, by proposal id, through a scoped writer role. The user confirms stored bytes, not a regeneration.

Write trust model, one sentence per layer: the constraint layer (allergies, medications) has no agent write path at all — the validated profile API is the only door, and the invariant lives in this document so no later phase adds a profile tool without tripping over the reasoning; the meal ledger accepts writes only from confirmed proposals; nothing mutates autonomously. Relaxation is data-gated: when the event log shows a near-zero edit rate on exact-match proposals with explicit logging intent, those writes may go autonomous. Fuzzy-resolved writes stay confirmed permanently — a 300k-food space makes fuzzy resolution riskier, not safer.

### Gates

Four checkpoints in firing order. All deterministic (C3). Every checkpoint emits a gate-verdict event: check name, evidence, verdict.

**Input gate** — fires before the first model call. Fetches the authenticated user's constraints; runs the resolver's entity-level conflict scan on the utterance. On a hit it injects a directive: refuse-and-cite for prescriptive asks ("should I eat shrimp" against a shellfish allergy), advise for descriptive mentions ("log the shrimp I ate"). Detection is deterministic; framing and explanation belong to the model. This gate steers and never blocks alone. It exists because the constrained eval category must not depend on the model noticing the pinned profile.

**Tool gate** — fires at every dispatch. Schema validation, catalog membership (no minted ids), enum whitelists, role enforcement. Failures become typed error observations the model reacts to; only infrastructure faults terminate the turn.

**Output gate** — fires on the buffered typed output before release. Four checks. (a) *Entity:* recommendation FoodRefs' allergen tags must not intersect profile allergies; no high-severity drug conflicts; a food without a reviewed tag row is not recommendable — empty tags would pass vacuously, so missing tags fail closed (C1). (b) *Numeric provenance:* every unit-attached quantity in prose must match an observation value after unit normalization and rounding tolerance; the no-arithmetic contract already pushed all derivation into observations, so no math is needed at check time (C2). (c) *Advisory structure:* any conflict detected at input or present in proposal entities requires an advisories entry citing the matching rule id — "advisory in prose" becomes checkable (field present, rule id valid) instead of a fuzzy prose judgment. *(New check — completes Round 1b's advisory promise structurally.)* (d) *Lexical backstop:* word-boundary substring scan with synonym expansion for foods mentioned in prose without tool grounding. Any violation: append it as feedback, regenerate (max two), then the deterministic refusal template.

**Commit gate** — structural, not a scan. Mutations occur only inside the confirmation short-circuit, by proposal id, through the writer role. No code path leads from model output to a database write.

### Memory

Four stores, all Postgres.

**Profile constraints** — append-only versioned rows with validity intervals. Reads: current constraints, and constraints as of a past turn — both one predicate on rows; a graph adds joins for questions nobody asks. Writes: the validated user API only.

**Meal ledger** — append-only rows carrying food id, grams, match type, source proposal id, timestamps. Writes arrive only from committed proposals. Semantics are descriptive, not prescriptive: the ledger records what the user ate, so a truthful record containing an allergen is correct. The acceptance scenario's "不含过敏原" binds the recommendation surface, not the ledger — blocking a truthful write yields a tracker that refuses to track.

**Proposals** — immutable content; states: proposed → committed | voided | superseded | expired. Edits supersede; commits reference stored bytes.

**Reference data** — food catalog, allergen tags, aliases, portion aliases. Snapshot-versioned, user-independent, read-only at runtime.

No free-text episodic memory. No eval category demands it, constraints and behavior already live in structured form, and prose memories add prompt-injection surface.

### Observability

Two layers: the per-turn typed event stream — the seam's output — and an append-only per-session log. The envelope carries a schema version; scorers and training pipelines break silently on drift, so the version field is not optional.

Event vocabulary: turn start (user, profile version, catalog snapshot version, context digest, input kind); model call (tokens, latency, cost); tool call and tool result at full fidelity — context received the capped rendering, the trace gets everything; gate verdict; clarification request; write proposal, write committed, proposal voided or superseded; final (the typed output); stop reason, with budget exhaustion and no-template refusal as distinct typed reasons.

The scorer consumes the per-turn stream only: must-call-tools, must-not-contain, should-ask-clarification (a distinct event type from write proposals, so confirmations never false-positive as clarifications), should-be-blocked as a direct gate-verdict lookup, and must-propose-write on resolved entities.

NutriMind RL consumes the session logs: full-fidelity observations, verdicts and terminal outcomes as reward-signal candidates, token and cost fields for efficiency shaping. Export passes an anonymization and consent gate — meals plus medications are sensitive.

Three metrics hold standing decision jobs: proposal edit rate per match type (write-autonomy trigger), no-template stop rate (catalog-growth trigger), and lexical-backstop hits that passed the entity gate (semantic-gate trigger). Each out-of-scope item below points at one of these instruments.

### Data Pipeline

USDA FoodData Central is an ingestion source, not a runtime dependency. *(New decision — the briefing implied a runtime API swap.)* Snapshot ingestion feeds the local tables: per-100g values in unit-bearing columns → human-reviewed allergen tags against the FDA big-9 → alias table → portion-alias table → resolver. The runtime never calls USDA. Three constraints force this: C2 needs stable ground truth for provenance matching, C3 needs network-free deterministic turns, and the briefing's own risk register names USDA reliability and unknown rate limits.

Coverage: the curated ~50-food set ships as the first snapshot through the same pipeline shape. Ingestion may then outpace tag review, because untagged foods are loggable — the user asserts what they ate — but never recommendable (fail closed). Tag review throttles the recommendation surface, not catalog size; the bounded, auditable table stays bounded and audited.

Freshness: nutrition facts move on the scale of years. Quarterly snapshot refresh with tag re-review. The catalog snapshot version pins per release and lands in every turn-start event, so any trace reproduces against its data.

### Multi-User

Authenticated identity enters the turn once, at the seam. Profile fetch, executor binding, proposal scoping, and event-log keying all derive from it. The user id is never a model-fillable parameter, which makes cross-tenant queries unrepresentable — the unmintable-food-id principle applied to identity. Another user's constraints are the wrong gate inputs, so isolation is a safety property, not only a privacy one (C1).

Defense in depth: row-level security on user-scoped tables beneath the executor binding. The turn path touches the database only through least-privilege roles — the read role for catalog queries, the scoped writer for commits and proposal transitions. The unrestricted role exists in migrations only.

Sessions: conversation state, pending proposals, and event logs key per session under the user. Traces carry PII — meals, medications — so trace access scopes to the owning user, and the RL export path runs through the anonymization gate.

## Testing Decisions

A good test drives the seam with a scripted model adapter, fake ports, and a fixed clock, then asserts only on the typed event stream. No prose matching — prose assertions rot when the model changes; event assertions survive. No reaching into internals — if a behavior matters, it is an event.

Two modes, one seam. Scripted mode gates CI and tests the *harness*: gates fire, budgets hold, invalid template calls surface as observations, nothing commits without a confirmation event. Zero network, zero LLM cost, zero flake (C3). Live mode runs nightly against the real model and tests *compliance*: the model calls tools, heeds directives, respects the output contract. Live results feed dashboards, never CI gates. The bare-versus-harness dual run continues as the value measurement — the same cases through a toolless baseline quantify what the harness buys.

Below the seam, golden suites pin the pure substrate: resolver cascade (exact, alias, fuzzy threshold, miss candidates), template rendering with declared result schemas, gate verdict tables, portion conversion. A contract test pins gate purity — typed verdicts, no harness imports — keeping the extraction seam honest until a standalone verifier ever cashes it in.

The eval dataset keeps its five failure-mode categories (simple, constrained, numeric inducement, cross-domain drug-nutrient, edge cases) and grows three case families: proposal correctness (must-propose-write on resolved entities, commit only after confirmation, edit supersedes), budget exhaustion, and no-template refusal. Each case pins expected events.

Prior art to follow: the CodeScorer's assertion style over trace events, the injectable clock/store/adapter ports already present, the dual-runner comparison, and the categoried dataset shape. The harness was born testable; the seam formalizes it.

## Out of Scope

- **Knowledge RAG** (NIH/USDA corpus) — richness, not correctness; no safety property depends on it. In scope: Phase 5, on user-visible answer-quality demand.
- **Context compaction** — observation caps suffice at eight steps. Phase 5, on context telemetry.
- **Autonomous writes for exact-match proposals** — Phase 5, when edit rate per match type reads near zero. Fuzzy-resolved writes: never autonomous.
- **Free-SQL fallback under role grants** — likely never: template velocity outruns query diversity on a three-table schema, and free SQL launders plausible-wrong queries through clean execution. Reconsider only on sustained no-template rate.
- **Semantic output gating beyond the lexical backstop** — Phase 5, if backstop hits that passed the entity gate prove material.
- **Token or sentence streaming** — mutually exclusive with retraction-safe gating; Phase 5 lookahead-buffer experiment, gated on latency telemetry.
- **Multi-model routing and fallback provider** — the adapter port makes the swap cheap and deterministic gates make it safe; Phase 5, on availability breach.
- **Episodic free-text memory** — no consumer, added injection surface; no phase until a concrete consumer exists.
- **Photo input, Chinese cuisine coverage, on-device inference, multi-agent topology** — never; briefing non-goals, and on-device belongs to NutriMind.

## Phases

Dependency-derived; the PRD's M-boundaries do not survive contact with the seam.

**Phase 0 — Seam and vocabulary.** Scope: schema-versioned event envelope, tagged turn input, ports, turn skeleton, scripted-model fixture, scorer over events. Gate: one scripted utterance turn and one scripted confirmation turn run in CI with zero network, scored on events alone. Position: the instrument precedes the experiment — every later phase's gate condition is an event assertion (C3).

**Phase 1 — Grounding substrate.** Scope: local catalog (curated seed via the USDA snapshot pipeline), reviewed allergen tags, alias and portion tables, resolver cascade, template catalog with enum interpolation, least-privilege read role, executor-bound identity. Gate: golden suites pass and the tag coverage report shows every catalog food reviewed or marked non-recommendable. Position: gates check structure against this ground truth (C1, C2), so the truth must exist before the checks that consume it.

**Phase 2 — Gated read path.** Scope: input gate and directives, tool gate wiring, all four output checks, regenerate-then-refuse, two-region context with observation caps, buffered release with step-event streaming. Gate: scripted eval passes all four read categories and every should-be-blocked case shows a blocking verdict event. Position: the read path is the recommendation surface — C1's injury channel — and fixtures seed the ledger, so summaries test before logging ships.

**Phase 3 — Write path.** Scope: proposal store and state machine, write-proposal terminal event, confirmation short-circuit committing by id through the writer role, supersede-on-edit, ledger lineage, edit-rate metrics. Gate: the proposal case family passes and no trace shows a mutation without a preceding confirmation event. Position: writes consume the resolver and the event vocabulary, and the ledger matters only once the read path can query it.

**Phase 4 — Surfaces and tenancy.** Scope: web chat driving the seam, step-event streaming, confirm/edit UI, profile management as the sole constraint write path, auth, row-level security, per-session trace scoping, nightly live eval. Gate: adversarial cross-tenant template attempts return nothing by construction, profile changes appear only via the validated path, and the nightly live run is green. Position: the seam already proved behavior headlessly, so surfaces add reach rather than logic, and tenancy hardening binds to sessions that exist only with a surface.

**Phase 5 — Metric-gated extensions.** Scope: the out-of-scope pool. Gate: each admission cites its recorded trigger and event-log evidence. Position: contingent work sequences after the instruments that decide it, and Phases 0–4 install exactly those instruments.
