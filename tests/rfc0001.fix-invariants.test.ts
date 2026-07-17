// RFC 0001 F1–F4 fix invariants (Phase 1 semantics).
//
// F1: ConfirmPorts requires proposalStore + sessionUserId (type-level);
//     no runtime "no store wired" pass.
// F2: failNextCommit → error gate; proposal stays proposed; no meal row.
// F3: failNextVoid → error gate; proposal stays proposed; no voided claim.
// F4: Decline cross-tenant / missing / not proposed → not_committable.

import { describe, expect, it, expectTypeOf } from "vitest";
import {
  turn,
  type AnyTurnEvent,
  type ConfirmPorts,
  type TurnGateVerdictEvent,
  type TurnInput,
  type TurnPorts,
  type TurnResult,
} from "../src/harness/turn";
import { commitGateShape } from "../src/harness/canonicalizeTurnEvents";
import { Tracer } from "../src/harness/tracer";
import type { ModelAdapter } from "../src/harness/types";
import type { Proposal, ProposalInput, ProposalStore } from "../src/harness/logMeal";
import {
  createInMemoryProposalStore,
  type FaultInjectable,
} from "./helpers/inMemoryProposalStore";

const FIXED_TS = "2026-07-17T12:00:00.000Z";
const USER_A = "user-a-f-fixtures";
const USER_B = "user-b-f-fixtures";

function stubAdapter(): ModelAdapter {
  return {
    generate: async () => {
      throw new Error("proposal_confirm must not call the model");
    },
  };
}

function ports(
  overrides: Partial<TurnPorts> = {},
): TurnPorts {
  return {
    adapter: stubAdapter(),
    tracer: new Tracer(),
    clock: () => new Date(FIXED_TS),
    ...overrides,
  };
}

async function collect(
  gen: AsyncGenerator<AnyTurnEvent, TurnResult, undefined>,
): Promise<{ events: AnyTurnEvent[]; result: TurnResult }> {
  const events: AnyTurnEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

function sampleInput(
  userId: string,
  overrides: Partial<ProposalInput> = {},
): ProposalInput {
  return {
    userId,
    foodId: "food-chicken-breast-001",
    foodName: "chicken breast",
    canonicalName: "chicken breast",
    portionG: 200,
    mealType: "lunch",
    kcal: 330,
    proteinG: 62,
    fatG: 7.2,
    carbsG: 0,
    nutritionSource: "usda-sr-legacy-2026-07-v1",
    matchType: "exact",
    allergenTags: [],
    ...overrides,
  };
}

function commitGate(
  events: readonly AnyTurnEvent[],
): TurnGateVerdictEvent {
  const gate = events.find(
    (e): e is TurnGateVerdictEvent =>
      e.type === "gate_verdict" && e.checkpoint === "commit",
  );
  expect(gate).toBeDefined();
  return gate!;
}

describe("RFC 0001 fix invariants (F1–F4)", () => {
  // ── F1 ──────────────────────────────────────────────────────────────────

  it("F1 ConfirmPorts requires kind + proposalStore + sessionUserId at type level", () => {
    expectTypeOf<ConfirmPorts>().toHaveProperty("kind");
    expectTypeOf<ConfirmPorts["kind"]>().toEqualTypeOf<"confirm">();
    expectTypeOf<ConfirmPorts>().toHaveProperty("proposalStore");
    expectTypeOf<ConfirmPorts>().toHaveProperty("sessionUserId");
    expectTypeOf<ConfirmPorts["proposalStore"]>().toEqualTypeOf<ProposalStore>();
    expectTypeOf<ConfirmPorts["sessionUserId"]>().toEqualTypeOf<string>();
    // mealLogStore must NOT be on ConfirmPorts
    expectTypeOf<ConfirmPorts>().not.toHaveProperty("mealLogStore");
  });

  it("F1 incomplete confirm ports fail closed on the seam (no throw, no silent pass)", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p-any",
      confirmed: true,
    };

    async function expectIncompleteFailClosed(
      incompletePorts: TurnPorts,
    ): Promise<void> {
      const { events, result } = await collect(turn(input, incompletePorts));
      // Stream ends with a terminal — never mid-stream throw (issue #73).
      expect(events[0]?.type).toBe("turn_start");
      expect(events[events.length - 1]?.type).toBe("turn_end");
      expect(result.stopReason).toBe("crash");
      expect(result.reply).toMatch(/ConfirmPorts incomplete/i);
      expect(result.commit).toBeUndefined();
      // No silent "no store wired" pass.
      expect(result.reply).not.toMatch(/no store wired/i);
      const gate = commitGate(events);
      expect(gate.verdict).toBe("error");
      expect(gate.checkName).toBe("confirm_ports_incomplete");
    }

    await expectIncompleteFailClosed(ports());

    // Missing only sessionUserId
    const store = createInMemoryProposalStore({ userId: USER_A });
    await expectIncompleteFailClosed(ports({ proposalStore: store }));

    // Missing only proposalStore
    await expectIncompleteFailClosed(ports({ sessionUserId: USER_A }));
  });

  // ── F2 ──────────────────────────────────────────────────────────────────

  it("F2 failNextCommit → error gate; proposal stays proposed; zero meal rows", async () => {
    const store = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    // FaultInjectable is test-only — production ProposalStore does not have it.
    const faultStore: ProposalStore & FaultInjectable = store;
    const proposal = await store.store(sampleInput(USER_A));

    faultStore.failNextCommit("injected-db-failure");

    const { events, result } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: true,
        },
        ports({ proposalStore: store, sessionUserId: USER_A }),
      ),
    );

    const gate = commitGate(events);
    expect(gate.verdict).toBe("error");
    expect(gate.evidence).toBe("injected-db-failure");
    // cause is evidence only — reply must not claim committed
    expect(result.reply).not.toMatch(/confirmed/i);
    expect(result.reply).toMatch(/failed/i);

    expect(store.proposals[0].status).toBe("proposed");
    expect(store.mealLedger).toHaveLength(0);

    // One-shot: next commit succeeds
    const second = await store.commitProposalAndInsertMeal(proposal.id);
    expect(second.kind).toBe("committed");
  });

  // ── F3 ──────────────────────────────────────────────────────────────────

  it("F3 failNextVoid → error gate; proposal stays proposed; stream does not claim rejected", async () => {
    const store = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const faultStore: ProposalStore & FaultInjectable = store;
    const proposal = await store.store(sampleInput(USER_A));

    faultStore.failNextVoid("injected-void-failure");

    const { events, result } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: false,
        },
        ports({ proposalStore: store, sessionUserId: USER_A }),
      ),
    );

    const gate = commitGate(events);
    expect(gate.verdict).toBe("error");
    expect(gate.evidence).toBe("injected-void-failure");

    // Fail closed: must NOT claim rejected/voided
    expect(result.reply).not.toMatch(/rejected|voided/i);
    expect(result.reply).toMatch(/failed/i);
    expect(store.proposals[0].status).toBe("proposed");
    expect(store.mealLedger).toHaveLength(0);
  });

  // ── F4 ──────────────────────────────────────────────────────────────────

  const notCommittable = [
    {
      checkpoint: "commit",
      verdict: "block",
      checkName: "not_committable",
    },
  ];

  it("F4 decline cross-tenant → not_committable; no void", async () => {
    const proposals: Proposal[] = [];
    const storeA = createInMemoryProposalStore({
      userId: USER_A,
      proposals,
      now: () => FIXED_TS,
    });
    const storeB = createInMemoryProposalStore({
      userId: USER_B,
      proposals,
      now: () => FIXED_TS,
    });
    const proposal = await storeA.store(sampleInput(USER_A));

    const { events } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: false,
        },
        ports({ proposalStore: storeB, sessionUserId: USER_B }),
      ),
    );

    expect(commitGateShape(events)).toEqual(notCommittable);
    expect(proposals[0].status).toBe("proposed");
  });

  it("F4 decline missing → not_committable", async () => {
    const store = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });

    const { events } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: "missing-id",
          confirmed: false,
        },
        ports({ proposalStore: store, sessionUserId: USER_A }),
      ),
    );

    expect(commitGateShape(events)).toEqual(notCommittable);
  });

  it("F4 decline already committed → not_committable; status unchanged", async () => {
    const store = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const proposal = await store.store(sampleInput(USER_A));
    await store.commitProposalAndInsertMeal(proposal.id);

    const { events } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: false,
        },
        ports({ proposalStore: store, sessionUserId: USER_A }),
      ),
    );

    expect(commitGateShape(events)).toEqual(notCommittable);
    expect(store.proposals[0].status).toBe("committed");
  });
});
