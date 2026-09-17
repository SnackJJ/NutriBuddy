// Ingest planning and application (S4 / #107 / RFC 0011 §3.2).
//
// The three paths the RFC names are the three tests below: unchanged content is
// skipped, changed content supersedes rather than deletes, and a document that
// goes away is archived — the last one only in the sense that the registry stops
// calling it active. What matters in all three is that an old citation can still
// be resolved afterwards, because that is what makes a superseded version worth
// keeping.

import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  ingestDocument,
  planChunks,
  planIngest,
  rechunkDocument,
  type ChunkRow,
  type RegistryStore,
  type SectionRow,
  type SourceRow,
} from "../src/evidence/ingest";
import type { CorpusDocument } from "../src/evidence/corpus";

function document(overrides: Partial<CorpusDocument> = {}): CorpusDocument {
  const sections = overrides.sections ?? [
    {
      id: "ods-x#intro",
      sectionPath: "X / Introduction",
      heading: "Introduction",
      ordinal: 1,
      text: "Vitamin X is a thing.",
      contentHash: "hash-intro",
      pinned: true,
    },
    {
      id: "ods-x#detail",
      sectionPath: "X / Detail",
      heading: "Detail",
      ordinal: 2,
      text: "More detail.",
      contentHash: "hash-detail",
      pinned: false,
    },
  ];

  return {
    slug: "ods-x",
    id: "ods-x@2024",
    title: "X — fact sheet",
    publisher: "NIH",
    url: "https://example.invalid/x",
    license: "U.S. federal government work — public domain",
    licenseEvidence: "https://example.invalid/policies",
    licenseFlags: [],
    authorityLevel: 1,
    docVersion: "2024",
    contentHash: "doc-hash-1",
    sections,
    ...overrides,
  };
}

function memoryStore(seed: readonly SourceRow[] = []): RegistryStore & {
  readonly sources: SourceRow[];
  readonly sections: SectionRow[];
  readonly superseded: string[];
  readonly chunks: ChunkRow[];
} {
  const sources = [...seed];
  const sections: SectionRow[] = [];
  const superseded: string[] = [];
  const chunks: ChunkRow[] = [];

  return {
    sources,
    sections,
    superseded,
    chunks,
    async findActiveSource(slug) {
      const row = sources.find((candidate) => candidate.slug === slug && candidate.status === "active");
      return row ? { id: row.id, contentHash: row.content_hash } : undefined;
    },
    async insertSource(row) {
      sources.push(row);
    },
    async markSuperseded(sourceId) {
      superseded.push(sourceId);
      const row = sources.find((candidate) => candidate.id === sourceId);
      if (row) sources[sources.indexOf(row)] = { ...row, status: "superseded" };
    },
    async existingSectionIds(sourceId) {
      return sections.filter((row) => row.source_id === sourceId).map((row) => row.id);
    },
    async upsertSections(rows) {
      for (const row of rows) {
        const index = sections.findIndex((candidate) => candidate.id === row.id);
        if (index >= 0) sections[index] = row;
        else sections.push(row);
      }
    },
    async replaceChunks(sourceId, rows) {
      // Derived data: replaced, never accumulated. Rows of other versions stay.
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        if (chunks[index].source_id === sourceId) chunks.splice(index, 1);
      }
      chunks.push(...rows);
    },
  };
}

describe("planIngest", () => {
  it("inserts when the document has never been seen", () => {
    const plan = planIngest(document(), undefined);
    expect(plan.action).toBe("insert");
    expect(plan.sections).toBe(2);
    expect(plan.pinned).toBe(1);
  });

  it("skips an unchanged document, so ingested_at keeps its meaning", () => {
    const plan = planIngest(document(), { id: "ods-x@2024", contentHash: "doc-hash-1" });
    expect(plan.action).toBe("skip");
  });

  it("skips when only the version label changed but the bytes did not", () => {
    // The hash is what the rows are compared on: a re-fetch that produced
    // identical text has not changed the evidence.
    const plan = planIngest(document({ id: "ods-x@2025", docVersion: "2025" }), {
      id: "ods-x@2024",
      contentHash: "doc-hash-1",
    });
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("only the version label differs");
  });

  it("supersedes a changed document and names the version it replaces", () => {
    const plan = planIngest(document({ contentHash: "doc-hash-2" }), {
      id: "ods-x@2024",
      contentHash: "doc-hash-1",
    });
    expect(plan.action).toBe("supersede-and-insert");
    expect(plan.supersedes).toBe("ods-x@2024");
  });
});

describe("ingestDocument", () => {
  it("writes the source and its sections on the first run", async () => {
    const store = memoryStore();
    const outcome = await ingestDocument(store, document());

    expect(outcome.written).toBe(true);
    expect(store.sources).toHaveLength(1);
    expect(store.sources[0]).toMatchObject({ id: "ods-x@2024", status: "active" });
    expect(store.sections).toHaveLength(2);
    expect(store.sections.find((row) => row.id === "ods-x#intro")?.pinned).toBe(true);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const store = memoryStore();
    await ingestDocument(store, document());
    const before = JSON.stringify(store.sources);

    const second = await ingestDocument(store, document());

    expect(second.plan.action).toBe("skip");
    expect(second.written).toBe(false);
    expect(JSON.stringify(store.sources)).toBe(before);
  });

  it("keeps the old version and its sections when content changes", async () => {
    const store = memoryStore();
    await ingestDocument(store, document());

    const changed = document({
      id: "ods-x@2025",
      docVersion: "2025",
      contentHash: "doc-hash-2",
      sections: [
        {
          id: "ods-x#intro",
          sectionPath: "X / Introduction",
          heading: "Introduction",
          ordinal: 1,
          text: "Vitamin X is a thing, revised.",
          contentHash: "hash-intro-2",
          pinned: true,
        },
      ],
    });
    const outcome = await ingestDocument(store, changed);

    expect(outcome.plan.action).toBe("supersede-and-insert");
    expect(store.superseded).toEqual(["ods-x@2024"]);
    // Both versions present: the old row is how an old citation stays resolvable.
    expect(store.sources.map((row) => row.id).sort()).toEqual(["ods-x@2024", "ods-x@2025"]);
    expect(store.sources.find((row) => row.id === "ods-x@2024")?.status).toBe("superseded");
    expect(store.sources.find((row) => row.id === "ods-x@2025")?.status).toBe("active");
  });

  it("writes nothing on a dry run", async () => {
    const store = memoryStore();
    const outcome = await ingestDocument(store, document(), { dry: true });
    expect(outcome.plan.action).toBe("insert");
    expect(outcome.written).toBe(false);
    expect(store.sources).toHaveLength(0);
    expect(store.sections).toHaveLength(0);
  });
});

describe("buildSnapshot", () => {
  it("records what a release pins, sorted by slug", () => {
    const snapshot = buildSnapshot(
      [document({ slug: "b" }), document({ slug: "a", id: "a@2024" })],
      { maxSections: 40, maxChars: 24000, sections: 1, chars: 100 },
      "2026-09-14T00:00:00.000Z",
    );

    expect(snapshot.sources.map((entry) => entry.slug)).toEqual(["a", "b"]);
    expect(snapshot.sources[0]).toMatchObject({ sections: 2, pinned: 1 });
    expect(snapshot.pinnedBudget.maxSections).toBe(40);
  });

  it("records what the retrieval index holds, and names the excluded sections", () => {
    const snapshot = buildSnapshot(
      [
        document({
          sections: [
            {
              id: "ods-x#intro",
              sectionPath: "X / Introduction",
              heading: "Introduction",
              ordinal: 1,
              text: "Vitamin X is a thing.",
              contentHash: "hash-intro",
              pinned: true,
            },
            {
              id: "ods-x#references",
              sectionPath: "X / References",
              heading: "References",
              ordinal: 2,
              text: "A. Author. Title. Journal. 2024. ".repeat(20),
              contentHash: "hash-refs",
              pinned: false,
            },
          ],
        }),
      ],
      { maxSections: 40, maxChars: 24000, sections: 1, chars: 100 },
      "2026-09-14T00:00:00.000Z",
    );

    expect(snapshot.chunks.sections).toBe(1);
    expect(snapshot.chunks.total).toBe(1);
    expect(snapshot.chunks.bibliography.sections).toBe(1);
    expect(snapshot.chunks.bibliography.sectionIds).toEqual(["ods-x#references"]);
    // Named with the size of what the exclusion saved, not just a count of one.
    expect(snapshot.chunks.bibliography.chunks).toBeGreaterThan(0);
  });
});

describe("chunks", () => {
  const bibliography = {
    id: "ods-x#references",
    sectionPath: "X / References",
    heading: "References",
    ordinal: 3,
    text: "A. Author. Title. Journal. 2024. ".repeat(30),
    contentHash: "hash-refs",
    pinned: false,
  };

  const withBibliography = (extra: Partial<CorpusDocument> = {}) =>
    document({
      sections: [...document().sections, bibliography],
      ...extra,
    });

  it("keeps a bibliography out of the index and names it in the plan", () => {
    const plan = planChunks(withBibliography());

    expect(plan.rows.map((row) => row.section_id)).toEqual(["ods-x#intro", "ods-x#detail"]);
    expect(plan.bibliography.sections).toBe(1);
    expect(plan.bibliography.sectionIds).toEqual(["ods-x#references"]);
    // The excluded section's text is long enough to have produced chunks.
    expect(plan.bibliography.chunks).toBeGreaterThan(0);
  });

  it("writes chunk rows on the first run, with the section path kept apart", async () => {
    const store = memoryStore();
    const outcome = await ingestDocument(store, document());

    expect(outcome.chunks).toBe(2);
    expect(store.chunks).toHaveLength(2);
    expect(store.chunks[0]).toMatchObject({
      id: "ods-x#intro#c1",
      section_id: "ods-x#intro",
      source_id: "ods-x@2024",
      ordinal: 1,
      heading_text: "X / Introduction",
      text: "Vitamin X is a thing.",
      embedding: null,
    });
  });

  it("is idempotent: a second run does not accumulate chunks", async () => {
    const store = memoryStore();
    await ingestDocument(store, document());
    const before = JSON.stringify(store.chunks);

    const second = await ingestDocument(store, document());

    expect(second.plan.action).toBe("skip");
    expect(JSON.stringify(store.chunks)).toBe(before);
    expect(store.chunks).toHaveLength(2);
  });

  it("keeps the superseded version's chunks, because its sections stay citable", async () => {
    const store = memoryStore();
    await ingestDocument(store, document());
    await ingestDocument(
      store,
      document({ id: "ods-x@2025", docVersion: "2025", contentHash: "doc-hash-2" }),
    );

    expect(store.chunks.map((row) => row.source_id)).toEqual(["ods-x@2024", "ods-x@2024", "ods-x@2025", "ods-x@2025"]);
  });

  it("fills the vector from the embedding port as a pgvector literal", async () => {
    const store = memoryStore();
    const embedded: string[] = [];
    const embed = {
      async embed(texts: readonly string[]) {
        embedded.push(...texts);
        return texts.map(() => Array.from({ length: 384 }, (_, index) => index / 1000));
      },
    };

    await ingestDocument(store, document(), { embed });

    // Embedded under its index text: the section path is part of what the vector
    // sees, which is the whole reason the prefix exists.
    expect(embedded[0]).toBe("X / Introduction\n\nVitamin X is a thing.");
    const vector = JSON.parse(store.chunks[0].embedding ?? "null") as number[];
    expect(vector).toHaveLength(384);
    expect(vector[1]).toBeCloseTo(0.001);
  });

  it("rebuilds chunks without touching the registry, for a changed rule or model", async () => {
    const store = memoryStore();
    await ingestDocument(store, document());
    store.chunks.splice(0, store.chunks.length, {
      ...store.chunks[0],
      text: "stale",
    });
    const sourcesBefore = JSON.stringify(store.sources);

    const plan = await rechunkDocument(store, document());

    expect(plan.chunks).toBe(2);
    expect(store.chunks).toHaveLength(2);
    expect(store.chunks[0].text).toBe("Vitamin X is a thing.");
    expect(JSON.stringify(store.sources)).toBe(sourcesBefore);
  });

  it("produces the same rows twice, so a rebuild is not a diff", () => {
    expect(JSON.stringify(planChunks(document()).rows)).toBe(JSON.stringify(planChunks(document()).rows));
  });
});
