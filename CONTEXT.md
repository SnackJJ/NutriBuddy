# NutriBuddy — Context

营养顾问 agent 的术语表(ubiquitous language)。八模块架构的职责见 `docs/PRD.md §4`,本文只钉术语,不写实现。

## Language

### 模型路由

**Model tier(模型档位)**:
能力/成本旋钮,取值 `flash`(`deepseek-v4-flash`,便宜)或 `pro`(`deepseek-v4-pro`,强、约 3× 价)。
_Avoid_: "大模型/小模型"(指代不清)、"flash/pro 两款模型"(thinking 是另一个独立轴,不是模型款式)

**Thinking mode(思考模式)**:
强度旋钮,与档位正交。DeepSeek V4 用**参数**控制(非独立 model id),flash 默认开。
_Avoid_: 把"开 thinking"和"换 pro"混为"提高强度"——它们是两个旋钮。

**Step-level routing(步骤级路由)**:
路由决策在 **harness 设计期**按 loop 步骤的种类静态绑定档位,**不在运行期判断 query 难易**。
_Avoid_: "task routing / query routing"(暗示按用户整句话判难易,本项目明确不这么做)

**Escalation(升级)**:
默认档位跑,Verifier 判失败/覆盖不达标时,用更高档位重试该步骤。v1.5 引入,v1 暂不做。

### Agent 拓扑

**Subagent(子 agent)**:
带独立 context 的嵌套 loop,被主 agent 调用、干活、只返回摘要。**按机制成立(隔离冗长中间产物 / 自治多步),绝不按主题成立。** 本项目唯一的 subagent 是**检索**(路 B,必要时并行 fan-out)。
_Avoid_: 按领域设"补剂营养师/运动营养师"等专家 agent(按主题拆 = 反模式)、"agent team / orchestra / 同级 peer"(机制上同一原语,且本项目只有一个面向用户的主 agent,天然层级)

**Sub-call(子调用)**:
工具实现内部的一次模型调用,无自己的 loop、无自治(如规范化、摘要)。不是 subagent。

**领域专长 = 装备,不是 agent**:
回答某领域更准,靠给**同一个主 agent**挂对应的 **skill / 领域 context 包**(对的检索范围 + 领域 context + 工具),不靠换 agent。膳食规划留在主 agent,不拆。

### 模块(术语,职责见 PRD §4)

**ModelAdapter**:
唯一对外暴露 `{model, thinking}` 两旋钮的模块;换模型/换供应商只动这里。

**Verifier**:
代码层的判停 + 约束/安全闸。数字核实与过敏/疾病硬约束**由代码做,不交给模型**。
