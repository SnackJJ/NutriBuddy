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
import type { Catalog } from "../catalog/catalog";

// ─── Request body types ───────────────────────────────────────────────

export const SESSION_USER_ID_HEADER = "X-User-Id";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProposalConfirmBody(body: Record<string, unknown>): TurnInput {
  const proposalId = body.proposalId;
  const confirmed = body.confirmed;
  const feedback = body.feedback;

  if (typeof proposalId !== "string" || proposalId.length === 0) {
    throw new Error(
      "proposalId is required and must be a string for proposal_confirm turns",
    );
  }

  if (typeof confirmed !== "boolean") {
    throw new Error(
      "confirmed is required and must be a boolean for proposal_confirm turns",
    );
  }

  if (feedback !== undefined && typeof feedback !== "string") {
    throw new Error(
      "feedback must be a string when provided for proposal_confirm turns",
    );
  }

  return { tag: "proposal_confirm", proposalId, confirmed, feedback };
}

function parseUtteranceBody(body: Record<string, unknown>): TurnInput {
  const message = body.message;

  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error(
      "message is required and must be non-empty for utterance turns",
    );
  }

  return { tag: "utterance", content: message.trim() };
}

export function parseChatBody(body: unknown): TurnInput {
  if (!isRecord(body)) {
    throw new Error("request body must be a JSON object");
  }

  const tag = body.tag;

  if (tag === "proposal_confirm") {
    return parseProposalConfirmBody(body);
  }

  if (tag !== undefined && tag !== "utterance") {
    throw new Error(
      `Unknown turn tag: "${String(tag)}". Expected "utterance" or "proposal_confirm".`,
    );
  }

  return parseUtteranceBody(body);
}

// ─── Port construction ───────────────────────────────────────────────

export interface BuildChatTurnPortsInput {
  readonly adapter: ModelAdapter;
  readonly tracer: Tracer;
  readonly sessionUserId?: string;
  readonly history?: readonly ChatMessage[];
  readonly eventLog?: EventLog;
  /** Food catalog for the input-gate conflict scan (issue #53). */
  readonly catalog?: Catalog;
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
export function buildChatTurnPorts(input: BuildChatTurnPortsInput): TurnPorts {
  return {
    adapter: input.adapter,
    tracer: input.tracer,
    eventLog: input.eventLog,
    userId: input.sessionUserId,
    sessionUserId: input.sessionUserId,
    history: input.history,
    catalog: input.catalog,
  };
}
