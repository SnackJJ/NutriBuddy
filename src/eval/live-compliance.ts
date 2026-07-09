#!/usr/bin/env npx tsx
// Live Compliance Eval（issue #40 / PRD v2 §4.2）。
//
// ⚠️  观测性 / 夜间运行 — NOT a CI gate.
//
// 与 CI-gating scripted eval（`npm run eval -- --strict`）不同，此 runner：
//   - 通过 live ModelAdapter + Turn Seam 运行选定的 eval case
//   - 记录合规信号（tool use / gate verdicts / typed final output / terminal outcomes）
//   - 结果独立于 CI 闸门报告 —— **不得让 CI 变红**
//
// 用法：
//   npm run eval:live                    # STUB 模式（框架自检，永绿）
//   npm run eval:live -- --live          # 使用真实模型（需 DEEPSEEK_API_KEY）
//   npm run eval:live -- --live --limit N  # 只跑前 N 条 case
//
// 合规信号定义：
//   toolUse     — 是否调用了期望的工具
//   gateVerdicts — 全部四个 checkpoint（input/tool/output/commit）的 gate 判定
//   typedOutput — 模型是否返回了结构化 TypedOutput（foodRefs + ruleRefs）
//   terminalOutcome — 终端状态（stopReason / steps / duration）

import {
  consumeTurn,
  turn,
  type AnyTurnEvent,
  type GateCheckpoint,
  type GateVerdict,
} from "../harness/turn";
import { Tracer } from "../harness/tracer";
import type {
  ModelAdapter,
  ToolHandler,
  StopReason,
  TypedOutput,
} from "../harness/types";
import type { EvalCase, EvalExpected } from "./types";
import type { InteractionStore } from "../lib/drugInteractions";
import { scoreHarness, EVAL_ERROR_PREFIX } from "./metrics";
import { loadEvalCases } from "./dataset";
import { DeepSeekAdapter } from "../harness/modelAdapter";

// ─── Compliance Signal Types ──────────────────────────────────────────────

/** Per-case tool-use compliance signal. */
export interface ToolUseSignal {
  readonly called: readonly string[];
  readonly expected: readonly string[];
  readonly missing: readonly string[];
  readonly compliant: boolean;
}

/** A single gate verdict observation from the Turn Seam event stream. */
export interface GateVerdictSignal {
  readonly checkpoint: GateCheckpoint;
  readonly verdict: GateVerdict;
  readonly checkName: string;
}

/** Structured typed-output compliance signal. */
export interface TypedOutputSignal {
  readonly returned: boolean;
  readonly hasFoodRefs: boolean;
  readonly hasRuleRefs: boolean;
}

/** Terminal outcome signal: what happened at the end of the turn. */
export interface TerminalOutcomeSignal {
  readonly stopReason: StopReason;
  readonly steps: number;
  readonly durationMs: number;
}

/** Compliance signals for a single eval case. */
export interface CaseComplianceSignals {
  readonly caseId: string;
  readonly response: string;
  readonly toolUse: ToolUseSignal;
  readonly gateVerdicts: readonly GateVerdictSignal[];
  readonly typedOutput: TypedOutputSignal;
  readonly terminalOutcome: TerminalOutcomeSignal;
  readonly passed: boolean;
  readonly violations: readonly string[];
}

/** Aggregated summary across all cases. */
export interface ComplianceSummary {
  readonly total: number;
  readonly toolComplianceRate: number;
  readonly gateBlockRate: number;
  readonly typedOutputRate: number;
  readonly terminalSuccessRate: number;
  readonly overallPassRate: number;
}

/** Full compliance report: per-case signals + aggregate summary. */
export interface ComplianceReport {
  readonly signals: readonly CaseComplianceSignals[];
  readonly summary: ComplianceSummary;
  renderText(): string;
}

interface TurnEventSignals {
  readonly toolCalls: string[];
  readonly gateVerdicts: GateVerdictSignal[];
  gateVerdictBlocks: number;
  steps: number;
}

const REPORT_WIDTH = 72;

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildToolUseSignal(
  expected: EvalExpected,
  called: readonly string[],
): ToolUseSignal {
  const expectedToolNames = expected.mustCallTools ?? [];

  return {
    called,
    expected: expectedToolNames,
    missing: expectedToolNames.filter((tool) => !called.includes(tool)),
    compliant: expectedToolNames.every((tool) => called.includes(tool)),
  };
}

function buildTypedOutputSignal(
  output: TypedOutput | undefined,
): TypedOutputSignal {
  if (!output) {
    return {
      returned: false,
      hasFoodRefs: false,
      hasRuleRefs: false,
    };
  }

  return {
    returned: true,
    hasFoodRefs: output.foodRefs.length > 0,
    hasRuleRefs: output.ruleRefs.length > 0,
  };
}

function createTurnEventSignals(): TurnEventSignals {
  return {
    toolCalls: [],
    gateVerdicts: [],
    gateVerdictBlocks: 0,
    steps: 0,
  };
}

function recordTurnEvent(signals: TurnEventSignals, event: AnyTurnEvent): void {
  if (event.type === "gate_verdict") {
    signals.gateVerdicts.push({
      checkpoint: event.checkpoint,
      verdict: event.verdict,
      checkName: event.checkName,
    });

    if (event.verdict === "block") {
      signals.gateVerdictBlocks++;
    }

    return;
  }

  if (event.type !== "step") {
    return;
  }

  const { agentEvent } = event;
  signals.steps = agentEvent.step;
  if (agentEvent.type === "act" && agentEvent.toolCall) {
    signals.toolCalls.push(agentEvent.toolCall.name);
  }
}

function countGateBlocks(gateVerdictBlocks: number, tracer: Tracer): number {
  return Math.max(gateVerdictBlocks, countTracerGateBlocks(tracer));
}

function countTracerGateBlocks(tracer: Tracer): number {
  return tracer.events().filter((event) => event.type === "gate_block").length;
}

// ─── Runner ───────────────────────────────────────────────────────────────

/**
 * Run selected eval cases through the live Turn Seam and record compliance
 * signals for tool use, gate verdicts, typed final output, and terminal outcomes.
 *
 * This is an **observational** runner — it does NOT gate CI.  Results are
 * reported separately from the CI-gating `npm run eval -- --strict` path.
 *
 * Reuses the same Turn Seam and scorer vocabulary as the CI harness runner
 * (`harness-runner.ts`), adding typed-output compliance and full gate verdict
 * collection.
 */
export async function runLiveComplianceEval(
  cases: readonly EvalCase[],
  adapter: ModelAdapter,
  tools: ReadonlyMap<string, ToolHandler>,
  interactionStore?: InteractionStore,
): Promise<ComplianceReport> {
  const signals: CaseComplianceSignals[] = [];

  for (const c of cases) {
    const tracer = new Tracer();
    const start = Date.now();
    const eventSignals = createTurnEventSignals();

    let reply = "";
    let steps = 0;
    let stopReason: StopReason = "end_turn";
    let typedOutput = buildTypedOutputSignal(undefined);

    const shouldRunGate =
      c.userContext !== undefined && interactionStore !== undefined;

    try {
      const result = await consumeTurn(
        turn(
          { tag: "utterance", content: c.query },
          {
            adapter,
            tracer,
            tools,
            userContext: shouldRunGate ? c.userContext : undefined,
            interactionStore: shouldRunGate ? interactionStore : undefined,
          },
        ),
        (event: AnyTurnEvent) => recordTurnEvent(eventSignals, event),
      );

      reply = result.reply;
      steps = result.steps;
      stopReason = result.stopReason;
      typedOutput = buildTypedOutputSignal(result.output);
    } catch (err) {
      reply = `${EVAL_ERROR_PREFIX}${String(err)}`;
      stopReason = "crash";
      steps = eventSignals.steps;
    }

    const durationMs = Date.now() - start;
    const gateBlocks = countGateBlocks(eventSignals.gateVerdictBlocks, tracer);

    const scored = scoreHarness(
      reply,
      eventSignals.toolCalls,
      c.expected,
      c.userContext,
      gateBlocks,
    );

    signals.push({
      caseId: c.id,
      response: reply,
      toolUse: buildToolUseSignal(c.expected, scored.toolCalls),
      gateVerdicts: eventSignals.gateVerdicts,
      typedOutput,
      terminalOutcome: {
        stopReason,
        steps,
        durationMs,
      },
      passed: scored.passed,
      violations: scored.violations,
    });
  }

  return buildComplianceReport(signals);
}

// ─── Report Builder ───────────────────────────────────────────────────────

function buildComplianceReport(
  signals: CaseComplianceSignals[],
): ComplianceReport {
  const total = signals.length;

  const toolCompliant = signals.filter((s) => s.toolUse.compliant).length;
  const gateBlocked = signals.filter((s) =>
    s.gateVerdicts.some((v) => v.verdict === "block"),
  ).length;
  const typedOutput = signals.filter((s) => s.typedOutput.returned).length;
  const terminalSuccess = signals.filter(
    (s) => s.terminalOutcome.stopReason === "end_turn",
  ).length;
  const passed = signals.filter((s) => s.passed).length;

  const summary: ComplianceSummary = {
    total,
    toolComplianceRate: total > 0 ? toolCompliant / total : 0,
    gateBlockRate: total > 0 ? gateBlocked / total : 0,
    typedOutputRate: total > 0 ? typedOutput / total : 0,
    terminalSuccessRate: total > 0 ? terminalSuccess / total : 0,
    overallPassRate: total > 0 ? passed / total : 0,
  };

  return {
    signals,
    summary,
    renderText() {
      return renderComplianceText(signals, summary);
    },
  };
}

function renderComplianceText(
  signals: readonly CaseComplianceSignals[],
  summary: ComplianceSummary,
): string {
  const lines: string[] = [];

  lines.push("═".repeat(REPORT_WIDTH));
  lines.push(
    "  NutriBuddy Live Compliance Eval (observational / non-CI-gating)",
  );
  lines.push("═".repeat(REPORT_WIDTH));
  lines.push("");

  // ─── Per-Case Compliance Signals ──────────────────────────────────────
  lines.push("─ Compliance Signals ─");
  lines.push("");
  lines.push(
    "  ID   ToolUse   GateBlk  TypedOut  Terminal   Pass   Violations",
  );
  lines.push(
    "  ──── ───────── ──────── ───────── ────────── ────── ──────────",
  );

  for (const s of signals) {
    lines.push(renderComplianceRow(s));
  }

  lines.push("");

  // ─── Summary ──────────────────────────────────────────────────────────
  lines.push("─ Compliance Summary ─");
  lines.push("");
  lines.push(`  Total cases:               ${summary.total}`);
  lines.push(
    `  Tool compliance rate:       ${formatRate(summary.toolComplianceRate)}`,
  );
  lines.push(
    `  Gate block rate:            ${formatRate(summary.gateBlockRate)}`,
  );
  lines.push(
    `  Typed output rate:          ${formatRate(summary.typedOutputRate)}`,
  );
  lines.push(
    `  Terminal success rate:      ${formatRate(summary.terminalSuccessRate)}`,
  );
  lines.push(
    `  Overall pass rate:          ${formatRate(summary.overallPassRate)}`,
  );
  lines.push("");
  lines.push("  ⚠️  Observational only — does NOT gate CI.");
  lines.push("");
  lines.push("═".repeat(REPORT_WIDTH));

  return lines.join("\n");
}

function renderComplianceRow(signal: CaseComplianceSignals): string {
  const tool = formatBooleanMark(signal.toolUse.compliant);
  const gateBlock = formatGateBlock(signal.gateVerdicts);
  const typed = formatTypedOutput(signal.typedOutput);
  const terminal = formatTerminalOutcome(signal.terminalOutcome);
  const pass = formatBooleanMark(signal.passed);
  const violations = signal.violations.length;

  return `  ${signal.caseId.padEnd(4)} ${tool.padEnd(9)} ${gateBlock.padEnd(8)} ${typed.padEnd(9)} ${terminal.padEnd(10)} ${pass.padEnd(6)} ${violations}`;
}

function formatBooleanMark(value: boolean): string {
  return value ? "✓" : "✗";
}

function formatGateBlock(verdicts: readonly GateVerdictSignal[]): string {
  if (verdicts.some((verdict) => verdict.verdict === "block")) {
    return "BLK";
  }
  return "—";
}

function formatTypedOutput(signal: TypedOutputSignal): string {
  if (!signal.returned) {
    return "✗";
  }

  let refs = "";
  if (signal.hasFoodRefs) {
    refs += "F";
  }
  if (signal.hasRuleRefs) {
    refs += "R";
  }

  return `✓${refs}`;
}

function formatTerminalOutcome(signal: TerminalOutcomeSignal): string {
  if (signal.stopReason === "end_turn") {
    return `${signal.steps}s`;
  }
  return signal.stopReason;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

/**
 * Stub adapter for offline framework validation.
 * Returns pre-canned responses so the framework can be tested without a live model.
 */
function stubAdapter(): ModelAdapter {
  return {
    generate: async () => ({
      content:
        "This is a simulated nutritional response for framework validation.",
      stop: true,
    }),
  };
}

/** Stub tools for offline testing. */
function stubTools(): Map<string, ToolHandler> {
  const handler: ToolHandler = async (args) => {
    const food = String(args.food ?? "");
    const canned: Record<string, string> = {
      "chicken breast":
        "chicken breast (100g): 165 kcal, 31g protein, 0g carbs",
      avocado: "avocado (medium, 150g): 240 kcal, 3g protein, 13g carbs",
      "white rice":
        "white rice, cooked (1 cup, 158g): 205 kcal, 4g protein, 45g carbs",
      salmon: "salmon (100g): 208 kcal, 20g protein, 0g carbs, rich in omega-3",
      egg: "large egg (50g): 72 kcal, 6g protein, 0.4g carbs",
      rice: "rice, cooked (1 cup, 158g): 205 kcal, 4g protein, 45g carbs",
    };

    const key = food.toLowerCase();
    for (const [k, v] of Object.entries(canned)) {
      if (key.includes(k)) return v;
    }
    return `${food}: unknown (no USDA data available)`;
  };

  return new Map([["search_food", handler]]);
}

/** Stub interaction store: returns empty. */
function stubInteractionStore(): InteractionStore {
  return { all: async () => [] };
}

function parseLimit(args: readonly string[]): number | undefined {
  const limitIdx = args.indexOf("--limit");

  if (limitIdx < 0 || limitIdx + 1 >= args.length) {
    return undefined;
  }

  return Number(args[limitIdx + 1]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const limit = parseLimit(args);

  console.log(
    live
      ? "Live Compliance Eval — LIVE mode (real model)\n"
      : "Live Compliance Eval — STUB mode (framework self-check, always green)\n",
  );

  const allCases = loadEvalCases();
  const cases = limit ? allCases.slice(0, limit) : allCases;
  console.log(`Running ${cases.length}/${allCases.length} eval cases.\n`);

  let adapter: ModelAdapter;
  let tools: ReadonlyMap<string, ToolHandler>;

  if (live) {
    adapter = new DeepSeekAdapter();
    tools = new Map<string, ToolHandler>();
  } else {
    adapter = stubAdapter();
    tools = stubTools();
  }

  const start = Date.now();
  const report = await runLiveComplianceEval(
    cases,
    adapter,
    tools,
    stubInteractionStore(),
  );
  const duration = Date.now() - start;

  console.log(report.renderText());
  console.log(`\nCompleted in ${duration}ms.\n`);

  // Always exit 0 — this is observational, NOT a CI gate.
  process.exit(0);
}

const invokedDirectly =
  process.argv[1]?.endsWith("live-compliance.ts") ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Live compliance eval failed:", err);
    process.exit(1);
  });
}
