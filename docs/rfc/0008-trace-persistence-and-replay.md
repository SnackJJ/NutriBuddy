# RFC 0008 — 轨迹持久化与 turn 重放（S1 spec）

> 状态：**Proposed**（2026-07-26；经第三轮评审修订，依据 `docs/reviews/2026-07-26-v1-specs-review-opus.md` 的阻断 #1–#3 与应修 #4–#17）。
> 关联：`docs/rfc/0007` §3 S1（验收 D3/D4/D9）、`docs/rfc/0006` §2/§3/§7、`docs/rfc/0003` T3（权威事件面）、`supabase/migrations/0007`（写者身份的既有先例）。
> 对应 issue 草稿见 §11。

## 1. 目标

1. 每个 turn 的**权威事件流落库**，同时承担四个身份：审计面、评测回放源、自进化归因输入、未来 RL 训练数据。
2. turn 成为**可查询、可重放的持久对象**：断连/刷新后不丢不重。
3. 不引入新的**控制流**：轨迹写入是端口旁路，不进闸门判定。**唯一新增的运行时依赖是 `@vercel/functions` 的 `waitUntil`**（§3.5 说明它为何不可避免）。

## 2. 现状与证据（决定后面每一条的形状）

- `turn.ts:48` 已有 `SCHEMA_VERSION = "1.9.0"`，事件只有五种：`turn_start` / `step` / `gate_verdict` / `model_call` / `turn_end`，每条已带 `schema` / `seq` / `timestamp`。
- **`seq` 由生成器内部的闭包分配**（`turn.ts:250` 的 `createEventMetadata`，`let seq = 0`）——路由拿不到计数器。这一条直接决定端口位置（§3.2）。
- `app/api/chat/route.ts:291` 把流以 NDJSON 推给客户端，无持久化。
- **断连会把 turn 丢在半途**：客户端断开 → `controller.enqueue` 抛 `Invalid state` → 进 catch → catch 里再 enqueue 再抛 → 生成器被扔下（进行中的模型调用照样计费）；`request.signal` 也没有传进 ports。
- **`turn()` 没有顶层 try/catch**（只有两处局部 try）：adapter 抛错（如缺 key）、`loop.ts` 的 abort `throw` 都让它以异常退出，**不产生 `turn_end`**；今天靠路由的 `{type:"error"}` 帧兜底。S1 之后这意味着 `turns` 行永远 `finished_at is null`。
- **`EventLog` 写相对目录 `traces`**（`mkdirSync` + `appendFileSync`，无 try/catch），而 `loop.ts:345` 第一步就 `record({type:"user_message"})`。在 Vercel 上 cwd 是只读的 `/var/task` → `EROFS` 同步抛出 → 所有 utterance turn 失败。**今天部署即全挂**，这是 #113 的真实依赖。
- `EventLog` 只有 `route.ts:201` 一处实例化；CLI（`src/cli.ts`）不建它，测试也不引用它的七类词表 → **它没有消费者**。
- 两套事件词表并存（turn 流 vs EventLog 的 `model_call|tool_call|tool_result|user_message|agent_response|error|gate_block`）。RFC 0003 T3 已把 Tracer 降级为 debug 旁路，本 RFC 执行同一判决：**权威轨迹 = turn 流**。
- 无 trace 表；**仓库没有任何迁移 runner**（无 `supabase/config.toml`，迁移靠手工贴 Dashboard），未跟踪的 `scripts/apply-harness-schema.sql` 已落后一版，且 `0008` 的 `create role` 不可重入。

## 3. 决定

### 3.1 权威轨迹 = `AnyTurnEvent` 流

落 `turn_events`；轮级元数据落 `turns`。`EventLog`（JSONL）不是第二真源，也不保留为"CLI 适配器" —— **它没有消费者**（§8）。

### 3.2 `TraceStore` 是 `turn()` 的端口，**不在路由层**

三个约束同时成立只有一种放法：`seq` 在生成器内部产生、终态事件必须带合法 `seq`、异常路径也必须留下终态。因此：

- `TraceStore` 作为可选端口挂在 turn 端口集上（与 `clock` / `proposalStore` 同级），由 `turn()` 在**每次 `yield` 之前** `await ports.trace?.append(event)`（`turnId` 在构造 store 时绑定，turn() 不自己持有）。
- 这与 ADD「一切外部都经端口进入」一致；scripted 测试注入 `InMemoryTraceStore`，服务端注入 Supabase 实现。
- `turnId` 由**装配层生成**（uuid），并在**构造 TraceStore 时绑定**（`readonly turnId`），端口方法只需 `append(event)`；事件 schema 里不加 `turnId` 字段（避免一次多余 bump，#108 在 S4 还要 bump 一次）。
- 端口形状（`startTurn` / `finishTurn` 都不需要，见 §3.4 的 RPC）：

```ts
export interface TraceStore {
  /** 构造时绑定，turn() 不需要自己持有 turnId。 */
  readonly turnId: string;
  /** turn_start 建 turns 行、turn_end 收尾，都在这一次写内完成（§3.4）。 */
  append(event: AnyTurnEvent): Promise<void>;
  listByTurn(turnId: string, sinceSeq?: number): Promise<AnyTurnEvent[]>;
  listTurns(userId: string, limit: number): Promise<TurnSummary[]>;
}
```

### 3.3 写者身份：服务端 service-role，用户态**不可写**

用户态 client 写审计表意味着要 `grant insert ... to authenticated`，于是任何持自己 JWT 的人都能绕过 Next.js 直接 `POST /rest/v1/turn_events`，为自己伪造 `gate_verdict: pass`、改写 `turn_end`、预占 `(turn_id, seq)` 让服务端写撞主键。不跨租户，但"审计面 / 回放源 / RL 数据"三个身份都要求**主体不可改写**。

这不是新论证，是仓库已经付过学费的结论：`0007_tighten_user_profile_writes.sql` 头注释写着「Migration 0005 granted authenticated insert/update on user_profile, which let a browser client write constraints directly... The validated profile API (service-role, server-side) remains the sole write door」。

- 写路径 = `createServerSupabase()`（service role），`user_id` 由服务端从 `VerifiedSession.userId` 绑定，**永不来自请求体**。
- 迁移 0011：`revoke all on public.turns, public.turn_events from anon, authenticated;` 然后 `grant select`（仅供读取）。**不建任何 insert/update 策略。**
- 读路径仍走用户态 client + owner-only select 策略（`GET /api/turns/:id/events`）。
- 将来若要独立 writer role（ADD 的 scoped-writer 字面），替代方案是 `create role nutribuddy_trace_writer nologin` + 仅 insert 两表 + 服务端签带 `role` 的 JWT；V1.0 不值得多一套签名机制，但 §8 要写明"与 profile API 同一扇门"。

### 3.4 一次写内完成建行与收尾（RPC）

外键要求 `turns` 行先于 `seq 0` 存在；两次写（先事件后 update）之间失败会留下"有 turn_end 事件却 `finished_at is null`"的状态，与"还在跑"不可区分。因此写入统一走一个 RPC：

```sql
append_turn_event(p_turn_id uuid, p_user_id uuid, p_event jsonb, p_meta jsonb default '{}')
-- type='turn_start'：insert into turns (..., app_version, source_version, skill_id, skill_version)
--                    values (..., p_meta->>'appVersion', ...) on conflict do nothing; 再插入事件
-- type='turn_end'  ：插入事件后 update turns set finished_at=now(),
--                    stop_reason=..., steps=..., cost_usd=<聚合>, latency_ms=<时间差>
-- 其余类型        ：user_id 从 turns 行取（不信 p_user_id）；insert ... on conflict do nothing
```

- **`p_meta` 参数是必需的**：`app_version` / `source_version` / `skill_id` / `skill_version` 都不在事件里，只靠 `p_event` 取不到 —— 否则 #114 之后 `app_version` 仍然是 null。由 `SupabaseTraceStore` 构造时绑定。
- **非 `turn_start` 分支的 `user_id` 从 `turns` 行读，不用 `p_user_id`**：否则一处装配 bug 就能造出"事件对 A 可见、turn 属于 B"的行。
- **函数权限必须显式收口**（`docs/reviews/2026-07-26-v1-specs-review-opus-verify.md` A1）：写成 **`security invoker`**（写入靠 service role 自身的表权限，不需要 definer），并且 Postgres 默认把 `EXECUTE` 授予 `PUBLIC` —— 必须显式 `revoke execute on function public.append_turn_event(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;` 再 `grant execute ... to service_role;`。否则阻断 #1 关上的门会从函数口子重新打开。

- `cost_usd` 由 SQL 从 `turn_events` 聚合（`type='model_call'` 的 `costUsd` 求和，含 regenerate 的多次尝试）；`latency_ms` 由 `turn_end.timestamp - turn_start.timestamp` 计算。**TS 侧不维护第二份聚合** —— 单一真源，S2/S3 直接读列。
- `append` 因此是"一次 RPC 调用"，天然原子。

### 3.5 断连语义（决定 A：断连不影响 turn）

- `enqueue` 包一层：客户端不在时置 `clientGone = true` 并继续消费生成器，事件照常落库。
- 用 `waitUntil`（`@vercel/functions`）保住实例，直到生成器消费完 —— 它是**本 RFC 唯一新增的运行时依赖**（§1.3），理由：产品核心场景是"吃完饭掏手机记一笔"（ADR 0002），锁屏/切后台断连不能吃掉整轮答案。若不愿引入该依赖，退路是 B（断连即中止 + `stopReason: "aborted"` 终态），但必须同时改写 D4 的语义。
- V1.0 **不做**"用户主动停止"（需要新的中止通道与接口），也**不做**多设备续看（需要 `listTurns` 的接口，S1 只给端口与脚本）。RFC 0006 §2 里"顺带满足这两点"的表述据此删除。
- `request.signal` 在 V1 不用于中止 turn；写入自带超时（§3.7）。

### 3.6 异常必须有终态：`turn()` 加顶层 catch

任何异常（adapter 抛错、abort、traceStore 二次失败）统一转成 `turn_end{stopReason:"crash"}`（`crash` 已在 `STOP_REASONS`），`seq` 正常分配，并在 `yield` 前尝试落库。这是本来就该有的 harness 不变量修复，顺手在 S1 做 —— 否则"每轮恰好一个终态事件"会成为第一批持久化的反例。

`trace_persist_failed` 走两条线：① 服务端结构化 log（唯一可靠）；② **路由级** `terminal` 帧带 `trace_persist_failed: true`（不改事件 schema）。`turns.persist_error` 保留，但标注"尽力而为 —— DB 不可用时它本身也写不进去"。

**catch 内的 append 必须再包一层 try/catch 并吞掉**（只打 log），否则二次抛错会递归；此时唯一可靠的信号是路由级帧与 server log。

### 3.7 写入的失败语义：超时、幂等、错误分类

| 项 | 决定 |
| --- | --- |
| 超时 | 每次写入带 `AbortSignal.timeout(5000)`（supabase-js 的 fetch 默认无超时，DB 半死会挂到函数上限） |
| 幂等 | `insert ... on conflict (turn_id, seq) do nothing` —— 服务端是唯一写者，冲突只可能来自自己的重试 |
| `23505`（唯一冲突） | **视为成功**（首次其实写成功但响应丢失） |
| `23503` / `42501` / `22P02` | **立刻 crash**：分别是 turns 行不存在（顺序 bug）、权限（配置 bug）、payload 非法 |
| 网络错误 / `502/503/504` / `57014` | 重试一次；仍失败 → `turn_end{crash}` |

不再声称"写入失败频率极低"：Supabase Free 计划 7 天不活动暂停后有约 30s 唤醒窗口，期间每次写都会超时。今天这次失败会先发生在 `loadUserContext`（503），属于被读路径挡住的巧合；写路径要靠上面的超时保护。这条"唤醒后首个请求慢一次"也应写进 #115 的用户说明。

### 3.8 保留策略：全保真 + 90 天（已决定）

- payload **全保真**（回放与 RL 需要），**保留 90 天**滚动删除，**导出必须脱敏**。
- 落地：`scripts/prune-traces.ts` 按月手动执行（不引入 pg_cron），README 写明节奏；删除粒度按 `turns.started_at`，`turn_events` 随外键级联。若 90 天被证明太短，改法是给 `turns` 加 `locked_until` 标记，而不是取消清理。

## 4. 数据模型（迁移 0011）

```sql
create table public.turns (
  id              uuid primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  session_id      text,                   -- V1.0 不填（见 §12）
  input_kind      text not null,
  app_version     text,                   -- #114 之前为 null
  catalog_version text,
  source_version  text,
  schema_version  text not null,
  skill_id        text,                   -- V1.1 预留
  skill_version   text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  stop_reason     text,
  steps           int,
  cost_usd        numeric(10,6),
  latency_ms      int,
  persist_error   text
);

create table public.turn_events (
  turn_id        uuid not null references public.turns(id) on delete cascade,
  user_id        uuid not null,            -- 服务端绑定，与 turns.user_id 相同
  seq            int  not null,
  schema_version text not null,
  type           text not null,
  payload        jsonb not null,           -- 完整 AnyTurnEvent（含 schema/seq/timestamp）
  created_at     timestamptz not null default now(),
  primary key (turn_id, seq)
);

create index turns_user_time_idx on public.turns (user_id, started_at desc);
-- turn_events 不需要额外索引：主键 (turn_id, seq) 已给出同列同序的唯一索引
```

- **`turn_events.user_id` 是必须的**：没有它，owner-only select 策略只能写成对 `turns` 的子查询，形状与 0005/0014 所有表都不同，也让 prune 与直查都要绕 join。策略统一为 `using ((select auth.uid()) = user_id)`。
- **RLS 与授权**：两表 `enable row level security`；`revoke all ... from anon, authenticated` 后 `grant select`；**不建 insert/update 策略**（写入走 service role，§3.3）。
- **既有表的回填不在本次**：三张老表（proposals / meal_logs / user_profile）的 `revoke` 与 `(select auth.uid())` 写法由**迁移 0014** 单独跟踪（RFC 0006 §7 第 4 条，issue #120）。
- **迁移可重放**：仓库目前没有 runner，D2 的可执行形式见 `docs/rfc/0007` D2 与 issue #123（scratch 环境必须是**带 Supabase 基线的本地栈**：`0005` 的策略引用 `auth.uid()`、`0011` 的外键引用 `auth.users`，vanilla Postgres 在 `0005` 就会失败）。同时修 `0008` 的 `create role` 为 `do $$ ... if not exists ... $$`（否则重放必失败），并停用未跟踪且已落后的 `scripts/apply-harness-schema.sql`。
- **重放靠 reset，不靠幂等**：`0005` 的 `create policy`、`0011` 的 `create table` 都不是幂等的。"空库重放"对真正空库成立，对"跑过一半再跑"不成立 —— 所以校验脚本第一步固定为 `supabase db reset`，**不要**去给老迁移加 `if not exists`。另注意：用 `drop schema public cascade` 清库会连 Supabase 挂在 schema 上的 default privileges 一起删掉，`revoke` 于是变成空操作，grant 断言会在与生产不同的环境里**空通过**。

## 5. 客户端契约

| 项 | 契约 |
| --- | --- |
| 发话 | `POST /api/chat`（不变） |
| turnId | 由装配层生成；路由在开始消费生成器**之前**发一个**路由级**帧 `{ "type": "turn_meta", "turnId", "schema" }` —— 它不是 `AnyTurnEvent`，不占 `seq`，不落库（与现有路由级 `terminal` / `error` 帧同类） |
| 客户端状态 | `turnId + lastSeq` 存 **sessionStorage**（按 tab），收到 `turn_end` 后清除（现状什么都不存，刷新即失，D4 的"刷新后"前提不成立） |
| 刷新后的呈现 | 只重放**最后一个未完成**的 turn；把 `turn_start.input` 渲染为用户消息（重放流里有它），避免在一个空聊天里渲染出没有提问的助手回合 |
| 重放接口 | `GET /api/turns/:id/events?since=<seq>` → NDJSON；**turns 行对用户不可见 → 404；可见但 `since` 之后无事件 → 200 空流**（客户端据此区分"不是你的 turn"与"还没有新事件"） |
| 不做 | 用户主动停止；多设备续看（需要 `listTurns` 的接口，本切片只给端口与脚本 #91） |

## 6. 容量与性能

- **事件数**：典型 **10–30 行/turn**；**上限约 140**（3 次尝试 × 8 步 × 5 条 + 4 条输出闸 ≈ 136），这是 §3.7 与存储估算共同的基数。第二版初稿写的"4–30"没算 regenerate，偏低。
- **payload**：全保真（§3.8）。
- **量级**：每天 20 turn × 20 事件 × ~1KB ≈ 400KB/天 ≈ 150MB/年 → Supabase Free 500MB 单用户一年内安全。
- **延迟假设（需实测校准）**：逐条 `await` 把一次 **PostgREST RPC 往返**（不是本地 pg 连接；同区域含 TLS 复用也在 20–50ms 量级）放进每个事件推给客户端的路径上。典型 20 条 ≈ **0.4–1s**；按上限 140 条 worst case 约 **3–7s**。相对秒级的模型延迟仍可接受，距 300s 函数上限更远，而且 3 次 regenerate 的上限本身很少出现 —— 但这仍是**假设**：S1 落地后必须能在报告里分清"模型慢"还是"DB 慢"（`docs/rfc/0009` §4 的"轨迹写入延迟"一行），上限情况看那里的分位再决定。若实测显示它吃掉了 step 事件流 masking latency 的效果，退路是把"推客户端"与"落库"流水线化（写库在下一事件产生前完成），**不是回到批量缓冲**。

## 7. 测试

| 测试 | 断言 |
| --- | --- |
| 端口契约 | 同一组断言跑 `InMemoryTraceStore`（唯一内存实现） |
| 迁移 | `bash scripts/verify-migrations.sh` 退出码 0（Supabase 本地栈 + reset，见 `docs/rfc/0007` D2 与 #123） |
| 落库等价 | 落库的 `payload` 与 `turn()` 流出的 `AnyTurnEvent` 逐条相等（复用 `canonicalizeTurnEvents` 中和时间戳与 cost 噪声） |
| 单终态 + 无缺口 | `select min(seq)=0 and max(seq)+1=count(*) and count(*) filter (where type='turn_end')=1 from turn_events where turn_id=$1` 为真 |
| 重放 | `since=k` 只返回 `seq>k`；重复调用结果一致；不可见 turn → 404，可见但无新事件 → 200 空流 |
| 授权 | 用户态 select 自己的 → 有行；**用户态 insert → `42501`（不是 RLS 拒）**；他人 JWT select → 0 行；**用户态 `rpc('append_turn_event', ...)` → 权限错误**（函数 EXECUTE 已从 PUBLIC 收回） |
| 失败语义 | 四类错误各一条（§3.7）：`23505`=成功、`23503/42501/22P02`=立刻 crash、网络类=重试一次；超时用注入的假 client |
| 断连 | 注入的 sink 在第 k 条后抛错 → turn 仍消费到底、事件完整、`listByTurn` 与全量一致 |
| 异常路径 | adapter 抛错 / abort → 仍有 `turn_end{crash}` 且已落库 |
| prune | 注入时钟：`started_at` 90 天前/内的两轮 → dry-run 报 1，apply 后剩 1 且其事件级联保留 |

## 8. 迁移与兼容

- `turn()` 新增**一个可选端口** + 顶层 catch；**事件 schema 不变**（原"路由只需替换装配、`turn()` 完全不动"的表述据此废止 —— 端口必须进 `turn()`，见 §3.2）。
- 路由改造：**删除 `new EventLog(...)`**（`eventLog` 传 undefined），`eventLog.ts` 文件留待清理；**不实现 `FileTraceStore`**（无消费者，"包住现有 EventLog 语义"与"CLI 行为不变"本就互斥）。
- `app_version` 在 #114 之前为 null；`session_id` 一律 null（§12）。
- 事件 schema 升级时：`turns.schema_version` + 每行 `schema_version` 保证混合历史可读。

## 9. DoD（对应 RFC 0007 D3/D4/D9，附可执行形式）

- **D3**：`select min(seq)=0 and max(seq)+1=count(*) and bool_or(type='turn_end') from turn_events where turn_id=$1` → true；保留策略按 §3.8 且 `scripts/prune-traces.ts --dry-run` 可用。
- **D4**：§7 的驱动函数单测（建议抽 `driveTurn(gen, traceStore, sink, signal)` 以便 vitest 注入）+ 一次真人操作：发话 → 第 2 个 step 事件后刷新 → 页面出现同一 turn 的后续事件与终态。
- **D9**：新增 `scripts/smoke-rfc0008-trace.mts`（照 `smoke-rfc0001-confirm.mts` 建两个临时用户）：service role 为 A 写一轮 → B 的 JWT `select` 得 0 行、`insert` 得 `42501`、`rpc('append_turn_event', ...)` 得权限错误；结束删两个用户并用 service role 确认三张老表无残留。
- `npm test` + `npm run typecheck` 绿。

## 10. 实现顺序

1. 迁移 0011（含 RPC）+ RLS/revoke + 0008 的 `create role` 幂等修复 + scratch 库重放校验
2. `TraceStore` 端口 + `InMemoryTraceStore` + 契约测试
3. `turn()` 接入端口 + 顶层 catch（`turn_end{crash}`）
4. `SupabaseTraceStore`（RPC、超时、幂等、错误分类）+ 路由改造（删 `EventLog`、断连继续消费 + `waitUntil`、`turn_meta` 帧）
5. `GET /api/turns/:id/events` + 客户端 sessionStorage 与刷新恢复
6. `scripts/prune-traces.ts`

## 11. Tickets（草稿 → issue）

| # | 内容 | 依赖 |
| --- | --- | --- |
| T1 | 迁移 0011：`turns` / `turn_events`（含 `user_id`）+ RPC（`security invoker` + 显式函数授权 + `p_meta`）+ RLS select-only + revoke/grant + 0008 幂等修复 | — |
| T2 | `TraceStore` 端口（`append`/`listByTurn`/`listTurns`）+ `InMemoryTraceStore` + 契约测试（**无 FileTraceStore**） | T1 |
| T3 | `turn()` 接入端口（yield 前 await）+ 顶层 catch → `turn_end{crash}` | T2 |
| T4 | `SupabaseTraceStore`（RPC/超时/幂等/错误分类）+ 路由改造（删 `EventLog`、断连继续消费 + `waitUntil`、`turn_meta` 帧） | T1 T3 |
| T5 | 失败语义测试：四类错误 + 超时 + 断连 + 异常路径 | T4 |
| T6 | `turn_meta` 帧 + 客户端 sessionStorage + 刷新恢复 + 重放路由（404/空流二选一写死） | T4 |
| T7 | `scripts/prune-traces.ts`（90 天，dry-run 默认） | T1 |
| T8 | `scripts/smoke-rfc0008-trace.mts`（D9 的伪造与越权断言，含 RPC 授权） | T1 T4 |
| T9 | 轨迹最小查询面：脚本按 user / 日期 / turnId 导出 JSON/MD（不做 UI） | T4 |

## 12. 决定与未决

### 12.1 已决定

- 保留策略：全保真 + 90 天 + 导出脱敏（§3.8）。
- `session_id`：**V1.0 不建会话概念**，该列保持 null；`listTurns(userId)` 按 `started_at` 排序即可；IM bot 接入时再定。原"目前随请求携带"的说法不成立（请求体里没有 sessionId）。

### 12.2 未决

1. **是否把 `step` 事件里的 observation 全量落库**：体积主因，也是回放价值来源。建议先落，观察体积再决定压缩。
2. **是否一次性导入历史 `traces/*.jsonl`**：建议不导。
3. **`eventLog.ts` 的最终处置**：S1 先删路由引用，文件是直接删除还是保留为未使用（留给清理票）。
