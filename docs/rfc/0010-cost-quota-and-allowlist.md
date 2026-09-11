# RFC 0010 — 费用闸、配额与白名单登录（S3 spec）

> 状态：**Proposed**（2026-07-26）。
> 关联：`docs/rfc/0007` §3 S3（验收 D6/D7）、`docs/rfc/0006` §5/§7、`docs/adr/0002`（上线门槛 #82 已关闭）。
> 对应 issue 草稿见 §8。

## 1. 目标

1. 模型费用有**硬上限**：超限返回 typed refusal，而不是静默失败或等账单。
2. 注册面收口：只有被允许的人能建号（V1.0 = 白名单）。
3. 拒绝行为**可观测**：能回答"谁在什么时候因为什么被拒"。

## 2. 现状与证据

- 匿名请求已封：`src/lib/auth.ts:getSessionFromHeader` + `app/api/chat/route.ts:173-194` 在无 session 时 401（issue #82 已关闭）。
- 注册/登录在 `app/profile/page.tsx`，走 `src/lib/useSupabaseSession.ts` 的 `signUp` / `signIn` —— **客户端直接调 Supabase Auth**，服务端目前不参与注册判定。
- **成本已经在算**：`src/harness/modelAdapter.ts:38` 有 `TIER_PRICING_USD`，`:54` 有 `computeCostUsd(tier, usage)`，`loop.ts:428` 每轮把 `costUsd` 写进 `model_call` 事件。**缺的是聚合与拦截，不是计价。**
- 全仓库无限流、无配额、无白名单。

## 3. 决定

### 3.1 三层防线（按顺序）

| 层 | 作用 | 强度 |
| --- | --- | --- |
| provider 侧消费上限 | 唯一能封顶总损失 | 人工设置，写进运维清单（ADR 0002 已列） |
| 白名单（注册面） | 不让陌生人进来 | Auth 层强制，不能只靠 UI |
| 配额（请求面） | 让进来的人也烧不爆 | 请求边界前置检查 |

### 3.2 白名单：三个方案与选择

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **A. 关闭公开注册 + 管理端建号** | Supabase Auth 关闭 "Allow new users to sign up"；用服务端脚本 / 控制台为朋友建号 | **V1.0 推荐**：零代码、零新表，恰好满足"自己 + 几个朋友"；代价是每加一个人要手动一次 |
| B. `signup_allowlist` 表 + Auth Hook（before user created） | 建号前查表，非白名单拒绝 | 代码化、可自助注册；**实现前需确认 hook 的当前可用性与错误文案传递方式**；V1.1 若开注册则采用 |
| C. 自建 `/api/auth/signup` | 服务端查白名单 + service role 建号 | 最灵活（可做邀请码），但引入一条新的身份写路径；仅在确实需要邀请码体验时做 |

**共同要求**：客户端 UI 永远不是唯一闸门；关闭注册后 `app/profile/page.tsx` 的 `signUp` 入口必须隐藏（否则用户点了一个必然失败的按钮）。

### 3.3 配额模型

- 配置（env 默认 + 可选 per-user 覆盖）：`QUOTA_DAILY_TURNS`、`QUOTA_DAILY_COST_USD`、`QUOTA_MAX_TURN_COST_USD`。
- **计数来源 = `turns` 表**（`docs/rfc/0008` 建的），按 `(user_id, started_at)` 索引聚合。**不新开计数表** —— 那会制造第二真源，也必然与轨迹表不一致。
- 检查点：`/api/chat` 入口，**在装配任何端口之前**（被拒请求不得消耗一次模型调用）。
- **拒绝形态：HTTP 429 + typed body，不进 turn seam**：

```json
{ "error": "quota_exceeded", "scope": "daily_turns|daily_cost|turn_cost",
  "limit": 40, "current": 40, "resetAt": "2026-07-27T00:00:00Z" }
```

理由：配额是**运行控制**，不是 agent 行为。让它进 seam 会造出一个没有内容的假 turn，并牵动 `STOP_REASONS` 与 `SCHEMA_VERSION` 两个本不该为运维策略改动的契约。

- **并发下的轻微超发是可接受的**（**决定**，不是未决）：不做分布式锁 —— 加锁的复杂度与故障面都大于偶尔多发一两次请求的代价。因此**配额是软上限**，provider 侧消费上限才是硬上限。
- **单轮最坏成本预估**：用 pinned region + 目录签名 + 证据子集的 token 上界 × `TIER_PRICING_USD` 估算，超 `QUOTA_MAX_TURN_COST_USD` 直接拒 —— 防的是单轮异常，不是日常用量。
  **依赖顺序警告**：公式里的"证据子集"由 S4 产出（`docs/rfc/0011` §3.7）。S3 与 S4 是并行分支，若 S3 先落地，该项**按 0 计入**会造成上界偏低（正是本节想防的漏防）；因此 S4 完成后必须回头做一次预估校准。这条二次修改点已在 issue #100 的范围里显式写出。

### 3.4 可观测

- 每次拒绝写一条结构化 server log：`{ user_id, scope, limit, current, path, at }`。
- 是否把拒绝落库统计：见 §9 未决（V1.0 先 log）。

## 4. 数据模型（迁移 0012）

```sql
-- 仅方案 B 需要
create table public.signup_allowlist (
  email       text primary key,          -- 存 lower(email)
  note        text,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);
alter table public.signup_allowlist enable row level security;
revoke all on public.signup_allowlist from anon, authenticated;  -- 无任何客户端访问路径

-- 方案 A / B / C 都可能需要：per-user 覆盖（不建则全走 env）
create table public.usage_limits (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  daily_turns      int,
  daily_cost_usd   numeric(10,6),
  max_turn_cost_usd numeric(10,6),
  updated_at       timestamptz not null default now()
);
alter table public.usage_limits enable row level security;
revoke all on public.usage_limits from anon, authenticated;      -- 仅服务端读写
```

若最终选方案 A 且不需要 per-user 覆盖，**这一迁移可以为空**（只加 `usage_limits` 也可省）—— 避免为不存在的需求建表。

## 5. 契约

| 项 | 契约 |
| --- | --- |
| 超配额 | 429 + §3.3 的 typed body；**无模型调用、无 turn 记录** |
| 放行 | 与现状完全一致（配额检查是纯前置） |
| 白名单拒绝 | 注册失败，错误文案不泄露白名单内容（不出现"该邮箱不在白名单"这类枚举线索） |
| 匿名 | 仍 401（#82 已实现） |
| 配额口径 | 日界按 UTC；计数含当天所有 turn（含失败轮） |

## 6. 测试

| 测试 | 断言 |
| --- | --- |
| 配额判定（纯函数） | 恰好等于上限 → 放行；超 1 → 拒；跨 UTC 日重置；`limit = 0` 语义 |
| 路由 | 超限 429 且 **adapter 未被调用**（spy 断言）；未超限行为不变 |
| 最坏成本预估 | pinned 上界 × 单价；无 usage 时保守取值 |
| 白名单（若选 B） | 白名单邮箱通过、非白名单失败；表无客户端可读路径（RLS + revoke 生效） |
| UI | 关闭注册时 `signUp` 入口不可见 |

## 7. DoD（对应 RFC 0007 D6/D7）

- D6：超每日配额返回 typed refusal；provider 侧消费上限已设置并留档。
- D7：非白名单邮箱无法建号；匿名请求仍 401。
- 拒绝路径不触发模型调用（测试断言）；`npm test` + `npm run typecheck` 绿。

## 8. Tickets（草稿 → issue）

| # | 内容 | 依赖 |
| --- | --- | --- |
| T1 | 配额判定纯函数 + 日界/边界测试 | — |
| T2 | 从 `turns` 聚合当日用量（turn 数 + 成本） | S1 |
| T3 | `/api/chat` 前置检查 + 429 typed body + "不调用模型"断言 | T1 T2 |
| T4 | 单轮最坏成本预估（复用 `TIER_PRICING_USD`） | T1 |
| T5 | 白名单落地（推荐的方案 A：关闭注册 + 建号脚本；或方案 B 的表 + hook） | — |
| T6 | UI：关闭注册时隐藏 signUp + 失败文案 | T5 |
| T7 | 拒绝的可观测（结构化 log） | T3 |

## 9. 未决

1. **白名单方案 A/B/C 的最终选择**：V1.0 建议 A（少一个机制），V1.1 开注册时升 B。
2. 配额口径以 turn 数还是成本为主：建议**两者都查、以成本为主**（turn 数防刷、成本防烧）。
3. 拒绝是否落库：V1.0 先 log；若需要滥用可见性，再加一张 `rejections` 表（属观测面，不属安全面）。
4. 是否对外暴露剩余配额（UI 展示）：V1.0 不做。
