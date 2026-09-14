"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage, WriteProposalData } from "@/harness/types";
import { extractSources, friendlyToolName } from "@/lib/chatHelpers";
import {
  indexCitations,
  resolveCitationChips,
  type CitationChip,
  type CitationIndexEntry,
  type WireCitation,
} from "@/lib/citationUi";
import type { DrugNutrientInteraction } from "@/lib/drugInteractions";
import {
  matchQualityLabel,
  projectProposalSafetyNotices,
  type ProposalSafetyNotice,
} from "@/lib/proposalSafety";
import {
  utteranceForCandidatePick,
  type ResolverCandidate,
  type ResolverMissProjection,
} from "@/lib/resolverMiss";
import {
  isRetryableStopReason,
  retryableMessage,
  retryableTitle,
  type RetryableTurnState,
} from "@/lib/retryableTurn";
import {
  isProposalStale,
  type ProposalUiStatus,
} from "@/lib/proposalLifecycle";
import { useSupabaseSession, authHeader } from "@/lib/useSupabaseSession";
import {
  beginTurn,
  completeTurn,
  readPendingTurn,
  recordEventSeq,
  replayUrl,
  type PendingTurn,
} from "@/lib/turnSession";
import { foldReplayedTurn, isTerminalEvent } from "@/lib/turnReplay";
import {
  CustomMealForm,
  type CustomMealFormValues,
} from "@/components/CustomMealForm";
import type { Session } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────

/** A message displayed in the chat UI.  Enriches the wire ChatMessage
 *  with UI-only fields for sources, tool calls, and gate status. */
interface DisplayMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Citation sources extracted from `[Source: …]` in the reply. */
  readonly sources?: readonly string[];
  /**
   * Evidence citations the gate verified (RFC 0011). Rendered as a titled link per
   * section: the heading is what makes an entry scannable, and the link is what
   * makes it checkable — a citation the reader cannot open is decoration.
   */
  readonly citations?: readonly CitationChip[];
  /** Tool calls made by the agent for this response. */
  readonly toolCalls?: readonly ToolCallEntry[];
  /** Whether the final reply was blocked by the post-gate. */
  readonly gateBlocked?: boolean;
  /** Post-gate violation reasons (if blocked). */
  readonly gateReasons?: readonly string[];
  /** The stopReason from the terminal event. */
  readonly stopReason?: string;
  /** Write-proposal payload (when stopReason is "write_proposal"). */
  readonly proposal?: WriteProposalData;
  /** Resolver miss projection (RFC 0004 §6.1). */
  readonly resolverMiss?: ResolverMissProjection;
  /** Proposal lifecycle status for retained cards (RFC 0004 §6.3). */
  readonly proposalStatus?: ProposalUiStatus;
}

interface ToolCallEntry {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result?: string;
}

interface StreamToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

interface StreamToolResult {
  readonly name: string;
  readonly result: string;
}

interface StreamAgentEvent {
  readonly type: "thought" | "act" | "observe";
  readonly step?: number;
  readonly content?: string;
  readonly toolCall?: StreamToolCall;
  readonly toolResult?: StreamToolResult;
}

interface StreamTerminalResult {
  readonly reply?: string;
  readonly steps?: number;
  readonly stopReason?: string;
  /** Typed output; its `citations` are the ones the gate verified. */
  readonly output?: { readonly citations?: readonly WireCitation[] } | null;
  readonly proposal?: WriteProposalData;
  readonly interactions?: readonly DrugNutrientInteraction[];
  readonly safetyNotices?: readonly ProposalSafetyNotice[];
  readonly resolverMiss?: ResolverMissProjection;
}

/** A streaming event from the /api/chat NDJSON stream (Turn Seam enriched). */
interface StreamEvent {
  readonly type: string;
  readonly step?: number;
  readonly content?: string;
  readonly toolCall?: StreamToolCall;
  readonly toolResult?: StreamToolResult;
  readonly agentEvent?: StreamAgentEvent;
  readonly reply?: string;
  readonly steps?: number;
  readonly stopReason?: string;
  readonly output?: unknown;
  readonly proposal?: WriteProposalData;
  readonly interactions?: readonly DrugNutrientInteraction[];
  readonly safetyNotices?: readonly ProposalSafetyNotice[];
  readonly resolverMiss?: ResolverMissProjection;
  readonly checkpoint?: string;
  readonly verdict?: string;
  readonly checkName?: string;
  readonly evidence?: string;
  /** Raw `turn_end` result: the typed output's citations live here. */
  readonly result?: StreamTerminalResult & { readonly output?: unknown };
  readonly error?: string;
  /** Route-level `turn_meta` frame: the turnId a refresh would resume (§5). */
  readonly turnId?: string;
  readonly schema?: string;
  /** Section titles and links for this turn's evidence (RFC 0011 §3.7). */
  readonly citations?: readonly CitationIndexEntry[];
  /** Event seq; route-level frames do not carry one. */
  readonly seq?: number;
  /** Event timestamp, used to date the turn being resumed. */
  readonly timestamp?: string;
  /** `turn_start` input, used to re-render the user's own message on resume. */
  readonly input?: { readonly tag?: string; readonly content?: string };
}

interface AssistantStreamState {
  content: string;
  toolCalls: ToolCallEntry[];
  stopReason: string;
  gateReasons: string[];
  /** Section id → title/link, from the turn's meta frame. */
  citationIndex: Map<string, CitationIndexEntry>;
  /** The citations that survived the gate, in the order the model gave them. */
  citations: WireCitation[];
  writeProposal?: WriteProposalData;
  interactions: DrugNutrientInteraction[];
  safetyNotices: ProposalSafetyNotice[];
  resolverMiss?: ResolverMissProjection;
}

interface AssistantStreamHandlers {
  readonly setCurrentTool: (tool: string | null) => void;
  readonly setPartialResponse: (content: string) => void;
}

function createAssistantStreamState(): AssistantStreamState {
  return {
    content: "",
    toolCalls: [],
    stopReason: "",
    gateReasons: [],
    citationIndex: new Map(),
    citations: [],
    interactions: [],
    safetyNotices: [],
    resolverMiss: undefined,
  };
}

/** Identity travels in the verified Authorization header (issue #48/#62/#65).
 *  /api/chat rejects missing sessions with 401 (issue #82). */
function chatHeaders(session: Session | null): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeader(session) };
}

/** Prefer caller fallback for machine status codes (401 "unauthorized"). */
async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  if (response.status === 401) {
    return fallback;
  }
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0
      ? body.error
      : fallback;
  } catch {
    return fallback;
  }
}

function parseStreamLine(line: string): StreamEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return undefined;
  }
}

async function readChatStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Streaming is not supported by your browser.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseStreamLine(line);
      if (event) {
        onEvent(event);
      }
    }
  }
}

function terminalResultFromEvent(
  event: StreamEvent,
): StreamTerminalResult | undefined {
  if (event.type === "turn_end") {
    // The wire type is structural and unchecked: narrow the one field the UI reads.
    const output = (event.result as { readonly output?: unknown } | undefined)?.output;
    return output === undefined
      ? event.result
      : { ...event.result, output: output as StreamTerminalResult["output"] };
  }

  if (event.type === "terminal") {
    // Route-level frame: the fields the UI reads, taken one by one rather than
    // by spreading the event, whose `output` is untyped on the wire.
    return {
      reply: event.reply,
      steps: event.steps,
      stopReason: event.stopReason,
      output: event.output as StreamTerminalResult["output"],
    };
  }

  return undefined;
}

function agentEventFromStreamEvent(
  event: StreamEvent,
): StreamAgentEvent | undefined {
  if (event.type === "step") {
    return event.agentEvent;
  }

  if (
    event.type === "thought" ||
    event.type === "act" ||
    event.type === "observe"
  ) {
    return {
      type: event.type,
      step: event.step,
      content: event.content,
      toolCall: event.toolCall,
      toolResult: event.toolResult,
    };
  }

  return undefined;
}

function applyAgentEvent(
  agentEvent: StreamAgentEvent,
  state: AssistantStreamState,
  handlers: AssistantStreamHandlers,
): void {
  switch (agentEvent.type) {
    case "thought":
      return;
    case "act":
      if (agentEvent.toolCall) {
        handlers.setCurrentTool(friendlyToolName(agentEvent.toolCall.name));
      }
      return;
    case "observe":
      if (agentEvent.toolResult) {
        state.toolCalls.push({
          name: agentEvent.toolResult.name,
          args: {},
          result: agentEvent.toolResult.result,
        });
        handlers.setCurrentTool(null);
      }

      if (agentEvent.content) {
        state.content = agentEvent.content;
        handlers.setPartialResponse(agentEvent.content);
      }
      return;
  }
}

function applyTerminalResult(
  event: StreamEvent,
  state: AssistantStreamState,
): void {
  const result = terminalResultFromEvent(event);
  if (!result) {
    return;
  }

  state.stopReason = result.stopReason ?? state.stopReason;

  if (result.reply) {
    state.content = result.reply;
  }

  // Only citations that survived the provenance check reach here: an entry the
  // gate stripped is not in `output.citations`, so the UI cannot show a source
  // the answer did not actually stand on.
  if (result.output?.citations) {
    state.citations = [...result.output.citations];
  }

  if (result.stopReason === "write_proposal" && result.proposal) {
    state.writeProposal = result.proposal;
  }

  if (result.interactions && result.interactions.length > 0) {
    state.interactions = [...result.interactions];
  }

  if (result.safetyNotices) {
    state.safetyNotices = [...result.safetyNotices];
  }

  if (result.resolverMiss) {
    state.resolverMiss = result.resolverMiss;
  }
}

function applyAssistantStreamEvent(
  event: StreamEvent,
  state: AssistantStreamState,
  handlers: AssistantStreamHandlers,
): void {
  if (event.type === "gate_verdict") {
    if (event.verdict === "block" && event.checkpoint === "output") {
      state.gateReasons.push(
        `${event.checkName ?? "output_gate"}: ${event.evidence ?? "blocked"}`,
      );
    }
    return;
  }

  const agentEvent = agentEventFromStreamEvent(event);
  if (agentEvent) {
    applyAgentEvent(agentEvent, state, handlers);
    return;
  }

  applyTerminalResult(event, state);
}

// ─── Sub-components ────────────────────────────────────────────────────

/** Shown when there are no messages yet. */
function EmptyState({
  onSelectPrompt,
}: {
  onSelectPrompt: (q: string) => void;
}) {
  const suggestions = [
    "How much protein is in a chicken breast?",
    "What foods are rich in vitamin D?",
    "Suggest a balanced meal plan for today",
    "Are there interactions between warfarin and leafy greens?",
  ];

  return (
    <div className="flex flex-col items-center justify-center px-4 py-20 text-center">
      {/* Icon */}
      <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
        <svg
          className="h-7 w-7 text-blue-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
          />
        </svg>
      </div>

      <h2 className="mb-2 text-xl font-semibold text-gray-900">
        Welcome to NutriBuddy
      </h2>
      <p className="mb-8 max-w-md text-sm leading-relaxed text-gray-500">
        Your personal AI nutrition assistant. Ask about food nutrition, meal
        planning, dietary guidelines, or get evidence-based answers to your
        nutrition questions.
      </p>

      <div className="grid w-full max-w-md gap-2">
        {suggestions.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onSelectPrompt(q)}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-left text-sm text-gray-600 transition hover:border-blue-300 hover:text-blue-700 hover:shadow-sm"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Animated "thinking" indicator shown while waiting for the first event. */
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-2">
      <span className="flex gap-1">
        <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:300ms]" />
      </span>
      <span className="text-sm text-gray-500">Thinking…</span>
    </div>
  );
}

/** Banner showing the current tool being executed. */
function ToolBanner({ tool }: { tool: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5">
      <svg
        className="h-4 w-4 animate-spin text-blue-600"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <span className="text-sm font-medium text-blue-700">{tool}</span>
    </div>
  );
}

/** A single chat message bubble. */
function MessageBubble({
  message,
  streaming = false,
}: {
  message: DisplayMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] sm:max-w-[75%] ${isUser ? "order-1" : ""}`}>
        {/* Bubble */}
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "rounded-br-md bg-blue-600 text-white"
              : "rounded-bl-md bg-white text-gray-900 shadow-sm ring-1 ring-gray-200"
          }`}
        >
          <p className="whitespace-pre-wrap break-words">
            {message.content || (
              <span className="italic text-gray-400">
                {message.gateBlocked
                  ? "Response blocked — see below for details."
                  : "No response generated."}
              </span>
            )}
          </p>
          {streaming && (
            <span className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-current align-text-bottom" />
          )}
        </div>

        {/* Retained proposal lifecycle card (committed / voided / stale) */}
        {message.proposal && message.proposalStatus && (
          <div className="mt-2">
            <ProposalCard
              proposal={message.proposal}
              safetyNotices={[]}
              status={message.proposalStatus}
              onConfirm={() => undefined}
              onReject={() => undefined}
              confirming={false}
            />
          </div>
        )}

        {/* Citation sources */}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.sources.map((src) => (
              <span
                key={src}
                className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-200"
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                Source: {src}
              </span>
            ))}
          </div>
        )}

        {/* Verified evidence citations (RFC 0011) */}
        {message.citations && message.citations.length > 0 && (
          <div className="mt-2 space-y-1">
            <p className="text-xs font-medium text-gray-500">Evidence</p>
            <ul className="flex flex-col gap-1">
              {message.citations.map((citation) => (
                <li key={citation.sectionId} className="text-xs text-gray-600">
                  {citation.url ? (
                    <a
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-start gap-1 rounded text-blue-700 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-600"
                    >
                      <svg
                        className="mt-0.5 h-3 w-3 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13.5 6H6.75A1.75 1.75 0 005 7.75v9.5c0 .966.784 1.75 1.75 1.75h9.5A1.75 1.75 0 0018 17.25V10.5M15 3h6v6M21 3l-9 9"
                        />
                      </svg>
                      <span>{citation.heading}</span>
                    </a>
                  ) : (
                    // No link rather than a dead one: the citation is still
                    // verified evidence, and an entry that cannot be opened is
                    // not a reason to hide it.
                    <span>{citation.heading}</span>
                  )}
                  <span className="ml-1 text-gray-400">({citation.docVersion})</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Collapsed tool calls (click to expand) */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.toolCalls.map((tc, i) => (
              <details key={i} className="group text-xs">
                <summary className="cursor-pointer text-gray-400 hover:text-gray-600">
                  <span className="inline-flex items-center gap-1">
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    {friendlyToolName(tc.name)}
                  </span>
                </summary>
                {tc.result && (
                  <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-gray-50 p-2 text-xs text-gray-600 whitespace-pre-wrap">
                    {tc.result}
                  </pre>
                )}
              </details>
            ))}
          </div>
        )}

        {/* Gate blocked warning */}
        {message.gateBlocked && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <p className="font-medium">
              ⚠️ Response blocked by safety constraints
            </p>
            {message.gateReasons && message.gateReasons.length > 0 && (
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {message.gateReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Retry affordance that preserves the original utterance (RFC 0004 §6.2). */
function RetryableError({
  state,
  onRetry,
  disabled,
}: {
  state: RetryableTurnState;
  onRetry: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 shadow-sm"
      data-retryable-reason={state.reason}
      role="alert"
    >
      <p className="font-semibold">{retryableTitle(state.reason)}</p>
      <p className="mt-1 text-xs text-red-800/90">{retryableMessage(state)}</p>
      <p className="mt-2 truncate text-xs text-red-700/80">
        Input kept: “{state.utterance}”
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={onRetry}
        className="mt-3 min-h-[44px] w-full rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50 sm:w-auto"
        data-retry-button="true"
      >
        Retry same input
      </button>
    </div>
  );
}

/** Clickable resolver candidates (RFC 0004 §6.1) — no free-form retype. */
function CandidatePicker({
  miss,
  onPick,
  disabled,
}: {
  miss: ResolverMissProjection;
  onPick: (candidate: ResolverCandidate) => void;
  disabled?: boolean;
}) {
  const quality = matchQualityLabel(miss.matchType);
  return (
    <div
      className="rounded-xl border border-status-warning/40 bg-status-warning/10 p-4 shadow-sm"
      data-resolver-miss={miss.matchType}
    >
      <p className="text-sm font-semibold text-amber-950">
        {miss.matchType === "miss_ambiguous"
          ? "Multiple matches — pick one"
          : miss.matchType === "miss_unknown"
            ? "No catalog match"
            : "Uncertain match"}
      </p>
      <p className="mt-1 text-xs text-amber-900/90">{miss.message}</p>
      {quality && (
        <p
          className="mt-2 inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900"
          data-match-quality={quality.kind}
        >
          {quality.label} ({miss.matchType})
        </p>
      )}
      {miss.candidates.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {miss.candidates.map((c) => (
            <li key={c.foodId}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(c)}
                className="min-h-[44px] w-full rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-left text-sm font-medium text-amber-950 transition hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                data-candidate-id={c.foodId}
              >
                <span className="font-semibold">{c.foodName}</span>
                {c.matchScore !== undefined && (
                  <span className="ml-2 text-xs text-amber-700">
                    score {c.matchScore}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-amber-900">
          Try another name, or use a custom / recipe path when available. No web
          search.
        </p>
      )}
    </div>
  );
}

/** Write-proposal confirmation card (issue #39 / mobile thumb targets #83).
 *  RFC 0004 §6.1 / §6.3 / §6.4: match quality, lifecycle, safety before confirm. */
function ProposalCard({
  proposal,
  safetyNotices,
  status = "pending",
  onConfirm,
  onReject,
  onEditPortion,
  confirming,
}: {
  proposal: WriteProposalData;
  safetyNotices: readonly ProposalSafetyNotice[];
  status?: ProposalUiStatus;
  onConfirm: (feedback?: string) => void;
  onReject: () => void;
  /** True edit: supersede with a new proposal (not optional note). */
  onEditPortion?: (portionG: number) => void;
  confirming: boolean;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [editPortion, setEditPortion] = useState(String(proposal.portionG));
  const quality = matchQualityLabel(proposal.matchType);
  const hasSafety = safetyNotices.length > 0;
  const stale =
    status === "stale" ||
    (status === "pending" && isProposalStale(proposal.createdAt));
  const interactive = status === "pending" && !stale;
  const statusLabel = stale
    ? "stale"
    : status === "committed"
      ? "committed"
      : status === "voided"
        ? "voided"
        : "pending";

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        stale
          ? "border-gray-300 bg-gray-50 opacity-90"
          : status === "committed"
            ? "border-green-200 bg-green-50"
            : status === "voided"
              ? "border-gray-200 bg-gray-50 opacity-80"
              : hasSafety
                ? "border-amber-300 bg-amber-50"
                : "border-blue-200 bg-blue-50"
      }`}
      data-proposal-status={statusLabel}
    >
      <div className="mb-3 flex items-center gap-2">
        <svg
          className={`h-5 w-5 shrink-0 ${hasSafety ? "text-amber-700" : "text-blue-600"}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        <span
          className={`text-sm font-semibold ${
            stale
              ? "text-gray-700"
              : status === "committed"
                ? "text-green-900"
                : hasSafety
                  ? "text-amber-900"
                  : "text-blue-800"
          }`}
        >
          {stale
            ? "Proposal expired"
            : status === "committed"
              ? "Meal logged"
              : status === "voided"
                ? "Proposal cancelled"
                : "Confirm Meal Log"}
        </span>
      </div>

      {stale && (
        <p className="mb-2 text-xs text-gray-600" data-stale-notice="true">
          This proposal is older than 30 minutes or no longer committable.
          Generate a new proposal to continue.
        </p>
      )}

      <div
        className={`mb-4 space-y-1 text-sm ${hasSafety ? "text-amber-950" : "text-blue-900"}`}
      >
        <p>
          <span className="font-medium">{proposal.foodName}</span> —{" "}
          {proposal.portionG}g ({proposal.mealType})
        </p>
        {proposal.canonicalName &&
          proposal.canonicalName !== proposal.foodName && (
            <p className="text-xs opacity-80">
              Catalog: {proposal.canonicalName}
            </p>
          )}
        {quality && (
          <p
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
              quality.kind === "estimated"
                ? "bg-yellow-100 text-yellow-900"
                : "bg-orange-100 text-orange-900"
            }`}
            data-match-quality={quality.kind}
          >
            {quality.label}
            {proposal.matchType ? ` (${proposal.matchType})` : ""}
          </p>
        )}
        <div
          className={`flex flex-wrap gap-x-4 gap-y-0.5 text-xs ${
            quality?.kind === "estimated"
              ? "text-amber-800/80"
              : hasSafety
                ? "text-amber-800"
                : "text-blue-700"
          }`}
        >
          {proposal.kcal !== undefined && <span>{proposal.kcal} kcal</span>}
          {proposal.proteinG !== undefined && (
            <span>{proposal.proteinG}g protein</span>
          )}
          {proposal.fatG !== undefined && <span>{proposal.fatG}g fat</span>}
          {proposal.carbsG !== undefined && (
            <span>{proposal.carbsG}g carbs</span>
          )}
        </div>
        {proposal.nutritionSource && (
          <p className="text-xs opacity-70">
            Source: {proposal.nutritionSource}
          </p>
        )}
        {hasSafety && (
          <div
            className="mt-2 space-y-1.5 rounded-lg border border-amber-400 bg-amber-100/80 p-3"
            role="status"
            aria-live="polite"
            data-safety-notices="true"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-950">
              Review before confirm
            </p>
            <ul className="space-y-1 text-xs text-amber-950">
              {safetyNotices.map((notice, i) => (
                <li key={`${notice.kind}-${notice.detail}-${i}`}>
                  <span className="font-medium">{notice.title}</span>
                  {": "}
                  {notice.detail}
                  {notice.severity === "high"
                    ? " — high severity"
                    : notice.severity === "moderate"
                      ? " — moderate"
                      : " — low"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {interactive && (
        <>
          {/* Thumb-reach: stacked full-width actions on phone, row on sm+ */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <button
              type="button"
              onClick={() => onConfirm(showFeedback ? feedback : undefined)}
              disabled={confirming}
              className="min-h-[44px] w-full rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:min-h-0 sm:rounded-lg sm:py-2 sm:text-sm"
            >
              {confirming ? "Confirming…" : "✓ Confirm"}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={confirming}
              className="min-h-[44px] w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-base font-medium text-gray-700 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:min-h-0 sm:rounded-lg sm:py-2 sm:text-sm"
            >
              ✗ Reject
            </button>
            {!showFeedback && (
              <button
                type="button"
                onClick={() => setShowFeedback(true)}
                disabled={confirming}
                className="min-h-[44px] w-full rounded-xl px-2 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 sm:min-h-0 sm:w-auto sm:text-xs"
              >
                + Add optional note
              </button>
            )}
            {onEditPortion && !showEdit && (
              <button
                type="button"
                onClick={() => setShowEdit(true)}
                disabled={confirming || !proposal.foodId}
                className="min-h-[44px] w-full rounded-xl px-2 py-2 text-sm font-medium text-blue-700 hover:text-blue-900 disabled:opacity-50 sm:min-h-0 sm:w-auto sm:text-xs"
                data-edit-portion="true"
              >
                Edit portion (new proposal)
              </button>
            )}
          </div>

          {showFeedback && (
            <div className="mt-3 space-y-2">
              <label className="block text-xs font-medium text-blue-800">
                Optional note (does not change logged fields)
              </label>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="e.g. felt full, rough estimate…"
                rows={2}
                disabled={confirming}
                className="min-h-[44px] w-full resize-none rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-base placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 sm:text-sm"
              />
            </div>
          )}

          {showEdit && onEditPortion && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="block flex-1 text-xs font-medium text-blue-800">
                New portion (g)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={editPortion}
                  onChange={(e) => setEditPortion(e.target.value)}
                  disabled={confirming}
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  data-edit-portion-input="true"
                />
              </label>
              <button
                type="button"
                disabled={confirming}
                onClick={() => {
                  const n = Number(editPortion);
                  if (!Number.isFinite(n) || n <= 0) return;
                  onEditPortion(n);
                }}
                className="min-h-[44px] rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                Apply as new proposal
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────

interface TodaySnapshot {
  readonly date: string;
  readonly consumed: {
    readonly kcal: number;
    readonly proteinG: number;
    readonly fatG: number;
    readonly carbsG: number;
  };
  readonly remaining: {
    readonly kcal: number | null;
    readonly proteinG: number | null;
    readonly fatG: number | null;
    readonly carbsG: number | null;
  };
  readonly mealCount: number;
}

function TodayBar({
  data,
  expanded,
  onToggle,
}: {
  data: TodaySnapshot | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="shrink-0 border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur"
      data-today-bar="true"
    >
      <button
        type="button"
        onClick={onToggle}
        className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 text-left text-xs text-gray-700"
      >
        <span className="font-semibold text-gray-900">Today</span>
        {data ? (
          <span className="truncate">
            {Math.round(data.consumed.kcal)} kcal
            {data.remaining.kcal !== null &&
              ` · ${Math.round(data.remaining.kcal)} left`}
            {" · "}
            P {Math.round(data.consumed.proteinG)}g
            {data.remaining.proteinG !== null &&
              ` (${Math.round(data.remaining.proteinG)} left)`}
          </span>
        ) : (
          <span className="text-gray-400">Loading…</span>
        )}
        <span className="text-gray-400">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && data && (
        <div className="mx-auto mt-2 grid max-w-3xl grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {(
            [
              ["kcal", data.consumed.kcal, data.remaining.kcal],
              ["protein", data.consumed.proteinG, data.remaining.proteinG],
              ["fat", data.consumed.fatG, data.remaining.fatG],
              ["carbs", data.consumed.carbsG, data.remaining.carbsG],
            ] as const
          ).map(([label, c, r]) => (
            <div
              key={label}
              className="rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5"
            >
              <div className="font-medium capitalize text-gray-800">{label}</div>
              <div>
                {Math.round(c)}
                {r !== null ? ` / rem ${Math.round(r)}` : ""}
              </div>
            </div>
          ))}
          <div className="col-span-2 text-gray-500 sm:col-span-4">
            {data.mealCount} meals · {data.date}
          </div>
        </div>
      )}
    </div>
  );
}

/** A terminal event ends the turn: `turn_end` is the seam's own, `terminal` the
 *  route-level frame that follows it (RFC 0008 §5). */
function isTerminalStreamEvent(event: StreamEvent): boolean {
  return isTerminalEvent(event.type);
}

/**
 * Folds a finished (or interrupted) turn's stream state into the message the
 * user sees.
 *
 * Shared by the live utterance path and the replay path so a turn that survived
 * a refresh renders exactly like one that did not (RFC 0008 §5).
 */
function assistantMessageFromStreamState(
  state: AssistantStreamState,
  options: { readonly utterance: string },
): DisplayMessage | undefined {
  const hasSomething =
    state.content ||
    state.stopReason === "gate_blocked" ||
    state.stopReason === "write_proposal" ||
    state.resolverMiss ||
    isRetryableStopReason(state.stopReason);

  if (!hasSomething) {
    return undefined;
  }

  const { cleanText, sources } = extractSources(state.content);

  return {
    role: "assistant",
    content:
      cleanText ||
      state.content ||
      (state.resolverMiss
        ? state.resolverMiss.message
        : isRetryableStopReason(state.stopReason)
          ? retryableMessage({
              utterance: options.utterance,
              reason: state.stopReason,
            })
          : "Write proposal awaiting confirmation."),
    sources: sources.length > 0 ? sources : undefined,
    citations:
      state.citations.length > 0
        ? [...resolveCitationChips(state.citations, state.citationIndex)]
        : undefined,
    toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    gateBlocked: state.stopReason === "gate_blocked",
    gateReasons: state.gateReasons.length > 0 ? state.gateReasons : undefined,
    stopReason: state.stopReason || undefined,
    proposal: state.writeProposal,
    resolverMiss: state.resolverMiss,
  };
}

/**
 * The live/replay stream callback, plus the client's turn bookkeeping.
 *
 * `turn_meta` registers the turn before its first event, every seq advances the
 * high-water mark, and the terminal clears it — so anything still registered
 * after a reload means a turn was interrupted (RFC 0008 §5).
 */
function trackedStreamHandler(
  streamState: AssistantStreamState,
  handlers: AssistantStreamHandlers,
  failureMessage: string,
): (event: StreamEvent) => void {
  // The turn this handler is watching. It comes from turn_meta, which the route
  // sends before the first event; seeding it from storage instead would let a
  // pre-assembly failure frame clear a *different* turn's resumable entry.
  let turnId: string | undefined;

  return (event) => {
    if (event.type === "error") {
      // The pump has given up on this turn, so there is nothing left to resume.
      completeTurn(window.sessionStorage);
      throw new Error(event.error ?? failureMessage);
    }

    if (event.type === "turn_meta") {
      turnId = event.turnId ?? turnId;
      if (turnId) beginTurn(window.sessionStorage, turnId);
      // The index arrives once per turn, from the same server-side load the
      // evidence set came from; resolving ids anywhere else would be a second
      // source of truth for what a citation points at.
      streamState.citationIndex = indexCitations(event.citations ?? []);
      return;
    }

    if (typeof event.seq === "number" && turnId) {
      recordEventSeq(window.sessionStorage, turnId, event.seq);
    }

    if (isTerminalStreamEvent(event)) {
      completeTurn(window.sessionStorage);
    }

    applyAssistantStreamEvent(event, streamState, handlers);
  };
}

/** How often a resumed turn asks the server for what is new (§3.5). */
const RESUME_POLL_MS = 1000;
/**
 * How long a reloaded page keeps waiting for a terminal event.
 *
 * A turn older than this is one whose terminal write was dropped (or whose
 * instance was killed) rather than one still in flight, so waiting longer only
 * locks the composer on every reload. The number is an assumption about the
 * deployed function limit — nothing in the repository binds the two.
 */
const RESUME_MAX_TURN_AGE_MS = 300_000;
/**
 * Runaway guard only: derived from the deadline so it can never fire first. An
 * earlier fixed cap (90) abandoned live turns at 90s and invited a duplicate
 * proposal.
 */
const RESUME_POLL_LIMIT = Math.ceil(RESUME_MAX_TURN_AGE_MS / RESUME_POLL_MS);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ChatPage() {
  const { session, loading: sessionLoading, configured } = useSupabaseSession();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [partialResponse, setPartialResponse] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<TodaySnapshot | null>(null);
  const [todayExpanded, setTodayExpanded] = useState(false);
  const [pendingProposal, setPendingProposal] =
    useState<WriteProposalData | null>(null);
  const [pendingSafetyNotices, setPendingSafetyNotices] = useState<
    readonly ProposalSafetyNotice[]
  >([]);
  const [pendingResolverMiss, setPendingResolverMiss] =
    useState<ResolverMissProjection | null>(null);
  const [retryable, setRetryable] = useState<RetryableTurnState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll when new content appears
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const refreshToday = useCallback(async () => {
    if (!session) {
      setToday(null);
      return;
    }
    try {
      const res = await fetch("/api/today", {
        headers: authHeader(session),
      });
      if (!res.ok) return;
      const body = (await res.json()) as TodaySnapshot;
      setToday(body);
    } catch {
      // TodayBar is best-effort; chat still works.
    }
  }, [session]);

  useEffect(() => {
    void refreshToday();
  }, [refreshToday]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, partialResponse, currentTool, pendingProposal, scrollToBottom]);

  // Auto-resize the textarea (single row, no manual resize)
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [input]);

  /** Build a flat ChatMessage[] history from DisplayMessage[] for the API. */
  const buildHistory = useCallback(
    (msgs: readonly DisplayMessage[]): readonly ChatMessage[] =>
      msgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    [],
  );

  /** Drive one free-text turn (also used by candidate pick — no retype). */
  const runUtteranceTurn = useCallback(
    async (trimmed: string, priorMessages: readonly DisplayMessage[]) => {
      if (!session || streaming || sessionLoading) return;

      setInput("");
      setStreaming(true);
      setError(null);
      setCurrentTool(null);
      setPartialResponse("");
      setPendingProposal(null);
      setPendingResolverMiss(null);
      setRetryable(null);

      const userMsg: DisplayMessage = {
        role: "user",
        content: trimmed,
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const history = buildHistory(priorMessages);
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: chatHeaders(session),
          body: JSON.stringify({ message: trimmed, history }),
        });

        if (!response.ok) {
          const fallback =
            response.status === 401
              ? "Session expired or missing. Sign in via Profile and try again."
              : "Failed to get a response. Please try again.";
          const detail = await responseErrorMessage(response, fallback);
          setError(detail);
          // RFC 0004 §6.2: keep input — offer retry instead of blank box.
          setInput(trimmed);
          setRetryable({
            utterance: trimmed,
            reason: "http_error",
            detail,
          });
          return;
        }

        const streamState = createAssistantStreamState();
        await readChatStream(
          response,
          trackedStreamHandler(
            streamState,
            { setCurrentTool, setPartialResponse },
            "An unexpected error occurred.",
          ),
        );

        if (
          streamState.content ||
          streamState.stopReason === "gate_blocked" ||
          streamState.stopReason === "write_proposal" ||
          streamState.resolverMiss ||
          isRetryableStopReason(streamState.stopReason)
        ) {
          const assistantMsg = assistantMessageFromStreamState(streamState, {
            utterance: trimmed,
          });
          if (assistantMsg) {
            setMessages((prev) => [...prev, assistantMsg]);
          }

          if (streamState.writeProposal) {
            setPendingProposal(streamState.writeProposal);
            setPendingSafetyNotices(
              streamState.safetyNotices.length > 0
                ? streamState.safetyNotices
                : projectProposalSafetyNotices(
                    streamState.writeProposal,
                    streamState.interactions,
                  ),
            );
          }

          if (streamState.resolverMiss) {
            setPendingResolverMiss(streamState.resolverMiss);
          }

          if (isRetryableStopReason(streamState.stopReason)) {
            setInput(trimmed);
            setRetryable({
              utterance: trimmed,
              reason: streamState.stopReason,
            });
          }
        }

        setPartialResponse("");
        setCurrentTool(null);
      } catch (err) {
        const detail =
          err instanceof Error
            ? err.message
            : "Network error. Please try again.";
        setError(detail);
        setInput(trimmed);
        setRetryable({
          utterance: trimmed,
          reason: "network",
          detail,
        });
      } finally {
        setStreaming(false);
      }
    },
    [session, streaming, sessionLoading, buildHistory],
  );

  /**
   * Pick up a turn that a reload interrupted (RFC 0008 §5, acceptance D4).
   *
   * Two phases, because the server keeps producing the turn after the client
   * left (§3.5):
   *   1. replay the whole turn from the beginning — that is what carries
   *      `turn_start.input`, so the user's own message is rendered instead of an
   *      answer with no question above it;
   *   2. keep asking for what is new (`since=lastSeq`) until the terminal event
   *      lands, so a still-running turn completes in front of the user.
   */
  const resumeInterruptedTurn = useCallback(
    async (pending: PendingTurn) => {
      const storage = window.sessionStorage;
      setStreaming(true);
      setError(null);

      const streamState = createAssistantStreamState();
      const handlers = { setCurrentTool, setPartialResponse };
      let userText: string | undefined;
      let sawTerminal = false;
      let lastSeq = pending.lastSeq;
      let startedAtMs: number | undefined;

      /** Returns false when the turn is not this user's (404) any more. */
      const consume = async (url: string): Promise<boolean> => {
        const response = await fetch(url, { headers: chatHeaders(session) });
        if (response.status === 404) return false;
        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(
              response,
              "Could not restore the interrupted turn.",
            ),
          );
        }

        const replayed: StreamEvent[] = [];
        await readChatStream(response, (event) => {
          replayed.push(event);
          if (typeof event.seq === "number") {
            recordEventSeq(storage, pending.turnId, event.seq);
          }
          applyAssistantStreamEvent(event, streamState, handlers);
        });

        // The fold owns the rules that decide whether this turn comes back, so
        // they are testable outside a browser (src/lib/turnReplay.ts).
        const folded = foldReplayedTurn(replayed);
        if (folded.userText) userText = folded.userText;
        if (folded.startedAtMs) startedAtMs = folded.startedAtMs;
        if (folded.lastSeq !== undefined) lastSeq = folded.lastSeq;
        if (folded.sawTerminal) sawTerminal = true;

        return true;
      };

      try {
        const first = await consume(replayUrl(pending.turnId));
        if (!first) {
          // Gone, or never ours: nothing to resume, and no reason to keep the
          // entry around for the next reload.
          completeTurn(storage);
          return;
        }

        setMessages((prev) =>
          userText ? [...prev, { role: "user", content: userText }] : prev,
        );

        // A turn cannot outlive the platform's own function limit, so a row that
        // is older than that will never be finalized (its terminal write was
        // dropped, the instance was killed, …). Without this bound the tab would
        // replay and poll for the same dead turn on every single reload.
        const deadline =
          (startedAtMs ?? Date.now()) + RESUME_MAX_TURN_AGE_MS;

        let polls = 0;
        while (!sawTerminal && polls < RESUME_POLL_LIMIT && Date.now() < deadline) {
          polls += 1;
          await sleep(RESUME_POLL_MS);
          if (!(await consume(replayUrl(pending.turnId, lastSeq)))) {
            completeTurn(storage);
            return;
          }
        }

        // Either way the entry goes: a turn that reached its terminal is done,
        // and one that outlived every plausible lifetime never will.
        completeTurn(storage);
        if (!sawTerminal) {
          setError("That answer stopped before it finished.");
          if (userText) {
            // Same treatment as a live turn that ends without an answer
            // (RFC 0004 §6.2): keep the input and offer a retry.
            setInput(userText);
            setRetryable({ utterance: userText, reason: "aborted" });
          }
        }

        const assistantMsg = assistantMessageFromStreamState(streamState, {
          utterance: userText ?? "",
        });
        if (assistantMsg) {
          setMessages((prev) => [...prev, assistantMsg]);
        }

        // The action surface has to be restored too, not just the text: a
        // proposal whose card never renders is a meal the user cannot log.
        if (streamState.writeProposal) {
          setPendingProposal(streamState.writeProposal);
          setPendingSafetyNotices(
            streamState.safetyNotices.length > 0
              ? streamState.safetyNotices
              : projectProposalSafetyNotices(
                  streamState.writeProposal,
                  streamState.interactions,
                ),
          );
        }
        if (streamState.resolverMiss) {
          setPendingResolverMiss(streamState.resolverMiss);
        }
        if (isRetryableStopReason(streamState.stopReason) && userText) {
          setRetryable({ utterance: userText, reason: streamState.stopReason });
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not restore the interrupted turn.",
        );
      } finally {
        setStreaming(false);
        setPartialResponse("");
        setCurrentTool(null);
      }
    },
    [session],
  );

  const resumingRef = useRef(false);

  useEffect(() => {
    if (sessionLoading || !session || resumingRef.current) return;
    const pending = readPendingTurn(window.sessionStorage);
    if (!pending) return;

    // Once per mount: a second attempt would replay the same events on top of
    // the messages the first one already rendered.
    resumingRef.current = true;
    void resumeInterruptedTurn(pending);
  }, [sessionLoading, session, resumeInterruptedTurn]);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming || sessionLoading) return;

    if (!session) {
      setError("Sign in required. Open Profile to sign in, then return here.");
      return;
    }

    await runUtteranceTurn(trimmed, messages);
  }, [
    input,
    streaming,
    sessionLoading,
    session,
    messages,
    runUtteranceTurn,
  ]);

  const handleRetry = useCallback(async () => {
    if (!retryable || streaming) return;
    const text = retryable.utterance;
    setRetryable(null);
    setError(null);
    // Drop the failed user (and trailing assistant) bubble so retry does not
    // duplicate history for the model or the UI (Codex T04 review).
    setMessages((prev) => {
      const next = [...prev];
      while (
        next.length > 0 &&
        next[next.length - 1]?.role === "assistant" &&
        isRetryableStopReason(next[next.length - 1]?.stopReason)
      ) {
        next.pop();
      }
      if (
        next.length > 0 &&
        next[next.length - 1]?.role === "user" &&
        next[next.length - 1]?.content === text
      ) {
        next.pop();
      }
      void runUtteranceTurn(text, next);
      return next;
    });
  }, [retryable, streaming, runUtteranceTurn]);

  const handlePickCandidate = useCallback(
    async (candidate: ResolverCandidate) => {
      if (!pendingResolverMiss || streaming || !session || sessionLoading) {
        return;
      }

      const priorMiss = pendingResolverMiss;
      const portionG = priorMiss.portionG ?? 100;
      const mealType = priorMiss.mealType ?? "snack";
      // Keep picker visible until the structured turn succeeds (Codex review).
      setStreaming(true);
      setError(null);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: chatHeaders(session),
          body: JSON.stringify({
            tag: "candidate_log",
            foodId: candidate.foodId,
            foodName: candidate.foodName,
            portionG,
            mealType,
          }),
        });

        if (!response.ok) {
          const fallback =
            response.status === 401
              ? "Session expired or missing. Sign in via Profile and try again."
              : "Failed to log selected food. Please try again.";
          setError(await responseErrorMessage(response, fallback));
          return;
        }

        const streamState = createAssistantStreamState();
        await readChatStream(
          response,
          trackedStreamHandler(
            streamState,
            { setCurrentTool, setPartialResponse },
            "Candidate log failed.",
          ),
        );

        const pickMsg: DisplayMessage = {
          role: "user",
          content: utteranceForCandidatePick(candidate, priorMiss),
        };
        setMessages((prev) => [...prev, pickMsg]);

        if (streamState.writeProposal) {
          setPendingResolverMiss(null);
          const { cleanText, sources } = extractSources(streamState.content);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content:
                cleanText ||
                streamState.content ||
                "Write proposal awaiting confirmation.",
              sources: sources.length > 0 ? sources : undefined,
              stopReason: streamState.stopReason || undefined,
              proposal: streamState.writeProposal,
            },
          ]);
          setPendingProposal(streamState.writeProposal);
          setPendingSafetyNotices(
            streamState.safetyNotices.length > 0
              ? streamState.safetyNotices
              : projectProposalSafetyNotices(
                  streamState.writeProposal,
                  streamState.interactions,
                ),
          );
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Network error during candidate pick.",
        );
      } finally {
        setStreaming(false);
        setPartialResponse("");
        setCurrentTool(null);
      }
    },
    [pendingResolverMiss, streaming, session, sessionLoading],
  );

  /** Hand-entry custom meal → proposal (RFC 0005 packaging escape hatch). */
  const handleCustomMeal = useCallback(
    async (values: CustomMealFormValues) => {
      if (!session || streaming || sessionLoading) return;
      setConfirming(true);
      setError(null);
      try {
        const res = await fetch("/api/custom-meal", {
          method: "POST",
          headers: {
            ...chatHeaders(session),
          },
          body: JSON.stringify(values),
        });
        if (!res.ok) {
          setError(await responseErrorMessage(res, "Custom meal failed."));
          return;
        }
        const body = (await res.json()) as {
          proposal: WriteProposalData;
        };
        setPendingResolverMiss(null);
        setPendingProposal(body.proposal);
        setPendingSafetyNotices(
          projectProposalSafetyNotices(body.proposal, []),
        );
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Custom meal proposal for ${body.proposal.foodName}.`,
            stopReason: "write_proposal",
            proposal: body.proposal,
          },
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Custom meal failed.");
      } finally {
        setConfirming(false);
      }
    },
    [session, streaming, sessionLoading],
  );

  /** Edit portion: void current proposal, open a new one bound to foodId. */
  const handleEditPortion = useCallback(
    async (portionG: number) => {
      if (!pendingProposal?.foodId || confirming || !session || sessionLoading) {
        return;
      }
      setConfirming(true);
      setError(null);
      const old = pendingProposal;
      try {
        // Void old proposal (best-effort) — immutable bytes never mutated.
        await fetch("/api/chat", {
          method: "POST",
          headers: chatHeaders(session),
          body: JSON.stringify({
            tag: "proposal_confirm",
            proposalId: old.proposalId,
            confirmed: false,
          }),
        });

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: chatHeaders(session),
          body: JSON.stringify({
            tag: "candidate_log",
            foodId: old.foodId,
            foodName: old.canonicalName ?? old.foodName,
            portionG,
            mealType: old.mealType,
          }),
        });
        if (!response.ok) {
          setError(await responseErrorMessage(response, "Edit failed."));
          return;
        }
        const streamState = createAssistantStreamState();
        await readChatStream(
          response,
          trackedStreamHandler(
            streamState,
            { setCurrentTool, setPartialResponse },
            "Edit failed.",
          ),
        );
        if (streamState.writeProposal) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Superseded with ${portionG}g ${old.foodName}.`,
              proposal: old,
              proposalStatus: "voided",
            },
            {
              role: "assistant",
              content: "New proposal awaiting confirmation.",
              stopReason: "write_proposal",
              proposal: streamState.writeProposal,
            },
          ]);
          setPendingProposal(streamState.writeProposal);
          setPendingSafetyNotices(
            streamState.safetyNotices.length > 0
              ? streamState.safetyNotices
              : projectProposalSafetyNotices(
                  streamState.writeProposal,
                  streamState.interactions,
                ),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Edit failed.");
      } finally {
        setConfirming(false);
      }
    },
    [pendingProposal, confirming, session, sessionLoading],
  );

  /** Confirm a write proposal through a structured turn input. */
  const handleConfirmProposal = useCallback(
    async (confirmed: boolean, feedback?: string) => {
      if (!pendingProposal || confirming || sessionLoading) return;

      if (!session) {
        setError("Sign in required. Open Profile to sign in, then return here.");
        return;
      }

      setConfirming(true);
      setError(null);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: chatHeaders(session),
          body: JSON.stringify({
            tag: "proposal_confirm",
            proposalId: pendingProposal.proposalId,
            confirmed,
            ...(feedback ? { feedback } : {}),
          }),
        });

        if (!response.ok) {
          const fallback =
            response.status === 401
              ? "Session expired or missing. Sign in via Profile and try again."
              : "Failed to process confirmation.";
          setError(await responseErrorMessage(response, fallback));
          return;
        }

        let reply = "";
        let notCommittable = false;
        // A confirm turn is a turn too, so it registers and clears the client's
        // pending-turn entry through the same handler as every other path (§5).
        const confirmBookkeeping = trackedStreamHandler(
          createAssistantStreamState(),
          { setCurrentTool: () => {}, setPartialResponse: () => {} },
          "Confirmation failed.",
        );
        await readChatStream(response, (event) => {
          confirmBookkeeping(event);

          const result = terminalResultFromEvent(event);
          if (result?.reply) {
            reply = result.reply;
          }
          if (
            typeof result?.reply === "string" &&
            /not_committable|expired|cannot be processed/i.test(result.reply)
          ) {
            notCommittable = true;
          }
        });

        const nextStatus: ProposalUiStatus = notCommittable
          ? "stale"
          : confirmed
            ? "committed"
            : "voided";

        // Retain proposal card in history with lifecycle status (RFC 0004 §6.3).
        const confirmMsg: DisplayMessage = {
          role: "assistant",
          content:
            reply ||
            (nextStatus === "stale"
              ? "Proposal is no longer committable (expired or already handled)."
              : `Proposal ${confirmed ? "confirmed" : "rejected"}.`),
          stopReason: "end_turn",
          proposal: pendingProposal,
          proposalStatus: nextStatus,
        };
        setMessages((prev) => [...prev, confirmMsg]);
        setPendingProposal(null);
        setPendingSafetyNotices([]);
        if (nextStatus === "committed") {
          void refreshToday();
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Network error during confirmation.",
        );
      } finally {
        setConfirming(false);
      }
    },
    [pendingProposal, confirming, sessionLoading, session, refreshToday],
  );

  /** Send on Enter (no Shift), newline on Shift+Enter. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  /** Click a prompt suggestion in the empty state. */
  const handleSelectPrompt = useCallback((q: string) => {
    setInput(q);
    // Focus the textarea after React re-renders
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const isEmpty = messages.length === 0 && !streaming;
  const signedOut = configured && !sessionLoading && !session;
  const chatBlocked = sessionLoading || signedOut;

  return (
    <main className="flex h-dvh flex-col bg-gray-50 pt-safe">
      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-gray-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">NutriBuddy</h1>
            <p className="text-xs text-gray-500">AI Nutrition Assistant</p>
          </div>
          <nav className="flex items-center gap-4">
            <a
              href="/profile"
              className="text-sm font-medium text-blue-600 hover:text-blue-800"
            >
              Profile
            </a>
            <a href="/" className="text-sm text-gray-500 hover:text-gray-700">
              Home
            </a>
          </nav>
        </div>
      </header>

      {signedOut && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-center text-sm text-amber-900">
          Sign in required to chat.{" "}
          <a href="/profile" className="font-semibold underline">
            Open Profile
          </a>
        </div>
      )}

      {!signedOut && (
        <TodayBar
          data={today}
          expanded={todayExpanded}
          onToggle={() => setTodayExpanded((v) => !v)}
        />
      )}

      {/* ── Messages ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <div className="space-y-4 sm:space-y-6">
            {isEmpty && <EmptyState onSelectPrompt={handleSelectPrompt} />}

            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}

            {/* Streaming indicators */}
            {streaming && currentTool && <ToolBanner tool={currentTool} />}

            {streaming && partialResponse && (
              <MessageBubble
                message={{ role: "assistant", content: partialResponse }}
                streaming
              />
            )}

            {streaming && !currentTool && !partialResponse && (
              <ThinkingIndicator />
            )}

            {/* Write-proposal confirmation card — full width on phone (#83) */}
            {pendingProposal && !streaming && (
              <div className="flex justify-start">
                <div className="w-full max-w-full sm:max-w-[75%]">
                  <ProposalCard
                    proposal={pendingProposal}
                    safetyNotices={pendingSafetyNotices}
                    onConfirm={(fb) => handleConfirmProposal(true, fb)}
                    onReject={() => handleConfirmProposal(false)}
                    onEditPortion={handleEditPortion}
                    confirming={confirming}
                  />
                </div>
              </div>
            )}

            {/* Resolver miss candidates (RFC 0004 §6.1) */}
            {pendingResolverMiss && !streaming && !pendingProposal && (
              <div className="flex justify-start">
                <div className="w-full max-w-full space-y-3 sm:max-w-[75%]">
                  <CandidatePicker
                    miss={pendingResolverMiss}
                    onPick={handlePickCandidate}
                    disabled={streaming}
                  />
                  {pendingResolverMiss.matchType === "miss_unknown" && (
                    <CustomMealForm
                      initialName={pendingResolverMiss.input}
                      disabled={streaming || confirming}
                      onSubmit={handleCustomMeal}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Retryable failures keep input (RFC 0004 §6.2) */}
            {retryable && !streaming && (
              <div className="flex justify-start">
                <div className="w-full max-w-full sm:max-w-[75%]">
                  <RetryableError
                    state={retryable}
                    onRetry={handleRetry}
                    disabled={streaming}
                  />
                </div>
              </div>
            )}

            {/* Non-retryable error banner */}
            {error && !retryable && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <p className="font-medium">Error</p>
                <p className="mt-0.5">{error}</p>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {/* ── Input ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-3 pb-safe sm:py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 sm:gap-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                sessionLoading
                  ? "Restoring session…"
                  : signedOut
                    ? "Sign in via Profile to start chatting…"
                    : "Ask NutriBuddy anything about nutrition…"
              }
              rows={1}
              disabled={streaming || chatBlocked}
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-gray-300 bg-gray-50 px-4 py-3 text-base placeholder:text-gray-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-2.5 sm:text-sm"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!input.trim() || streaming || chatBlocked}
              className="min-h-[44px] min-w-[44px] shrink-0 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:min-w-0 sm:py-2.5"
              aria-label="Send message"
            >
              <span className="hidden sm:inline">Send</span>
              <svg
                className="h-5 w-5 sm:hidden"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            NutriBuddy provides evidence-based nutrition guidance. Always
            consult a healthcare professional for medical advice.
          </p>
        </div>
      </div>
    </main>
  );
}
