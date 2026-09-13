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
- **Data**: USDA FoodData Central as **snapshot ingestion**; runtime reads local catalog. Knowledge RAG: `docs/adr/0004` (Proposed) brings it **into scope as an evidence layer only** — it never supplies numbers, entities, or writes; retrieval itself lands in V1.1.

## Next (V1.0 — plan in `docs/rfc/0007`)

Keep this list short. Prefer GitHub issues as the live backlog. (#82 / #83 landed; the previous list here was stale.)

1. **S1 — 轨迹持久化与 turn 重放**（`docs/rfc/0008`）：路径上的头号阻塞项 —— 审计 / 回放 / 归因 / RL 资产全挂在它上面。**T1–T5 已落地**（迁移 0011、TraceStore 端口、`turn()` 接线与终态语义、`SupabaseTraceStore`、失败语义测试）；剩余 #89（`turn_meta` + 客户端 `lastSeq` + 重放接口）、#91（查询面）、#120（迁移 0014）、#122（90 天保留）、#124（D9 越权 smoke）
2. **S2 — 评测报告与成本/延迟聚合**（`docs/rfc/0009`）：产出可复现的数字与回归基线
3. **S3 — 费用闸、配额与白名单登录**（`docs/rfc/0010`）；**S4 — 依据层**（source registry + 引用检查，`docs/rfc/0011`，前置 `docs/adr/0004` 接受）
4. **S5 — 上线收尾**：部署、README、隐私与数据删除路径、`version` + tag

S1 的迁移改动带两个必须先满足的前提：本地重放依赖 Supabase 本地栈（`docs/rfc/0007` D2 与 `scripts/verify-migrations.sh`），而 `supabase/config.toml` 的 `major_version` **尚未**与 hosted 项目核对（见该文件内注释，归 #113 前闭合）。

Nightly live eval thickening and dropping derived `toolResult` after the UI migration (RFC 0002 §2.6) stay open; TraceEvent stays debug-only.

Do **not** confuse ADD product Phase 0–4 with structural RFC phases (already landed).

## Commands

```bash
npm test                 # vitest (excludes .sandcastle)
npm run typecheck
npm run verify:migrations # 空库重放检查（需 Docker + psql，会 db reset 本地栈）
npm run smoke:confirm    # live Supabase confirm/void (needs .env.local)
npm run eval
```

## What to read

**Default (cold start):** this file + `CONTEXT.md`. Open `docs/ADD.md` when architecture or seam behavior is in play. Open an ADR only if it touches the area.

**On demand (ticket / path must name it):**

| Path | Role |
|------|------|
| `docs/PRD-v2.md` | Product goals / old milestone color |
| `docs/rfc/*` | Design notes; **status is declared in each RFC header** (`Proposed` / `Accepted` / `Implemented`). Structural RFCs 0001–0003 landed; product RFCs 0006–0012 are `Proposed` (0012 is V1.1) |
| `docs/agents/*` | Tracker / triage / domain-doc **how-to** for Matt skills |

**Do not load unless the task explicitly needs them:**

- `docs/archive/**` (including old PRD v1, briefings)
- `docs/research/**`
- `docs/resume/**` (career / outward-facing narrative — never project context)
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
