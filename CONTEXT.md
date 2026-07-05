# NutriBuddy — 领域术语表

> 本文只定义领域概念，不含实现细节。架构 source of truth 是 `docs/ADD.md`；术语解释若与 ADD 冲突，以 ADD 为准。术语按首字母排序。

## Catalog（食品目录）

运行时本地食品与营养事实目录。数据来自 USDA FoodData Central snapshot ingestion，但运行时不调用 USDA API。Catalog 提供 food id、per-100g 营养值、allergen tags、aliases、portion aliases 和 snapshot version。

## Gates（闸）

确定性检查点，包括 input gate、tool gate、output gate、commit gate。每个 gate 都必须产出 typed verdict event；安全属性不能依赖随机 LLM judge。

## NutriBuddy

一个自建 agent harness 驱动的个人营养顾问应用。目标是在自建的 control loop / context / memory / verification / trace 机械之上，实现可信的营养建议。**不含端侧推理、小模型 RL 适配——这些归 NutriMind（另一个项目）。**

## NutriMind

独立项目，承接端侧小模型 + RL 适配的远期目标。NutriBuddy 的工程产出（harness 设计模式）可以迁移到 NutriMind，但 NutriBuddy 的架构选择不受端侧约束。

## Proposal（写入提案）

agent 可创建但不可直接提交的 immutable 写入提案。`log_meal` 只能产出 proposal terminal event；用户确认后，下一次 turn 以 proposal confirmation 作为 structured input，经确定性 short-circuit 按 proposal id commit。

## Resolver（食品解析器）

Catalog 下的确定性解析器。解析顺序为 exact match → alias table → fuzzy threshold。模型可以提出字符串，但不能 mint food id；多候选、低置信或未知食物必须返回 typed miss 并要求 clarification。

## Trajectory（轨迹）

NutriBuddy 的 typed event stream / session log 记录的 agent 每一步决策数据（turn start → model call → tool call/result → gate verdict → terminal event）。**格式设计上需考虑后续可被 NutriMind 的 RL 训练消费**——这是两个项目之间的数据飞轮。Trajectory 不是 debug log，是训练数据资产。

## Turn Seam（单轮测试缝）

NutriBuddy 的最高测试缝。一个 turn function 接收 tagged input（free-text utterance 或 proposal confirmation）和 injected ports（model adapter、stores、catalog/resolver、clock），输出 schema-versioned typed event stream，并以 exactly one terminal event 结束。

## Typed Query Catalog（类型化查询目录）

读取路径的 reviewed SQL 模板目录。模型只能选择 template id 和 typed parameters；executor 校验参数、绑定 authenticated user id、渲染 reviewed SQL，并返回 schema-declared observation。模型不从零写 SQL，不做营养数字心算。

## 技术选型

- **语言**：TypeScript（全栈，Next.js API route 内跑 harness）。参考 Claude Code、Codex 等前沿 Agent 应用的 TS 实践。
- **前端/后端**：Next.js + Supabase
- **模型**：API 模型（DeepSeek / 通义千问 / Claude），不接端侧推理
