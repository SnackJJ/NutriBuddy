// Chat API helpers (issue #39 / PRD v2 §5.1).
//
// Pure functions shared between the chat API route and tests:
// request parsing, port construction, and event serialisation.
// The route handler is thin — just wires parsed inputs into the Turn Seam.

import type { ChatMessage } from "../harness/types";
import type { TurnInput, TurnPorts } from "../harness/turn";
import type { Tracer } from "../harness/tracer";
import type { ModelAdapter } from "../harness/types";
import type { EventLog } from "../harness/eventLog";

// ─── Request body types ───────────────────────────────────────────────

export interface UtteranceChatBody {
  readonly tag?: "utterance";
  readonly message: string;
  readonly history?: readonly ChatMessage[];
}

export interface ProposalConfirmChatBody {
  readonly tag: "proposal_confirm";
  readonly proposalId: string;
  readonly confirmed: boolean;
  readonly feedback?: string;
}

export type ChatRequestBody = UtteranceChatBody | ProposalConfirmChatBody;

// ─── Body parsing ─────────────────────────────────────────────────────

/**
 * Parse a chat request body into a TurnInput for the Turn Seam.
 *
 * When tag is "proposal_confirm", produces a ProposalConfirmInput that
 * short-circuits the model call. When tag is "utterance" or omitted,
 * produces an UtteranceInput for a full model turn.
 */
export function parseChatBody(body: ChatRequestBody): TurnInput {
  if (body.tag === "proposal_confirm") {
    const { tag: _tag, proposalId, confirmed, feedback } = body;

    if (!proposalId || typeof proposalId !== "string") {
      throw new Error(
        "proposalId is required and must be a string for proposal_confirm turns",
      );
    }

    return { tag: "proposal_confirm", proposalId, confirmed, feedback };
  }

  if (body.tag && body.tag !== "utterance") {
    throw new Error(
      `Unknown turn tag: "${String(body.tag)}". Expected "utterance" or "proposal_confirm".`,
    );
  }

  const { message } = body as UtteranceChatBody;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    throw new Error("message is required and must be non-empty for utterance turns");
  }

  return { tag: "utterance", content: message.trim() };
}

// ─── Port construction ───────────────────────────────────────────────

export interface BuildChatTurnPortsInput {
  readonly adapter: ModelAdapter;
  readonly tracer: Tracer;
  readonly sessionUserId?: string;
  readonly history?: readonly ChatMessage[];
  readonly eventLog?: EventLog;
}

/**
 * Build TurnPorts from chat API parameters.
 *
 * The sessionUserId comes from the request header (not the body)
 * and is bound as both userId and sessionUserId on the ports.
 * The model never sees the userId — it's for tool scoping only.
 *
 * This is the boundary where user identity enters the harness
 * outside of model-fillable input (issue #39 / PRD v2 §3.1).
 */
export function buildChatTurnPorts(
  input: BuildChatTurnPortsInput,
): TurnPorts {
  return {
    adapter: input.adapter,
    tracer: input.tracer,
    eventLog: input.eventLog,
    userId: input.sessionUserId,
    sessionUserId: input.sessionUserId,
    history: input.history,
  };
}
