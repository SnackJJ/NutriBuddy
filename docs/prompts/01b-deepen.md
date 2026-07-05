# Architecture Deepening

Round 1 produced a provenance-first harness design with a typed-output safety layer. Three load-bearing design questions were skipped or only grazed. Resolve each with a concrete recommendation and the reasoning behind it.

## Q1 — Food Normalization: Pre-loop or In-loop?

PRD §3.3: user says "a bowl of rice" → `normalize_food` → `{food: "rice, white, cooked", portion_g: 150}`. This function sits at the system's entry bottleneck — wrong parse, wrong answer.

Two placements, different failure modes:

**Pre-loop (deterministic pipeline before context assembly).**
- Pro: does not consume step budget. Failure → clarification request, no loop started.
- Con: deterministic matchers fail on "a bowl of that stuff I ate yesterday." Any LLM involvement makes it stochastic — and then the pre-loop step has its own hallucination problem with no gate upstream of it.

**In-loop (tool call within the agent's step budget).**
- Pro: the model can disambiguate interactively ("did you mean cooked white rice or brown rice?").
- Con: costs a step. Ambiguity resolution + actual query may push a simple case past the step cap. And if `normalize_food` fails, the loop has no fallback tool.

Questions to resolve:
1. If pre-loop: is `normalize_food` deterministic or LLM-assisted? If LLM-assisted, how is its output gated?
2. If in-loop: does it count against MAX_STEPS? Does a normalization failure count as a tool error that terminates the turn, or does the loop recover via clarification?
3. Is there a hybrid: deterministic pre-scan for exact USDA name matches, fallback to in-loop fuzzy resolution for unknowns?

Make a recommendation. Do not enumerate both sides without picking one.

## Q2 — The Write Trust Model

Round 1 established that the constraint layer (allergies, medications) has no agent write path — profile changes go through a validated user API only. That covers `user_profile`.

`log_meal` is a **tool the agent calls autonomously**. The agent decides when to log a meal, what food name to use, and what portion size to write. The post-gate cannot un-write a database row.

Three trust models, pick one:

**A — Trust the agent, harden detection.** Agent calls `log_meal` freely. Gate checks happen after. If a violating meal was logged, the system detects it post-hoc (a meal containing an allergen food_id) and surfaces it to the user. Write-safety is eventual, not transactional.

**B — User confirmation for all writes.** Every `log_meal` call requires explicit user confirmation before executing. The tool returns a proposed entry; the loop pauses; the user approves or rejects. No write path is fully autonomous.

**C — Write gate with rollback capability.** Agent calls `log_meal` freely. The safety gate runs before the response is released. If the gate blocks, the meal log entry is deleted or marked as voided. Requires a transaction or soft-delete pattern.

Questions to resolve:
1. Does model B break the eval's measurement model? If `shouldAskClarification` is a passing criterion, confirmation prompts may look like clarification to the scorer.
2. Does model C create a new failure mode — gate blocks, delete succeeds, user never sees the blocked meal, but the delete log entry is itself a data leak?
3. What does the M1 acceptance scenario in PRD §6 actually demand? The scenario says "不含过敏原" — does that mean the write must also be clean, or only the visible answer?

Make a recommendation. State which model and why it fits NutriBuddy's specific constraints.

## Q3 — CodeAct SQL Template Design

Round 1 called CodeAct "load-bearing for C2" — it pushes arithmetic into grounded SQL so the numeric gate has an observation to check against. Good. But "SQL via templates" is a spectrum, not a single design.

Three points on that spectrum:

**A — Parameter-only templates.** Each query shape is a pre-written SQL string with `$1, $2` placeholders. The model picks a template and fills parameters. `SELECT SUM(protein_g) FROM meal_logs WHERE user_id = $1 AND logged_at >= $2`. Safety is structural: the model cannot add columns, join tables, or compose expressions.

**B — Role-gated free SQL.** The model writes arbitrary SELECT statements. Safety is enforced at the database layer: a Postgres role with SELECT-only grants on whitelisted views, statement timeout, row limit, single-statement rule. The model can compose queries you didn't anticipate, but it cannot mutate, DOS, or exfiltrate.

**C — Hybrid with fallback.** Start with template A. If no template matches (the model signals "none of the above"), fall back to B with role enforcement. The model gets template safety in common cases and composition power in novel ones.

Questions to resolve:
1. At ~4 query shapes for M1 (single food lookup, meal log summary by date range, daily totals, weekly totals), is the template catalog small enough that A covers everything, or is there already a query shape that needs composition?
2. Model B's role enforcement requires a separate Supabase connection with restricted grants. Is that infrastructure complexity worth it for M1, or is it a clear M2 boundary?
3. If the model generates malformed SQL under B, does the error become an observation (model can retry) or a turn-terminating failure?

Make a recommendation. State the template design and where the SQL safety boundary sits.

## Constraints

- Each answer must be a decision, not a survey. "It depends" is a non-answer. Pick and defend.
- Ground every recommendation in NutriBuddy's specific constraints (C1-C3 from Round 1, plus the PRD M1 acceptance scenario).
- If your recommendation contradicts something from Round 1 Part A, say so explicitly and explain the revision.
- Prose: declarative sentences. No passive voice. No hedging.
