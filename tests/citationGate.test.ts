// Citation provenance (S4 / #108, #109 / RFC 0011 §3.5).
//
// The four conditions are a truth table, so the tests are one too: exists ×
// status × version × membership, plus the two fail-closed paths (no evidence set,
// no registry). What the tests protect beyond the table is the *severity* split —
// a stripped citation is a `block` verdict that is not `terminal`, because the
// answer's numbers and allergens keep their own verdicts and the shared
// regenerate budget belongs to tier-2.

import { describe, expect, it } from "vitest";
import {
  checkCitations,
  citationEvidence,
  stripInvalidCitations,
  type CitationRegistryEntry,
} from "../src/harness/citationGate";
import { consumeTurn, turn, type AnyTurnEvent, type TurnEvidenceSet } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import type { CitationRef, ModelAdapter, TypedOutput } from "../src/harness/types";

const SECTION_A = "ods-vitamin-k#vitamin-k-interactions-with-medications-warfarin-coumadin-an";
const SECTION_B = "ods-potassium#potassium-interactions-with-medications-potassium-sparing-di";

const ACTIVE_ENTRY: CitationRegistryEntry = {
  sectionId: SECTION_A,
  sourceId: "ods-vitamin-k@2024",
  docVersion: "ods-vitamin-k@2024",
  status: "active",
};

function citation(overrides: Partial<CitationRef> = {}): CitationRef {
  return {
    sectionId: SECTION_A,
    sourceId: "ods-vitamin-k@2024",
    docVersion: "ods-vitamin-k@2024",
    ...overrides,
  };
}

function output(citations: readonly CitationRef[]): TypedOutput {
  return { prose: "Keep vitamin K intake steady.", foodRefs: [], ruleRefs: [], citations };
}

const EVIDENCE: TurnEvidenceSet = {
  sourceVersion: "sources/snapshot.json@2026-09-14",
  sectionIds: [SECTION_A, SECTION_B],
};

describe("checkCitations", () => {
  it("keeps a citation that satisfies all four conditions", () => {
    const result = checkCitations({
      output: output([citation()]),
      evidenceSet: EVIDENCE,
      entries: [ACTIVE_ENTRY],
    });

    expect(result.passed).toBe(true);
    expect(result.kept).toHaveLength(1);
    expect(result.stripped).toEqual([]);
  });

  it("strips an unknown section: the registry is the only source of what exists", () => {
    const result = checkCitations({
      output: output([citation({ sectionId: "made-up#section" })]),
      evidenceSet: { ...EVIDENCE, sectionIds: ["made-up#section"] },
      entries: [ACTIVE_ENTRY],
    });

    expect(result.passed).toBe(false);
    expect(result.stripped[0].reason).toContain("unknown section");
  });

  it("strips a citation to a superseded document, not just archived", () => {
    for (const status of ["superseded", "archived"] as const) {
      const result = checkCitations({
        output: output([citation()]),
        evidenceSet: EVIDENCE,
        entries: [{ ...ACTIVE_ENTRY, status }],
      });
      expect(result.passed).toBe(false);
      expect(result.stripped[0].reason).toContain(status);
    }
  });

  it("strips a version mismatch and names both versions", () => {
    const result = checkCitations({
      output: output([citation({ docVersion: "ods-vitamin-k@2023" })]),
      evidenceSet: EVIDENCE,
      entries: [ACTIVE_ENTRY],
    });

    expect(result.stripped[0].reason).toContain("cited ods-vitamin-k@2023");
    expect(result.stripped[0].reason).toContain("registry has ods-vitamin-k@2024");
  });

  it("strips a section the turn was never allowed to see", () => {
    const result = checkCitations({
      output: output([citation({ sectionId: SECTION_B, sourceId: "ods-potassium@2024", docVersion: "ods-potassium@2024" })]),
      evidenceSet: { ...EVIDENCE, sectionIds: [SECTION_A] },
      entries: [
        ACTIVE_ENTRY,
        {
          sectionId: SECTION_B,
          sourceId: "ods-potassium@2024",
          docVersion: "ods-potassium@2024",
          status: "active",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.stripped[0].reason).toContain("was not in this turn's evidence set");
  });

  it("fails closed when no evidence set was recorded", () => {
    const result = checkCitations({
      output: output([citation()]),
      evidenceSet: undefined,
      entries: [ACTIVE_ENTRY],
    });

    expect(result.passed).toBe(false);
    expect(result.kept).toEqual([]);
    expect(result.stripped[0].reason).toContain("no evidence set was recorded");
  });

  it("fails closed when the registry could not be read, and says why", () => {
    const result = checkCitations({
      output: output([citation()]),
      evidenceSet: EVIDENCE,
      entries: undefined,
      unavailableReason: "permission denied for table source_sections",
    });

    expect(result.passed).toBe(false);
    expect(result.stripped[0].reason).toContain("permission denied");
  });

  it("judges citations independently: one bad one does not take the good ones with it", () => {
    const result = checkCitations({
      output: output([citation(), citation({ sectionId: "made-up#section" })]),
      evidenceSet: EVIDENCE,
      entries: [ACTIVE_ENTRY],
    });

    expect(result.kept).toHaveLength(1);
    expect(result.stripped).toHaveLength(1);
    expect(result.passed).toBe(false);
  });

  it("passes an answer that makes no citation at all", () => {
    const result = checkCitations({
      output: { prose: "No evidence claim here.", foodRefs: [], ruleRefs: [] },
      evidenceSet: undefined,
      entries: undefined,
    });
    expect(result).toEqual({ passed: true, kept: [], stripped: [], reasons: [] });
  });
});

describe("stripInvalidCitations", () => {
  it("keeps the surviving citations and leaves the prose alone", () => {
    const stripped = stripInvalidCitations(output([citation({ sectionId: "made-up#s" })]), {
      passed: false,
      kept: [],
      stripped: [{ citation: citation(), reason: "x" }],
      reasons: ["x"],
    });

    expect(stripped?.prose).toBe("Keep vitamin K intake steady.");
    expect("citations" in (stripped ?? {})).toBe(false);
  });

  it("removes the field entirely when nothing survives, rather than leaving an empty array", () => {
    // `citations: []` reads as "I checked, there is nothing to cite" — a claim a
    // stripped answer has not earned.
    const striped = stripInvalidCitations(output([citation()]), {
      passed: false,
      kept: [],
      stripped: [{ citation: citation(), reason: "unknown" }],
      reasons: ["unknown"],
    });
    expect(Object.keys(striped ?? {})).toEqual(["prose", "foodRefs", "ruleRefs"]);
  });

  it("returns the output untouched when nothing was stripped", () => {
    const original = output([citation()]);
    expect(
      stripInvalidCitations(original, {
        passed: true,
        kept: [citation()],
        stripped: [],
        reasons: [],
      }),
    ).toBe(original);
  });
});

describe("citationEvidence", () => {
  it("says what was verified when nothing was stripped", () => {
    const text = citationEvidence({ passed: true, kept: [citation()], stripped: [], reasons: [] });
    expect(text).toContain("1 citation(s) verified");
  });

  it("lists each reason when something was stripped", () => {
    const text = citationEvidence({
      passed: false,
      kept: [],
      stripped: [{ citation: citation(), reason: "unknown section x#y" }],
      reasons: ["unknown section x#y"],
    });
    expect(text).toContain("unknown section x#y");
    expect(text).toContain("removed rather than answered with");
  });
});

// ── the tier-1 verdict, inside a real turn ─────────────────────────────────

function adapterReturning(output: TypedOutput): ModelAdapter {
  return {
    generate: async () => ({
      content: output.prose,
      stop: true,
      output,
    }),
  };
}

async function runTurnWith(
  output: TypedOutput,
  options: {
    readonly evidenceSet?: TurnEvidenceSet;
    readonly registry?: { entries(ids: readonly string[]): Promise<readonly CitationRegistryEntry[]> };
  },
) {
  const events: AnyTurnEvent[] = [];
  const result = await consumeTurn(
    turn(
      { tag: "utterance", content: "Is kale ok with warfarin?" },
      {
        adapter: adapterReturning(output),
        tracer: new Tracer(),
        ...(options.evidenceSet ? { evidenceSet: options.evidenceSet } : {}),
        ...(options.registry ? { citationRegistry: options.registry } : {}),
      } as never,
    ),
    (event) => events.push(event),
  );
  return { events, result };
}

describe("citation stripping inside a turn (#109)", () => {
  it("strips an unverifiable citation, blocks without being terminal, and still answers", async () => {
    const { events, result } = await runTurnWith(output([citation({ sectionId: "made-up#s" })]), {
      evidenceSet: EVIDENCE,
      registry: { entries: async () => [] },
    });

    const citationVerdict = events.find(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
    );
    expect(citationVerdict?.type).toBe("gate_verdict");
    if (citationVerdict?.type !== "gate_verdict") throw new Error("no citation verdict");
    expect(citationVerdict.verdict).toBe("block");
    // The whole point of tier-1: reported, not retried.
    expect(citationVerdict.terminal).toBe(false);

    // The answer itself is delivered, without the citation.
    expect(result.stopReason).toBe("end_turn");
    expect(result.output?.citations).toBeUndefined();
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("keeps a verifiable citation and reports it as verified", async () => {
    const { events, result } = await runTurnWith(output([citation()]), {
      evidenceSet: EVIDENCE,
      registry: { entries: async () => [ACTIVE_ENTRY] },
    });

    const citationVerdict = events.find(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
    );
    if (citationVerdict?.type !== "gate_verdict") throw new Error("no citation verdict");
    expect(citationVerdict.evidence).toContain("verified");
    expect(result.output?.citations).toHaveLength(1);
  });

  it("strips everything when no registry is wired, without failing the turn", async () => {
    const { events, result } = await runTurnWith(output([citation()]), { evidenceSet: EVIDENCE });

    const citationVerdict = events.find(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
    );
    if (citationVerdict?.type !== "gate_verdict") throw new Error("no citation verdict");
    expect(citationVerdict.evidence).toContain("no registry port is wired");
    expect(result.stopReason).toBe("end_turn");
  });

  it("says nothing when the answer made no citation claim", async () => {
    const { events } = await runTurnWith(
      { prose: "No citation claim.", foodRefs: [], ruleRefs: [] },
      { evidenceSet: EVIDENCE, registry: { entries: async () => [] } },
    );
    expect(
      events.some(
        (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
      ),
    ).toBe(false);
  });

  it("treats a registry that throws as unavailable rather than as permission to cite", async () => {
    const { events, result } = await runTurnWith(output([citation()]), {
      evidenceSet: EVIDENCE,
      registry: {
        entries: async () => {
          throw new Error("permission denied for table source_sections");
        },
      },
    });

    const citationVerdict = events.find(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
    );
    if (citationVerdict?.type !== "gate_verdict") throw new Error("no citation verdict");
    expect(citationVerdict.evidence).toContain("permission denied");
    expect(result.output?.citations).toBeUndefined();
  });
});
