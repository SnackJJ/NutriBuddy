# NutriBuddy 对外叙述包（简历 / 面试 / README）

> **用途**：把 NutriBuddy 讲成"一套方法论 + 一个成熟应用"，供简历、面试自述、开源 README 复用。
> **不是**架构文档、不是 agent 上下文。架构 source of truth 仍是 `docs/ADD.md`；本文若与 ADD 冲突，以 ADD 为准。
> **维护约定**：§5 的实测数字每轮迭代后更新；§6「真话对照表」里任何一行从"待补"变成"已支撑"之前，对应话术不要写进简历。

---

## 0. 定位（三句话，从头到尾只用这三句）

| 场景 | 话术 |
| --- | --- |
| 简历项目名 | **NutriBuddy｜可信营养顾问 Agent：自建 Agent Harness 的取数溯源、确定性安全闸与反馈自进化系统**（TypeScript / Next.js / Supabase，开源） |
| 20 秒口述 | "一个自己会用的营养助手：模型只负责选择和叙述，食物实体、营养数字、写入动作全部由确定性代码定义和校验；单轮 harness 有输入/工具/输出/提交四道纯函数闸门；失败可归因、可回放，用来自动迭代策略。" |
| 一句话卖点 | **事实不进模型，写入不靠模型，失败可归因。** |

三个"我亲手造的机械"，不要讲成"我用了什么库"：

1. **Turn Seam**（单缝）：所有行为收敛为一个函数边界，行为不是 typed event 就等于不存在。
2. **Deterministic Gates**（四道闸）：模型输出到数据库之间**不存在代码路径**。
3. **Trajectory 资产化**：每条决策都是 schema-versioned 事件，既是审计面、也是回放与自我迭代的燃料。

---

## 1. 写法公式（从参照简历里抽象出来的，放之四海）

> **【我命名的机械】+【一条能画出来的箭头链路】+【各环节职责枚举】+【因此防住的失败模式】**

反例（不要写）：堆栈名词、没有失败模式、成果只有一个总数没有归因。

成果段的公式：

> **规模（证明不是玩具）+ 消融归因（把总提升拆成来源）+ 延迟/成本（证明能上线）**

参照简历里最值钱的一句是消融那句："82.6% → 93.1%，其中混合检索与事实治理贡献 7.2pt、两轮 Skill 灰度贡献 3.3pt"。**NutriBuddy 的等价句必须自己做出来**（见 §5），它比任何单个通过率都可信。

---

## 2. 六条方法论主张（讲"方法论"，不讲"app"）

这六条是全篇的地基，面试时任何一条都能展开三分钟：

1. **数字不由模型产生** —— 派生量（份量缩放、周合计、环比）一律以 observation 列返回；输出闸做单位归一后的 provenance 比对。模型心算是幻觉的唯一入口。
2. **实体不可被铸造** —— 食品实体只能来自 resolver 级联（exact → alias → fuzzy）铸出的 catalog id；多候选/低置信必须返回 typed miss 并追问。
3. **写入不可由模型触发** —— `log_meal` 只产出 immutable proposal；确认是一次 turn 输入，走确定性短路按 proposal id 提交，引用的是 stored bytes。
4. **安全不依赖随机判官** —— 四道闸全是纯函数，输出 typed verdict；评测器直接读事件，不用 LLM 当裁判。
5. **行为不可观测即不存在** —— 单缝输出 typed event stream，并以 exactly one terminal event 收尾；scorer 只吃事件，不吃 prose。
6. **失败必须可归因、可回放** —— 确定性 + 注入端口让"把历史 case 重放一遍"成为可能，这是自进化的前提，不是副产品。

---

## 3. 完整版正文（9 条，可整段摘）

> 标记：✅ 已有实现　🟡 在实现/部分实现　⬜ 目标（写进简历前请对照 §6）
> 括号里的小字是给"落地"用的，不要写进简历。

### 3.1 ✅ Harness 编排治理：模型降级为端口，行为升格为事件

自建 Turn Seam，把每轮对话固定收敛为 `tagged input → input gate → context assembler → ReAct + typed query catalog → tool/output/commit gate → exactly one terminal event`；**任何行为必须先成为 typed event，否则在整个系统里不存在**——安全属性因此不依赖随机 LLM judge，评测器直接读事件流判分。模型被降级为 adapter 端口：scripted adapter 在 CI 里跑零网络零成本全确定性回放，live adapter 跑夜间真实模型合规性，两者共用同一 runner、同一 scorer、同一份 event schema。

（防住的失败模式：把"看起来对"当"测过了"；模型换了以后回归测试集体腐烂。）

### 3.2 ✅ 数字可溯的取数链路：模型不做心算，也不写 SQL

catalog snapshot 作为事实层，模型只能发出 template id + typed parameters；executor 校验 enum/日期范围、从会话绑定用户身份、渲染 reviewed SQL，返回 schema-declared observation。份量缩放、周合计、周环比等派生量全部以 observation 列返回；输出闸对文中每个带单位的数字做单位归一后的 provenance 比对，匹配不上就让模型带反馈重生成，两次仍不过就落到确定性拒答模板。

（防住的失败模式：数字幻觉；以及"看起来干净的 SQL 查询实际上算错"这类最隐蔽的错误。）

### 3.3 ✅ 实体解析与强制拒答：模型不能 mint food id

食品识别走确定性级联 `exact → alias → fuzzy(阈值)`；部分命中记录 match type 并要求答案点名实体，多候选/低置信/未知一律返回 typed miss 与候选列表，由模型追问用户。份量短语经 per-food portion-alias 表换算，模型不换算"一碗"。**catalog 是闸门，不是建议。**

（防住的失败模式：把"鸡胸肉"悄悄解析成"鸡腿"，然后整条营养结论连锁错下去。）

### 3.4 ✅ 四道确定性闸：从模型输出到数据库之间不存在代码路径

`input gate`（用户约束扫描 + directive 注入）→ `tool gate`（schema、catalog 成员、enum、角色）→ `output gate`（实体合规、数字来源、咨询结构、词面兜底四项检查）→ `commit gate`（结构性：提交只能发生在确认短路内，按 proposal id、经 least-privilege writer role 落库）。每个检查点都发 gate verdict 事件：check 名 + 证据 + 判决。

（防住的失败模式：过敏原/药物冲突建议；prose 里"顺便提一句"的未接地食物。）

### 3.5 ✅ 分层记忆与写入信任模型

四类存储按**写入信任等级与生命周期**分层，而非按内容分类：`profile constraints`（**没有 agent 写入路径**，只能走校验过的 profile API）/ `meal ledger`（append-only，只接受被确认的 proposal）/ `proposals`（不可变，`proposed → committed | voided | superseded | expired`，编辑产生 superseding proposal 而不是就地改）/ `reference data`（快照版本化、运行时只读）。context 组装分 pinned（system 契约 + 目录签名 + profile 快照 + 该用户适用的药物规则，字节稳定以命中前缀缓存）与 dynamic（会话、带上限的 observation、待确认 proposal 摘要）。

（防住的失败模式：模型把自己上一轮的推断当成"用户档案"引用回来。）

### 3.6 ⬜ 知识 RAG 与检索隔离：依据可核验，但数字仍来自事实层

> ⚠️ 这一条与 `docs/ADD.md` §Out of Scope 及 ADR 0001/0003 当前状态冲突（知识 RAG 原为 metric-gated 推迟项）。**落地前需要一份 ADR 更新 ADD 的 scope 判定。** 在 ADR 落地前，本条只能写成"规划中"。

接入 NIH ODS / USDA 膳食指南类权威语料，构建 `source registry`（文档版本、生效日期、archive 状态、章节定位）作为事实层，检索层做**混合检索**：BM25/全文检索负责条款号、剂量、数字等精确召回，向量检索负责语义召回，RRF 融合后 rerank；命中后**强制回源**到 registry 校验版本与生效状态，再进上下文。引用随答案一起返回，可被用户逐条点开核验。

关键设计边界（面试必答）：**RAG 只提供"依据与话术"，不提供数字与实体。** 营养数字仍来自 catalog observation，实体仍由 resolver 铸造 —— 所以引入 RAG 不动摇安全论证，只是把"为什么这么建议"从模型记忆换成可核验原文。多轮检索与覆盖判停产生大量中间垃圾，用 ADR 0001 允许的**唯一** subagent（检索 subagent）做 context 隔离，而不是新增领域 agent。

（防住的失败模式：模型凭记忆编造指南条款；检索到的旧版本文件覆盖现行规定。）

### 3.7 ⬜ 反馈自进化 Loop：采集 → 归因 → 变更 → 历史回放 → 版本记账

`Execute → Observe → Reflect → Adapt` 的在线闭环：采集**点击/纠错/追问/放弃/复制**与 gate verdict、terminal outcome、live 合规信号；把失败按类型归因到 `resolver_miss / no_template / retrieval_miss / intent_misroute / gate_block.{entity|numeric|advisory|lexical} / noncompliance / budget_exhausted / cost`；归因结果映射到**可版本化的策略变更**（prompt 版本、模板集新增、alias 补充、gate 阈值、检索权重、场景策略包）；变更先在历史 trace 上**回放重跑**，不倒退才准入，并自动把失败 case 沉淀成待复核的评测集草稿。

两条防自欺的护栏（这条最能加分）：**(a)** 在线反馈与 goldens 评测集物理分离，新 case 必须人工复核后才进 goldens；**(b)** 回放用 scripted adapter 保证确定性，否则"改好了"只是模型这次心情好。

（防住的失败模式：反馈只落进日志、不改变下一轮策略；以及模型学会讨好点赞而不是变准。）

### 3.8 ⬜ 场景化 Skill 编排：把"日常会用的营养场景"做成可版本化的策略包

把日常场景显式化：**记录饮食 / 营养查询 / 推荐 / 计划 / 复盘**。每个场景绑定一个策略包 —— 上下文组装策略、可用模板集、闸门强度、回答模板、检索范围；并记录每个版本的分组、触发次数、成功率与效果，用于验证"策略改动是否真的改变了下一轮在线表现"。

架构红线（ADR 0001 已明确授权这条路径）：场景**不新增 agent、不新增控制流**，只是给同一个主 agent 挂不同的 skill / 领域 context 包。场景编排退化成多 agent 就违反了单 agent 原则。

（防住的失败模式：所有场景共用一套 prompt，"记一笔"和"给我一周计划"互相污染。）

### 3.9 🟡 成熟交付形态：服务端 harness，移动优先的云托管 PWA

harness、四道闸、catalog 与模型调用全部留在服务端；客户端职责只有"发一句话 → 收事件流 → 渲染 → 确认时回传 proposal id"，不含任何逻辑，因此**一份 harness 服务 N 个 surface**。交付形态为云托管 PWA：核心场景是"吃完饭掏手机记一笔"，移动端是主场景而不是配角，同时省掉原生与包壳的成本；不需要原生护城河（HealthKit 类数据源不在范围内）。

工程面：per-turn 的 token / 延迟 / 成本 / 前缀缓存命中逐条记录，模型账号设消费上限，超时与错误恢复有确定的 UI 状态。

（防住的失败模式：为了做一个界面把安全逻辑复制到客户端。）

---

## 4. 一页简历精选版（只放 4 条）

> 一页简历不要超过 4 条；投不同岗位换不同 3+1 组合（见 §4.2）。

1. **单缝 Harness 编排治理** —— 自建 turn seam 把每轮固定为 `input gate → context assembler → ReAct + typed query catalog → tool/output/commit gate → exactly one terminal event`；模型降级为 adapter 端口，CI 用 scripted adapter 跑零网络零成本全确定性回放，夜间用 live adapter 跑真实模型合规性，共用同一 runner 与 scorer。**任何行为必须先成为 typed event**，安全属性因此不依赖随机 LLM judge。
2. **取数溯源与安全闸** —— 数字只能来自 reviewed SQL 模板返回的 observation 列，实体只能由 resolver 级联铸造，写入只能来自用户确认过的不可变 proposal；四道纯函数闸门产出 typed verdict，**代码层面不存在从模型输出到数据库写入的路径**。
3. **知识 RAG 与可核验引用**（⬜ 见 §6）—— 接入 NIH ODS / USDA 权威语料，构建带版本与生效状态的 source registry；混合检索（BM25 + 向量 + RRF + rerank）后**强制回源校验**再进上下文，答案引用可逐条点开核验；检索以独立 subagent 隔离中间噪声，不新增领域 agent。
4. **反馈自进化 Loop**（⬜ 见 §6）—— `Execute → Observe → Reflect → Adapt`：采集点赞/纠错/追问/放弃与 gate verdict，把失败归因到 `resolver_miss / no_template / retrieval_miss / gate_block.* / noncompliance`，映射为可版本化策略变更，**先在历史 trace 上回放重跑、不倒退才准入**，并把失败 case 沉淀为评测集草稿。

### 4.2 岗位侧重

| 投递方向 | 重哪几条 | 加什么数字 |
| --- | --- | --- |
| Agent / 应用 AI | 1、3、4 | 双跑消融 Δ、归因分桶分布 |
| 后端 / 工程 | 1、2、9 | P95 延迟、$/turn、并发压测 |
| 算法 / RAG | 3 + resolver 级联 | Recall@5、MRR、引用正确率 |
| 数据 / 平台 | 2、5、9 | 快照版本化、RLS、事件 schema 版本 |

---

## 5. 成果段：指标从哪里来

> 原则：**每个数字都要能一条命令复现。** 没跑出来的先留空，不要编。

| 话术 | 数据来源 | 怎么跑出来 |
| --- | --- | --- |
| "在 N 条覆盖 6 类失败模式（简单 / 约束 / 数字诱导 / 跨域药物 / 边界 / 描述）的评测集上完成 bare vs harness 双跑，通过率 __% → __%（Δ +__pt）" | `src/eval/metrics.ts` 已产出 `barePassRate / harnessPassRate / constraintViolationRate / toolCallRate / sourceComplianceRate / gateTurnRate` | `npm run eval -- --live`，再补一个把结果落盘的 `eval:report` |
| "约束违反率 __% → __%、工具调用率 __%、闸门拦截 __%" | 同上（`EvalSummary`） | 同上 |
| "should-be-blocked 用例 100% 出现 blocking verdict" | `checkShouldBeBlocked` + turn 事件流 | `npm run eval` |
| "检索：引用正确率 __%、Recall@5 __、MRR __"（RAG 落地后） | 需新增检索评测集 | 新脚本，格式对齐 `src/eval/` |
| "每轮 P95 __s、$__/turn、前缀缓存命中 __%" | `model_call_usage` 事件已带 `latencyMs / usage.cacheHitTokens / costUsd`（`src/harness/loop.ts`） | 聚合脚本读事件流（**只差聚合，不差埋点**） |
| "工程规模：__ 个测试文件 / __ 条断言 / CI 零网络零 LLM 成本" | 实测 **51 个测试文件、973 条断言** | `npm test` |
| "架构规模：4 道闸 × 全部产出 typed verdict、8 步预算、__ 张查询模板" | `docs/ADD.md` | — |
| "并发 __ 下 P95 __ms"（压测） | 真跑才有 | k6 / autocannon 打 `/api/chat`，1 → N 并发 |
| "策略迭代消融：某轮检索改造贡献 +__pt、某轮场景策略贡献 +__pt" | 需要 §3.7 的版本记账 | 有了版本记账与报告历史后自然得出 |

**最有性价比的一项**：`npm run eval:report` —— 把已有逐 case 对比 + 6 项汇总指标写成 markdown/JSON 归档，顺带聚合 `model_call_usage` 的 P50/P95 延迟、$/turn、缓存命中率。这一步做完，上表前 5 行全部有数。

---

## 6. 真话对照表（写进简历前逐行核对）

| 话术 | 现在能证明它的东西 | 还缺什么才能放心写 |
| --- | --- | --- |
| §3.1 单缝 harness / 双 adapter | `src/harness/turn.ts`、`tests/turn.test.ts`、RFC 0003 T3/T4 | —（可写） |
| §3.2 取数溯源 | `src/harness/numericProvenanceGate.ts`、`src/catalog/queryCatalog.ts` | —（可写） |
| §3.3 resolver 级联 | `src/catalog/resolver.ts`、`src/lib/resolverMiss.ts` | —（可写） |
| §3.4 四道闸 | `src/harness/gate.ts`、`advisoryGate.ts`、`src/harness/proposalConfirm.ts`、`supabase/migrations/0005_rls_policies.sql` | —（可写） |
| §3.5 分层记忆 | `docs/ADD.md` §Memory、`supabase/migrations/0003/0004/0006` | —（可写） |
| §3.6 知识 RAG | 无（ADD 原把知识 RAG 列为推迟项） | **`docs/adr/0004` 已起草（Proposed）**；接受后落地 source registry + 混合检索 + 引用回源 + 检索评测集 |
| §3.7 反馈自进化 | 只有 trace / event log 与三个 standing 指标；`feedback` 字段目前只用于 proposal 确认附言 | typed 失败归因枚举 + 归因分桶报告 + 历史 trace 回放 + 策略版本记账 |
| §3.8 场景 Skill 编排 | ADR 0001 已授权"单一主 agent + skill/领域 context 包"这条路径 | 场景分类 + 策略包结构 + 每版本效果记账 |
| §3.9 成熟 PWA | ADR 0002 已 Accepted（云端 PWA、移动端为主场景）；`app/chat` 已有 confirm/edit UI | 上线门槛 #82（关闭匿名通道）、#83（PWA shell + 移动端 UX）+ 部署 |
| "开源项目" | `git@github.com:SnackJJ/NutriBuddy.git` | 确认仓库公开 + README 可跑（当前 `README.md` 只有标题，**这是最便宜的一次加分项**） |

---

## 7. 面试必被问的 10 问（附答法要点）

1. **为什么不用 LangGraph / CrewAI？** —— 框架会拿走控制流，而安全论证要求闸门是纯函数、verdict 是 typed event；库里填的是管道（模型调用、向量、rerank），不放控制流。
2. **为什么单 agent，不做专家团？** —— 每多一个 agent 就多一处会违反约束/幻觉数字的地方；真实营养问题大量跨域（"肌酸 + 高血压"），专家团需要路由与冲突裁决，正是无理由去建的机械。领域专长用 skill/context 包挂同一个 agent。
3. **RAG 在你的安全论证里处于哪一层？** —— 最外层"依据与话术"；数字仍只来自 observation，实体仍由 resolver 铸造，所以引入 RAG 不动摇 C1/C2/C3。
4. **混合检索为什么需要 RRF + rerank？** —— BM25 命中条款号/剂量这类精确串，向量召回同义表述；两者打分不可比，用 RRF 融合名次而非分数；rerank 处理 top-k 里的语义精排，最后强制回源校验版本。
5. **反馈闭环怎么防止自我强化错误？** —— 在线反馈与 goldens 分离、新 case 人工复核、回放用 scripted adapter 保证确定性、只有指标不倒退才准入。
6. **单缝的代价是什么？** —— 多轮协议要拆成多轮单缝调用（clarification / proposal 都是 terminal event）；换来的是"一个函数边界就能测全部行为"。
7. **proposal 为什么不直接写库？** —— 用户确认的是 stored bytes，不是一次重新生成的结果；确定性短路让唯一被用户明确批准的动作不再随机。
8. **模型换了怎么办？** —— 模型是端口：scripted adapter 测 harness，live adapter 测合规；换模型不改闸门、不改评测器。
9. **成本与延迟怎么控？** —— pinned region 字节稳定以命中前缀缓存、observation 上限、8 步预算、逐轮记 token/延迟/成本并有账号消费上限；缓冲式发布换取"违规不可撤回"。
10. **为什么是 PWA 而不是小程序 / 原生？** —— 核心场景是"吃完饭掏手机记一笔"，移动端是全部交互而非配角；PWA 覆盖它且省掉原生与包壳成本；小程序受平台审核与账号实体约束，且与英文/西式饮食的定位不符（若要服务微信生态，可作为后续独立 surface）。

---

## 8. 路线图：让 §3.6–3.9 从话术变成事实

> 顺序按依赖排，不按性价比排。R5 是"成熟应用"的达成条件。

| 阶段 | 内容 | 产出的简历素材 | 依赖 |
| --- | --- | --- | --- |
| **R1 数字采集** | `eval:report`（逐 case + 汇总 + P50/P95 延迟 / $/turn / 缓存命中落盘归档）；README 补可跑说明 | §5 前 5 行全部有数；"开源可跑" | 无 |
| **R2 归因闭环** | terminal event 加失败归因枚举 + 报告按归因分桶 + 失败 case 自动生成评测集草稿 | §3.7 前半条 | R1 |
| **R3 知识 RAG 纳入** | ADR 0004 更新 ADD scope → source registry（版本/生效日期/章节）→ 混合检索（BM25 + pgvector + RRF + rerank）→ 命中回源校验 → 检索 subagent 隔离 → 引用随答返回 + 检索评测集 | §3.6 全部；算法岗主素材 | 无（可并行 R1/R2） |
| **R4 回放与策略版本记账** | 策略版本（prompt / 模板集 / 闸阈值 / 检索权重）+ 历史 trace 回放 + 版本效果 delta | §3.7 后半条；消融句（+__pt） | R2 |
| **R5 场景 Skill 编排** | 5 个日常场景（记录 / 查询 / 推荐 / 计划 / 复盘）× 策略包 + 每版本效果记账 | §3.8 全部 | R4 |
| **R6 成熟交付** | #82 关闭匿名通道、#83 PWA shell + 移动端 confirm/edit UX、部署 Vercel、消费上限、错误恢复与空态、可观测看板 | §3.9 全部；"已上线可用" | R1 |
| **R7 压测与延迟工程** | k6 打 `/api/chat`（1 → N 并发）、冷启动与 catalog 加载优化、必要时迁长驻容器 | 压测与延迟数字 | R6 |

**需要先做的两件"文档类"前置**（否则 ADD 权威性会被自己绕过）：

- `docs/adr/0004-knowledge-rag-in-scope.md` —— 把知识 RAG 从 metric-gated 推迟项变为在范围内，说明它提供什么、不提供什么（数字/实体仍归确定性代码），以及触发条件与失败模式。
- `docs/rfc/0006-self-evolution-loop.md` —— 归因枚举、事件 schema 扩展、回放机制、评测集准入护栏、策略版本记账格式。

---

## 9. 三档说法（润色的边界）

| 档位 | 做法 | 建议 |
| --- | --- | --- |
| 保守 | 只写 §6 标"可写"的条目 + 实测数字 | 面试零风险，但项目显得小 |
| **常规（推荐）** | 上表可写项全写；§3.6–3.9 以"设计并推进中"或"已落地机制部分"表述；规模与影响适度上探（"面向个人日常饮食决策的完整闭环"） | 允许夸大**影响与规模**，不允许夸大**技术栈与上线状态** |
| 激进 | 把未做的 RAG/自进化写成已完成、把别人的压测数字搬过来 | ❌ 一被追问细节就穿；且 §7 的 10 个问题你答不上第 3、4、5 问 |

**判断标准一句话**：能画出链路图、能说出防住哪个失败模式、能一条命令复现数字 —— 满足这三条就可以写成"已完成"。

简历上适度保留"企业味"的工程数字是行业惯例，但**转化方式要对**：

- 灰度发布 → 写"评测门禁 + 策略版本回滚"（你真能有：版本记账 + 报告历史）
- 压测吞吐 → 自己去打 `/api/chat`，写"N 并发下 P95 __ms"（真跑就有）
- 分布式 → 不写。你的可信度来源恰好是"少而确定性"，写成集群反而稀释主张

---

## 10. 后续维护

1. §5 每轮迭代更新实测值，历史值保留在 `docs/resume/eval-history.md`（尚未创建）。
2. §3 的标记随实现推进上调（⬜ → 🟡 → ✅），**标记与 §6 必须同时改**，否则这份文档会变成自我欺骗。
3. 本文件不进入 `AGENTS.md` 的 agent 上下文；它是对外叙述，不是架构约束。
