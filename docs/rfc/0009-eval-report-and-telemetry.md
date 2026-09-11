# RFC 0009 — 评测报告与成本/延迟聚合（S2 spec）

> 状态：**Proposed**（2026-07-26）。
> 关联：`docs/rfc/0007` §3 S2（验收 D5）、`docs/rfc/0006` §6、`docs/research/agent-skills-design-patterns.md` §5（pass^k、capability vs regression）。
> 对应 issue 草稿见 §9。

## 1. 目标

1. 一条命令把已有评测与逐轮遥测变成**可回溯的历史**：既产出对外可引用的数字，也产出"这次改动是否让指标倒退"的回归基线。
2. **不改 CI 门禁语义**：scripted 仍进 CI（零网络零成本），live 仍只喂看板。

## 2. 现状与证据

- `src/eval/reporter.ts` 已产出逐 case 对比（bare / harness / delta 四种）+ 汇总；`src/eval/metrics.ts` 的 `computeMetrics` 已算 6 项指标（bare 通过率、harness 通过率、约束违反率、工具调用率、来源合规率、闸拦截率）—— **但只 print，不落盘，无历史**。
- `src/eval/index.ts` 已有 stub / live 两模式；入口是 `npm run eval` 与 `npm run eval:live`（合规信号）。
- 成本/延迟/缓存命中的字段**已经在事件里**：`TurnModelCallEvent.latencyMs / usage / costUsd`（`turn.ts:210`），loop 另发 `model_call_usage`（`loop.ts:423`）—— 缺的只是聚合，不是埋点。
- 数据集：29 条 case / 6 类失败模式（simple 5、constrained 6、numeric 5、cross_domain 5、edge_case 4、descriptive 4）。
- 现状后果：无法回答"哪一版改进了多少"，简历与对外叙述里最值钱的那句消融归因**在结构上写不出来**。

## 3. 命令与产物

```bash
npm run eval:report                              # scripted，零成本，确定性
npm run eval:report -- --live                    # 真实模型（需 DEEPSEEK_API_KEY）
npm run eval:report -- --tag retr-v2             # 给本轮变更打标签
npm run eval:report -- --compare 2026-07-26T10-00-00Z-abc1234
```

```
reports/
  index.json                  # 历史索引（§5）
  <reportId>/
    report.md                 # 人读：结论 + 指标表 + 倒退标记 + 逐 case
    summary.json              # 机读：指标 + 口径 + 环境
    cases.json                # 逐 case 判定、违规摘要、trace 指针
```

`reportId = <UTC 时间戳>-<tag>`，`tag` 缺省为 git 短 sha。

## 4. 指标口径（先定义口径，否则数字会骗人）

| 指标 | 定义 | 来源 |
| --- | --- | --- |
| harness / bare 通过率 + Δ | 逐 case pass 比例 | `computeMetrics` |
| 约束违反率 / 工具调用率 / 闸拦截率 / 来源合规率 | 已有口径不变 | `computeMetrics` |
| 延迟 P50 / P95 | turn 墙钟时长；另报所有 `model_call.latencyMs` 的分位 | `turn_events` |
| 轨迹写入延迟 | 每次 `turn_events` append 的耗时分位，**与模型延迟分开统计** | 落库计时 |
| 成本 | $/turn、总成本、token in/out | `model_call.usage / costUsd` |
| 缓存命中 | 命中 token 占比（`cacheHitTokens / promptTokens`） | `model_call.usage` |
| 终态分布 | `stopReason` 计数、`steps` 分布 | `turn_end` |
| 闸分布 | `checkpoint × verdict` 计数、`checkName` top-N | `gate_verdict` |
| 检索（V1.1 预留） | Recall@5 / MRR / 引用正确率 —— **只留字段不留实现** | 未来检索评测集 |

三条强制纪律：

1. **样本量必附**：n=29 时百分点差异不具统计意义（`docs/research/agent-skills-design-patterns.md` §5：单次小样本测量结构上就是噪声）。报告对所有对比**显示 n**；n < 30 时只报计数与原始差，不写"提升 x%"。V1.1 再加 bootstrap 置信区间（离线可做、零成本）。
2. **capability 与 regression 分组**：新能力 case（起始就该失败）与回归 case（应接近 100%）分开报告，混在一起看不出退化。
3. **口径进产物**：`summary.json` 自带指标定义与数据哈希，避免同一名字两种算法。

## 5. 历史与对比

`reports/index.json` 每条记录：

```json
{ "reportId": "...", "at": "...", "mode": "scripted|live", "gitSha": "...", "dirty": false,
  "appVersion": "1.0.0", "catalogVersion": "...", "datasetHash": "...", "n": 29,
  "summary": { "...": "..." } }
```

- `--compare <reportId>` 输出逐指标 delta 表，并按阈值标记倒退项（默认：通过率 Δ ≤ −2pt、P95 增幅 ≥ 20%、成本增幅 ≥ 30%）。
- `datasetHash`：case 集合的规范化哈希（按 case id 排序后稳定序列化）。**数据变了就不可比**，报告必须显式提示。
- 记录与 `git sha` + `appVersion` + `catalogVersion` 绑定 → 与 `docs/rfc/0012` §1.4 的 `(skill_id, version, hash)` 记账同源，V1.1 的策略版本 delta 直接复用这套索引。

## 6. 隐私与体积

- 报告与索引**不含 prompt 全文**；live 模式下模型输出默认截断到 240 字符，可 `--no-output` 关闭。
- `report.md` / `summary.json` / `cases.json` / `index.json` 进 git（这是对外证据）；原始逐 turn 轨迹**不入 git**。
- case 的 query 是人写的测试数据，可入 git。

## 7. 测试

| 测试 | 断言 |
| --- | --- |
| 渲染 | 给定结果集 → 期望的 md 表与 json 字段（纯函数） |
| 分位边界 | 1 条、偶数条、全相等时的 P50/P95 |
| 除零 | 无 model_call / 无 prompt token 时的缓存占比与成本 |
| 复现 | scripted 两次运行 `summary` 相等（忽略 `at` / `reportId`） |
| datasetHash | 同内容不同顺序 → 同 hash |
| compare | 构造倒退项 → 被标记；数据哈希不同 → 明确提示不可比 |

## 8. DoD（对应 RFC 0007 D5）

`npm run eval:report` 一条命令产出 §3 的三类产物；`summary.json` 含 §4 全部指标且均带 n；`--compare` 能标出倒退项；scripted 模式两次运行结果一致；CI 仍只跑 `npm run eval`（门禁语义不变）。

## 9. Tickets（草稿 → issue）

| # | 内容 | 依赖 |
| --- | --- | --- |
| T1 | 聚合模块（纯函数：结果集 → summary，含分位/成本/缓存/分布） | — |
| T2 | 从轨迹聚合延迟与成本（读 `turn_events`；**无 S1 时先用 stub/内存数据**，接口先定） | S1 可选 |
| T3 | markdown 渲染 + json 落盘 + `reports/index.json` | T1 |
| T4 | `--compare` 与倒退标记 | T3 |
| T5 | 测试（§7 全部） | T1–T4 |
| T6 | README 补"三条命令 + 数字从哪来"（与 §S5 上线收尾合并） | T3 |

## 10. 未决

1. 报告是否上传为 CI artifact：私有仓库收益低，倾向不做。
2. `eval:live`（合规信号跑）与 `eval:report` 是否合并入口：建议保留两个 —— 前者测"模型是否守规矩"，后者做归档与对比。
3. 是否把 live 报告与轨迹表 join（回答"哪类失败在增加"）：属 V1.1 归因闭环，本 RFC 不做。
4. bootstrap 置信区间：建议 V1.1 引入，本 RFC 只保证口径与 n 可查。
