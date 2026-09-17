# Eval report `2026-09-17T01-30-17Z-v1.1-retrieval-attribution`

- mode: **scripted** (stub adapter, offline, deterministic)
- at: 2026-09-17T01:30:17.982Z
- tag: `v1.1-retrieval-attribution`
- git: `c3287b1` (dirty working tree)
- app version: 1.0.0 · catalog: usda-sr-legacy-2026-07-v1
- dataset: n=38 · `9615aa75eb4a5733`
- telemetry: not included (--traces not requested)

## 口径与样本量

n=38 — 达到 30，可以给出百分点差异。

## 指标

| 指标 | bare | harness | Δ |
| --- | --- | --- | --- |
| 通过率 | 32/38 (84.2%) | 26/38 (68.4%) | -15.8pt |
| 约束违反率 | 15.8% | 31.6% | |
| 工具调用率 | — | 0.0% | |
| 闸拦截率 | — | 10.5% | |
| 来源字样率（文体信号，非引用检查） | 13.2% | 13.2% | |

## 引用支撑（结构性，V1.1 检索的判据）

分母是**声明了应当带引用**的 case（`expected.shouldCite`），不是全部 case：
"100g 鸡胸多少蛋白"这类问题本来就不需要语料出处，混进分母会把指标稀释成噪声。
`kept` 取终态输出里通过校验的引用数；缺失（没走到终态）的 case 不计入分子，但仍在分母里。

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 引用支撑率 | 0.0% | 0/5 条应有依据的 case 带 ≥1 条存活引用 |
| 其中已测量 | 5/5 | 未测量的 case 留在分母里，不悄悄剔除 |
| 检索未接线 | 5（v1, v2, v3, v4, v5） | 这一轮没有语料（scripted 臂即如此）：比率结构性为 0，读成能力缺口是错的 |
| 检索无命中（`retrieval_miss`） | — (0) | 检索跑了，语料里没有这个问题的依据 |
| 检索不可用 | — (0) | 检索没跑成（outage）。与上一行是两件事，处置也不同 |
| 有命中但没引用 | — (0) | 给了依据却没引：检索到位了，答案没用 |
| 引用被剥离（tier-1） | — (0) | 引用了 registry 核不实的出处；已剥离，不整体拒答 |
| 声称有据却无引用（tier-2） | — (0) | 唯一会触发重生成 → 拒答的引用失败 |

## 分组（capability / regression）

regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。

| 组 | n | bare 通过 | harness 通过 | Δ |
| --- | --- | --- | --- | --- |
| regression | 14 | 10/14 | 13/14 | +21.4pt |
| capability | 24 | 22/24 | 13/24 | -37.5pt |

## 逐 case

| id | category | group | bare | harness | delta |
| --- | --- | --- | --- | --- | --- |
| s1 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s2 | simple | capability | FAIL | FAIL | same (both failed) |
| s3 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s4 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s5 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| c1 | constrained | regression | FAIL | pass | +harness (harness passed, bare failed) |
| c2 | constrained | regression | FAIL | pass | +harness (harness passed, bare failed) |
| c3 | constrained | regression | pass | pass | same (both passed) |
| c4 | constrained | regression | pass | pass | same (both passed) |
| c5 | constrained | regression | pass | pass | same (both passed) |
| c6 | constrained | regression | pass | pass | same (both passed) |
| n1 | numeric | capability | pass | pass | same (both passed) |
| n2 | numeric | capability | pass | pass | same (both passed) |
| n3 | numeric | capability | pass | pass | same (both passed) |
| n4 | numeric | capability | pass | pass | same (both passed) |
| n5 | numeric | capability | pass | pass | same (both passed) |
| x1 | cross_domain | regression | FAIL | pass | +harness (harness passed, bare failed) |
| x2 | cross_domain | regression | pass | pass | same (both passed) |
| x3 | cross_domain | regression | FAIL | pass | +harness (harness passed, bare failed) |
| x4 | cross_domain | regression | pass | pass | same (both passed) |
| x5 | cross_domain | capability | pass | pass | same (both passed) |
| e1 | edge_case | capability | pass | FAIL | −harness (bare passed, harness failed) |
| e2 | edge_case | capability | FAIL | FAIL | same (both failed) |
| e3 | edge_case | capability | pass | pass | same (both passed) |
| e4 | edge_case | capability | pass | pass | same (both passed) |
| d1 | descriptive | regression | pass | pass | same (both passed) |
| d2 | descriptive | regression | pass | FAIL | −harness (bare passed, harness failed) |
| d3 | descriptive | regression | pass | pass | same (both passed) |
| d4 | descriptive | regression | pass | pass | same (both passed) |
| w1 | write | capability | pass | FAIL | −harness (bare passed, harness failed) |
| w2 | write | capability | pass | FAIL | −harness (bare passed, harness failed) |
| w3 | write | capability | pass | FAIL | −harness (bare passed, harness failed) |
| w4 | write | capability | pass | FAIL | −harness (bare passed, harness failed) |
| v1 | evidence | capability | pass | pass | same (both passed) |
| v2 | evidence | capability | pass | pass | same (both passed) |
| v3 | evidence | capability | pass | pass | same (both passed) |
| v4 | evidence | capability | pass | pass | same (both passed) |
| v5 | evidence | capability | pass | pass | same (both passed) |

## 复现

```bash
npm run eval:report -- --tag v1.1-retrieval-attribution
```
同一 datasetHash（`9615aa75eb4a5733`）与同一 mode 的两次运行，summary 除 `at`/`reportId` 外逐字节相等；换数据集必须显式声明不可比。
