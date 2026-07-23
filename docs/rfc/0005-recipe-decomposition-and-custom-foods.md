# RFC 0005 — 菜谱分解与自建食物

> Status: **Proposed** (2026-07-23) — 待评审。
> **Not always-on agent context** — 只在做 catalog / resolver / 自建食物路径时打开。
> Authority: `docs/adr/0003-recipe-decomposition-boundary.md` 定边界与不变量；本文定设计。
> Architecture source of truth: `docs/ADD.md`。本文不改 gate、observation、matchType 的定义。
> 关联: `docs/rfc/0004-frontend-ux-contract.md` §6 定 UI 状态覆盖；本文新增的状态回填至该矩阵。

## Why

`resolver` 的 `miss_unknown` 目前是死路：catalog 里没有的食物，用户无法记录。而复合菜品（意面、宫保鸡丁）永远不会直接命中 catalog —— catalog 存的是基础食材。

ADR 0003 判定解法是**分解**而非**覆盖**：把复合菜品拆为基础食材引用 + 克数，营养由代码从 catalog 事实计算。这条路径不需要新数据源、不需要模型提供数字、不需要打开 Phase 5。

## 1. Scope

**In scope**

- 菜谱分解：复合菜品 → 基础食材引用 + 克数 → 计算 per100g → 存为自建食物
- 自建食物：用户手录营养标签，服务拆不到基础食材的包装食品
- 自建食物库的版本化与快照身份
- 微量营养素缺失的诚实表达

**Non-goals（明确排除）**

- web search / knowledge RAG —— Phase 5 指标闸保持关闭（ADR 0001 / ADD:127,151）
- 预置菜谱库 —— dogfooding 阶段模型提议 + 用户确认已足够
- 包装食品公开库摄入（Open Food Facts 等）—— 架构上同构于 USDA snapshot ingestion，但不在本 RFC
- 修改 `MatchType` union、observation 来源、任何 gate 判定逻辑

## 2. 不变量

> **菜谱永远不携带营养数字。**

菜谱携带：配料的 catalog food id、各配料克数、成菜重量。营养值全部由代码计算。模型的职责是提议组成结构，与它在 `log_meal` 上已有的职责同构。

这条守住，`numericProvenanceGate` 无需任何改动 —— 菜谱营养源自 catalog observation，天然可溯源。

## 3. 菜谱分解

### 3.1 流程

```
用户: "午饭吃了一顿宫保鸡丁"
  ↓ resolver → miss_unknown
模型提议组成（不含任何营养数字）:
  鸡胸肉 150g / 花生 20g / 青椒 50g / 食用油 12g / 酱油 8g / 糖 5g
  ↓ 每项走 resolver 铸造 food id
  ↓ 用户确认或调整克数
  ↓ 用户填成菜重量（默认 = 配料总重，可改）
计算 per100g = Σ(配料营养) ÷ 成菜重量
  ↓
存为自建食物「宫保鸡丁」
  ↓
本次记录 = 普通 1 行 meal_logs
```

### 3.2 成菜重量

配料生重之和 ≠ 成菜重量（烹饪失水）。若按生重算 per100g，用户说"吃了 200g 宫保鸡丁"时营养会**系统性低估** —— 熟食每克营养密度更高，且偏差单向。

因此建菜谱时必须采集成菜重量，默认填配料总重供用户修正。该值同时用于自动生成 `portionAliases`：`{ 顿: 成菜重量, serving: 成菜重量 }`，使"一顿 x"可确定性解析。

### 3.3 二次命中

菜谱存为自建食物后，第二次吃直接 exact 命中，无需重新分解。这直接服务 RFC 0004 §7 的「记一餐 < 10 秒 / ≤ 2 次交互」指标。

### 3.4 落地形态

菜谱**不引入新表、不改 `meal_logs` schema**。它复用自建食物机制：一个自建食物，其 per100g 由配料计算而来，配料清单存在自建食物定义内作为 provenance。记录时是普通 1 行。

## 4. 自建食物（逃生舱）

仅服务拆不到基础食材的包装食品（某品牌饼干、蛋白棒）。用户手录包装营养标签 —— 用户持有实物标签，权威性高于任何检索结果。

中国预包装食品强制标注能量 / 蛋白质 / 脂肪 / 碳水 / 钠，恰好覆盖 `MacroNutritionPer100g` 加钠。其余微量营养素按 §5 存为 unknown。

**模型不参与此路径。** 用户直接填表单，数字不经模型之手。

## 5. 微量营养素缺失

`NutritionPer100g` 当前 14 项全部必填。自建食物无法凑齐，需改造：

- 四大宏量（kcal / proteinG / fatG / carbsG）保持必填
- 微量项转为可选，缺失即 **unknown**，不以 0 填充
- 聚合查询返回形状需能表达「部分未知」：`{ known: 8.2, unknownCount: 2, unknownFoods: [...] }`

**理由**：以 0 填充会使微量营养素统计系统性偏低且不自知 —— 用户以为铁摄入达标，实际是自建食物那部分没算。对营养应用这是真实危害，且与架构「不确定性必须可见」的基调相悖。

回答"今天铁够吗"时必须诚实报告：「已知部分 8.2mg，但螺蛳粉的铁含量未知」。

## 6. 快照身份与可复现性

`resolveFood` 用 `catalog.snapshot.version` 给结果盖戳，注释说明是为了 traces 可复现（issue #60）。自建食物不属于任何 USDA 快照。

**决定：复合快照号。**

```
usda-sr-legacy-2026-07-v1+user:42:v3
```

自建食物库自身 append-only 版本化，每次新增 / 修改递增。trajectory 完整可复现，eval golden 不因用户新增食物而漂移。

`meal_logs` 的 freeze-at-write-time 原则（`0002_meal_logs.sql` 注释）意味着历史记录不受后续编辑影响，编辑自建食物是安全操作。

## 7. Provenance

复用已有的 `nutritionSource` 字段（`logMeal.ts:431` 现设为 `resolved.catalogSnapshotId`，已持久化至 `proposals.nutrition_source` 与 `meal_logs`，且 `app/chat/page.tsx:561` 已在显示）。

复合快照号落地后**两档区分自动成立**，零额外代码：

| 值 | 含义 |
|----|------|
| `usda-sr-legacy-...` | USDA 实测事实 |
| `usda-...+user:42:v3` | 含自建食物成分 |

更细的分档（推导 vs 手录）判定为冗余：菜谱推导的食物必然存有配料表，手录的必然没有，「有无配料表」这一事实本身即可区分。`nutritionSource` 是自由字符串，未来需要时可加后缀，不影响已有数据。

## 8. 安全性

**无需新增机制。** `catalog.ts:96-99` 已定义：`allergenTags: undefined` = 未审核，**可记录、不可推荐**，output entity check 对其 fail closed（ADD §Gates check (a)，ADD:101 亦述）。

自建食物默认 `allergenTags: undefined`，除非用户显式审核。这正是所需语义：你自己加的食物能记账，但 agent 不会主动推荐它。

## 9. 不改动清单

明确不动，避免实施时漂移：

- `MatchType` union（`exact | alias | fuzzy | miss_*`）—— 匹配质量与数据来源是正交概念，不可混编
- observation 来源 —— 仍限 reviewed SQL 模板
- 四个 gate 的判定逻辑
- `meal_logs` schema
- `numericProvenanceGate` 实现

## 10. UI 状态（回填 RFC 0004 §6）

本 RFC 新增以下用户可见状态，需并入 RFC 0004 的失败路径矩阵：

| 状态 | UI 契约 |
|------|---------|
| `miss_unknown` → 提议分解 | 展示配料清单，每项可改克数、可删、可加 |
| 分解中配料自身 miss | 该配料单独走 §6.1 的 miss 处理；**编辑器不 abort**，但未解析项 **阻塞最终保存**（可 resolve / 替换 / 显式删除，不可静默跳过） |
| 成菜重量采集 | 默认填配料总重，明示这会影响 per100g |
| 自建食物表单 | 四大宏量必填，微量可空；空即 unknown，不显示为 0 |
| 聚合含 unknown | 诚实标注「X 项未知」，不静默求和 |
| 二次命中自建食物 | 与 catalog 命中视觉可区分（provenance 两档） |

## 11. Done when

- [ ] 菜谱分解可从 `miss_unknown` 走通至 commit，全程模型不输出营养数字
- [ ] 成菜重量参与 per100g 计算，并自动生成 `portionAliases`
- [ ] 二次吃同一菜谱 exact 命中，不重新分解
- [ ] 微量缺失存 unknown，聚合查询能表达「部分未知」
- [ ] 复合快照号落地，自建库 append-only
- [ ] `numericProvenanceGate` 与全部 gate 判定零改动，goldens green
- [ ] §9 清单确实未被改动

## 12. 开放问题（已决默认）

1. ~~旧版本是否可读？~~ **已决**：历史版本长期可读（append-only），trajectory 引用的版本必须可解析。
2. ~~配料存何处？~~ **已决**：自建食物定义内 **versioned JSON** 优先；无跨菜谱查询需求前不拆表。
3. ~~缺失配料 skip vs block？~~ **已决**：**阻塞最终保存**（编辑器可继续；不可静默省略油/酱/糖等）。用户须 resolve、替换或显式删除该配料后才能定稿。
