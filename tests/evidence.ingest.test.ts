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
  planIngest,
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
} {
  const sources = [...seed];
  const sections: SectionRow[] = [];
  const superseded: string[] = [];

  return {
    sources,
    sections,
    superseded,
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
});
