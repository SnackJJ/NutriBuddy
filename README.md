# NutriBuddy

一个**自建 agent harness** 驱动的个人营养助手：记下吃了什么，得到能核对出处的回答。
技术栈是 TypeScript + Next.js + Supabase；harness（循环 / 上下文 / 记忆 / 校验 / 轨迹）是自己写的 —— 库只填管道（模型调用、向量、rerank）。

## 三条不变量

这套 harness 的价值不在"能聊天"，而在于三条**由确定性代码守住**的性质：

1. **数字只能来自目录事实。** 营养值一律从本地 USDA 快照目录查（`numericProvenanceGate` 校验每个数字都能追到一次 observation），模型不做心算、也不能编。
2. **实体只能由 resolver 铸造。** 食物 id 由确定性解析器（exact → alias → fuzzy）产出，模型只能提出字符串；多候选、低置信、未知食物一律 typed miss 并要求澄清。
3. **写入只能来自用户确认过的提案。** `log_meal` 只产出 immutable proposal；用户确认后由下一次 turn 按 id 确定性 commit，服务端把"谁能写什么"钉在数据库层（RLS + 最小授权）。

在此之上：四道闸（input / tool / output / commit）每道都产出 typed verdict 事件；每个 turn 恰好一个终态事件并落库（审计、回放、归因、未来 RL 的资产）；过敏与用药是硬约束，命中就拒答而不是含糊带过。

架构主张与取舍见 `docs/ADD.md`（source of truth）、`docs/adr/*`（不可逆决定）、`docs/rfc/*`（分片设计）。

## 十分钟跑起来

```bash
npm install
cp .env.local.example .env.local     # 填 Supabase URL / anon key / service role key / 模型 key
npx supabase start                   # 本地栈（Docker），自动应用 supabase/migrations/*
npm run verify:migrations            # 空库重放 + schema 断言（授权 / 策略 / 索引前提）
npx tsx scripts/ingest-sources.mts   # 依据语料 → sources / source_sections（幂等）
npm run dev                          # http://localhost:3000
```

没有模型 key 也能跑：`npm test` 与 `npm run eval`（scripted 模式）零网络、零成本。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm test` | vitest 全量（零网络） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify:migrations` | 空库重放 `supabase/migrations/*` 并断言授权 / 策略 / 索引前提（需 Docker + psql） |
| `npm run eval` | 评测（默认 stub adapter，零成本；`--live` 用真实模型） |
| `npm run eval:report` | 产出 `reports/<id>/{report.md,summary.json,cases.json}` + 索引；`--compare` 标倒退、`--traces` 并入轨迹遥测 |
| `npm run smoke:confirm` / `npm run smoke:trace` | 真库 smoke：确认写入路径的授权面 / 轨迹写门与跨账号读取（需 `.env.local`） |
| `npm run export:traces` / `npm run prune:traces` | 轨迹导出（默认脱敏）/ 90 天滚动保留（默认 dry-run） |
| `npm run create:user` | 白名单方案 A：为指定邮箱建号（需 service role） |

## 数字从哪来

对外可引用的数字全部来自**可复现**的评测产物：

- 数据集：29 条手工 case，6 类（simple / constrained / numeric / cross_domain / edge_case / descriptive），按 case 自身声明的安全契约分成 **regression**（必须恒成立）与 **capability**（会演进）两组
- 两个手臂：`bare`（纯模型，无工具 / 闸 / 轨迹）与 `harness`（真实 `turn()` + 产品工具 + 四道闸 + 重生成）。**两臂拿到相同的用户档案**，差别只有机械 —— 否则测出来的是"谁拿到了信息"而不是"harness 有没有用"
- 口径进产物：每份 `summary.json` 自带指标定义、样本量与被拒原因；`datasetHash` 一变，`--compare` 判定**不可比**而不是照打 delta
- 已入库基线（`reports/`）：scripted（确定性、零成本）与 live（真模型）。最新 live：harness 72.4% vs bare 51.7%，regression 组 0/14 → 10/14

口径定义与为什么这么定义：`docs/rfc/0009`。

## 依据层

回答里"权威指南怎么说"这类断言带**可点开的引用**，且引用经过确定性校验：section 必须存在于 registry、文档状态为 active、版本一致、且**在本轮进过模型的证据集**里。校验不过的引用被剥离（不整体拒答）；只有"声称有出处却给不出引用"才走重生成 → 拒答。
语料只收美国联邦政府作品（17 U.S.C. §105，公有领域），逐源记录 license 与依据 URL；抓取与摄入见 `sources/README.md` 与 `scripts/{fetch,ingest}-sources.mts`。

## 边界

本项目提供营养信息与记录工具，**不构成医疗建议**，不能替代医生或注册营养师。有疾病、正在服药或怀孕时请先咨询专业人士。

隐私与数据处理（收集什么、**轨迹保留 90 天**、模型供应商一侧会发生什么、账号删除的级联范围）见 [`docs/privacy.md`](docs/privacy.md) 与站内 `/privacy` 页面；运维步骤见 [`docs/ops/v1.0-operations.md`](docs/ops/v1.0-operations.md)。
