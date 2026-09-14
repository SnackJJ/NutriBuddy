# Eval report `2026-09-14T11-25-35Z-v1.0.0-s2-baseline`

- mode: **scripted** (stub adapter, offline, deterministic)
- at: 2026-09-14T11:25:35.983Z
- tag: `v1.0.0-s2-baseline`
- git: `0771564`
- app version: 0.0.0-unversioned · catalog: usda-sr-legacy-2026-07-v1
- dataset: n=29 · `2ed96d9b935c9739`
- telemetry: not included (--traces not requested)

## 口径与样本量

n=29 **小于 30**：本报告只报计数与原始差，不写「提升 x%」这类百分点结论。

## 指标

| 指标 | bare | harness | Δ |
| --- | --- | --- | --- |
| 通过率 | 25/29 (86.2%) | 19/29 (65.5%) | -20.7pt |
| 约束违反率 | 13.8% | 34.5% | |
| 工具调用率 | — | 0.0% | |
| 闸拦截率 | — | 6.9% | |
| 来源合规率（软，词面） | 17.2% | 17.2% | |

## 分组（capability / regression）

regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。

| 组 | n | bare 通过 | harness 通过 | Δ |
| --- | --- | --- | --- | --- |
| regression | 14 | 10/14 | 11/14 | +7.1pt |
| capability | 15 | 15/15 | 8/15 | -46.7pt |

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
| x1 | cross_domain | regression | FAIL | FAIL | same (both failed) |
| x2 | cross_domain | regression | pass | pass | same (both passed) |
| x3 | cross_domain | regression | FAIL | FAIL | same (both failed) |
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
同一 datasetHash（`2ed96d9b935c9739`）与同一 mode 的两次运行，summary 除 `at`/`reportId` 外逐字节相等；换数据集必须显式声明不可比。
