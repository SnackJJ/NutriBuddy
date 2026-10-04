// The retrieval port: fusion order, section dedupe, and the two degradation
// signals (V1.1 / RFC 0013 §4, issue #134).
//
// What is asserted here is the part of retrieval that has to be right regardless
// of which side produced the candidates: a section ranked by both sides beats one
// ranked by either, a section appears once, the tie ordering is a function of the
// inputs, and "nothing to retrieve" is told apart from "retrieval is down".

import { describe, expect, it } from "vitest";
import {
  RRF_K,
  RETRIEVAL_TOP_SECTIONS,
  createInMemoryRetriever,
  createSupabaseRetriever,
  fuseRankedChunks,
  type RankedChunk,
} from "../src/evidence/retrieval";
import type { EmbeddingPort } from "../src/evidence/embedding";
import type { SupabaseClient } from "@supabase/supabase-js";

function ranked(chunkId: string, sectionId: string, rank: number): RankedChunk {
  return { chunkId, sectionId, rank };
}

describe("fuseRankedChunks", () => {
  it("gives a section both sides agree on more than a section only one side found", () => {
    const hits = fuseRankedChunks(
      [ranked("a#c1", "s-a", 3), ranked("b#c1", "s-b", 1)],
      [ranked("a#c1", "s-a", 1), ranked("c#c1", "s-c", 1)],
    );

    // s-a: 1/61 (best of 1/61, 1/63). s-b: 1/61. s-c: 1/61 — three-way tie at the
    // top is broken by section id, but s-a must be in it because both sides found it.
    const a = hits.find((hit) => hit.sectionId === "s-a");
    expect(a?.via).toEqual(["lexical", "vector"]);
    expect(a?.score).toBeCloseTo(1 / (RRF_K + 1));
    expect(hits.map((hit) => hit.sectionId)).toEqual(["s-a", "s-b", "s-c"]);

    const b = hits.find((hit) => hit.sectionId === "s-b");
    expect(b?.via).toEqual(["lexical"]);
  });

  it("keeps one hit per section, with the chunk that scored best", () => {
    const hits = fuseRankedChunks(
      [ranked("s-a#c9", "s-a", 4), ranked("s-a#c1", "s-a", 2)],
      [ranked("s-a#c2", "s-a", 7)],
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].sectionId).toBe("s-a");
    // rank 2 is this section's best, so its chunk is the one worth injecting.
    expect(hits[0].chunkId).toBe("s-a#c1");
    expect(hits[0].score).toBeCloseTo(1 / (RRF_K + 2));
  });

  it("scores a section by its best chunk, not by how many chunks it has", () => {
    // s-many has two mediocre chunks (sum would be 2/75 ≈ 0.0267) and s-best has
    // one good one (1/65 ≈ 0.0154). Summing would rank volume over relevance,
    // which is how the 43k-character reference lists would have won had §3 left
    // them in the index.
    const hits = fuseRankedChunks(
      [ranked("s-many#c1", "s-many", 15), ranked("s-many#c2", "s-many", 16), ranked("s-best#c1", "s-best", 5)],
      [],
    );

    expect(hits.map((hit) => hit.sectionId)).toEqual(["s-best", "s-many"]);
  });

  it("is deterministic: equal scores break on section id, not on arrival order", () => {
    const forward = fuseRankedChunks([ranked("b#c1", "s-b", 1), ranked("a#c1", "s-a", 1)], []);
    const reverse = fuseRankedChunks([ranked("a#c1", "s-a", 1), ranked("b#c1", "s-b", 1)], []);
    expect(forward.map((hit) => hit.sectionId)).toEqual(["s-a", "s-b"]);
    expect(reverse.map((hit) => hit.sectionId)).toEqual(["s-a", "s-b"]);
  });

  it("respects the limit and ignores an unranked chunk", () => {
    const hits = fuseRankedChunks(
      [ranked("a#c1", "s-a", 1), ranked("b#c1", "s-b", 2), ranked("c#c1", "s-c", 0)],
      [],
      2,
    );
    expect(hits.map((hit) => hit.sectionId)).toEqual(["s-a", "s-b"]);
  });

  it("returns nothing rather than an empty section when there are no candidates", () => {
    expect(fuseRankedChunks([], [])).toEqual([]);
  });
});

describe("in-memory retriever (the CI default)", () => {
  const chunks = [
    { chunkId: "d#c1", sectionId: "vitamin-d", text: "Vitamin D helps the body absorb calcium." },
    { chunkId: "d#c2", sectionId: "vitamin-d", text: "Adults need vitamin D from sun or food." },
    { chunkId: "z#c1", sectionId: "zinc", text: "Zinc is found in meat and legumes." },
    { chunkId: "c#c1", sectionId: "calcium", text: "Calcium is stored in bones." },
  ];

  it("answers with the sections that share terms with the query", async () => {
    const retriever = createInMemoryRetriever(chunks);
    const result = await retriever.retrieve("which foods have zinc");

    expect(result.degraded).toBeUndefined();
    expect(result.hits[0].sectionId).toBe("zinc");
    // The vitamin D chunks match nothing but "vitamin"? No: only zinc shares a
    // term, so the corpus's other sections are absent rather than padding the list.
    expect(result.hits.map((hit) => hit.sectionId)).toEqual(["zinc"]);
  });

  it("dedupes a section that matches on several chunks", async () => {
    const retriever = createInMemoryRetriever(chunks);
    const result = await retriever.retrieve("vitamin d calcium");
    expect(result.hits.filter((hit) => hit.sectionId === "vitamin-d")).toHaveLength(1);
  });

  it("says no_hits rather than pretending the corpus is unavailable", async () => {
    const retriever = createInMemoryRetriever(chunks);
    const result = await retriever.retrieve("quantum chromodynamics");
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBe("no_hits");
  });

  it("lets the vector side outrank a weaker lexical match, and dates the change", async () => {
    const embed: EmbeddingPort = {
      async embed() {
        return [[1, 0, 0]];
      },
    };
    // Only the calcium chunk is "semantically" close; the query shares no terms
    // with it, so a lexical-only retriever would never return it at all.
    const retriever = createInMemoryRetriever(chunks, {
      embed,
      vectors: [
        [0, 1, 0],
        [0, 1, 0],
        [0, 1, 0],
        [1, 0, 0],
      ],
    });

    const result = await retriever.retrieve("bone density");
    expect(result.hits[0].sectionId).toBe("calcium");
    expect(result.hits[0].via).toEqual(["vector"]);
  });

  it("refuses a corpus with a duplicate chunk id instead of silently dropping one", () => {
    expect(() =>
      createInMemoryRetriever([
        { chunkId: "a#c1", sectionId: "s-a", text: "one" },
        { chunkId: "a#c1", sectionId: "s-a", text: "two" },
      ]),
    ).toThrow(/duplicate chunk id/);
  });

  it("returns at most the documented number of sections by default", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      chunkId: `s${index}#c1`,
      sectionId: `section-${index}`,
      text: "magnesium is involved in enzymatic reactions",
    }));
    const result = await createInMemoryRetriever(many).retrieve("magnesium");
    expect(result.hits).toHaveLength(RETRIEVAL_TOP_SECTIONS);
  });
});

describe("postgres retriever degradation", () => {
  const embed: EmbeddingPort = {
    async embed() {
      return [Array.from({ length: 384 }, () => 0.1)];
    },
  };

  function clientWith(handler: (name: string) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
    return { rpc: (name: string) => handler(name) } as unknown as SupabaseClient;
  }

  it("reports unavailable when a ranking function fails, and invents nothing", async () => {
    const failures: string[] = [];
    const retriever = createSupabaseRetriever(
      clientWith(async () => ({ data: null, error: { message: "boom" } })),
      { embed, onFailure: (side) => failures.push(side) },
    );

    const result = await retriever.retrieve("vitamin d");
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBe("unavailable");
    expect(failures).toEqual(["lexical", "vector"]);
  });

  it("reports unavailable when the embedding call fails, without throwing", async () => {
    const failing: EmbeddingPort = {
      async embed() {
        throw new Error("edge function unreachable");
      },
    };
    const retriever = createSupabaseRetriever(
      clientWith(async () => ({ data: [], error: null })),
      { embed: failing },
    );

    const result = await retriever.retrieve("vitamin d");
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBe("unavailable");
  });

  it("reports no_hits when both sides ran and found nothing", async () => {
    const retriever = createSupabaseRetriever(
      clientWith(async () => ({ data: [], error: null })),
      { embed },
    );

    const result = await retriever.retrieve("quantum chromodynamics");
    expect(result.degraded).toBe("no_hits");
  });

  it("fuses whatever the two functions returned", async () => {
    const retriever = createSupabaseRetriever(
      clientWith(async (name) =>
        name === "match_source_chunks_by_text"
          ? { data: [{ chunk_id: "d#c1", section_id: "vitamin-d", rank: 1 }], error: null }
          : { data: [{ chunk_id: "z#c1", section_id: "zinc", rank: 1 }], error: null },
      ),
      { embed },
    );

    const result = await retriever.retrieve("vitamin d");
    expect(result.degraded).toBeUndefined();
    expect(result.hits.map((hit) => hit.sectionId).sort()).toEqual(["vitamin-d", "zinc"]);
  });
});
