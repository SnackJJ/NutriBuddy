# Eval report `2026-09-14T15-59-59Z-v1.0.0-baseline-2`

- mode: **scripted** (stub adapter, offline, deterministic)
- at: 2026-09-14T15:59:59.372Z
- tag: `v1.0.0-baseline-2`
- git: `6c833f4` (dirty working tree)
- app version: 1.0.0 · catalog: usda-sr-legacy-2026-07-v1
- dataset: n=29 · `763fad0c3cd03f67`
- telemetry: not included (--traces not requested)

## 口径与样本量

n=29 **小于 30**：本报告只报计数与原始差，不写「提升 x%」这类百分点结论。

## 指标

| 指标 | bare | harness | Δ |
| --- | --- | --- | --- |
| 通过率 | 23/29 (79.3%) | 21/29 (72.4%) | -6.9pt |
| 约束违反率 | 20.7% | 27.6% | |
| 工具调用率 | — | 0.0% | |
| 闸拦截率 | — | 13.8% | |
| 来源合规率（软，词面） | 17.2% | 17.2% | |

## 分组（capability / regression）

regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。

| 组 | n | bare 通过 | harness 通过 | Δ |
| --- | --- | --- | --- | --- |
| regression | 14 | 10/14 | 13/14 | +21.4pt |
| capability | 15 | 13/15 | 8/15 | -33.3pt |

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

## 复现

```bash
npm run eval:report -- --tag v1.0.0-baseline-2
```
同一 datasetHash（`763fad0c3cd03f67`）与同一 mode 的两次运行，summary 除 `at`/`reportId` 外逐字节相等；换数据集必须显式声明不可比。
