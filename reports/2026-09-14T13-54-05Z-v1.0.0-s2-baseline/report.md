# Eval report `2026-09-14T13-54-05Z-v1.0.0-s2-baseline`

- mode: **scripted** (stub adapter, offline, deterministic)
- at: 2026-09-14T13:54:05.824Z
- tag: `v1.0.0-s2-baseline`
- git: `80df4e5` (dirty working tree)
- app version: 0.0.0-unversioned · catalog: usda-sr-legacy-2026-07-v1
- dataset: n=29 · `bd84acbe8dd4e2a1`
- telemetry: not included (--traces not requested)

## 口径与样本量

n=29 **小于 30**：本报告只报计数与原始差，不写「提升 x%」这类百分点结论。

## 指标

| 指标 | bare | harness | Δ |
| --- | --- | --- | --- |
| 通过率 | 25/29 (86.2%) | 21/29 (72.4%) | -13.8pt |
| 约束违反率 | 13.8% | 27.6% | |
| 工具调用率 | — | 0.0% | |
| 闸拦截率 | — | 13.8% | |
| 来源合规率（软，词面） | 17.2% | 17.2% | |

## 分组（capability / regression）

regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。

| 组 | n | bare 通过 | harness 通过 | Δ |
| --- | --- | --- | --- | --- |
| regression | 14 | 10/14 | 13/14 | +21.4pt |
| capability | 15 | 15/15 | 8/15 | -46.7pt |

## 与 `2026-09-14T13-32-49Z-live-commandcode-v1` 对比

阈值：通过率 ≤ -2pt、P95 ≥ +20%、成本 ≥ +30%。

**不可比（下面的 delta 不构成结论）**：

- mode differs (live vs scripted): a scripted report and a live report measure different things

| 指标 | 2026-09-14T13-32-49Z-live-commandcode-v1 | 2026-09-14T13-54-05Z-v1.0.0-s2-baseline | Δ | 判定 |
| --- | --- | --- | --- | --- |
| harness 通过率 | 79.3% | 72.4% | -6.9pt | 不可比 |
| bare 通过率 | 55.2% | 86.2% | +31.0pt | 不可比 |
| 约束违反率 (harness) | 20.7% | 27.6% | +6.9pt | 不可比 |
| 工具调用率 | 100.0% | 0.0% | -100.0pt | 不可比 |
| 闸拦截率 | 48.3% | 13.8% | -34.5pt | 不可比 |
| regression 组通过率 (n=14) | 85.7% | 92.9% | +7.1pt | 不可比 |
| capability 组通过率 (n=15) | 73.3% | 53.3% | -20.0pt | 不可比 |
| turn 墙钟 P95 | n/a | n/a | n/a | 不可比 |
| model_call P95 | n/a | n/a | n/a | 不可比 |
| 轨迹写入 P95 | n/a | n/a | n/a | 不可比 |
| 每轮成本均值 | n/a | n/a | n/a | 不可比 |
| 缓存命中率 | n/a | n/a | n/a | 不可比 |


## 逐 case

| id | category | group | bare | harness | delta |
| --- | --- | --- | --- | --- | --- |
| s1 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s2 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
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
| e2 | edge_case | capability | pass | FAIL | −harness (bare passed, harness failed) |
| e3 | edge_case | capability | pass | pass | same (both passed) |
| e4 | edge_case | capability | pass | pass | same (both passed) |
| d1 | descriptive | regression | pass | pass | same (both passed) |
| d2 | descriptive | regression | pass | FAIL | −harness (bare passed, harness failed) |
| d3 | descriptive | regression | pass | pass | same (both passed) |
| d4 | descriptive | regression | pass | pass | same (both passed) |

## 复现

```bash
npm run eval:report -- --tag v1.0.0-s2-baseline
```
同一 datasetHash（`bd84acbe8dd4e2a1`）与同一 mode 的两次运行，summary 除 `at`/`reportId` 外逐字节相等；换数据集必须显式声明不可比。
