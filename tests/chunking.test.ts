// The chunking rule (V1.1 / RFC 0013 §3, issue #133).
//
// Chunking is a pure function of a section, so the boundaries that matter are
// asserted directly rather than through a database: a paragraph is never
// stitched across, a paragraph over the cap degrades to sentences before it is
// hard-cut, overlap lands only where a size-driven cut happened and counts
// inside the cap, and a bibliography produces nothing at all.

import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkSection,
  isBibliography,
  type ChunkableSection,
} from "../src/evidence/chunking";

function section(overrides: Partial<ChunkableSection> = {}): ChunkableSection {
  return {
    id: "ods-calcium#calcium-recommended-intakes",
    sectionPath: "Calcium / Recommended Intakes",
    heading: "Recommended Intakes",
    text: "Adults need 1,000 mg of calcium a day.",
    ...overrides,
  };
}

/**
 * Deterministic prose of at least `chars` characters, always ending on a
 * sentence: a fixture sliced mid-sentence would make "every piece ends at a
 * sentence boundary" fail for a reason that has nothing to do with the rule.
 */
function prose(chars: number): string {
  const sentence = "Magnesium is involved in more than 300 enzymatic reactions in the body. ";
  let text = "";
  while (text.length < chars) text += sentence;
  // Trimmed like a paragraph is: a trailing space would make every text
  // comparison in this file fail for a reason the rule has nothing to do with.
  return text.trimEnd();
}

describe("isBibliography", () => {
  it("reads the heading, not just the id suffix", () => {
    expect(isBibliography({ id: "x#y", heading: "References", sectionPath: "X / Y" })).toBe(true);
    expect(isBibliography({ id: "x#y", heading: " Reference ", sectionPath: "X / Y" })).toBe(true);
  });

  it("reads the last path segment when there is no heading", () => {
    expect(isBibliography({ id: "x#y", heading: null, sectionPath: "Vitamin D / References" })).toBe(true);
    expect(isBibliography({ id: "x#y", heading: null, sectionPath: "Vitamin D / Sources" })).toBe(false);
  });

  it("falls back to the id suffix", () => {
    expect(isBibliography({ id: "ods-iron#iron-references", heading: null, sectionPath: "" })).toBe(true);
  });

  it("does not fire on a section that merely mentions references", () => {
    expect(
      isBibliography({
        id: "ods-iron#iron-references-and-further-reading-list",
        heading: "Selected References",
        sectionPath: "Iron / Selected References",
      }),
    ).toBe(false);
  });
});

describe("chunkSection", () => {
  it("returns nothing for a bibliography — exclusion happens at ingest", () => {
    expect(
      chunkSection(
        section({
          id: "ods-omega-3#omega-3-fatty-acids-references",
          sectionPath: "Omega-3 Fatty Acids / References",
          heading: "References",
          text: prose(40_000),
        }),
      ),
    ).toEqual([]);
  });

  it("keeps a short section whole, with its path prefixed on the index text only", () => {
    const chunks = chunkSection(section());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("ods-calcium#calcium-recommended-intakes#c1");
    expect(chunks[0].ordinal).toBe(1);
    expect(chunks[0].text).toBe("Adults need 1,000 mg of calcium a day.");
    expect(chunks[0].indexText).toBe(
      "Calcium / Recommended Intakes\n\nAdults need 1,000 mg of calcium a day.",
    );
    expect(chunks[0].charCount).toBe(chunks[0].text.length);
    expect(chunks[0].contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("packs paragraphs up to the target and never across a paragraph", () => {
    const first = prose(500);
    const second = prose(500);
    const third = prose(500);
    const chunks = chunkSection(section({ text: `${first}\n\n${second}\n\n${third}` }));

    expect(chunks).toHaveLength(2);
    // The first two paragraphs fit under the target; the third does not.
    expect(chunks[0].text).toBe(`${first}\n\n${second}`);
    expect(chunks[1].text).toBe(third);
    for (const chunk of chunks) expect(chunk.charCount).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("degrades an over-long paragraph to sentence boundaries, not a mid-word cut", () => {
    const chunks = chunkSection(section({ text: prose(CHUNK_MAX_CHARS * 2) }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.charCount).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
      // Every piece but the last ends at a sentence terminator.
      expect(chunk.text.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  it("overlaps only where a size-driven cut happened, and inside the cap", () => {
    const split = chunkSection(section({ text: prose(CHUNK_MAX_CHARS * 2) }));
    // Two whole paragraphs that do not fit one chunk: the boundary between them
    // is a paragraph boundary, so nothing is carried across it.
    const packed = chunkSection(section({ text: `${prose(700)}\n\n${prose(700)}` }));
    expect(packed.length).toBeGreaterThan(1);

    // A paragraph split to fit repeats its tail into the next chunk…
    const tail = split[0].text.slice(-CHUNK_OVERLAP_CHARS).trimStart();
    expect(tail.length).toBeGreaterThan(0);
    expect(split[1].text.startsWith(tail)).toBe(true);
    // …a paragraph boundary does not: overlap there would glue unrelated claims.
    expect(packed[1].text.startsWith(prose(700).slice(-CHUNK_OVERLAP_CHARS))).toBe(false);
    expect(packed[1].text).toBe(prose(700));
  });

  it("never exceeds the cap, overlap included", () => {
    // A paragraph that splits at the cap leaves no room for overlap; the rule
    // must drop the overlap rather than push the chunk over 1,600.
    const exact = prose(CHUNK_MAX_CHARS).repeat(2);
    for (const chunk of chunkSection(section({ text: exact }))) {
      expect(chunk.charCount).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    for (const chunk of chunkSection(section({ text: prose(20_000) }))) {
      expect(chunk.charCount).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("numbers ordinals from 1 and hashes the body, so identical bodies agree", () => {
    const chunks = chunkSection(section({ text: `${prose(500)}\n\n${prose(500)}\n\n${prose(500)}` }));
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([1, 2]);

    const same = chunkSection(section({ text: "Identical body." }));
    const alsoSame = chunkSection(section({ id: "other#section", text: "Identical body." }));
    expect(same[0].contentHash).toBe(alsoSame[0].contentHash);
  });

  it("returns nothing for an empty section rather than an empty chunk", () => {
    expect(chunkSection(section({ text: "   \n\n  " }))).toEqual([]);
  });

  it("keeps every chunk under the cap; overlap may push one past the target but never past the cap", () => {
    const chunks = chunkSection(section({ text: prose(5_000) }));
    expect(chunks.length).toBeGreaterThan(1);
    // The first chunk carries no overlap, so it is bound by the target.
    expect(chunks[0].charCount).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    for (const chunk of chunks) expect(chunk.charCount).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });
});
