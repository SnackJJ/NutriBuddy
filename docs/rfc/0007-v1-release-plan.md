# RFC 0007 — V1.0 版本计划：目标、验收与切片

> 状态：**Proposed**（2026-07-26）。
> 关联：`docs/adr/0002`（交付形态 Accepted）、`docs/adr/0004`（知识 RAG 纳入 Proposed）、`docs/rfc/0006`（云端运行架构 Proposed — 本计划的技术依据）。
> **本 RFC 定义目标与验收，不承载任务清单**：切片经 spec 转为 GitHub issue 后，backlog 的 live 真源在 issue tracker（见 `docs/agents/issue-tracker.md`）。

## 0. 版本约定

采用语义化版本 + git tag，`package.json` 补 `version` 字段（当前**没有**该字段，也**没有任何 tag**）。每个 release 在 turn-start 事件里带 `appVersion / catalogVersion / sourceVersion`，构成"任意一次回答可复现"的最小集合。

| 版本 | 一句话 | 状态 |
| --- | --- | --- |
| **V0.9（当前）** | harness 与安全机械完整，运行面未建立 | 已达成（见 §0.1） |
| **V1.0** | 云端可信闭环：能上线、有可复现的数字、费用可控、依据层就位 | 本 RFC 定义 |
| V1.1 | 自进化：失败归因 + 历史回放 + 场景策略包 + 知识检索 | 仅记方向 |
| V2.0 | 公开发布的开关（注册门槛、条款、隐私义务） | 仅记方向 |

### 0.1 V0.9 的判定依据（不靠记忆）

- issue tracker 中 **#82（拒绝匿名请求）与 #83（PWA shell + 移动端 confirm/edit）均已关闭**，`AGENTS.md` 的 "Next" 列表已过期。
- 代码在位：单缝 `src/harness/turn.ts`、四道闸、proposal 生命周期、RLS 迁移 0001–0010、NDJSON 流式、登录/注册与档案页、PWA manifest 与图标。
- 工程规模：51 个测试文件 / 973 条断言；eval 数据集 29 条 case（6 类失败模式）。
- **缺**：无部署配置、无 tag、无 `version` 字段、轨迹写本地文件、评测不落盘、无费用闸、首页仍是占位页。

## 1. V1.0 目标（三条，都可验收）

1. **上线且可控**：部署到云端，手机可"添加到主屏幕"日常使用；白名单登录；模型费用有硬上限，超限返回 typed refusal 而不是静默失败。
2. **可复现**：每个 turn 的完整事件流落库、可查询、可按 seq 重放；评测与成本/延迟指标落盘成历史，任意两次运行可对比。
3. **依据层就位**：source registry（版本 / 生效日期 / archive 状态 / 权威级别）与语料快照管线建成，答案引用可被结构性检查（引用的 sourceId 必须在本轮 observation 中出现过）。**检索本身留给 V1.1**。

### 1.1 V1.0 明确不做

- 知识检索链路的实现（BM25/向量/RRF/rerank）与检索 subagent —— V1.1。
- 失败归因闭环、历史 trace 回放、场景策略包 —— V1.1。
- 公开注册、多租户扩张、隐私条款的公开版本 —— V2.0 开关。
- durable execution / 工作流引擎 / 独立向量库 / Redis 会话 —— 无证据支持（`docs/rfc/0006` §2–§4）。
- token 级流式输出 —— 与"违规不可撤回"的缓冲式发布冲突（ADD §Loop）。

## 2. 验收（Definition of Done）

V1.0 完成 = 下列每一条都能**当场演示或一条命令复现**：

| # | 验收项 | 验证方式 |
| --- | --- | --- |
| D1 | 测试与类型全绿 | `npm test` + `npm run typecheck` |
| D2 | 迁移可从零重放 | `bash scripts/verify-migrations.sh` 退出码 0。脚本环境必须是**带 Supabase 基线的本地栈**（`supabase start` + reset 后按序执行）：`0005` 的策略引用 `auth.uid()`、`0011` 的外键引用 `auth.users`，vanilla Postgres 在 `0005` 就失败；而 reset 是必需的，因为老迁移不幂等（详见 RFC 0008 §4 与 issue #123） |
| D3 | 轨迹落库 | 跑一次真实 turn 后，`turn_events` 能按 `turn_id` 查出该轮全部事件，且 seq 连续；保留策略按 `docs/rfc/0008` §12.1（全保真 + 90 天滚动删除）执行且脚本可用 |
| D4 | 可重放 | 会话中断（刷新/断网）后，客户端凭 `turnId + lastSeq` 看到已产生的事件，不丢不重 |
| D5 | 数字可复现 | `npm run eval:report` 产出 `report.md` + `summary.json`，含 bare vs harness、P50/P95 延迟、$/turn、缓存命中率；重复运行（scripted）结果一致 |
| D6 | 费用可控 | 超每日配额的请求返回 typed refusal；provider 侧消费上限截图存档 |
| D7 | 白名单生效 | 非白名单邮箱无法完成注册；匿名请求仍 401 |
| D8 | 引用可核验 | 一次带依据的回答中，引用的 sourceId 均能在该轮 evidenceSet 与 source registry 中查到版本与章节。**软指标（不进 fail-closed，只进 eval report）**：抽样 N 条典型问题，统计"钉住证据集能产出可用引用"的覆盖率，写进 `npm run eval:report` 的 retrieval / rag_boundary 类别（`docs/rfc/0009` §4 已留字段）—— 它是 V1.1 判断"先扩钉住集还是先上检索"的依据 |
| D9 | 越权不可见 | 用另一账号的 JWT 查询 D3 的轨迹，返回空（RLS 有效） |
| D10 | 已上线 | 手机通过 HTTPS 访问并"添加到主屏幕"可用；`grep -r "sk-" .next/static/` 无输出 |

## 3. 切片（顺序即依赖）

| 切片 | 内容 | Spec | 产出物 | 依赖 |
| --- | --- | --- | --- | --- |
| **S1** | 轨迹持久化与 turn 重放 | RFC 0008 | 迁移 + `EventLog` 落库端口 + 重放接口 | — |
| **S2** | 评测报告与成本/延迟聚合 | RFC 0009 | `eval:report` + `reports/*` + 历史索引 | — |
| **S3** | 费用闸、配额与白名单登录 | RFC 0010 | 限额表 + 配额检查 + allowlist | S1（配额计数复用轨迹表）；**对 S4 有软依赖**：成本预估公式里的"证据子集"项由 S4 产出，S3 先行时按 0 计入、S4 完成后回头校准（RFC 0010 §3.3） |
| **S4** | 依据层：source registry、语料快照与引用检查 | RFC 0011 | 迁移 + 摄入脚本 + output gate 第五检查 | S1（引用需本轮可用证据集可查）、ADR 0004 接受 |
| **S5** | 上线收尾 | 本 RFC §4 | 部署、README、隐私说明与删除路径、tag/version | S1–S4 |
| **S6** | 数字加固（可选） | — | 压测 P95、冷启动测量 | S5 |

**S1 与 S2 可并行**（互不依赖），但 S1 必须先于 S3/S4 落地。S6 不阻塞 V1.0 上线，可在上线后补。

## 4. 上线收尾清单（S5）

- 部署到 Vercel；Supabase 项目为生产项目；环境变量只勾 Production。**前置：#88（删除路由里的 `EventLog`）必须先落地** —— 它在只读的 `/var/task` 上抛 `EROFS`，会让每个 utterance turn 失败（`docs/rfc/0008` §2）。
- `package.json` 补 `version: 1.0.0` + `v1.0.0` tag。
- `README.md` 从占位补成"能跑起来 + 能看懂架构主张"：一句话定位、三条不变量、`npm test` / `npm run eval` / `npm run eval:report` 三条命令、架构文档指针。
- 隐私说明与数据删除路径（餐食 + 用药属个人健康数据）：必须写明**轨迹保留 90 天**（`docs/rfc/0008` §12.1）、**账号删除的级联范围**，以及**所用模型供应商对请求内容的留存/训练条款**；"非医疗建议"的产品定位写入首页与回答模板。
- 首页从占位改为可用入口（登录 / 开始记录）。
- 人工验证移动端"添加到主屏幕"全流程（无法由 AFK agent 完成）。
- 确认托管计划条款是否允许非商用（`docs/rfc/0006` §12 标注为未核实）。

## 5. 风险与回退

| 风险 | 触发信号 | 处置 |
| --- | --- | --- |
| 费用敞口 | 出现非本人调用 | 立即收紧白名单 + 提高配额门槛；provider 侧上限是最后一道 |
| 迁移破坏现有 RLS | 越权查询返回了数据 | 迁移先在小项目验证；新表逐表 `revoke` 默认 grant（RFC 0006 §7） |
| 轨迹表体积 | 单 turn 事件数远超预估 | 先采样 payload、再考虑分区；保留策略见 `docs/rfc/0008` §12.1（全保真 + 90 天滚动删除，issue #122） |
| 范围膨胀 | V1.0 里塞进 V1.1 的条目 | 按 §1.1 退回，不讨论 |
| 上线后无人用 | 自己两周内未日常使用 | 说明产品假设不成立，回到 PRD 而非加功能 |

## 6. 与 issue tracker 的衔接

约定：**一份 spec 的 ticket 小节就是一组 issue 的草稿**，转 issue 时带上 spec 编号、切片号与验收项编号（如 `S1 / RFC 0008 §T3 / D4`），使每个 issue 都能回答"为什么做"和"怎么算做完"。本 RFC 不复制 issue 列表，避免两处维护。
