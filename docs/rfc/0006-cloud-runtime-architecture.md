# RFC 0006 — 云端运行架构（V1 上线形态）

> 状态：**Proposed**（2026-07-26）。
> 关联：`docs/adr/0002`（交付形态 Accepted）、`docs/adr/0004`（知识 RAG 纳入 Proposed）、`docs/ADD.md` §Testing Seam / §Observability / §Multi-User。
> 本文回答"哪些东西放云端、放在哪一层、为什么"；**不改变** ADD 的架构主张（单 agent、四道闸、单缝）。

## 1. 现状（逐条带证据）

| 层 | 现在是什么 | 云上会怎样 |
| --- | --- | --- |
| 客户端 | `app/chat/page.tsx`（1790 行，含空态/`aria-live`/confirm-edit） + `app/profile/page.tsx`（登录/注册/档案） | ✅ 可用 |
| API | `app/api/{chat,profile,today,custom-meal}/route.ts`，`runtime = "nodejs"` | ✅ 可用；`/api/chat` 已 401 拒绝匿名（#82 已关闭） |
| 流式 | NDJSON：turn 事件逐条推送，terminal 收尾（`route.ts:291`） | ✅ 可用；刷新页面即断，无恢复 |
| 身份 | Supabase JWT 校验 + `assertSessionSubject`，用户态 client 走 RLS | ✅ 可用 |
| 数据 | Postgres：`user_profile / meal_logs / proposals` + RLS（migrations 0001–0010） | ✅ 可用 |
| 事实层 | catalog 快照文件（`CATALOG_SNAPSHOT_PATH`），冷启动加载，缺省落 SEED | ⚠️ serverless 每次冷启动重载；快照变大后成为负担（ADR 0002 已记） |
| **轨迹** | `EventLog` 用 `appendFileSync` 写相对目录 `traces`（`src/harness/eventLog.ts`），且 `loop.ts:345` 第一步就调用它 | ❌ 比"丢数据"更糟：Vercel 的 cwd 是只读的 `/var/task`，`mkdirSync` 直接抛 `EROFS` → **今天部署等于每个 utterance turn 都失败**。它同时也没有任何消费者（仅路由一处实例化，CLI 与测试都不用）。**#113 部署的真实依赖是 S1 的 #88，不是笼统的 S1–S4** |
| 评测 | scripted eval 进 CI（`npm run eval`）、live 合规跑夜间（`npm run eval:live`）；结果不落盘 | ⚠️ 无历史、无趋势、无法出"成果数字" |
| 成本 | 逐轮记 `latencyMs / usage / costUsd`（事件层有），无账号级上限、无限流 | ❌ 公开可达即费用敞口 |
| 部署 | 无 vercel/容器配置，无 tag，`package.json` 无 `version` 字段 | ❌ 未部署 |

**结论**：安全与业务逻辑这条线已经具备上云条件（这正是 Phase 0–4 的产出）。缺的是**运行面**：轨迹持久化、成本闸、可观测的历史、部署与版本标记。

## 2. 运行拓扑

```
手机/浏览器 (PWA, 无逻辑)
  └─ HTTPS → Vercel (Next.js)
       ├─ app/api/chat        turn seam（streaming NDJSON）
       ├─ app/api/{profile,today,custom-meal}
       └─ 服务端端口：ModelAdapter | Catalog | Stores | Clock
            ├─ Supabase Postgres（业务数据 + RLS + 轨迹 + 向量/全文）
            └─ 模型 API（prompt 前缀缓存）
```

三条不变量（沿用 ADR 0002）：

1. **harness 只在服务端**，客户端只发一句话、渲染事件、回传 proposalId。
2. **端口在服务端闭口**：模型 key、service-role key 永不下发。
3. **一份 harness 服务 N 个 surface**（PWA / 未来 IM bot / CLI 开发工具），surface 不持有逻辑。

**长任务策略**：V1 不做 durable execution（不引入 Inngest / Temporal / 托管工作流）。理由：单 turn 预算 8 步、输出闸最多重生成 2 次；函数时长上限也已不是瓶颈 —— 现行上限是 **Hobby 300s / Pro 800s**（Fluid Compute 默认 300s），而非 ADR 0002 记录时的 60s（见 §12 与 `docs/research/agent-harness-production-architecture.md` §1）。工作流引擎是为"跨天、可中断、需崩溃恢复"的流程准备的，而本产品的 turn 是秒级且**每次都必须重新过闸**。

**但"刷新即丢"要顺手修掉**：既然轨迹必须入 Postgres（§3、§10.1），**把 turn 做成可重放的持久对象几乎是免费的** —— `turns` 行 + `turn_events(seq)` 追加，客户端持 `turnId` 与 `lastSeq`，断线后按 `?since=seq` 重放。这一步不需要 Redis；但需要 `waitUntil`（`@vercel/functions`）保证客户端断连后实例不被冻结 —— 它是 S1 **唯一新增的运行时依赖**（`docs/rfc/0008` §1.3、§3.5）。**它不覆盖"用户主动停止"与"多设备续看"** —— 前者需要新的中止通道，后者需要 `listTurns` 的接口，V1.0 都不做。

## 3. 数据层：单个 Postgres 装下全部

V1 **不引入** Redis / 独立向量库 / 对象存储。分层如下：

| 关注点 | 存放 | 理由 |
| --- | --- | --- |
| 业务数据 | Postgres：`user_profile`（版本化 append-only）、`meal_logs`、`proposals` | 已有，RLS 已建 |
| **轨迹** | Postgres：`turn_events`（append-only，列为 `turn_id + user_id + seq + schema_version + type + payload + created_at`，`payload` = 完整 `AnyTurnEvent`；**无 `session_id`**）、`turns`（轮级元数据：终端状态、stopReason、cost/latency 汇总，`session_id` 在 V1.0 恒为 null） | **本次新增**。事件 schema 已成 typed，落表即得审计 + 回放 + RL 消费面 |
| 知识语料 | Postgres：`sources`（registry：版本/生效日期/archive/权威级别）、`source_chunks`（`tsvector` + `vector`） | 与 ADR 0004 同一套 snapshot 哲学 |
| 会话 | 客户端持有 + 显式随请求发送（沿用现状 `getRequestHistory`） | V1 不做服务端会话表；轨迹表已能重建 |
| 缓存 | provider 前缀缓存 + catalog 常驻内存 | 见 §4 |

**为什么轨迹必须进库**：它同时是四个东西的载体 —— 审计面、评测回放源、自进化归因输入、未来 RL 训练数据（`CONTEXT.md` 已把 Trajectory 定为资产）。写本地文件时这四个都不成立，而 serverless 让本地文件等于不存在。

**为什么检索也放同一个 Postgres**：语料是文档级（切片数万），`tsvector` 做词法侧、`pgvector` 做语义侧、RRF 在 SQL 里融合已足够；跨系统会让"引用回源校验"变成两跳并新增一套鉴权边界。**迁出触发条件**：检索 P95 超过 turn 预算的 1/3，或切片数进入百万级（§12 的阈值同样是工程判断，无权威基准）。

三条实现细节（外部调研确认，见 §12）：

1. **RRF 在 Postgres 里没有内建函数**，要用 CTE 手写 `1/(k+rank)`（k 常取 60，可加权）；ParadeDB 的手册给了可抄的 SQL。
2. **原生 `ts_rank` 不是 BM25**（只看单文档、缺全局语料统计）。若词法排序质量成为问题，先考虑 `pg_search` 类扩展，而不是换检索引擎。
3. **原始语料不进 Postgres**：PDF/HTML 原文与 USDA 快照放对象存储（Supabase Storage），Postgres 只存切片、元数据与向量。

## 4. 缓存分层：只做三层，其余推迟

| 层 | 做什么 | V1 是否做 |
| --- | --- | --- |
| **模型前缀缓存** | pinned region 字节稳定（system 契约 + 模板签名 + profile 快照 + 药物规则），让 provider KV 缓存命中；`cacheHitTokens` 已在事件里 | ✅ 已有，进一步把"字节稳定"变成测试断言 |
| **catalog 常驻** | 进程内加载快照，冷启动一次 | ✅ 已有；加一条：快照版本写进 turn-start 事件（已有 `catalogVersion`） |
| **检索结果缓存** | 同一 query 归一化后的 top-k 短 TTL 缓存 | 🟡 仅当 RAG 上线且实测检索占延迟大头才做 |
| embedding 缓存 / Redis 会话 / CDN 动态缓存 | — | ❌ 推迟，当前无证据支持 |

**前缀稳定性的排序规则**：system 契约 + 工具 schema + 稳定知识块放最前，时间戳、用户档案变更等动态内容放最后；顺序一变，命中率归零。DeepSeek 的磁盘 KV 缓存是默认开启的（`prompt_cache_hit_tokens` 直接可用），Anthropic 走 `cache_control` 断点 —— 两家机制不同，但"前缀字节稳定"是共同前提。

## 5. 成本与滥用控制（公开可达的前提）

1. **provider 侧消费上限**（唯一能封顶损失的机制，ADR 0002 已列；provider 自身不设硬速率限制，只会返回 429）。
2. **每用户每日配额**：turn 数 + token 上限，超限返回 typed refusal（不是静默失败）。
3. **接口限流**：按用户 + IP 双键。注意主流 serverless 限流库**默认超时放行（fail-open）**，高成本端点必须显式改成 fail-closed 或本地兜底 —— 否则限流失效的时刻正好是压力最大的时刻。
4. **单 turn 预算**：步数 8 已有；新增 token / wall-clock / 工具调用数上限，超限走确定性拒答。
5. **匿名通道**：保持 401（已实现），公开注册前再加邮箱验证与防脚本注册。
6. **调用前最坏成本预估**：按上下文上界 × 单价估算，超阈值直接拒绝，而不是等账单。

**单用户 → 多用户时最容易被忽略的一点**：RLS 只保护数据，**不保护成本**。模型调用是唯一能被滥用的资源，必须与本节一起设计。

## 6. 可观测性

V1 = 自建事件表（§3）+ 一个只读看板页面（`/admin` 或脚本导出），指标固定为：

- 每 turn：`stopReason` 分布、步数、gate verdict 分布、P50/P95 延迟、token、成本、前缀缓存命中率；
- 每评测：通过率（bare vs harness Δ）、约束违反率、工具调用率、闸拦截率；
- 每归因（自进化落地后）：失败分桶计数与趋势。

**不自建第二个 tracing 系统**：事件表已是 schema-versioned 的权威事实源，引入第三方 LLM 可观测平台会制造第二真源。若要对外标准兼容，只做一层**导出适配**（OTel/第三方格式），不改变内部形状。

**命名对齐 OTel GenAI 语义约定**（该约定仍在独立仓库、尚未稳定，所以只对齐命名、不引入依赖）：每回合一条 trace（`turn_id`、skill pack 版本、模型、终态）；每步一个 span（类型、耗时、重试、错误）；每次模型调用记 model / 输入输出 token / **缓存命中 token** / 延迟 / stop reason / 成本；每次检索记 query、召回数、融合 top-k、rerank 前后序、语料版本；每次写操作记工具名、参数 hash、幂等键、确认来源。

**优先级明确**：成本归因 + 失败分类 > 全量 prompt 留档。留档是隐私面也是存储成本，按需采样即可。

## 7. 多租户与安全（从 1 个用户到 N 个用户时要改的东西）

| 项 | 现状 | 开放前要补 |
| --- | --- | --- |
| 行级隔离 | RLS 已建（proposals / meal_logs / user_profile） | 新增表（轨迹、语料）逐表 RLS + 策略 |
| 角色 | 用户态 client 走 RLS；service-role 仅服务端 | 明确"service-role 只在迁移与后台任务使用"的调用清单 |
| 密钥 | `DEEPSEEK_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 仅 Production | 保持 Preview 不下发（ADR 0002 已列） |
| 敏感数据 | 餐食 + 用药 = 个人健康数据 | 隐私说明、数据删除路径（账号删除 = 级联删轨迹）、导出与同意；**轨迹保留 90 天**（`docs/rfc/0008` §12.1） |
| 第三方模型供应商 | 餐食/用药以自然语言进入 prompt 并发给模型 API | 隐私说明必须写明所用供应商对请求内容的留存与训练使用条款 —— "删账号"不等于供应商侧日志同步清除，不能只描述自己库里的删除级联 |
| 提示注入 | catalog/知识语料进 context | 语料视为不可信文本：只作引用载荷，不承载指令 |

四条来自生产实践的具体要求（§12）：

1. **加策略不等于收回授权**：新表开 RLS 的同时必须 `revoke` 默认给 `anon` / `authenticated` 的 grant —— Supabase 上"策略"与"授权"是两套检查，只开 RLS 不收 grant 会留下直连口子。
2. **RLS 策略写法影响性能**：把 `auth.uid()` 与函数包成 `(select ...)` 触发 initPlan 缓存，并给策略列建索引（Supabase 官方实测：10 万行表上 `auth.uid()=user_id` 从 171ms 降到 <0.1ms）。
3. **公共语料表与用户数据表分离授权**：语料是 `authenticated` 只读的公共数据，轨迹/餐食/提案是 owner-only。账号删除只级联用户数据，不动语料。
4. **这三条同样适用于既有表**：`proposals` / `meal_logs` / `user_profile`（`supabase/migrations/0005_rls_policies.sql`）目前既没有 `revoke` 默认 grant，策略也写成裸 `auth.uid() = user_id`。回填由**迁移 0014** 单独跟踪（不塞进新表迁移，避免把两个风险混在一次迁移里）。

## 8. Skill / 场景策略包

> **V1.1 内容，已搬到 `docs/rfc/0012-scenario-policy-packs.md`。** 本节原在此处（约 55 行），但它是落地顺序 step 6 的 V1.1 事项，不被任何 S1–S5 ticket 引用；留在一份标题为"V1 上线形态"的 RFC 里会让人误判 V1.0 的实际范围。决定内容未变，只是搬家。


## 9. 部署与运维

- **托管**：Vercel（现存 Next.js 应用），Supabase 保持 Postgres + Auth + RLS。
- **版本标记**：`package.json` 补 `version`，与 `vX.Y.Z` tag 对齐；每个 release 在 turn-start 事件里带 `appVersion + catalogVersion + sourceVersion`（可复现性的最小集合）。
- **迁移触发条件**（ADR 0002 已定）：撞上函数时长上限（现行 Hobby 300s / Pro 800s，见 §12.1；ADR 0002 成文时记录的 60s 前提已过期）或 catalog 冷启动成本 → 迁 Fly.io/Railway 长驻容器，成本低。
- **备份**：依赖 Supabase 快照；轨迹表属关键资产，需单独导出策略。

## 10. 落地顺序（依赖排序）

V1.0 = 第 1–4 步（能上线、能产生可复现数字、费用可控、依据层的数据与检查就位）；V1.1 = 第 5–6 步（自进化闭环 + 场景策略包）。

1. `turn_events` / `turns` 表 + `TraceStore` **端口进 `turn()`**（删除路由里的 `EventLog`，**不保留 fs 适配器**）+ 按 `?since=seq` 重放 —— **其余一切的前置**（审计、回放、归因、RL 资产、刷新恢复都挂在它上面）。
2. `eval:report`：评测结果落盘 + 成本/延迟聚合（成果数字与回归基线）。
3. 成本闸与配额 + **白名单登录**（allowlist 校验；比"发邀请码"少一个机制、解决同一个滥用问题）。
4. **RAG 的 V1.0 部分**：ADR 0004 接受 → source registry 表 + 语料 snapshot 管线 + 引用结构性检查（检索本身留到 V1.1）。这样 V1.1 只接检索，不动数据层与闸。
5. 失败归因枚举 + 分桶报告 + 历史回放（自进化前半）。
6. 场景策略包 + `(skill_id, version, hash)` 记账（自进化后半）。
7. 部署、隐私说明与数据删除路径、README 可跑。
8. 压测与延迟工程。

## 11. 未决问题

1. 对外开放到哪一档（个人 / 白名单 / 公开注册）。**本 RFC 建议**：V1.0 走白名单，公开发布作为 V2 的开关 —— 因为公开所需的三样（费用兜底、隐私与删除路径、注册门槛）与用户数无关，V1.0 做掉就不用返工；而公开注册多出的防脚本、条款、健康数据合规义务在这个阶段不产生收益。另需确认托管计划条款是否允许非商用（§12 标注为未核实）。
2. 轨迹表的保留策略与导出（RL 用全量 vs 隐私最小化）。
3. catalog 快照的存放：仓库内文件 vs Supabase Storage vs 表（影响冷启动与版本管理）。
4. 是否引入第三方可观测平台的导出适配（不影响内部真源）。
5. 检索语料的授权与过期治理责任边界。

## 12. 行业实现对照

两份外部调研全文见 `docs/research/agent-harness-production-architecture.md` 与 `docs/research/agent-skills-design-patterns.md`（含未核实/有争议清单）。本节只保留"与决策相关"的对照。

| 议题 | 业界现状（含硬边界） | 本项目取舍 |
| --- | --- | --- |
| 计算拓扑 | Vercel Fluid 默认 300s、Hobby 300s / Pro 800s；Cloudflare 墙钟不限但 CPU 默认 30s；容器方案有冷启动代价 | 留在 Vercel；不提前迁容器（**ADR 0002 的 60s 前提已过期**） |
| 回合持久化 | 两派：Redis 流缓冲（AI SDK resumable streams）vs 事件表重放（`?since=seq`）；有观点认为 30s+ 回合与多设备场景下 Redis 缓冲不足 | 选事件表重放 —— 轨迹本来就要入库，重放近乎免费，且无新依赖 |
| 数据层 | 单 Postgres + pgvector + tsvector 是当前主流；**RRF 无内建函数**需手写 CTE；原生 `ts_rank` 并非 BM25 | 单 Postgres，不引独立向量库；原始语料进对象存储 |
| 缓存 | 供应商前缀缓存 ROI 最高；embedding / 检索结果缓存收益在单人量级很低 | 只做前缀缓存 + catalog 常驻；其余推迟 |
| 限流与成本 | 主流 serverless 限流库**默认 fail-open**；模型供应商不设硬速率上限只会 429 | 高成本端点 fail-closed + 每日配额 + 调用前最坏成本预估 |
| 可观测 | OTel GenAI 语义约定未稳定（Schema URL 仍 TODO）；第三方平台可做看板 | 自建事件表为唯一真源，仅做导出适配；命名向 OTel 对齐 |
| 多租户 | RLS 与 grant 是两套检查（**加策略不收回授权**）；策略写法影响性能（`(select auth.uid())` + 索引） | 新表逐表 RLS + revoke + 索引；语料表与用户表分离授权 |
| Skill 形态 | 三层成本模型（描述常驻 / 正文按需 / 引用更按需）；Model Spec 的权威阶梯（Platform > Developer > User）；可视化编排在安全敏感路径被反复证明是负资产（Langflow/Dify CVE、n8n 自述 task runner "insecure by design"、OpenAI Agent Builder 关停） | §8：策略包 = 数据，控制流留代码，用户只能改偏好改不了闸 |
| RAG 与安全 | Bloomberg 研究：**RAG 反而降低安全性**，81.8% 的不安全回答来自"安全文档"；Intercom：检索范围必须靠**配置**而非提示词（"写不要用它"无效） | 直接支撑 ADR 0004 的三条不变量 + 检索范围配置化 + 语料视为不可信文本 |
| 持久执行 | 只有跨天 / 需人工审批暂停 / 需崩溃恢复才值得引入；Temporal 的"LLM 调用放在 Activity、重放复用结果"语义优于 LangGraph 的"重放会重跑节点" | V1 不引入工作流引擎 |
| 评测方法 | 区分 capability eval 与 regression eval；用 pass^k 而非 pass@k；反对"检查工具调用顺序"这类过刚判据；单次小样本测量结构上就是噪声 | 现有 scorer 保持事件断言；新增 pass^k 报告与路由混淆矩阵 |

### 12.1 本 RFC 因调研而修正的三处

1. **函数时长事实**：60s → **Hobby 300s / Pro 800s**（ADR 0002 记录的事实前提已过期，本 RFC 不据此改变交付形态的选择，只更新边界）。
2. **刷新恢复从"可接受"升级为"顺手修"**：§2 原判断（未落库即未发生）在"轨迹必须入库"之后不再成立 —— 事件表已给出重放能力。
3. **RLS 写法要求具体化**：加策略同时 revoke grant、策略列索引、`(select ...)` 包函数（§7）。

### 12.2 证据强度

上述来源以厂商文档、官方工程博客与厂商自测 benchmark 为主；厂商 benchmark 不可横向比较（Pinecone / Qdrant / ParadeDB 各有一套）。本 RFC 的决策**不依赖任何单一厂商基准**：单 Postgres、事件表重放、策略包 = 数据这三条，都能在移除全部外部参照后由本项目自身约束（单 agent、注入端口、确定性闸）独立推出。
