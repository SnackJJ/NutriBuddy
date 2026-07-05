# Prompt 2 — Implementation Plan

You have three artifacts:

1. `docs/BRIEFING.md` — project snapshot (current code, gaps, risks). Ignore its M1/M2/M3 milestone structure — those were defined before the architecture was refined.
2. Round 1 output — provenance-first harness design (model narrates; tool layer asserts facts; gates check structure, not prose)
3. Round 1b output — three deepened decisions (in-tool resolver, propose/commit writes, parameter templates + role grants)

Your job: **design the implementation plan from scratch.** Define your own phases based on dependency order and the architecture's safety thesis. Do not inherit the PRD's milestone boundaries.

## Part 1 — Full Architecture Target

Describe the end-state architecture. This is the blueprint everything below builds toward. Cover:

- **Loop** — control flow, step budget, how tools and gates interleave
- **Context** — what lives in pinned vs. dynamic regions, compaction strategy, cross-turn memory
- **Tools** — full tool set, how each is constrained, which have write paths and under what trust model
- **Gates** — all checkpoints, their ordering, what each gates on, failure behavior
- **Memory** — all stores, their schemas, read/write access patterns, versioning
- **Observability** — event types, trace format, what the eval scorer consumes vs. what feeds NutriMind RL
- **Data pipeline** — USDA API → food table → resolver → gate. Data freshness and coverage strategy.
- **Multi-user** — auth, session isolation, profile scoping

One paragraph per bullet. Tight.

## Part 2 — Phased Execution

Define your own phases based on dependency order and architectural risk. Do not reference M1/M2/M3 unless a phase genuinely matches one.

Principles:
- Safety-critical infrastructure ships before features that depend on it.
- Each phase extends the previous without breaking its contracts.
- Phases are sized so each one delivers a testable, runnable system.

For each phase:

- **Scope** — what gets built. List concrete issues for the first 1-2 phases; architectural direction for later phases.
- **Gate condition** — "Phase N is done when..." Specific and testable.
- **Why this phase, in this position** — one sentence justifying its place in the order.

### Issue format (for concrete phases)

Each issue: one clear outcome, one session to complete, independently testable. Tagged: `[harness]`, `[infra]`, `[eval]`, `[ui]`, `[integration]`.

## Part 3 — Transition Contracts

List the interfaces, event types, and data schemas that span multiple phases. For each: state what the earliest phase must get right so later phases don't pay rewrite costs.

Examples of what to look for:
- Trace event envelope — schema version field
- Gate verdict interface — typed, pure, no harness imports
- Food table schema — allergen tags as columns
- `write_proposal` event type — distinct from `clarification_request`
- Template executor interface — `{template_id, params}` contract

For each: "Phase X must Y, or Phase Z will require W."

## Part 4 — Risk Map

Flag the 5 highest-risk items across the full plan. For each: which phase, what makes it risky, the failure mode, and a mitigation.

## Constraints

- Define phases from dependency order, not from a pre-existing milestone document. If the PRD's M1/M2/M3 happens to match, fine — but derive it, don't inherit it.
- Concrete-phase issues must be independently testable. Merge issues that share a test.
- Later-phase direction can be coarser — architectural decisions with key tradeoffs, not per-issue breakdowns.
- No issue titled "Refactor X" without a concrete before/after.
- Single developer.
- If a later-phase decision depends on data collected in an earlier phase, state the measurement explicitly in the earlier phase's issues.
- Prose: declarative sentences. No passive voice. No hedging.
