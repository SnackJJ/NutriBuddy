// RFC 0001 Step 0 keep goldens (K1–K14) at gate/verdict grain.
//
// Goldens freeze checkpoint + verdict + stable reason code structure via
// canonicalizeTurnEvents / commitGateShape. Side-effects (ledger rows,
// proposal status) are asserted via store inspection, not event evidence.

import { describe, expect, it } from "vitest";
import {
  turn,
  type AnyTurnEvent,
  type TurnGateVerdictEvent,
  type TurnInput,
  type TurnPorts,
  type TurnResult,
} from "../src/harness/turn";
import {
  canonicalizeTurnEvents,
  commitGateShape,
} from "../src/harness/canonicalizeTurnEvents";
import { Tracer } from "../src/harness/tracer";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../src/harness/types";
import {
  createCatalog,
  nutritionPer100g,
  SEED_FOODS,
  type Catalog,
  type CatalogFood,
} from "../src/catalog/catalog";
import { createLogMealHandler, LOG_MEAL_SCHEMA } from "../src/harness/logMeal";
import type { Proposal, ProposalInput } from "../src/harness/logMeal";
import { createInMemoryProposalStore } from "./helpers/inMemoryProposalStore";

const FIXED_TS = "2026-07-17T12:00:00.000Z";
const USER_A = "user-a-k-fixtures";
const USER_B = "user-b-k-fixtures";

type AdapterImpl = (
  req: ModelRequest,
) => ModelResponse | Promise<ModelResponse>;

function stubAdapter(impl: AdapterImpl): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

function fixedClock(): () => Date {
  return () => new Date(FIXED_TS);
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

function createPorts(
  impl: AdapterImpl = () => ({ content: "OK", stop: true }),
  overrides: Partial<TurnPorts> = {},
): TurnPorts {
  return {
    adapter: stubAdapter(impl),
    tracer: new Tracer(),
    clock: fixedClock(),
    ...overrides,
  };
}

function gateShape(
  events: readonly AnyTurnEvent[],
): readonly {
  readonly checkpoint: string;
  readonly verdict: string;
  readonly checkName: string;
}[] {
  return events
    .filter(
      (e): e is TurnGateVerdictEvent => e.type === "gate_verdict",
    )
    .map((e) => ({
      checkpoint: e.checkpoint,
      verdict: e.verdict,
      checkName: e.checkName,
    }));
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

function catalog(): Catalog {
  return createCatalog(SEED_FOODS);
}

// ── K1: Normal utterance → final ──────────────────────────────────────────

describe("RFC 0001 keep goldens", () => {
  it("K1 normal utterance → final: seam order, output+commit pass", async () => {
    const input: TurnInput = {
      tag: "utterance",
      content: "How much protein in an egg?",
    };
    const ports = createPorts(() => ({
      content: "About 6g of protein per large egg.",
      stop: true,
    }));

    const { events, result } = await collect(turn(input, ports));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn_start");
    expect(types[types.length - 1]).toBe("turn_end");
    expect(types).toContain("model_call");
    expect(types).toContain("step");
    // Seam order at gate grain: turn_start → input gate → … → output gate → commit gate → turn_end
    const gateIdx = types
      .map((t, i) => (t === "gate_verdict" ? i : -1))
      .filter((i) => i >= 0);
    expect(gateIdx.length).toBeGreaterThanOrEqual(3);
    expect(gateIdx[0]).toBeGreaterThan(0); // after turn_start
    expect(gateIdx[gateIdx.length - 1]).toBeLessThan(types.length - 1);
    expect(result.stopReason).toBe("end_turn");

    const shape = gateShape(events);
    expect(shape).toEqual(
      expect.arrayContaining([
        {
          checkpoint: "input",
          verdict: "pass",
          checkName: "pre_gate_input_check",
        },
        {
          checkpoint: "output",
          verdict: "pass",
          checkName: "post_gate_output_check",
        },
        {
          checkpoint: "commit",
          verdict: "pass",
          checkName: "commit_gate_check",
        },
      ]),
    );

    // Canonicalize is stable for goldens
    expect(canonicalizeTurnEvents(events)).toMatchObject(
      events.map((e) =>
        expect.objectContaining({
          type: e.type,
          timestamp: "<ts>",
        }),
      ),
    );
  });

  // ── K2: Utterance → write_proposal ──────────────────────────────────────

  it("K2 utterance → write_proposal: terminal write_proposal, zero meal rows", async () => {
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const cat = catalog();
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls++;
      if (calls === 1) {
        return {
          content: "",
          stop: false,
          toolCalls: [
            {
              id: "call-log-k2",
              name: "log_meal",
              args: {
                food_name: "chicken breast",
                portion_g: 200,
                meal_type: "lunch",
              },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "Proposed logging chicken breast.", stop: true };
    });

    const ports = createPorts(undefined, {
      adapter,
      tools: new Map([
        [
          "log_meal",
          createLogMealHandler({
            catalog: cat,
            proposalStore,
            userId: USER_A,
          }),
        ],
      ]),
      toolSchemas: [LOG_MEAL_SCHEMA],
      proposalStore,
      sessionUserId: USER_A,
      catalog: cat,
    });

    const { events, result } = await collect(
      turn({ tag: "utterance", content: "log 200g chicken breast for lunch" }, ports),
    );

    expect(result.stopReason).toBe("write_proposal");
    expect(result.proposal).toBeDefined();
    expect(proposalStore.mealLedger.length).toBe(0);
    expect(proposalStore.proposals[0]?.status).toBe("proposed");

    expect(commitGateShape(events)).toEqual([
      {
        checkpoint: "commit",
        verdict: "pass",
        checkName: "commit_gate_check",
      },
    ]);
  });

  // ── K3: Confirm success ─────────────────────────────────────────────────

  it("K3 confirm success: commit pass + ledger lineage", async () => {
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const proposal = await proposalStore.store(sampleInput(USER_A));

    const { events, result } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: true,
        },
        createPorts(undefined, {
          proposalStore,
          sessionUserId: USER_A,
        }),
      ),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.reply).toContain("confirmed");
    expect(proposalStore.proposals[0].status).toBe("committed");
    expect(proposalStore.mealLedger).toHaveLength(1);
    expect(proposalStore.mealLedger[0].proposalId).toBe(proposal.id);
    // K3 / issue #76: id lineage on structured terminal fields.
    expect(result.commit).toEqual({
      proposalId: proposal.id,
      mealLogId: proposalStore.mealLedger[0].id,
    });

    expect(commitGateShape(events)).toEqual([
      {
        checkpoint: "commit",
        verdict: "pass",
        checkName: "commit_gate_check",
      },
    ]);

    const canonical = canonicalizeTurnEvents(events);
    expect(canonical.map((e) => (e as { type: string }).type)).toEqual([
      "turn_start",
      "gate_verdict",
      "gate_verdict",
      "turn_end",
    ]);
  });

  // ── K4: Reject success ──────────────────────────────────────────────────

  it("K4 reject success: commit pass, status voided, zero meal rows", async () => {
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const proposal = await proposalStore.store(sampleInput(USER_A));

    const { events, result } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: false,
        },
        createPorts(undefined, {
          proposalStore,
          sessionUserId: USER_A,
        }),
      ),
    );

    expect(result.reply).toContain("rejected");
    expect(result.commit).toBeUndefined();
    expect(proposalStore.proposals[0].status).toBe("voided");
    expect(proposalStore.mealLedger).toHaveLength(0);
    expect(commitGateShape(events)).toEqual([
      {
        checkpoint: "commit",
        verdict: "pass",
        checkName: "commit_gate_check",
      },
    ]);
  });

  // ── K5 / K6 / K7: not_committable collapse ──────────────────────────────

  const notCommittableGate = [
    {
      checkpoint: "commit",
      verdict: "block",
      checkName: "not_committable",
    },
  ];

  it("K5 confirm cross-tenant → not_committable; no status change; no insert", async () => {
    const proposals: Proposal[] = [];
    const mealLedger = [] as ReturnType<
      typeof createInMemoryProposalStore
    >["mealLedger"];
    const storeA = createInMemoryProposalStore({
      userId: USER_A,
      proposals,
      mealLedger,
      now: () => FIXED_TS,
    });
    const storeB = createInMemoryProposalStore({
      userId: USER_B,
      proposals,
      mealLedger,
      now: () => FIXED_TS,
    });
    const proposal = await storeA.store(sampleInput(USER_A));

    const { events } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: true,
        },
        createPorts(undefined, {
          proposalStore: storeB,
          sessionUserId: USER_B,
        }),
      ),
    );

    expect(commitGateShape(events)).toEqual(notCommittableGate);
    expect(proposals[0].status).toBe("proposed");
    expect(mealLedger).toHaveLength(0);
  });

  it("K6 confirm non-proposed → same gate shape as K5; no second insert", async () => {
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const proposal = await proposalStore.store(sampleInput(USER_A));
    await proposalStore.commitProposalAndInsertMeal(proposal.id);
    expect(proposalStore.mealLedger).toHaveLength(1);

    const { events } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: proposal.id,
          confirmed: true,
        },
        createPorts(undefined, {
          proposalStore,
          sessionUserId: USER_A,
        }),
      ),
    );

    expect(commitGateShape(events)).toEqual(notCommittableGate);
    expect(proposalStore.mealLedger).toHaveLength(1);
    expect(proposalStore.proposals[0].status).toBe("committed");
  });

  it("K7 confirm missing proposal → same gate shape as K5; no insert", async () => {
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });

    const { events } = await collect(
      turn(
        {
          tag: "proposal_confirm",
          proposalId: "proposal-does-not-exist",
          confirmed: true,
        },
        createPorts(undefined, {
          proposalStore,
          sessionUserId: USER_A,
        }),
      ),
    );

    expect(commitGateShape(events)).toEqual(notCommittableGate);
    expect(proposalStore.mealLedger).toHaveLength(0);
  });

  it("K5/K6/K7 commit-gate shapes are identical", async () => {
    // Re-run three fixtures and compare commitGateShape only
    async function shapeFor(
      setup: () => Promise<{
        proposalStore: ReturnType<typeof createInMemoryProposalStore>;
        proposalId: string;
        sessionUserId: string;
      }>,
    ) {
      const { proposalStore, proposalId, sessionUserId } = await setup();
      const { events } = await collect(
        turn(
          {
            tag: "proposal_confirm",
            proposalId,
            confirmed: true,
          },
          createPorts(undefined, { proposalStore, sessionUserId }),
        ),
      );
      return commitGateShape(events);
    }

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
    const p = await storeA.store(sampleInput(USER_A));

    const k5 = await shapeFor(async () => ({
      proposalStore: storeB,
      proposalId: p.id,
      sessionUserId: USER_B,
    }));

    const committedStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const p6 = await committedStore.store(sampleInput(USER_A));
    await committedStore.commitProposalAndInsertMeal(p6.id);
    const k6 = await shapeFor(async () => ({
      proposalStore: committedStore,
      proposalId: p6.id,
      sessionUserId: USER_A,
    }));

    const emptyStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const k7 = await shapeFor(async () => ({
      proposalStore: emptyStore,
      proposalId: "missing",
      sessionUserId: USER_A,
    }));

    expect(k5).toEqual(k6);
    expect(k6).toEqual(k7);
    expect(k5).toEqual(notCommittableGate);
  });

  // ── K8: Input gate prescriptive ─────────────────────────────────────────

  it("K8 input gate prescriptive: pass + refuse-and-cite directive", async () => {
    const cat = catalog();
    const seen: ModelRequest[] = [];
    const { events, result } = await collect(
      turn(
        {
          tag: "utterance",
          content: "Should I eat shrimp for dinner?",
        },
        createPorts(
          (req) => {
            seen.push(req);
            return {
              content:
                "I can't recommend shrimp — shellfish allergy. Consult a dietitian.",
              stop: true,
            };
          },
          {
            catalog: cat,
            userContext: { allergies: ["shellfish"], medications: [] },
            interactionStore: { all: async () => [] },
          },
        ),
      ),
    );

    const inputGate = gateShape(events).find((g) => g.checkpoint === "input");
    expect(inputGate).toEqual({
      checkpoint: "input",
      verdict: "pass",
      checkName: "pre_gate_input_check",
    });
    const inputEvent = events.find(
      (e): e is TurnGateVerdictEvent =>
        e.type === "gate_verdict" && e.checkpoint === "input",
    );
    expect(inputEvent?.evidence).toMatch(/prescriptive|Refuse-and-cite/i);
    expect(seen[0].messages.some((m) =>
      m.content.includes("[INPUT GATE DIRECTIVE — REFUSE AND CITE]"),
    )).toBe(true);
    expect(result.stopReason).toBe("end_turn");
  });

  // ── K9: Input gate descriptive ──────────────────────────────────────────

  it("K9 input gate descriptive: advise directive, advisory path armed", async () => {
    const cat = catalog();
    const { events, result } = await collect(
      turn(
        {
          tag: "utterance",
          content: "Log the shrimp I ate for lunch",
        },
        createPorts(() => ({ content: "Noted shrimp for lunch.", stop: true }), {
          catalog: cat,
          userContext: { allergies: ["shellfish"], medications: [] },
          interactionStore: { all: async () => [] },
        }),
      ),
    );

    const inputEvent = events.find(
      (e): e is TurnGateVerdictEvent =>
        e.type === "gate_verdict" && e.checkpoint === "input",
    );
    expect(inputEvent?.verdict).toBe("pass");
    expect(inputEvent?.evidence).toMatch(/descriptive|advise/i);
    expect(result.stopReason).toBe("end_turn");
  });

  // ── K10: typed_miss ─────────────────────────────────────────────────────

  it("K10 typed_miss: tool gate pass + miss reason; no minted food id", async () => {
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls++;
      if (calls === 1) {
        return {
          content: "",
          stop: false,
          toolCalls: [
            {
              id: "call-miss",
              name: "log_meal",
              args: { food_name: "xyzzy-unknown-food", portion_g: 100 },
            } satisfies ToolCall,
          ],
        };
      }
      return {
        content: "I couldn't find that food. Could you clarify?",
        stop: true,
      };
    });
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const cat = catalog();

    const { events, result } = await collect(
      turn(
        { tag: "utterance", content: "log xyzzy-unknown-food" },
        createPorts(undefined, {
          adapter,
          tools: new Map([
            [
              "log_meal",
              createLogMealHandler({
                catalog: cat,
                proposalStore,
                userId: USER_A,
              }),
            ],
          ]),
          toolSchemas: [LOG_MEAL_SCHEMA],
          proposalStore,
          sessionUserId: USER_A,
          catalog: cat,
        }),
      ),
    );

    const toolGate = events.find(
      (e): e is TurnGateVerdictEvent =>
        e.type === "gate_verdict" && e.checkpoint === "tool",
    );
    expect(toolGate?.verdict).toBe("pass");
    expect(toolGate?.evidence).toMatch(/typed miss|miss_/i);
    expect(result.stopReason).not.toBe("write_proposal");
    expect(proposalStore.proposals).toHaveLength(0);
  });

  // ── K11: typed_error ────────────────────────────────────────────────────

  it("K11 typed_error: tool gate error", async () => {
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls++;
      if (calls === 1) {
        return {
          content: "",
          stop: false,
          toolCalls: [
            {
              id: "call-err",
              name: "log_meal",
              // invalid args → handler returns {error:...} typed_error
              args: { food_name: "", portion_g: -1 },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "Sorry, that failed.", stop: true };
    });
    const proposalStore = createInMemoryProposalStore({
      userId: USER_A,
      now: () => FIXED_TS,
    });
    const cat = catalog();

    const { events } = await collect(
      turn(
        { tag: "utterance", content: "log bad args" },
        createPorts(undefined, {
          adapter,
          tools: new Map([
            [
              "log_meal",
              createLogMealHandler({
                catalog: cat,
                proposalStore,
                userId: USER_A,
              }),
            ],
          ]),
          toolSchemas: [LOG_MEAL_SCHEMA],
          proposalStore,
          sessionUserId: USER_A,
          catalog: cat,
        }),
      ),
    );

    const toolGate = events.find(
      (e): e is TurnGateVerdictEvent =>
        e.type === "gate_verdict" && e.checkpoint === "tool",
    );
    expect(toolGate?.verdict).toBe("error");
    expect(toolGate?.checkName).toBe("tool_gate_check");
  });

  // ── K12: Output gate retry → pass ───────────────────────────────────────

  it("K12 output gate retry → pass within max regenerations", async () => {
    // Lexical block then self-correct: recommend peanuts → safe alternative.
    let callCount = 0;
    const allergyAdapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "I recommend peanuts for protein!",
          stop: true,
        };
      }
      return {
        content: "Chicken breast is a solid protein option.",
        stop: true,
      };
    });

    const { events, result } = await collect(
      turn(
        { tag: "utterance", content: "protein ideas?" },
        createPorts(undefined, {
          adapter: allergyAdapter,
          userContext: { allergies: ["peanut"], medications: [] },
          interactionStore: { all: async () => [] },
        }),
      ),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(callCount).toBeLessThanOrEqual(3); // original + ≤2 regenerations
    expect(callCount).toBeGreaterThanOrEqual(2);
    const commit = commitGateShape(events);
    expect(commit[0]?.verdict).toBe("pass");
  });

  // ── K13: Output gate exhaust ────────────────────────────────────────────

  it("K13 output gate exhaust → gate_blocked + commit block", async () => {
    const adapter = stubAdapter(() => ({
      content: "I recommend peanuts for protein!",
      stop: true,
    }));

    const { events, result } = await collect(
      turn(
        { tag: "utterance", content: "protein ideas?" },
        createPorts(undefined, {
          adapter,
          userContext: { allergies: ["peanut"], medications: [] },
          interactionStore: { all: async () => [] },
        }),
      ),
    );

    expect(result.stopReason).toBe("gate_blocked");
    expect(commitGateShape(events)).toEqual([
      {
        checkpoint: "commit",
        verdict: "block",
        checkName: "commit_gate_check",
      },
    ]);
  });

  // ── K14: Untagged not recommendable ─────────────────────────────────────

  it("K14 untagged food fails closed on entity check", async () => {
    const untagged: CatalogFood = {
      id: "food-untagged-001",
      canonicalName: "mystery grain",
      aliases: [],
      per100g: nutritionPer100g({
        kcal: 100,
        proteinG: 5,
        fatG: 1,
        carbsG: 20,
      }),
      // allergenTags intentionally omitted → not recommendable
      portionAliases: {},
      category: "grain",
    };
    const cat = createCatalog([...SEED_FOODS, untagged]);

    const adapter = stubAdapter(() => ({
      content: "",
      stop: false,
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call-sa-k14",
          name: "submit_answer",
          args: {
            prose: "Try this grain option.",
            foodRefs: [
              {
                foodId: "food-untagged-001",
                foodName: "mystery grain",
                matchType: "exact",
              },
            ],
            ruleRefs: [],
          },
        } satisfies ToolCall,
      ],
    }));

    const { events, result } = await collect(
      turn(
        { tag: "utterance", content: "snack idea?" },
        createPorts(undefined, {
          adapter,
          catalog: cat,
          userContext: { allergies: [], medications: [] },
          interactionStore: { all: async () => [] },
        }),
      ),
    );

    const entity = events.filter(
      (e): e is TurnGateVerdictEvent =>
        e.type === "gate_verdict" && e.checkName === "output_entity_check",
    );
    expect(entity.length).toBeGreaterThanOrEqual(1);
    expect(entity.some((e) => e.verdict === "block")).toBe(true);
    expect(entity.some((e) => /not recommendable|no reviewed allergen/i.test(e.evidence))).toBe(
      true,
    );
    expect(result.stopReason).toBe("gate_blocked");
  });
});
