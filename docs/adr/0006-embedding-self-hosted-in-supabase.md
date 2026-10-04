# embedding 自托管在 Supabase，用 gte-small 384 维

> 状态：**Accepted**（2026-09-16）。

## 背景

V1.1 的检索是混合形态（`docs/rfc/0013` §4），向量侧需要一个 embedding 出口。现状里没有：

- `src/harness/modelAdapter.ts` 的三个 provider 档（`deepseek` / `commandcode` / `custom`）全是 chat completions，没有 embedding 能力；DeepSeek 官方 API 也不提供 embedding 端点。
- 因此无论选哪家商用 embedding，都是**一条新的"用户问题离开本项目"的流向**。而 `docs/privacy.md` §4 末行对新增流向的规矩是硬性的：运维者必须在切换前把该供应商的条款与保留策略记录进本文，**未记录即视为未核对**——而那笔账现在还压着 commandcode 网关（默认 provider 已是它，§4 正文记录的却只有 DeepSeek）。

成本不是这里的约束：排除书目后是 703 个 chunk、约 525k 字符，一次性 embedding 是分币级，每轮查询的 embedding 也可忽略。约束是**供应商边界与合规账**。

## 决定

**embedding 用 Supabase Edge Functions 内置的 `gte-small`（384 维），语料侧与查询侧同模型、同配置。**

- 迁移里 `create extension if not exists vector with schema extensions;`，向量列 `extensions.vector(384)`，HNSW 索引。
- 查询侧：Edge Function 内原生推理（Edge Runtime v1.36.0 起内置，不经外部 API）。
- 语料侧：摄入脚本内联生成（同一个 gte-small ONNX，同 `mean_pool: true` + `normalize: true`），摄入仍是一条本地命令、不需要已部署的函数。

## 为什么

- **零新增信任边界。** Supabase 本来就托管全部数据（轨迹、档案、餐食），查询文本进 Edge Function 不构成新的流向，`privacy.md` §4 不需要为它再查一次条款。选商用 embedding 则要在 §4 里先补一段条款记录——而 §4 已有的那笔（网关）还没还。
- **hybrid 让弱模型够用。** 向量侧只需补"换了个说法"的召回；剂量、上限、条款号这类精确串交给词法侧。语料是英文联邦政府 fact sheet，问题也是英文，384 维的领域词汇重合度足够。
- **索引规模小。** 703 个 chunk 的 HNSW 构建与存储都微不足道，没有理由为它引入独立向量库（ADR 0004 已排除）。

## 后果

- **新增一个部署物：Edge Function。** 本地开发要 `supabase functions serve`；`docs/ops/v1.0-operations.md` 的部署清单要加一项。
- **同一个模型跑在两个运行时里，这是内联生成换来的代价。** 两侧的池化与归一化必须一致，否则向量空间不可比。守卫是"模型 id 与配置常量单点定义 + 一条断言测试"，以及一次人工对拍（对同一段文本比对两侧向量）——它**不能**由单元测试捕获 Supabase 侧偷偷换模型。
- **`vector(384)` 的维度写死在迁移里。** 换模型的代价是又一次迁移加重跑摄入（可承受：摄入按 `content_hash` 幂等；不可逆的部分只有维度那一列）。
- DeepSeek 直连档仍未提供 embedding；若将来引入商用 embedding，先按 `privacy.md` §4 记录条款再开。
