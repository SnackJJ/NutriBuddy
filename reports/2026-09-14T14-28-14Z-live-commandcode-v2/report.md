# Eval report `2026-09-14T14-28-14Z-live-commandcode-v2`

- mode: **live** (real model)
- at: 2026-09-14T14:28:14.951Z
- tag: `live-commandcode-v2`
- git: `794d4c4`
- app version: 0.0.0-unversioned · catalog: usda-sr-legacy-2026-07-v1
- dataset: n=29 · `bd84acbe8dd4e2a1`
- telemetry: not included (listTurns: Could not find the table 'public.turns' in the schema cache)

## 口径与样本量

n=29 **小于 30**：本报告只报计数与原始差，不写「提升 x%」这类百分点结论。

## 指标

| 指标 | bare | harness | Δ |
| --- | --- | --- | --- |
| 通过率 | 15/29 (51.7%) | 21/29 (72.4%) | +20.7pt |
| 约束违反率 | 48.3% | 27.6% | |
| 工具调用率 | — | 100.0% | |
| 闸拦截率 | — | 31.0% | |
| 来源合规率（软，词面） | 34.5% | 17.2% | |

## 分组（capability / regression）

regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。

| 组 | n | bare 通过 | harness 通过 | Δ |
| --- | --- | --- | --- | --- |
| regression | 14 | 0/14 | 10/14 | +71.4pt |
| capability | 15 | 15/15 | 11/15 | -26.7pt |

## 逐 case

| id | category | group | bare | harness | delta |
| --- | --- | --- | --- | --- | --- |
| s1 | simple | capability | pass | pass | same (both passed) |
| s2 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s3 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s4 | simple | capability | pass | FAIL | −harness (bare passed, harness failed) |
| s5 | simple | capability | pass | pass | same (both passed) |
| c1 | constrained | regression | FAIL | FAIL | same (both failed) |
| c2 | constrained | regression | FAIL | pass | +harness (harness passed, bare failed) |
| c3 | constrained | regression | FAIL | pass | +harness (harness passed, bare failed) |
| c4 | constrained | regression | FAIL | FAIL | same (both failed) |
| c5 | constrained | regression | FAIL | pass | +harness (harness passed, bare failed) |
| c6 | constrained | regression | FAIL | pass | +harness (harness passed, bare failed) |
| n1 | numeric | capability | pass | pass | same (both passed) |
| n2 | numeric | capability | pass | pass | same (both passed) |
| n3 | numeric | capability | pass | pass | same (both passed) |
| n4 | numeric | capability | pass | pass | same (both passed) |
| n5 | numeric | capability | pass | pass | same (both passed) |
| x1 | cross_domain | regression | FAIL | pass | +harness (harness passed, bare failed) |
| x2 | cross_domain | regression | FAIL | pass | +harness (harness passed, bare failed) |
| x3 | cross_domain | regression | FAIL | pass | +harness (harness passed, bare failed) |
| x4 | cross_domain | regression | FAIL | pass | +harness (harness passed, bare failed) |
| x5 | cross_domain | capability | pass | pass | same (both passed) |
| e1 | edge_case | capability | pass | pass | same (both passed) |
| e2 | edge_case | capability | pass | FAIL | −harness (bare passed, harness failed) |
| e3 | edge_case | capability | pass | pass | same (both passed) |
| e4 | edge_case | capability | pass | pass | same (both passed) |
| d1 | descriptive | regression | FAIL | FAIL | same (both failed) |
| d2 | descriptive | regression | FAIL | FAIL | same (both failed) |
| d3 | descriptive | regression | FAIL | pass | +harness (harness passed, bare failed) |
| d4 | descriptive | regression | FAIL | pass | +harness (harness passed, bare failed) |

## 复现

```bash
npm run eval:report -- --live -- --tag live-commandcode-v2
```
同一 datasetHash（`bd84acbe8dd4e2a1`）与同一 mode 的两次运行，summary 除 `at`/`reportId` 外逐字节相等；换数据集必须显式声明不可比。
