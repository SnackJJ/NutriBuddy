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

Keep this list short. Prefer GitHub issues as the live backlog.

1. **S1 已收口**（`docs/rfc/0008`）：T1–T9 全部落地（迁移 0011/0014、TraceStore 端口、`turn()` 接线、`SupabaseTraceStore`、重放路由、导出 `scripts/export-traces.mts`、保留 `scripts/prune-traces.ts`、D9 smoke）。两处仍未闭合、已留在票上：D4 的**真人刷新验证**（仓库无 jsdom，见 `docs/reviews/2026-09-13-s1-turn-replay-review.md`）与 `supabase/config.toml` 的 `major_version` 与 hosted 核对（归 #113）。
2. **S2 — 评测报告与成本/延迟聚合**（`docs/rfc/0009`）：已落地 —— `npm run eval:report` 产出 `reports/<reportId>/{report.md,summary.json,cases.json}` + `reports/index.json`（记 gitSha/appVersion/catalogVersion/datasetHash/n），`--compare <reportId>` 按阈值标倒退，`--traces` 把轨迹的延迟/成本并进来
3. **S3 — 费用闸、配额与白名单登录**（`docs/rfc/0010`）：代码侧已落地（配额纯函数 `src/lib/quota.ts`、`turns` 聚合、429 前置、最坏成本预估、UI 隐藏注册、拒绝日志）；运维人工步骤（关闭公开注册、provider 消费上限、Production-only 密钥）见 `docs/ops/v1.0-operations.md`，**尚未执行**；**S4 — 依据层**（source registry + 引用检查，`docs/rfc/0011`，前置 `docs/adr/0004` 接受）
4. **S5 — 上线收尾**：部署、README、隐私与数据删除路径、`version` + tag

S1 之后的迁移前提不变：本地重放依赖 Supabase 本地栈（`docs/rfc/0007` D2 与 `scripts/verify-migrations.sh`），该脚本现在同时断言 0011 与 0014 的 grant / 策略 / 索引前提。

Nightly live eval thickening and dropping derived `toolResult` after the UI migration (RFC 0002 §2.6) stay open; TraceEvent stays debug-only.

Do **not** confuse ADD product Phase 0–4 with structural RFC phases (already landed).

## Commands

```bash
npm test                 # vitest (excludes .sandcastle)
npm run typecheck
npm run verify:migrations # 空库重放检查（需 Docker + psql，会 db reset 本地栈）
npm run smoke:confirm    # live Supabase confirm/void (needs .env.local)
npm run smoke:trace      # D9: trace write door closed + cross-account reads (needs .env.local)
npm run export:traces    # 轨迹导出（--turn / --user+--date；默认脱敏，`--with-text` 仅本地调试）
npm run prune:traces     # 90 天滚动保留（默认 dry-run，`--apply` 才删；按月手工执行）
npm run create:user      # 建号（白名单方案 A，RFC 0010；需 .env.local）
npm run eval
npm run eval:report -- --live --traces   # 报告：scripted 默认；--live 需模型 key（NUTRIBUDDY_MODEL_PROVIDER=commandcode 可走网关）
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
