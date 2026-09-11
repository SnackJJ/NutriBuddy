# 生产级 agent harness 云架构（外部调研）

> 冷文档，**非 always-on 上下文**。2026-07-26 由外部调研产出，供 `docs/rfc/0006-cloud-runtime-architecture.md` 决策引用；结论未逐条复核，报告内已自行标注"未核实/有争议"项。
> 阅读方式：把它当"业界现状与硬边界"的资料，不当架构决定。架构决定仍在 ADD / ADR / RFC。

## 0. 结论速览

| 议题 | 建议 | 硬边界（可核查） |
|---|---|---|
| 计算拓扑 | 留在 Vercel 函数；30–60s 回合不构成换拓扑的理由 | Fluid Compute 默认 300s；Hobby 上限 300s，Pro/Enterprise 800s（[AI SDK 超时文档](https://cdn.jsdelivr.net/npm/ai@7.0.58/docs/09-troubleshooting/06-timeout-on-vercel.mdx)、[Vercel 时长配置](https://vercel.com/docs/functions/configuring-functions/duration)） |
| 长时回合 | 回合状态机 + append-only 事件表（Postgres），客户端按 seq 重放；跨超时才上 Inngest | Inngest 用 step 做检查点重试（[Inngest 文档](https://www.inngest.com/docs/learn/inngest-functions)） |
| 数据层 | 单 Supabase Postgres 全包：向量 + FTS + RRF | RRF 无内建函数，需自写 CTE（[ParadeDB 手册](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)） |
| 缓存 | 只做供应商前缀缓存 + 静态资源 CDN | DeepSeek 磁盘 KV 缓存默认开启（[文档](https://api-docs.deepseek.com/guides/kv_cache)） |
| 状态 | Postgres 为唯一真相；Redis 只放计数/锁/短缓冲 | RLS 与 grant 是两套检查（[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)） |
| 可观测性 | 自带事件流为真相源，按 OTel GenAI 属性命名以便将来导出 | 该约定仍拆在独立仓库、Schema URL 为 TODO（[repo](https://github.com/open-telemetry/semantic-conventions-genai)） |

## 1. 计算拓扑

**serverless 的时长上限已经不是瓶颈。** Vercel 在 Fluid Compute 下把默认函数时长提到 300s（所有计划），Hobby 上限 300s、Pro/Enterprise 800s（[AI SDK 超时文档](https://cdn.jsdelivr.net/npm/ai@7.0.58/docs/09-troubleshooting/06-timeout-on-vercel.mdx)、[Vercel 配置文档](https://vercel.com/docs/functions/configuring-functions/duration)）。Vercel 另有"函数可运行至 30 分钟"的 changelog，但未能读到正文确认适用计划（[changelog](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes)，**未核实**）。

Cloudflare Workers 的模型不同：**墙钟时间不限**（只要客户端连接着），默认 CPU 时间 30s、可通过 `cpu_ms` 提到 300s（[2025-03 变更](https://developers.cloudflare.com/changelog/2025-03-25-higher-cpu-limits/)、[Limits](https://developers.cloudflare.com/workers/platform/limits/)）。对"等模型返回"这种 I/O 等待型 agent，CPU 限制基本无关；真正的坑是长时间不写数据的响应会被 524 截断（[Cloudflare 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)）。

容器方案的代价是冷启动：Fly 的 autostop/autostart 机器空闲后停机、请求时再拉起（[Fly 文档](https://fly.io/docs/launch/autostop-autostart/)），Render 免费实例空闲即休眠（[Render 免费实例](https://render.com/docs/free)）。

**模块级状态**：serverless 不承诺同一实例处理下一次请求，把目录缓存在模块作用域只在单实例单生命周期内有效（工程判断，非厂商条文）。目录应作为打包内 JSON 或 Postgres 表按需加载，配进程级 memo + TTL。

**何时离开 serverless**：单回合稳定超过函数上限；需要常驻连接（WebSocket）；需要把大文件/rerank 模型常驻内存；需要长时间后台消费者。30–60s 回合不满足任何一条。

## 2. 长时回合与持久执行

三种失败要分开处理：函数超时、页面刷新、用户主动停止。它们的最小子集是同一件事——**把回合变成可查询、可重放的持久对象**。

| 方案 | 适用 | 单人成本 |
|---|---|---|
| 自建：`turns` 状态机 + `turn_events`(seq) + SSE 按 `?since=` 重放 | 回合 <300s，只需刷新幸存 | 最低，无需新依赖 |
| Inngest | 需要跨超时、重试、flow control、cron | 免费层可起步（[文档](https://www.inngest.com/docs/learn/inngest-functions)、[定价](https://www.inngest.com/pricing)） |
| Vercel Workflows | 已在 Vercel 且想吃托管持久执行 | 文档正文未读到（**未核实**） |
| Temporal | 多服务、强一致长流程 | 过重（[定价更新](https://temporal.io/blog/temporal-cloud-pricing-update)） |

Vercel AI SDK 的 resumable streams 覆盖同一场景，但要求 Redis + Next.js 的 `after()`，且明确把"用户点停止 ≠ 取消生成"留给开发者实现 stop 端点（[AI SDK 文档](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)）。**争议点**：Redis 缓冲式重放 vs 事件表重放。Ably 认为 30s+ 回合、多设备、企业代理环境下 Redis 方案不够（[Ably 分析](https://ably.com/blog/ai-chat-stream-resumption)）——卖方便立场，但它指出的"任何持有有效 streamId 的请求都能重连"的鉴权缺口值得自查。

**最小方案**：POST 创建 turn → 202 + `turn_id`；turn 步进写 `turn_events`；GET `/turns/:id/events?since=seq` 重放；刷新后用 `turnId` 重连。只有当单回合真越过 300s，才把 plan/act/verify 拆成多次函数调用（用 step 表做幂等），或引入 Inngest。

## 3. 数据层

**单 Postgres 足够，且是当前主流做法。** Supabase FTS 覆盖 tsvector/tsquery/`websearch_to_tsquery` 与 pg_trgm（[Supabase FTS](https://supabase.com/docs/guides/database/full-text-search)）；pgvector 提供 HNSW/IVFFlat 索引（[Supabase HNSW](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes)、[pgvector README](https://github.com/pgvector/pgvector)）。

**RRF 在 Postgres 里没有内建函数**，要在 SQL 层用 CTE 自己写：`1/(k+rank)`、k 通常取 60、可加权，还能把新鲜度/热度作为额外 ranker 一起融合（[ParadeDB 手册](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)）。同篇指出原生 `ts_rank` 只看单文档、缺全局语料统计（即**并非 BM25**）；若在意词法排序质量，可选 pg_search 这类扩展，不必立刻上 Elasticsearch。

**何时离开 Postgres（有争议）**：公开 benchmark 多为厂商自测，不可横比。可操作阈值（工程判断）：单租户语料 <10⁶ chunks、QPS 数十以内、延迟预算宽松（>50ms）→ 留在 Postgres，先把 HNSW 参数与内存调对。

**对象存储**：USDA 原始快照、PDF/HTML 语料原文放 Supabase Storage（或 S3 兼容），Postgres 只存切块、元数据与向量。

## 4. 缓存

| 层 | 现在做？ | 依据 |
|---|---|---|
| 供应商前缀缓存 | **做**，最高 ROI | DeepSeek 默认开启磁盘 KV 缓存，按"前缀单元"完全匹配，`usage` 有 `prompt_cache_hit_tokens`/`miss`，best-effort、几小时到几天清理（[DeepSeek](https://api-docs.deepseek.com/guides/kv_cache)）；Anthropic 支持自动缓存与显式 `cache_control` 断点，TTL 5 分钟或 1 小时（[Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)） |
| Embedding 缓存 | 只在重复嵌入同一文本时 | 摄入期一次性嵌入不需要；键用 `sha256(text)+model` |
| 检索结果缓存 | 推迟 | 单人流量命中率低；真正受益的是夜间 eval 反复跑同一批 query |
| 会话状态 Redis | 取决于第 2 节选择 | 选事件表重放则不需要 |
| 限流计数 | 见第 6 节 | [Upstash Ratelimit](https://upstash.com/docs/redis/sdks/ratelimit-ts/overview) |
| HTTP/CDN | 只缓存静态资源 | 带认证的 turn 接口不要进 CDN |

前缀缓存的前提是**前缀稳定**：system + 工具 schema + 稳定知识块放最前，时间戳、用户档案变更等动态内容放最后；顺序一变，命中率归零。

## 5. 会话状态与人工确认

- 会话/消息/回合/事件流/待确认动作 → **Postgres**（唯一真相、可被 RLS 保护、可与 trace join）
- 正在生成的事件 → Postgres append-only + seq 重放；若用 Redis 做流缓冲则二选一，别同时维护两份
- 锁、幂等键、限流计数 → Redis
- 客户端 → 只存 UI 态与 `lastSeq`

**"必须确认才能执行"是状态，不是进程内的 await。** LangGraph 的做法是 interrupt + checkpointer 持久化后恢复（[LangGraph HITL](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)）；AI SDK 把 tool approvals 建模为显式审批与策略（[Tool Approvals](https://ai-sdk.dev/docs/agents/tool-approvals)、[Policy-Based Tool Approvals](https://ai-sdk.dev/docs/agents/policy-tool-approvals)）。落地要点：`pending_approval` 带幂等键与过期时间；恢复时从"哪一步"继续而不是重跑整轮。

## 6. 成本与滥用控制

Upstash Ratelimit 面向 serverless、支持多算法与动态限额、**超时默认放行**（[文档](https://upstash.com/docs/redis/sdks/ratelimit-ts/overview)）——fail-open 对成本防线是漏洞，高成本端点应 fail-closed 或本地兜底。供应商侧不能兜底：DeepSeek 明确不设硬性速率限制、可能返回 429（[DeepSeek 限流](https://api-docs.deepseek.com/quick_start/rate_limit)）。

单人开发者三件套：① 每用户每日 token/费用预算表，超限直接拒绝；② 每回合硬上限（max steps、wall-clock、工具调用数、检索 token）；③ 请求前按上下文上界 × 单价预估最坏成本并按阈值拒绝。平台侧用 WAF/防火墙速率规则做第一道。

**一个容易踩的合规点**：Vercel Hobby 计划的使用条款面向个人/非商用，对外开放外部用户前需确认计划适用性（[Hobby 计划](https://vercel.com/docs/plans/hobby)，**未核实**）。

## 7. 可观测性

规范尚未稳定：OTel GenAI 语义约定已拆到独立仓库，README 里 Schema URL 仍是 TODO（[semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)、[属性注册表](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)）。Langfuse 可自托管（[self-hosting](https://langfuse.com/self-hosting)），AI SDK 有内置 telemetry 导出（[telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)）——把它们当"看板"，真相源仍是自己的类型化事件流。

**最小可用集**：每回合一条 trace（turn_id、skill pack 版本、模型、终态）；每步一个 span（类型、耗时、重试、错误）；每次模型调用记录 model / 输入输出 token / 缓存命中 token / 延迟 / stop reason / 成本估算；每次检索记录 query、召回数、融合后 top-k、rerank 前后序、语料版本；每次写操作记录工具名、参数 hash、幂等键、确认来源。优先级：**成本归因 + 失败分类 > 全量 prompt 留档**。

## 8. 多租户与安全

- **RLS 基线**：暴露 schema 的每张表都开 RLS，并 revoke 默认给 `anon`/`authenticated` 的 grant——**加策略不会收回授权**（[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)）。
- **性能**：策略里把 `auth.uid()` 与函数包成 `(select ...)` 触发 initPlan 缓存，并给策略列加索引。官方实测 10 万行表：`auth.uid()=user_id` 171ms → 加索引 <0.1ms；`is_admin()` 11000ms → `(select is_admin())` 7ms（[RLS 性能与最佳实践](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)）。
- **客户端选择**：用户态请求用带用户 JWT 的客户端让 RLS 生效；service_role/secret key 绕过 RLS，只能服务端使用（[API keys 新命名](https://supabase.com/docs/guides/getting-started/api-keys)）。
- **密钥**：模型 key 与 Supabase secret key 一律仅服务端环境变量，绝不 `NEXT_PUBLIC_`。
- **1 → N 用户新增的工作**：`user_id/tenant_id` 列 + 每表策略 + 索引；公共语料拆成"authenticated 只读"表；按用户配额与花费上限；写操作审计；账号删除路径（区分公共语料与用户数据）；计划合规性复核。**RLS 只保护数据、不保护成本**——多租户下最易被滥用的资源是模型调用。

## 9. 未能核实 / 有争议清单

1. Vercel "函数可运行 30 分钟" changelog 正文与适用计划未读到；AI SDK 文档口径为 Hobby 300s / Pro 800s。
2. Ably 称 Cloudflare 把 SSE 截到 30s，Cloudflare 官方文档中未找到；官方可查的是 524（源站 100s 无数据）与 Workers CPU 上限。
3. Vercel Workflows（WDK）的 GA 状态与限制未核实。
4. Trigger.dev v4 的定价与限额未核实。
5. Supabase 免费项目"7 天不活跃自动暂停"本次未确认。
6. OpenAI prompt caching 的 1024 token 门槛与折扣比例未逐条核对。
7. Anthropic 缓存写/读价格倍率未逐条核对定价页。
8. Vercel Hobby 非商用限制的条款正文未读到。
9. "Postgres vs 专用向量库"的分界线无权威基准，报告给的阈值是工程判断。
10. "serverless 不保证实例复用、不能依赖模块级目录缓存"是设计原则判断，未见厂商明文承诺。
