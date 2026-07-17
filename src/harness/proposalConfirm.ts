// Proposal confirm short-circuit (RFC 0001 Phase 1 / issues #71, #73, #76).
//
// Ownership and status are decided solely by the store discriminant (kind).
// No pre-RPC get-then-branch. mealLogStore is not used; writes go only through
// commitProposalAndInsertMeal / voidProposal.
//
// Callers must pass a fully-typed ConfirmPorts (kind: "confirm"). Incomplete
// assembly is resolved at the turn seam (issue #73) — this module does not
// accept the optional TurnPorts bag.

import type {
  ConfirmPorts,
  GateVerdict,
  ProposalConfirmInput,
  TurnResult,
} from "./turn";

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

function createEndTurnResult(
  reply: string,
  extra: Partial<TurnResult> = {},
): TurnResult {
  return {
    reply,
    steps: 0,
    stopReason: "end_turn",
    ...extra,
  };
}

function createProposalConfirmReply(input: ProposalConfirmInput): string {
  if (!input.confirmed) {
    return `Proposal ${input.proposalId} rejected.`;
  }

  const feedback = input.feedback ? ` ${input.feedback}` : "";
  return `Proposal ${input.proposalId} confirmed.${feedback}`;
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
 * Handle a proposal confirmation turn input (RFC 0001 Phase 1).
 *
 * Short-circuits the model. Ports must already be a complete ConfirmPorts —
 * incomplete assembly is fail-closed at the turn boundary (issue #73).
 */
export async function handleProposalConfirm(
  input: ProposalConfirmInput,
  ports: ConfirmPorts,
): Promise<ProposalConfirmOutcome> {
  const { proposalId, confirmed } = input;
  const { proposalStore } = ports;

  if (confirmed) {
    const outcome = await proposalStore.commitProposalAndInsertMeal(proposalId);
    switch (outcome.kind) {
      case "committed":
        return createProposalConfirmOutcome(
          createEndTurnResult(createProposalConfirmReply(input), {
            // K3 / issue #76: structured id lineage on the terminal.
            commit: {
              proposalId: outcome.proposalId,
              mealLogId: outcome.mealLogId,
            },
          }),
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
        createEndTurnResult(createProposalConfirmReply(input)),
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
