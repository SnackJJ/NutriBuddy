# Agent Tool Design: Skills vs Atomic Tools

> Research report: June 2026  
> Researching Claude Code, Codex CLI, and industry best practices for NutriBuddy's tool architecture

---

## Executive Summary

**For NutriBuddy v1 with 4-5 tools: flat tool list, no progressive disclosure, no skills system.** The research unanimously supports this — tools under 10 sit in a "safe zone" at ~94% selection accuracy. Progressive disclosure (skills) is a context management strategy that becomes necessary at ~15-20+ tools, not a capability enhancement.

---

## 1. Tool Count vs Model Accuracy

### 1.1 Scaling Law

Tool selection accuracy follows a logarithmic decay law:

```
acc(n) = a - b × log₂(n)    (R² > 0.94)
```

Every doubling of tool count reduces accuracy by 1.8-3.1 percentage points. This is NOT linear degradation — it's logarithmic.

### 1.2 Empirical Benchmarks

| Tool Count | Approximate Accuracy     | Source              |
| ---------- | ------------------------ | ------------------- |
| ~5         | ~94%                     | Gantz.ai empirical  |
| ~20        | ~85%                     | Extrapolated        |
| ~50        | ~76%                     | Gantz.ai; BFCL data |
| ~200       | 41-83% (model-dependent) | AI/TLDR             |
| ~740+      | Near zero                | RAG-MCP project     |

**BFCL V4 (late 2025) — model comparison on function calling:**

| Model             | Overall Accuracy |
| ----------------- | ---------------- |
| Claude Opus 4.5   | 77.47%           |
| Claude Sonnet 4.5 | 73.24%           |
| GPT-5.2           | 55.87%           |
| GPT-4.1           | 53.96%           |

### 1.3 "Looking Is Not Picking" (arXiv 2606.16364, 2026)

**In 80% of BFCL failures, the model's attention IS on the correct tool — it just mis-selects it anyway.** The failure is at the readout stage (which to pick), not the input stage (didn't see it). Implications:

- Better tool descriptions have a ceiling
- Reducing tool count is more effective than optimizing descriptions
- Cleaner descriptions alone cannot fix selection errors

### 1.4 Single-Tool Selection Is Harder Than Multi-Tool Composition

CompToolBench: 17/18 models scored **higher** on composed multi-tool tasks than on isolated single-tool selection from a 106-tool catalog. Selecting 1 from 106 ≈ 40%; parallel composition ≈ 67%. The act of choosing from a large catalog is intrinsically harder.

---

## 2. Claude Code's Tool System

### 2.1 Architecture

| Layer                    | Count  | What's Included                                       |
| ------------------------ | ------ | ----------------------------------------------------- |
| Core tools               | 8      | Bash, Read, Edit, Write, Grep, Glob, Agent, TodoWrite |
| User-facing named        | ~23    | Full inventory                                        |
| Built-in implementations | ~36-40 | Source code analysis                                  |

### 2.2 Atomic Design Principle

Anthropic's Thariq Shihipar (Agent SDK Workshop):

> "Think of tools as atomic actions the agent does sequentially. We don't use bash to write files — we have a Write tool, because we want the user to see the output and approve it, and we don't combine writing files with other operations — it's a very atomic action."

### 2.3 Skill vs Tool vs Slash Command

| Layer         | Definition                                   | Role                                        |
| ------------- | -------------------------------------------- | ------------------------------------------- |
| Tool          | Atomic function exposed via JSON Schema      | "Hands" — execute I/O                       |
| Skill         | SKILL.md package with instructions + scripts | "Manager" — decides which tools, what order |
| Slash Command | `/name` shortcut                             | UI entry point for user intent              |

### 2.4 Three-Stage Progressive Disclosure

| Level        | Content                               | Context Cost         | When Loaded                          |
| ------------ | ------------------------------------- | -------------------- | ------------------------------------ |
| Metadata     | name + description (frontmatter only) | ~30-100 tokens/skill | Always in system prompt              |
| Instructions | Full SKILL.md body                    | < 2000 tokens        | On trigger (intent match or `/name`) |
| Resources    | references/, scripts/, examples/      | On demand            | Only when explicitly read/run        |

No algorithmic routing — the model's forward pass determines relevance via semantic understanding of the description.

---

## 3. Codex CLI's Tool System

### 3.1 Architecture

Single-agent ReAct loop: Think → Tool Call → Observe → Repeat. Shell-first toolkit with structured patching. Key tools: `shell`, `apply_patch`, `js_repl`, `list_dir`, `view_image`, `tool_search`, `spawn_agent`, `web_search`, `update_plan`.

### 3.2 Tool Discovery

- `tool_search`: BM25-based semantic tool search for large catalogs (hundreds of MCP tools)
- Progressive skill discovery: names/descriptions at startup (limited to 2% of context window), full instructions on demand
- Skills use the same cross-platform Agent Skills standard (Dec 2025)

---

## 4. When Progressive Disclosure Matters

### 4.1 Thresholds

| Tool Count | Action                                                                        |
| ---------- | ----------------------------------------------------------------------------- |
| 1-10       | Flat list. No progressive disclosure. Safe zone (~94% accuracy).              |
| 10-20      | Caution zone. Start considering namespacing.                                  |
| 20-50      | Implement skill-like progressive disclosure. Split into sub-agents by domain. |
| 50-100+    | RAG-based tool retrieval. Hierarchical sub-agents. Full plugin ecosystem.     |

### 4.2 What Skills Actually Are

Steve Kinney's analysis: **"Agent skills are not a new capability — they're a context management strategy."** Their value comes from routing and progressive disclosure, not from smarter prompts.

A skill says **how** to do it, **when** to use it, and **what to do when it fails**. A tool says **what** can be done. Skills = orchestration layer (procedural knowledge); Tools = execution layer (atomic functions).

---

## 5. Recommendation for NutriBuddy

### 5.1 v1 (4-5 tools): Flat List

All tools visible at all times. No progressive disclosure. No skill system. The research says this is correct — at this scale, the infrastructure cost of progressive disclosure exceeds its benefit.

### 5.2 Extensibility Path

```
v1 (4-5 tools):   Flat tool list
v2 (10-15 tools): Namespace prefixes (nutrition_query:*, meal_log:*, user_goals:*)
v3 (20-50 tools): Skill system (3-stage progressive disclosure)
```

### 5.3 Design Principles from Day One

- **Stateless tools**: Each tool receives all context, returns results. No internal state.
- **Consistent interface**: All tools follow the same JSON-Schema pattern.
- **Registry as data structure**: Tools defined as a list, not hard-coded. New tool = append to list.

---

## Key Sources

1. [Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents) — Anthropic, Dec 2024
2. [Equipping Agents for the Real World with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — Anthropic
3. [Writing Effective Tools for AI Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — Anthropic, Sep 2025
4. [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic, Sep 2025
5. [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference)
6. [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
7. [Steve Kinney: Agent Skills, Stripped of Hype](https://stevekinney.com/writing/agent-skills)
8. [OpenAI: Unrolling the Codex Agent Loop](https://openai.com/unrolling-the-codex-agent-loop/)
9. [OpenAI Codex Skills Documentation](https://developers.openai.com/codex/skills)
10. [Berkeley Function Calling Leaderboard (BFCL)](https://gorilla.cs.berkeley.edu/leaderboard)
11. [Gantz.ai: 50 Tools Accuracy Analysis](https://gantz.ai/blog/post/50-tools/)
12. [arXiv:2604.01955](https://arxiv.org/abs/2604.01955) — ClawRxiv: Tool selection scaling law
13. [arXiv:2606.16364](https://arxiv.org/abs/2606.16364) — Looking Is Not Picking
14. [arXiv:2510.20036](https://arxiv.org/abs/2510.20036) — ToolScope: merging redundant tools
15. [arXiv:2510.00307](https://arxiv.org/abs/2510.00307) — BiasBusters: tool selection bias
16. [ToolRet Benchmark](https://huggingface.co/papers/2503.01763) — arXiv:2503.01763
17. [Alatirok: Tool Count Thresholds](https://alatirok.com/how-many-tools-can-an-ai-agent-have/)
18. [Agent Engineering: Designing Action Spaces](https://www.agent-engineering.ch/articles/designing-agent-action-spaces/)
19. [YouTube: Claude Agent SDK Workshop (Thariq Shihipar)](https://www.youtube.com/watch?v=TqC1qOfiVcQ)
