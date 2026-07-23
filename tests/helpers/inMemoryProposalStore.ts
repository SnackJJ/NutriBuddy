// In-memory ProposalStore + FaultInjectable (RFC 0001 §1.3).
//
// Test double only. Production ProposalStore does not include fault methods.
// Ownership collapses to the same not_committable discriminant as production:
// wrong-owner / non-proposed / missing → not_committable (no richer evidence).

import type {
  CommitResult,
  MealLogEntry,
  Proposal,
  ProposalInput,
  ProposalStore,
  VoidResult,
} from "../../src/harness/logMeal";

/** Test-only. In-memory ProposalStore must implement this; Supabase adapter must not. */
export interface FaultInjectable {
  /** Next commitProposalAndInsertMeal returns {kind:"error", cause}, with
   *  zero state change (proposal stays proposed; no meal row). One-shot. */
  failNextCommit(cause: string): void;
  /** Same for voidProposal. */
  failNextVoid(cause: string): void;
}

export interface InMemoryProposalStoreOptions {
  /** Bound session subject — only this user's proposals are commit/void-able. */
  readonly userId: string;
  /** Shared proposal array (fixture-visible for side-effect asserts). */
  readonly proposals?: Proposal[];
  /** Shared meal ledger array (fixture-visible for side-effect asserts). */
  readonly mealLedger?: MealLogEntry[];
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

export interface InMemoryProposalStore
  extends ProposalStore, FaultInjectable {
  /** Live proposals array (same reference as options.proposals when provided). */
  readonly proposals: Proposal[];
  /** Live meal ledger (same reference as options.mealLedger when provided). */
  readonly mealLedger: MealLogEntry[];
}

let defaultIdCounter = 0;

function defaultIdFactory(): string {
  defaultIdCounter += 1;
  return `proposal-mem-${defaultIdCounter.toString().padStart(3, "0")}`;
}

/**
 * Create an in-memory ProposalStore that implements the production verdict
 * contract plus FaultInjectable for F2/F3.
 *
 * Commit/void only succeed when the proposal's userId matches the store's
 * bound userId and status is "proposed". All other cases collapse to
 * not_committable (same as production app-layer events under RLS).
 */
export function createInMemoryProposalStore(
  options: InMemoryProposalStoreOptions,
): InMemoryProposalStore {
  const proposals = options.proposals ?? [];
  const mealLedger = options.mealLedger ?? [];
  const now =
    options.now ?? (() => new Date("2026-07-17T12:00:00.000Z").toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const boundUserId = options.userId;

  let nextCommitFail: string | undefined;
  let nextVoidFail: string | undefined;

  const store: InMemoryProposalStore = {
    proposals,
    mealLedger,

    failNextCommit(cause: string): void {
      nextCommitFail = cause;
    },

    failNextVoid(cause: string): void {
      nextVoidFail = cause;
    },

    async store(input: ProposalInput): Promise<Proposal> {
      const proposal: Proposal = {
        ...input,
        id: idFactory(),
        status: "proposed",
        createdAt: now(),
      };
      proposals.push(proposal);
      return proposal;
    },

    async get(id: string): Promise<Proposal | undefined> {
      return proposals.find((p) => p.id === id);
    },

    async commitProposalAndInsertMeal(
      proposalId: string,
    ): Promise<CommitResult> {
      // Injected failure runs BEFORE the critical section (RFC §1.3).
      if (nextCommitFail !== undefined) {
        const cause = nextCommitFail;
        nextCommitFail = undefined;
        return { kind: "error", cause };
      }

      const index = proposals.findIndex(
        (p) =>
          p.id === proposalId &&
          p.userId === boundUserId &&
          p.status === "proposed",
      );

      if (index < 0) {
        return { kind: "not_committable" };
      }

      const proposal = proposals[index];
      const committed: Proposal = { ...proposal, status: "committed" };
      proposals[index] = committed;

      const entry: MealLogEntry = {
        id: mealLedger.length + 1,
        userId: proposal.userId,
        foodName: proposal.foodName,
        portionG: proposal.portionG,
        mealType: proposal.mealType,
        loggedAt: now(),
        kcal: proposal.kcal,
        proteinG: proposal.proteinG,
        fatG: proposal.fatG,
        carbsG: proposal.carbsG,
        proposalId: proposal.id,
        foodId: proposal.foodId,
        matchType: proposal.matchType,
        allergenTags: [...(proposal.allergenTags ?? [])],
      };
      mealLedger.push(entry);

      return {
        kind: "committed",
        proposalId: proposal.id,
        mealLogId: entry.id,
      };
    },

    async voidProposal(proposalId: string): Promise<VoidResult> {
      if (nextVoidFail !== undefined) {
        const cause = nextVoidFail;
        nextVoidFail = undefined;
        return { kind: "error", cause };
      }

      const index = proposals.findIndex(
        (p) =>
          p.id === proposalId &&
          p.userId === boundUserId &&
          p.status === "proposed",
      );

      if (index < 0) {
        return { kind: "not_committable" };
      }

      const voided: Proposal = {
        ...proposals[index],
        status: "voided",
      };
      proposals[index] = voided;

      return { kind: "voided", proposalId };
    },
  };

  return store;
}
