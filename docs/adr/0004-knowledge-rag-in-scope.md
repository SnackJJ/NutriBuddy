# 知识 RAG 纳入项目范围

> 状态：**Proposed**（2026-07-26）。本 ADR 修改 `docs/ADD.md` §Out of Scope 的一处判定，并部分打开 ADR 0001 / ADR 0003 关闭的检索闸。接受后需同步更新 ADD 与 `CONTEXT.md`。

## 背景

`docs/ADD.md:127` 把 Knowledge RAG（NIH/USDA 语料）列为 **Phase 5、metric-gated 推迟项**，理由是"richness, not correctness；没有安全属性依赖它"。ADR 0001 把检索 subagent 定为"唯一可能够格的 subagent，但只在指标触发后进入"，ADR 0003 明确"闸保持关闭"。

项目当前状态（Phase 4 已落地：seam / 四道闸 / 写入路径 / PWA shell / auth+RLS / nightly live eval 框架）改变了两件事：

1. **安全正确性已经不依赖 RAG**，所以引入 RAG 不再有"用它来补正确性"的滑坡风险 —— 它只补依据与话术。
2. **产品价值的天花板卡在依据上**："这个建议为什么成立"目前只能由模型叙述；没有可核验原文，答案的权威性等于模型的记忆。

因此本 ADR 决定把知识 RAG **纳入范围**，但把它严格限制在依据层。

## 决定

1. **知识 RAG 在范围内**，定位为 **advisory evidence 层**：提供"为什么这么建议"的权威原文与引用，不提供事实、数字、实体、写入。
2. **三条不变量（与 ADR 0003 的菜谱不变量同构）**：
   - 营养数字仍只能来自 catalog observation（`numericProvenanceGate` 不改）。
   - 食物实体仍只能由 resolver 级联铸造。
   - 写入仍只能来自用户确认过的 immutable proposal。
3. **引用必须是结构性可检查的**：context 中进入的检索片段携带 `sourceId + docVersion + 章节定位`；最终答案的引用字段只允许引用**本轮 observation 中出现过的 sourceId**。这是 output gate 的第四个结构性检查，仍是纯函数，不引入 LLM judge。**失败按严重度分级**：校验不通过的引用被确定性剥离（并发出 typed verdict），不整体拒答；只有"声称有权威依据却给不出引用"才走既有的重生成 → 拒答路径。理由：本 ADR 明确 RAG 不承担安全属性，一个数字与过敏原都正确的答案不该因一条引用的版本不符而被整体拒答（实现细节见 `docs/rfc/0011` §3.5）。
4. **检索失败必须 fail-closed**：检索不可用或缺证据时，答案退化为"无引用 + 明确说明依据不足"，绝不允许模型以记忆补位。禁止 RAG 片段被当作数字来源。
5. **数据层沿用 snapshot 哲学**：`source registry`（文档 id、版本、生效日期、archive 状态、权威级别、章节）与语料快照版本化，随 release 固定，并写入 turn-start 事件的 context digest —— 与 catalog snapshot version 同一套机制，保证任意 trace 可对数据复现。
6. **检索实现**：同一 Postgres 内的混合检索 —— 词法侧（`tsvector`）负责条款号、剂量、数字等精确串召回，`pgvector` 负责语义召回，RRF 融合后 rerank；命中后**强制回源** registry 校验版本与生效状态，再进上下文。实现注意：RRF 在 Postgres 无内建函数，需用 CTE 手写 `1/(k+rank)`；原生 `ts_rank` **并非 BM25**（只看单文档、缺全局语料统计），若词法排序质量不足，先考虑 `pg_search` 类扩展而非更换检索引擎。原始语料（PDF/HTML）放对象存储，Postgres 只存切片、元数据与向量。
7. **检索 subagent 有条件启用**：仅当出现"多轮检索 + 覆盖判停"这类需要 context 隔离的场景时启用（ADR 0001 已授权该路径），不新增领域 agent，不改单 agent 拓扑。
8. **新增评测类别**：`retrieval`（Recall@k / MRR / 引用正确率 / 引用存在性）与 `rag_boundary`（检索到的文本不得把数字偷渡进答案、检索不可用时的降级行为）。与既有六类同表计分。

## 为什么（权衡）

### 为什么不继续推迟

原推迟理由的前提是"没有消费者"。现在消费者明确了：**用户要的不是一个会算数的记录器，而是一个能给出依据的顾问**。而恰好因为安全不变量已经由确定性代码承担，RAG 可以只做"依据"这一件事 —— 这是最低风险的引入方式，也是唯一不与 C1/C2/C3 冲突的方式。

### 为什么不用独立向量库

语料规模是文档级（数百到数千份、切片数万），单 Postgres 的 `pgvector` + 全文检索足够；引入独立向量库会多出一套一致性、备份、鉴权边界，且使"引用回源校验"变成跨系统的两跳。触发迁出的条件是检索延迟或数据量真正超出现有栈，而不是"业界都这么做"。

### 为什么引用检查放在 output gate 而不是新 gate

属性是同一类："答案里的某个东西必须在 observation 里出现过"。数字已经这么查（provenance），实体已经这么查（catalog 成员），引用沿用同一形状，闸的数量不增加。

### 为什么仍然不做多 agent

检索是**机制**（context 隔离），不是**主题**（营养领域分工）。ADR 0001 的论证不变：按领域拆 agent 会 N 倍化可靠性失败面，且需要路由与冲突裁决。

### 外部证据（2026-07-26 调研，全文见 `docs/research/agent-skills-design-patterns.md` §3）

- Bloomberg 在 11 个模型、5000+ 有害提示上的研究显示 **RAG 反而降低安全性**，81.8% 的不安全回答来自"安全文档" —— 说明"把安全交给检索到的文本"是错的方向，与本 ADR 第 2 条不变量（RAG 不参与任何安全判定）一致。
- Intercom Fin 的工程文档证明**检索范围必须靠配置而非提示词**（官方原话：写"不要用某篇文章"，"如果它是最佳匹配，Fin 可能仍然会用它"）—— 本 ADR 因此要求 source registry 带权威级别与 archive 状态，检索范围由配置决定。
- OWASP LLM01 的结论是 RAG 与微调**不能完全缓解**注入，缓解手段是"用确定性代码校验输出格式" + 高风险动作人工批准 —— 对应本 ADR 第 3 条（引用结构性可检查）与既有的写入确认短路。

## 后果

- `docs/ADD.md`：§Out of Scope 删除 Knowledge RAG 条目（或改写为"已纳入，见 ADR 0004"）；§Phases 增加 RAG 阶段；§Data Pipeline 增加语料 snapshot 与 source registry。
- `CONTEXT.md`：新增术语 Source registry / Citation。
- ADR 0001 / 0003 的"闸保持关闭"表述失效，需在该 ADR 中补一条指向本 ADR 的更新说明。
- 成本与延迟：每轮可能多一次检索调用与一次 rerank，进入 per-turn 成本/延迟记录；需要为检索设 token 与时间预算。
- 评测与自进化：检索失败成为新的归因分桶（`retrieval_miss`），进入反馈闭环。
- 风险：语料版权与使用条款需逐源确认；过期文件必须能被 archive 状态挡住（否则"精确地引用了已废止的条款"会成为新的失败模式）。

## 明确不做

- 不做通用网页检索 / 联网搜索作为答案依据。
- 不让 RAG 结果参与任何安全判定（过敏原、药物冲突仍走规则表与闸）。
- 不做 RAG 驱动的自动改写规则表 —— 规则表变更仍走人工审核。
