# S1 落地评审记录（Opus，2026-09-13）—— #123 / #88 / #90

> 输入：本轮实现的两个变更集（stage A = #123 迁移可重放；stage B = #88/#90 轨迹落库与 turn 接线）。
> 方法：`claude -p --model opus` 两轮：先评审未提交的 diff，作者修完后**复审同一 diff**（复审提示词逐条列出上一轮发现，要求给出 addressed/partial/not-addressed 与证据）。
> 结论：stage A `pass-with-nits`，stage B 第一轮 `blocked` → 修复后复审 `pass-with-nits`。以下只记评审意见中**有行为后果**的部分与处理结果；纯风格项从略。

---

## 一、复审发现（有行为后果者）与处理

### 阻断（stage B 第一轮）：`p_meta` 键名与 RPC 契约不一致

`SupabaseTraceStore` 发的是 `app_version` / `source_version`，而迁移 0011 用 `p_meta->>'appVersion'` 读（RFC §3.4 即如此写），`InMemoryTraceStore` 绑定的是 `opts.meta.appVersion`。后果：#114 之后每一行的 `turns.app_version` 都会是 NULL 而**不报任何错**，正是 §3.4 加粗警告的静默兜底；单测当时还把错误的键名钉死了，所以永远绿。

**处理**：`metaPayload` 改发 camelCase；单测断言改为 `{ appVersion, sourceVersion }`。**真机验证**：本地栈上跑一次真实 turn（`meta: {appVersion: "1.0.0-test", sourceVersion: "usda-2026-01"}`）→ `select app_version, source_version from turns` 返回 `1.0.0-test|usda-2026-01`。

### 应修：错误分类对着真实 postgrest-js 是死代码

评审读了 `node_modules/@supabase/postgrest-js` 的实现：`rpc()` 是 POST，不在其内部重试的方法表里；失败 fetch 被**转成 resolve** 的 `{ error: { code: "" }, status: 0 }`，HTTP 状态在响应对象上而不在 error 上。因此原实现里 `catch (err)`、`err.name === "TimeoutError"`、`error.status === 502-504` 三条分支在生产都不会命中，真实超时会被记成 `08006`（重试结论碰巧一致，但码与日志是错的）；假 client 用 reject 模拟，把不存在的形状"演活了"。

**处理**：`write()` 持有本次写入的 `AbortSignal`，超时由 `signal.aborted` 判定；HTTP 状态从响应读；假 client 改为按 postgrest-js 的形状 resolve。另经复审追加：**带 SQLSTATE 的响应优先于"信号恰好已 abort"**（否则超时窗口内的真实完整性冲突会被误判为可重试），并各有用例。`PGRST001/PGRST002`（PostgREST 连接池/ schema cache，503）按 RFC §3.7 的 5xx 类处理为可重试。

### 应修：trace store 构造失败时客户端被告知"没有丢失"

`trace?.persistFailed ?? false` 在 store 不存在（例如漏配 `SUPABASE_SERVICE_ROLE_KEY`）时报"一切正常"，与 §3.6"该标志必须经路由级终态帧到达客户端"相悖。

**处理**：改为 `?? true`；构造失败本身有结构化 log。

### 应修：放弃写入没有服务端日志

§3.6 把"服务端结构化 log"列为唯一可靠通道，而原实现只在重试前打 log，两处 `giveUp` 都是静默 throw；终态自身写失败（`turn()` 里被吞掉以免递归）因此完全没有记录。

**处理**：新增 `giveUp()`，两条放弃分支都写结构化 log（turnId / seq / code / message）。

### 应修：CLI 行为回退

`turn()` 的异常契约改变后，CLI 漏配 key 时从"打印原因 + exit 1"变成"通用句子 + exit 0"。

**处理**：CLI 注入 `crashReply` 把原因写 stderr，并在 `stopReason === "crash"` 时 `return 1`；用户可见文案仍是 harness 的默认句（不再有第二份字面量）。补 `tests/cli.test.ts` 用例钉住退出码与 stderr。

### 应修：`src/harness/` 出现 `console.*` 默认值

**处理**：`SupabaseTraceStoreOptions.log` 改为必填；`src/harness/` 下无 console。

### 应修（stage A）：断言可能空通过

首版 `verify-migrations.sh` 只证明"reset 没报错"，不证明"每个文件都被应用"；头注释用"grant 断言会空通过"论证环境选择，脚本里却没有 grant 断言。

**处理**：断言改为对磁盘与终态比对——`supabase_migrations.schema_migrations` 的行数必须等于 `supabase/migrations/*.sql` 的文件数，且每个文件的版本号都必须出现；再断言 5 张表、`append_turn_event`、`query_*` 的 owner、执行角色**不再**持有 `public` 的 CREATE、RLS 打开、用户态角色对两表无读写且不能执行 RPC、运行中的 Postgres 大版本等于 `config.toml` 的 `major_version`。**反向探针**：`grant insert on public.turn_events to authenticated` 后同一断言块立即 raise（`0011: the trace surface is reachable by a user-facing role`），revoke 后恢复。

### 应修（stage A）：`grant create on schema public` 在终态多余

评审指出 CREATE 只是**转移 owner 时**的前置，SECURITY DEFINER 运行期只需要 USAGE + SELECT；首版注释的辩护不成立。

**处理**：六条 `alter function ... owner to` 之后 `revoke create on schema public from nutribuddy_query_ro;`，注释改写为"转移期临时权限"；脚本断言其终态为假。`grant nutribuddy_query_ro to current_user` 保留——它同时是运行角色后续 `create or replace` / `revoke` / `grant execute` 的前提。

### 应修（stage A）：手工 schema 路径仍在

`scripts/smoke-rfc0001-confirm.mts` 仍教人"粘贴到 Dashboard SQL Editor"。

**处理**：改为 `supabase link` + `supabase db push`；并写明手工建过的项目需要一次性 `migration repair --status applied 0001 … 0008`（**只到 0008**：该分支正是因为 0009 缺失才走到，0010 又是 `create or replace` 同一个函数，把 0009/0010 标成 applied 会让历史撒谎且 smoke 依旧 BLOCKED——这条是复审发现的、由上一版提示词引入的错误引导）。

---

## 二、实现中发现、由测试兜住的三个真实缺陷

1. **事件流本来就有洞**：`createTurnModelCallEvent` 在去重判断**之前**分配 seq，多步 turn 会分配一个永不被 yield 的 seq。D3 的 `max(seq)+1 = count(*)` 对此直接判否。修法：去重判断前置。这条同时说明"每处 `nextMetadata()` 后紧跟 yield"是流无缝的**结构性**保证。
2. **崩溃终态丢失步数**：crash 结果原写 `steps: 0`，而 issue #21 要求"崩溃可区别于零步完成"。修法：包装层跟踪流中最大的 `agentEvent.step`。
3. **turn_start 之前的崩溃无行可收尾**：RPC 对未知 turn 的非 start 事件 raise `23503`，因此 body 在首个事件前抛出时**不写任何东西**（不伪造一行 `turns`），客户端仍拿到恰好一个终态事件。

---

## 三、未闭合项（不阻塞本轮交付）

| 项 | 状态 | 归属 |
| --- | --- | --- |
| `supabase/config.toml` 的 `major_version = 17` 未对 hosted 项目核对 | 已在文件内标注 UNVERIFIED；本轮无法核对（hosted 直连为 IPv6，本机不可达，pooler 区域未知）。需在 Dashboard 跑一次 `show server_version` | #113（部署）前必须闭合 |
| `turns.persist_error` 仍无写者 | RFC §3.6 定位为"尽力而为"，`giveUp` 目前只打 log。要么在 store 里补一次 best-effort update，要么删列 | 后续票或 RFC 修订 |
| `package-lock.json` 的无关抖动 | npm 版本差异（`name` 由 `workspace` 变目录名、`@emnapi/*` optional 条目增减、多处 `peer: true`）。锁文件仍与 `package.json` 一致，`npm ci` 可用 | 保持现状 |
| "断连后仍消费到底"的 `enqueue` 抛错分支 | 测试只能到达 `cancel()` 路径；该分支覆盖"平台把流置为 errored 而未调 cancel"的形态，已按此写入注释 | — |

---

## 四、真机证据（本地 Supabase 栈）

- `bash scripts/verify-migrations.sh` → 退出 0，0001–0011 按序应用，`Postgres 17.6`，含全部终态断言。
- 真实 turn（scripted adapter，非模型调用）经 `SupabaseTraceStore` 落库：8 条事件 seq 连续 `0..7`；`select min(seq)=0 and max(seq)+1=count(*) and count(*) filter (where type='turn_end')=1` → `t`；落库 payload 与流出的 `AnyTurnEvent` 逐条相等（jsonb 键序不敏感比较）；另一用户 store 读同 turn → 空数组（RLS/owner 过滤）；`turns` 行 `end_turn|1|0.000000|63ms`；`p_meta` 的 camelCase 键使 `app_version`/`source_version` 正常落库。
- `npm test` 55 文件 / 1044 用例全绿；`npm run typecheck` 绿。
