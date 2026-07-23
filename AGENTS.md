# NutriBuddy — Agent entry (always-on)

> **Single always-on file.** `CLAUDE.md` points here. Do not maintain a second status log.

## Authority (conflict order)

1. `docs/ADD.md` — architecture source of truth  
2. `docs/adr/*` — irreversible decisions  
3. `CONTEXT.md` — domain glossary only  
4. This file — principles, next work, read policy  

Product prose in `docs/PRD-v2.md` is **context, not architecture**. It never wins over ADD.

## Principles (stable)

- **Harness first**: own loop / context / memory / verification / trace; libraries only fill pipes (model call, vectors, rerank).
- **Out of scope**: LangGraph/CrewAI-style frameworks; photo logging; native app (early); on-device inference / RL (→ NutriMind).
- **Stack**: TypeScript; Next.js + Supabase + self-built harness.
- **Topology**: single agent. Model chooses and narrates; facts / numbers / entities / writes are defined and checked by deterministic code.
- **Test seam**: one `turn` boundary — tagged input + injected ports → schema-versioned event stream → exactly one terminal event.
- **Loop**: ReAct + typed query catalog (template id + typed params). No free-form SQL; no mental nutrition arithmetic.
- **Data**: USDA FoodData Central as **snapshot ingestion**; runtime reads local catalog. Knowledge RAG deferred (metric-gated).

## Next (product surface)

Keep this list short. Prefer GitHub issues as the live backlog.

1. 交付形态与上线（`docs/adr/0002`）：#82 关闭匿名通道、#83 PWA + confirm/edit UX  
2. Nightly live eval thickening  
3. Remaining debt: drop derived `toolResult` after UI migration (RFC 0002 §2.6); TraceEvent debug-only  

Do **not** confuse ADD product Phase 0–4 with structural RFC phases (already landed).

## Commands

```bash
npm test                 # vitest (excludes .sandcastle)
npm run typecheck
npm run smoke:confirm    # live Supabase confirm/void (needs .env.local)
npm run eval
```

## What to read

**Default (cold start):** this file + `CONTEXT.md`. Open `docs/ADD.md` when architecture or seam behavior is in play. Open an ADR only if it touches the area.

**On demand (ticket / path must name it):**

| Path | Role |
|------|------|
| `docs/PRD-v2.md` | Product goals / old milestone color |
| `docs/rfc/*` | Design notes; **status is declared in each RFC header** (`Proposed` / `Accepted` / `Implemented`). Structural RFCs 0001–0003 landed; later product RFCs may still be open. |
| `docs/agents/*` | Tracker / triage / domain-doc **how-to** for Matt skills |

**Do not load unless the task explicitly needs them:**

- `docs/archive/**` (including old PRD v1, briefings)
- `docs/research/**`
- `docs/reviews/**`
- Full text of Implemented RFCs “just in case”

## Doc lifecycle (prevent re-sprawl)

| Kind | When active | After done |
|------|-------------|------------|
| ADD / ADR / `CONTEXT.md` | Always the stable SoTs | Update in place; don’t fork |
| RFC | Status `Proposed` / `Active` only | Mark `Implemented`; **remove from this entry’s pointers** |
| Research / review | Input to a decision | Stay cold under `docs/research` / `docs/reviews` |
| PRD | Product narrative | Never always-on; never beats ADD |
| Status / changelog | Prefer issues + git | Not a second AGENTS body |

If you write a long design note, either it becomes an ADR/RFC with a status, or it goes to archive/research—not a third always-on truth.
