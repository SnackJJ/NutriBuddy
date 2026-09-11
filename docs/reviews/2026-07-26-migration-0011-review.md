# 静态审查：迁移 0011（commit 1cbf757）

> 对象：`supabase/migrations/0011_turns_trace.sql`（200 行）+ `0008_query_templates_sql.sql` 的 `create role` 幂等块。
> 规范：`docs/rfc/0008` §3.3 / §3.4 / §4 / §9。
> 前提：**未对任何数据库执行过**；下面每条都是按 PostgreSQL 15+/Supabase 语义静态推演，标了行号或函数名，改法可直接粘贴。因为 0011 还没在任何库上应用过，改法应**直接改 0011 本身**，不要另开 0012。

---

## 阻断

**无。** 语法与类型静态推演全部通过（见文末"逐项核对"）；权限模型闭合；三条分支的状态机没有找不到行、没有非幂等的重放路径。下面的应修都是"现在改五行比 #88 做到一半再改便宜"，不是"不改就跑不起来"。

---

## 应修

### 1. L123–L155 `append_turn_event` → `turn_start` 撞 `on conflict (id) do nothing` 时，事件行的 `user_id` 仍取 `p_user_id`，不是 `turns` 行的 owner

L144 `v_owner := p_user_id` 在 turns 行**已存在**（重试、或 uuid 被另一个 turn 占用）时照样执行；else 分支专门防的"事件对 A 可见、turn 属于 B"在 start 分支被绕过。重试场景下两者相等，无害；但这个函数的价值就是让"不可能不一致"成为 DDL 级保证，而不是靠调用方守约。

**改法**（替换 L123–L155 为一条路径：先 insert-or-noop，再统一从 `turns` 取 owner，start 分支额外校验一致）：

```sql
  if v_type = 'turn_start' then
    if v_seq <> 0 then
      raise exception 'append_turn_event: turn_start must have seq 0, got %', v_seq
        using errcode = '22P02';
    end if;

    insert into public.turns (
      id, user_id, session_id, input_kind, app_version, catalog_version,
      source_version, schema_version, skill_id, skill_version, started_at
    ) values (
      p_turn_id, p_user_id, null,
      p_event->'input'->>'tag',            -- 见应修 3：缺失时已在上面 raise
      p_meta->>'appVersion', p_event->>'catalogVersion', p_meta->>'sourceVersion',
      v_schema, p_meta->>'skillId', p_meta->>'skillVersion', v_ts
    )
    on conflict (id) do nothing;
  end if;

  -- 唯一的 owner 来源：turns 行。start 分支的 on-conflict 与非 start 分支走同一条路。
  select t.user_id into v_owner from public.turns t where t.id = p_turn_id;

  if v_owner is null then
    raise exception 'append_turn_event: unknown turn %', p_turn_id
      using errcode = '23503';
  end if;

  if v_type = 'turn_start' and v_owner <> p_user_id then
    raise exception 'append_turn_event: turn % belongs to another user', p_turn_id
      using errcode = '23514';   -- check_violation：不可重试，见 #88 分类（建议 2）
  end if;
```

### 2. L94–L95 → service_role 的表权限全靠 Supabase 的 default privileges，迁移里没有显式 grant

`revoke all ... from anon, authenticated` **不会**碰 service_role（REVOKE 只作用于列出的 grantee），这一点是对的。但 service_role 之所以有 insert/update，是因为 `postgres` 建表时 `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO ... service_role` 生效——第四轮评审已经指出：在 `drop schema public cascade` 后重建的 scratch 库里这些 default privileges 不存在，于是 RPC 在 scratch 里会 `42501`、在生产里正常，测试结果误导。另外 `turns.persist_error` 是 app 用 service role 直接 `update` 写的（RPC 不写它），同样依赖这条隐式 grant。

**改法**（L95 之后追加，让迁移自描述、与环境无关；对已有 default grant 幂等）：

```sql
-- Explicit, environment-independent: the RPC (security invoker) and the
-- best-effort persist_error update both run as service_role.
grant select, insert, update, delete on public.turns, public.turn_events to service_role;
```

### 3. L113 / L114 / L133 → 三处 `coalesce` 把畸形 payload 静默"修好"，与 §3.7「`22P02` = payload 非法，立刻 crash」相反

- L113 `coalesce(p_event->>'schema', 'unknown')`：`schema_version` 是重放 / golden / 混合历史可读性的键（§8）。一行 `'unknown'` 对版本感知的读者等于不可读，而它绝不会被 §3.7 的分类捕获——因为函数没报错。
- L114 `coalesce(nullif(...)::timestamptz, now())`：`latency_ms` 用 `v_ts - turn_start.timestamp`；turn_end 缺 timestamp 时用 DB 时钟减注入时钟，得到一个看似合法的错数。
- L133 `coalesce(p_event->'input'->>'tag', 'utterance')`：`input` 缺失、为 JSON `null`、为字符串时，`->>` 都返回 SQL NULL 而不报错（已核：`'null'::jsonb ->> 'tag'` 与 `'"x"'::jsonb ->> 'tag'` 均为 NULL），于是一律记成 `utterance`。

每条 `AnyTurnEvent` 在 TS 里这三个字段都是必填，缺失只可能是 bug。让它像 L118 一样 raise，分类器才能按 §3.7 立刻 crash。

**改法**（替换 L113–L114，并在 L118 的 if 里补两条）：

```sql
  v_schema text := nullif(p_event->>'schema', '');
  v_ts     timestamptz := nullif(p_event->>'timestamp', '')::timestamptz;
```

```sql
  if v_type is null or v_seq is null or v_schema is null or v_ts is null then
    raise exception 'append_turn_event: event lacks type/seq/schema/timestamp'
      using errcode = '22P02';
  end if;
  if v_type = 'turn_start' and p_event->'input'->>'tag' is null then
    raise exception 'append_turn_event: turn_start lacks input.tag'
      using errcode = '22P02';
  end if;
```

（L133 相应改为直接 `p_event->'input'->>'tag'`，见应修 1 的代码。）

### 4. issue #86 DoD 的两条断言 → 一条对运行者身份敏感，一条缺 schema 过滤；给出与身份无关的写法

- `information_schema.role_table_grants` 只显示"grantor 或 grantee 是当前启用角色"的行。以 `postgres`（grantor）在 SQL editor 里跑是对的；但一旦有人通过 API 以 `service_role` 调一个包了这句 SQL 的函数，结果集为空，`count(*) = 0` **空通过**。
- `pg_class where relname in (...)` 没限定 `relnamespace`。

**改法**（用 `has_*_privilege`，它查 ACL 而不查可见性，任何角色执行结果一致；一次查完整个权限模型）：

```sql
select
  has_table_privilege('authenticated', 'public.turns',       'select')                                   as auth_turns_select,   -- true
  has_table_privilege('authenticated', 'public.turn_events', 'select')                                   as auth_events_select,  -- true
  not has_table_privilege('authenticated', 'public.turns',       'insert, update, delete, truncate, references, trigger') as auth_turns_ro,   -- true
  not has_table_privilege('authenticated', 'public.turn_events', 'insert, update, delete, truncate, references, trigger') as auth_events_ro,  -- true
  not has_table_privilege('anon', 'public.turn_events', 'select, insert, update, delete')                as anon_nothing,        -- true
  has_table_privilege('service_role', 'public.turn_events', 'insert')                                    as svc_insert,          -- true
  has_table_privilege('service_role', 'public.turns',       'update')                                    as svc_update,          -- true
  not has_function_privilege('authenticated', 'public.append_turn_event(uuid,uuid,jsonb,jsonb)', 'execute') as auth_no_rpc,      -- true
  not has_function_privilege('anon',          'public.append_turn_event(uuid,uuid,jsonb,jsonb)', 'execute') as anon_no_rpc,      -- true
  has_function_privilege('service_role',      'public.append_turn_event(uuid,uuid,jsonb,jsonb)', 'execute') as svc_rpc,          -- true
  (select bool_and(relrowsecurity) from pg_class
     where relnamespace = 'public'::regnamespace and relname in ('turns','turn_events'))                as rls_on;              -- true
```

`has_table_privilege(..., 'a, b, c')` 在**任一**权限成立时返回 true，所以 `not has_table_privilege(..., '<全部写权限>')` 正是"一个写权限都没有"。函数签名里带默认值的 `p_meta` 不改变标识符，`(uuid,uuid,jsonb,jsonb)` 就是它。

### 5. issue #124 → "用户态 rpc → 权限错误"要区分真拒绝与 schema cache 未刷新

期望是 PostgREST 透传 Postgres 的 `42501 permission denied for function append_turn_event`（supabase-js `error.code === '42501'`）。若拿到的是 `PGRST202`（函数在 schema cache 里找不到），那是 PostgREST 还没重载，不是授权结果——smoke 若按"有 error 就算过"会把这两种情况混在一起。同理，用户态 `insert` 期望 `42501 permission denied for table turn_events`；权限检查发生在约束检查之前，所以 body 只要列名存在即可（未知列会先得 `PGRST204`）。

**改法**（#124 的断言写成精确码，其余任何码都算失败）：

```ts
const { error: insErr } = await userB.from("turn_events").insert({ turn_id, user_id: userB_id, seq: 999, schema_version: "x", type: "step", payload: {} });
assert(insErr?.code === "42501", `expected 42501, got ${insErr?.code}: ${insErr?.message}`);

const { error: rpcErr } = await userB.rpc("append_turn_event", { p_turn_id: turn_id, p_user_id: userB_id, p_event: {} });
assert(rpcErr?.code === "42501", `expected 42501, got ${rpcErr?.code}: ${rpcErr?.message}`); // PGRST202 = schema cache 未刷新，不是通过
```

---

## 建议

### 6. L173 / L185 → `e.payload ? 'costUsd'`、`e.payload ? 'timestamp'` 两个谓词是冗余的，且 `?` 在部分工具链里会被当占位符

`->>` 对不存在的键返回 NULL，L174 的 `is not null` 已经覆盖键缺失；`min()` 本身忽略 NULL。`?` 在 psql / SQL editor / supabase CLI（pgx）里没问题，但任何用 `?` 做参数绑定的驱动都会吞掉它。删掉两行不改变语义：

```sql
-- L173 删除 `and e.payload ? 'costUsd'`
-- L185 删除 `and e.payload ? 'timestamp'`
```

### 7. 给 #88 的分类器备注（不改 0011）：按错误码**类**分，而不是枚举四个码

这份 RPC 会产生 §3.7 表里没有的码：`22007`（timestamp 串非法，不是 `22P02`）、`23502`（`p_user_id` 为 null 撞 `not null`）、`23514`（应修 1 的 owner 不一致）。而 `23505` 在这份 RPC 里**永远不会出现**（两处 insert 都是 `on conflict do nothing`）——分支保留无害，但别指望测到它。建议 `SupabaseTraceStore` 的分类写成：`22*`、`23*`（除 `23505`）、`42*` → 立刻 crash；`08*`、`57014`、HTTP 502/503/504、fetch 网络错误 → 重试一次；`23505` → 成功；其它未知码 → 立刻 crash（宁可停也不重试一个未知状态）。

### 8. L157–L159 → 同 `(turn_id, seq)` 但 payload 不同的重复 append 会被静默丢弃

理论上不可能（同一生成器同一 seq 只有一个事件），但如果真发生（例如装配层复用了 turnId），"first wins + 无声"是最难排查的形态。可选加固，成本一行：

```sql
  insert into public.turn_events (turn_id, user_id, seq, schema_version, type, payload)
  values (p_turn_id, v_owner, v_seq, v_schema, v_type, p_event)
  on conflict (turn_id, seq) do nothing;
  if not found and exists (
    select 1 from public.turn_events e
     where e.turn_id = p_turn_id and e.seq = v_seq and e.payload <> p_event
  ) then
    raise exception 'append_turn_event: seq % already stored with a different payload', v_seq
      using errcode = '23514';
  end if;
```

### 9. 0008 的 `do $$ ... end $$;` 幂等块 → 正确，无需改

`create role` 可在事务内执行，plpgsql 直接透传该 utility 语句；`pg_roles` 对所有角色可读；随后的 `grant usage / grant select` 与 `create or replace function` / `alter function ... owner to` 本身幂等。`supabase db reset` 只重建数据库不重建 cluster，角色残留正是这个块要处理的情形。

---

## 逐项核对（对应题目的五类）

### 1. SQL 正确性

| 位置 | 结论 |
| --- | --- |
| L99–L108 函数头 | `language plpgsql` / `security invoker` / `set search_path = public` / `as $$` 的顺序合法（与 0009 同形）；`p_meta jsonb default '{}'::jsonb` 合法 |
| L112 `nullif(p_event->>'seq','')::int` | JSON 数字 `0` → 文本 `'0'` → 0，非 null ✔；非数字串 → Postgres 自己抛 `22P02` ✔ |
| L114 `::timestamptz` | ISO 8601 含毫秒与 `Z` 可直接转 ✔ |
| L133 `coalesce(p_event->'input'->>'tag', ...)` | `input` 缺失 / JSON null / 非对象三种情况都得 NULL、不报错（问题在于**不报错**，见应修 3） |
| L142 / L159 `on conflict (id|turn_id, seq) do nothing` | 冲突目标分别是主键 ✔；`do nothing` 后 `found` 为 false（建议 8 用到） |
| L168–L175 `cost_usd` | `sum((...)::numeric)` 接受 `1e-7` 之类科学计数 ✔；写入 `numeric(10,6)` 自动舍入 ✔；零行时 `coalesce(...,0)` ✔ |
| L176–L186 `latency_ms` | 括号已逐层核对：`round(extract(epoch from (v_ts - min(...))) * 1000)::int`。PG14+ 的 `extract(epoch from interval)` 返回 numeric，`round(numeric)` → numeric → `::int` ✔；PG13 返回 double 也有对应 `round` ✔ |
| L197–L200 函数授权 | `revoke all on function <sig> from public, anon, authenticated` 语法合法（`public` 小写即 PUBLIC）；`ALL` 对函数 = EXECUTE。**真实效果**：Postgres 默认 PUBLIC 有 EXECUTE，Supabase 的 default privileges 又给 anon/authenticated/service_role 各一条显式 EXECUTE；这条语句把 PUBLIC 与两条显式的一起收掉，只剩 owner(postgres) + service_role ✔ |
| 0008 DO 块 | ✔（建议 9） |

### 2. 权限模型是否闭合

- 客户端（`authenticated`）：表上只剩 `select`（L94–L95），策略 `for select to authenticated`（L80–L88）限定自己的行；无 insert/update/delete 策略也无 grant。`anon`：零 grant。
- `revoke all ... from anon, authenticated` **不影响** service_role；service_role 的 insert/update 来自 default privileges（隐式，见应修 2）+ `bypassrls` 属性，RPC 以 invoker 身份 = service_role 执行时写入合法 ✔。
- 持自己 JWT 直接 `POST /rest/v1/turn_events`：表级权限检查先于 RLS 与约束 → `42501` ✔（不是靠策略拒）。
- RPC：PostgREST 会把 `public` 里的函数暴露出来，但执行时 Postgres 拒绝 → `42501` ✔。带默认值的 `p_meta` 不改变函数标识符，L197/L199 的 `(uuid, uuid, jsonb, jsonb)` 就是它 ✔；三参调用由 PostgREST 按默认值匹配 ✔。

### 3. 状态机完整性

| 情形 | 行为 |
| --- | --- |
| `turn_end` 的 update 找不到行 | 不可能：非 start 分支先 `select user_id`，为空即 raise `23503`（L149–L154），update 只在行存在时执行 |
| 没有 `turn_start` 事件时算 latency | `min()` 零行 → NULL → `v_ts - NULL` → NULL → `latency_ms` NULL，**不报错** ✔ |
| 重复 append 同 `(turn_id, seq)` | 事件 `do nothing`；若是 `turn_end`，update 用相同值重跑，幂等 ✔（payload 不同的重复见建议 8） |
| 先 append 非 start 事件、turns 行不存在 | raise `23503` ✔，与 §3.7 一致 |
| `turn_start` 重复 append | turns `do nothing` + 事件 `do nothing`，安全；但 owner 取 `p_user_id` 而非行内值（应修 1） |
| `turn_start` 的 `seq ≠ 0` | 不校验（应修 1 已并入） |
| 原子性 | 函数体是一个语句内的一次事务；任一 raise 使 turns 与事件的写入一起回滚 ✔ |

### 4. 与 spec 的一致性

| spec | 0011 |
| --- | --- |
| §3.3 service role 写、用户态只读、revoke 后仅 grant select、不建 insert/update 策略 | ✔ L77–L95 |
| §3.4 三分支、`p_meta`、非 start 从 turns 取 owner、SQL 聚合 cost/latency、`on conflict do nothing`、`security invoker` + 显式函数授权 | ✔（start 分支的 owner 例外见应修 1） |
| §4 列集、`turn_events.user_id`、`payload` = 完整事件、`schema_version` 列名、只一个 `turns_user_time_idx`、`session_id` 为 null | ✔ 逐列一致 |
| §9 D3 查询 / D9 三条断言 | 在此 DDL 下都能得到预期结果（D9 的精确码见应修 5） |
| **SQL 做了 spec 没要求的事** | ① 策略加了 `to authenticated`（比 spec 更严，合理）；② 三处 `coalesce` 兜底（应修 3，与 §3.7 相反）；③ `raise ... errcode '23503'` 手工模拟外键错误（spec 认可的码，合理） |

### 5. 可测性

见应修 4、5。补充：`select min(seq)=0 and max(seq)+1=count(*) and bool_or(type='turn_end') ...`（§9 D3）在此 DDL 下直接可用。

---

## 结论

**可以交给 #88 继续。** 这份迁移没有语法或类型错误、权限模型按 §3.3 闭合、三条分支的状态机在所有问到的边界上都有确定行为。真机验证（#123 的本地栈 + reset）仍是必要的最终门槛，但静态推演没有发现"跑不起来"或"跑起来不安全"的点。

交接前建议在 0011 本身直接吸收应修 1–3（三段可粘贴的 SQL，合计不到 40 行），并把 #86 的 DoD 换成应修 4 的 `has_*_privilege` 查询——这三处改的是"不一致能否成为 DDL 级不可能"和"断言会不会空通过"，在 #88 写 `SupabaseTraceStore` 的错误分类之前定下来最便宜。建议 6–8 可与 #88 一起做，建议 7 直接写进 #88 的范围。
