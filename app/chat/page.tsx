"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage } from "@/harness/types";
import type { WriteProposalData } from "@/harness/types";
import { extractSources, friendlyToolName } from "@/lib/chatHelpers";

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

/** A streaming event from the /api/chat NDJSON stream (Turn Seam enriched). */
interface StreamEvent {
  readonly type: string;
  readonly step?: number;
  readonly content?: string;
  readonly toolCall?: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
  readonly toolResult?: { readonly name: string; readonly result: string };
  /** Agent event carried inside a step event from the Turn Seam. */
  readonly agentEvent?: {
    readonly type: "thought" | "act" | "observe";
    readonly step: number;
    readonly content?: string;
    readonly toolCall?: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
    readonly toolResult?: { readonly name: string; readonly result: string };
  };
  /** Terminal result fields (from turn_end result + terminal event). */
  readonly reply?: string;
  readonly steps?: number;
  readonly stopReason?: string;
  readonly output?: unknown;
  readonly proposal?: WriteProposalData;
  /** Gate verdict fields. */
  readonly checkpoint?: string;
  readonly verdict?: string;
  readonly checkName?: string;
  readonly evidence?: string;
  /** Result object carried by turn_end events. */
  readonly result?: {
    readonly reply: string;
    readonly steps: number;
    readonly stopReason: string;
    readonly proposal?: WriteProposalData;
  };
  readonly error?: string;
}

// ─── Sub-components ────────────────────────────────────────────────────

/** Shown when there are no messages yet. */
function EmptyState({ onSelectPrompt }: { onSelectPrompt: (q: string) => void }) {
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
        Your personal AI nutrition assistant. Ask about food nutrition,
        meal planning, dietary guidelines, or get evidence-based answers
        to your nutrition questions.
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
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
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
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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

/** Write-proposal confirmation card (issue #39). */
function ProposalCard({
  proposal,
  onConfirm,
  onReject,
  confirming,
}: {
  proposal: WriteProposalData;
  onConfirm: (feedback?: string) => void;
  onReject: () => void;
  confirming: boolean;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <svg className="h-5 w-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <span className="text-sm font-semibold text-blue-800">
          Confirm Meal Log
        </span>
      </div>

      <div className="mb-3 space-y-1 text-sm text-blue-900">
        <p>
          <span className="font-medium">{proposal.foodName}</span> —{" "}
          {proposal.portionG}g ({proposal.mealType})
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-blue-700">
          {proposal.kcal !== undefined && (
            <span>{proposal.kcal} kcal</span>
          )}
          {proposal.proteinG !== undefined && (
            <span>{proposal.proteinG}g protein</span>
          )}
          {proposal.fatG !== undefined && (
            <span>{proposal.fatG}g fat</span>
          )}
          {proposal.carbsG !== undefined && (
            <span>{proposal.carbsG}g carbs</span>
          )}
        </div>
        {proposal.nutritionSource && (
          <p className="text-xs text-blue-500">
            Source: {proposal.nutritionSource}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onConfirm(showFeedback ? feedback : undefined)}
          disabled={confirming}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {confirming ? "Confirming…" : "✓ Confirm"}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={confirming}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ✗ Reject
        </button>
        {!showFeedback && (
          <button
            type="button"
            onClick={() => setShowFeedback(true)}
            disabled={confirming}
            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
          >
            + Add feedback
          </button>
        )}
      </div>

      {showFeedback && (
        <div className="mt-3">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Optional feedback (e.g. reduce portion, change meal type)…"
            rows={2}
            disabled={confirming}
            className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────

const SESSION_USER_ID_HEADER = "X-User-Id";

/** Generate a stable client-side userId (M1 — no auth yet).
 *  Returns empty string during SSR; the component hydrates via useEffect. */
function readUserId(): string {
  if (typeof window === "undefined") return "";
  const key = "nutribuddy_user_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function ChatPage() {
  const [userId, setUserId] = useState("");
  // Hydrate userId on the client only (SSR-safe)
  useEffect(() => {
    setUserId(readUserId());
  }, []);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [partialResponse, setPartialResponse] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  /** Pending proposal awaiting user confirmation. */
  const [pendingProposal, setPendingProposal] = useState<WriteProposalData | null>(null);
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
    if (!trimmed || streaming) return;

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
        headers: {
          "Content-Type": "application/json",
          ...(userId ? { [SESSION_USER_ID_HEADER]: userId } : {}),
        },
        body: JSON.stringify({ message: trimmed, history }),
      });

      if (!response.ok) {
        let errorMsg = "Failed to get a response. Please try again.";
        try {
          const err = (await response.json()) as { error?: string };
          if (err.error) errorMsg = err.error;
        } catch {
          // Can't parse error body — use default
        }
        setError(errorMsg);
        setStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setError("Streaming is not supported by your browser.");
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";
      const toolCalls: ToolCallEntry[] = [];
      let stopReason = "";
      let gateReasons: string[] = [];
      let writeProposal: WriteProposalData | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line) as StreamEvent;
          } catch {
            continue; // Skip malformed JSON lines
          }

          // ── Handle Turn Seam enriched events ──────────────────
          switch (event.type) {
            case "error":
              setError(event.error ?? "An unexpected error occurred.");
              setStreaming(false);
              return;

            case "turn_start":
              // Turn start — no visible update needed
              break;

            case "gate_verdict":
              // Gate verdict checkpoints — collect evidence
              if (event.verdict === "block" && event.checkpoint === "output") {
                gateReasons.push(
                  `${event.checkName ?? "output_gate"}: ${event.evidence ?? "blocked"}`,
                );
              }
              break;

            case "step": {
              // Step events carry agentEvent (thought/act/observe)
              if (!event.agentEvent) break;

              switch (event.agentEvent.type) {
                case "thought":
                  // thought events are intermediate — no visible update
                  break;

                case "act":
                  if (event.agentEvent.toolCall) {
                    setCurrentTool(
                      friendlyToolName(event.agentEvent.toolCall.name),
                    );
                  }
                  break;

                case "observe":
                  if (event.agentEvent.toolResult) {
                    toolCalls.push({
                      name: event.agentEvent.toolResult.name,
                      args: {},
                      result: event.agentEvent.toolResult.result,
                    });
                    setCurrentTool(null);
                  }
                  if (event.agentEvent.content) {
                    assistantContent = event.agentEvent.content;
                    setPartialResponse(event.agentEvent.content);
                  }
                  break;
              }
              break;
            }

            case "turn_end":
              // turn_end carries the terminal result — extract key fields
              if (event.result) {
                stopReason = event.result.stopReason ?? stopReason;
                if (event.result.reply) {
                  assistantContent = event.result.reply;
                }
                if (
                  event.result.stopReason === "write_proposal" &&
                  event.result.proposal
                ) {
                  writeProposal = event.result.proposal;
                }
              }
              break;

            case "terminal":
              // Legacy terminal event (compat with TurnResult return value)
              stopReason = event.stopReason ?? stopReason;
              if (event.reply) {
                assistantContent = event.reply;
              }
              if (
                event.stopReason === "write_proposal" &&
                event.proposal
              ) {
                writeProposal = event.proposal;
              }
              break;

            // ── Legacy AgentEvent compat (thought/act/observe at top level) ─
            case "thought":
              break;

            case "act":
              if (event.toolCall) {
                setCurrentTool(friendlyToolName(event.toolCall.name));
              }
              break;

            case "observe":
              if (event.toolResult) {
                toolCalls.push({
                  name: event.toolResult.name,
                  args: {},
                  result: event.toolResult.result,
                });
                setCurrentTool(null);
              }
              if (event.content) {
                assistantContent = event.content;
                setPartialResponse(event.content);
              }
              break;

            default:
              break;
          }
        }
      }

      // Finalize the assistant message
      if (assistantContent || stopReason === "gate_blocked" || stopReason === "write_proposal") {
        const { cleanText, sources } = extractSources(assistantContent);

        const assistantMsg: DisplayMessage = {
          role: "assistant",
          content: cleanText || assistantContent || "Write proposal awaiting confirmation.",
          sources: sources.length > 0 ? sources : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          gateBlocked: stopReason === "gate_blocked",
          gateReasons: gateReasons.length > 0 ? gateReasons : undefined,
          stopReason: stopReason || undefined,
          proposal: writeProposal,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        // Show proposal confirmation card
        if (writeProposal) {
          setPendingProposal(writeProposal);
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
  }, [input, streaming, messages, userId, buildHistory]);

  /** Confirm a write proposal through a structured turn input. */
  const handleConfirmProposal = useCallback(
    async (confirmed: boolean, feedback?: string) => {
      if (!pendingProposal || confirming) return;

      setConfirming(true);
      setError(null);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(userId ? { [SESSION_USER_ID_HEADER]: userId } : {}),
          },
          body: JSON.stringify({
            tag: "proposal_confirm",
            proposalId: pendingProposal.proposalId,
            confirmed,
            ...(feedback ? { feedback } : {}),
          }),
        });

        if (!response.ok) {
          let errorMsg = "Failed to process confirmation.";
          try {
            const err = (await response.json()) as { error?: string };
            if (err.error) errorMsg = err.error;
          } catch {
            // Use default
          }
          setError(errorMsg);
          setConfirming(false);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          setError("Streaming is not supported by your browser.");
          setConfirming(false);
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let reply = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }

            if (event.type === "error") {
              setError(event.error ?? "Confirmation failed.");
              setConfirming(false);
              return;
            }

            if (
              event.type === "turn_end" &&
              event.result?.reply
            ) {
              reply = event.result.reply;
            }

            if (event.type === "terminal" && event.reply) {
              reply = event.reply;
            }
          }
        }

        // Add the confirmation result as an assistant message
        const confirmMsg: DisplayMessage = {
          role: "assistant",
          content: reply || `Proposal ${confirmed ? "confirmed" : "rejected"}.`,
          stopReason: "end_turn",
        };
        setMessages((prev) => [...prev, confirmMsg]);
        setPendingProposal(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Network error during confirmation.",
        );
      } finally {
        setConfirming(false);
      }
    },
    [pendingProposal, confirming, userId],
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

  return (
    <main className="flex h-dvh flex-col bg-gray-50">
      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-gray-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">
              NutriBuddy
            </h1>
            <p className="text-xs text-gray-500">AI Nutrition Assistant</p>
          </div>
          <nav className="flex items-center gap-4">
            <a
              href="/profile"
              className="text-sm font-medium text-blue-600 hover:text-blue-800"
            >
              Profile
            </a>
            <a
              href="/"
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Home
            </a>
          </nav>
        </div>
      </header>

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

            {/* Write-proposal confirmation card */}
            {pendingProposal && !streaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] sm:max-w-[75%]">
                  <ProposalCard
                    proposal={pendingProposal}
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
      <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-3 sm:py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 sm:gap-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask NutriBuddy anything about nutrition…"
              rows={1}
              disabled={streaming}
              className="flex-1 resize-none rounded-xl border border-gray-300 bg-gray-50 px-4 py-2.5 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!input.trim() || streaming}
              className="shrink-0 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
