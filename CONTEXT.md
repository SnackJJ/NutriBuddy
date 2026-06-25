# NutriBuddy — 领域术语表

> 本文只定义领域概念，不含实现细节。术语按首字母排序。

## NutriBuddy

一个自建 agent harness 驱动的个人营养顾问应用。目标是在自建的 control loop / context / memory / verification / trace 机械之上，实现可信的营养建议。**不含端侧推理、小模型 RL 适配——这些归 NutriMind（另一个项目）。**

## NutriMind

独立项目，承接端侧小模型 + RL 适配的远期目标。NutriBuddy 的工程产出（harness 设计模式）可以迁移到 NutriMind，但 NutriBuddy 的架构选择不受端侧约束。

## Trajectory（轨迹）

NutriBuddy 的 Tracer 模块记录的 agent 每一步决策数据（模型看到什么 → 决定调用什么工具 → 工具返回什么 → 最终产出什么）。**格式设计上需考虑后续可被 NutriMind 的 RL 训练消费**——这是两个项目之间的数据飞轮。Trajectory 不是 debug log，是训练数据资产。

## 技术选型

- **语言**：TypeScript（全栈，Next.js API route 内跑 harness）。参考 Claude Code、Codex 等前沿 Agent 应用的 TS 实践。
- **前端/后端**：Next.js + Supabase
- **模型**：API 模型（DeepSeek / 通义千问 / Claude），不接端侧推理
