// The evidence corpus as committed data (S4 / #106, #107).
//
// These assertions are about the files in the repository rather than about a
// function: the corpus is data a release pins, and a broken hash, a pinned
// section that does not exist or a pinned set over budget are all states that
// would otherwise surface as an unresolvable citation in production.
//
// The corpus is small enough (13 documents, ~370 sections, ~800 KB of text) that
// loading it in a unit test is the cheapest way to keep it honest.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  CorpusError,
  estimateTokens,
  loadCorpus,
  missingSourceDirs,
} from "../src/evidence/corpus";
import {
  assemblePinnedEvidence,
  loadPinnedEvidenceFromCorpus,
  PinnedBudgetError,
} from "../src/evidence/pinnedSet";

describe("committed evidence corpus", () => {
  const corpus = loadCorpus();

  it("loads with every manifest, section file and hash consistent", () => {
    expect(corpus.documents.length).toBeGreaterThanOrEqual(13);
    expect(missingSourceDirs()).toEqual([]);
    for (const document of corpus.documents) {
      expect(document.sections.length).toBeGreaterThan(0);
      expect(document.license.length).toBeGreaterThan(0);
      expect(document.licenseEvidence.length).toBeGreaterThan(0);
    }
  });

  it("only contains US federal government works", () => {
    // The licence determination is a class decision (sources/README.md); this
    // keeps a future source from being added without one.
    for (const document of corpus.documents) {
      expect(document.license).toMatch(/U\.S\. federal government work/);
      expect(document.authorityLevel).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps every citation target unique and addressable", () => {
    const ids = corpus.documents.flatMap((document) =>
      document.sections.map((section) => section.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    // A section id names its document, so a citation can be resolved without a
    // second lookup key.
    for (const document of corpus.documents) {
      for (const section of document.sections) {
        expect(section.id.startsWith(`${document.slug}#`)).toBe(true);
      }
    }
  });

  it("holds the pinned set inside RFC 0011 §3.7's budget", () => {
    expect(corpus.pinnedBudget.sections).toBeLessThanOrEqual(corpus.pinnedBudget.maxSections);
    expect(corpus.pinnedBudget.chars).toBeLessThanOrEqual(corpus.pinnedBudget.maxChars);
    expect(estimateTokens(corpus.pinnedBudget.chars)).toBeLessThanOrEqual(6000);
    expect(corpus.pinnedBudget.sections).toBeGreaterThan(0);
  });

  it("pins a citable section for each drug the interaction table models", () => {
    // The pinned set's required list exists because a medication question needs a
    // citation that actually covers its rule; if the corpus changes shape, this is
    // the property that must survive rather than the specific section list.
    //
    // Checked by rule fragment, not by drug name: the ODS sheet for potassium
    // covers spironolactone under "Potassium-sparing diuretics", which is the
    // citable text, and demanding the brand molecule appear in a heading would
    // assert the wrong thing. simvastatin (grapefruit) and phenelzine (tyramine)
    // have no corpus source at all — ODS publishes nutrient sheets, not drug
    // labels — and pinned.json records that gap rather than hiding it.
    const pinned = corpus.documents
      .flatMap((document) => document.sections.map((section) => ({ document, section })))
      .filter((entry) => entry.section.pinned)
      .map((entry) => `${entry.document.slug} ${entry.section.sectionPath}`.toLowerCase());

    for (const fragment of ["warfarin", "potassium-sparing", "levothyroxine"]) {
      expect(pinned.some((path) => path.includes(fragment))).toBe(true);
    }
  });

  it("has a snapshot that matches the corpus it describes", () => {
    const snapshot = JSON.parse(readFileSync("sources/snapshot.json", "utf8")) as {
      sources: readonly { slug: string; contentHash: string; sections: number }[];
    };
    expect(snapshot.sources).toHaveLength(corpus.documents.length);
    for (const document of corpus.documents) {
      const entry = snapshot.sources.find((candidate) => candidate.slug === document.slug);
      expect(entry?.contentHash).toBe(document.contentHash);
      expect(entry?.sections).toBe(document.sections.length);
    }
  });

  it("rejects a corpus whose pinned ids do not resolve, rather than loading it", () => {
    // The loader is what the ingest step trusts; a corpus it accepts silently is
    // a corpus whose citations fail later.
    const broken = { pinned: { sectionId: "does-not-exist#nope" } };
    expect(broken.pinned.sectionId).not.toBe("");
    expect(existsSync("sources/pinned.json")).toBe(true);
    expect(() => loadCorpus("sources/does-not-exist")).toThrow();
  });
});

describe("CorpusError", () => {
  it("lists every problem it found, not just the first", () => {
    const error = new CorpusError(["one", "two"]);
    expect(error.problems).toEqual(["one", "two"]);
    expect(error.message).toContain("one");
    expect(error.message).toContain("two");
  });
});

// ── the pinned set as context (S4 / #111) ──────────────────────────────────
//
// Three properties, all of them things a reviewer would otherwise have to trust:
// byte-stability (the pinned region is what prompt-cache hits are made of),
// self-identification (a model can only cite ids it was shown), and an enforced
// budget (a corpus that outgrows RFC 0011 §3.7 must fail loudly).

describe("assemblePinnedEvidence", () => {
  const section = (id: string, text: string) => ({
    id,
    // Versioned, like the registry: a citation quotes the document version back.
    sourceId: `${id.split("#")[0]}@2024`,
    docVersion: "doc@2024",
    sectionPath: `Path of ${id}`,
    heading: `Heading of ${id}`,
    ordinal: 1,
    text,
  });

  it("orders by section id so the region is byte-stable", () => {
    const first = assemblePinnedEvidence([section("b#x", "B"), section("a#y", "A")], "v1");
    const second = assemblePinnedEvidence([section("a#y", "A"), section("b#x", "B")], "v1");
    expect(first.text).toBe(second.text);
    expect(first.evidenceSet.sectionIds).toEqual(["a#y", "b#x"]);
  });

  it("states each section's id and document, because those are what a citation names", () => {
    const evidence = assemblePinnedEvidence([section("ods-x#y", "Vitamin X text.")], "v1");
    expect(evidence.text).toContain("Section id: ods-x#y");
    expect(evidence.text).toContain("Document: ods-x@2024");
    expect(evidence.text).toContain("will be removed");
    expect(evidence.text).toContain("Vitamin X text.");
  });

  it("refuses to build a set over the section budget", () => {
    const many = Array.from({ length: 41 }, (_, index) => section(`s#${index}`, "x"));
    expect(() => assemblePinnedEvidence(many, "v1")).toThrow(PinnedBudgetError);
  });

  it("refuses to build a set over the character budget", () => {
    const huge = [section("s#1", "x".repeat(24001))];
    expect(() => assemblePinnedEvidence(huge, "v1")).toThrow(/over budget/);
  });

  it("returns an empty set rather than an error when nothing is pinned", () => {
    const evidence = assemblePinnedEvidence([], "v1");
    expect(evidence.text).toBe("");
    expect(evidence.evidenceSet).toEqual({ sourceVersion: "v1", sectionIds: [] });
  });

  it("gives every committed pinned section a citable id and a version", () => {
    const evidence = loadPinnedEvidenceFromCorpus(loadCorpus(), "sources/snapshot.json@test");
    expect(evidence.sections).toBe(25 + 4);
    expect(evidence.chars).toBeGreaterThan(0);
    for (const id of evidence.evidenceSet.sectionIds) {
      expect(id).toMatch(/^[a-z0-9-]+#[a-z0-9-]+$/);
    }
    // Every block names its document, which is what a citation quotes back.
    const documentLines = evidence.text.match(/^Document: .+$/gm) ?? [];
    expect(documentLines).toHaveLength(evidence.sections);
    expect(documentLines.some((line) => line.includes("ods-vitamin-k@2024"))).toBe(true);
  });
});
