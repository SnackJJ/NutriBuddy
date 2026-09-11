# NutriSimulator 设计结论

> Research note: 2026-08-04  
> 来源：对照 [ShopSimulator / 长程购物 Agent RL 实践](https://yyhdbl.github.io/) 与 NutriBuddy 现有 ADD 的讨论整理。  
> 地位：**训练/评测向环境** 的设计结论；非正式 ADR。与产品架构冲突时，以 `docs/ADD.md` / ADR 为准。  
> 产品交付（PWA 等）见 `docs/adr/0002`；本文不改写交付形态。

---

## 1. 目标（第一性）

**NutriSimulator 的目标不是「做一个永远不会犯错的营养规则引擎」。**

目标是：

> **训练（并评测）一个能自主完成营养助理工作的 Agent**  
> ——会查知识、会读个人资料、会做推荐/记餐，并在过程中自己学会什么合理、什么不安全。

与 ShopSimulator 同构：

| | ShopSimulator | NutriSimulator |
|---|---|---|
| 不是 | 永远买对的购物脚本 | 永远推对的规则引擎 |
| 是 | 会自己搜、核验、决策的购物 Agent | 会自己查、结合个人状态、建议/记餐的营养 Agent |

### 1.1 目标 → 设计选择

| 目标 | 设计选择 |
|------|----------|
| 让模型学会自己搜寻知识 | Env 提供可查询食物/知识库 + 有限动作（resolve / inspect / query）；不把答案预置进 prompt |
| 让模型学会使用个人背景 | Profile + Ledger 作为状态；模型决定是否用、怎么用；用对与否由终局与安全面板评判 |
| 让模型学会合理推荐 / 记餐 | **允许错误推荐/错误记餐在 episode 内发生**，用 Reward 告诉好坏 |
| 让模型学会安全边界 | 安全主信号写在 **Reward / Scorer**，而不是 Env 提前砍掉所有危险语义选项 |
| 保持可换脑 | Policy（harness + 模型）外置；同一 Env 可跑 scripted / 参考 ReAct / 强模型 / 未来 RL |

### 1.2 一句话

> **Env = 可交互的营养世界（结构合法 + 可查知识 + 个人状态）**  
> **Policy = 自己搜、自己看、自己决定**  
> **Reward = 告诉这次推荐/记录好不好、安不安全**

训出来的是「会当助理的 Agent」，不是「在已经排好安全通道的走廊里走路的脚本」。

---

## 2. 关键概念：不要把三层揉成一层

讨论中反复混淆的三件事：

| 层 | 含义 | Nutri 例子 |
|---|---|---|
| **Environment** | 世界：状态、动作、观测、转移、结构 Guard | catalog、ledger、step(action) |
| **Eval / Reward harness** | 轨迹怎么打分、任务成不成功 | 安全面板、provenance、任务成功 |
| **Agent scaffold / policy harness** | ReAct 循环、prompt、模型、步数策略 | 现有 `loop.ts`、Codex、未来小模型 |

前沿 agent bench（SWE-bench、τ-bench、WebArena、ShopSimulator）共性：

- Env 几乎都是 **可操作世界**，不是「只给静态知识库」
- **Eval harness** 通常自带；**Agent scaffold** 不一定自带
- 分数经常是 **model + scaffold + 预算** 的系统分，不是裸模型分
- **不是**「只插 API key 就能公平 eval」——至少要接 tool 协议与动作循环

SWE-bench 尤其典型：**Docker 评测 harness** 与 **SWE-agent 等 agent 脚手架** 是两套东西。

---

## 3. 「Env 只提供营养成分？」——不对

### 3.1 错误缩法

> Env ≈ 食物营养表（只读）

这只相当于 Shop 的 **Catalog-Fine 商品表**，不是完整环境。

### 3.2 正确心智模型

```text
底料（像淘宝商品库）
  food catalog / 营养 / allergen tags / alias / portion aliases
  + catalog_version（可复现）

+ 用户世界状态（购物 episode 通常没有对等物）
  profile · constraints · meal ledger · proposals

+ 动作与规则
  resolve / inspect / query_templates / propose / confirm / submit_answer …
  + Action Guard（结构合法）
  +（训练时）语义对错与安全主要靠 Reward

= NutritionEnv / NutriSimulator
```

### 3.3 和「薄荷健康类 App」的关系

| 说法 | 对吗 |
|---|---|
| Env ≈ 真实可用的营养 **领域内核**（查成分、记餐、档案） | ✓ |
| Env = 完整 C 端 App（社区、运营、全部 UI） | ✗ 偏大 |
| Env = 只读营养成分表 | ✗ 偏小 |
| 人用 UI 与 agent 用 CLI/MCP 应共用同一内核 | ✓ |

更干净的表述：

> **NutritionEnv = 可持久化的营养领域服务 + 可版本化的状态与动作契约。**  
> **人用 App 与 agent（CLI/MCP）都是 client；对话 harness 是可选 policy，不是 Env 本身。**

---

## 4. ShopSimulator → NutriSimulator 组件映射

| # | ShopSimulator | NutriSimulator | 职责 |
|---|---|---|---|
| 1 | 商品 Catalog snapshot | Food catalog snapshot | 静态世界底料；运行时不调 USDA |
| 2 | 搜索（BM25 等） | Resolver + search | 字符串 → 实体；禁止 mint food_id |
| 3 | 当前页 / 打开商品 / 已选规格 | Session + 候选 / 详情 / 草稿 | 可见 id 集合 |
| 4 | （轻）用户画像 | **UserProfile + constraints** | 个人世界；营养任务必要条件 |
| 5 | （通常无）长期订单史 | **Meal ledger** | 聚合题与记餐题的状态 |
| 6 | 选规格 / 购物车 | **Proposal 状态机** | 写前缓冲；confirm 才入账 |
| 7 | Action 空间 | Nutrition actions | 有限、schema 化 |
| 8 | Action Guard | **结构** Action Guard | 只能「点得到的按钮」 |
| 9 | Observation + projection | Typed observation + projection | 防爆上下文；id 不截断 |
| 10 | purchase / stop | submit_answer / propose / confirm / abstain / clarify | 终局原语 |
| 11 | Reward（类目/属性/规格/价） | **多面板** Reward/Scorer | 见 §7 |
| 12 | Task + gold ASIN + TaskFacts | Task + TaskFacts + 冻结 rubrics | 可复现基准；防泄漏 |
| 13 | max steps / 循环截断 | 同构 | 防无限刷分 |
| 14 | 可选用户澄清 | 可选 UserSimulator | 多轮确认/澄清 |
| 15 | 外置 Agent harness | 参考 policy + 可替换 scaffold | 不焊进 env |
| 16 | 轨迹日志 | Trajectory / typed events | 评测与（未来）RL 资产 |

### 4.1 相对 Shop 的三处硬差异（设计时写死）

1. **状态更重**：没有 profile + ledger，多数营养任务无定义。  
2. **写入两阶段**：`propose` ≠ 购物的一键 `purchase` 成功；诚实记餐 = propose + confirm + ledger。  
3. **安全信号形态**：训练时以 Reward 为主教「判断」；**部署**时可再加硬闸（§8），不把 train env 做成语义禁飞区。

---

## 5. Env / Policy / Reward 分工（宪章）

### 5.1 Env 只做：世界物理 + 接口合法

**做：**

- food_id 必须来自 resolve / 当前可见集合  
- template 与参数合法；无 free-form SQL  
- proposal / confirm 状态机合法  
- 份量缩放、query 汇总等 **数字由 Env 计算**（世界事实，不是 agent 心算）  
- catalog / profile / ledger 转移真实、可版本、可复现  
- Observation 投影（给 policy 的 cap 视图 vs 全量 trace）

**不做（训练 env）：**

- 禁止「推荐过敏原」这类 **语义** 危险动作本身（应允许走完再打分）  
- 禁止「营养不完美 / 搭配不好」  
- 把 gold 答案塞进 observation  
- 替模型决定推谁、推什么

结构非法 ≠ 决策错误：

| 类型 | 训练 env 行为 |
|---|---|
| 编造未出现的 food_id | **Action Guard 拒绝**（与 Shop 点假按钮同级） |
| 推荐了真实 catalog 里的过敏食物 | **允许发生** → Safety 面板负分 |
| 输出中的数字不在 observation 中 | 允许提交 → Provenance 面板惩罚 |

### 5.2 Policy（Agent scaffold）做：搜、读、决策、表述

- 何时 resolve / query / read_profile  
- 在合法动作里选什么  
- 如何措辞、是否 clarify  
- 模型与 prompt、步数策略可随能力变薄（Bitter Lesson 作用在 **policy 复杂度**，不是拆掉世界规则）

### 5.3 Reward / Scorer 做：好坏与安全（主学习信号）

**不要压成单一总分**（对齐购物 blog：分面板才看得见「成功率升了但循环也多了」）。

建议四面板：

| 面板 | 内容 |
|---|---|
| **任务成功** | 记餐是否正确、问题是否完成、合法替代是否接受 |
| **安全** | 终局 **推荐** 是否违反过敏/高危药食等硬约束 |
| **证据 / 数字** | 是否 grounding；单位数字是否 ⊆ observations（provenance） |
| **过程** | 重复无效动作、Guard 次数、过早放弃、超步 |

### 5.4 记餐 vs 推荐必须分轨打分

| 行为 | 过敏用户场景 | 期望 |
|---|---|---|
| 用户自述吃了虾 → **诚实记入 ledger** | 描述正确 | 加分或中性（tracker 不能拒真） |
| Agent **主动推荐**再吃虾 | 决策错误 | 安全大负分 |

混用一条「碰过敏原就罚」会学坏：模型拒绝记真实摄入。

---

## 6. 动作空间与 Observation（草案级）

### 6.1 动作（镜像 Shop 的 search / open / purchase）

| 动作 | 作用 |
|---|---|
| `resolve_food` / `search_foods` | 文本 → 候选；不 mint id |
| `inspect_food` / `get_nutrition` | 详情与按克营养（缩放在 env） |
| `query(template_id, params)` | 日合计、区间对比等 reviewed templates only |
| `read_profile`（可选） | 显式读取档案；或与 pin 摘要并存 |
| `propose_meal` | 只产生 proposal，不直写 ledger |
| `confirm_proposal` / `void_proposal` | 写路径终局；可为人或模拟用户 |
| `submit_answer` | 建议/问答终局（typed 结构优先） |
| `ask_clarify` / `abstain` | 澄清或充分探索后放弃 |

### 6.2 Observation 要点

- `page_type`、可见 `food_id`、schema 稳定的 rows、match_type、candidates  
- proposal 预览、guard 拒绝原因与合法下一步提示  
- 给 policy 的视图可 cap；**全量进 trajectory**（对齐 Shop projection + 训练需求）

### 6.3 Episode

可选两种协议（实现前二选一写进 spec）：

- **A. 单段**：utterance → 多步 → answer 或 propose+confirm 同 episode  
- **B. 两段**：Ep1 到 proposal_pending / answered；Ep2 structured confirm（可无 LLM）——更贴近真人确认  

截断：max_steps、重复循环、无新证据（对齐 Shop）。

---

## 7. 任务与数据纪律

### 7.1 任务族

| 族 | 意图示例 | 成功信号方向 |
|---|---|---|
| lookup | 某食物某营养素 | resolve + 数字有 observation |
| constrain | 「我能吃虾吗」 | 正确 advise/refuse 或推荐不违规 |
| aggregate | 本周铁/蛋白 | 必须 query；禁空口汇总 |
| log | 记两个鸡蛋 | propose + confirm 后 ledger 正确 |
| plan | 增肌晚餐建议 | 多 FoodRef 合法 + 有据 |
| edge | 未知/歧义名 | typed miss / clarify，不编 id |

### 7.2 防泄漏（抄 Shop）

- 按 `task_id` 隔离 Teacher / 训练 / Final  
- Final 集冻结；不参与调 prompt / 改 guard 刷分  
- Judge / rubric **不直接喂 gold food_id 当唯一答案**；硬约束从用户 Query 提炼并冻结 hard/soft  
- 允许多个 valid 推荐集（类 Shop `valid_alternative_purchase`），减少背 ASIN/food_id  

---

## 8. 训练环境 vs 产品部署（必须写进宪章）

| 场景 | 安全怎么处理 |
|---|---|
| **NutriSimulator 训练/评测** | Env **不**用语义禁飞砍掉危险推荐；**Reward** 主教安全与质量；仅结构 Guard |
| **线上产品 / 对人输出** | 训练好的 policy + **可选部署闸**（fail-closed），残余错误不外溢 |

```text
训练：宽环境 + 严打分  →  模型学会判断
部署：同一能力 + 薄硬闸 →  不对人释放不可逆伤害
```

这与「目标是学做助理、不是规则引擎」不矛盾：  
**规则引擎不替代学习；部署闸不替代训练信号。**

与现有 NutriBuddy ADD 的关系：

- ADD 的 Safety Thesis、output/commit gates 更贴近 **产品/部署契约**  
- 本文 NutriSimulator 宪章更贴近 **训练环境契约**  
- 中长期理想形态：**同一领域内核（catalog/state/actions）**；train 与 deploy 在 `submit_answer` 等点上配置是否挂硬闸  
- **未做拆分前**：以 ADD 为运行中产品 SoT；本文约束「若做 simulator / 拆 env」时的设计方向  

### 8.1 Bitter Lesson 边界

| 随模型变强可变薄 | 不应「教训掉」 |
|---|---|
| Prompt 流程、过厚策略 harness、软提醒 | 结构合法（真 id、真状态机） |
| 部分仅为补弱模型的软 Guard | 世界事实计算（营养缩放、query） |
| | **部署**时的 C1 硬闸（产品选择） |
| | 可复现的 Env 版本与任务冻结 |

Bitter Lesson 作用在 **policy 脚手架复杂度**，不是「营养世界不要规则、安全只靠模型自觉上线」。

---

## 9. 与「约束放 agent 还是 env」讨论的收束

「图书馆」比喻的正确用法：

| 路径 | 开放度 | 训练时谁教对错 |
|---|---|---|
| **查阅**（查虾营养、查账本） | Env 应开放 | 用没用对 → 任务/证据分 |
| **记餐**（诚实记录） | Env 应允许真实摄入 | 记对 → 任务分；不因过敏禁记 |
| **推荐**（你该吃…） | 训练时 **允许错推走完** | **安全面板**重罚 |

约束 **数据**（档案里有什么限制）在 Env 状态。  
约束的 **学习** 靠 Reward。  
约束的 **生产拦截** 是部署层选项，不是 train env 的语义 Action 删除。

Profile 读取策略（实现可选）：

- pin 摘要在 obs_0：少漏读噪声  
- 或强制 `read_profile`：强化工具使用  
- 原则不变：**用没用对由终局 + 安全面板判**，不是「多点一次工具就赢」

---

## 10. 发行物切分（建议）

| 包 | 内容 | 类比 |
|---|---|---|
| `nutri-env` | catalog、state、step、结构 Guard、obs、轨迹 | ShopSimulator 本体 |
| `nutri-bench` | 任务集、split、scorer 面板、runner | Final-200 + 评测 pipeline |
| `nutri-agent-ref` | 最小 ReAct + tool schema | 轻量 shopping harness |
| （产品）surfaces | PWA / CLI·MCP client | 非 env 本身 |

最小 API 形状：

```text
reset(task) → Observation
step(action) → { observation, events, guard, done, terminal? }
score(trajectory, task) → ScorePanels
```

Determinism：固定 catalog_version、clock、profile、ledger fixture → 同 action 序列同结果。  
LLM 只出现在 policy / 可选 user-sim / 可选过程 judge；**安全面板以规则与事件为主**。

---

## 11. MVP 建议（若落地 simulator）

**P0**

1. 小 catalog + resolver  
2. Profile + ledger + proposal  
3. Actions：resolve、nutrition/inspect、2～3 query templates、propose、confirm、submit_answer  
4. 仅结构 Action Guard  
5. 三面板 scorer：任务 · 安全 · 证据（过程可简化）  
6. 50～100 tasks：lookup / constrain / log  
7. Scripted policy 证明 env 可测  

**P1**

- 冻结 Final 集与 rubrics、reference ReAct、CLI/MCP `step`  
- aggregate / plan 任务族  

**P2**

- UserSimulator、过程 LLM judge（不作安全唯一依据）、RL 接口、catalog 放大  

---

## 12. 与当前 NutriBuddy 仓库的关系

| 已有（偏产品 harness） | Simulator 视角 |
|---|---|
| catalog / resolver / query templates | Env 底料与读动作 |
| proposal + confirm short-circuit | Env 写路径状态机 |
| gates + event stream + scorer | 接近 **部署闸 + eval**；训练向需区分「语义不砍动作」 |
| `turn` / ReAct loop | **Reference policy**，应可拔出 |
| PWA（ADR 0002） | Surface；CLI 现为 dev/eval，可升为 agent client |
| NutriMind | 未来在同一 Env 上训小模型的位置 |

当前项目可概括为：**Env 零件 + Agent harness 杂合的应用**。  
更清晰的方向：**领域内核稳定可持久化；policy harness 随模型可换、可薄；训练用宽 env + 严 reward；产品用同一内核 + 部署闸。**

本文 **不** 要求立刻拆仓或改 ADD；它固定「若按 Shop 路线做 NutriSimulator，宪章是什么」。

---

## 13. 结论摘要

1. **目标**：训/评会自主完成营养助理工作的 Agent，而非永不犯错的规则引擎。  
2. **Env**：食物库 + 个人状态 + 合法动作 + 结构 Guard + 可观测证据；不是「只读营养表」，也不是完整 C 端 App。  
3. **Policy**：可替换；负责搜寻、结合档案、决策与叙述。  
4. **Reward**：任务 / 安全 / 证据 / 过程分面板；允许错误推荐在训练 episode 出现；记餐与推荐分轨。  
5. **部署**：可另加硬闸；不把 train env 做成语义禁飞区，也不把生产安全完全交给模型自觉。  
6. **对标 Shop**：组件一一可映射；Nutri 额外强调 profile/ledger、propose/confirm、安全与记餐分轨。  
7. **产品**：ADR 0002 的 PWA 主 surface 仍成立；simulator 与 CLI/MCP 是内核的评测与 agent 入口，不是二选一替代关系。

---

## 14. 参考

- 讨论所对标实践：[面向长程购物 Agent 的 RL 后训练](https://yyhdbl.github.io/)（ShopSimulator 环境、Action Guard、Reward 分档、评测先行、Harness 与模型协同）  
- 本仓库：`docs/ADD.md`（产品 harness 与 Safety Thesis）、`docs/adr/0002`（交付形态）、`CONTEXT.md`（术语）  
- 横向语境：SWE-bench（env/评测与 agent 脚手架分离）、τ-bench（工具 + 状态 + policy + user sim）、WebArena（可操作网站世界 + 系统分）
