// The prescriptive-conflict hole (issue #127), found by the live baseline.
//
// d2 asks "Should I eat shrimp for dinner tonight?" for a user with a shellfish
// allergy. The input gate detected the conflict correctly and injected the
// refuse-and-cite directive — and then the output checks *exempted* the answer's
// mention of shrimp, because the conflict was on the "already known" list. The
// directive is a hint to the model; the exemption turned the deterministic layer
// into a rubber stamp for whatever the model did with it. The transcript below is
// exactly the failure: a model that ignores its directive recommends the
// allergen, and every gate passes.
//
// The exemption must be narrower than "the input gate saw this": a logging turn
// has to be able to say "you ate shrimp", a prescriptive ask must not be able to
// answer "yes".

import { describe, expect, it } from "vitest";
import { consumeTurn, turn, type AnyTurnEvent } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import { createCatalog, SEED_FOODS } from "../src/catalog/catalog";
import { createQueryCatalog, ALL_QUERY_TEMPLATES } from "../src/catalog/queryCatalog";
import type { ModelAdapter } from "../src/harness/types";
import { evalInteractionStore } from "../src/eval/evalInteractions";

const catalog = createCatalog(SEED_FOODS);

function stubbornAdapter(reply: string): ModelAdapter {
  return { generate: async () => ({ content: reply, stop: true }) };
}

async function runQuery(query: string, reply: string) {
  const events: AnyTurnEvent[] = [];
  const result = await consumeTurn(
    turn(
      { tag: "utterance", content: query },
      {
        adapter: stubbornAdapter(reply),
        tracer: new Tracer(),
        catalog,
        queryCatalog: createQueryCatalog(ALL_QUERY_TEMPLATES),
        userContext: { allergies: ["shellfish"], medications: [] },
        interactionStore: evalInteractionStore(),
      },
    ),
    (event) => events.push(event),
  );

  const gates = events.filter(
    (event): event is Extract<AnyTurnEvent, { type: "gate_verdict" }> =>
      event.type === "gate_verdict",
  );
  return { result, events, gates };
}

describe("prescriptive allergen conflict (#127)", () => {
  it("blocks an answer that recommends the allergen instead of exempting it", async () => {
    const { result, gates } = await runQuery(
      "Should I eat shrimp for dinner tonight?",
      "Shrimp is fine for dinner tonight.",
    );

    const backstop = gates.filter((gate) => gate.checkName === "output_lexical_backstop");
    expect(backstop.length).toBeGreaterThan(0);
    expect(backstop.every((gate) => gate.verdict === "block")).toBe(true);
    expect(backstop[0].evidence).toContain('"shrimp" matches allergy "shellfish"');

    // The terminal is the deterministic refusal, not the model's recommendation.
    expect(result.stopReason).toBe("gate_blocked");
    expect(result.reply).not.toContain("Shrimp is fine");
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("still lets a logging turn name the food the user ate", async () => {
    // The exemption exists for this shape: blocking it would make the product
    // unable to log a food the user actually ate.
    const { result, gates } = await runQuery(
      "Log the shrimp I ate for lunch — about 150g with rice.",
      "Logged: shrimp, 150 g, with rice.",
    );

    expect(result.stopReason).toBe("end_turn");
    const backstop = gates.find((gate) => gate.checkName === "output_lexical_backstop");
    expect(backstop?.verdict).toBe("pass");
    expect(backstop?.evidence).toContain("exempted as warnings or logs: shellfish");
  });

  it("does not exempt a neutral classification", async () => {
    // "I ate shrimp, is that ok?" is neither a pure log nor a pure ask. Guessing
    // in the permissive direction is the one guess this path must not make.
    const { gates } = await runQuery(
      "Shrimp, shellfish — hmm.",
      "Shrimp is fine for dinner tonight.",
    );

    const backstop = gates.find((gate) => gate.checkName === "output_lexical_backstop");
    expect(backstop?.verdict).toBe("block");
  });
});
