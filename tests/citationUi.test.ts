// Citation rendering (S4 / #112 / RFC 0011 §3.7).
//
// The component behaviour is asserted the way this repository asserts UI without
// jsdom: the decision is a pure function (tested here properly), and the page's
// use of it is read off the source (which proves wiring, not rendering). The
// interesting question is not "does the chip look right" but "what happens when
// the index and the citation disagree" — because that is the state a reader must
// never be lied to about.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  indexCitations,
  resolveCitationChips,
  type CitationIndexEntry,
} from "../src/lib/citationUi";

const SECTION = "ods-vitamin-k#vitamin-k-interactions-with-medications-warfarin-coumadin-an";

const entry: CitationIndexEntry = {
  sectionId: SECTION,
  heading: "Vitamin K / Interactions with Medications / Warfarin",
  docVersion: "2024",
  url: "https://example.invalid/vitamin-k#h4",
};

describe("resolveCitationChips", () => {
  it("uses the index for the title and the link", () => {
    const chips = resolveCitationChips(
      [{ sectionId: SECTION, sourceId: "ods-vitamin-k", docVersion: "2024" }],
      indexCitations([entry]),
    );

    expect(chips).toEqual([
      {
        sectionId: SECTION,
        heading: "Vitamin K / Interactions with Medications / Warfarin",
        docVersion: "2024",
        url: "https://example.invalid/vitamin-k#h4",
      },
    ]);
  });

  it("keeps a citation the index does not know, labelled by its id and unlinked", () => {
    // The gate verified it; hiding it would make a well-sourced answer look less
    // sourced than it is, and inventing a title would be worse than showing none.
    const chips = resolveCitationChips(
      [{ sectionId: "unknown#section", sourceId: "unknown", docVersion: "2024" }],
      indexCitations([entry]),
    );

    expect(chips).toEqual([
      {
        sectionId: "unknown#section",
        heading: "unknown#section",
        docVersion: "2024",
        url: "",
      },
    ]);
  });

  it("preserves the model's order, so the reading order is the answer's", () => {
    const second: CitationIndexEntry = { ...entry, sectionId: "b#x", heading: "B" };
    const chips = resolveCitationChips(
      [
        { sectionId: "b#x", sourceId: "b", docVersion: "2024" },
        { sectionId: SECTION, sourceId: "ods-vitamin-k", docVersion: "2024" },
      ],
      indexCitations([entry, second]),
    );

    expect(chips.map((chip) => chip.sectionId)).toEqual(["b#x", SECTION]);
  });

  it("returns nothing for an answer that cited nothing", () => {
    expect(resolveCitationChips([], indexCitations([entry]))).toEqual([]);
  });
});

describe("the chat page's use of it (#112)", () => {
  const pageSource = () => readFileSync("app/chat/page.tsx", "utf-8");

  it("resolves citations with the index from the turn's meta frame", () => {
    const source = pageSource();
    expect(source).toContain("resolveCitationChips(state.citations, state.citationIndex)");
    expect(source).toContain("indexCitations(event.citations ?? [])");
  });

  it("takes citations from the terminal's typed output, not from the prose", () => {
    // Only the gate's survivors live in `output.citations`; a citation stripped
    // for provenance is not in there, so the UI cannot show a source the answer
    // did not actually stand on.
    const source = pageSource();
    expect(source).toContain("result.output?.citations");
  });

  it("renders a titled link, and a bare title when there is no url", () => {
    const source = pageSource();
    expect(source).toContain("message.citations");
    expect(source).toContain("Evidence");
    expect(source).toContain("citation.url ? (");
    expect(source).toContain("{citation.heading}");
    expect(source).toContain("({citation.docVersion})");
    expect(source).toContain('rel="noreferrer"');
  });
});

describe("the route's citation index (#112)", () => {
  const routeSource = () => readFileSync("app/api/chat/route.ts", "utf-8");

  it("ships the index with the same load that produced the evidence set", () => {
    const source = routeSource();
    expect(source).toContain("citations: loaded.index");
    // One load: an index built from a different read could describe evidence the
    // turn was never given.
    expect(source.match(/loadPinnedEvidence\(/g) ?? []).toHaveLength(1);
  });
});
