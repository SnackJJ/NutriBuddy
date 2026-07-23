"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage, WriteProposalData } from "@/harness/types";
import { extractSources, friendlyToolName } from "@/lib/chatHelpers";
import type { DrugNutrientInteraction } from "@/lib/drugInteractions";
import {
  matchQualityLabel,
  projectProposalSafetyNotices,
  type ProposalSafetyNotice,
} from "@/lib/proposalSafety";
import { useSupabaseSession, authHeader } from "@/lib/useSupabaseSession";
import type { Session } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────

/** A message displayed in the chat UI.  Enriches the wire ChatMessage
 *  with UI-only fields for sources, tool calls, and gate status. */
interface DisplayMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Citation sources extracted from `[Source: …]` in the reply. */
  readonly sources?: readonly string[];
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
  readonly proposal?: WriteProposalData;
  readonly interactions?: readonly DrugNutrientInteraction[];
  readonly safetyNotices?: readonly ProposalSafetyNotice[];
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
  readonly checkpoint?: string;
  readonly verdict?: string;
  readonly checkName?: string;
  readonly evidence?: string;
  readonly result?: StreamTerminalResult;
  readonly error?: string;
}

interface AssistantStreamState {
  content: string;
  toolCalls: ToolCallEntry[];
  stopReason: string;
  gateReasons: string[];
  writeProposal?: WriteProposalData;
  interactions: DrugNutrientInteraction[];
  safetyNotices: ProposalSafetyNotice[];
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
    interactions: [],
    safetyNotices: [],
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
    return event.result;
  }

  if (event.type === "terminal") {
    return event;
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

  if (result.stopReason === "write_proposal" && result.proposal) {
    state.writeProposal = result.proposal;
  }

  if (result.interactions && result.interactions.length > 0) {
    state.interactions = [...result.interactions];
  }

  if (result.safetyNotices) {
    state.safetyNotices = [...result.safetyNotices];
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

/** Write-proposal confirmation card (issue #39 / mobile thumb targets #83).
 *  RFC 0004 §6.1 / §6.4: match quality + safety notices before confirm. */
function ProposalCard({
  proposal,
  safetyNotices,
  onConfirm,
  onReject,
  confirming,
}: {
  proposal: WriteProposalData;
  safetyNotices: readonly ProposalSafetyNotice[];
  onConfirm: (feedback?: string) => void;
  onReject: () => void;
  confirming: boolean;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const quality = matchQualityLabel(proposal.matchType);
  const hasSafety = safetyNotices.length > 0;

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        hasSafety
          ? "border-amber-300 bg-amber-50"
          : "border-blue-200 bg-blue-50"
      }`}
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
          className={`text-sm font-semibold ${hasSafety ? "text-amber-900" : "text-blue-800"}`}
        >
          Confirm Meal Log
        </span>
      </div>

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
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { session, loading: sessionLoading, configured } = useSupabaseSession();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [partialResponse, setPartialResponse] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] =
    useState<WriteProposalData | null>(null);
  const [pendingSafetyNotices, setPendingSafetyNotices] = useState<
    readonly ProposalSafetyNotice[]
  >([]);
  const [confirming, setConfirming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll when new content appears
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

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

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming || sessionLoading) return;

    // Issue #82: /api/chat is auth-only — block before the network call.
    if (!session) {
      setError("Sign in required. Open Profile to sign in, then return here.");
      return;
    }

    setInput("");
    setStreaming(true);
    setError(null);
    setCurrentTool(null);
    setPartialResponse("");
    setPendingProposal(null);

    const userMsg: DisplayMessage = {
      role: "user",
      content: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const history = buildHistory(messages);
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
        setError(await responseErrorMessage(response, fallback));
        return;
      }

      const streamState = createAssistantStreamState();
      await readChatStream(response, (event) => {
        if (event.type === "error") {
          throw new Error(event.error ?? "An unexpected error occurred.");
        }

        applyAssistantStreamEvent(event, streamState, {
          setCurrentTool,
          setPartialResponse,
        });
      });

      if (
        streamState.content ||
        streamState.stopReason === "gate_blocked" ||
        streamState.stopReason === "write_proposal"
      ) {
        const { cleanText, sources } = extractSources(streamState.content);

        const assistantMsg: DisplayMessage = {
          role: "assistant",
          content:
            cleanText ||
            streamState.content ||
            "Write proposal awaiting confirmation.",
          sources: sources.length > 0 ? sources : undefined,
          toolCalls:
            streamState.toolCalls.length > 0
              ? streamState.toolCalls
              : undefined,
          gateBlocked: streamState.stopReason === "gate_blocked",
          gateReasons:
            streamState.gateReasons.length > 0
              ? streamState.gateReasons
              : undefined,
          stopReason: streamState.stopReason || undefined,
          proposal: streamState.writeProposal,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        if (streamState.writeProposal) {
          setPendingProposal(streamState.writeProposal);
          // Prefer turn-seam projection; fall back only if terminal omitted notices.
          setPendingSafetyNotices(
            streamState.safetyNotices.length > 0
              ? streamState.safetyNotices
              : projectProposalSafetyNotices(
                  streamState.writeProposal,
                  streamState.interactions,
                ),
          );
        }
      }

      setPartialResponse("");
      setCurrentTool(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error. Please try again.",
      );
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, sessionLoading, messages, session, buildHistory]);

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
        await readChatStream(response, (event) => {
          if (event.type === "error") {
            throw new Error(event.error ?? "Confirmation failed.");
          }

          const result = terminalResultFromEvent(event);
          if (result?.reply) {
            reply = result.reply;
          }
        });

        const confirmMsg: DisplayMessage = {
          role: "assistant",
          content: reply || `Proposal ${confirmed ? "confirmed" : "rejected"}.`,
          stopReason: "end_turn",
        };
        setMessages((prev) => [...prev, confirmMsg]);
        setPendingProposal(null);
        setPendingSafetyNotices([]);
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
    [pendingProposal, confirming, sessionLoading, session],
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
                    confirming={confirming}
                  />
                </div>
              </div>
            )}

            {/* Error banner */}
            {error && (
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
