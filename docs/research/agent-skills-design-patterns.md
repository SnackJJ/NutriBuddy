# 垂直 Agent 的 Skill 设计模式（外部调研）

> 冷文档，**非 always-on 上下文**。2026-07-26 由外部调研产出，供 `docs/rfc/0012-scenario-policy-packs.md`（场景策略包设计）引用；结论未逐条复核，未成熟项已自行标注。
> 背景：单 agent harness，事实/数字/写入由确定性代码兜底，明确不做多 agent。

## 0. 一句话结论

对单 Agent、事实/数字/写入由确定性代码兜底的 harness，**Skill 应当定义为"领域策略包（policy pack）+ 可评测的程序性知识"，而不是编排单元**；控制流、门禁与写入规则永远留在 TypeScript 里。可视化工作流引擎在安全敏感路径上是负资产。

## 1. "Skill" 在当前产品里的确切含义

Agent Skills 已是开放格式：一个目录含 `SKILL.md`，YAML frontmatter 必填 `name`（≤64 字符）与 `description`（≤1024 字符），可选 `allowed-tools`（标注为实验性），另有 `scripts/`、`references/`、`assets/` 三个约定目录（[规范](https://agentskills.io/specification)）。

**载入/上下文成本模型是 Skill 的第一性设计约束**，Anthropic 分三层：启动时**只有 name + description 进系统提示**；模型判断相关才读 `SKILL.md` 正文；正文再引用 `references/` 按需读取——"可打包的上下文事实上无上限"，但常驻成本只等于描述（[Anthropic 工程博客](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)）。Claude Code 进一步工程化：Skill 正文"只在使用时载入"，`/skill-doctor` 显示每个 Skill 的**每轮上下文开销与使用次数**，并警告"每个列出的 Skill 都在每一轮增加上下文"（[Claude Code 文档](https://code.claude.com/docs/en/skills)）。同一逻辑适用于子代理：官方对子代理 description 合计超过 15,000 token 会在启动时告警（[subagents 文档](https://code.claude.com/docs/en/sub-agents)）。

| 扩展轴 | 本质 | 常驻上下文成本 | 谁决定"用不用" | 权限能力 |
|---|---|---|---|---|
| **Skill** | 文件夹化指令 + 脚本 + 参考 | 描述（小），正文按需 | 模型按 description 选择，或用户 `/name` 显式调用 | 可携带 `allowed-tools` 预授权，受既有权限流约束 |
| **Tool** | 类型化函数契约 | 每个工具完整 schema 全量注入 | 模型逐次调用 | 由权限/沙箱决定 |
| **Subagent** | 独立上下文 + 独立系统提示 + 独立工具集 | 仅 description；正文不进主上下文 | 主 Agent 委派 | 可限制工具、模型、权限模式 |
| **MCP** | 跨应用连接外部系统的协议 | 同 Tool | 客户端/用户安装 | 由 MCP 客户端与远端授权 |
| **AGENTS.md / CLAUDE.md** | 常驻事实与约定，非流程 | 全量常驻 | 永远载入 | 无 |

区别是**上下文经济学与权限面的区别，不是"能力"的区别**。Anthropic 实测把 MCP 工具改为"按需读代码 API"后 token 从 150,000 降到 2,000（[code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)）。MCP 官方把 Skill 定位为"教 Agent 如何组合工具完成复杂工作流"的互补层（[MCP 文档](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills)）。AGENTS.md 给出最重要的优先级不变式：**"离被编辑文件最近的 AGENTS.md 生效；用户显式聊天指令覆盖一切"**（[agents.md](https://agents.md/)）。

Cursor 的同构实现可对照：四种规则适用范围（Project / User / Team / AGENTS.md），用 `alwaysApply`、`globs`、`description` 精确控制"何时进上下文"（[Cursor Rules](https://cursor.com/docs/rules)）——这是"选择机制"的最小设计。

## 2. Skill 包 vs 工作流编排引擎

"用 Skill 还是 n8n/Dify/LangGraph"这个二选一被各方否定：Anthropic 按**谁拥有控制流**区分（workflow = 预定义代码路径；agent = 模型自主决定），建议"先找最简单的方案"，并点名 GUI 工作流构建器会"制造额外抽象层，遮蔽底层 prompt 与响应，使调试更难"（[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)）。LangChain 的说法是生产系统几乎都是两者组合，判据轴是**可预测性 vs 自主性**（[LangChain](https://www.langchain.com/blog/how-to-think-about-agent-frameworks)）。

| 判据 | 倾向声明式 Skill/代码 | 倾向状态化工作流引擎 |
|---|---|---|
| 控制流是否需 PR 审阅、单元测试 | 是 → 代码 | 可视化图 diff 弱 |
| 是否跨天、需人工审批后恢复 | 否 | 是（Temporal/LangGraph interrupt） |
| 副作用幂等性 | 自控 | 引擎需 at-least-once 语义 |
| 变更频率与回滚粒度 | 内容是内容 | 图版本改动影响在跑实例 |

**失败模式（有据可查）：**

- **重放会重跑副作用。** LangGraph 文档化：`interrupt` 恢复时节点**从头重跑**，因此"interrupt 之前的副作用必须幂等"（[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts.md)）；"最新图立即作用于所有 thread"的语义会让暂停中的 thread 因节点改名直接失败（[backward compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility.md)）。
- **可视化工具的审阅门禁覆盖不到真正的控制流。** n8n 官方承认工作流审阅**不覆盖 credentials、variables、子工作流**，评论"不锚定到具体节点"（[workflow reviews](https://docs.n8n.io/build/manage-workflows/workflow-reviews.md)）；其 task runner 模式被自家文档称为 **"insecure by design"**（[task runners](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-task-runners.md)）；n8n Agents 功能仍标 **Preview**（[n8n agents](https://docs.n8n.io/build/build-and-manage-agents.md)）。
- **安全面已被大规模验证。** Langflow CVE-2025-3248 进入 CISA KEV 且标记"active"利用（[NVD](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2025-3248)）；Dify 沙箱逃逸 CVE-2024-10252 可在沙箱内以 root 执行任意 Python（[NVD](https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=dify)）。
- **这一类产品仍不成熟。** OpenAI Agent Builder 宣布 **2026-11-30 关停**，官方迁移文档承认"以强确定性为核心的工作流可能无法忠实迁移"（[迁移指南](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder.md)）。

若 Agent 有安全门禁，把控制流交给可视化工具意味着：**门禁的正确性无法被类型系统与单元测试证明，只能靠点击后的观察**。

## 3. 受监管 / 安全敏感垂直如何组织领域策略

公开工程细节极少，但有三个可复制模式。

**(a) 确定性硬门禁与模型叙述分层。** Hippocratic AI 的"星座架构"：主对话 Agent 之外并行跑多个窄域监督模型（用药安全、升级逻辑、策略约束、隐私），区分"**同步阻断不安全输出的硬门禁**"与"异步监控并在后续轮次介入"（[Hippocratic AI](https://hippocraticai.com/building-ai-for-healthcare-conversations-part-2/)）。AWS Bedrock Automated Reasoning checks 是厂商化同类物：从策略文档抽取形式化规则、输出前校验——但**只检测不阻断**，且文档明确写"**无提示注入防护**"（[Bedrock 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-automated-reasoning-checks.html)）。

**(b) 检索范围是配置对象，不是提示词。** Intercom Fin 写得很清楚："你可以写'不要用某篇文章'，但**如果它是最佳匹配，Fin 可能仍然会用它**；要阻止必须从内容可用性设置里移除"（[Fin Guidance](https://www.intercom.com/help/en/articles/10210126-provide-fin-ai-agent-with-specific-guidance)）。Bloomberg 研究给出机制层面的反证：11 个模型、5000+ 有害提示上，**RAG 反而降低了安全性**，81.8% 的不安全回答来自"安全文档"（[论文](https://ar5iv.labs.arxiv.org/html/2504.18041)）。OWASP 结论一致：RAG 与微调**不能完全缓解**注入，应"**用确定性代码校验输出格式**"并对高风险动作要求人工批准（[OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)）。

**(c) 提示词只能决定"是否"，配置决定"去哪里"。** Fin 把升级机制拆成数据驱动的 **Escalation Rules**（命中即**不生成回答**、直接转人工）与自然语言 **Escalation Guidance**；"规则与指引决定**何时**升级，**Workflows 决定接下来发生什么**"；并存在刻意不可覆盖的硬编码不变式——"客户明确要求人工时 Fin 永远升级，该默认行为**不能被 procedure 覆盖**"（[Fin 升级文档](https://www.intercom.com/help/en/articles/12396892-manage-fin-ai-agent-s-escalation-guidance-and-rules)）。同组文档也警告提示词包的自然代价：指引在**生成过程中**生效，因此"步骤可能顺序错乱或被跳过"，"宽泛的指引会造成升级量急升、解决率下降"（[Guidance vs Procedures](https://www.intercom.com/help/en/articles/14623785-when-to-use-fin-guidance-vs-procedures)）。Zendesk 用 search rules（按 Article/Locale/Labels + 操作符过滤知识源）独立印证"范围靠配置"（[Zendesk](https://support.zendesk.com/hc/en-us/articles/9185497386394-Configuring-search-rules-for-knowledge-sources-for-AI-agents)）。

**营养/饮食垂直缺乏规则，但有最强的"数字不能由模型算"的证据。** 一项 10 个通用聊天机器人的临床评分研究中，简单病例最高准确率仅 67.2%，复杂病例**无一超过 50%**，同一提示重复三次的可复现性最低降至 50%，主要不一致集中在蛋白质推荐量——**同时建议增加和减少蛋白质摄入**，作者结论是"不能取代专业营养师"（[J Clin Med 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11677083/)）。监管侧边界是 FDA 的 **General Wellness**（与疾病诊断/治疗无关的健康生活方式软件不构成器械）与 CDS 指南 Criterion 4（使用者能"独立复核依据"），后者仍只针对医疗专业人员，对面向消费者的健康聊天机器人**没有新政策**（[FDA General Wellness](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/general-wellness-policy-low-risk-devices)）。WHO 的 LMM 指南点名"**自动化偏见**"：错误被忽略，或"困难选择被不当委托给模型"（[WHO](https://www.who.int/news/item/18-01-2024-who-releases-ai-ethics-and-governance-guidance-for-large-multi-modal-models)）。

**注意证据强度**：没有任何公司公开过真实系统提示词包、规则表或阈值；Salesforce Trust Layer 与 Nabla 评测白皮书基本停留在营销页。Harvey 的引用架构（[BigLaw Bench – Sources](https://www.harvey.ai/blog/biglaw-bench-sources)）与 Hippocratic AI 的监督器分类是最接近"架构披露"的公开材料。

## 4. 用户可定制行为：允许什么、锁死什么

最有用的心智模型是 OpenAI Model Spec 的**权威阶梯**：**Platform**（不可被开发者或用户覆盖）> **Developer** > **User** > Guideline，且"助手的工具消息、引用的不可信文本与多模态数据**不具有权威**"（[Model Spec](https://model-spec.openai.com/2025-02-12.html)）。Custom GPT 被建模为 **developer 角色**——"用户可配置"的产品本质是给用户一个受限的 developer 席位。

| 产品 | 用户可改 | 用户不可改 |
|---|---|---|
| ChatGPT 自定义指令 / GPTs | 语气、偏好、知识文件、行为指令 | 平台级安全规则、越狱禁令 |
| Claude Projects | 项目级自定义指令与知识库 | 工具白名单、安全策略 |
| Cursor | 四层规则、`alwaysApply`/`globs`、User Rules | 配置文件需批准、终端需批准、MCP 需逐个批准；官方自述这些是"**尽力而为的护栏而非硬安全边界**"（[Cursor 安全文档](https://cursor.com/docs/agent/security)） |
| n8n | Agent 的 prompt 与 system message | **工具集由工作流固定**；敏感工具可要求人工批准（[n8n docs](https://docs.n8n.io/build/build-and-manage-agents.md)） |
| AGENTS.md | 任意 Markdown | 优先级不变式：最近文件胜出、用户聊天指令覆盖一切 |

**跨产品一致的模式**：用户可改"表达与偏好"，不可改"可达能力、安全策略、审计与优先级"。Intercom 的实现可以照抄：允许用户用自然语言写政策，但设了 100 条上限、矛盾检测 linter、版本历史与回滚——**同时明确规定 prompt 不能路由、不能改写硬编码答案、不能做结构化计数**（[Fin Guidance](https://www.intercom.com/help/en/articles/10210126-provide-fin-ai-agent-with-specific-guidance)）。

## 5. 版本化与评测

**版本化**：OpenAI 官方建议"把生产 prompt 存在应用代码里而非可复用的 prompt 对象"，理由是类型化输入、代码审阅、测试与常规部署流程，并计划 **2026-11-30** 关停托管 prompt 对象（[Prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering)）。若用注册表，事实标准是**不可变版本 + 标签指针**（[Langfuse](https://langfuse.com/docs/prompt-management/features/prompt-version-control)、[MLflow](https://mlflow.org/docs/latest/genai/prompt-registry/)、[LangSmith](https://docs.langchain.com/langsmith/manage-prompts)）。一个常被忽略的坑：Langfuse 承认**它不替你分流流量**，灰度逻辑仍在你的代码里。

**评测**：Anthropic 的框架最有操作性——区分 **capability eval**（起始通过率就该偏低）与 **regression eval**（应接近 100%）；用 pass@k 与 **pass^k** 区分"能过"与"稳定能过"（单次 75% 成功率下 pass^3 ≈ 42%）；明确反对检查"工具调用顺序"这类过刚判据——"**更好的做法是评它产出了什么，而不是它走了哪条路**"；并给出评测器本身出错的量化案例（CORE-Bench 因判分过刚一度只得 42%，修正后 95%）（[Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)）。τ-bench 的 SOTA pass^8 < 25% 说明**单次小样本测量在结构上就是噪声**（[τ-bench](https://arxiv.org/abs/2406.12045)）。LLM-as-judge 的位置偏置与自我偏好有量化研究（[MT-Bench](https://arxiv.org/abs/2306.05685)），需人标校准；可操作数字：**每个失败模式 100–200 条标注**，dev/test 各 30–50 正例 + 30–50 反例（[Hamel Husain, Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)）。统计显著性方面把评测当实验设计已有方法论文（[Miller, Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640)）。

**CI 门禁形态**：golden dataset + experiment + 阈值，脚本低于阈值抛错让 job 失败、分数贴到 PR 评论（[Langfuse regression testing](https://langfuse.com/resources/engineering/llm-regression-testing)）。量级参考：LinkedIn 公开复盘称从 80% 到 95% 质量花了额外四个月，一次 prompt + 防御式解析把工具参数格式错误率从约 10% 降到约 0.01%（[LinkedIn 工程博客](https://www.linkedin.com/blog/engineering/generative-ai/musings-on-building-a-generative-ai-product)）。

**未成熟部分（诚实标记）**：没有任何公司公布带样本量与效应量的 prompt A/B 流水线；"离线评测与线上效果的差距"在 prompt 层面没有量化研究；judge 校准需要多少标注仍属经验之谈。

## 6. 对本项目的建议（原文结论）

### 6.1 定位：Skill 是"领域策略包"，不是编排器

Skill 不引入新控制流，只做三件事：**(1)** 给模型程序性知识；**(2)** 声明本场景允许的工具子集与必须的确认点；**(3)** 声明可被 `policy.yaml` 校验的**数据驱动触发条件**。控制流、门禁、写入仍归现有 `turn` 边界 + 确定性代码。这正是 Intercom 已验证的分工：**prompt 决定"是否"，配置/代码决定"接下来做什么"**。

### 6.2 文件布局

```
skills/
  log-meal/
    SKILL.md              # 描述 + 程序性知识（正文按需载入）
    policy.yaml           # 机器可读：触发、工具白名单、门禁、输出模板
    references/           # 少量按需文档（份量估算、常见食材口径）
      portion-estimation.md
    evals/
      evals.json          # 每轮 turn 的离线回归集
  weekly-plan/
  review-reflection/
```

```yaml
# skills/log-meal/policy.yaml
id: log-meal
version: 1.2.0
# —— 选择层：由确定性代码先算，模型只能在候选集内选 ——
triggers:
  intents: [log_meal, correct_entry]
  exclude_when: [requests_medical_advice, allergy_conflict]
# —— 能力层：只能收窄，不能扩张 ——
tools:
  allow: [catalog.lookup_food, catalog.estimate_portion, entry.propose_draft]
  deny:  [entry.commit]          # 提交必须走确认门禁
gates:
  - numbers_must_come_from: usda_catalog
  - require_user_confirm_before: [entry.commit]
  - refuse_and_escalate_if: [allergy_conflict, medical_advice_request]
output:
  template: meal_logged.v1
  must_cite: [catalog.food_id, portion_grams]
```

`SKILL.md` frontmatter 只放 `name` / `description`（description 是唯一常驻成本，要写成"何时用"而不是"是什么"）。

### 6.3 选择机制：确定性路由优先，模型选择兜底

不要让模型从全量 Skill 列表自由挑选。两段式：**代码先基于 typed event + 会话状态算出候选集**（"上一条是 pending confirm" → 只开放 `confirm-edit`；"用户提到过敏" → 强制进入 `safety-escalation`），再把候选集连同各自 description 交给模型选择或要求澄清。候选集应小（经验上 ≤ 5），因为常驻描述是线性成本。

### 6.4 可覆盖 / 不可覆盖

| 层级 | 谁写 | 例子 |
|---|---|---|
| **平台层（不可被 Skill 或用户覆盖）** | 你，在 TS 代码里 | 数值必须来自 catalog；写入必须确认；每轮恰好一个终态事件；过敏冲突拒答并升级；医疗建议拒答 |
| **开发者层（Skill 可声明、代码校验）** | 你 | 工具白名单、输出模板 id、澄清策略、引用要求、语气 |
| **用户层（Supabase 表 + schema 校验）** | 用户 | 过敏原、忌口、宗教/伦理约束、目标（减脂/增肌/血糖）、预算、烹饪时间上限、份量单位 |
| **禁止** | 任何人 | 修改门禁、绕过确认、直接写库、放宽数值来源 |

用户"自定义 Skill"应是**填结构化偏好**，而不是写 prompt。理由：Model Spec 的权威阶梯要求平台层不可被下层覆盖；自然语言政策包有已被厂商文档化的副作用——在生成过程中随时生效并**打乱有序流程**。若确实想开放"用户自建场景"，限制为受 zod 校验的 `ScenarioSpec`（触发意图 + 偏好覆盖 + 输出模板），而不是一段自由 prompt。

### 6.5 评测与版本化

三层断言分开测：

1. **确定性断言（跑在现有 `turn` 测试缝上）**：数值全部带 `food_id` 来源；无确认不得产生 commit 事件；过敏冲突必拒；恰好一个终态事件。回归集要求接近 100%。
2. **路由/触发混淆矩阵**：每个 Skill 写 should-trigger 与 should-not-trigger 提示集，测命中率——这是 Skill 最常见的退化点（[Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)）。
3. **输出质量**：LLM rubric + 人标校准，用 **pass^k** 而非 pass@k 报告。评"产出什么"而非"调用顺序"。

版本化：`policy.yaml` 带 semver，`SKILL.md` 与 `references/` 计算内容哈希，**把 (skill_id, version, hash) 写进每一轮事件流**——"哪一版策略产生了这个结果"永远可追溯，离线回放才有意义。CI 门禁照 Langfuse 形态：固定数据集 + 阈值 + 失败即挂 job。

### 6.6 什么时候才该引入 durable execution

只有出现**跨天、需人工审批暂停、需崩溃恢复**的流程（如"周计划需用户第二天确认后才落库"）才考虑持久化执行；而且仍应**用代码定义工作流**。Temporal 的模型（工作流代码保持确定性，**LLM 调用放进 Activity**，结果记录在事件历史并在重放时复用）优于 LangGraph 的"重放会重跑节点"（[Temporal workflow definition](https://docs.temporal.io/workflow-definition.md)、[Temporal AI 博客](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal)）。在此之前，一张状态表 + 自己的 `turn` 边界就够。

**最后一句**：这个项目最大的风险不是"Skill 设计得不够强大"，而是**把本不该交给模型的判断，通过 Skill 或可视化编排悄悄地交出去**。
