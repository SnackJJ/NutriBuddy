# Prompt 1 — Harness Architecture Design Review

Read `docs/BRIEFING.md`. It describes NutriBuddy — a personal nutrition advisor agent application. Absorb the problem constraints: what kind of queries users ask, what safety guarantees are required, what data sources exist, what the eval framework demands.

Then do the following.

## Part A — Design Your Own Harness

Forget the existing architecture described in BRIEFING.md §2. Start from scratch.

Given this application's requirements, design the agent harness you would build. Cover at minimum:

- **Loop** — What control flow? ReAct? Plan-then-execute? Something else? How do tool calls and model reasoning interleave?
- **Context** — How is the context window assembled? What is pinned vs. dynamic? How do you handle growth across turns?
- **Memory** — What does the system remember across sessions? How is it stored? How is it retrieved and injected?
- **Tools** — How are tools defined, dispatched, and constrained? What safety boundaries exist at the tool layer?
- **Safety gates** — Where do they sit? What do they check? How do they interact with tool execution?
- **Observability** — What gets logged? At what granularity? What does the eval system consume?

For each: state what you chose, and **why this specific shape fits NutriBuddy's constraints**. Reference concrete properties of this application — "because the user may have a shellfish allergy" is a good reason. "Because it's best practice" is not.

## Part B — Compare Against the Existing Design

Now compare your design against the existing architecture in BRIEFING.md §2.

For each module where your design differs from the existing one:
1. State the difference concretely.
2. Argue which choice is better for NutriBuddy. If yours is better, explain why. If the existing design is better, concede and explain what you missed.
3. If the existing design is better for M1 (speed/simplicity) but yours is better for M2-M3 (scale/coverage), say so explicitly — and suggest when the switch should happen.

If your design is identical to the existing one on a module, say so and move on. Do not pad.

## Part C — Re-evaluate the Existing Decisions

BRIEFING.md §4 lists 8 design decisions. After designing your own harness and comparing, pick the 3 decisions where your thinking diverges most from the author's. For each: state the decision, your position, and the strongest argument the other side could make against you.

## Constraints

- Part A must be grounded in NutriBuddy's actual constraints. Every design choice must cite a concrete requirement from BRIEFING.md.
- Do not critique the implementation gap (§3.2). The question is whether the *architecture* is right, not whether it's built yet.
- Prose: short sentences, no hedging, no passive voice. If you agree, say "Agree." If you disagree, say "Wrong — " and state why.
