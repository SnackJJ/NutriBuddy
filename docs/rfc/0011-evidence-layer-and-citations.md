# RFC 0011 — 依据层：source registry、语料快照与引用检查（S4 spec）

> 状态：**Proposed**（2026-07-26）。
> **前置条件**：`docs/adr/0004` 必须被接受（接受时同步更新 `docs/ADD.md` §Out of Scope）。
> 关联：`docs/rfc/0007` §3 S4（验收 D8）、`docs/rfc/0006` §3 与 `docs/rfc/0012`（场景策略包）、`docs/adr/0003`（"菜谱不携带营养数字"的同构不变量）、`docs/research/agent-skills-design-patterns.md` §3。
> 对应 issue 草稿见 §7。

## 1. 目标（V1.0 只做依据层，**不做检索**）

1. 建成 `source registry` + 语料快照管线：文档版本、生效日期、archive 状态、权威级别、章节定位 —— 与 catalog 同一套 snapshot 哲学，`sourceVersion` 随每轮记录。
2. **引用结构性可检查**：答案引用的章节必须存在、状态为 active、版本一致，**且出现在本轮的可用证据集里**。
3. V1.0 用**固定的钉住证据子集**让引用端到端可验证；BM25/向量/RRF/rerank 与检索 subagent 全部属 V1.1。

## 2. 现状与证据

- `TypedOutput` 目前只有 `prose / foodRefs / ruleRefs`（`src/harness/types.ts:251`）—— 无引用字段。
- 闸是纯函数 + typed verdict（`gate.ts:checkPostGate`、`numericProvenanceGate.ts:checkNumericProvenance`、`advisoryGate.ts:checkAdvisoryStructure`）—— 新增检查必须同形。
- **已有"钉住子集"先例**：ADD §Context 把用户适用的药物规则子集（全表 20–30 行）钉进 pinned region，理由是"约束不能依赖一次可能被跳过的 fetch"。依据层沿用同一机制。
- 摄入先例：`src/ingest/usda.ts` → 版本化 snapshot JSON；`catalog.snapshot.version` 进 `turn_start`（issue #60）。
- output gate 现有四项检查（实体 / 数字来源 / advisory 结构 / 词面兜底）→ 本 RFC 增第五项。

## 3. 决定

### 3.1 数据模型（迁移 0013）

```sql
-- 实现注记（2026-09-14，迁移 0013）：`id` 是 **`<slug>@<doc_version>`**，稳定文档身份另存
-- `slug` 列。原因是本节的"变更则 upsert 并把旧版本标 superseded（不删）"在 `id = slug` 下无处安放
-- 旧版本 —— 旧 trace 可能引用它，而引用必须能解析。另加一条 partial unique index：
-- 每个 slug 至多一个 active 版本，"同一文档两个 active"这个状态由数据库拒绝表示。
create table public.sources (
  id             text primary key,        -- <slug>@<doc_version>
  title          text not null,
  publisher      text not null,
  url            text not null,
  license        text,                    -- 逐源确认后填写
  doc_version    text not null,           -- 文档自身版本
  effective_date date,
  status         text not null default 'active',  -- active | superseded | archived
  authority_level int not null,           -- 数值越小越权威
  content_hash   text not null,
  ingested_at    timestamptz not null default now()
);

create table public.source_sections (
  id           text primary key,          -- 稳定 id：<source_id>#<section_path slug>
  source_id    text not null references public.sources(id) on delete cascade,
  section_path text not null,             -- "Chapter 1 / Key Recommendations"
  heading      text,
  ordinal      int  not null,
  text         text not null,
  anchor       text,                      -- 原文 URL + 锚点，供用户点开核验
  content_hash text not null,
  pinned       boolean not null default false   -- 是否进入 V1.0 钉住证据集
);

create index source_sections_source_idx on public.source_sections (source_id, ordinal);
create index source_sections_pinned_idx on public.source_sections (pinned) where pinned;
```

**RLS 与授权**（`docs/rfc/0006` §7 第 3 条）：语料是公共只读数据 —— `authenticated` 可 `select` 且仅限 `status='active'`；写入仅 service role；**先 `revoke` 默认 grant，再显式 `grant select`**。

**不建向量/全文列**：V1.1 迁移再加 `tsvector` + `embedding vector(...)` 与索引。V1.0 建了也没人查。

### 3.2 摄入管线（`scripts/ingest-sources.ts`）

沿用 `src/ingest/usda.ts` 的形状：

- 输入：仓库内 `sources/<source-id>/manifest.json` + 正文文件。
- 输出 ①：Supabase 行（service role 写入）。
- 输出 ②：版本化 snapshot manifest（各源 `content_hash`、section 数、`sourceVersion`）进仓库，作为可复现凭据。
- **幂等**：`content_hash` 未变则跳过；变更则 upsert 并把旧版本标 `superseded`（不删 —— 历史 trace 可能引用它）。

### 3.3 引用契约（additive schema 变更）

```ts
export interface CitationRef {
  readonly sectionId: string;
  readonly sourceId: string;
  readonly docVersion: string;
  readonly quote?: string;          // 可选短引文，长度上限见 §8
}

// TypedOutput 增加可选字段（不破坏既有生产者）
export interface TypedOutput {
  readonly prose: string;
  readonly foodRefs: readonly FoodRef[];
  readonly ruleRefs: readonly RuleRef[];
  readonly citations?: readonly CitationRef[];
}
```

`SCHEMA_VERSION` 由 `1.9.0` → `1.10.0`；`canonicalizeTurnEvents` 的 golden 需同步（新增字段先于既有断言落地，避免 golden 集体失效）。

### 3.4 本轮可用证据集必须成为 typed 数据

gate 要判"引用是否在本轮可用证据里"，就必须让**可用证据集本身可观测**。扩展 `TurnStartEvent`：

```ts
readonly evidenceSet?: {
  readonly sourceVersion: string;
  readonly sectionIds: readonly string[];   // 钉住集（V1.0）；V1.1 追加检索命中
};
```

理由：① gate 需要它；② trace 需要它才能重放这次判定；③ 未来 V1.1 检索命中直接并入同一字段，闸的语义不变。

### 3.5 output gate 第五项检查（`citationGate.ts`，纯函数）

对每条 citation 依次检查：

1. `sectionId` 存在于 registry；
2. 其 `source.status === "active"`（`superseded` / `archived` 一律拒绝 —— 防止"精确引用了已废止条款"这一新失败模式）；
3. `docVersion` 与 registry 当前版本一致；
4. `sectionId` ∈ 本轮 `evidenceSet.sectionIds`。

违规处理 —— **按严重度分级，不套用 C1 安全闸的终态**。ADR 0004 明确"RAG 不承担安全属性"；一个数字、实体、过敏原判断都正确的答案，不该因为一条引用的章节版本不符而被整体拒答：

1. **校验失败的 citation：确定性剥离**（从 typed output 的 `citations` 移除），并发 `block` verdict（`checkName: citation_provenance`，evidence 列出被剥离的 sectionId）。**不重生成、不拒答** —— 答案主体与既有安全路径都不受影响。
2. **剥离后如果 prose 里仍留着"声称有权威依据"的断言句**（§3.6），问题就不再是引用格式，而是"说了有出处却没有出处"，此时才走既有的重生成（最多两次）→ 确定性拒答。

顺序固定：**先剥离，再跑词面兜底**；两道检查各自发 typed verdict，scorer 因此能看到剥离次数（不可观测即不存在的同一条纪律）。

**verdict 必须自带严重度**：`gate_verdict` 事件需要一个显式字段区分"计入 regenerate 预算的 block"与"仅剥离、不计入预算的 block"（建议 `terminal: boolean`，随本次 `SCHEMA_VERSION` bump 一起加）。不能把区分留在"checkName 恰好等于 citation_provenance"这种阅读约定里 —— 否则实现者会照 ticket 字面把 tier-1 也接进 `turn.ts` 里那个共享 regenerate 预算（tier-2 才该进去）。

**fail-closed**：registry 不可用或 `evidenceSet` 缺失时，**不允许出现 citation**（一律剥离，而不是放行）。

### 3.6 词面兜底扩展

当 prose 出现"指南建议 / 膳食指南推荐 / according to the Dietary Guidelines / recommendations are"这类**断言语式**而 `citations` 为空 → 记违规（与现有 lexical backstop 同形）。空 citations 本身合法（不是每个回答都需要依据），但"声称有权威依据却不给引用"必须被拦。

### 3.7 钉住证据集（V1.0 的端到端可验证机制）

- 规模：**≤ 40 段、≤ 6k token**，按 `sectionId` 排序（字节稳定，不破坏前缀缓存）。
- 内容：**通用核心建议**（与用户无关的固定集），因此可以进 pinned region 保持字节稳定。
- **不做按用户选择** —— 按用户挑选证据本质是检索，属 V1.1；V1.0 的任何"相关性选择"都会把检索偷偷放进来，违反 ADR 0004 的分期。
- 用户可见面：答案里的引用至少展示 section 标题与来源链接（点开到 `anchor`）。UI 呈现的完整化属 S5。

## 4. 语料范围与合规（V1.0 建议三个源）

| 源 | 用途 | 备注 |
| --- | --- | --- |
| NIH ODS Fact Sheets | 补剂 / 维生素依据 | 美国联邦政府作品通常属公共领域，**须逐条确认**（部分内容可能含第三方授权材料） |
| Dietary Guidelines for Americans | 膳食建议 | 同上 |
| FDA 过敏原标签指南 | 与既有 allergen tags 交叉引用 | 同上 |

每条 `sources` 行必须填 `license`；引文长度设上限（控制体积）；**不做网页检索、不接非权威语料**。

## 5. 测试

| 测试 | 断言 |
| --- | --- |
| 摄入三条路径 | 幂等跳过 / 变更 upsert + 旧版 superseded / 源下架 archived |
| registry 查询（纯函数） | active / superseded / archived 三态；未知 id |
| `citationGate` 真值表 | 存在与否 × 状态 × 版本不符 × 不在本轮证据集（覆盖 fail-closed） |
| 词面兜底 | 断言句式无引用 → 违规；有引用 → 放行 |
| golden | 含 `citations` 的 `TypedOutput` 规范化与评分；`SCHEMA_VERSION` bump 后旧 golden 的迁移 |
| 迁移 / 授权 | 空库重放；`authenticated` 可读 active、不可写；匿名不可读 |
| 端到端 | 一次回答带 citation → trace 里可按 `sectionId` 查到 source 与版本（D8） |
| 重放 | `evidenceSet` 落库后，同一 turn 的引用判定可离线复算 |

## 6. DoD（对应 RFC 0007 D8）

一次带依据的回答中，所有 citation 都能在 registry 与本轮 `evidenceSet` 中查到且版本一致；**校验不通过的引用被确定性剥离并留下 typed verdict（tier-1，不拒答）**，只有"声称有权威依据却给不出引用"才走重生成 → 拒答（tier-2）；`npm test` + `npm run typecheck` 绿。

## 7. Tickets（草稿 → issue）

| # | 内容 | 依赖 |
| --- | --- | --- |
| T1 | 迁移 0013：`sources` / `source_sections` + RLS + revoke/grant + 索引 | ADR 0004 接受 |
| T2 | 语料清单与 manifest 格式 + 三个源的正文与 license 确认 | T1 |
| T3 | `scripts/ingest-sources.ts`（幂等、superseded、snapshot manifest） | T2 |
| T4 | `CitationRef` + `TypedOutput.citations` + `TurnStartEvent.evidenceSet` + `SCHEMA_VERSION` bump + golden 迁移 | T1 |
| T5 | `citationGate.ts`（四条件 + fail-closed）+ **tier-1 剥离动作** + verdict 事件（带 §3.5 的严重度字段）：**只有 tier-2 词面兜底才接反馈重生成，tier-1 不得进共享 regenerate 预算** | T4 |
| T6 | 词面兜底扩展（断言句式须带引用） | T4 |
| T7 | 钉住证据集的装配（≤40 段、排序稳定、进 pinned region） | T3 T4 |
| T8 | 引用的最小 UI（section 标题 + 来源链接） | T7 |

## 8. 未决

1. **语料最终清单与体量**：是否纳入 DailyMed 药品标签（与既有药物规则表的关系需先厘清，避免两套药物事实）。
2. **钉住集的选择规则**：本 RFC 定为"固定通用建议集"，不做按用户选择。若后续发现覆盖不足，应先扩集，不先加检索。
3. **`quote` 的存储与长度**：只存 `sectionId` 更省，存短引文更利于 UI 展示与审计 —— 需定上限（建议 ≤ 240 字符）。
4. **中文界面 vs 英文语料**：引文与界面语言不一致时的呈现规则（先原样引文 + 界面中文说明）。
5. **V1.1 检索命中如何并入 `evidenceSet`**：本 RFC 已把字段设计成可并入，但"检索命中是否需要更细的 score/rank 记录"留待 V1.1 决定。
6. **语料的过期治理责任**：谁负责发现新版指南并触发重摄入（建议：人工季度检查，与 catalog 快照刷新同节奏）。
