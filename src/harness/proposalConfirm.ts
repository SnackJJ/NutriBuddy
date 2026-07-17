// Proposal confirm short-circuit (RFC 0001 Phase 1 / issue #71).
//
// Extracted from turn.ts as a move-only: ownership and status are decided
// solely by the store discriminant (kind). No pre-RPC get-then-branch.
// mealLogStore is not used; writes go only through
// commitProposalAndInsertMeal / voidProposal.

import type {
  ConfirmPorts,
  GateVerdict,
  ProposalConfirmInput,
  TurnPorts,
  TurnResult,
} from "./turn";
// type-only import from turn avoids runtime cycle with turn → proposalConfirm.

const COMMIT_GATE_CHECK = "commit_gate_check";
const NOT_COMMITTABLE = "not_committable";

export type CommitGateVerdict = {
  readonly verdict: GateVerdict;
  readonly checkName: string;
  readonly evidence: string;
};

/** Return value of handleProposalConfirm — carries the turn result plus commit gate details. */
export interface ProposalConfirmOutcome {
  readonly result: TurnResult;
  readonly commitVerdict: CommitGateVerdict;
}

function createEndTurnResult(reply: string): TurnResult {
  return {
    reply,
    steps: 0,
    stopReason: "end_turn",
  };
}

function createProposalConfirmReply(input: ProposalConfirmInput): string {
  if (!input.confirmed) {
    return `Proposal ${input.proposalId} rejected.`;
  }

  const feedback = input.feedback ? ` ${input.feedback}` : "";
  return `Proposal ${input.proposalId} confirmed.${feedback}`;
}

function createProposalConfirmResult(input: ProposalConfirmInput): TurnResult {
  return createEndTurnResult(createProposalConfirmReply(input));
}

function createProposalConfirmOutcome(
  result: TurnResult,
  verdict: GateVerdict,
  evidence: string,
  checkName: string = COMMIT_GATE_CHECK,
): ProposalConfirmOutcome {
  return {
    result,
    commitVerdict: {
      verdict,
      checkName,
      evidence,
    },
  };
}

/**
 * Require ConfirmPorts fields. Incomplete assembly is unrepresentable —
 * throw rather than silent "no store wired" pass (RFC 0001 F1 / C1).
 */
function requireConfirmPorts(ports: TurnPorts): ConfirmPorts {
  if (!ports.proposalStore || !ports.sessionUserId) {
    throw new Error(
      "ConfirmPorts incomplete: proposalStore and sessionUserId are required",
    );
  }
  return {
    proposalStore: ports.proposalStore,
    sessionUserId: ports.sessionUserId,
    clock: ports.clock,
  };
}

/**
 * Handle a proposal confirmation turn input (RFC 0001 Phase 1).
 *
 * Short-circuits the model. Ownership and status are decided solely by the
 * store discriminant (kind) — no pre-RPC get-then-branch. mealLogStore is
 * not used; writes go only through commitProposalAndInsertMeal / voidProposal.
 */
export async function handleProposalConfirm(
  input: ProposalConfirmInput,
  ports: TurnPorts,
): Promise<ProposalConfirmOutcome> {
  const { proposalId, confirmed } = input;
  const { proposalStore } = requireConfirmPorts(ports);

  if (confirmed) {
    const outcome = await proposalStore.commitProposalAndInsertMeal(proposalId);
    switch (outcome.kind) {
      case "committed":
        return createProposalConfirmOutcome(
          createProposalConfirmResult(input),
          "pass",
          `Proposal ${proposalId} committed — meal ledger row ${outcome.mealLogId}`,
        );
      case "not_committable":
        return createProposalConfirmOutcome(
          createEndTurnResult(`Proposal ${proposalId} cannot be committed.`),
          "block",
          NOT_COMMITTABLE,
          NOT_COMMITTABLE,
        );
      case "error":
        return createProposalConfirmOutcome(
          createEndTurnResult(`Proposal ${proposalId} commit failed.`),
          "error",
          outcome.cause,
        );
    }
  }

  const outcome = await proposalStore.voidProposal(proposalId);
  switch (outcome.kind) {
    case "voided":
      return createProposalConfirmOutcome(
        createProposalConfirmResult(input),
        "pass",
        `Proposal ${proposalId} explicitly rejected by user`,
      );
    case "not_committable":
      return createProposalConfirmOutcome(
        createEndTurnResult(`Proposal ${proposalId} cannot be voided.`),
        "block",
        NOT_COMMITTABLE,
        NOT_COMMITTABLE,
      );
    case "error":
      // Fail closed: do not claim rejected/voided (RFC 0001 F3).
      return createProposalConfirmOutcome(
        createEndTurnResult(`Proposal ${proposalId} void failed.`),
        "error",
        outcome.cause,
      );
  }
}
