# Prompt 3 — Issue Breakdown

You have `docs/ARCHITECTURE.md` — the Architecture Decision Document from Prompt 2. It contains the safety thesis, module designs, testing seam, and phased execution order. Do NOT re-litigate architecture decisions. The architecture is decided.

Your job: **break the first phase into independently-grabbable issues using tracer-bullet vertical slices.**

## Step 0 — Prefactoring

Identify changes that make the implementation easier but add no user-facing behavior. "Make the change easy, then make the easy change."

Prefactoring candidates:
- Interfaces that need to be extracted before new code can sit behind them
- Type definitions that need to be widened before new variants can exist
- Test infrastructure that needs to exist before features can be verified

Each prefactoring issue must state: what exists now, what changes, and which subsequent issue it unblocks. If no prefactoring is needed, say so and move on.

## Step 1 — Vertical Slices

Each issue is a **tracer bullet**: a thin vertical slice through ALL integration layers — schema, logic, events, eval assertions — that is demoable or verifiable on its own. NOT a horizontal layer ("build the resolver", "build the gate").

A vertical slice rule: if an issue touches only one module, it's a horizontal layer — split it wider or merge it with the layer above or below.

## Step 2 — Draft the Issue List

For each issue:

- **Title**: short descriptive name, no tags in the title
- **What to build**: end-to-end behavior. What the user or eval sees when this ships. No file paths, no code snippets.
- **Acceptance criteria**: checkbox list. Each criterion testable with a yes/no.
- **Blocked by**: which other issues must complete first, or "None — can start immediately."

## Step 3 — Quiz the User

Present the breakdown as a numbered list. For each slice show: title, blocked by, and the first acceptance criterion (abbreviated).

Ask:
- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?

Iterate until the user approves.

## Step 4 — Publish

Once approved, output the final issue list in dependency order (blockers first). Each issue in the template from Step 2, now with full acceptance criteria.

## Constraints

- Single developer.
- No file paths. No code snippets. They go stale.
- Acceptance criteria must be checkable with a yes/no. "System is fast" is not a criterion.
- If two issues share a test, merge them.
- Blocked-by references must use the issue titles from this breakdown, not external references.
- Prose: declarative. No passive voice. No hedging.
