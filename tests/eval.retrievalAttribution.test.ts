// Attribution for cases that should have cited and did not (#136 / RFC 0013 §6).
//
// The buckets are the point: a citation-support rate that falls short can be four
// different failures, and three of them are not the product's. "Retrieval was not
// wired" is a fact about the run (the scripted arm has no corpus); "retrieval is
// down" is an outage; "the corpus has nothing" is a content gap; only "sections
// were supplied and the answer used none" is a capability result. Reporting one
// number without them invites the same misreading #129 fixed for provider faults.

import { describe, expect, it } from "vitest";
import { citationSupportOf } from "../src/eval/summary";
import { runHarnessEval } from "../src/eval/harness-runner";
import type { EvalCase, HarnessResult } from "../src/eval/types";
import type { ModelAdapter, TypedOutput } from "../src/harness/types";
import type { CitationRegistryEntry } from "../src/harness/citationGate";
import type { EvidenceTextSource } from "../src/evidence/retrievalContext";

const SECTION = "ods-vitamin-d#vitamin-d-introduction";

function declared(id: string): EvalCase {
  return { id, query: `why does ${id} matter`, category: "evidence", expected: { shouldCite: true } };
}

function result(id: string, overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    caseId: id,
    response: "ok",
    steps: 2,
    stopReason: "end_turn",
    passed: true,
    violations: [],
    toolCalls: [],
    gateBlocks: 0,
    durationMs: 1,
    citations: { kept: 0, stripped: false, claimedAuthorityWithoutCitation: false },
    ...overrides,
  };
}

describe("citation attribution buckets", () => {
  const cases = [declared("v1"), declared("v2"), declared("v3"), declared("v4")];

  it("names a run with no corpus as unwired rather than as a capability gap", () => {
    const support = citationSupportOf(cases, [result("v1"), result("v2")]);

    expect(support.unwired).toEqual(["v1", "v2"]);
    expect(support.retrievalMiss).toEqual([]);
    expect(support.retrievalUnavailable).toEqual([]);
    expect(support.citedNothing).toEqual([]);
  });

  it("separates a corpus gap from an outage", () => {
    const support = citationSupportOf(cases, [
      result("v1", { retrieval: { hits: 0, degraded: "no_hits" } }),
      result("v2", { retrieval: { hits: 0, degraded: "unavailable" } }),
    ]);

    expect(support.retrievalMiss).toEqual(["v1"]);
    expect(support.retrievalUnavailable).toEqual(["v2"]);
    expect(support.unwired).toEqual([]);
  });

  it("names a case that was given evidence and cited none of it", () => {
    const support = citationSupportOf(cases, [result("v1", { retrieval: { hits: 3 } })]);
    expect(support.citedNothing).toEqual(["v1"]);
  });

  it("keeps a supported case out of every bucket", () => {
    const support = citationSupportOf(cases, [
      result("v1", {
        retrieval: { hits: 2 },
        citations: { kept: 1, stripped: false, claimedAuthorityWithoutCitation: false },
      }),
    ]);

    expect(support.supported).toBe(1);
    expect(support.rate).toBeCloseTo(0.25);
    for (const bucket of [support.unwired, support.retrievalMiss, support.retrievalUnavailable, support.citedNothing]) {
      expect(bucket).toEqual([]);
    }
  });

  it("counts a case the run never measured in the denominator, not in a bucket", () => {
    const support = citationSupportOf(cases, [result("v1", { citations: undefined })]);
    expect(support.measured).toBe(0);
    expect(support.declared).toBe(4);
    expect(support.unwired).toEqual([]);
  });
});

// ── the eval path can actually move the metric ──────────────────────────────

describe("harness runner with a corpus wired", () => {
  const texts: EvidenceTextSource = {
    async loadSections(ids) {
      return ids.map((id) => ({
        id,
        sourceId: "ods-vitamin-d",
        docVersion: "2024",
        sectionPath: "Vitamin D / Introduction",
        anchor: null,
        text: "Vitamin D promotes calcium absorption.",
      }));
    },
    async loadChunks() {
      return [];
    },
  };

  const retriever = {
    async retrieve() {
      return {
        hits: [{ sectionId: SECTION, chunkId: `${SECTION}#c1`, score: 1, via: ["vector"] as const }],
      };
    },
  };

  const registry: { entries(ids: readonly string[]): Promise<readonly CitationRegistryEntry[]> } = {
    entries: async () => [
      { sectionId: SECTION, sourceId: "ods-vitamin-d", docVersion: "2024", status: "active" },
    ],
  };

  const citing: TypedOutput = {
    prose: "Vitamin D helps the body absorb calcium.",
    foodRefs: [],
    ruleRefs: [],
    citations: [{ sectionId: SECTION, sourceId: "ods-vitamin-d", docVersion: "2024" }],
  };

  const adapter: ModelAdapter = {
    async generate() {
      return { content: citing.prose, stop: true, output: citing };
    },
  };

  it("runs retrieval per case and reports a citation that survived the gate", async () => {
    const cases = [declared("v1")];
    const [outcome] = await runHarnessEval(
      cases,
      adapter,
      new Map(),
      undefined,
      undefined,
      undefined,
      {
        pinnedSet: { sourceVersion: "sources/catalog.json@test", sectionIds: [] },
        citationRegistry: registry,
        retrieval: { retriever, texts, sourceVersion: "sources/catalog.json@test" },
      },
    );

    expect(outcome.retrieval).toEqual({ hits: 1 });
    expect(outcome.citations?.kept).toBe(1);

    // And the summary reads that as support rather than as one more miss.
    const support = citationSupportOf(cases, [outcome]);
    expect(support.supported).toBe(1);
    expect(support.rate).toBe(1);
  });

  it("attributes no_hits to the corpus rather than to the answer", async () => {
    const [outcome] = await runHarnessEval(
      [declared("v1")],
      adapter,
      new Map(),
      undefined,
      undefined,
      undefined,
      {
        pinnedSet: { sourceVersion: "sources/catalog.json@test", sectionIds: [] },
        citationRegistry: registry,
        retrieval: {
          retriever: { async retrieve() { return { hits: [], degraded: "no_hits" as const }; } },
          texts,
          sourceVersion: "sources/catalog.json@test",
        },
      },
    );

    expect(outcome.retrieval).toEqual({ hits: 0, degraded: "no_hits" });
    expect(citationSupportOf([declared("v1")], [outcome]).retrievalMiss).toEqual(["v1"]);
  });

  it("turns a retriever that throws into an outage, not a failed case", async () => {
    const [outcome] = await runHarnessEval(
      [declared("v1")],
      adapter,
      new Map(),
      undefined,
      undefined,
      undefined,
      {
        pinnedSet: { sourceVersion: "sources/catalog.json@test", sectionIds: [] },
        citationRegistry: registry,
        retrieval: {
          retriever: {
            async retrieve() {
              throw new Error("edge function unreachable");
            },
          },
          texts,
          sourceVersion: "sources/catalog.json@test",
        },
      },
    );

    // The case still produced a result, and the report can say why it had no
    // citation (a run that threw would have measured nothing at all).
    expect(outcome.retrieval).toEqual({ hits: 0, degraded: "unavailable" });
    expect(citationSupportOf([declared("v1")], [outcome]).retrievalUnavailable).toEqual(["v1"]);
  });

  it("leaves the metric unattributed-but-present when no corpus is wired", async () => {
    const [outcome] = await runHarnessEval([declared("v1")], adapter, new Map());

    expect(outcome.retrieval).toBeUndefined();
    expect(outcome.citations?.kept).toBe(0);
    expect(citationSupportOf([declared("v1")], [outcome]).unwired).toEqual(["v1"]);
  });
});
