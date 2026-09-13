# S1 / #124 评审记录（Opus，2026-09-13）—— D9 越权与伪造断言（smoke）

> 输入：`scripts/smoke-rfc0008-trace.mts` 的首版实现，以及 `scripts/verify-migrations.sh` 的 `notify pgrst` 补充与 `tsconfig` 纳入 `scripts`。
> 方法：`claude -p --model opus` 单轮评审（本轮未逐条复审，改动按发现直接落实；**已用负向探针代替复审**——见下）。
> 结论：**pass-with-nits**，4 条应修 + 6 条 nit，全部已处理。

---

## 一、最有价值的一条：评审按票面建议写出的断言是空通过的

issue #124 的评审补充（0011 静态审查，应修 5）要求"断言必须锁定精确错误码"，并给出 `assert(insErr?.code === "42501")`。本轮实现照此写完、跑绿之后，作者做了一次**负向探针**：把 0011 撤销掉的权限还回去，看断言会不会变红。

- 恢复 `grant insert on public.turn_events to authenticated` → **脚本仍然全绿**。原因：Postgres 对"RLS 策略拒绝"也报 `42501`，两种拒绝同码。也就是说票面建议的断言**不可能**发现"grant 被还回来"这一真实回归。
- 同理，`grant execute on function public.append_turn_event(...) to authenticated` 会让函数真的被用户调进去（报 `22P02`），而只查 `code === "42501"` 的断言同样抓不到。

**处理**：断言改为"码 + 消息"双条件，且消息必须指认**哪扇门**：
- 表门：`permission denied for table turn_events`（权限检查先于 RLS）
- 函数门：`permission denied for function append_turn_event`（EXECUTE 已从 PUBLIC 收回）

**负向探针复用为验收**（比复审更硬）：两个门各自恢复后脚本都 FAIL 且 exit 1（前者 2 条 FAIL，报出 `new row violates row-level security policy`；后者 2 条 FAIL，报出 `22P02`），撤销后回到 13/13 PASS。

这是本项目第二次遇到"评审给的断言本身需要被实证"（第一次是 #86 DoD 的 `information_schema` 空通过），因此记在这里而不只是写进 commit。

## 二、其余应修与处理

| # | 问题 | 处理 |
| --- | --- | --- |
| ① | `turns` 行的越权断言没有正向控制：若读策略被误删，owner 也查不到，断言照样 PASS（线上表现为重放路由对本人 404） | 先加"owner 能看到自己的 turns 行"再断言 stranger 看不到 |
| ② | preflight 把 service_role 的真回归降级成"环境没搭好"：探针依赖的 grant 与所测 grant 互补，若 `grant execute … to service_role` 被删，会得到 42501 → 退 2 + 一段讲 PGRST202 的文案 | 只有 `PGRST202` 走 BLOCKED/退 2；其它非 23503 一律 `check(false)` → 退 1，并把 code/message 打出来 |
| ③ | 表探针的 BLOCKED 文案开错药：`PGRST205`（cache 陈旧）被建议去 `db push`，service key 填错（401）同样被建议 push | `PGRST205`/含 schema cache 走 reload 提示；其它码提示核对 target 与 service-role key |
| ④ | "打印 target"只是日志不是闸：`.env.local` 指 hosted、什么都不 export、照 DoD 敲命令，就会在 hosted 建两个账号 | 非 `127.0.0.1/localhost` 的 URL 必须 `SMOKE_ALLOW_REMOTE=1`；并打印每个值来自环境还是文件（混源是走错项目的主要形态） |

## 三、nit 与处理

- 固定 UUID 探针可能撞上同 id 的 fixture 而真的写入一行 → 改用 `randomUUID()`。
- 4 条清理 PASS 里 3 条恒真（stranger 无行、老三表无行）→ 级联检查改为"删前计数 > 0 且删后为 0"（实测 `9 rows before, 0 after`），老三表标注为 `[leak check]`。
- 顶层未捕获异常没有汇总行 → 主流程包 try/catch，抛出也计入 `FAILED: n assertion(s)`。
- 缺 `smoke:trace` 入口与 AGENTS.md Commands 条目 → 已补（并把 #124 从 Next 列表摘掉）。
- `notify pgrst` 是 fire-and-forget，LISTEN 连接重连时会丢 → 可接受，smoke 的 preflight 会指回来。
- `tsconfig` 纳入 `scripts` 后 `next build` 也会类型检查脚本 → 有意为之，#113 需知悉。

## 四、真机证据（本地栈）

```
target: http://127.0.0.1:54321 (NEXT_PUBLIC_SUPABASE_URL from environment, SERVICE_ROLE_KEY from environment)
13/13 PASS   exit 0
```
负向（把门打开）：
```
grant insert  on public.turn_events to authenticated            → 2 FAIL, exit 1
grant execute on function public.append_turn_event(...) to authenticated → 2 FAIL, exit 1
```
环境守卫：
```
npx tsx --env-file=.env.local scripts/smoke-rfc0008-trace.mts   → refusing to run against https://hrefzfrsqbmbrgdbcidp.supabase.co, exit 2
```

## 五、顺带发现的 hosted 情况（归 #113，需人工动作）

那次误打 hosted 的运行留下了一条可读证据：该项目的 REST API **看得到** `turns` / `turn_events`（计数成功），但**看不到** `append_turn_event`（PGRST202）。两种解释：①函数确实没建起来（例如手工粘贴时 `create function` 那一步失败，而前面的建表已自动提交）；②PostgREST cache 陈旧。区分办法是在 Dashboard 的 SQL Editor 跑一次：

```sql
select proname from pg_proc where proname = 'append_turn_event';
select version  from supabase_migrations.schema_migrations order by version;
```

无论哪种，`major_version` 的核对（见 `supabase/config.toml` 内的 UNVERIFIED 注释）与这家项目的迁移收敛都应在部署前完成。**本轮没有在 hosted 上写入任何数据**（两个临时账号已删除）。
