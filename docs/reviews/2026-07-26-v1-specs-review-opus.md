# V1.0 Spec 第三轮评审（Opus，2026-07-26）—— 以「直接开工 S1」为视角

> 输入：`docs/reviews/2026-07-26-v1-specs-review.md`（前两轮 + 修订记录 + 复审结论）视为已知，本文**只写新发现**。
> 方法：对照 `app/api/chat/route.ts`、`src/harness/{turn,loop,eventLog}.ts`、`src/lib/{supabase,proposalStore,auth}.ts`、`supabase/migrations/0001–0010`、`scripts/smoke-rfc0001-confirm.mts`、`app/chat/page.tsx` 逐条推演 RFC 0008 落地时会撞到什么。
> 四个视角：迁移 0011 能否跑通与自洽；逐条 await 的工程后果；S1 八张票的顺序与可测性；无依据的假设与更简单的等效做法。

---

## 阻断

### 1. `docs/rfc/0008` §4「写路径用用户态 client + insert 策略」→ 审计表对持 JWT 的任何客户端可写，且与仓库自己在迁移 0007 记下的教训相反

用户态 client 写 `turns`/`turn_events` 意味着必须 `grant insert ... to authenticated` 并配 `with check (user_id = auth.uid())`。这与 §4 同段的"必须 revoke 默认 grant"只能靠"revoke 后再 grant insert 回来"调和——而一旦 grant 回来，任何持有自己 JWT 的人都能绕过 Next.js 直接对 PostgREST `POST /rest/v1/turn_events`，往**自己的** turn 里插任意 `gate_verdict: pass`、改写 `turn_end`、预占 `(turn_id, seq)` 让服务端写入撞主键。不跨租户，但"轨迹 = 审计面 / 评测回放源 / RL 训练数据"（§1）四个身份里三个都要求**主体不可改写**——主体可写的审计不是审计。`supabase/migrations/0007_tighten_user_profile_writes.sql` 头注释已经记录了同一件事："0005 granted authenticated insert/update on user_profile, which let a browser client write constraints directly... The validated profile API (service-role, server-side) remains the sole write door"——项目已经为 `user_profile` 走过一次这个坑，`app/api/profile/route.ts:13` 已在用 `createServerSupabase()`。RFC 0008 §4"不扩散 service role"的前提（service role 只在迁移用）在代码里本来就不成立。

另一个后果：用户态 client 的 JWT 有效期是会话级的；turn 进行中 token 过期（`PGRST301`）会让尾部事件写失败 → 按 §3(6) 整轮 crash，且这不是"Postgres 级故障"。

**改法**（决定 #86 的 DDL，必须先定）：
- 写路径 = 服务端 service-role client（复用 `createServerSupabase`），`user_id` 由服务端从 `VerifiedSession.userId` 绑定，永不来自请求体。
- 迁移 0011：`revoke all on public.turns, public.turn_events from anon, authenticated; grant select on public.turns, public.turn_events to authenticated;` **不建任何 insert/update 策略**；只建 owner-only select 策略供 `GET /api/turns/:id/events` 走用户态 client + RLS。
- D9 测试加一条"伪造"断言：用户 B 的 JWT `insert into turn_events` → 期望 `42501 insufficient_privilege`（不是靠 RLS 拒，是根本没 grant）。
- 若坚持 ADD "unrestricted role exists in migrations only"的字面，替代是 `create role nutribuddy_trace_writer nologin` + 仅 insert/update 两表 + `grant ... to authenticator` + 服务端用 `SUPABASE_JWT_SECRET` 签一个 `role: nutribuddy_trace_writer` 的 JWT——多一套签名机制；V1.0 不值得，沿用 profile API 的 service-role 门即可，但要在 §4 写明"与 profile API 同一扇门"。

### 2. `docs/rfc/0008` §3(6) + §8 → "写失败 → typed error terminal（stopReason: crash）"与"turn() 完全不动"、"seq 由生成器分配"三者不可能同时成立；且生成器抛异常时根本没有终态事件

`seq` 由 `turn.ts:250 createEventMetadata` 的闭包在生成器**内部**分配；路由拿不到计数器。若 TraceStore 挂在路由的 `ReadableStream.start()` 里（这是 §8"路由只需替换装配"隐含的位置），写失败时路由无法合成一个带合法 `seq` 的 `turn_end`——只能发路由级 `{type:"terminal"}` 帧（不进 `turn_events`，不是 `AnyTurnEvent`）。此外 `runUtteranceTurn` 对 `gen.next()` 没有 try/catch（`turn.ts:930–1009`），adapter 抛错（如缺 `DEEPSEEK_API_KEY`）、`loop.ts:385` 的 abort `throw`，都让 `turn()` 以异常退出、**不产生 `turn_end`**——今天路由靠 `{type:"error"}` 帧兜底。S1 之后这条路径的结果是：`turns` 行永远 `finished_at is null`、无终态事件、重放接口回放到一半没有结尾——"每轮恰好一个终态事件"（ADD §Testing Seam）第一次变成持久化的谎言。

**改法**（决定 #87 的接口与 #88 的接线位置，必须先定）：
- 把 `TraceStore` 做成 **`TurnPorts` 上的可选端口**（与 `clock`/`proposalStore` 同级），由 `turn()` 在每次 `yield` 前 `await ports.traceStore?.append(event)`。这与 ADD"一切外部都经端口进入"一致，scripted 测试注入 `InMemoryTraceStore`，路由注入 Supabase 实现。§8"turn() 不动"改为"turn() 新增一个可选端口，事件 schema 不动"。
- 在 `turn()` 顶层加 try/catch：任何异常（含 traceStore 二次失败、abort、adapter 抛错）统一变成 `turn_end{stopReason:"crash"}`（`crash` 已在 `STOP_REASONS`），`seq` 正常分配，先尝试落库再 yield。这是本来就该有的 harness 不变量修复，顺手在 S1 做。
- `trace_persist_failed` 走两条线：① 服务端结构化 log（唯一可靠）；② 路由级 `terminal` 帧加字段（不改事件 schema）。`turns.persist_error` 保留但标注"尽力而为——DB 不可用时它本身也写不进去"。

### 3. `app/api/chat/route.ts:291–319` + `docs/rfc/0008` §5 → 客户端断连后 turn 处于什么状态，spec 没有决定；现有路由在断连时会把 turn 半途丢掉，D4 在真实断连场景下不成立

现状：客户端断开 → `ReadableStream` 被 cancel → 下一次 `controller.enqueue` 抛 `Invalid state`（`route.ts:294`）→ 进 catch → catch 里再 `enqueue` 再抛 → `start()` promise 未处理拒绝，生成器被扔在半途（进行中的模型调用照样计费）。路由也没有把 `request.signal` 传给 `ports.signal`。S1 之后：`turns` 行开着、事件写到断连那一刻为止、没有 `turn_end`。用户刷新后调 `?since=` 看到的是一个永远不结束的 turn。这正是 D4 声称要解决的场景。

同时 Vercel 的函数生命周期：响应结束（含被 cancel）后实例可被冻结，除非用 `waitUntil`（`@vercel/functions`，Next 14.2 无 `after()`）。所以"断连后服务端继续跑完"不是默认行为。

**改法**（二选一，写进 §3 决定）：
- **A（推荐，D4 才是真的）**：断连不影响 turn。`enqueue` 包一层 `try { } catch { clientGone = true }`，生成器消费到底、事件照常落库；用 `waitUntil(consumePromise)` 保住实例。代价：引入 `@vercel/functions`（与 §1.3"不引入新依赖"冲突，需在 §1.3 明写例外）。
- **B（零依赖）**：断连即中止。路由把 `request.signal` 传入 `ports.signal`；把 `loop.ts:385` 的 `throw` 改成返回 `stopReason: "aborted"` 的终态（`aborted` 已在 `STOP_REASONS` 但今天没有任何路径产生它），`turn()` 正常 yield `turn_end{aborted}` 并落库。D4 的语义收窄为"看到断连前的事件 + 一个 aborted 终态"，§9 D4 与 RFC 0007 D4 同步改写。
- 无论选哪个，都要删掉 RFC 0006 §2"顺带满足'用户点停止'和'多设备续看'"——前者需要一个 `POST /api/turns/:id/abort` 之类的服务端中止通道（新机制），后者需要第二台设备能发现 turnId（`listTurns` 有端口无接口，#91 只是脚本）；S1 两者都不交付。

---

## 应修

### 4. `docs/rfc/0008` §4 vs `docs/rfc/0006` §3 → `turn_events` 列集两处不一致；无 `user_id` 时 RLS 只能写子查询策略

RFC 0006 §3 写的是 `turn_events(user_id + session_id + turn_id + seq + ...)`，RFC 0008 §4 的 DDL 两个都没有。没有 `user_id`，owner-only select 策略只能写成 `using (exists (select 1 from public.turns t where t.id = turn_id and t.user_id = (select auth.uid())))`——与 0005/0014 所有表的策略形状不同，也让 #122 的 prune、D9 的直查都要绕 join。

**改法**：`turn_events` 加 `user_id uuid not null`（服务端从 session 绑定，与 `turns.user_id` 相同），策略统一为 `using ((select auth.uid()) = user_id)`；索引 `(user_id, turn_id)` 可省（主键 + turns 索引够用）。同步 RFC 0006 §3 或 0008 §4，二者取一为准。

### 5. `docs/rfc/0008` §4 `turns.session_id text not null` → 请求里根本没有 session id，这一列在第一行 insert 就会失败

`ChatRequestBody`（`src/lib/chatApi.ts`）三种 body 都没有 sessionId；`route.ts:201 new EventLog(sessionUserId)` 里的"session"其实是 userId。§12.2 未决 3 写的"目前随请求携带"不成立。

**改法**：V1.0 `session_id` 改为 nullable 且不填；§12.2 未决 3 改为"V1.0 不建会话概念，`listTurns(userId)` 按 `started_at` 排序即可；IM bot 接入时再定"。#91 的"按 session 导出"改为"按 user / 日期 / turnId 导出"。

### 6. `docs/rfc/0008` §5「首个事件携带 turnId」+ §8「事件 schema 完全不动」→ 二者只能靠路由级帧调和，spec 没写

`TurnStartEvent` 没有 turnId 字段；加进去就是 schema 变更（要 bump，而 #108 在 S4 还要 bump 一次 → 两次 golden 迁移）。

**改法**：路由在 `turn_start` 之前发一个**路由级**帧 `{type:"turn_meta", turnId, schema}`（与现有路由级 `terminal`/`error` 帧同类，不进 `turn_events`，不占 seq）；重放接口不需要重发它（客户端已持有 turnId）。§5 表加一行写明"turn_meta 是路由级帧，不是 AnyTurnEvent"。

### 7. `docs/rfc/0008` §3(6)「重试一次」→ 没有定义可重试边界、没有超时、23505 会被当失败

- supabase-js 的 fetch 无默认超时：DB 半死时"await 写入"会挂到函数上限（300s）而不是失败。
- 首次写入实际成功但响应丢失 → 重试撞 `(turn_id, seq)` 主键 → `23505` → 按现 spec 判为失败 → 整轮 crash，而行明明在。
- 哪些错误该立刻 fail：`23503`（turns 行不存在——写入顺序 bug）、`42501`（权限——配置 bug）、`22P02`（payload 非法）；哪些该重试一次：网络错误、`502/503/504`、`57014` statement timeout。

**改法**：写入用 `insert ... on conflict (turn_id, seq) do nothing`（服务端是唯一写者，冲突只可能来自自己的重试）；每次写入带 `AbortSignal.timeout(5000)`；错误分类表写进 §3(6)：`23505` = 成功；`23503/42501/22P02` = 立刻 crash；其余 = 重试一次。#90 的测试表按这四类各一条。

### 8. `docs/rfc/0008` §3(6)「把错误写进 turns.persist_error」→ 写失败的原因正是 DB 不可用，这一列在需要它的时候写不进去

**改法**：见阻断 #2 第三点；§3(6) 改为"服务端 log 为准，`persist_error` 尽力而为"。

### 9. issue #121 → "依赖 on delete cascade：proposals / meal_logs 随之一并删除"不成立；DoD 用被删用户的 JWT 去查是空验证

`proposals.user_id`（0004）、`meal_logs.user_id`（0002）、`user_profile.user_id`（0001）**都没有指向 `auth.users` 的外键**，`meal_logs.proposal_id` 也只是 text。`auth.admin.deleteUser` 之后三张表的行原样留下——`user_profile.medications` 就在其中。DoD"以该用户身份查 proposals / meal_logs / turns 均为空"必然通过：用户没了、JWT 没了、当然查不到，但行还在。

**改法**：① #121 范围加"迁移 0015：为三张老表加 `foreign key (user_id) references auth.users(id) on delete cascade`（先 `delete` 孤儿行，`smoke-rfc0001-confirm.mts` 创建又删除的临时用户很可能已经留下了）"，或在删账号脚本里用 service role 显式先删三表再删 auth 用户；② DoD 改为用 service role 查 `select count(*) from meal_logs where user_id = $deleted` = 0，三表各一条。

### 10. issue #120 → "revoke 默认 grant，再按需要显式 grant"如果不精确到列，会打断 confirm 路径；DoD 缺 `npm run smoke:confirm`

`proposals` 由用户态 client 直接 `insert`（`src/lib/proposalStore.ts:201`）；`commit_proposal_and_insert_meal` / `void_proposal` 是 **`security invoker`**（0009/0010），以调用者权限跑，需要 `authenticated` 持有 `update on proposals` + `insert on meal_logs`。revoke 后必须一字不差地 grant 回：`select` 三表、`insert, update on proposals`、`insert on meal_logs`。#120 现在的 DoD"现有 RLS 相关测试全绿"是单测（fake client），测不到 grant。

**改法**：#120 范围写死 grant 清单；DoD 加 `npm run smoke:confirm` 必须通过（它是仓库里唯一走真实 grant 的测试）。

### 11. `docs/rfc/0007` D2 / issue #86 DoD「空库重放全部迁移」→ 仓库没有任何迁移 runner，这条 DoD 没有可执行形式

无 `supabase/config.toml`，无 CLI 配置；迁移是手工贴进 Dashboard SQL Editor（`smoke-rfc0001-confirm.mts:95–107` 的提示就是这么写的）。`scripts/apply-harness-schema.sql`（未跟踪）是 0001–0009 的手工拼接，已落后 0010 一版——它是第二真源且已经漂了。另外 0008 的 `create role nutribuddy_query_ro nologin` 不可重入（角色无 `if not exists`），非空库重放必失败。

**改法**：① #86 的 DoD 改为可执行命令：`for f in supabase/migrations/*.sql; do psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || exit 1; done` 对一个一次性 scratch 项目跑；② 删除 `scripts/apply-harness-schema.sql` 或改成由脚本生成（`cat supabase/migrations/*.sql`），不再手工维护；③ 0008 的 `create role` 用 `do $$ begin if not exists (select 1 from pg_roles where rolname='nutribuddy_query_ro') then create role ...; end if; end $$;` 修一下，否则"空库"以外永远跑不通。

### 12. `docs/rfc/0006` §1 / `docs/rfc/0008` §2「serverless 上写本地盘 = 丢数据」→ 实际是每个 utterance turn 立刻 500，#88 必须**删除** `EventLog` 而不是"保留给 CLI"

`eventLog.ts:defaultAppend` 是 `mkdirSync("traces") + appendFileSync`，无 try/catch；`loop.ts:345` 第一步就 `record({type:"user_message"})`；Vercel 的 `/var/task` 只读 → `EROFS` 同步抛出 → 穿过 `turn()` → 路由 `{type:"error"}`。今天的代码直接部署 = 全部对话失败。而 `EventLog` 只有 `route.ts:201` 一处实例化，CLI（`src/cli.ts`）默认不建它，没有任何测试引用它的词表。

**改法**：#88 范围明写"从路由删除 `new EventLog`，`eventLog` 端口传 undefined"；#113 的依赖里点名 #88（而不是笼统的 S1–S4）；RFC 0008 §3.2"EventLog 保留为 CLI/测试的本地适配器"改为"EventLog 无消费者，S1 删除路由引用，文件留待清理"。

### 13. issue #87 / `docs/rfc/0008` §3.3「FileTraceStore（CLI）」→ 没有消费者，且"包住现有 EventLog 语义"与"CLI 行为不变"互斥

CLI 今天不写任何轨迹文件；"行为不变"= 继续不写，"FileTraceStore 给 CLI"= 开始写；`AnyTurnEvent` JSONL 与 `EventLog` 的七种事件词表也不是一回事。

**改法**：#87 收窄为 `TraceStore` 接口 + `InMemoryTraceStore` + 契约测试；FileTraceStore 删除。要给 CLI 加轨迹文件，另开票并说明谁读它。

### 14. `docs/rfc/0008` §3.3 `finishTurn(turnId, result: TurnResult)` → `TerminalResult` 没有 cost / latency，`turns.cost_usd / latency_ms` 按这个签名填不出来；S3 #98 依赖这两列

`TerminalResult`（`types.ts`）只有 reply/steps/stopReason/output/proposal/…；cost 分散在每条 `model_call.costUsd`（含 regenerate 的多次尝试），latency 是 `turn_start.timestamp → turn_end.timestamp`。

**改法**：见建议 #20（SQL 里算）；若不采纳，则 `finishTurn` 改签名为 `finishTurn(turnId, summary: { stopReason, steps, costUsd, latencyMs })`，由 `SupabaseTraceStore` 在 `append` 时累加。#98 的依赖标注为"#88 完成且 cost 累加有测试"。

### 15. `docs/rfc/0008` §5「客户端只存 turnId + lastSeq（沿用现状）」→ 现状什么都不存；React state 刷新即空，D4 的"刷新后"前提不成立

`app/chat/page.tsx` 没有任何 `localStorage/sessionStorage`；`messages`、`turnId` 都在 `useState`。刷新后客户端没有 turnId 可用来调 `?since=`。而且即使拿到，整段对话历史也没了——重放会在一个空聊天里渲染出一个没有用户提问的助手回合。

**改法**：§5 明写"`turnId + lastSeq` 存 `sessionStorage`（按 tab），turn_end 到达后清除"；并决定刷新后的呈现：只重放最后一个未完成 turn，且把 `turn_start.input` 渲染为用户消息（重放流里有它）。#89 的范围与 DoD 相应补充。

### 16. `docs/rfc/0008` §6「事件数 4–30 行/turn」→ 没算 regenerate；最坏情况约 4×

每步 thought/act/observe 3 条 + model_call 1 + tool 闸 1 = 5 条；8 步 = 40；每次尝试再加 4 条 output 闸；`MAX_OUTPUT_GATE_RETRIES = 2` 即最多 3 次尝试 → ≈ 3×44 + 4 ≈ 136 条。这个数字是 §3(6)"逐条 await 可忽略"与 §6 存储估算共同的基数。

**改法**：§6 改为"典型 10–30，上限 ~140（3 次尝试 × 8 步）"，并让复审结论里要求的延迟量化按上限算。

### 17. `docs/rfc/0008` §3(6)「写入失败是本地 Postgres 级故障，频率极低」→ 与 ADR 0002 记录的 Supabase Free「7 天不活动即暂停、唤醒约 30s」相抵触

唤醒期间每次写都超时。现状里这次失败会更早发生在 `loadUserContext`（503），所以 turn 本身不会 crash——但这意味着"极低"是被前面的读挡住的巧合，不是写路径的性质。

**改法**：把这句改为"依赖 Free 计划暂停后的首个请求由 safety context 读先行失败；写路径本身用 #7 的超时保护"，并把"唤醒后首次请求慢一次"写进 #115 的隐私/使用说明。

---

## 建议

### 18. `docs/rfc/0008` §4 + §3.3 → `startTurn` 与 `append(turn_start)` 合并为一次写，消灭"有 turns 行无事件"的孤儿态

外键要求 `turns` 行先于 seq 0 存在。若路由先 `startTurn` 再跑 `turn()`，`turn()` 在起步就抛（`ports.signal` 已 aborted、装配失败）会留下空 turns 行。

**改法**：一个 RPC `append_turn_event(p_turn_id uuid, p_user_id uuid, p_event jsonb)`：`type='turn_start'` 时先 `insert into turns (...)`（版本字段从 `p_event` 与参数取）再插事件；其余类型直接 `insert ... on conflict do nothing`。`startTurn` 从接口删掉。

### 19. `docs/rfc/0008` §3.3 → `finishTurn` 同理并入 `append(turn_end)`，终态原子化

两次写（先事件后 `update turns`）之间失败会留下"有 turn_end 事件但 `finished_at is null`"的状态，与"还在跑"不可区分。

**改法**：同一个 RPC 里 `type='turn_end'` 分支做 `update turns set finished_at = now(), stop_reason = p_event->'result'->>'stopReason', steps = (p_event->'result'->>'steps')::int`。

### 20. `turns.cost_usd / latency_ms` 在 SQL 里从事件算，TS 不维护第二份聚合

`cost_usd = (select coalesce(sum((payload->>'costUsd')::numeric), 0) from turn_events where turn_id = p_turn_id and type = 'model_call')`；`latency_ms = extract(epoch from (turn_end.timestamp - turn_start.timestamp)) * 1000`。单一真源，#98/#93 直接读列。

### 21. `docs/rfc/0008` §4 → `payload` 应是完整 `AnyTurnEvent`（含 schema/seq/timestamp），列是副本

否则 §7"落库等价"测试要先把列拼回去；重放接口也要拼。写明 `payload = event` 原样，`select payload` 即重放行。顺带把 `turn_events.schema` 改名 `schema_version`，与 `turns.schema_version` 一致。

### 22. `docs/rfc/0008` §3.5 重放接口「空/404」→ 二选一

`turns` 行对用户不可见（RLS 空）→ 404；可见但 `since` 之后无事件 → 200 空流。写死，客户端才好区分"turn 不是你的"和"还没新事件"。

### 23. `app/api/chat/route.ts` 流式消费逻辑抽成可注入函数，否则 D4 / #90 没有单测形式

把 `start()` 里的"消费生成器 → 落库 → enqueue"抽成 `driveTurn(gen, traceStore, sink, signal)`，vitest 用 `InMemoryTraceStore` + 假 sink：消费到第 k 条后 sink 抛错 → 断言 turn 仍跑完、`listByTurn(id, k)` 返回 seq > k 的其余事件且与全量一致；traceStore 在 seq k 抛一次 → 重试成功；抛两次 → `turn_end{crash}`。

---

## S1 开工顺序（八张票：#86–#91、#120、#122）

前提：阻断 #1–#3 三个决定写进 RFC 0008 后再动 #86/#87。

| 批次 | 票 | 可并行 | 隐藏依赖 / 备注 |
| --- | --- | --- | --- |
| 0 | 决定 #1–#3（改 RFC 0008 §3、§4、§5、§8） | — | 半天文档工作，不是研究 |
| 1 | #86（迁移 0011）、#120（迁移 0014） | 互相并行 | #120 的 DoD 必须含 `npm run smoke:confirm`（应修 #10）；两者都需要一个 scratch 项目跑 D2（应修 #11） |
| 1 | #87（接口 + InMemory + 契约测试） | 与批次 1 并行（不碰 DB） | 收窄掉 FileTraceStore（应修 #13）；接口按建议 #18/#19 只剩 `append / listByTurn / listTurns` |
| 2 | #88（Supabase 实现 + 端口接入 turn() + 路由改造） | 依赖 #86 #87 | 必须删除 `new EventLog`（应修 #12）；turnId 生成在这里而不是 #89；#90 的重试/超时/错误分类在这里**设计**、在 #90 测试；`app_version` 在 #114 之前为 null，写明 |
| 2 | #122（prune 脚本） | 与 #88 并行（只依赖 #86） | — |
| 3 | #89（turn_meta 帧 + sessionStorage + 重放路由） | 依赖 #88 | 客户端改动比票面大（应修 #15）；重放 404/空二选一（建议 #22） |
| 3 | #90（失败语义测试） | 依赖 #88 | 四类错误各一条（应修 #7）+ 断连一条（阻断 #3） |
| 3 | #91（导出脚本） | 依赖 #88 | 去掉"按 session"（应修 #5） |

**可执行的 DoD 形式**（票里现在都是文字，补成命令/断言）：

- #86：`for f in supabase/migrations/*.sql; do psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -f "$f"; done` 退出码 0；`select count(*) from information_schema.role_table_grants where table_name in ('turns','turn_events') and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'` = 0；`select relrowsecurity from pg_class where relname in ('turns','turn_events')` 全 true。
- D3（#88）：`select min(seq) = 0 and max(seq) + 1 = count(*) and bool_or(type = 'turn_end') from turn_events where turn_id = $1` = true。
- D9（#86/#89）：新增 `scripts/smoke-rfc0008-trace.mts`，照 `smoke-rfc0001-confirm.mts` 建两个临时用户；service role 为 A 写一个 turn；`createUserSupabase(tokenB).from('turn_events').select('*').eq('turn_id', id)` → 0 行；`createUserSupabase(tokenB).from('turn_events').insert({...})` → error code `42501`；结束删两个用户并用 service role 确认三张老表无残留（顺便验证应修 #9）。
- D4（#89）：建议 #23 的单测 + 一次真人操作：发话 → 第 2 个 step 事件后刷新 → 页面出现同一 turn 的后续事件与终态。
- #90：`InMemoryTraceStore` 注入 `failAt: { seq: 3, times: 1 }` → turn 正常结束且 `listByTurn` 完整；`times: 2` → `turn_end.result.stopReason === "crash"` 且路由 `terminal` 帧含 `trace_persist_failed: true`；`code: "23505"` → 视为成功；`code: "23503"` → 不重试直接 crash。
- #122：注入时钟 `now = 2026-11-01`，插入 `started_at` 为 2026-07-01 与 2026-10-01 两行，`--dry-run` 输出 1，`--apply` 后 `turns` 剩 1 行、其 `turn_events` 仍在、另一 turn 的事件级联消失。

---

## Top 3

1. **阻断 #1（写者身份）**：用户态 client 写审计表 = 主体可伪造轨迹，与迁移 0007 记录的教训和 ADD 的 scoped-writer 模型都相反；这决定 #86 的每一条 grant/policy，不先定就得重做迁移。
2. **阻断 #2（TraceStore 的位置 + 异常收尾）**：seq 在生成器里、终态要带 seq、异常路径今天就没有终态——TraceStore 只能做成 `turn()` 的端口并顺手给 `turn()` 加顶层 catch，否则 S1 会把"每轮恰好一个终态事件"变成第一批持久化的反例。
3. **阻断 #3（断连生命周期）**：现有路由在断连时把 turn 丢在半途；不先在"continue + waitUntil"与"abort 终态"之间二选一，D4 的验收在真实断连场景下不可能通过。

**结论**：S1 **不能按现在的 spec 直接开工**——缺的不是新研究，是三个半天内能写完的决定（写者身份、端口位置与异常收尾、断连语义）。它们直接决定 #86 的 DDL 和 #87 的接口，先动手就是返工。三个决定落进 RFC 0008 之后，#86 与 #120 可以立刻并行开工，其余按上表批次推进；应修 #4–#17 大多可在对应票内顺手吸收，不需要再开一轮评审。
