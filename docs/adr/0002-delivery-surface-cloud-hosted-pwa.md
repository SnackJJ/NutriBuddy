# 交付形态：云端托管 PWA，单一 harness 服务多 surface

> 状态：Accepted（2026-07-23）。本 ADR 在 `docs/ADD.md` Phase 4「Surfaces and tenancy」的框架内做具体选择，不推翻 ADD。ADD 仍是架构 source of truth。

NutriBuddy 的用户可达形态是**部署在 Vercel 上的 PWA**。harness 全部在服务端执行，客户端只做 UI 与事件渲染。CLI 不是产品形态，保持为开发与 eval 工具。

## 决定

1. **主 surface = PWA**：在现有 Next.js 站点（`app/chat`）上加 manifest、图标、safe-area 适配与移动端 confirm/edit 布局。不做原生 app，不做 Capacitor 包壳。
2. **部署 = 云端托管（Vercel）**：不做本地部署 + 内网穿透。Supabase 继续承担 Postgres + auth + RLS。
3. **harness 在服务端**：turn seam、gates、catalog、模型调用全部留在 `app/api/*` 之后。客户端的职责边界是「发一句话 → 收 event stream → 渲染 → confirm 时回传 proposalId」，不含任何逻辑。
4. **CLI 保持现状且不部署**：`src/cli.ts` 的固定 `CLI_USER_ID`、file stores、`--confirm <proposalId>` 交互都是为 seam 验证服务的，不改造成产品。它不该碰生产数据，现在的隔离是正确的。
5. **部署前置条件**（见下方 handoff 清单）必须先完成，否则不上线。

## 为什么（权衡）

### 本地部署在移动端约束下不成立

产品的核心场景是「吃完饭掏手机记一笔」。本地部署意味着笔记本必须在线，且需要内网穿透。链路会变成 `手机 → 隧道 → 笔记本(WSL2) → 云端 Supabase`，把最脆弱的一环夹在中间还多一跳。云端托管是 `手机 → Vercel → Supabase`，没有一个单点故障是用户自己的设备。

数据库已在云端这一点强化了该结论：Supabase 提供的不只是 Postgres，还有 auth 与 RLS，`app/api/chat/route.ts` 已依赖 `createUserSupabase` / `assertSessionSubject`。自建 Postgres 需要重写这一整套。

### harness 必须在服务端，理由按重要性排序

1. **一份 harness 服务 N 个 surface**。gates（`src/harness/gate.ts`、`numericProvenanceGate.ts`、`advisoryGate.ts`）被刻意做成纯函数就是为了只存在一份。放进浏览器后每加一个 surface 就要复制一份。
2. 模型 API key 不能下发。
3. USDA catalog 快照体积不适合进客户端 bundle。
4. Supabase RLS 与 scoped writer role 的整个设计前提就是客户端不可信。

### PWA 而非原生

PWA 通常的短板是拿不到原生能力，而 photo logging 已是 `AGENTS.md` 明确的 out of scope，**最大短板在本产品中不存在**。原生的真实护城河是 HealthKit / Google Health Connect（步数、心率、睡眠），本项目不接这些数据源。行业共识亦是先 PWA 验证、原生留给 v2；PWA 成本低 50–70%，且省掉应用商店 15–30% 抽成。

`AGENTS.md` 已将 native app 列为 early 阶段 out of scope，本决定与之一致。

### CLI 不是候选

用户侧约束（移动端优先）与终端形态直接冲突——手机上没有终端。若未来确要做 CLI 产品，需重写交互层为常驻 REPL（进程内 `y/n` 确认、真实 auth、连 Supabase），成本按「新建」算而非「已有」。

### 调研依据（2026-07-23）

考察了当前 AI 应用的形态分布，用以校准本决定：

- **Coding agent 已收敛为「一个引擎、多个入口」**：Claude Code（CLI 为架构中心 + IDE 扩展 + web + 桌面 + 移动推送）、Codex（CLI + IDE + Cloud + ChatGPT 侧边栏 + 移动 + Chrome 扩展，cloud 为一等公民）、Jules（web 优先 + CLI + API）、OpenCode（纯 TUI/CLI）、Devin（纯 cloud）。没有一家做「CLI 还是 Web」的二选一。这与本项目 turn seam + 多 adapter 的既有结构同构。
- **重心由反馈延迟决定**：要盯着看的高频交互留本地（Claude Code 的理由是「瓶颈是反馈延迟，而最快的反馈回路在终端」），能走开的长任务放云端（Jules / Devin / Codex Cloud）。
- **深科技领域（医药 / 材料）不玩形态**：Isomorphic Labs、Periodic Labs、Chai Discovery 的交付物是分子、材料与药企合作，不是界面；真正卖软件的是老牌 Schrödinger（桌面工作站 + 云门户双形态）与 Benchling（纯 cloud）。规律是离物理世界越近，产品形态越不重要。
- **B2B 专业工具选 web 是为了多方审阅**（Replica 面向规划部门 / 开发商 / 建筑事务所共享同一 URL），不是因为技术更优。

**关键映射（结论与 coding agent 相反）**：在 coding agent 中移动端是配角，角色是「触发 + 通知 + 审批」；而在营养助手中，「触发 + 审批」**就是全部交互**（log_meal + confirm）。根因是上下文位置不同——coding agent 的上下文在开发机上，所以终端赢；营养的上下文在用户吃饭的地方，所以手机赢。终端在前者赢，恰恰说明它在后者输。

## 后果与已知风险

### Vercel Hobby 的两个边界

- **函数上限 60 秒**（早期 10 秒的限制已放宽）。一个 ReAct turn 通常够，但叠加慢响应 + 多轮工具调用 + output gate 违规触发的 regenerate（ADD 规定最多两次）可能顶到边界。
- **冷启动与 module 级 catalog 冲突**。`app/api/chat/route.ts:50` 的 `loadConfiguredCatalog()` 注释写明 "built once at cold start"——这在长驻进程中是最优解，在 serverless 上是负担。个人自用调用稀疏，冷启动频率反而高。痛感程度由快照体积决定。

**迁移触发条件**：撞上上述任一边界即迁往长驻容器（Fly.io / Railway），catalog 加载一次常驻内存且无函数超时。迁移成本极低（同一个 Next.js app，`npm run build` + `npm start`），因此**不提前优化**。

### Supabase Free 额度

500 MB 数据库 / 1 GB 文件 / 50k MAU / 不限 API 请求，最多 2 个活跃项目。**7 天无活动自动暂停**，数据不删，唤醒约 30 秒。日常使用不会触发；长期离开后首次请求会慢一次。

## 上线门槛

### 代码侧

- **#82 — `/api/chat` 不得存在匿名通道。** 当前 `app/api/chat/route.ts:183` 的 `if (session)` 在无 session 时不返回 401 而是继续执行，turn 照常跑完并消耗模型额度。这不是 bug（`src/lib/auth.ts:5` 的注释说明了匿名降级是有意设计），但在公网部署 + 个人自用的组合下它是敞开的费用暴露面。
- **#83 — PWA shell + 移动端 confirm/edit UX。** 决定 1 的落地，同时吸收 `AGENTS.md` § Next 原第 1 条。

### 运维侧（人工执行，不进 issue tracker）

这三条是部署决定的边界条件，不是一次性任务——更换托管方后依然适用。

1. **模型账号设消费上限。** 唯一能限制损失上界的措施；密钥管理只降低概率，不封顶损失。
2. **敏感变量只勾 Production，不给 Preview。** Vercel 的 Preview 部署默认继承环境变量，而 preview URL 格式可推测且不受主域名保护。`DEEPSEEK_API_KEY` 与 `SUPABASE_SERVICE_ROLE_KEY` 只给 Production。
3. **build 后验证 bundle 无密钥泄露。** 按现有结构应为干净——`NEXT_PUBLIC_` 只用于 Supabase URL 与 anon key，两者本就是公开值：

```bash
npm run build
grep -r "sk-" .next/static/ 2>/dev/null   # 无输出即干净
```

部署后需真人验证移动端「添加到主屏幕」流程，该验证无法由 AFK agent 完成。

## 明确不做

- 原生 app 与 Capacitor 包壳（`AGENTS.md` out of scope，PWA 已覆盖绝大部分）
- CLI 产品化（见上）
- 本地部署 + 内网穿透
- 提前迁往长驻容器（等触发条件）

## 未决

**Telegram bot 作为第三个 surface**——曾在讨论中评估：终端事件（final answer / clarification / write proposal / refusal / error）与 IM 交互同构，inline keyboard 实现 confirm/edit 比自建 Web UI 省一个数量级，且推送与移动端可达性白送。成本约为一个 webhook route 复用 `assembleChatTurnPorts`。

**推迟决定的理由**：(a) 取决于用户日常主力 IM 是否为 Telegram（微信个人号无 bot API）；(b) 真实的架构工作量在于 RLS 依赖 session JWT 而 bot 无浏览器 session，需要 `chatId → userId` 映射并签发 JWT 或走 service role——后者绕过 RLS，须在 adapter 层自行保证租户隔离，正是「逻辑漏进 surface」的典型口子。

应在 PWA 上线并真实使用两周后再评估，届时摩擦点是观测到的而非猜测的。
