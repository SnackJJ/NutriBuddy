# 第四轮：核实第三轮处置的落实质量（Opus，2026-07-26）

> 对照 `docs/reviews/2026-07-26-v1-specs-review-opus.md` 的阻断 #1–#3、应修 #4–#17、建议 #18–#23。
> 核实对象：`docs/rfc/0008`（整篇重写）、`docs/rfc/0006` §1/§2、`docs/rfc/0007` D2/§4、issue #86–#91、#113、#120、#121、#123（`gh issue view` 实际正文）。open issue 数 38（37 + #123）。
> 判定口径：改动是否解决原问题、章节引用是否指向正确内容、是否引入新的不一致。已落实的只给判断，不复述。

---

## 已落实

| # | 项 | 判断 |
| --- | --- | --- |
| 阻断 #1 | 写者身份 | **已定**。0008 §3.3 改为 service-role 写 + `revoke all` 后仅 `grant select` + 不建 insert/update 策略，引用 0007 迁移作先例；§7/§9/#86 加了「用户态 insert → `42501`」断言。仅剩 RPC 的 execute 授权未写（见有偏差 A1，五分钟补丁）。 |
| 阻断 #2 | 端口位置 + 顶层 catch | **已定**。§3.2 把 `TraceStore` 放进 `turn()` 端口、明确 seq 由生成器分配是唯一约束；§3.6 顶层 catch → `turn_end{crash}`；§8 废止了「turn() 完全不动」；#88 正文与之一致。 |
| 阻断 #3 | 断连语义 | **已定为 A**。§3.5 写明 `waitUntil` 是新依赖的例外、V1.0 不做主动停止与多设备续看；0006 §2 同步删除了「顺带满足」并指向 0008 §3.5，两处一致。 |
| 应修 #4 | `turn_events.user_id` | 已加列（`not null`，服务端绑定），策略统一为 `(select auth.uid()) = user_id`；#86 写明「必须含 user_id」。 |
| 应修 #5 | `session_id` 无来源 | 改为可空且 V1.0 不填（§4、§12.1）；#91 去掉了「按 session 导出」。 |
| 应修 #6 | turnId 帧 | §5 定为路由级 `turn_meta` 帧，不占 seq、不落库；#89 一致。 |
| 应修 #7 | 重试边界 | §3.7 表：5s 超时、`on conflict do nothing`、`23505`=成功、`23503/42501/22P02`=立刻 crash、网络类重试一次；#88/#90 逐条对应。 |
| 应修 #8 | `persist_error` 写不进去 | §3.6 改为「服务端 log 为准，列尽力而为」。 |
| 应修 #9 | #121 级联假象 | #121 改为迁移 0015 加三表外键 + 先删孤儿行 + service role 验证三表计数为 0。 |
| 应修 #10 | #120 grant 清单 | 一字不差列出（三表 select；proposals insert/update；meal_logs insert），说明了 security invoker 的原因，DoD 含 `npm run smoke:confirm`。 |
| 应修 #12 | EventLog EROFS | 0006 §1 表、0008 §2/§8、0007 §4、#113 四处都改为「#88 是 #113 的真实前置」；#88 范围含删除 `new EventLog`。 |
| 应修 #13 | FileTraceStore 无消费者 | §3.2/§8/#87 正文均删除。 |
| 应修 #14 | finishTurn 填不出 cost/latency | 并入 RPC，在 SQL 聚合（§3.4）；#86 写明「TS 不维护第二份聚合」。 |
| 应修 #15 | 客户端不存 turnId | §5 定 sessionStorage + 刷新后只重放最后一个未完成 turn + `turn_start.input` 渲染为用户消息；#89 一致。 |
| 应修 #17 | 「写失败极低」无依据 | §3.7 改写为「被读路径挡住的巧合」，并要求写进 #115 用户说明。 |
| 建议 #18/#19 | startTurn/finishTurn 并入 append | §3.2 端口只剩三个方法，§3.4 一个 RPC 三个分支；#87 一致。 |
| 建议 #20 | 聚合在 SQL 里算 | §3.4 已写。 |
| 建议 #21 | payload = 完整事件、列名 `schema_version` | §4 已改；#86 一致。 |
| 建议 #22 | 重放 404/空流 | §5 写死；#89 一致。 |
| 建议 #23 | 抽 `driveTurn` 便于单测 | §9 D4、#89 DoD 已采用。 |
| （附带） | `docs/rfc/0009` §4 | 已加「轨迹写入延迟」一行，与 0008 §6 的要求闭合。 |

---

## 有偏差

### A1. `docs/rfc/0008` §3.4 / issue #86 → RPC `append_turn_event` 没写 security 模式与 execute 授权（**新引入**，阻断 #1 的最后一块）

Postgres 函数默认 `EXECUTE` 授予 `PUBLIC`，PostgREST 会把它暴露给 `anon`/`authenticated`。若按仓库里 0008 查询模板的先例写成 `security definer`，持 JWT 的用户就能绕过刚 revoke 掉的表权限直接调 RPC 写审计表——阻断 #1 关上的门从函数口子重新打开。§3.3、§4、#86 只讲了表级 revoke，一个字没提函数。

**改法**：§3.4 与 #86 各加一行：`security invoker`（写入靠 service role 自身的表权限，不需要 definer）+ `revoke all on function public.append_turn_event(uuid, uuid, jsonb) from public, anon, authenticated; grant execute on function ... to service_role;`。§7「授权」行与 D9 smoke 各加一条：用户态 `rpc('append_turn_event', ...)` → 权限错误。

### A2. `docs/rfc/0008` §3.4 → RPC 签名装不下 `turns` 的元数据列（**新引入**，建议 #18/#20 的落实不完整）

`append_turn_event(p_turn_id, p_user_id, p_event)`：`turn_start` 分支能从 `p_event` 取到 `input.tag`、`catalogVersion`、`schema`，但 `app_version`、`session_id`、`skill_id/skill_version`、`source_version` 都不在事件里。§4/§8 写「`app_version` 在 #114 之前为 null」——按这个签名，#114 之后也永远是 null。

**改法**：签名加第四个参数 `p_meta jsonb default '{}'`（`appVersion`、`sourceVersion`、`skillId`、`skillVersion`），`SupabaseTraceStore` 构造时绑定；§3.4、#86 同步。

### A3. `docs/rfc/0008` §3.4 → `turn_events.user_id` 与 `turns.user_id` 没有一致性约束（应修 #4 的落实留了口子）

级联靠 `turn_id → turns` 外键成立，prune 与 RLS 都成立——这部分自洽。但 RPC 对非 `turn_start` 事件若直接写 `p_user_id`，一处装配 bug 就会造出「事件对 A 可见、turn 属于 B」的行。

**改法**（二选一）：RPC 里非 start 分支的 `user_id` 从 `turns` 行取（不信 `p_user_id`），或加 `unique (id, user_id)` 于 `turns` + `foreign key (turn_id, user_id) references turns(id, user_id)` 于 `turn_events`。前者更省。

### A4. `docs/rfc/0007` D2 / issue #86 DoD → 那条 shell 命令源码不可直接跑，且「scratch 库」的前提没有说清（应修 #11 落实不完整；**新引入**）

- 0007 §2 表格里写的是 `\|\| exit 1`——Markdown 渲染正确，但从源码复制出来的 `\|\|` 在 bash 里是三个字面 `|`、`exit`、`1` 当作 psql 的多余参数，不会在首个失败处停下。#86 正文的同一条命令没有转义，是对的。
- `exit 1` 写在 for 循环里，交互式粘贴会直接关掉当前 shell。
- 更根本：`0005` 的策略引用 `auth.uid()`，`0011` 的外键引用 `auth.users`——**vanilla Postgres 在 0005 就会失败**。scratch 必须是带 Supabase 基线的库。而一个复用的 Supabase 项目又不是「空库」：`create policy`（0005）、`create table`（0011 无 `if not exists`）、`create role`（cluster 级，`drop schema` 清不掉）二次执行都会失败；若用 `drop schema public cascade` 清库，Supabase 挂在 schema 上的 `alter default privileges`（给 anon/authenticated 的默认 grant）会一起被删——之后 `revoke` 变成空操作，#86 的 `role_table_grants ... = 0` 断言**在与生产不同的环境里空通过**，恰好测不到它要测的东西。
- #123 与 0008 §11 T1 对「谁负责 scratch 重放」分工相反（T1 写自己做，#123 写自己做）。

**改法**：① D2 改为 `bash scripts/verify-migrations.sh` 退出码 0，不在表格里内嵌 shell；② #123 写死 runner = Supabase CLI 本地栈（`supabase init` 生成 `config.toml` + `supabase start` + `supabase db reset` 后按序 `psql`），这是唯一同时具备 `auth` schema、默认 privileges、可真正清零的环境；脚本拒绝 `SCRATCH_DB` 指向生产 project ref；③ 0008 §11 T1 删掉「scratch 库重放校验」，归 #123。

### A5. `docs/rfc/0008` §4「D2 的可执行形式见 §9」、§7「执行 §9 的命令」→ §9 里没有任何迁移命令（**新引入**的悬空内引用）

§9 只有 D3/D4/D9。命令实际在 0007 D2 与 #86/#123。**改法**：两处改为「见 `docs/rfc/0007` D2 / issue #123」。

### A6. `docs/rfc/0008` §3.5 与 `docs/rfc/0006` §2 → 引用的「§1.3『不引入新依赖』」已不存在（**新引入**）

0008 §1.3 被改成「不引入新的**控制流**」，但 §3.5 与 0006 §2 仍说 `waitUntil` 是「§1.3『不引入新依赖』的例外」。**改法**：§1.3 恢复为「不引入新依赖（唯一例外 `@vercel/functions`，见 §3.5）」，或把两处引用改成「本 RFC 唯一新增的运行时依赖」。

### A7. `docs/rfc/0006` §3 表、§10 步骤 1 → 两处旧表述没跟着 0008 改（**新引入**的跨文档不一致）

- §3：`turn_events` 列集仍写 `user_id + session_id + ...`，而 0008 §4 的 `turn_events` 没有 `session_id`（它只在 `turns` 上，且 V1.0 为 null）。
- §10 步骤 1：仍写「`EventLog` 落库端口（替换 fs 写入，**保留 fs 适配器给 CLI**）」，与 0008 §8「不实现 FileTraceStore、删路由引用」相反。

**改法**：§3 列集改为 `turn_id + user_id + seq + schema_version + type + payload + created_at`；§10 步骤 1 改为「`TraceStore` 端口进 `turn()`，删除 `EventLog`」。

### A8. `docs/rfc/0008` §6 → 单次写入延迟「1–5ms」是无依据数字（应修 #16 只落实了事件数）

supabase-js 的 RPC 是一次 HTTPS 往返到 PostgREST（不是本地 pg 连接）；同区域含 TLS 复用也在 20–50ms 量级。按 §6 自己的上限 140 条，worst case 是 3–7s 而非 0.15–0.7s——「相对秒级模型延迟可忽略」这个结论被前提预先决定了。**改法**：把数字改成 20–50ms/次、worst 3–7s、典型 20 条 ≈ 0.4–1s，并保留「实测校准 + 不回批量」的表述；结论改为「典型情况可接受，上限情况需看 0009 的分位」。

### A9. issue #90 → 「用 `InMemoryTraceStore` 的 `failAt` 注入即可覆盖」测错了层

`23505/23503/42501/22P02` 的分类逻辑按 §3.7 住在 `SupabaseTraceStore`（它读 PostgREST 的 error code）。往 `InMemoryTraceStore` 里注入 `code` 要么测不到真实分类代码，要么得把分类复制进内存实现（第二份真源）。**改法**：#90 拆两层——分类与超时用 `SupabaseTraceStore` + 假 `client.rpc`（返回 `{ error: { code } }` / 挂起触发 `AbortSignal.timeout`）；`turn()` 对「append 抛一次/抛两次」的反应用 `InMemoryTraceStore` 的 `failAt: { seq, times }`（不带 code）。

### A10. issue #88 / #89 / #90 → 同一条「断连后 turn 仍消费到底」断言写在三张票里

#88 DoD、#89 DoD（`driveTurn` 单测）、#90 范围各出现一次。**改法**：只留 #90（失败语义票）；#89 的 `driveTurn` 单测只断言重放集合相等（D4），#88 DoD 只留 D3 查询。

### A11. issue #87 标题仍是「内存/**文件**实现」

正文已删 FileTraceStore，标题没改。**改法**：`gh issue edit 87 --title "[S1] TraceStore 端口 + 内存实现 + 契约测试"`。

### A12. `docs/rfc/0008` §3.2 → `turn()` 从哪拿 `turnId` 没写

`append(turnId, event)` 要求 `turn()` 持有 turnId，「随端口传入」但没说字段名；#88 也只说「注入端口」。**改法**：§3.2 明写 `TurnPorts.turnId?: string`（与 `catalogVersion` 同级），或让 `SupabaseTraceStore` 构造时绑定 turnId、端口签名改为 `append(event)`——后者少一个参数，且 `InMemoryTraceStore` 也不需要知道 turnId。

### A13. `docs/rfc/0008` §3.6 → 顶层 catch 里的落库再失败没说怎么办

catch 产生 `turn_end{crash}` 并「尝试落库」；这次 append 若再抛，不能再进 catch（否则递归）。属实现细节，但 #88 是 AFK 票，应写一句：「catch 内的 append 用 try/catch 吞掉，仅打 log 并让路由 `terminal` 帧带 `trace_persist_failed`」。

---

## 遗漏

### M1. 0008 §11 T8（`scripts/smoke-rfc0008-trace.mts`，D9 的伪造与越权断言）没有 issue

#86 的「验收」栏写了 D9，但它的 DoD 只有 grant/RLS 的静态查询；#90 明说「无需真 DB」。RFC 0007 D9「用另一账号的 JWT 查询 D3 的轨迹返回空」和第三轮要求的「用户 B insert → 42501」在 backlog 里没有任何一张票承接。**改法**：新建 `[S1] scripts/smoke-rfc0008-trace.mts：D9 越权 + 伪造断言`（依赖 #86、#88；`enhancement, ready-for-agent`；DoD 照 0008 §9 D9），并把 A1 的 RPC 调用断言加进去。

### M2. 0008 §11 没有「轨迹导出脚本」这一行，而 #91 指向的「§T6 附带」是另一张票

§11 重写后 T6 = turn_meta/客户端/重放（对应 #89），导出脚本从表里消失；#91 引用「§T6 附带」与「§12.1」都指不到导出的规范。**改法**：§11 补一行 `T9 轨迹最小查询面（脚本导出 JSON/MD，按 user/日期/turnId）| T4`；#91 的引用改为 §T9。

### M3. `docs/rfc/0008` §11 / issue #123 → 0005 与 0011 的「可重放」本身没有被任何 DDL 保证

即使 runner 到位（A4），`0005` 的 `create policy` 与 `0011` 的 `create table` 都不是幂等的；「空库重放」对真正空库成立，对「跑过一半再跑」不成立。这与 0007 D2 的字面一致，但 #123 的脚本若不先 `supabase db reset`，第二次运行必红。**改法**：#123 的脚本第一步固定为 reset（本地栈）——A4 已包含；这里只是把「幂等不是目标、reset 才是」写进 #123 正文，避免有人去给 0005 加 `if not exists`。

---

## 四项专门检查的结论

| 检查 | 结论 |
| --- | --- |
| §3.4 RPC 与 §4 DDL 自洽（`turn_events.user_id` 无外键、级联靠 `turns`、RLS 与 prune） | **成立**：级联链 `auth.users → turns → turn_events` 完整，prune 删 `turns` 即可，owner-only select 策略按 `user_id` 直查。残留两点：RPC 的 execute 授权未写（A1）、两列一致性无约束（A3）。 |
| §3.2 端口形状 vs §11 vs #86–#91 | **对齐**（三方法、无 start/finish、无 FileTraceStore）。偏差：#87 标题（A11）、turnId 传递方式（A12）、§11 缺导出行 + #91 指错（M2）、T8 无票（M1）、T1 与 #123 分工相反（A4③）。 |
| 0007 D2 命令与 0006 的 waitUntil 表述 | D2 源码里 `\|\|` 不可直接粘贴，且 scratch 环境前提未说清（A4）；waitUntil 在 0006 §2 与 0008 §3.5 **一致**，但两处共同引用了已不存在的 §1.3 措辞（A6）。 |
| issue 引用的章节号 | #86/#87/#88/#89/#90/#113/#120/#121/#123 全部指向正确内容；#122 的 §12.1 仍可达（12.1 首条指回 §3.8），建议改指 §3.8；#91 指错（M2）。 |

---

## 结论

**三个决定可以视为已定**：写者身份（service-role 写、用户态只读）、端口位置（`TraceStore` 进 `turn()` + 顶层 catch）、断连语义（决定 A + `waitUntil`）在 0008 正文、0006 §1/§2、0007 §4 与 #86/#88/#113 之间已经闭合，没有互相打架的表述。剩下的偏差里只有 **A1（RPC 的 execute 授权）** 会改变 #86 的 SQL 内容，其余是引用修正、分工归属、测试分层和一张漏建的票。

**S1 可以开工。第 1 步的确切动作**：先给 #86 追加一行范围——`append_turn_event` 为 `security invoker`，`revoke all on function ... from public, anon, authenticated; grant execute ... to service_role`，并加 `p_meta jsonb` 参数（A1、A2）——然后写 `supabase/migrations/0011_turns_trace.sql`（两表 DDL、RLS select-only、revoke/grant、RPC 三分支、`0008` 的 `create role` 幂等修复）。与之并行、不阻塞第 1 步的两件事：把 #123 的 runner 写死为 Supabase CLI 本地栈（A4，否则 #86 的 grant 断言会空通过）；建 T8 的 smoke 票（M1，否则 D9 没有 owner）。
