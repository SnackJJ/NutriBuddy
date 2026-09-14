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
- **Data**: USDA FoodData Central as **snapshot ingestion**; runtime reads local catalog. Knowledge RAG: `docs/adr/0004` (**Accepted**, 2026-09-14) brings it **into scope as an evidence layer only** — it never supplies numbers, entities, or writes; V1.0 ships the registry/corpus/pinned set/citation checks, retrieval itself lands in V1.1 (`docs/rfc/0011`).

## Next (V1.0 — plan in `docs/rfc/0007`)

Keep this list short. Prefer GitHub issues as the live backlog.

1. **S1 已收口**（`docs/rfc/0008`）：T1–T9 全部落地（迁移 0011/0014、TraceStore 端口、`turn()` 接线、`SupabaseTraceStore`、重放路由、导出 `scripts/export-traces.mts`、保留 `scripts/prune-traces.ts`、D9 smoke）。两处仍未闭合、已留在票上：D4 的**真人刷新验证**（仓库无 jsdom，见 `docs/reviews/2026-09-13-s1-turn-replay-review.md`）与 `supabase/config.toml` 的 `major_version` 与 hosted 核对（归 #113）。
2. **S2 — 评测报告与成本/延迟聚合**（`docs/rfc/0009`）：已落地 —— `npm run eval:report` 产出 `reports/<reportId>/{report.md,summary.json,cases.json}` + `reports/index.json`，`--compare <reportId>` 按阈值标倒退（数据集或 mode 不同即判不可比），`--traces` 并入轨迹遥测。live 基线在 `reports/`（v1/v2 是历史记录，datasetHash 已变故与后续不可比）。**live 基线挖出的六个问题全部已修并关闭**：#126 转圈 + 终态空回复、#127 gate 没拦 prescriptive 过敏请求、#128 词面判分把警告当违规、#129 provider 抖动被记成能力失败（现重试 + `infrastructure` 标记并从分母剔除且点名）、#130 catalog 里没有的食物（`expectsCatalogMiss`：必须如实说查不到且不得编数字）、#125 药物相互作用表无迁移（硬约束数据源在重放库里不存在）
3. **S3 — 费用闸、配额与白名单登录**（`docs/rfc/0010`）：代码侧已落地（配额纯函数 `src/lib/quota.ts`、`turns` 聚合、429 前置、最坏成本预估、UI 隐藏注册、拒绝日志）；运维人工步骤（关闭公开注册、provider 消费上限、Production-only 密钥）见 `docs/ops/v1.0-operations.md`，**尚未执行**
4. **S4 — 依据层**（`docs/rfc/0011`，ADR 0004 已接受）：已落地 —— 迁移 0013（sources/source_sections + RLS）、13 个联邦政府语料源（372 段，`sources/`）、`scripts/ingest-sources.mts`（按 content_hash 幂等、变更 supersede 不删）、`CitationRef`/`evidenceSet`（SCHEMA_VERSION 1.10.0）、`citationGate`（四条件 + fail-closed，tier-1 剥离 `terminal:false`）、词面兜底 tier-2（声称有出处却无引用 → 重生成→拒答）、钉住集装配进 pinned region（29 段 / ~6k token）、最小引用 UI（标题 + 可点开链接）。**D8 已实测**：真模型给出的 1 条引用经 registry 校验通过并随答案送达
5. **S5 — 上线收尾**：代码与文档侧已落地 —— README（定位 / 三条不变量 / 十分钟跑起来 / 数字从哪来）、`version: 1.0.0`、首页可用入口、隐私说明（`docs/privacy.md` + `/privacy`，含供应商条款查证与"删号不等于供应商侧清除"）、账号删除（迁移 0016 级联 + `DELETE /api/account` + `npm run smoke:delete` 实测）。**仍待人工**：Vercel 部署与 Production-only 密钥（#113）、`v1.0.0` tag（#114）、关闭公开注册（#101）、provider 消费上限（#119）、真机 PWA 验证（#117）、托管条款确认（#118）

迁移现在有 16 个（0011 起是 S1/S4/S5 的：0011 轨迹、0013 依据语料、0014 老表 grant、0015 相互作用规则、0016 账号删除级联）。本地重放依赖 Supabase 本地栈（`docs/rfc/0007` D2 与 `scripts/verify-migrations.sh`），该脚本逐条断言每迁移的授权 / 策略 / 索引 / 计数前提（含"规则表已种子""三表有级联外键"这类曾经空通过的项）。

Nightly live eval thickening and dropping derived `toolResult` after the UI migration (RFC 0002 §2.6) stay open; TraceEvent stays debug-only.

Do **not** confuse ADD product Phase 0–4 with structural RFC phases (already landed).

## Commands

```bash
npm test                 # vitest (excludes .sandcastle)
npm run typecheck
npm run verify:migrations # 空库重放检查（需 Docker + psql，会 db reset 本地栈）
npm run smoke:confirm    # live Supabase confirm/void (needs .env.local)
npm run smoke:trace      # D9: trace write door closed + cross-account reads (needs .env.local)
npm run smoke:delete     # 账号删除后五张表清空、语料表不变（service role 计数，needs .env.local）
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
