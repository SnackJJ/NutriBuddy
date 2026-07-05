# Architecture Decision Document

You have three artifacts:

1. `docs/BRIEFING.md` — project snapshot
2. Round 1 output — provenance-first harness design
3. Round 1b output — three deepened decisions (in-tool resolver, propose/commit, parameter templates + role grants)

**Do NOT interview. Synthesize what you already have.** The three artifacts above contain every decision. Your job is to consolidate them into one clean Architecture Decision Document.

## Step 1 — Identify the Testing Seam

Sketch the highest seam at which the harness can be tested end-to-end. The ideal number of seams is one: a single integration point where the eval system hooks in and a full turn can be exercised deterministically. State it explicitly. This seam drives every implementation decision that follows.

## Step 2 — Write the Architecture Decision Document

Use this template. Every section mandatory.

```
# NutriBuddy — Architecture Decision Document

## Safety Thesis

One paragraph. What does the harness guarantee, and how? State the provenance-first principle:
model narrates, tool layer asserts facts, gates check structure. What C1-C3 entail.

## Architecture

### Loop
Control flow, step budget, tool/gate interleaving.

### Context
Pinned vs. dynamic regions. Growth control. Cross-turn strategy.

### Tools
Full tool set. Per tool: what it does, how it's constrained, write path trust model.

### Gates
All checkpoints in order. Per gate: when it fires, what it checks, deterministic or not, failure behavior.

### Memory
All stores. Per store: schema, read/write pattern, versioning.

### Observability
Event types. Trace format. What the eval scorer consumes vs. what feeds NutriMind RL.

### Data Pipeline
USDA API → food table → resolver → gate. Coverage and freshness strategy.

### Multi-User
Auth, session isolation, profile scoping.

## Testing Decisions

- What makes a good test for this harness
- Which modules are tested and at what seam
- Prior art in the codebase to follow

## Out of Scope

What this architecture deliberately does NOT cover. Each item tagged with the phase
where it becomes in-scope.
```

## Step 3 — Assign Phases

Group the architecture into phases based on dependency order. Do not inherit the PRD's M1/M2/M3 boundaries. Derive your own.

For each phase: a one-line scope, a gate condition, and one sentence justifying its position in the order.

## Constraints

- No file paths. No code snippets. They go stale.
- Every architecture decision must trace to a concrete constraint (C1-C3) or an eval category from BRIEFING.md.
- "Best practice" is not a reason. "Numeric gate can't verify query-matches-intent under free SQL" is a reason.
- Prose: declarative. No passive voice. No hedging.
