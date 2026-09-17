// Retrieval at the turn seam (V1.1 / RFC 0013 §5, issue #135).
//
// The four things worth asserting here are the ones the design turns on: the
// retrieved block rides the *dynamic* region (so the cached pinned prefix is
// byte-identical with and without it), it sits ahead of the question, a citation
// to a retrieved section passes the gate while one to an unknown section is still
// stripped, and a retrieval outage is reported rather than silently producing an
// answer that looks like the corpus had nothing.

import { describe, expect, it } from "vitest";
import { consumeTurn, turn, type AnyTurnEvent, type TurnEvidenceSet } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import type { ModelAdapter, ModelRequest, TypedOutput } from "../src/harness/types";
import type { CitationRegistryEntry } from "../src/harness/citationGate";
import { createInMemoryRetriever } from "../src/evidence/retrieval";
import {
  loadRetrievalEvidence,
  withRetrievedSections,
  type EvidenceTextSource,
} from "../src/evidence/retrievalContext";

const QUESTION = "Why is vitamin D important for health?";

const CHUNKS = [
  {
    chunkId: "ods-vitamin-d#vitamin-d-introduction#c1",
    sectionId: "ods-vitamin-d#vitamin-d-introduction",
    text: "Vitamin D promotes calcium absorption in the gut and is needed for bone growth.",
  },
  {
    chunkId: "ods-zinc#zinc-introduction#c1",
    sectionId: "ods-zinc#zinc-introduction",
    text: "Zinc is involved in immune function and cell division.",
  },
];

const TEXTS: EvidenceTextSource = {
  async loadSections(ids) {
    return ids.map((id) => ({
      id,
      sourceId: id.split("#")[0],
      docVersion: "2024",
      sectionPath: id.split("#")[1].replace(/-/g, " "),
      anchor: null,
      text: CHUNKS.find((chunk) => chunk.sectionId === id)?.text ?? "",
    }));
  },
  async loadChunks(ids) {
    return ids.flatMap((id) => {
      const chunk = CHUNKS.find((candidate) => candidate.chunkId === id);
      return chunk ? [{ id: chunk.chunkId, sectionId: chunk.sectionId, headingText: "", text: chunk.text }] : [];
    });
  },
};

const PINNED: TurnEvidenceSet = {
  sourceVersion: "sources/catalog.json@test",
  sectionIds: ["ods-iron#iron-recommended-intakes"],
};

const RETRIEVED_SECTION = "ods-vitamin-d#vitamin-d-introduction";

function adapterCapturing(output: TypedOutput): { adapter: ModelAdapter; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    adapter: {
      generate: async (request) => {
        requests.push(request);
        return { content: output.prose, stop: true, output };
      },
    },
  };
}

async function runTurn(options: {
  readonly output: TypedOutput;
  readonly retrievedEvidence?: string;
  readonly evidenceSet?: TurnEvidenceSet;
  readonly retrievalProvenance?: Parameters<typeof turn>[1] extends never ? never : unknown;
  readonly registry?: { entries(ids: readonly string[]): Promise<readonly CitationRegistryEntry[]> };
}) {
  const { adapter, requests } = adapterCapturing(options.output);
  const events: AnyTurnEvent[] = [];
  const result = await consumeTurn(
    turn(
      { tag: "utterance", content: QUESTION },
      {
        adapter,
        tracer: new Tracer(),
        ...(options.retrievedEvidence ? { retrievedEvidence: options.retrievedEvidence } : {}),
        ...(options.evidenceSet ? { evidenceSet: options.evidenceSet } : {}),
        ...(options.retrievalProvenance ? { retrievalProvenance: options.retrievalProvenance } : {}),
        ...(options.registry ? { citationRegistry: options.registry } : {}),
      } as never,
    ),
    (event) => events.push(event),
  );
  return { events, result, requests };
}

/** The pipeline the route runs: retrieve, render, merge, then hand the turn both halves. */
async function retrieve(query = QUESTION, limit?: number) {
  return loadRetrievalEvidence({
    retriever: createInMemoryRetriever(CHUNKS),
    texts: TEXTS,
    query,
    sourceVersion: PINNED.sourceVersion,
    limit,
  });
}

const ACTIVE_ENTRY: CitationRegistryEntry = {
  sectionId: RETRIEVED_SECTION,
  sourceId: "ods-vitamin-d",
  docVersion: "2024",
  status: "active",
};

function citing(sectionId: string): TypedOutput {
  return {
    prose: "Vitamin D helps the body absorb calcium.",
    foodRefs: [],
    ruleRefs: [],
    citations: [{ sectionId, sourceId: sectionId.split("#")[0], docVersion: "2024" }],
  };
}

describe("retrieved evidence at the turn seam", () => {
  it("rides the dynamic region, ahead of the question, leaving the system message unchanged", async () => {
    const retrieved = await retrieve();
    const control = await runTurn({ output: citing(RETRIEVED_SECTION) });
    const withRetrieval = await runTurn({
      output: citing(RETRIEVED_SECTION),
      retrievedEvidence: retrieved.text,
    });

    const systemOf = (requests: ModelRequest[]) => requests[0].messages[0].content;
    // The whole reason retrieval cannot live in the pinned region: the cached
    // prefix has to stay byte-identical between a turn that retrieved and one
    // that did not.
    expect(systemOf(withRetrieval.requests)).toBe(systemOf(control.requests));
    expect(systemOf(control.requests)).not.toContain("RETRIEVED EVIDENCE");

    const userMessage = withRetrieval.requests[0].messages.at(-1)?.content ?? "";
    expect(userMessage.startsWith("[RETRIEVED EVIDENCE")).toBe(true);
    expect(userMessage).toContain("Vitamin D promotes calcium absorption");
    // Sources first, then the question they answer.
    expect(userMessage.indexOf("[RETRIEVED EVIDENCE")).toBeLessThan(userMessage.indexOf(QUESTION));
  });

  it("records what retrieval contributed on turn_start, so a trace can replay it", async () => {
    const retrieved = await retrieve();
    const { events } = await runTurn({
      output: citing(RETRIEVED_SECTION),
      retrievedEvidence: retrieved.text,
      evidenceSet: withRetrievedSections(PINNED, retrieved.sectionIds),
      retrievalProvenance: retrieved.provenance,
    });

    const start = events.find((event) => event.type === "turn_start");
    if (start?.type !== "turn_start") throw new Error("no turn_start");
    expect(start.retrieval?.sourceVersion).toBe(PINNED.sourceVersion);
    expect(start.retrieval?.hits.map((hit) => hit.sectionId)).toEqual(retrieved.sectionIds);
    expect(start.retrieval?.degraded).toBeUndefined();
    // Ids, not text: the corpus is versioned, so a replay reloads the chunks.
    expect(JSON.stringify(start.retrieval)).not.toContain("Vitamin D promotes calcium");
  });

  it("makes a retrieved section citable, and leaves an unknown one stripped", async () => {
    const retrieved = await retrieve();
    const evidenceSet = withRetrievedSections(PINNED, retrieved.sectionIds);
    expect(evidenceSet?.sectionIds).toContain(RETRIEVED_SECTION);
    // The pinned set is still there: retrieval adds, it does not replace.
    expect(evidenceSet?.sectionIds).toContain("ods-iron#iron-recommended-intakes");

    const accepted = await runTurn({
      output: citing(RETRIEVED_SECTION),
      retrievedEvidence: retrieved.text,
      evidenceSet,
      registry: { entries: async () => [ACTIVE_ENTRY] },
    });
    const acceptedVerdict = accepted.events.find(
      (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
    );
    expect(accepted.result.output?.citations).toHaveLength(1);
    if (acceptedVerdict?.type !== "gate_verdict") throw new Error("no citation verdict");
    expect(acceptedVerdict.verdict).toBe("pass");

    const stripped = await runTurn({
      output: citing("ods-selenium#selenium-introduction"),
      retrievedEvidence: retrieved.text,
      evidenceSet,
      registry: { entries: async () => [] },
    });
    expect(stripped.result.output?.citations).toBeUndefined();
  });

  it("emits exactly one terminal event with and without retrieval", async () => {
    const retrieved = await retrieve();
    const { events } = await runTurn({
      output: citing(RETRIEVED_SECTION),
      retrievedEvidence: retrieved.text,
    });
    const terminals = events.filter((event) => event.type === "turn_end");
    expect(terminals).toHaveLength(1);
  });

  it("answers without retrieved evidence when retrieval is down, and says why", async () => {
    const retrieved = await loadRetrievalEvidence({
      retriever: {
        async retrieve() {
          return { hits: [], degraded: "unavailable" as const };
        },
      },
      texts: TEXTS,
      query: QUESTION,
      sourceVersion: PINNED.sourceVersion,
    });

    expect(retrieved.text).toBeUndefined();
    expect(retrieved.sectionIds).toEqual([]);

    const { events, result } = await runTurn({
      output: { prose: "Vitamin D matters for bone health.", foodRefs: [], ruleRefs: [] },
      evidenceSet: PINNED,
      retrievalProvenance: retrieved.provenance,
    });

    // The answer still goes out — degraded, not failed (ADR 0004 §4) — and the
    // trace says retrieval was unavailable rather than that the corpus was empty.
    expect(result.stopReason).toBe("end_turn");
    expect(result.output?.citations).toBeUndefined();
    const start = events.find((event) => event.type === "turn_start");
    if (start?.type !== "turn_start") throw new Error("no turn_start");
    expect(start.retrieval?.degraded).toBe("unavailable");
    expect(start.retrieval?.hits).toEqual([]);
  });

  it("keeps the whole-section rule: long sections are injected as a window", async () => {
    const longText = "x".repeat(3_000);
    const longTexts: EvidenceTextSource = {
      async loadSections() {
        return [
          {
            id: "ods-omega-3#omega-3-fatty-acids-omega-3s-and-health",
            sourceId: "ods-omega-3",
            docVersion: "2024",
            sectionPath: "Omega-3 Fatty Acids / Omega-3s and Health",
            anchor: null,
            text: longText,
          },
        ];
      },
      async loadChunks() {
        return [
          {
            id: "ods-omega-3#omega-3-fatty-acids-omega-3s-and-health#c3",
            sectionId: "ods-omega-3#omega-3-fatty-acids-omega-3s-and-health",
            headingText: "Omega-3 Fatty Acids / Omega-3s and Health",
            text: "the matched window",
          },
        ];
      },
    };

    const evidence = await loadRetrievalEvidence({
      retriever: {
        async retrieve() {
          return {
            hits: [
              {
                sectionId: "ods-omega-3#omega-3-fatty-acids-omega-3s-and-health",
                chunkId: "ods-omega-3#omega-3-fatty-acids-omega-3s-and-health#c3",
                score: 1,
                via: ["lexical"] as const,
              },
            ],
          };
        },
      },
      texts: longTexts,
      query: "omega-3 and heart health",
      sourceVersion: PINNED.sourceVersion,
    });

    expect(evidence.text).toContain("the matched window");
    expect(evidence.text).not.toContain(longText);
    expect(evidence.text).toContain("excerpt");
  });
});
