// The pinned evidence set (S4 / RFC 0011 §3.7, issue #111).
//
// V1.0 has no retrieval, so the evidence a turn may cite is a **fixed set** that
// rides the pinned region alongside the system prompt and the template catalog.
// Three properties are the whole design:
//
//   * **byte-stable.** Sections are ordered by `sectionId` and rendered with no
//     timestamps or counts that could vary between processes: the region is what
//     prompt-cache hits are made of, and one reordered section costs a cache miss
//     on every turn.
//   * **self-identifying.** Each block carries its section id and document
//     version, because that is what citations quote back and what the citation
//     gate checks them against. A model that cannot see the id cannot cite
//     legally, and asking it to guess one would produce exactly the unresolvable
//     citations the gate then has to strip.
//   * **explicitly bounded.** The budget is checked here, not assumed: a corpus
//     that grows past RFC 0011 §3.7's ceilings must fail loudly rather than
//     silently eat the context window.
//
// No user-dependent selection. Choosing evidence per user *is* retrieval, and ADR
// 0004 phases retrieval to V1.1 — a "small relevance tweak" here would be the
// thing the phasing exists to prevent.

import type { TurnEvidenceSet } from "../harness/turn";

export interface EvidenceSection {
  /** `<source_id>#<section slug>` — what a citation names. */
  readonly id: string;
  readonly sourceId: string;
  readonly docVersion: string;
  readonly sectionPath: string;
  readonly heading: string | null;
  readonly ordinal: number;
  readonly text: string;
  readonly anchor?: string;
}

export interface PinnedEvidence {
  /** Text for the pinned region; empty when no evidence is configured. */
  readonly text: string;
  /** What this turn is allowed to cite, recorded on `turn_start`. */
  readonly evidenceSet: TurnEvidenceSet;
  readonly sections: number;
  readonly chars: number;
}

/** RFC 0011 §3.7's ceilings, as constants rather than comments. */
export const PINNED_MAX_SECTIONS = 40;
// chars/4 is the estimator the corpus and the budget both use (see
// src/evidence/corpus.ts); 6000 tokens therefore means 24000 characters.
export const PINNED_MAX_CHARS = 24000;

export class PinnedBudgetError extends Error {
  constructor(sectionCount: number, chars: number) {
    super(
      `pinned evidence set is over budget: ${sectionCount} sections / ${chars} chars ` +
        `(max ${PINNED_MAX_SECTIONS} / ${PINNED_MAX_CHARS})`,
    );
    this.name = "PinnedBudgetError";
  }
}

/**
 * Render the pinned evidence and the set it implies.
 *
 * `sourceVersion` names the corpus the set came from; it lands on `turn_start` so
 * a replay can name the corpus it was judged against rather than trusting that
 * the corpus has not moved since.
 */
export function assemblePinnedEvidence(
  sections: readonly EvidenceSection[],
  sourceVersion: string,
): PinnedEvidence {
  const ordered = [...sections].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const chars = ordered.reduce((total, section) => total + section.text.length, 0);
  if (ordered.length > PINNED_MAX_SECTIONS || chars > PINNED_MAX_CHARS) {
    throw new PinnedBudgetError(ordered.length, chars);
  }

  if (ordered.length === 0) {
    return {
      text: "",
      evidenceSet: { sourceVersion, sectionIds: [] },
      sections: 0,
      chars: 0,
    };
  }

  const blocks = ordered.map((section) => {
    const trail = section.heading && section.heading !== section.sectionPath
      ? `${section.sectionPath}`
      : section.sectionPath;
    const anchor = section.anchor ? `\nAnchor: ${section.anchor}` : "";
    return (
      `### ${trail}\n` +
      `Section id: ${section.id}\n` +
      `Source id: ${section.sourceId}\n` +
      `Doc version: ${section.docVersion}${anchor}\n\n` +
      section.text
    );
  });

  const text =
    "[EVIDENCE — citable sections]\n" +
    "Cite these only by their section id, together with the document id and version " +
    "shown. A citation that does not match a section here will be removed.\n\n" +
    blocks.join("\n\n");

  return {
    text,
    evidenceSet: { sourceVersion, sectionIds: ordered.map((section) => section.id) },
    sections: ordered.length,
    chars,
  };
}

/**
 * Section ids a citation could legally name, for error messages and tests.
 *
 * Sorted, like the set itself: a diff is how a corpus change is reviewed.
 */
export function evidenceSectionIds(evidence: PinnedEvidence): readonly string[] {
  return [...evidence.evidenceSet.sectionIds].sort();
}

// ── loaders ───────────────────────────────────────────────────────────────

/**
 * Pinned sections straight from the corpus files.
 *
 * The file path is what the CLI, the eval and the tests use: it needs no
 * database, and it is the same data the ingest step writes, so a mismatch
 * between what is pinned in git and what is pinned in the registry shows up as a
 * diff rather than as a silent difference in behaviour.
 */
export function loadPinnedEvidenceFromCorpus(
  corpus: { readonly documents: readonly CorpusDocumentLike[] },
  sourceVersion: string,
): PinnedEvidence {
  const sections = corpus.documents.flatMap((document) =>
    document.sections
      .filter((section) => section.pinned)
      .map((section) => ({
        id: section.id,
        sourceId: document.id,
        docVersion: document.docVersion,
        sectionPath: section.sectionPath,
        heading: section.heading,
        ordinal: section.ordinal,
        text: section.text,
        anchor: section.anchor,
      })),
  );
  return assemblePinnedEvidence(sections, sourceVersion);
}

interface CorpusDocumentLike {
  readonly id: string;
  readonly docVersion: string;
  readonly sections: readonly {
    readonly id: string;
    readonly sectionPath: string;
    readonly heading: string | null;
    readonly ordinal: number;
    readonly text: string;
    readonly anchor?: string;
    readonly pinned: boolean;
  }[];
}
