# Evaluating LLM Agents in Domains Without Ground-Truth Answers

> Research report: June 2026
> Covers medical, financial, legal, and nutrition domains

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Evaluation Paradigms for Open-Ended Domains](#2-evaluation-paradigms-for-open-ended-domains)
   - 2.1 LLM-as-Judge
   - 2.2 Human Expert Evaluation
   - 2.3 Constraint-Based Evaluation
   - 2.4 Groundedness/Factuality Scoring
   - 2.5 Rubric-Based Evaluation
   - 2.6 Preference-Based Evaluation
3. [LLM-as-Judge in Detail](#3-llm-as-judge-in-detail)
   - 3.1 Core Techniques
   - 3.2 Known Biases and Mitigations
   - 3.3 Calibration Against Human Judgment
   - 3.4 When LLM-as-Judge Is Good Enough
4. [Medical Domain](#4-medical-domain)
   - 4.1 Google Med-PaLM 2 Framework
   - 4.2 Hippocratic AI RWE-LLM
   - 4.3 OpenAI GPT-4 Medical Evaluation
   - 4.4 Emerging Frameworks (2025-2026)
5. [Legal Domain](#5-legal-domain)
   - 5.1 Harvey AI: BigLaw Bench & Legal Agent Benchmark
   - 5.2 LexisNexis AI Evaluation
   - 5.3 Stanford Legal RAG Hallucination Study
   - 5.4 Citation Evaluation Benchmarks
6. [Financial Domain](#6-financial-domain)
   - 6.1 Academic Benchmarks
   - 6.2 Key Research Findings
   - 6.3 FINRA Regulatory Guidance
7. [Nutrition Domain](#7-nutrition-domain)
   - 7.1 Expert Dietitian Review
   - 7.2 Diet Quality Index Scoring
   - 7.3 Standardized Exam Benchmarking
   - 7.4 Real-World RCTs
   - 7.5 Key Gaps
8. [Constraint-Based Evaluation in Practice](#8-constraint-based-evaluation-in-practice)
   - 8.1 Defining "Must Not Violate" Rules
   - 8.2 Automated Fact-Checking Pipelines
   - 8.3 Building an Eval Harness for Structured Assertions
9. [Key Papers and Surveys](#9-key-papers-and-surveys)
   - 9.1 LLM-as-Judge Papers
   - 9.2 Agent Evaluation Surveys
   - 9.3 RAG Evaluation
   - 9.4 Anthropic's Evaluation Philosophy
   - 9.5 OpenAI's Evaluation Methodology
10. [Implementation Guidance for NutriBuddy](#10-implementation-guidance-for-nutribuddy)
11. [Citations and References](#11-citations-and-references)

---

## 1. Executive Summary

Evaluating LLM agents in domains **without ground-truth answers** (medical advice, financial planning, legal analysis, nutrition counseling) requires a fundamentally different approach from traditional ML evaluation. There is no test set of correct answers.

The industry has converged on **five core paradigms**, used in combination:

| Paradigm                 | What It Measures                     | Cost       | Reliability           | Best For                     |
| ------------------------ | ------------------------------------ | ---------- | --------------------- | ---------------------------- |
| **LLM-as-Judge**         | Semantic quality against rubric      | Low        | Moderate (calibrated) | Rapid iteration, regression  |
| **Human Expert Panel**   | Clinical/professional accuracy       | High       | Gold standard         | Safety sign-off, calibration |
| **Constraint-Based**     | Rule violations (safety, compliance) | Low        | High (deterministic)  | Must-not-violate checks      |
| **Groundedness Scoring** | Claim support from sources           | Low-Medium | High                  | Hallucination detection      |
| **Preference Eval**      | User satisfaction, A/B test          | Medium     | High (real users)     | Product decisions            |

**Key findings:**

1. **LLM-as-judge is the default** but requires calibration against humans. Single LLM judges are unreliable; **jury systems** (3+ models) and **calibrated rubrics** dramatically improve reliability.
2. **Domain-specific failure taxonomies** are essential. Medical: correctness vs. safety vs. completeness. Legal: correctness vs. groundedness vs. misgrounded. Financial: timeliness, intent restraint, domain alignment.
3. **Constraint-based checks catch the most dangerous failures.** Compliance rules, "never events," and citation verification can be automated and run deterministically.
4. **Nutrition is the least mature domain** for LLM evaluation. No standardized benchmarks exist. Expert dietitian review against guidelines remains the gold standard.
5. **The gap between benchmark and real-world is large.** Multiple studies confirm that agents scoring well on intrinsic metrics fail in deployment (e.g., the INLG 2025 RCT found LLM nutrition features had "little to no effect" on outcomes).

---

## 2. Evaluation Paradigms for Open-Ended Domains

### 2.1 LLM-as-Judge

**What it measures:** Semantic quality of LLM outputs evaluated by another LLM using structured rubrics.

**Three core scoring paradigms:**

- **Pairwise comparison** -- Judge sees two outputs for the same input and picks the better one (or tie). Most reliable format because relative judgment is easier than absolute scoring. Foundation of Chatbot Arena and MT-Bench. Cost: O(n^2) comparisons for n systems.

- **Pointwise scoring with rubric** -- Judge assigns a score per output against explicit criteria. Most common in production. Binary pass/fail or 1-5 Likert scales. Enables deployment gating ("don't release if faithfulness < 0.85 on canary set").

- **Reference-based scoring** -- Judge compares output to a known-correct reference answer. Most reliable when ground truth exists (factual QA, structured extraction). Less applicable in open-ended domains.

**When to use:**

- Rapid iteration in CI/CD pipelines
- Regression testing at scale (thousands of samples)
- Objective tasks with clear criteria
- When human inter-rater agreement is high (kappa >= 0.6)

**What can go wrong:**

- Systematic biases (position, verbosity, self-enhancement, format, sycophancy)
- Low agreement with humans in subjective domains
- Judge model itself may hallucinate during evaluation
- Cost scales with number of outputs evaluated

**Concrete implementation guidance:**

1. Always pair LLM-as-judge with a **calibration set** of human-annotated examples
2. Use **position swapping** (run twice, swap A/B, only count consistent judgments)
3. Use **cross-family juries** (3+ models from different providers)
4. Report Cohen's Kappa against humans, not just accuracy
5. Include explicit "unknown/abstain" option for uncertain judgments

### 2.2 Human Expert Evaluation

**What it measures:** Professional assessment of output quality by domain experts.

**When to use:**

- Calibrating LLM judges (gold dataset creation)
- High-stakes safety sign-off before deployment
- Highly subjective or nuanced outputs (strategy, tone, creativity)
- When human inter-rater agreement is low (kappa < 0.4) -- if experts can't agree, no automated judge can

**What can go wrong:**

- Extremely expensive ($50-200/hour for physicians, $500+/hour for specialists)
- Slow (days to weeks per evaluation round)
- Rater drift over time (fatigue, changing standards)
- Small sample sizes limit statistical power

**Concrete implementation guidance:**

1. **Blind, randomized presentation** -- raters must not know output source
2. **Independent ratings** -- no conferring before scoring; use Delphi method for disagreement resolution
3. **Triplicate or quadruple rating** -- minimum 3 raters per output for reliability
4. **Measure inter-rater reliability** upfront (Cohen's Kappa, Fleiss' Kappa, ICC)
5. **Budget for recalibration** -- re-check agreement monthly as raters drift
6. **Use structured rubrics**, not holistic judgment -- this maximizes consistency

### 2.3 Constraint-Based Evaluation

**What it measures:** Whether outputs violate known rules, regulations, or safety boundaries.

**When to use:**

- Safety-critical "never events" (e.g., recommending contraindicated drugs)
- Regulatory compliance (FDA, FINRA, HIPAA, GDPR)
- Hard constraints from domain guidelines (clinical practice guidelines, dietary reference intakes)
- As a pre-filter before more expensive evaluation

**What can go wrong:**

- Incomplete rule coverage (you can't enumerate all possible violations)
- Rules may conflict or have exceptions
- Over-constraining reduces helpfulness
- Rules become outdated as guidelines change

**Concrete implementation guidance:**

1. **Maintain a machine-readable rule base** -- e.g., "must not recommend >400mg/day caffeine during pregnancy"
2. **Extract atomic claims** from LLM output (NLI-based claim decomposition)
3. **Check each claim against the rule base** (deterministic or NLI-based)
4. **Tier violations by severity** -- minor inaccuracy vs. potential harm
5. **Track rule coverage** -- what % of known guidelines are encoded

### 2.4 Groundedness/Factuality Scoring

**What it measures:** Whether claims in the output are supported by the source material (retrieved documents, knowledge base).

**Core techniques:**

- **NLI-based verification** -- Use Natural Language Inference model to check if source entails claim
- **Claim decomposition** -- Break output into atomic factual statements, verify each independently
- **Citation verification** -- Check whether citations actually support the claim they accompany
- **Retrieval-augmented evaluation** -- Measure whether retrieved context justifies the generated answer

**When to use:**

- RAG systems where outputs should be grounded in retrieved documents
- Any system that cites external sources
- High-hallucination-risk domains (medical, legal)

**What can go wrong:**

- NLI models have their own accuracy limits (typically 85-92% on benchmarks)
- Claims can be technically true but misleading without full context
- Groundedness != correctness (an output can be grounded in bad sources)
- Citation verification is computationally expensive at scale

**Concrete implementation guidance:**

1. Use **separate metrics** for groundedness (supported by sources) and correctness (true in the world)
2. Adopt the **Stanford legal hallucination taxonomy**: Correct + Grounded, Correct + Ungrounded, Incorrect + Grounded (misgrounded), Incorrect + Ungrounded
3. For RAG: measure **faithfulness** (answer matches retrieved docs), **retrieval relevance** (docs match query), and **context utilization** (answer uses all relevant docs)
4. **Harvey's approach**: Deploy a system of models that (1) break answers into factual claims, (2) verify each claim against source documents, (3) human-review a sample to confirm system alignment

### 2.5 Rubric-Based Evaluation

**What it measures:** Multi-dimensional quality assessment using domain-specific criteria.

**Common dimensions:**

- Medical: accuracy, safety, completeness, helpfulness, empathy, conciseness, harm potential
- Legal: correctness, groundedness, citation accuracy, completeness, tone, relevance
- Financial: factual accuracy, analytical completeness, data recency, model consistency, fiduciary alignment
- Nutrition: accuracy against guidelines, personalization, safety, practicality, readability

**When to use:**

- Any open-ended domain where quality is multi-faceted
- When you need to track improvement on specific dimensions over time
- Deployment gating (e.g., "safety >= 4.0 AND accuracy >= 3.5")

**What can go wrong:**

- Rubric dimensions may be correlated (e.g., helpfulness and completeness)
- Raters exhibit halo effects (high score on one dimension inflates others)
- Rubric drift over time as understanding of quality evolves
- Too many dimensions cause rater fatigue

**Concrete implementation guidance:**

1. **Keep dimensions independent and non-overlapping** -- each should measure something distinct
2. **Use binary pass/fail per criterion** rather than Likert scales where possible (improves reliability)
3. **Harvey's all-pass standard**: task passes only if every criterion passes -- no partial credit
4. **Med-PaLM approach**: separate rubrics for physicians (12 axes) and laypeople (2 axes)
5. **Calibrate rubrics iteratively** -- pilot test, refine, then deploy at scale

### 2.6 Preference-Based Evaluation

**What it measures:** Which output users (or expert raters) prefer in A/B comparisons.

**Methods:**

- **Chatbot Arena** -- ELO rating system from crowdsourced pairwise preferences
- **Expert pairwise ranking** -- Domain experts compare two outputs (Med-PaLM 2 approach)
- **A/B testing with real users** -- Measure engagement, satisfaction, task completion
- **Preference labeling** -- Create preference datasets for RLHF training

**When to use:**

- Determining which system to deploy
- RLHF data collection
- When absolute quality is less important than relative user satisfaction

**What can go wrong:**

- Users prefer more verbose or confident outputs even when less accurate
- Users cannot distinguish good advice from bad advice in unfamiliar domains
- Sycophancy (models that agree with users are preferred even when wrong)
- ELO ratings converge slowly and can be gamed

**Concrete implementation guidance:**

1. **Blind comparisons with randomized order** -- eliminate presentation bias
2. **Include expert reviewers alongside users** -- user preference != quality
3. **Track within-subject and between-subject reliability** for preference judgments
4. **ELO systems require thousands of comparisons** for stable ratings
5. **Med-PaLM 2 showed**: pairwise ranking reduces inter-rater variability vs. independent scoring

---

## 3. LLM-as-Judge in Detail

### 3.1 Core Techniques

**Effective judge prompts contain four elements:**

1. **Criterion definition** -- domain-specific terminology ("faithful to retrieved context" not "high quality")
2. **Explicit reasoning structure** -- list claims, conditions, or tool calls before scoring (Chain-of-Thought)
3. **Scoring rules** -- map reasoning to scale ("if any enumerated claim is not supported by context, score 0")
4. **Edge case handling** -- truncated context, empty retrieval, partial answers, refusals

**Advanced techniques:**

- **Rule-augmented prompting** -- embed guidelines, references, and rubrics directly in prompt
- **Adversarial judge training** -- fine-tune judges on biased vs. unbiased judgment pairs (RBD approach)
- **Structured generation** -- JSON output with per-criterion scores and justifications
- **Multi-agent collaboration** -- same-family ensemble (different temperatures) + cross-family ensemble (different providers)
- **Calibrated rubrics** -- decompose into atomic criteria with explicit pass/fail conditions

**Key papers:**

- Zheng et al. (2023) "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" -- Foundational paper; GPT-4 judge reached >80% human agreement
- Zhu et al. (2024) "JudgeLM: Fine-tuned LLMs are Scalable Judges" -- Fine-tuned judge models
- EMNLP 2025 survey "From Generation to Judgment" -- Comprehensive methodological survey

### 3.2 Known Biases and Mitigations

**Five documented bias types:**

| Bias                 | Definition                                            | Effect Size        | Primary Mitigation                              |
| -------------------- | ----------------------------------------------------- | ------------------ | ----------------------------------------------- |
| **Position bias**    | Prefers first or last position in pairwise comparison | 10-15 pp swing     | Position swapping + consistency check           |
| **Verbosity bias**   | Prefers longer outputs regardless of quality          | 15-30 pp inflation | Length-controlled scoring; prompt instruction   |
| **Self-enhancement** | Prefers own or same-family outputs                    | 10-25 pp inflation | Cross-family juries (different providers)       |
| **Format bias**      | Prefers specific formatting (markdown vs. plain)      | 5-15 pp swing      | Format-neutral rubrics; multi-format sampling   |
| **Sycophancy**       | Agrees with user's stated view                        | Varies by model    | Adversarial testing; calibrated against experts |

**Key findings from the most comprehensive bias study** (arXiv:2604.23178 "Judging the Judges: A Systematic Evaluation of Bias Mitigation Strategies"):

- **Style bias is dominant** (0.76-0.92 across all models), far exceeding position bias (<0.04)
- All models show a **conciseness preference** but correctly distinguish quality from length (0.92-1.00 accuracy)
- The **combined budget strategy** (position swap + CoT + rubric) significantly improved Claude Sonnet 4 by +11.2 pp (p<0.0001)
- **Only 2 of 20 non-baseline configurations** showed decreased agreement
- **Mitigation effectiveness is model-dependent** -- no universal solution

**Practical mitigation pipeline:**

1. Randomize position on every pairwise call
2. Use different-provider judge for evaluation (avoid self-enhancement)
3. Apply position swapping + consistency scoring
4. Use calibrated rubrics with explicit length-independent criteria
5. Calibrate against human experts monthly
6. Rotate judge model families to avoid overfitting to judge preferences

### 3.3 Calibration Against Human Judgment

**Why Kappa:** Cohen's Kappa measures agreement corrected for chance. Raw accuracy can be misleading -- if 90% of samples pass, a judge that labels everything "pass" has 90% accuracy but Kappa = 0.

**Target thresholds:**
| Kappa Range | Interpretation | Production Readiness |
|---|---|---|
| < 0.20 | Poor | Do not use |
| 0.20 - 0.40 | Fair | Coarse signal only, low-risk |
| 0.40 - 0.60 | Moderate | OK for internal evals |
| 0.60 - 0.80 | Substantial | Target for production |
| 0.80 - 1.00 | Near perfect | Excellent |

**Key calibration principle:** The judge should match human inter-rater agreement, not exceed perfect 1.0. If two human experts agree at kappa 0.55 on a subjective task, demanding kappa 0.85 from an LLM judge is misguided. Always measure human-human agreement first, then compare LLM-human to that baseline.

**Recent findings:**

- GPT-4 on MT-Bench: ~0.80 kappa vs. humans, matching human-human agreement (Zheng et al. 2023)
- Large-scale study (arXiv:2606.19544, 21 models): kappa-accuracy gap of 33.8-41.2 pp -- raw accuracy significantly overestimates performance
- "Turing test" approach (arXiv:2510.09738): Mix LLM with 3 humans, compute pairwise kappa, identify models with human-like judgment (|z| < 1). Passing models achieve 0.781-0.816 kappa

**Calibration tools:**

- **llm-judge-calibrator** -- Runs position swap experiments, outputs Cohen's Kappa, bias rates, overall grade (A-F)
- **Judge calibration loop** (andrewBatutin) -- Iterative prompt patching to optimize kappa. Out-of-box judges start at 0.2-0.4; iteratively improvable

### 3.4 When LLM-as-Judge Is Good Enough vs. When You Need Humans

**Use LLM-as-Judge when:**

- Rapid iteration (CI/CD, every commit push)
- Regression testing ("does it still handle all old cases?")
- Mass evaluation (thousands of samples)
- Objective tasks with clear criteria
- High human agreement on the task (kappa >= 0.6)

**Use human experts when:**

- Calibrating LLM judges (creating gold dataset)
- Evaluating highly subjective outputs (strategy, creativity, empathy)
- Task ambiguity means low human agreement (kappa < 0.4)
- High-stakes decisions (safety, compliance, regulatory sign-off)
- Rare but critical failure modes (adversarial testing, red teaming)

**Hybrid approach (Anthropic's recommendation):**

1. **Automated graders** -- deterministic graders preferred, LLM graders used where needed, all run on every change in CI/CD
2. **LLM graders** -- calibrated against human experts; include "unknown" escape hatch; use clear structured rubrics; one dimension per grader
3. **Human review** -- reserved for (a) calibrating LLM graders, (b) evaluating subjective outputs, (c) spot-checking pipeline health

**Selective evaluation** (emerging paradigm): LLM judge self-scores confidence and abstains when uncertain. Methods like "Trust or Escalate" (arXiv:2407.18370) can guarantee high-agreement coverage by predicting when the judge will agree with humans and only escalating uncertain cases.

---

## 4. Medical Domain

### 4.1 Google Med-PaLM 2 Framework

**The most comprehensive and cited medical LLM evaluation framework.** Published in Nature Medicine (Singhal et al., 2024).

**Evaluation dimensions (14 total):**

- **Physician rubric** (12 axes): scientific factuality, precision, medical reasoning, knowledge recall, reading comprehension, completeness, appropriate context, consensus support, safety/harm, bias, missing important content, unnecessary information
- **Layperson rubric** (2 axes): helpfulness, comprehension

**Three evaluation modes:**

1. **Individual answer evaluation** -- Each answer rated independently by 3 random raters (physician or layperson). MultiMedQA 140: triple-rated. Adversarial sets: quadruple-rated. Inter-rater reliability: kappa > 0.8 for 10/12 axes, > 0.6 for remaining 2.

2. **Pairwise ranking evaluation** -- Direct comparison between two answers (e.g., Med-PaLM 2 vs. physician). 1,066 consumer medical questions. Blinded, randomized order. **Physicians preferred Med-PaLM 2 over physician-written answers on 8 of 9 clinical axes (p < 0.001).**

3. **Adversarial testing** -- 240 long-form questions designed to probe LLM limitations. Two datasets: adversarial general + adversarial health equity.

**Key methodological contributions:**

- Separate rubrics for clinical experts and lay users
- Triplicate/quadruple rating with inter-rater reliability reporting
- Pairwise ranking reduces inter-rater variability
- Adversarial dataset creation through red teaming
- Chain of retrieval for grounding answers in verified medical sources

**Sources:**

- Nature Medicine paper: https://www.nature.com/articles/s41591-024-03423-7
- arXiv: https://arxiv.org/abs/2305.09617

### 4.2 Hippocratic AI RWE-LLM

**Real-World Evaluation of Large Language Models in Healthcare** -- the largest-scale medical AI safety validation.

**Scale:** 6,234 US licensed clinicians (5,969 nurses + 265 physicians), average 11.5 years experience, evaluated over 307,000 unique clinical scenarios across 4 iterations.

**Four-stage framework:**

1. **Pre-implementation** -- Define safety requirements, clinical domains, error severity categories
2. **Three-tier review** -- Internal nursing review -> physician adjudication -> expert panel for complex cases
3. **Resolution** -- Systematic feedback loop from error identification to system enhancement
4. **Continuous monitoring** -- Spot-checking and ongoing surveillance

**Error severity classification:**

- Minor clinical inaccuracies -> potential safety concerns -> severe harm risk
- Three-tier system ensures appropriate escalation

**Results over iterations:**
| Iteration | Correct Advice | Minor Harm | Severe Harm |
|---|---|---|---|
| Pre-Polaris | ~80.0% | 1.32% | 0.06% |
| Polaris 1.0 | 96.79% | 0.13% | 0.10% |
| Polaris 2.0 | 98.75% | 0.07% | 0.00% |
| Polaris 3.0 | 99.38% | -- | -- |

**Key innovation:** **Constellation architecture** -- 22 specialized LLMs (later 30+) around a core conversational model. Support models validate specific safety dimensions (medication interactions, lab results, escalation criteria) independently.

**Methodology publication:** https://www.medrxiv.org/content/10.1101/2025.03.17.25324157v1

### 4.3 OpenAI GPT-4 Medical Evaluation

**Approach:** Standardized exam benchmarking + human error analysis + calibration studies.

**Exam benchmarks:** USMLE (86.7%), MedQA, PubMedQA, MedMCQA, MMLU medical subsets. GPT-4 exceeded passing score by >20 points.

**Medprompt strategy** (Nori et al.): Dynamic few-shot selection, self-generated chain-of-thought, choice shuffling ensemble. Achieved 90.2% on MedQA.

**Error analysis methodology:** 44 medical experts annotated 300 out of 919 erroneous GPT-4 answers. Found large fraction labeled "reasonable answers by GPT-4" even when factually wrong -- highlighting the difficulty of evaluation in medicine.

**Comparison to Med-PaLM 2:** Med-PaLM 2 invested more heavily in human evaluation (pairwise ranking, multi-axe rubrics). GPT-4 focused more on exam performance and calibrated uncertainty.

### 4.4 Emerging Medical Evaluation Frameworks (2025-2026)

**MedHELM** (Holistic Evaluation of LLMs for Medical Tasks):

- 3-member LLM jury (GPT-4o, Claude 3.7 Sonnet, LLaMA 3.3 70B)
- 3 axes: factual correctness, completeness, safety (1-5 Likert)
- LLM jury ICC=0.47, better than average clinician inter-rater agreement (0.43)
- https://arxiv.org/abs/2505.23802

**CARE** (Co-cause Aware Jury Aggregation):

- Models latent variable quality, inter-rater correlation, and confounders in multi-judge aggregation
- Reduces aggregation error by up to 25.15%
- https://openreview.net/forum?id=seM2ixNp6W

**MedJUDGE** (Medical Judge Utility, Debiasing, Governance, and Evaluation):

- Risk-stratified 3-pillar framework: efficacy, safety, accountability
- Three clinical risk tiers (A/B/C) with escalating rigor requirements
- https://arxiv.org/abs/2604.25933

**Human Evaluators vs. LLM-as-a-Judge** (medRxiv 2025):

- 5 LLM judges (GPT-5, Gemini-2.5-Pro, Claude-4.1-Opus, MedGemma-20B, GPT-OSS-70B)
- 6 bilingual Rwandan doctors
- 11 evaluation dimensions adapted from Med-PaLM 2 framework
- **Key finding**: Weighted juries outperform individual judges. Claude best among individuals; L1 jury achieved equivalence on 5/11 criteria
- https://www.medrxiv.org/content/10.1101/2025.10.27.25338910v1

**MEDIC** (Modular Evaluation framework):

- 5 critical dimensions: medical reasoning, ethical/bias concerns, data/language understanding, in-context learning, clinical safety
- Living framework, not static benchmark
- https://arxiv.org/html/2409.07314

**EGDA** (Evidence-Grounded Decision Authority):

- Grades evidence into 3 levels: L0 (absent), L1 (suggestive), L2 (confirmed)
- Claim-grade rules determine what assertions each level permits
- Reduced ungrounded reasoning from 48.7% to 8.0% in breast oncology cases
- https://www.medrxiv.org/content/10.64898/2026.05.19.26353565v1

**CREOLA** (Clinical Review of LLMs and AI):

- Clinician-in-the-loop methodology
- Error taxonomy + clinical safety framework + annotation platform
- Quantifies clinical impact of hallucinations specifically
- https://www.medrxiv.org/content/2024.09.12.24313556v1

**MedGuard** (PMC 2025):

- 5 principles: truthfulness, resilience, fairness, robustness, privacy
- 10 aspects, 1,000 expert-validated questions across 11 LLMs
- Found current models universally underperform regardless of safety alignment
- https://pmc.ncbi.nlm.nih.gov/articles/PMC12478422/

---

## 5. Legal Domain

### 5.1 Harvey AI

Harvey has the most mature and transparent evaluation framework among legal AI companies.

**BigLaw Bench** (2024):

- Public-facing benchmark for evaluating LLMs on complex legal tasks
- **Two independent scores**: Answer Score (completeness/accuracy) and Source Score (verifiability of assertions)
- **Custom rubrics** with positive points for task completion and negative points for errors (hallucinations, incorrect tone, irrelevant material)
- Harvey scored 74% answer score, 68% source score. GPT-4o scored 24% on source score.
- Foundation models show trouble showing their work even when explicitly asked

**Legal Agent Benchmark (LAB)** (2025, open source):

- 1,200+ agent tasks across 24 legal practice areas
- Evaluated by 75,000+ expert-written rubric criteria
- **All-pass grading**: task passes only if every criterion passes -- no partial credit. Rationale: "A deal-team report that identifies eight of ten risks is not 80% useful; it is materially incomplete."
- Each criterion = atomic binary pass/fail (facts, conclusions, citations, severity, recommendations, deadlines, formatting)
- **LLM-as-judge** with `claude-sonnet-4-6` as default; no golden reference output
- Cross-model consensus: GPT-5.5 and Opus 4.8 agree on >95% of criteria
- Grader reliability: 98.9% per-criterion self-consistency floor across three reruns

**Hallucination detection pipeline:**

1. Deploy system of models that break answers into all relevant factual claims
2. Verify each claim against source of truth documents
3. Human-review sample to confirm system alignment
4. Harvey's hallucination rate: ~1 in 500 claims (0.2%). Foundation models: 0.7-1.9%.

**Scaling evaluation** (Harvey blog):

- Likert-scale ratings by domain experts (1-7) on accuracy, helpfulness, clarity
- Internal tool for side-by-side LLM comparisons by experts
- Automated grading with confidence scores
- Retrieval evaluation using precision, recall, NDCG

**Sources:**

- https://github.com/harveyai/harvey-labs/blob/main/docs/eval-strategies.md
- https://www.harvey.ai/blog/introducing-biglaw-bench
- https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark
- https://www.harvey.ai/blog/biglaw-bench-hallucinations

### 5.2 LexisNexis AI Evaluation

**Core approach:** Grounded in proprietary content authority + human expert review.

**Architecture:** RAG with "minimum of five crucial checkpoints" per prompt:

- Intelligent ranking (Shepard's Signal indicators)
- Authoritative content verification
- Citation validation

**Human infrastructure:** 300+ J.D. experts on Data Discovery and Enrichment team. "Hundreds of thousands of rated answer samples by subject matter experts used for model tuning."

**Independent validation:** Engaged PwC to validate measurement methodologies. Third-party evaluations from Stanford RegLab + HAI.

**Stanford study findings:**

- Lexis+ AI accurate on 65% of queries (vs. 18% for Ask Practical Law AI)
- 17-33% hallucination rates across all RAG-based legal tools tested
- Rigorous human evaluation: Cohen's kappa 0.77, 85.4% inter-rater agreement

### 5.3 Stanford Legal RAG Hallucination Study

**Key paper:** "Hallucination-Free? Assessing the Reliability of Leading AI Legal Research Tools" (Stanford HAI, 2024)

**Contributions:**

1. First systematic assessment of leading AI legal research tools
2. Manual dataset of 200+ legal queries for probing vulnerabilities
3. Detailed hallucination typology for legal domain
4. Pre-registered methodology with transparent coding

**Hallucination taxonomy:**

- **Correct vs. Incorrect** (factual accuracy dimension)
- **Grounded vs. Ungrounded vs. Misgrounded** (source relationship dimension)
  - Grounded: valid references support the claim
  - Ungrounded: no citations provided
  - Misgrounded: cites sources but misinterprets or source is inapplicable
- A hallucination = incorrect OR misgrounded

**Inter-rater reliability:** Cohen's kappa 0.77, 85.4% agreement -- "substantial" per Landis & Koch.

### 5.4 Citation Evaluation Benchmarks

**LegalCiteBench** (arXiv:2605.10186):

- 24K evaluation instances from 1,000 real U.S. judicial opinions
- 5 tasks: citation retrieval, citation completion, citation error detection, case matching, case verification
- Key metric: **Misleading Answer Rate (MAR)** -- proportion of low-scoring responses that provide concrete citation rather than abstaining
- Even strongest models score below 7/100 on citation retrieval; MAR exceeds 94% for 20/21 models

**Citation Grounding (CG)** (arXiv:2606.00898):

- 3-component metric: **Citation Precision** (does provision exist?), **Citation Relevance** (contextually appropriate?), **Citation Temporality** (valid at relevant date?)
- Applied to 100.8M Ukrainian court decisions
- Commercial LLMs hallucinate 13-21% of legal citations
- Proposes **Citation Grounding DPO** for training with algorithmic preference pairs

**LegalHalluLens** (arXiv:2606.18021):

- Typed hallucination profiles across 4 categories: numeric, temporal, obligation/entitlement, factual
- **Risk Direction Index (RDI)**: single signed scalar measuring omission-vs-invention bias
- Key finding: ~40pp gap between obligation/numeric and temporal claims hidden by aggregate metrics. Two systems with same 52% hallucination rate can carry opposite risk directions

**Reliability by Design** (arXiv:2601.15476):

- Two operational metrics: **False Citation Rate (FCR)** and **Fabricated Fact Rate (FFR)**
- Pure generative: 26.8% FCR, 15.6% FFR. Advanced RAG: -99.8% both

**Who Checks the Citations?** (arXiv:2606.21155):

- 1,000+ court filings with fabricated citations, growing year-over-year
- GPT-5 achieves 82.8% recall, 60.5% F1 in agentic setting
- Models struggle most with: incorrect pincites (18.2% recall)

---

## 6. Financial Domain

### 6.1 Academic Benchmarks

| Benchmark            | Scale                                  | Methodology                                                                                                        | Key Finding                                                                    |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **FinTrust** (2025)  | 15,680 QA pairs, 7 dimensions          | Trustworthiness evaluation: truthfulness, robustness, safety, fairness, privacy, transparency, knowledge discovery | Tests fiduciary alignment and conflict of interest disclosure                  |
| **Hedge-Bench 1.0**  | 102 real analyst tasks + expert traces | LLM-as-judge with citation verification + hallucination penalties                                                  | Frontier models score below 16%                                                |
| **FinResearchBench** | Open-ended financial research          | Logic tree Agent-as-a-Judge: correctness, informativeness, source attribution, professionalism                     | Hierarchical criteria structure                                                |
| **FIRE Benchmark**   | Open-ended financial tasks             | Rubric-based automated grading                                                                                     | Explicitly notes LLM-as-judge instability; fine-grained criteria as mitigation |
| **FinToolBench**     | Tool-use tasks                         | Measures timeliness, intent restraint (info vs. transactional), domain alignment                                   | Tracks domain hallucination (equity tools for crypto)                          |
| **BigFinanceBench**  | 928 workflow-grounded questions        | Point-weighted rubrics with dual judging. Grades full trajectory (tool calls, calculations), not just final answer | Created by practicing analysts                                                 |
| **FinDeepResearch**  | 64 companies, 8 markets                | Dual evaluation: Structural Rigor + Information Precision                                                          | Specific, traceable claims required                                            |
| **AFIB**             | Multi-dimension                        | Factual accuracy, analytical completeness, data recency, model consistency, failure patterns                       | 5-dimensional quality profile                                                  |

### 6.2 Key Research Findings

**Heuristic collapse** (arXiv:2604.23837):

- LLMs focus almost entirely on risk tolerance (willingness) while ignoring financial capacity (income, horizon, liquidity needs)
- This violates fiduciary suitability standards

**User insensitivity to quality** (arXiv:2504.05862):

- Users prefer extroverted LLM-advisors even when they give worse advice
- Users cannot distinguish good from bad advice in financial domains

**Sycophancy eval** (Prakhar Anand, 2026):

- Asymmetric bullish deference -- models tilt positive when users are enthusiastic
- "The user who most needs scrutiny gets the least"

**Gender bias** (Taha Choukhmane, 2026):

- Two-thirds of gender difference driven by different prompts
- One-third from models giving different advice to same question by different gender labels

### 6.3 FINRA Regulatory Guidance

- **Technology-neutral stance**: Existing rules apply equally to AI-generated content
- **Rule 3110 (Supervision)**: Firms must have supervisory systems addressing model risk management, data privacy, reliability, and accuracy
- **Rule 2210 (Communications)**: Content standards apply to AI-generated communications
- **2026 Oversight Report expectations**: Formal review/approval processes, pre-deployment testing, ongoing monitoring of prompts/responses/outputs, human-in-the-loop review
- **AI agents (first-time in 2026 Report)**: Specific guidance on testing and monitoring for autonomous agents
- No specific LLM evaluation methodology mandated; firms determine own approach

---

## 7. Nutrition Domain

### 7.1 Expert Dietitian Review (Most Common Method)

Several studies use panels of registered dietitians scoring LLM outputs against established guidelines:

- **MDPI Nutrients (2024)**: 30 dietitians evaluated ChatGPT on 7 criteria (accuracy, currency, completeness, understandability, readability, relevance, practicality) using 1-10 Likert
- **J. Clinical Medicine (2024)**: 3 expert dietitians evaluated accuracy (5-pt Likert), completeness (binary), reproducibility (0-2), consistency across 3 days
- **Frontiers in Nutrition (2026)**: 14 clinical experts from different fields; blinded multidimensional ratings (accuracy, safety, nutritional balance, personalization, practicality) on 79 real clinical cases
- **JMIR (2025)**: Llama 3 + RAG grounded in AHA dietary guidelines; 3 expert reviewers scored on appropriateness, reliability, readability, harm, guideline adherence

**Key finding across studies:** LLMs are often indistinguishable from dietitians on subjective quality but flagged for safety concerns and lack of personalization.

### 7.2 Diet Quality Index Scoring

- **DQI-I (Diet Quality Index-International)** used to evaluate meal plans from Gemini, Copilot, ChatGPT 4.0 (MDPI Nutrients 2025)
- Scoring: variety (15pts), adequacy (40pts), moderation (30pts), balance (10pts)
- Validation against USDA Food Data Central

### 7.3 Standardized Exam Benchmarking

- **Registered Dietitian (RD) Exam**: 1,050 multiple-choice questions across 4 domains
- Benchmarked GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro with 4 prompting techniques (ZS, CoT, CoT-SC, RAP)
- https://www.nature.com/articles/s41598-024-85003-w

### 7.4 Real-World RCTs

**INLG 2025** -- First 7-week RCT (N=81) of LLM-enhanced nutrition chatbot:

- Compared rule-based vs. LLM-augmented groups
- Measured dietary outcomes, emotional well-being, engagement
- **Key finding**: LLM features had "little to no effect on any measures"
- Demonstrates gap between intrinsic metrics and real-world impact

### 7.5 Key Gaps

- No standardized benchmarks exist for LLM-based nutrition recommendations
- Most evaluations are intrinsic (textual characteristics) rather than extrinsic (real-world outcomes)
- Only one RCT identified (INLG 2025)
- Expert review against guidelines remains gold standard
- Nutrition lacks an equivalent of AgentBench, Med-PaLM evaluation, or Legal Agent Benchmark
- App evaluation focuses on calorie tracking accuracy (MAPE comparisons), not advice quality

---

## 8. Constraint-Based Evaluation in Practice

### 8.1 Defining "Must Not Violate" Rules

**Approach from medical domain (EGDA framework):**

1. Grade evidence into levels: L0 (absent), L1 (suggestive), L2 (confirmed)
2. Define claim-grade rules: what assertions are permitted at each evidence level
3. Automated checking: extract claims from output, check evidence grade, verify assertion permissibility

**Approach from clinical safety (Never Events):**

- Define "things the AI must never do" based on clinical guidelines
- Test with adversarial inputs (e.g., patient claims unreasonable medication dosage)
- Use expert-written must-include/must-exclude criteria grounded in named clinical guidelines
- Open-source toolkit: https://github.com/deepikaa-s/clinical-safety-eval

**Approach from legal (Harvey):**

- Hallucination = factual claim demonstrably disproven by reference to a source of truth
- Does NOT count reasoning errors or incomplete understanding as hallucinations
- Separate measurement for different failure modes

**Implementation pattern:**

```
1. Domain expert writes rules: "IF patient_pregnant AND drug=X THEN MUST flag caution"
2. Encode as structured rules (DSL, JSON schema, or code)
3. Decompose LLM output into atomic claims (NLI-based extraction)
4. Check each claim against rule base
5. Flag violations with severity tier
```

### 8.2 Automated Fact-Checking Pipelines

**Harvey's approach (most mature documented pipeline):**

1. Model system breaks answer into all relevant factual claims
2. For each claim, check against source of truth documents
3. Human review sample to confirm system alignment
4. Hallucination rate = sentences containing hallucinated claim / total sentences

**Stanford legal hallucination approach:**

1. Define groundedness: relationship between response and cited sources
2. Three categories: grounded (valid), ungrounded (no citations), misgrounded (cites but inapplicable)
3. Hallucination = incorrect OR misgrounded

**General pattern (RAGAS, TruLens):**

1. Retrieve source documents
2. Generate answer from retrieved context
3. Check faithfulness: are answer claims entailed by retrieved documents? (NLI model)
4. Check relevance: are retrieved documents relevant to the query?
5. Score = average of per-claim entailment probabilities

**Key distinction**: Groundedness != correctness. An output can be grounded in bad sources, or correct without being grounded. Measure both separately.

### 8.3 Building an Eval Harness for Structured Assertions

**Based on Harvey's open-source evaluation framework** (https://github.com/harveyai/harvey-labs):

```
task.json structure:
{
  "task": {
    "instruction": "What is the caloric deficit needed to lose 1kg/week?",
    "context": {
      "materials": [
        {"name": "WHO Guidelines", "content": "..."},
        {"name": "Patient Profile", "content": "..."}
      ]
    },
    "deliverables": ["response.md"],
    "criteria": [
      {
        "id": "deficit-calculation",
        "match_criteria": "Calculation correctly states 7700 kcal deficit per kg of body fat loss",
        "deliverables": ["response.md"],
        "weight": 1.0
      },
      {
        "id": "safety-warning",
        "match_criteria": "Warns against deficit exceeding 1000 kcal/day without medical supervision",
        "deliverables": ["response.md"],
        "weight": 1.0
      }
    ]
  }
}
```

**Key design principles:**

- **No golden reference output** -- the `match_criteria` IS the standard
- **Binary pass/fail per criterion** -- no partial credit improves reliability
- **All-pass task score** -- task scores 1.0 only if every criterion passes
- **Semantic matching** (not keyword) -- LLM judge evaluates meaning, not wording
- **LLM judge is a separate call** -- not the agent being evaluated
- **SSOT (Single Source of Truth)**: `task.json` is authoritative

**For nutrition specifically**, criteria could include:

- Caloric calculation accuracy based on patient metrics
- Macronutrient distribution within recommended ranges
- Safety warnings for extreme values
- Contraindication checks (pregnancy, comorbidities, medications)
- Guideline adherence (WHO, Dietary Guidelines for Americans, etc.)

---

## 9. Key Papers and Surveys

### 9.1 LLM-as-Judge Papers

| Paper                                                                 | Venue               | Key Contribution                                      |
| --------------------------------------------------------------------- | ------------------- | ----------------------------------------------------- |
| Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena (Zheng et al.) | NeurIPS 2023        | Foundational; GPT-4 judge >80% human agreement        |
| JudgeLM: Fine-tuned LLMs are Scalable Judges (Zhu et al.)             | ICLR 2025 Spotlight | Fine-tuned judge models                               |
| From Generation to Judgment (EMNLP 2025 survey)                       | EMNLP 2025          | Comprehensive survey: 10 methods, bias quantification |
| Judging the Judges: Evaluating Alignment (arXiv)                      | 2024                | Systematic vulnerability analysis                     |
| Judging the Judges: Bias Mitigation (arXiv:2604.23178)                | 2026                | 9 debiasing strategies across 5 models, 3 benchmarks  |
| Justice or Prejudice? Quantifying Biases (CALM framework)             | ICLR 2025           | 12 bias types; automated quantification               |
| Any LLM Can Be a Reliable Judge (RBD, NeurIPS 2025)                   | NeurIPS 2025        | Reasoning-based Bias Detector                         |
| Beyond the Surface: Measuring Self-Preference                         | EMNLP 2025          | Self-preference quantification                        |
| Am I More Pointwise or Pairwise? (arXiv:2602.02219)                   | 2026                | Position bias in rubric-based scoring                 |
| Agreement Metrics for LLM-as-Judge (arXiv:2606.00093)                 | 2026                | What metrics to report and why                        |
| Reliability without Validity (arXiv:2606.19544)                       | 2026                | Large-scale kappa analysis; 21 models                 |
| Trust or Escalate (arXiv:2407.18370)                                  | 2024                | Selective evaluation with guarantees                  |

### 9.2 Agent Evaluation Surveys

| Survey                                                    | Venue    | Key Contribution                                      |
| --------------------------------------------------------- | -------- | ----------------------------------------------------- |
| Survey on Evaluation of LLM-based Agents (Yehudai et al.) | ACL 2026 | First comprehensive agent eval survey; 5 perspectives |
| From Benchmarks to Deployment (Springer)                  | 2026     | 15 benchmarks analyzed; 0/15 include safety scoring   |
| Evaluation and Benchmarking of LLM Agents (KDD)           | 2025     | 2D taxonomy: eval objectives x eval process           |
| From Language to Action (Springer)                        | 2026     | 68 datasets, 108 papers, 7 research questions         |

### 9.3 RAG Evaluation

| Framework                | Key Contribution                                  |
| ------------------------ | ------------------------------------------------- |
| RAGAS                    | Context relevance, answer relevance, faithfulness |
| RAGBench + TRACe         | 400M DeBERTa model competitive with LLM judges    |
| CRAG (Facebook Research) | 4,409 QA pairs; best LLM 34%, RAG 44%             |
| MIRAGE                   | 7,560 instances; noise vulnerability metrics      |
| FRAMES                   | Factuality + retrieval + reasoning unified eval   |
| GaRAGe                   | 2,366 questions; Relevance-Aware Factuality Score |

### 9.4 Anthropic's Evaluation Philosophy

**Responsible Scaling Policy (RSP) v3.0:**

- Capability assessments + safeguard assessments
- ASL levels (1-3+); evaluations every 4x compute jump and every 3 months
- Domains: CBRN, cybersecurity, autonomous capabilities

**Model-Written Evaluations:**

- Use LLMs to generate test data for specific behaviors
- 154 datasets created; found scale-adverse sycophancy
- Human validation achieves 90-100% label agreement

**Agent Evals Demystified (2026):**

- Three grader types: code-based (most reliable), model-based (calibrated), human (occasional)
- Key principles: isolated environments, avoid shared state, calibrate LLM judges against human experts
- Each dimension gets its own independent LLM grader

**Statistical rigor:**

- Report SEM with all evaluation scores
- Use power analysis to determine sample sizes
- Reduce within-question variance (multiple samples per question)
- 95% confidence intervals (mean +/- 1.96 SEM)

**Sources:**

- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- https://www-cdn.anthropic.com/e670587677525f28df69b59e5fb4c22cc5461a17.pdf
- https://anthropic.com/news/a-new-initiative-for-developing-third-party-model-evaluations

### 9.5 OpenAI's Evaluation Methodology

**Eval-driven development:**

1. Define objective
2. Collect dataset (synthetic + human-curated + production)
3. Define metrics
4. Run/compare
5. Continuously evaluate

**Three grader types:**

- Deterministic (match, includes, fuzzyMatch)
- Model-graded (LLM-as-judge with CoT)
- Human

**Evaluation flywheel:** Collect failure modes -> annotate -> build automated graders -> measure vs human baseline -> integrate into CI/CD

**Agent evals pattern:** Outcome goals (task completion) + Process goals (tool usage) + Style goals (conventions) + Efficiency goals (cost/tokens)

**Source:** https://developers.openai.com/api/docs/guides/evaluation-best-practices

---

## 10. Implementation Guidance for NutriBuddy

Based on this research, here is a recommended evaluation strategy for a nutrition AI assistant:

### Tier 1: Constraint-Based Safety Checks (Run Every Time)

- Encode "never events" from nutrition guidelines:
  - Caloric deficit >1000 kcal/day without medical supervision
  - Contradictions with known dietary reference intakes (DRIs)
  - Dangerous combination recommendations
- Decompose output into atomic claims and verify each against rule base
- Flag any violation for human review before delivery to user

### Tier 2: Groundedness Check (Run Every Time)

- If using RAG (e.g., USDA Food Data Central, NIH ODS, WHO guidelines): verify all claims against retrieved sources
- Track groundedness score (what % of claims are directly supported)
- Flag ungrounded or misgrounded claims for review

### Tier 3: Rubric-Based LLM-as-Judge (Run in CI/CD)

- Multi-dimensional rubric covering:
  - Accuracy against known guidelines (pass/fail per guideline referenced)
  - Safety: no contraindications missed
  - Completeness: all relevant factors addressed
  - Personalization: advice tailored to user's stated context
  - Conciseness: no filler
- Use jury of 3+ LLMs from different providers
- Calibrate against dietitian-annotated canary set monthly
- Target: per-criterion kappa >= 0.7 against dietitian consensus

### Tier 4: Human Expert Review (Periodic Deep Dives)

- Monthly calibration rounds with 3+ registered dietitians
- Score 30-50 diverse outputs on same rubric as Tier 3
- Measure LLJ-human agreement, adjust rubric if needed
- Quarterly adversarial testing (edge cases, multi-comorbidity scenarios)

### Tier 5: Real-World Outcomes (Quarterly)

- Track user engagement, satisfaction surveys
- A/B test specific advice changes
- Measure dietary adherence vs. baseline (if possible via self-report)
- Track safety incidents (user reports of adverse effects)

### Recommended Metrics Dashboard

| Metric                | Method                       | Target |
| --------------------- | ---------------------------- | ------ |
| Safety violation rate | Constraint-based check       | <0.1%  |
| Groundedness score    | NLI-based claim verification | >95%   |
| Guideline adherence   | Rubric LLM-as-judge          | >90%   |
| LLM-human kappa       | Monthly calibration          | >0.7   |
| User satisfaction     | Survey                       | >4.0/5 |
| Hallucination rate    | Claim decomposition + verify | <0.5%  |

---

## 11. Citations and References

### LLM-as-Judge

- Zheng et al. (2023). "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena." NeurIPS 2023. arXiv:2306.05685
- Zhu et al. (2024). "JudgeLM: Fine-tuned LLMs are Scalable Judges." ICLR 2025. arXiv:2310.17631
- EMNLP 2025 Survey. "From Generation to Judgment: Opportunities and Challenges of LLM-as-a-judge." arXiv:2411.16594
- arXiv:2604.23178. "Judging the Judges: A Systematic Evaluation of Bias Mitigation Strategies in LLM-as-a-Judge Pipelines."
- arXiv:2410.02736. "Justice or Prejudice? Quantifying Biases in LLM-as-a-Judge." ICLR 2025.
- arXiv:2505.17100. "Any Large Language Model Can Be a Reliable Judge: Debiasing with a Reasoning-based Bias Detector." NeurIPS 2025.
- arXiv:2602.02219. "Am I More Pointwise or Pairwise? Position Bias in Rubric-Based LLM-as-a-Judge."
- arXiv:2606.00093. "Agreement Metrics for LLM-as-Judge Evaluation: What to Report and Why."
- arXiv:2606.19544. "Reliability without Validity: Large-Scale Evaluation of LLM-as-a-Judge Models."
- arXiv:2407.18370. "Trust or Escalate: LLM Judges with Provable Guarantees for Human Agreement."

### Medical

- Singhal et al. (2024). "Towards Expert-Level Medical Question Answering with Large Language Models." Nature Medicine. arXiv:2305.09617
- Google Cloud. "Sharing Google's Med-PaLM 2 Medical Large Language Model." https://cloud.google.com/blog/topics/healthcare-life-sciences/sharing-google-med-palm-2-medical-large-language-model
- Hippocratic AI. "Real World Evaluation of Large Language Models in Healthcare (RWE-LLM)." medRxiv 2025. https://www.medrxiv.org/content/10.1101/2025.03.17.25324157v1
- Hippocratic AI. "Polaris 3.0." https://hippocraticai.com/polaris-3/
- arXiv:2505.23802. "MedHELM: Holistic Evaluation of LLMs for Medical Tasks."
- OpenReview CARE. "Co-cause Aware Jury Aggregation for Reliable LLM-as-Judge." ICLR 2026.
- arXiv:2604.25933. "MedJUDGE: Medical Judge Utility, Debiasing, Governance, and Evaluation."
- medRxiv 2025. "Human Evaluators vs. LLM-as-a-Judge: Toward Scalable, Real-World Evaluation of Clinical GenAI." https://www.medrxiv.org/content/10.1101/2025.10.27.25338910v1
- arXiv:2409.07314. "MEDIC: Comprehensive Evaluation of Leading Indicators for LLM Safety and Utility in Clinical Applications."
- medRxiv 2026. "EGDA: Evidence-Grounded Decision Authority." https://www.medrxiv.org/content/10.64898/2026.05.19.26353565v1
- medRxiv 2024. "CREOLA: A Framework to Assess Clinical Safety and Hallucination Rates of LLMs."
- PMC 2025. "MedGuard: Comprehensive Safety Evaluation Framework for Medical LLMs."
- PMC 2024. "AMEGA: Autonomous Medical Guideline Adherence Evaluation."
- Nature Medicine 2024. "A Toolbox for Surfacing Health Equity Harms and Biases in LLMs."
- Nature Digital Medicine 2025. "CSEDB: Clinical Safety-Effectiveness Dual-Track Benchmark."

### Legal

- Harvey AI. "BigLaw Bench." https://www.harvey.ai/blog/introducing-biglaw-bench
- Harvey AI. "Legal Agent Benchmark (LAB)." https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark
- Harvey AI. "BigLaw Bench: Hallucinations." https://www.harvey.ai/blog/biglaw-bench-hallucinations
- Harvey AI. "Evaluation Strategies." https://github.com/harveyai/harvey-labs/blob/main/docs/eval-strategies.md
- Stanford HAI (2024). "Hallucination-Free? Assessing the Reliability of Leading AI Legal Research Tools." https://law.stanford.edu/wp-content/uploads/2024/05/Legal_RAG_Hallucinations.pdf
- arXiv:2605.10186. "LegalCiteBench: Citation Retrieval and Verification."
- arXiv:2606.00898. "Citation Grounding: Evaluating Legal Citation Accuracy."
- arXiv:2606.18021. "LegalHalluLens: Typed Hallucination Profiles in Legal AI."
- arXiv:2601.15476. "Reliability by Design: False Citation Rate and Fabricated Fact Rate."
- arXiv:2606.21155. "Who Checks the Citations? Fabricated Citations in Court Filings."

### Financial

- arXiv:2510.15232. "FinTrust: Trustworthiness Evaluation for Financial LLMs."
- arXiv:2606.03918. "Hedge-Bench 1.0: Real-World Financial Agent Evaluation."
- ACM (2025). "FinResearchBench: Logic Tree-based Agent-as-a-Judge."
- arXiv:2602.22273. "FIRE Benchmark: Rubric-Based Financial LLM Evaluation."
- arXiv:2603.08262. "FinToolBench: Timeliness and Domain Alignment."
- arXiv:2606.03829. "BigFinanceBench: Workflow-Grounded Financial Evaluation."
- arXiv:2604.23837. "Heuristic Collapse in LLM Financial Advice."
- arXiv:2504.05862. "User Insensitivity to LLM Financial Advice Quality."
- FINRA (2026). "Annual Regulatory Oversight Report: Generative AI."
- NIST AI RMF 1.0.

### Nutrition

- MDPI Nutrients (2024). "Evaluation of ChatGPT Dietary Advice for College Students." https://www.mdpi.com/2072-6643/16/12/1939
- J. Clinical Medicine (2024). "Multi-Chatbot Nutrition Advice Evaluation." https://www.mdpi.com/2077-0383/13/24/7810
- MDPI Nutrients (2024). "ChatGPT and NCD Guidelines Evaluation." https://www.mdpi.com/2072-6643/16/4/469
- Frontiers in Nutrition (2026). "Med-Diet System: Clinical Expert Evaluation." https://www.frontiersin.org/journals/nutrition/articles/10.3389/fnut.2026.1826469/full
- MDPI Nutrients (2025). "Diet Quality Index-International for AI Meal Plans." https://www.mdpi.com/2072-6643/17/2/206
- Nature Scientific Reports (2024). "RD Exam Benchmark for LLMs." https://www.nature.com/articles/s41598-024-85003-w
- INLG 2025. "First RCT of LLM-Enhanced Nutrition Chatbot." https://aclanthology.org/2025.inlg-main.44.pdf
- JMIR (2025). "Llama 3 + RAG for Dietary Guidance." https://www.jmir.org/2025/1/e78625/
- MDPI Nutrients (2024). "MARS/ABACUS App Evaluation Scale." https://www.mdpi.com/2072-6643/16/15/2573

### Surveys and Frameworks

- arXiv:2503.16416. "Survey on Evaluation of LLM-based Agents." ACL 2026.
- Springer (2026). "From Benchmarks to Deployment: Comprehensive Review of Agentic AI Evaluation."
- KDD (2025). "Evaluation and Benchmarking of LLM Agents: A Survey."
- arXiv:2504.14891. "Comprehensive Survey of RAG Evaluation."
- Anthropic. "Responsible Scaling Policy v3.0." https://www-cdn.anthropic.com/e670587677525f28df69b59e5fb4c22cc5461a17.pdf
- Anthropic. "Demystifying Evals for AI Agents." https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic. "Model-Written Evaluations." https://www-cdn.anthropic.com/e4f69aacd8c0905030172bc6eb480c252ea7d6ad/model-written-evals.pdf
- Anthropic. "A New Initiative for Developing Third-Party Model Evaluations." https://anthropic.com/news/a-new-initiative-for-developing-third-party-model-evaluations
- OpenAI. "Evaluation Best Practices." https://developers.openai.com/api/docs/guides/evaluation-best-practices
- OpenAI. "Evaluation Flywheel." https://developers.openai.com/cookbook/examples/evaluation/building_resilient_prompts_using_an_evaluation_flywheel
