# NutriBuddy — 项目行动记录

> 架构原则以 `docs/ADD.md` 为准。`docs/PRD-v2.md` 保留产品语境；冲突按 ADD。  
> 与 `AGENTS.md` 保持同步；本文件给 Claude Code / 本地 agent 用。

## 已确定

- **原则**：自建 harness 机械（loop/context/memory/verification/trace），库只填管线
- **不做**：LangGraph/CrewAI、拍照录入、native App（初期）、端侧推理/RL（NutriMind）
- **语言 / 栈**：TypeScript；Next.js + Supabase + 自建 harness
- **拓扑**：单 agent；模型只选择和叙述，事实/数字/实体/写入由确定性代码定义和校验
- **测试缝**：单 turn boundary；ports 注入 → schema-versioned event stream → exactly one terminal
- **数据**：USDA snapshot ingestion；runtime 读 local catalog。知识 RAG 推迟

## 当前状态（2026-07-20）

- **RFC 0001 已合入 main（PR #72）** — confirm 路径安全：原子 RPC、ConfirmPorts fail-closed、K/F 回归网、`proposalConfirm` 抽取
- Live smoke 通过：`npm run smoke:confirm`（migration 0009 已在目标项目）
- **RFC 0002 ToolOutcome 已实现** — `toolOutcome.ts`、gate `reasonCode`、SCHEMA 1.7.0、handlers 结构化 outcome
- **下一步**：结构 Phase 3 events/tracer demotion（RFC 0001 Appendix B；勿与 ADD 产品 Phase 0–4 编号混淆）

## 命令

```bash
npm test                 # vitest，排除 .sandcastle
npm run typecheck
npm run smoke:confirm    # live Supabase confirm/void（需 .env.local）
npm run eval
```

## 文档入口

- `docs/ADD.md` — 架构 SoT
- `docs/rfc/0001-phase1-confirm-safety.md` — confirm 安全（已实现）
- `docs/rfc/0002-tool-outcome.md` — 下一步结构收敛
- `docs/PRD-v2.md` — 产品语境
