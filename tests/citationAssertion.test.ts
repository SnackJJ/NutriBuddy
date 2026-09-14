// Citation assertion backstop (S4 / #110 / RFC 0011 §3.6).
//
// The rule the tests pin: an answer may cite nothing, and an answer may claim
// authority — what it may not do is claim authority while citing nothing. The
// ordering property matters as much as the rule: this check runs after the
// provenance strip, so a citation that will not reach the user cannot satisfy it.

import { describe, expect, it } from "vitest";
import {
  ASSERTION_PHRASES,
  checkCitationAssertions,
} from "../src/harness/citationAssertion";
import { consumeTurn, turn, type AnyTurnEvent } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import type { CitationRef, ModelAdapter, TypedOutput } from "../src/harness/types";

function output(overrides: Partial<TypedOutput> = {}): TypedOutput {
  return { prose: "Have some chicken.", foodRefs: [], ruleRefs: [], ...overrides };
}

/** The check reads the prose the user sees plus the citations, like the gate does. */
function assertions(typed: TypedOutput | undefined, reply = "") {
  return checkCitationAssertions({
    prose: typed?.prose ?? reply,
    citations: typed?.citations,
  });
}

const CITATION: CitationRef = {
  sectionId: "ods-vitamin-d#vitamin-d-recommended-intakes",
  sourceId: "ods-vitamin-d",
  docVersion: "2024",
};

describe("checkCitationAssertions", () => {
  it("lets an answer with no authority claim pass, citation or not", () => {
    expect(assertions(output()).passed).toBe(true);
    expect(assertions({ prose: "You ate 150 g of rice.", foodRefs: [], ruleRefs: [] }).passed).toBe(true);
    // A reply with no typed output at all: prose is prose.
    expect(checkCitationAssertions({ prose: "You ate 150 g of rice.", citations: undefined }).passed).toBe(true);
  });

  it("blocks an authority claim with no citation, naming the phrase", () => {
    const result = assertions(
      output({ prose: "The Dietary Guidelines recommend two servings of fish per week." }),
    );

    expect(result.passed).toBe(false);
    expect(result.matched.join(" ")).toMatch(/dietary guidelines/i);
    expect(result.reasons[0]).toContain("cites no evidence section");
  });

  it("accepts the same claim once a citation is present", () => {
    const result = assertions(
      output({
        prose: "The Dietary Guidelines recommend two servings of fish per week.",
        citations: [CITATION],
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.matched.length).toBeGreaterThan(0);
    expect(result.reasons).toEqual([]);
  });

  it("treats an empty citation array as no citation, not as a checked answer", () => {
    const result = assertions(
      output({ prose: "According to the NIH, vitamin D matters.", citations: [] }),
    );
    expect(result.passed).toBe(false);
  });

  it("catches the same claim in the prompt's other language", () => {
    for (const prose of ["膳食指南推荐每周吃两次鱼。", "指南建议补充维生素 D。"]) {
      expect(assertions(output({ prose })).passed).toBe(false);
    }
  });

  it("does not fire on food descriptions that merely mention an authority's data", () => {
    // "according to USDA" is deliberately in the list (it attributes a number to
    // an authority), but a sentence that reports a catalog observation without
    // attributing it must not be blocked.
    expect(
      assertions(output({ prose: "Chicken breast has 31 g of protein per 100 g." })).passed,
    ).toBe(true);
  });

  it("keeps the phrase list small enough to read", () => {
    // Not a style rule: every phrase here can block a legitimate answer, and a
    // list that grows by accretion is how a backstop becomes a tax.
    expect(ASSERTION_PHRASES.length).toBeLessThanOrEqual(14);
  });
});

// ── inside a turn: tier-2 retries, tier-1 does not ─────────────────────────

function adapterReturning(outputs: readonly TypedOutput[]): {
  adapter: ModelAdapter;
  calls: () => number;
} {
  let call = 0;
  return {
    adapter: {
      generate: async () => {
        const next = outputs[Math.min(call, outputs.length - 1)];
        call += 1;
        return { content: next.prose, stop: true, output: next };
      },
    },
    calls: () => call,
  };
}

async function run(outputs: readonly TypedOutput[]) {
  const events: AnyTurnEvent[] = [];
  const { adapter, calls } = adapterReturning(outputs);
  const result = await consumeTurn(
    turn(
      { tag: "utterance", content: "What do the guidelines say about fish?" },
      { adapter, tracer: new Tracer() } as never,
    ),
    (event) => events.push(event),
  );
  return { events, result, calls };
}

describe("citation assertion inside a turn", () => {
  it("retries an authority claim, then refuses deterministically", async () => {
    const claiming = output({ prose: "The Dietary Guidelines recommend two servings of fish per week." });
    const { events, result, calls } = await run([claiming, claiming, claiming]);

    const assertionVerdicts = events.filter(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_assertion",
    );
    expect(assertionVerdicts.length).toBeGreaterThan(1);
    expect(assertionVerdicts.every((event) => event.type === "gate_verdict" && event.verdict === "block")).toBe(true);
    expect(result.stopReason).toBe("gate_blocked");
    // The shared budget: one initial attempt plus two regenerations.
    expect(calls()).toBe(3);
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("stops retrying as soon as the claim is dropped or cited", async () => {
    const claiming = output({ prose: "The Dietary Guidelines recommend two servings of fish per week." });
    const fixed = output({ prose: "Fish twice a week is a reasonable target.", citations: [CITATION] });

    const { result } = await run([claiming, fixed]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.reply).toBe("Fish twice a week is a reasonable target.");
  });

  it("does not spend a retry on an answer that simply has no citation", async () => {
    // Deliberately free of numbers and allergens, so the only check that could
    // object here is the citation one — and it must not.
    const plain = output({ prose: "That meal is on file for today." });
    const { events, result, calls } = await run([plain]);

    const assertionVerdicts = events.filter(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_assertion",
    );
    expect(assertionVerdicts).toHaveLength(1);
    expect(assertionVerdicts[0].type === "gate_verdict" && assertionVerdicts[0].verdict).toBe("pass");
    expect(result.stopReason).toBe("end_turn");
    expect(calls()).toBe(1);
  });
});
