# 主 agent + 单一检索 subagent

> 2026-07-05 更新：`docs/ADD.md` 是当前架构 source of truth。本 ADR 仍约束“不要按领域拆多 agent”；知识检索 subagent 也已从 M2 固定项改为 metric-gated extension。

NutriBuddy 采用「主 agent + 单一检索 subagent」拓扑,不做按领域划分的专家 agent 团(膳食/补剂/运动营养师等)。

## 决定

- subagent **只按机制成立**(上下文隔离 / 自治多步),不按主题成立。
- 全项目唯一可能够格的 subagent 是**检索**(知识 RAG):多轮检索 + 覆盖判停会产生大量中间垃圾,需要隔离 context;必要时可并行 fan-out 多个检索 subagent。但它不是安全正确性的前置条件，只在 ADD 指标触发后进入。
- 领域专长(运动营养、补剂等)通过给**同一个主 agent**挂 **skill / 领域 context 包**(对的检索范围 + 领域 context + 工具)实现,**不**新增 agent。
- 膳食规划是主 agent 的本职,留在主 agent,不拆为 subagent。

## 为什么(权衡)

放弃"专家会诊"式的多 agent 拓扑,因为:

1. **它 N 倍化可靠性失败面** —— PRD §3 的命脉是约束违反→0、不幻觉数字、有据可循;每多一个 agent 就多一处会犯这些错的地方,Verifier(代码)还得逐个闸。
2. **引入跨 agent 编排** —— 真实营养问题大量跨域(如"肌酸增肌 + 是否影响高血压"),专家团需要路由、答案合并、冲突裁决,正是无理由去建的机械。
3. **违背"别让框架掌控控制流"**(PRD §0/§1 非目标)——专家团就是亲手搭、再被其奴役的控制流框架。

调研依据:Claude Code / Anthropic 触发 subagent 的场景(冗长输出隔离、breadth-first 并行探索、工具限制)在 NutriBuddy 要么不适用,要么塌回"检索的并行版";Anthropic 明确"步骤强依赖、低价值、短链路"不该用多 agent,而营养助手主链路正是窄而强依赖。专家"会诊"体验放到产品呈现层,不进架构。

### 补充验证（2026-06-25）：多领域 agent 分离不是共识

考察了 NutriOrion（arxiv/2602.18650）的并行 domain agent 方案（Body/Clinical/Medication/Diet 各自独立 context + 聚合），并做了一次对抗性验证。结论：**NutriOrion 最值得搬的是它的 Safety Constraint Mechanism（硬约束注入），不是它的多 agent 拓扑。** 并行 domain agent 方案存在以下问题：

1. **零生产部署**：所有生产中的医疗多 agent 系统（Rede Mater Dei 12 agent、Foxconn CoDoctor）用的是 supervisor routing，不是 NutriOrion 的并行独立 agent + 聚合模式。
2. **Optimization Paradox**（Stanford, 2026）：分别优化各领域 agent 反而降低系统整体诊断准确率（85.5% → 67.7%, p<0.001）。
3. **MAST 研究**（NeurIPS 2025）：41-87% 的多 agent 失败源于规格问题和 agent 间协调错误。
4. **Hallucination as Context Drift**（2026）：agent 间同步使幻觉恶化 34-42%。
5. **大厂一致建议**：Anthropic、Shopify、Microsoft、Google DeepMind/MIT、Cognition（Devin 团队）均建议从单 agent 起步。

**替代方案**：单 agent + 确定性代码层 gates。模型负责选择和叙述；food id、营养数字、写入 proposal、commit 都由确定性代码定义和校验。NutriOrion 的硬约束机制完全适用于单 agent 架构，但在 NutriBuddy 中体现为 ADD 定义的 input/tool/output/commit gates 和 typed verdict events。
