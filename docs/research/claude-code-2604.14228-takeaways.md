# Claude Code Architecture Takeaways for NutriBuddy

> Research note: 2026-07-20  
> Source: Liu et al., *Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems*, arXiv:2604.14228v2 (2026).  
> Scope: What Claude Code's engineering design validates, what NutriBuddy already has, what to borrow, and what to reject.  
> Conflicts resolve in favor of `docs/ADD.md`.

---

## Executive Summary

Claude Code's production shape is **a thin while/ReAct loop plus a thick deterministic harness** (permissions, compaction, tools, persistence). NutriBuddy already sits on the same design point: single `turn()` seam, model chooses among options deterministic code defines, gates and confirm short-circuit own safety.

**Borrow:** reversibility-weighted risk, denial-as-routing-signal, tool-pool pre-filtering, append-only + projection separation, silent-failure metrics closed loop.  
**Do not borrow:** ML permission classifiers, multi-agent topology, MCP/plugins/skills stack, five-layer compaction, user-level "bypass safety."

Domain difference binds the rest: Claude Code's scarce resource is **context**; NutriBuddy's is **correctness under C1/C2/C3** (injury, numeric provenance, deterministic eval).

---

## 1. Paper Snapshot

### 1.1 Core claim

The agent loop is simple (`queryLoop`: assemble context → call model → permission → execute tools → continue). Most of the system is **around** the loop:

| Surrounding system | Claude Code choice |
| ------------------ | ------------------ |
| Safety | Seven permission modes; deny-first rules; optional ML auto-mode classifier; shell sandbox; hooks |
| Context | Five-layer pre-model shapers (budget → snip → microcompact → collapse → auto-compact) |
| Extensibility | MCP, plugins, skills, hooks (four mechanisms at different context costs) |
| Delegation | Subagents with isolated context; summary-only return to parent |
| Persistence | Append-oriented JSONL transcripts; resume/fork; session permissions **not** restored on resume |

### 1.2 Five values (paper §2.1)

1. **Human decision authority** — observe, approve, interrupt, audit  
2. **Safety, security, and privacy** — protect even when the human is inattentive  
3. **Reliable execution** — single-turn correctness and long-horizon coherence  
4. **Capability amplification** — invest in operational harness, not decision scaffolding  
5. **Contextual adaptability** — project/tool/convention fit; trust trajectories over fixed trust

### 1.3 Thirteen principles (compressed)

Paper Table 1. The ones that matter most for NutriBuddy:

| Principle | Design question |
| --------- | --------------- |
| Deny-first with human escalation | Unrecognized risky actions: allow, block, or escalate? |
| Graduated trust spectrum | Fixed permission level, or a spectrum users traverse? |
| Defense in depth | One safety boundary, or multiple independent ones? |
| Externalized programmable policy | Hardcoded policy vs hooks/config? |
| Context as scarce resource | Single truncation vs graduated pipeline? |
| Append-only durable state | Mutable state vs checkpoints vs append-only logs? |
| Minimal scaffolding, maximal harness | Constrain model choices, or give a rich operational environment? |
| Values over rules | Rigid procedures vs judgment + deterministic guardrails? |
| Composable multi-mechanism extensibility | One extension API vs layered mechanisms? |
| Reversibility-weighted risk | Same oversight for all actions, or lighter for reversible/read-only? |
| Transparent file-based config/memory | Opaque DB vs user-visible artifacts? |
| Isolated subagent boundaries | Shared vs isolated context/permissions? |
| Graceful recovery | Fail hard vs recover and reserve human attention? |

### 1.4 Three recurring design commitments (paper §12.7)

1. **Graduated layering over monolithic mechanisms** — safety, context, and extensibility are stacks of independent stages.  
2. **Append-only designs that favor auditability over query power** — full history retained; live view is a projection.  
3. **Model judgment within a deterministic harness** — paper cites ~1.6% decision logic vs ~98.4% operational infrastructure (community estimate of extracted source; treat as qualitative, not a hard metric).

---

## 2. Mapping: Claude Code ↔ NutriBuddy

| Design question | Claude Code | NutriBuddy (ADD) |
| --------------- | ----------- | ---------------- |
| Where does reasoning live? | Model; harness executes | Same; **option space** is catalog/resolver/templates |
| How many execution engines? | Single `queryLoop` | Single `turn` / `consumeTurn` |
| Default safety posture | Deny-first + human escalation + layers | Fail-closed gates + **confirm-only writes** |
| Binding resource constraint | Context window | **Safety + code-scorable events** (context secondary) |
| When does a human intervene? | Most side-effecting tools | Write path + fuzzy resolution; recommendation surface auto-blocks |
| Extensibility | MCP / plugins / skills / hooks | Typed query catalog growth; RAG metric-gated |
| State model | Append-only JSONL + projections | Append-only Postgres stores + schema-versioned events |

### 2.1 Already aligned (do not re-implement as "Claude Code features")

| Claude Code idea | NutriBuddy status |
| ---------------- | ----------------- |
| Thin loop, thick harness | `loop.ts` + gates + catalog + confirm |
| No LangGraph-style decision scaffolding | ADD non-goal; libraries fill pipes only |
| Model never authors world facts | Resolver mints food ids; templates compute numbers |
| Human authority on mutations | Proposal → confirm short-circuit (RFC 0001) |
| Layered checks | Input / tool / output / commit gates |
| Full fidelity for eval/trace, capped for model | Observation caps + event stream / Tracer |
| Typed stop / terminal outcomes | Terminal events; RFC 0002 `ToolOutcome` / `reasonCode` |
| Single seam, many surfaces | CLI, web chat, scripted + live eval |

---

## 3. What to borrow

Ordered by **value × fit × cost**. Each item names the ADD/product surface it touches.

### 3.1 Reversibility-weighted risk (high / low cost)

**Paper:** Read-only and reversible actions get lighter oversight; irreversible actions get heavier. Users approve ~93% of permission prompts → interactive confirm is **behaviorally unreliable** as the sole safety mechanism.

**NutriBuddy translation:**

| Action class | Policy |
| ------------ | ------ |
| Catalog reads / summaries | No confirm |
| Exact-match + explicit log intent | Metric-gated autonomy (ADD Phase 5 when edit rate near zero) |
| Fuzzy / multi-candidate / allergen-related | **Permanent confirm** |
| Recommendation surface (entity / allergen / drug) | **Always fail-closed**; never user-bypassable |

**Product implication (Web confirm/edit UX):** Confirm is not Yes/No fatigue UI. It must surface resolved entities, grams, kcal, match type, and any advisories. Defaults bias to safety (void / edit), not blind accept.

### 3.2 Denial as routing signal, not hard crash (high / low cost)

**Paper:** Permission denials return a reason to the model so it revises; only unrecoverable faults abort. Recovery-oriented enforcement *shapes* behavior instead of only stopping it.

**NutriBuddy translation:**

| Failure class | Behavior |
| ------------- | -------- |
| Tool / schema / catalog miss | Typed observation + continue loop (existing) |
| Output gate fail | Feedback + regenerate (max 2), then refusal (existing) |
| Infra / non-serializable outcome | Terminal crash / refusal (RFC 0002) |
| Commit path | **Never** model-regenerated write; confirm short-circuit only |

**Contract:** Every non-infra denial is a scorable event with `reasonCode`. Aligns with C3 and RFC 0002.

### 3.3 Tool-pool pre-filtering (medium / low cost now)

**Paper:** Blanket-denied tools are stripped from the model's tool list at assembly time so the model cannot waste steps invoking them.

**NutriBuddy translation:** Tool count is small (~4–5); still pre-filter by capability:

- No write capability / policy → omit `log_meal` from schemas  
- Future catalog growth → filter **visible templates** by intent/scene rather than inventing a skills system  
- Never expose free-SQL or autonomous mutation tools "for flexibility"

Consistent with `docs/research/agent-tool-design-skills-vs-atomic-tools.md`: under ~10 tools, flat lists win; skills are a context strategy for large catalogs, not a capability upgrade.

### 3.4 Layer independence (high / discipline cost)

**Paper:** Defense in depth assumes **independent** failure modes. Shared performance shortcuts (e.g. collapsing many checks into one prompt) collapse the stack.

**NutriBuddy must keep these orthogonal:**

| Layer | Must not collapse into |
| ----- | ---------------------- |
| Entity existence (resolver) | Model prose claiming a food exists |
| Numeric provenance (observations) | Prose regex as sole gate |
| Allergen / drug rules (deterministic) | LLM safety classifier |
| Commit atomicity (RPC) | Chat UI state machine |

### 3.5 Append-only SoT + live projection (medium / already mostly done)

**Paper:** Transcripts outlive the context window; compaction is a **read-time projection**; resume/fork rebuild from log; **session-scoped trust is not restored on resume**.

**NutriBuddy translation:**

1. Postgres meal/profile/proposal + event stream = stronger append-only than JSONL.  
2. Context assembly may summarize; **never mutate historical ledger or committed proposals in place** (supersede, don't edit bytes).  
3. If session resume ships: do **not** restore "user once approved X so skip confirm."

### 3.6 Silent-failure observability loop (high / medium cost)

**Paper §13.1 / §12.6:** Dominant production failure is not crash but **invisible wrongness**. Industry reports emphasize traces → evals → harness changes.

**NutriBuddy already named the standing decision metrics in ADD.** Make them product/ops real:

| Metric | Decision job |
| ------ | ------------ |
| Proposal edit rate × match type | Gate exact-match autonomous writes |
| No-template stop rate | Grow query catalog |
| Lexical-backstop hits that passed entity gate | Trigger semantic gate work |

**Near-term owner:** nightly live eval + dashboards (product Phase surface work; not structural RFC 0003).

### 3.7 Lifecycle hooks — only as a later policy port (low priority)

**Paper:** 27 hook events; PreToolUse can deny/rewrite; PostToolUse can inject context.

**NutriBuddy stance:**

- **Now:** Hardcoded gates (testable, code-scorable, no combinatorial hook surface).  
- **Later (enterprise policy):** Thin policy ports, not a 27-event bus. Candidate names: `PreCommit`, `PostCommit`, `OnGateFail`.

---

## 4. What not to borrow

| Claude Code feature | Why reject for NutriBuddy |
| ------------------- | ------------------------- |
| ML auto-mode permission classifier | Stochastic safety arbiter conflicts with C1/C3; live eval only, never CI safety boundary |
| Multi-agent / worktree isolation | ADD: single agent; write path needs global constraint consistency |
| MCP + plugins + skills stack | Tool surface &lt;10; expands attack and scoring surface without product need |
| Five-layer compaction pipeline | Out of scope until context telemetry; observation caps + 8-step budget suffice |
| Shell / OS sandbox as primary safety | No shell; wrong threat model |
| User "bypass permissions" modes | Allergen / drug gates must not be user-bypassable |
| Free-form episodic auto-memory | ADD non-goal; injection surface; structured stores only |

---

## 5. Domain binding (do not paper over)

| | Coding agent (Claude Code) | Nutrition agent (NutriBuddy) |
| - | -------------------------- | ---------------------------- |
| Harm if wrong | Broken code, data loss, secrets | Allergen / drug-nutrient injury (C1) |
| Ground truth | Repo + tests + user review | Local catalog + reviewed tags + templates |
| Human vigilance | Habituated approve | Same risk if confirm is Yes-spam |
| Acceptable stochastic layer | Model plans; some safety classifiers | Model **narrates and chooses tools only** |
| Eval | Task pass / user edit | **Code scorer on typed events** (C3) |

Implication: NutriBuddy's harness investment stays on **gates, catalog, confirm, event schema** — not on compaction, skills, or multi-agent orchestration.

---

## 6. Actionable checklist (next product steps)

Tied to current status (2026-07-20): structural phases done; next is Web confirm/edit UX + nightly live eval.

1. **Confirm UX** — Grade by match type / allergen / drug; show resolved entities and numbers; anti-blind-approve defaults.  
2. **Denial completeness** — All recoverable failures emit `reasonCode` events (RFC 0002 continuity).  
3. **Tool visibility** — Capability-based schema filtering (tiny change, permanent principle).  
4. **Three metrics in nightly live** — edit rate, no-template rate, backstop leakage.  
5. **Hard no** — LLM permission classifier, multi-agent, general hooks framework without a measured gap.

---

## 7. One-line synthesis

> Production agents win as **thin decision loops inside thick deterministic harnesses**. NutriBuddy already chose that shape; Claude Code validates the bet. Borrow **risk grading, recoverable denials, audit projections, and silent-failure metrics** — not coding-agent extension surface or model-as-safety-judge.

---

## References

- Liu, Zhao, Shang, Shen. *Dive into Claude Code…* arXiv:2604.14228v2, 2026. <https://arxiv.org/abs/2604.14228>  
- Companion repo (paper authors): <https://github.com/VILA-Lab/Dive-into-Claude-Code>  
- NutriBuddy SoT: `docs/ADD.md`  
- Related research: `docs/research/agent-tool-design-skills-vs-atomic-tools.md`  
- Confirm safety: `docs/rfc/0001-phase1-confirm-safety.md`  
- ToolOutcome: `docs/rfc/0002-tool-outcome.md`
