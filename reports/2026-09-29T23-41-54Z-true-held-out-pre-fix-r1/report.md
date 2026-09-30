# Eval report `2026-09-29T23-41-54Z-true-held-out-pre-fix-r1`

- mode: **live** (real model)
- at: 2026-09-29T23:41:54.221Z
- tag: `true-held-out-pre-fix-r1`
- git: `ca00db3` (dirty working tree)
- app version: 1.0.0 · catalog: usda-sr-legacy-2026-07-v1
- dataset: n=11 · `f429432a1500d7ea`
- model: provider `commandcode` · flash `deepseek/deepseek-v4.1-flash` · pro `deepseek/deepseek-v4-pro`
- pricing: upstream deepseek published pricing; the gateway's own markup is not known
- evidence: **retrieval** — 钉住集 + 逐题检索（产品行为）
- telemetry: not included (--traces not requested)

## 口径与样本量

n=11 **小于 30**：本报告只报计数与原始差，不写「提升 x%」这类百分点结论。

## 指标

| 指标 | bare | harness | Δ |
| --- | --- | --- | --- |
| 通过率 | 11/11 (100.0%) | 11/11 (100.0%) | +0.0pt |
| 约束违反率 | 0.0% | 0.0% | |
| 工具调用率 | — | 100.0% | |
| 闸拦截率 | — | 100.0% | |
| 来源字样率（文体信号，非引用检查） | 27.3% | 100.0% | |

上表通过率是**旧口径**（拒答本身不算失败）。新口径见下一节。

## 口径对照

新口径 = 旧口径，并且应答用例被拒则失败。应答用例 = 没有 `mustNotContain`、且 `shouldBeBlocked` 不是 `true`。目录缺失用例（`expectsCatalogMiss`）不进误拒率：如实说查不到是该题的正确答案。误拒包括闸耗尽拒答、`stopReason=gate_blocked`、空回复兜底，以及以拒绝开头的模型回复。

| 口径 | bare | harness | Δ |
| --- | --- | --- | --- |
| 旧口径通过率 | 11/11 (100.0%) | 11/11 (100.0%) | +0.0pt |
| 新口径通过率 | 11/11 (100.0%) | 9/11 (81.8%) | -18.2pt |
| 误拒率 | 0/11 (0.0%) | 2/11 (18.2%) | |
| 安全用例（regression）旧口径 | 0/0 | 0/0 | |
| 安全用例（regression）新口径 | 0/0 | 0/0 | |

harness 误拒：tho3, tho8

## 引用支撑（结构性，V1.1 检索的判据）

分母是**声明了应当带引用**的 case（`expected.shouldCite`），不是全部 case：
"100g 鸡胸多少蛋白"这类问题本来就不需要语料出处，混进分母会把指标稀释成噪声。
`kept` 取终态输出里通过校验的引用数；缺失（没走到终态）的 case 不计入分子，但仍在分母里。

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 引用支撑率 | n/a（数据集里没有声明应带引用的 case） | 0/0 条应有依据的 case 带 ≥1 条存活引用 |
| 其中已测量 | 0/0 | 未测量的 case 留在分母里，不悄悄剔除 |
| 检索未接线 | — (0) | 这一轮没有语料（scripted 臂即如此）：比率结构性为 0，读成能力缺口是错的 |
| 检索无命中（`retrieval_miss`） | — (0) | 检索跑了，语料里没有这个问题的依据 |
| 检索不可用 | — (0) | 检索没跑成（outage）。与上一行是两件事，处置也不同 |
| 有命中但没引用 | — (0) | 给了依据却没引：检索到位了，答案没用 |
| 引用被剥离（tier-1） | — (0) | 引用了 registry 核不实的出处；已剥离，不整体拒答 |
| 声称有据却无引用（tier-2） | — (0) | 唯一会触发重生成 → 拒答的引用失败 |

## 分组（capability / regression）

regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。

| 组 | n | bare 通过 | harness 通过 | Δ |
| --- | --- | --- | --- | --- |
| regression | 0 | 0/0 | 0/0 | n/a |
| capability | 11 | 11/11 | 11/11 | +0.0pt |

## 逐 case

| id | category | group | bare | harness | delta |
| --- | --- | --- | --- | --- | --- |
| tho1 | simple | capability | pass | pass | same (both passed) |
| tho2 | descriptive | capability | pass | pass | same (both passed) |
| tho3 | simple | capability | pass | pass | same (both passed) |
| tho4 | descriptive | capability | pass | pass | same (both passed) |
| tho5 | descriptive | capability | pass | pass | same (both passed) |
| tho6 | simple | capability | pass | pass | same (both passed) |
| tho7 | descriptive | capability | pass | pass | same (both passed) |
| tho8 | simple | capability | pass | pass | same (both passed) |
| tho9 | write | capability | pass | pass | same (both passed) |
| tho10 | descriptive | capability | pass | pass | same (both passed) |
| tho11 | simple | capability | pass | pass | same (both passed) |

## 复现

```bash
npm run eval:report -- --live --tag true-held-out-pre-fix-r1
```
同一 datasetHash（`f429432a1500d7ea`）与同一 mode 的两次运行，summary 除 `at`/`reportId` 外逐字节相等；换数据集必须显式声明不可比。
