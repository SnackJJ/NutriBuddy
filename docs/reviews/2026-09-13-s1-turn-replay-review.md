# S1 / #89 评审记录（Opus，2026-09-13）—— turn_meta、客户端 lastSeq、重放接口

> 输入：`#89` 的实现变更（`app/api/turns/[id]/events`、`src/lib/{turnReplay,turnSession}.ts`、`app/chat/page.tsx` 的记账与恢复、`TraceStore.findTurn`）。
> 方法：同 `2026-09-13-s1-trace-persistence-review.md` —— 先评审未提交 diff，修完后**复审同一 diff**。
> 结论：首轮 **blocked**（2 阻断 + 4 应修）→ 修复后复审 **pass-with-nits**（首轮全部 addressed；复审新增 1 条应修 + 6 条 nit，其中应修与主要 nit 已在本轮修掉）。

---

## 一、首轮阻断与处理

### 阻断 1：首轮重放已含终态时，提案卡永不出现

恢复逻辑把 `setPendingProposal` / `setPendingResolverMiss` 写在 **poll 循环体内**。刷新时若 turn 已经结束（用户重新登录 + 页面加载 ≥1s，实际几乎总是如此），首次全量重放就带回 `turn_end`，`sawTerminal` 为真、循环整体跳过 → 气泡显示 "Write proposal awaiting confirmation." 但没有确认按钮，提案按 0010 的 TTL 过期，**这顿饭没记上**。这正是 ADR 0002 的核心场景（吃完饭掏手机记一笔）。

**处理**：恢复块（proposal / resolverMiss / retryable）移到循环之后**无条件执行一次**；`sawTerminal` 改由共享的 `consume()` 置位，使"首次重放即终态"与"轮询中才终态"两条路径收敛到同一段恢复代码。复审确认这不是表面修补，并逐条核对了链路（`turn_end.result.proposal` → `applyTerminalResult` → `pendingProposal && !streaming` 渲染）。

### 阻断 2：永无终态的 turn 会让该 tab 每次刷新都被锁 90 秒，且永不解除

"轮询耗尽则保留条目"原本没有上界。终态写入失败被吞（`turn.ts`）、pump 抛 error 帧后生成器被丢弃、函数超时被杀、本地热重启都会产生"有 `turn_start`、永无 `turn_end`"的行；之后该 tab 每次刷新都会全量重放 + 90×1s 轮询，期间 textarea 被禁用，然后静默结束、条目保留、下次刷新重来。

**处理**：以 `turn_start.timestamp` 的年龄设上界（`RESUME_MAX_TURN_AGE_MS`，默认 300s，即"超过它不可能还在跑"），到界即清除条目并提示；`error` 帧到达时同样先清除——pump 已经放弃那个 turn，没有可续的东西。

### 应修（均已在首轮修完）

| # | 问题 | 处理 |
| --- | --- | --- |
| 3 | DoD 单测是恒真式：生成器把六次 `append` 全放在首次 `yield` 之前，cancel 后即使 pump 丢弃生成器断言照样通过 | 改为 append/yield 交错（与 `turn()` 一致），cancel 后 store 只会留下已产出的部分，断言因此有判别力 |
| 4 | sessionStorage 访问无保护：浏览器屏蔽站点数据时抛 `SecurityError`，会把一次正常的 live turn 变成报错（回归） | 四个存取函数全部 try/catch——记账是旁路，绝不能影响 turn 本身。（复审指出 `window.sessionStorage` 的**属性求值**在页面调用点、包装不到；在本应用里不可达，因为站点数据被屏蔽时 Supabase 无法跨整页跳转保住 session，降为 nit） |
| 5 | 轮询期间同一段内容渲染两次（累积气泡 + `partialResponse`） | 轮询期间只靠 `partialResponse`，assistant 气泡在循环后只追加一次 |
| 6 | `SupabaseTraceStore.findTurn` 零测试；假 client 没有 `maybeSingle` | 假 client 补 `maybeSingle`，新增两条用例钉住 `[["user_id",…],["id",…]]` 过滤与"无行返回 undefined" |

## 二、复审新增（本轮已修）

### 应修：90 次 poll 上限先于 300s deadline 触发，然后无条件清条目

上一轮引入的 deadline 是对的，但保留的固定上限（90 × 1s）抢先生效并清除条目，于是 **>90s 的活 turn 被放弃**，用户按提示重发 → 第二个 proposal 被生成，而第一个在 t=100s 完成时没人看见（RFC §6 的 worst case 本就是分钟级）。作者自己的注释被自己的循环条件推翻。

**处理**：poll 上限改为由 deadline 派生（`ceil(deadline / interval)`），**永不先于 deadline 触发**，退化为纯粹的失控保护。

### 其余 nit

- `trackedStreamHandler` 原在每帧回调内重建（每事件一个新闭包 + 一次 storage 读）→ 提到流外。
- handler 的 `turnId` 初值原从 storage 读；pre-assembly 的失败帧（无 seq）会因此清掉**另一个** turn 可恢复的条目 → 初值改 `undefined`，只信 `turn_meta`。
- confirm 路径第三份手写记账副本 → 改用同一个 handler。
- 无终态中断只给 error banner，未像 live 路径那样保留输入并给 Retry（RFC 0004 §6.2）→ 补 `setInput` + `setRetryable`。
- 恢复折叠逻辑（userText / startedAt / sawTerminal / lastSeq）正是阻断 1 的所在却无测试 → 抽成纯函数 `foldReplayedTurn`（`src/lib/turnReplay.ts`）并补四条用例，含"首轮重放已含终态"。
- deadline 注释原称"matches the platform function limit"，但仓库里没有任何东西把两者绑定 → 注释改为明确标注这是假设（部署时的函数时限）；客户端时钟偏差的影响一并记录。

## 三、未闭合（不阻塞）

- 恢复循环本身（React 状态恢复顺序）仍无自动化测试——仓库没有 jsdom，票的 DoD 把这一条留给真人操作。折叠规则已抽纯并覆盖。
- 卸载不 abort 循环：应用全部用整页跳转，最多多跑一个边界周期，无副作用。

## 四、真机证据（本地 Supabase 栈，与路由相同的构造方式）

用 `createClient(API_URL, ANON_KEY, { global: { headers: { Authorization: Bearer <user JWT> } } })` —— 即路由重建的那个 client —— 跑 `loadTurnReplay`：

- 拥有者：`{kind:"events"}`，seq `0..7`；`since=2` → `3..7`（只返回更晚的事件，不丢不重）。
- 另一个已登录用户持同一 turnId：`{kind:"not_found"}`（路由 → 404）。
- 用户态 client 调 `append_turn_event`：`42501 permission denied for function`（0011 收回了 EXECUTE，写门仍然关着；#124 会把它固化成断言）。

`npm test` 56 文件 / 1071 用例全绿；`npm run typecheck`、`next lint`、`next build` 均通过（构建产物含新路由 `ƒ /api/turns/[id]/events`）。
