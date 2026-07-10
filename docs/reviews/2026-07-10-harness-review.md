# Codebase Review — ADD 对照 + Harness 架构评估

> 日期：2026-07-10。方法：通读 `src/harness` / `src/catalog` / `src/lib` / `src/eval` / `app` 全部源码与测试，逐条对照 `docs/ADD.md`（2026-07-05 版）。
> 结论已与作者对齐（见 §四），行动项拆分为 GitHub issues。

## 结论摘要

ADD 本身质量高、逻辑自洽，维持为 source of truth。但 codebase 与 ADD 之间存在一个**结构性断裂**：核心安全机器（resolver、query catalog、TypedOutput、numeric/advisory gate）全部已实现且有测试，却**没有一条接进真实运行路径**。根因是 `src/harness/modelAdapter.ts` 不支持 function calling——真实模型在生产中调不了任何工具、产不出 TypedOutput，这些 gate 在生产中要么不运行、要么恒 pass。

目前生产路径上真正生效的安全机制只有三个：

1. Pre-gate pinned 注入（过敏/用药约束进 system prompt）
2. Post-gate 词法扫描（过敏原同义词 + 词边界匹配）
3. Proposal 确认短路提交（commit gate，结构性成立）

**scripted 测试在演练一台生产中不存在的机器。** CI 全绿证明 harness 机械正确，但 ADD 的安全论点（"every safety-relevant fact traces to deterministic machinery"）目前对真实用户不成立。这不是某个模块写错，而是「切片式推进」到了必须接线的临界点。

## 一、ADD 评估与实现差距

### ADD 本身的评价

三条可挑的点（不动摇整体）：

1. **TypedOutput 的传输机制未定**。ADD §Loop 要求结构化终稿（prose + FoodRefs + RuleRefs），numeric/advisory gate 都依赖它，但没说这个结构怎么从一次 chat completion 里可靠拿到。这是 spec 到实现之间最大的空洞，实现恰好卡死在这里。→ 决策：走 **final-answer 工具**模式（见 §四）。
2. **事件词表未标注最小集**。ADD §Observability 要求 turn_start 带 profile version / catalog snapshot version / context digest，model call 带 tokens/latency/cost；实现里 `TurnStartEvent` 只有 input。作为 M1 简化合理，但应标注哪些字段 Phase 0 必须、哪些可延后。
3. **描述性 vs 处方性只写在 input gate**，输出侧词法 backstop 未继承该区分，导致实现里的行为 bug（见下）。

### 逐 Phase 对照

| Phase | ADD 要求 | 实现状态 |
|---|---|---|
| 0 seam 与词表 | 单 turn 函数、tagged input、schema 版本化事件流、scripted CI | ✅ 基本完成（`turn.ts` 单入口 + `SCHEMA_VERSION` + ports 注入） |
| 1 grounding 底座 | catalog/resolver/别名/份量表、7 个查询模板、SQL executor + 最小权限角色 | ⚠️ resolver 级联与 catalog 种子有 golden tests，但**运行路径零引用**；模板仅 `food_lookup` 1/7；`QueryRunner` 无生产实现 |
| 2 gated 读路径 | input gate 冲突扫描 + directive、tool gate 校验、四项 output check、observation caps | ⚠️ 形似神不似：input gate 硬编码 pass；tool gate 无条件 pass（error JSON 也 pass）；numeric/advisory 仅在 `result.output` 存在时运行（生产中永不存在）；`conflicts` 端口从未填充；observation caps 未做 |
| 3 写路径 | proposal 状态机、确认短路、ledger lineage、supersede-on-edit、edit-rate 指标 | ✅ 大部分：所有权/状态校验、按 id 提交、proposalId lineage 都对；缺 supersede/expire、edit-rate 指标；route 用内存 store |
| 4 表面与租户 | web chat 走 seam、auth、RLS、nightly live eval | ⚠️ web chat 驱动 seam + NDJSON 流 ✅；但「auth」是客户端自报 `X-User-Id` header；migrations 无 RLS policy；history 由客户端 body 提供（可注入伪造 `[tool_result]`）；live eval 是手动 runner |

### 核心断裂：安全机器在真实模型面前空转

`modelAdapter.ts` 的 `generate()` 只发 messages、只读 content，永远返回 `{content, stop: true}`——不传 tools schema、不解析 tool_calls、不产 output。连锁后果：

- 生产中模型**调不了任何工具**（`log_meal` 接了线但模型够不着；`query_catalog` 连 handler 都没有）；
- TypedOutput 从不存在 → numeric provenance / advisory gate 在生产中**从不执行**；
- observations 恒空 → C2「数字必须来自 observation」无任何 enforcement；
- `loop.ts` 给模型的工具说明只有一行 `"Callable tool: log_meal"`（无参数 schema）；`LOG_MEAL_SCHEMA` / `GET_FOOD_NUTRITION_SCHEMA` 导出后无人消费。

**与 ADD 直接冲突的行为 bug**：ADD §Memory 说 ledger 是描述性的、"log the shrimp I ate" 应 advise 而非 block；但 `gate.ts` post-gate 会把任何提到 shrimp 的回复硬拦——包括 write proposal 确认文案。贝壳类过敏用户在当前实现下**无法记录自己吃过虾**，正是 ADD 预言的 "a tracker that refuses to track"。

## 二、架构冗余与组合问题

单模块看都克制、可测、符合 simplicity 原则；问题是「建好的部件不装车」+ 组合层设计欠佳。

1. **三套食物营养数据源并存**：
   - `src/harness/foodNutrition.ts` STUB_DB（~45 种，`log_meal` 实际在用，自由字符串查表，绕开 resolver）
   - `src/catalog/catalog.ts` SEED_FOODS（~40 种，带 allergen tags/aliases/portion aliases，无人使用）
   - `src/lib/usda.ts` 实时 API client（无人使用，且违反 ADD「USDA 离开热路径」决策）

   `log_meal` 绕开 resolver 意味着写路径完全绕开「catalog 是唯一 id 铸造者」的核心不变量。

2. **两层输出 gate 重试嵌套**：`loop.run()` 内层词法 post-gate + 2 次重试；`turn.runUtteranceTurn()` 外层 numeric+advisory + 2 次重试（每次重跑整个 run()）。最坏情况两层相乘；重试反馈模板、refusal 文案几乎逐句重复。ADD 说的是**一个** output gate、四个 check、统一 regenerate max 2。

3. **三套事件词表**：Tracer（step/payload）、EventLog（OpenHands 词表）、turn AnyTurnEvent（schema versioned）。ADD 只承诺两层。症状：`harness-runner.ts` 里同一 gate block 事实两处记录，只好 `Math.max` 取大。

4. **装饰性 gate 事件是负资产**：恒 pass 的 input/tool gate verdict 对 scorer 是噪音甚至假信号。事件流可信度是项目立身之本——没实现的 check 宁可不发事件，不发假 pass。

5. **工具结果回灌用假文本消息**（`[tool_call]`/`[tool_result]` 塞进 user role），而非 provider 原生 tool role——与 function calling 缺失是同一问题两面，且破坏 prompt cache 前缀稳定性。

## 三、业界对照与吸收方向

不学的（ADD 已正确排除）：multi-agent 拓扑、planner/executor 分层、知识 RAG。

吸收的：

1. **工具调用走 provider 原生协议**（业界无一例外）：tools JSON schema 发给 API、解析结构化 tool_calls、tool role 回灌。TypedOutput 采用「final-answer 工具」模式（模型必须调 `submit_answer(prose, foodRefs, ruleRefs)` 交卷）——比 JSON mode 可靠，天然融入 tools Map，同时补上 ADD 的 spec 空洞。
2. **确定性护栏分层**：方向不变（本项目比业界更深），缺的只是把 gate 从装饰事件变成真检查。
3. **Context 管理**：pinned region 字节稳定已对齐 prompt caching 最佳实践；observation caps（top-k rows + byte ceiling）在接上 query_catalog 后立刻需要。「答案要摘要、trace 要全量」的双目的地设计与 Anthropic context editing 思路同构，照 ADD 实现即可，不引库。**长期/短期记忆分层、单轮 context query 的设计需要单独推敲**（见 §六）。
4. **事件流即产品**：已对齐；差 ADD 已承诺的 token/latency/cost 字段与 snapshot 版本戳——三个 standing metrics（edit rate / no-template rate / backstop hits）一个都还没有。
5. **租户底线**：`X-User-Id` header 必须换成 Supabase Auth session + RLS（C1 把 isolation 定义为安全属性，当前实现是全项目最不达标处）。

## 四、已确认决策（2026-07-10 与作者对齐）

1. **优先级**：先跑通 P0——让真实运行路径接通（function calling adapter + catalog 接线），其余随后。
2. **营养数据统一形态**：数据源可以多个（USDA snapshot、手工种子、未来其他源），但 agent 内维护形态**唯一**——统一为 `CatalogFood` 一种数据类型（类比 RAG：异构源 → 统一存储形态）。ingestion adapter 负责「源格式 → CatalogFood」的转换；`usda.ts` 改造为 ingestion adapter，STUB_DB 删除，`log_meal` 改走 resolver。
3. **Gate 重组**：确认问题严重——单模块可测但组合欠佳。合并两层输出 gate 为 turn 层单点、tool gate 做真校验、input gate 实现 utterance 冲突扫描 + refuse/advise directive（顺带修「无法记录过敏原」bug）、填充 conflicts 端口激活 advisory gate。护栏分层的大方向不变。
4. **Context/记忆设计**：暂不动手，先做设计推敲（§六）。
5. 本 review 固化到 docs/，行动项拆 GitHub issues。

## 五、行动清单

> 已按 tracer-bullet 垂直切片拆为 GitHub issues #41–#52（2026-07-10，标签 `ready-for-agent`）。

### P0 — 接通真实运行路径

- **P0-1（#41）** ModelAdapter 支持原生 function calling：发送 tools schema、解析 `tool_calls[]`（按数组迭代）、`role:"tool"` + `tool_call_id` 回灌（替换 `[tool_call]` 假文本消息）；同时修正 thinking 参数格式为 `{"type":"enabled"|"disabled"}`（现为布尔值，不符合官方 schema）。DeepSeek 官方已完整支持 OpenAI 兼容协议且思考模式兼容 tool calls（见附录）。
- **P0-2（#43，blocked by #41）** TypedOutput 走 final-answer 工具交卷：`submit_answer(prose, foodRefs, ruleRefs)`，loop 收到该调用即终止并携带 TypedOutput。
- **P0-3（#44 写路径 + #46 读路径）** catalog/resolver 接进运行路径：`log_meal` 改走 resolver + catalog、删除 STUB_DB（#44）；注册 `query_catalog` tool handler，先内存 QueryRunner，observations 喂 numeric gate（#46）。
- **P0-4（#42，可并行）** `usda.ts` 改造为 snapshot ingestion adapter（USDA → CatalogFood 统一形态），移出运行时路径。

### P1 — Gate 重组

- **P1-1（#47，blocked by #43）** 合并两层输出 gate 重试为 turn 层单点（全部 check、统一 regenerate max 2、统一 refusal 模板）。
- **P1-2（#45，blocked by #41）** tool gate 真校验：schema 校验在 dispatch 处执行，error 结果发 error verdict，不再无条件 pass。
- **P1-3 + P1-4（#49，blocked by #44/#47，合并为一片）** input gate utterance 实体冲突扫描 + refuse/advise directive；填充 `conflicts` 端口激活 advisory gate；词法 backstop 继承描述性/处方性区分，修复「过敏用户无法记录餐食」。

### P2 — 收敛与加固

- **P2-1（#50，blocked by #47）** 事件词表收敛：Tracer 降级为 turn 事件流的 sink；scorer 只消费 per-turn stream。
- **P2-2（#48，blocked by #44）** Supabase 版 proposal/meal store 替换内存实现；Supabase Auth 替换 `X-User-Id`；user-scoped 表加 RLS。
- **P2-3（#51，blocked by #46）** observation caps（canonical rendering、top-k rows、byte ceiling）；turn_start 补 catalog snapshot version / profile version；model_call 补 tokens/cache hit-miss/latency/cost。
- **P2-4（#52，blocked by #46/#48）** 补齐查询模板 2–7（meal summary / daily totals / weekly totals / daily average / range comparison / top-k by nutrient）+ SQL executor（SELECT-only role、statement timeout、row cap）。

## 六、待设计议题（不建 issue，先推敲）

- **记忆与 context 分层设计**：什么算长期记忆（profile constraints / ledger 已是结构化长期态），什么算短期记忆（对话滑窗、pending proposal digest），单轮内 context 怎么查询与裁剪；history 目前由客户端 body 传入——多轮状态应服务端持有还是继续客户端回传。ADD 的立场是「durable 状态全在 Postgres，chat history 只滑窗」，但落地细节未定。建议单独开一次 grilling/design 会话。

## 附录：DeepSeek function calling 调研（2026-07-10，官方文档实测读取）

结论：**原生 function calling 是 P0-1 的实现路径，无需 prompt-based 文本协议兜底。**

1. **完整 OpenAI 兼容的 tool calls**：请求 `tools` 数组（`{"type":"function","function":{name, description, parameters: JSON Schema}}`）+ `tool_choice`（`none`/`auto`/`required`/指定函数）；响应 `choices[0].message.tool_calls[]`（含 `id` / `function.name` / `function.arguments` JSON 字符串），`finish_reason: "tool_calls"`；回灌 `{"role":"tool","tool_call_id":…,"content":…}`。与 OpenAI 逐字段一致。
2. **模型 ID**：`deepseek-v4-flash`（2500 并发）与 `deepseek-v4-pro`，均 1M 上下文、支持 tool calls + JSON output + 思考双模式。codebase 现有 `TIER_TO_MODEL_ID` 映射正确。旧 `deepseek-chat`/`deepseek-reasoner` 于 2026-07-24 下线（codebase 未使用，无影响）。
3. **思考模式与 tool calls 已兼容**（V3.2 起），thinking 是请求参数：`"thinking": {"type": "enabled"|"disabled"}`，默认 enabled。⚠️ 现有 adapter 发的是布尔值 `thinking: true`——**格式不对，P0-1 需一并修**。思考模式下 `temperature`/`top_p` 等被忽略；回灌工具结果时不带 `reasoning_content`。
4. **JSON mode 只有 `json_object`，没有 OpenAI 式 `json_schema` response_format** → 印证 TypedOutput 走 final-answer 工具（P0-2）而非 JSON mode 的决策。tool 定义可用 `strict: true` 但属 Beta（需 `/beta` base_url）——生产上以 harness 侧 tool gate 校验 arguments 作为兜底（正好是 P1-2）。
5. **Parallel tool calls 官方未明确**，但 `tool_calls` 是数组——harness 按数组迭代处理，不依赖模型主动并行。
6. **Prompt caching 默认自动开启**（前缀完全匹配，best-effort），usage 返回 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` → 可直接喂 P2-3 的 model_call 成本字段。pinned region 字节稳定设计正好吃到缓存。
7. 上限：单请求最多 128 个 function（无影响）。旧版「function calling 不稳定/循环」警告在当前文档已移除。

来源：[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) / [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) / [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) / [JSON Mode](https://api-docs.deepseek.com/guides/json_mode) / [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) / [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) / [V4 Release](https://api-docs.deepseek.com/news/news260424/)
