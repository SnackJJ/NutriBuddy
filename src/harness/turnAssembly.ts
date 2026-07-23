// Structural Phase 6 — typed turn assembly with fail-closed incomplete ports.
// Confirm path mirrors ConfirmPorts; utterance requires adapter + tracer at minimum.

import type { ModelAdapter, ToolHandler, ToolSchema, ChatMessage } from "./types";
import type { Tracer } from "./tracer";
import type { EventLog } from "./eventLog";
import type { Catalog } from "../catalog/catalog";
import type { QueryCatalog } from "../catalog/queryCatalog";
import type { UserContext } from "./gate";
import type { InteractionStore } from "../lib/drugInteractions";
import type {
  MealLogStore,
  ProposalStore,
} from "./logMeal";
import type { TurnPorts, TurnResult } from "./turn";
import { resolveConfirmPorts } from "./turn";

export type TurnAssemblyKind =
  | "utterance"
  | "proposal_confirm"
  | "candidate_log";

export const ASSEMBLY_INCOMPLETE = "assembly_incomplete";
export const CONFIRM_PORTS_INCOMPLETE = "confirm_ports_incomplete";

export interface CreateTurnAssemblyInput {
  readonly kind: TurnAssemblyKind;
  readonly adapter: ModelAdapter;
  readonly tracer: Tracer;
  readonly clock?: () => Date;
  readonly eventLog?: EventLog;
  readonly history?: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly tier?: "flash" | "pro";
  readonly thinking?: boolean;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
  readonly userId?: string;
  readonly sessionUserId?: string;
  readonly proposalStore?: ProposalStore;
  readonly mealLogStore?: MealLogStore;
  readonly catalog?: Catalog;
  readonly queryCatalog?: QueryCatalog;
  readonly catalogVersion?: string;
  readonly profileVersion?: string;
  readonly tools?: ReadonlyMap<string, ToolHandler>;
  readonly toolSchemas?: readonly ToolSchema[];
  readonly userContext?: UserContext;
  readonly interactionStore?: InteractionStore;
  /**
   * When true (default for utterance with tools intent), require tools + toolSchemas
   * together. Anonymous utterance without tools is allowed.
   */
  readonly requireTools?: boolean;
}

export type TurnAssemblyOk = {
  readonly ok: true;
  readonly ports: TurnPorts;
};

export type TurnAssemblyFail = {
  readonly ok: false;
  readonly checkName: string;
  readonly reason: string;
};

export type TurnAssemblyResult = TurnAssemblyOk | TurnAssemblyFail;

/**
 * Build TurnPorts for a tagged turn path. Incomplete assemblies fail closed
 * (discriminated result) — callers must not call turn() with partial safety ports.
 */
export function createTurnAssembly(
  input: CreateTurnAssemblyInput,
): TurnAssemblyResult {
  if (!input.adapter || !input.tracer) {
    return {
      ok: false,
      checkName: ASSEMBLY_INCOMPLETE,
      reason: "adapter and tracer are required for every turn assembly",
    };
  }

  if (input.kind === "proposal_confirm") {
    if (!input.proposalStore || !input.sessionUserId) {
      return {
        ok: false,
        checkName: CONFIRM_PORTS_INCOMPLETE,
        reason:
          "ConfirmPorts incomplete: proposalStore and sessionUserId are required",
      };
    }
  }

  if (input.kind === "candidate_log") {
    if (!input.catalog || !input.proposalStore || !input.sessionUserId) {
      return {
        ok: false,
        checkName: ASSEMBLY_INCOMPLETE,
        reason:
          "candidate_log requires catalog, proposalStore, and sessionUserId",
      };
    }
  }

  const wantTools = input.requireTools === true;
  if (wantTools) {
    if (!input.tools || !input.toolSchemas || input.toolSchemas.length === 0) {
      return {
        ok: false,
        checkName: ASSEMBLY_INCOMPLETE,
        reason: "tools and toolSchemas are required when requireTools is true",
      };
    }
  }

  // tools without schemas (or reverse) is an inconsistent assembly
  if (
    (input.tools && !input.toolSchemas) ||
    (!input.tools && input.toolSchemas && input.toolSchemas.length > 0)
  ) {
    return {
      ok: false,
      checkName: ASSEMBLY_INCOMPLETE,
      reason: "tools and toolSchemas must be provided together",
    };
  }

  const ports: TurnPorts = {
    adapter: input.adapter,
    tracer: input.tracer,
    clock: input.clock,
    eventLog: input.eventLog,
    history: input.history,
    systemPrompt: input.systemPrompt,
    tier: input.tier,
    thinking: input.thinking,
    maxSteps: input.maxSteps,
    signal: input.signal,
    userId: input.userId ?? input.sessionUserId,
    sessionUserId: input.sessionUserId,
    proposalStore: input.proposalStore,
    mealLogStore: input.mealLogStore,
    catalog: input.catalog,
    queryCatalog: input.queryCatalog,
    catalogVersion: input.catalogVersion,
    profileVersion: input.profileVersion,
    tools: input.tools,
    toolSchemas: input.toolSchemas,
    userContext: input.userContext,
    interactionStore: input.interactionStore,
  };

  // Double-check confirm resolution matches RFC 0001 ConfirmPorts
  if (input.kind === "proposal_confirm" && !resolveConfirmPorts(ports)) {
    return {
      ok: false,
      checkName: CONFIRM_PORTS_INCOMPLETE,
      reason:
        "ConfirmPorts incomplete: proposalStore and sessionUserId are required",
    };
  }

  return { ok: true, ports };
}

/** Fail-closed TurnResult for incomplete assembly (before turn() starts). */
export function incompleteAssemblyResult(
  reason: string,
  proposalId?: string,
): TurnResult {
  const prefix = proposalId
    ? `Proposal ${proposalId} cannot be processed: `
    : "";
  return {
    reply: `${prefix}${reason}`,
    steps: 0,
    stopReason: "crash",
  };
}
