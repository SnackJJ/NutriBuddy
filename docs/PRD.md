# NutriBuddy — PRD / 项目骨架

> **一句话定位**：用 RL 让一个端侧小模型，在一个自建的 agent harness 里，可靠地扮演个人营养顾问。
> **营养是 benchmark，harness 是手段，on-device 是终点。**

---

## 0. 这份文档怎么用

这是一份**工程项目骨架**，不是产品需求清单。它的每一节都对应你最终要亲手拥有的一块东西。带 `→ 指标` 的地方是你做完后能写进简历/报告的可量化结果，带 `[P0/P1/P2]` 的是优先级。

---

## 1. 项目目标与非目标

### 目标（Goals）

1. **学 harness 工程**：亲手拥有 control loop、context 组装、memory、verification、retrieval、tracing 这几块核心，理解前沿 coding agent 解决长程任务的设计模式，并迁移到一个非编码领域。
2. **做出可量化的可靠性**：在一个"算错数字、忘记约束都会出事"的安全敏感领域，把一个不可靠的 LLM 通过 harness 做到**可测量的可靠**。
3. **端侧 + 小模型 + RL 适配**（终极目标）：通过 SFT + GRPO 让一个手机能跑的小模型学会这套 harness 的 agent 行为。

### 非目标（Non-Goals）—— 同样重要

- ❌ **不做"录入快"的红海竞争**。拍照数卡路里 + 验证过的食物库是 commodity（有人 8 小时就能拼一个），不是我们的护城河，**不投入**。
- ❌ **不建在 LangGraph / CrewAI 这类框架上**。框架会过时，且会让框架掌管控制流和上下文——而那正是本项目要自己长出来的肌肉。
- ❌ **不追求 native App**（初期）。Web-first + PWA，后端/agent 平台无关。

### 一条贯穿全文的原则

> **自己拥有"机械"（loop / context / memory / verification / trace），把"管线"（调模型 / 存向量 / rerank）交给库。**
> 要躲的不是"用库"，是"让框架替你掌管控制流"。

---

## 2. 定位：在哪条线上发力

| | 录入/识别层 | **建议/咨询层（本项目）** |
|---|---|---|
| 用户痛点 | adherence（坚持不下来） | 建议不可信、不个性化、不安全 |
| 实现 | 单次视觉推理 + 食物库 | agentic RAG + 记忆 + 验证 |
| 市场 | 红海、commodity | 大家在叠、但都很浅 |
| 是否 harness 形状 | 否 | **是** |

**结论：别拼"录入快"，去做没人做好的"建议可信"。护城河是 harness 的 reliability，不是 UI。**

---

## 3. 要解决的模型痛点（项目的核心弹药）

这一节是简历和报告里最值钱的部分：每一行都是 **痛点 → harness 机制 → 可量化指标**。

| # | 模型痛点 | harness 解法 | 指标 | 优先级 |
|---|---|---|---|---|
| ① | **数字幻觉**（LLM 估卡路里误差 25–40%，份量估计低到 39%） | 绝不让模型 freehand 数字；强制查营养库；算术放进代码 | 卡路里/宏量误差率（接入前后） | P0 |
| ② | **忘记硬约束**（过敏/疾病） | allergies/conditions 每轮注入为 hard constraint + 代码层 validation gate，违规打回重生成 | **constraint-violation rate → ~0** | P0（主打） |
| ③ | **无依据健康断言** | RAG grounding 到权威源（NIH ODS/膳食指南）+ 引用强制 + safety pass（医疗类转向就医） | groundedness / 引用覆盖率 / 越界转向率 | P0 |
| ④ | **看不见趋势**（如连续超标） | harness 预计算聚合/摘要再喂入 | — | P1 |
| ⑤ | **脏的食物实体解析**（「一碗米饭」→克数→库条目） | normalization 工具 + 歧义消解 loop（多匹配反问） | 实体匹配准确率 | P1 |

> ① 和 ② 含金量最高：它们把"模型不可靠"变成"系统可靠且可量化"，这正是 harness 存在的意义。

---

## 4. 系统架构：八个模块

你"像 Claude Code 那样、不靠框架"的 harness = 亲手拥有这八块，只用库去填里面的料。

```
                         ┌─────────────────────────────────────┐
   用户消息 ──────────▶  │  ① Loop (turn 循环, MAX_STEPS)        │
                         │     ├─ 调 ② ContextAssembler 拼上下文 │
                         │     ├─ 调 ⑧ ModelAdapter 生成          │
                         │     ├─ 调 ③ ToolRegistry 执行工具      │
                         │     └─ 调 ⑥ Verifier 判停/校验         │
                         └───────────────┬─────────────────────┘
                                         │ 全程
                         ┌───────────────▼─────────────────────┐
                         │  ⑦ Tracer (记录每一步, 可观测)        │
                         └───────────────────────────────────────┘

   ② ContextAssembler ──读──▶ ④ MemoryStore (profile/状态/情景)
                       ──调──▶ ⑤ Retriever (双路检索)
   ③ ToolRegistry ─────────▶ 营养API / 数据库 / ⑤ Retriever
   ⑤ Retriever 内部 ───────▶ [向量库 / BM25 / reranker]  ← 库只出现在这里
   ⑧ ModelAdapter ────────▶ v1: API 模型   v2: 端侧 Qwen
```

| 模块 | 职责 | 自建 or 用库 |
|---|---|---|
| ① **Loop** | turn 循环，编排，MAX_STEPS，可中断 | **自建**（几十行） |
| ② **ContextAssembler** | 每轮拼 system + memory + 检索结果 + 历史；compaction | **自建** |
| ③ **ToolRegistry + dispatch** | schema、执行、错误即消息、结果截断 | **自建** |
| ④ **MemoryStore** | profile/状态/情景三层 + 注入策略 + memory extraction | **自建** |
| ⑤ **Retriever** | 双路：个人事实确定性查询 + 知识 agentic RAG | 自建逻辑，**库填料**（向量库/reranker） |
| ⑥ **Verifier** | 覆盖判停 + 约束/安全闸 | **自建**（将来即 RL reward） |
| ⑦ **Tracer** | 记录每一步（模型看到什么/决定什么/工具返回什么） | **自建** |
| ⑧ **ModelAdapter** | 可换模型：native function-calling ↔ 纯文本+regex | **自建接口**，SDK 填料 |

> 框架最想替你管的正是 ①②③，而那恰恰是你最该自己拥有的。库只该出现在 ⑤ 内部和 ⑧。

---

## 5. 记忆架构（MemoryStore）

核心问题永远是：**什么时候、把什么、放进有限的 context window。**

| 层 | 内容 | 存哪 | 注入策略 |
|---|---|---|---|
| 工作/短期 | 当前对话 | context window | 在窗口里，变长则 compaction |
| **Profile（语义）** | 身体指标、过敏、饮食习惯 | 持久库 | **每轮必注入** system prompt（小而关键） |
| **当前状态（中期）** | 如「减脂中，目标 1800 kcal」 | 持久库（goal 记录） | **每次会话载入**，结束即改 |
| **情景** | 过去对话/事件 | 持久库 + 向量索引 | **按相关性检索**（RAG），相关时才注入 |

**三个工程决策（省 token 就省在这）：**
1. **memory extraction**：对话结束后决定哪些写回长期库（不是什么都存）。
2. **注入策略**：小 profile 常驻，大情景按需检索。
3. **窗口精简**：compaction + 工具结果截断。

---

## 6. 检索设计（Retriever）—— 双路分离

> 这是本 agent 设计上最该想清楚的一刀。按**信息的性质**选检索方式，而不是一把 RAG 梭哈。

### 路 A：个人事实（确定性查询，这是你的 "grep"）
- 数据：过敏、指标、当前状态、今日已摄入 —— **结构化、可精确定位、安全红线**。
- 做法：`SELECT ... FROM profile` 这种确定性查询，**harness 预取，保证一定在场**。
- 绝不用语义 RAG —— 不能"检索漏"过敏史。

### 路 B：权威知识（agentic RAG）
- 数据：营养事实、膳食指南、营养-药物相互作用 —— **非结构化、语义化、基本静态**（所以预建索引划算，不存在"索引过期"问题）。
- 做法：hybrid 检索（BM25 + 向量 + reranker）+ **agentic 多轮 + 覆盖判停**。

### "搜得够不够"的判停机制（路 B 核心）
1. **先拆**：把问题分解成需要哪些事实点（checklist），而不是直接冲去搜。
2. **覆盖检查**：每轮标注 checklist 哪些被检索证据覆盖了、哪些还空 —— 判据是"context 里有没有支撑"（可读、可靠），**不是模型内省"我知不知道"**。
3. **触发下一轮**：还有空项 → 用空项当新 query 再检（模型 emit `search` 而非答案）。
4. **停**：checklist 全覆盖 / 连续几轮无新增覆盖（收益递减）/ 撞 `MAX_SEARCH_ROUNDS`。
5. **blocking 项**：个人约束类（过敏）是"**必须覆盖否则不许作答**"，不是普通待办。

实现档位（按精力选）：**b 计划+待办工具** 起步 → 叠 **c 缺口分析一轮** → 叠 **d 相关性分数 + 新颖度判停 + 硬上限**。

---

## 7. 工具规格（ToolRegistry）

> 原则：工具是给模型用的 API，**工具返回值本身就是 prompt**；错误是一等公民（失败 → 模型读得懂的消息，不崩）。

| 工具 | 作用 | 副作用 | 备注 |
|---|---|---|---|
| `get_food_nutrition` | 查食物营养 | 只读 | 走营养库/路 B，数字不让模型口算 |
| `log_meal` | 记一餐 | 写库 | 低风险可逆，可自主跑 |
| `get_today_summary` | 今日摄入聚合 | 只读 | 预计算，解痛点④ |
| `get_history` | 历史趋势 | 只读 | 聚合后再喂 |
| `retrieve_knowledge` | 权威知识检索 | 只读 | 路 B 的 agentic RAG 入口 |
| `set_goal` | 设/改目标 | 写库 | 改中期状态 |
| `normalize_food` | 食物实体规范化 | 只读 | 解痛点⑤，复用 entity matching |
| `(plan / answer)` | checklist 待办 + 交卷闸 | — | 支撑覆盖判停（§6） |

---

## 8. 可靠性与安全（Verifier）

- **覆盖判停**：见 §6。
- **约束校验闸（blocking）**：对模型产出的每条推荐做代码层约束校验（过敏/疾病），违规打回重生成。→ constraint-violation rate ~0。
- **数字核实**：任何卡路里/宏量必须来自 `get_food_nutrition`，不接受模型 freehand。
- **safety pass**：识别医疗类断言（"能治…""与某药相互作用"），转向"请咨询医生"，而非自信作答。
- **human-in-the-loop**：仅对**不可逆 + 动用现实资源**的动作（如"下单买菜/花钱"）挂一道确认闸。其余（记录、生成菜单、规划）低风险可逆，自主跑。

> 这套 Verifier 将来就是 RL reward 的来源：格式合法、工具有效、约束没违反、覆盖达标 —— **"harness 即 reward"**。

---

## 9. 评估体系（最高 ROI，也最多人偷懒）

**先把 eval 立起来，整个项目的说服力就不一样了。**

1. 建一个 N 条营养 query 的 **eval 集**，覆盖：简单查询、含约束（过敏/疾病）、趋势分析、医疗越界诱导、模糊食物实体。
2. 每个失败模式定义打分：卡路里误差%、constraint-violation rate、groundedness/引用覆盖、越界转向率、实体匹配准确率。
3. **先量 baseline**（基座模型 + 朴素做法的失败率），再用 harness 机制逐项压下来。
4. 全程 trace（⑦），从失败里挖问题、迭代 harness —— 这就是工业界"trace 驱动改进"。

> 产出叙事："我把 X 从 A% 降到 B%，把过敏违反率压到 ~0"。这串数字本身就是最大亮点。

---

## 10. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Next.js + Vercel，PWA | Web-first；API routes 即薄后端 |
| 数据/登录/存储 | Supabase（Postgres + Auth + Storage） | 多端同步天然解决；路 A 确定性查询在这 |
| Agent 运行 | Next.js API route / serverless | 持有 LLM key，跑 loop；注意超时 → streaming |
| 检索料 | BM25 + 向量库 + reranker | 只在 Retriever 内部 |
| 模型 | **v1: API**（DeepSeek/通义/Claude）→ **v2: 端侧 Qwen3-4B** | 换模型只换 ⑧ ModelAdapter |
| 可观测 | 自建 Tracer + trace 查看器 | 早做，debug 快十倍 |

> 移动端将来用 Expo（React Native）：复用 §4 的非 UI 代码 + 后端，只补 UI。别一开始上 native。

---

## 11. 里程碑 / 路线图

> 每一步都是可独立交付、可写进简历的成果。前 3 步在服务器上完成大部分价值，第 4 步是皇冠宝石但风险最高，放最后。

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **M1** [P0] | 服务器上：API 大模型当 teacher + harness 八块跑通 + **eval 集 & baseline** | 问题定义 + 度量 |
| **M2** [P0] | 小模型（未量化）在服务器上跑 harness，量出 vs 大模型的 gap | "这就是 RL 要填的差距" |
| **M3** [P1] | harness validation 接成 RL reward；SFT 冷启 + GRPO 适配 | "把小模型 agent 可靠性从 A 提到 B" |
| **M4** [P2] | 量化（int4/8）+ 端侧推理引擎部署，接受并量化能力损失 | "它真的在手机上跑起来了" |

**端侧三盆冷水（影响选型，越早知道越省命）：**
1. 最稀缺的不是算力，是 **context 长度 / KV cache 内存** → §5 的记忆精简是生死线。
2. 小模型 **tool-calling 可靠性**差 → RL 奖励奔"harness 可验证的信号"，而非模糊的"答得好"。
3. **端侧推理栈是硬骨头** → 先用"模拟端侧约束"（小模型+限上下文）在服务器跑通，最后才上真机。

---

## 12. 借鉴前沿 coding agent 的清单

| 直接搬（领域无关） | 改造再用 | 不要搬 |
|---|---|---|
| 极简 control loop | agentic search 的**原则**（按需精确取），但知识仍用 RAG | 重型 sandbox / git 快照 |
| ContextManager：token 预算 + compaction | 检索 subagent：上下文隔离（v1 纳入，唯一 subagent；必要时并行 fan-out） | 仓库/文件系统工具 |
| 结构化笔记 / 外部记忆 | "长任务保持环境干净"（你是短回合，基本用不上） | |
| verification 对照外部依据（非 self-review） | | |
| trace 驱动改进 | | |
| tool 设计纪律（schema / 返回即 prompt / 错误即消息） | | |
| programmatic tool calling（中间结果不进窗口，端侧省 token 大杀器，进阶） | | |

> **meta 规则**：harness 的机械尽管照前沿 coding agent 抄；但"数据怎么取"要按你自己的环境判断 —— 它们能丢向量 RAG 是因为仓库能 grep，你的知识是语义文档，RAG 仍然对。

---

## 13. 简历叙事

- 面向 **AI engineering 岗**（如阿里那类），对固收/rates quant **基本不加分**（那条线靠 Nelson-Siegel + PCA 项目），两条线分开经营。
- **三块合起来讲才是杀手锏，别拆开**：① eval/度量闭环 ② harness 工程深度 ③ 自训小模型 + RL。
- 一句话标题：**"用 agentic RAG + 个人化记忆 + 安全约束校验，做一个端侧小模型驱动的可靠营养顾问；用 RL 让小模型在 harness 里学会可靠的 agent 行为。"**

---

## 14. 明确边界（Out of Scope，至少 v1）

- 拍照识别 / 多模态录入（commodity，后置或不做）
- 多 agent 编排 / 按领域划分的专家 agent 团（按主题拆 = 反模式）。架构定为：**主 agent + 检索 subagent**；领域专长靠 skill / 领域 context 包，不靠加 agent。膳食规划留在主 agent。详见 `docs/adr/0001-main-agent-plus-retrieval-subagent.md`
- 重型权限/沙箱（只在"花钱"动作上挂一道闸）
- Native App（Web/PWA 先行）
- 社交/排行榜等产品功能（与 harness 学习目标无关）
