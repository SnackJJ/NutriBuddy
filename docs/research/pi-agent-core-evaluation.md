# pi agent core 评估（2026-09-14）

> 输入问题：**「pi agent 好不好，能不能作为 NutriBuddy 的扩展底座？」**
> 结论：**不把 pi-agent-core 作为运行时底座；把它当参照实现读，并在"管道"层（模型访问）可选接入 `pi-ai`。**
> 本文是决策输入，不是 always-on 文档；结论若被执行，落成 ADR 或 RFC。

## 一、pi 是什么

| 项 | 内容 |
| --- | --- |
| 仓库 | `Earendil-Works/pi`（原 `badlogic/pi-mono`，作者 Mario Zechner） |
| 归属 | 2026-04 被 Armin Ronacher 的 Earendil 收购；核心保持 MIT，RFC 0015 为 hosted 层保留 Fair Source/专有层 |
| 体量 | 2026-05 约 **45,041 stars**、**2,143 个社区包**（低于 Codex 80k / Gemini CLI 103k） |
| 形态 | TypeScript monorepo，六个包：`pi-ai`（多供应商 LLM API）、`pi-agent-core`（agent 运行时）、`pi-coding-agent`（CLI）、`pi-tui`（终端 UI）、`pi-telemetry`（遥测契约）、`chord`（应用组合运行时） |
| 定位 | **极简核心 + 宽边缘**：核心不含 MCP、subagent、plan mode、权限弹窗、后台 bash；能力靠扩展/包/技能外挂 |
| 安全姿态 | 明确**不内建权限系统**（文件/进程/网络/凭据），需要边界就容器化；文档同时警告"扩展会执行任意代码" |

来源：[仓库 README](https://github.com/Earendil-Works/pi)、[agent-core 文档](https://mintlify.wiki/pt-act/pi-mono/packages/agent-core)、[Implicator 分析](https://www.implicator.ai/pi-is-not-a-claude-code-rival-it-is-a-harness-rebellion/)。

## 二、设计上真正的优点（值得读的部分）

1. **核心小到可以读完**：一个 `Agent` 类 + 工具循环 + 事件流。作者的理由是"厂商 harness 会注入隐藏上下文并在版本间改变行为"——可读性本身就是产品属性。这条与 NutriBuddy"审计面必须可解释"同向。
2. **事件流是为一等消费者设计的**：`agent_start` / `turn_start` / `message_start` / `message_update`（含 `text_delta`）/ 工具执行事件。UI 直接订阅，不需要在内部状态上做反射。对照 NutriBuddy：`AnyTurnEvent` 流已经是权威轨迹，pi 的形状验证了这个方向。
3. **自定义消息类型用 TS declaration merging 扩展**：扩展不修改核心类型定义。对"包生态"是关键设计。
4. **steering / follow-up**：运行中可插入引导与后续消息，不必打断重开。NutriBuddy V1.0 明确不做"用户主动停止"，但这是将来会要的机制。
5. **session tree（Armin 特别点出的细节）**：可以从任意历史消息**分叉**，旁支问题不沉积进主上下文。对 NutriBuddy 的轨迹与归因直接有用——"如果当时换个说法会怎样"可以用同一份 trace 分叉复算，而不是重跑。
6. **供应商广度**：订阅登录（ChatGPT Plus/Pro、Claude Pro/Max、Copilot）+ 一堆 API key + 任意 OpenAI 兼容本地端点。这与我们刚做的 `PROVIDER_PROFILES`（直连 ↔ 网关）是同一个想法，pi 做得更全。
7. **供应链硬化**：直接依赖钉死精确版本、`min-release-age=2`、shrinkwrap、`npm ci --ignore-scripts`、审计工作流。值得抄进我们的 release 清单。

## 三、为什么**不**把 pi-agent-core 当底座

1. **它要替换的正是项目的差异化部分。** NutriBuddy 的 `docs/ADD.md` 第一条原则是 *Harness first: own loop / context / memory / verification / trace; libraries only fill pipes*。`pi-agent-core` 就是 loop —— 接上去等于把"四道闸 + 单一终态 + 轨迹重放 + 数字来源校验"这套自己写的东西换成别人的循环。简历上那句"基于热门框架搭 agent"反而会**削弱**现在更有说服力的那句："自建 harness，确定性闸 + 证据层 + 可重放轨迹"。
2. **安全模型相反。** pi 明确不做权限系统，写入靠容器化隔离；NutriBuddy 的安全属性是**确定性的**：数字只能来自 catalog observation、写入必须经用户确认的 immutable proposal、引用必须能回源校验。把 loop 交给一个"没有闸"的运行时，等于把安全属性降级成提示词与容器边界。
3. **没有可重放终态契约。** 我们的 S1 花了一整条切片建立"每轮恰好一个终态事件 + 落库等价 + 断连不影响 turn + D9 越权断言"。pi 的事件流是为 UI 实时性设计的，没有"审计面不可被主体改写"这类约束。两者目标不同，替换不是升级。
4. **生态的信任面。** 2,143 个包、扩展可执行任意代码：对一个存健康数据、写用户餐食账本的产品，这是要额外承担的风险面，而收益（省下自己写循环）在我们这里并不存在——循环已经写完了。
5. **"热门"不是架构理由。** pi 的热度来自它对**编码 agent** 的判断（极简、可读、不被厂商绑架），与"营养顾问 agent 需要什么"没有直接关系。投简历的正确用法是**能讲清楚为什么不用**，这比"用了 X"更能过追问。

## 四、实际该做的三件事

1. **照读，不照抄**：把 pi 的 session tree、steering、事件粒度写进我们的设计词汇表（V1.1 的轨迹分叉与"多设备续看"会用到）。这些属于 ADD 的 Observability / Loop 面，应该以 RFC 形式落地，而不是引依赖。
2. **在管道层可选接入 `pi-ai`**：`ModelAdapter` 端口本来就是为了"换供应商只动一处"。加一个基于 `pi-ai` 的实现（多供应商 + 订阅登录），既验证端口形状，也不碰 harness。它属于 ADD 允许"库填管道"的那一类。
3. **把评估本身留痕**（本文 + 需要时升成 ADR）：面试与评审都能引"我们评估过 X，选择不引入，理由是 Y；引入的是它的 Z 部分"。

## 五、什么时候应该重新评估

- 出现**多表面编排**需求（CLI + Web + IM + 定时任务共享会话），而我们的装配层开始自己长成一个"组合运行时"——那时 `chord` 与 pi-agent-core 是候选，而不是现在。
- 出现**多 subagent 拓扑**需求（ADR 0001 目前按机制只允许检索 subagent）：pi 明确不做 subagent，届时它并不比自建更有优势。
- pi 的核心**长出**我们需要的安全契约（权限、审计、确定性终态）——目前它按设计不做这些，短期不会。
