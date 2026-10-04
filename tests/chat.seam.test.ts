// The chat route's seam into `turn()` (#135 review finding, 2026-09-17).
//
// This file exists because the seam silently dropped every evidence port:
// `assembleChatTurnPorts` accepted `evidenceText`, `evidenceSet`,
// `citationRegistry`, `retrievedEvidence` and `retrievalProvenance` in its input
// type and forwarded none of them, so through the only production entry point the
// model saw no evidence at all and the citation gate — which fail-closes when the
// evidence set is absent — stripped every citation.
//
// Nothing noticed, and the reason is worth keeping: the V1.1 acceptance evidence
// (a smoke script and the turn-level tests) hand-wires ports straight into
// `turn()`, which is a *different* seam from the one the product uses. A test that
// builds its own ports cannot fail when the route stops building them. So this
// asserts the forwarding itself, on the seam the route actually calls.
//
// It is also the guard for the pre-existing half: the V1.0 evidence trio was
// dropped here from the day it landed, which means the pinned evidence never
// reached the model in production either.

import { describe, expect, it } from "vitest";
import { assembleChatTurnPorts } from "../src/lib/chatApi";
import { Tracer } from "../src/harness/tracer";
import type { ModelAdapter } from "../src/harness/types";
import type { TurnEvidenceSet, TurnRetrieval } from "../src/harness/turn";

const adapter: ModelAdapter = {
  async generate() {
    return { content: "ok", stop: true };
  },
};

const EVIDENCE_SET: TurnEvidenceSet = {
  sourceVersion: "sources/catalog.json@test",
  sectionIds: ["ods-vitamin-d#vitamin-d-introduction"],
};

const RETRIEVAL: TurnRetrieval = {
  sourceVersion: "sources/catalog.json@test",
  hits: [
    {
      sectionId: "ods-vitamin-d#vitamin-d-introduction",
      chunkId: "ods-vitamin-d#vitamin-d-introduction#c1",
      score: 0.0164,
      via: ["lexical", "vector"],
    },
  ],
};

const registry = { entries: async () => [] };

describe("the chat seam forwards every evidence port", () => {
  it("carries the pinned trio and the retrieval pair into TurnPorts", () => {
    const assembly = assembleChatTurnPorts({
      kind: "utterance",
      adapter,
      tracer: new Tracer(),
      evidenceText: "PINNED-TEXT",
      evidenceSet: EVIDENCE_SET,
      citationRegistry: registry,
      retrievedEvidence: "RETRIEVED-TEXT",
      retrievalProvenance: RETRIEVAL,
    });

    if (!assembly.ok) throw new Error(`assembly failed: ${assembly.reason}`);
    const ports = assembly.ports;

    expect(ports.evidenceText).toBe("PINNED-TEXT");
    expect(ports.evidenceSet).toEqual(EVIDENCE_SET);
    expect(ports.citationRegistry).toBe(registry);
    expect(ports.retrievedEvidence).toBe("RETRIEVED-TEXT");
    expect(ports.retrievalProvenance).toEqual(RETRIEVAL);
  });

  it("still assembles without any evidence, since a corpus is optional", () => {
    const assembly = assembleChatTurnPorts({ kind: "utterance", adapter, tracer: new Tracer() });
    if (!assembly.ok) throw new Error(`assembly failed: ${assembly.reason}`);

    // Absent rather than defaulted: "no corpus was assembled" and "the corpus was
    // empty" are different, and only the second is a configured turn.
    expect(assembly.ports.evidenceText).toBeUndefined();
    expect(assembly.ports.evidenceSet).toBeUndefined();
    expect(assembly.ports.retrievalProvenance).toBeUndefined();
  });
});
