# RFC 0004 — Frontend UX Contract（前端 UX 契约）

> Status: **Accepted** (2026-07-23) — Grok × Codex 联合决议后接受。实现完成前保持 Accepted，**不是** Implemented。
> **Not always-on agent context** — 只在做前端 UX / 组件 / design token 时打开。
> Architecture source of truth: `docs/ADD.md`。本文不改任何架构决策。
> Scope: **UX 契约层** — 用户、任务、流程、状态覆盖、指标。**不含**实现（token 值、组件代码、页面布局），那些是下游 tickets。
> Authority: 本文是前端状态覆盖的唯一约束来源。组件清单与 token 语义必须从 §6 矩阵推导，不得另起炉灶。

## Why

前端当前状态：`app/chat/page.tsx` 945 行、`app/profile/page.tsx` 544 行，无 `src/components/`，无 design token（`tailwind.config.ts` 的 `extend` 为空，`globals.css` 只有三行 `@tailwind`）。

但真正的问题不是缺 token，是**缺状态覆盖**：

后端已经把不确定性建模成类型 —— `resolver.ts` 的 6 种 `matchType`、`types.ts:137` 的 6 种 `StopReason`。前端把它们压成了同一种视觉呈现。**架构上的诚实没有传递给用户。**

具体表现：`WriteProposalData` 已携带 `matchType` 与 `allergenTags`（`src/harness/types.ts:169-170`），前端拿到后直接丢弃。用户无法区分"catalog 精确命中的 140 kcal"和"模糊匹配猜出来的 140 kcal"。

在补 token 之前必须先定这个契约，否则组件清单只能靠拍脑袋。

## 1. 用户与场景

**Dogfooding 阶段唯一用户：项目作者本人。**

| 维度 | 取值 |
|------|------|
| 专业水平 | 懂卡路里/宏量营养素，无需术语翻译 |
| 使用场景 | 餐后即时记录，移动端为主，单手，注意力低 |
| 频次 | 每天 3–5 次记录，1–2 次查询 |
| 容错 | 高 —— 用户即开发者，能理解报错 |

### 因此明确砍掉（Non-goals）

- Onboarding / 新手引导 / 空状态教学
- 术语通俗化（直接用 kcal / protein / portionG）
- 目标值推荐向导（profile 手填即可）
- 多用户 / 分享 / 社交
- 国际化（中文单语）
- 用户可配置主题

砍掉这些的理由是**验证成本**：dogfooding 的唯一目的是验证 §7 的赌注，上述功能不参与验证。

## 2. JTBD（按频次排序）

| # | 任务 | 频次 | 入口 | 当前支持 |
|---|------|------|------|----------|
| 1 | 记一餐 | 3–5 次/天 | 对话输入 | ⚠️ 通路有，失败路径缺 |
| 2 | 我今天还能吃多少 | 2–3 次/天 | 应常驻可见 | ❌ 无 |
| 3 | 这个我能吃吗（过敏原/药物） | 1 次/天 | 对话提问 | ⚠️ 有 pre-gate，UI 未突出 |
| 4 | 改一条记错的 | 0.5 次/天 | 提案编辑 / 历史 | ❌ 无 |
| 5 | 这周怎么样 | 1 次/周 | 对话或面板 | ⚠️ 有 `weekly_totals` template |

**排序即优先级。** 任务 1 与 2 决定主界面形态；3–5 可以先只走对话。

## 3. 产品隐喻

**对话主界面 + 常驻今日条。**

推导依据（不是审美偏好）：

- 任务 1（最高频）→ 自然语言输入摩擦最低 → 对话必须是主输入
- 任务 2（次高频）→ 需要随时可见而不打断对话 → 常驻摘要条
- 任务 3–5 频次低 → 走对话即可，不给独立导航

**推论：今日展开是页内态，不是独立 tab。** Dogfooding 首发：TodayBar 打开 **页内** Sheet（移动）/ 面板（桌面）。**不**建 `/today` 路由、拦截路由或底栏 tab，直到深链成为真实需求。做成 tab 会把「对话优先」稀释成普通表单应用。

## 4. 信息架构

| 路由 / 表面 | 角色 | 现状 |
|-------------|------|------|
| `/` | 已登录 → 重定向 `/chat`；未登录 → 登录入口 | 脚手架占位，需重做 |
| `/chat` | 主界面 = 今日条 + 对话流；今日明细为页内展开 | 有，需重构 |
| Today 展开 | 今日条的 Sheet/面板（餐次列表 + 营养素细分），**非**独立路由 | 待建 |
| `/profile` | 目标、过敏原、用药 | 有（allergies / medications / 四项目标 / 身高体重） |

## 5. 关键流程 — Happy path

**记一餐**，目标 ≤ 2 次交互：

```
用户: "午饭吃了两个鸡蛋"
  ↓ turn 开始，流式呈现进度
agent: [resolver: exact] → 提案卡片（鸡蛋 ×2 / 100g / 140 kcal）
  ↓ 交互 1
用户: [确认]
  ↓ 确定性 short-circuit 按 proposalId commit
系统: 已入账，今日条数字更新
```

数据来源约束：
- **已消耗宏量**：`daily_totals` template（已存在）。**不新写聚合 SQL** —— 读取路径只走 Typed Query Catalog。
- **目标**：既有 authenticated profile 读路径。
- **remaining**：应用层确定性计算（目标 − 已消耗），**绝不**让模型心算。

## 6. 失败路径矩阵（本 RFC 核心）

状态空间来自代码，非设计臆造。**每一行必须有明确的 UI 呈现**；未覆盖的行视为设计缺陷。

### 6.1 Resolver matchType（`src/catalog/resolver.ts`）

| matchType | 含义 | UI 契约 | 用户出路 | 现状 |
|-----------|------|---------|----------|------|
| `exact` | 精确命中 | 数字正常呈现，无标记 | — | ✅ |
| `alias` | 别名命中 | 同 exact，可显示 canonical 名 | — | ✅ |
| `fuzzy` | 模糊命中带分数 | **显式标记为推测**，弱化数字权重 | 一键换候选 | ❌ 与 exact 同形 |
| `miss_ambiguous` | 多候选 | **候选列表直接可点选** | 点选，**不得要求重打字** | ❌ |
| `miss_low_confidence` | 低于阈值 | 标记不确定 + 显式求确认 | 确认或改述 | ❌ |
| `miss_unknown` | 查无此食物 | 明确说明无匹配 | 换说法 / 手填营养值 | ❌ |

**硬约束**：`miss_ambiguous` 必须给可点选候选。要求用户重新打字会把交互次数推到 3+，直接违反 §7 指标。

### 6.2 StopReason（`src/harness/types.ts:137`）

| StopReason | UI 契约 | 用户出路 | 现状 |
|------------|---------|----------|------|
| `end_turn` | 正常回复 | — | ✅ |
| `write_proposal` | 提案卡片，四态齐全（见 6.3） | 确认/改/取消 | ⚠️ 缺编辑与过期 |
| `gate_blocked` | 说明**拦了什么、为什么** | 改述 | ⚠️ 有 amber 框但只列原因 |
| `max_steps` | "循环耗尽" | **可重试，不丢输入** | ❌ |
| `aborted` | 已中断 | 重发 | ❌ |
| `crash` | 出错 | **可重试，不丢输入** | ⚠️ 红框，输入已丢 |

**硬约束**：`max_steps` / `crash` / `aborted` 三态必须保留用户原始输入。让用户重打字是 dogfooding 阶段最容易导致弃用的行为。

### 6.3 Proposal 生命周期

| 态 | 触发 | UI |
|----|------|-----|
| `pending` | 收到 `write_proposal` | 卡片 + 确认/改分量/取消 |
| `committed` | confirm short-circuit 成功 | 收敛为已入账摘要，今日条更新 |
| `voided` | 用户取消 | 弱化留痕，不消失 |
| `stale` | 后端判定不可 commit（过期 / 已 void / 不存在）或客户端 TTL 提示 | 标记过期，禁用确认，提供「重新生成」 |

**`stale` 权威（hybrid）**：
- **后端权威**：commit 路径原子拒绝过期/不可用提案（默认 TTL **30 分钟**）。
- **前端提示**：可据 `createdAt` 预先禁用确认并标 stale；时钟冲突**永远以后端为准**。
- 不在浏览器里单独发明 commit 授权。

**编辑语义**：改分量 = **新 Proposal supersede**（immutable bytes 不 in-place 修改）。当前「optional note」**不是** edit。

### 6.4 安全提示（对应任务 3）

`WriteProposalData.allergenTags`、match 质量（`matchType`）与 **proposal-relevant** 药物交互提示必须在**提案确认之前**可见 —— 这是 profile 里 allergies / medications 字段存在的意义。确认后才提示等于没提示。

**送达约束**：
- 安全提示必须是 turn / wire 上的 **typed projection**，禁止从 assistant 散文或废弃 `toolResult` 字符串反推。
- 只展示与**本提案食物**相关的交互，不把用户全部用药规则刷在每张卡片上。
- Profile / interaction 加载失败必须 **fail closed**（不得静默当成「无过敏/无用药」继续）。

## 7. 成功指标

Dogfooding 的赌注：**自然语言输入把"记一餐"的摩擦降到低于表单式记录。** 记录类应用的通病是两周弃用，赌注不成立则产品不成立。

| 指标 | 目标 | 测法 |
|------|------|------|
| 记一餐耗时 | < 10 秒 | 首次输入 → commit 时间戳 |
| 记一餐交互次数 | ≤ 2 | 计数用户操作 |
| 提案确认率 | > 80% | commit / proposal |
| 提案修正率 | < 20% | 改分量次数 / proposal |
| 连续使用天数 | > 14 天 | 有 commit 的日期数 |

Trajectory 已记录 typed event stream，上述指标应从中导出，**不另建埋点**。

## 8. 下游推导（informative，非约束）

以下由 §6 推导，供后续 ticket 参考，具体设计在实现 RFC 中定：

**组件清单**（由 §6 每行推出，不是拍脑袋列的）：

| 组件 | 来源行 |
|------|--------|
| `ProposalCard` | §6.3 四态 |
| `CandidatePicker` | §6.1 `miss_ambiguous` |
| `ConfidenceBadge` | §6.1 `fuzzy` / `miss_low_confidence` |
| `SafetyNotice` | §6.4 |
| `RetryableError` | §6.2 `max_steps` / `crash` / `aborted` |
| `TodayBar` | §2 任务 2 |
| `AgentProgress` | §5 流式进度 |
| `MacroDisplay` | §2 任务 2、5 |

**Token 语义**：使用 **semantic UI roles**（如 `status-warning` / `status-danger` / `surface` / 宏量功能色），由 **component variant** 映射领域态（pending/stale、置信度、gate）。避免通用 `primary/secondary`，也避免 token 名与领域枚举 1:1 耦合（如 `proposal-stale-background`）。三层：primitive → semantic role → component variant。

## 9. Done when

本 RFC 标记 Implemented 的条件：

- [ ] §6 全部行在 UI 中有明确呈现，无"压成同一种视觉"的残留
- [ ] `miss_ambiguous` 可点选，不要求重打字
- [ ] `max_steps` / `crash` / `aborted` 保留用户输入
- [ ] `allergenTags` 与 drug-nutrient interactions 在确认前可见
- [ ] 今日条读 `daily_totals`，无新增 SQL
- [ ] §7 指标可从 trajectory 导出

## 10. 开放问题（已决 / 边界）

1. ~~`miss_unknown` 是否允许用户手填营养值直接入账？~~ **已决**（2026-07-23）：主路径是**菜谱分解**（拆到 catalog 基础食材，营养由代码算），手填仅作为包装食品的逃生舱。不引入 web search。边界见 `docs/adr/0003-recipe-decomposition-boundary.md`，设计见 `docs/rfc/0005-recipe-decomposition-and-custom-foods.md`。**RFC 0005 §10 新增的 UI 状态需并入本文 §6 矩阵**；0005 未落地前，本 RFC 的 §6 主矩阵仍可独立实现。
2. ~~`stale` 判定放前端还是后端？~~ **已决**：hybrid —— 后端 commit 权威 + 前端 stale 提示（§6.3）。
3. ~~是否引入 shadcn/ui？~~ **已决**：窄引入、按需。优先 **Sheet / Dialog**（Today 展开、候选选择器）。不迁移全站 Button/Card/Form；不预装 Popover。
4. **RFC 0005 扩展边界**：分解 / 自建食物 / 微量 unknown UI **不**阻塞本 RFC 的安全补丁、提案生命周期、resolver 失败出路、TodayBar。未解析配料在 0005 中 **阻塞定稿**（可编辑，不可静默跳过）—— 见 0005。
