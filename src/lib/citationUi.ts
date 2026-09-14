// Citation rendering inputs (S4 / RFC 0011 §3.7, issue #112).
//
// The split this module exists to keep: the *server* decides what evidence was
// available and which citations survived the gate; the *client* only turns those
// ids into something a reader can scan and open. Resolving an id on the client
// against anything else would be a second source of truth for what a citation
// points at, which is the same failure the citation gate is built to prevent.
//
// Pure, so the fallback behaviour is testable without a DOM: the repository has no
// jsdom, and "what does the UI show when the index is missing an id" is a question
// worth answering precisely rather than by reading the component.

/** One citation as the wire carries it (RFC 0011 §3.3). */
export interface WireCitation {
  readonly sectionId: string;
  readonly sourceId: string;
  readonly docVersion: string;
  readonly quote?: string;
}

/** What the turn's meta frame says about a citable section. */
export interface CitationIndexEntry {
  readonly sectionId: string;
  readonly heading: string;
  readonly docVersion: string;
  readonly url: string;
}

export interface CitationChip {
  readonly sectionId: string;
  readonly heading: string;
  readonly docVersion: string;
  readonly url: string;
}

/**
 * Turn verified citations into chips.
 *
 * A citation the index does not know is still shown, with its section id as the
 * label and no link: the gate verified it, and dropping it would make a well
 * sourced answer look less sourced than it is. The reverse — inventing a heading —
 * is not an option worth considering.
 */
export function resolveCitationChips(
  citations: readonly WireCitation[],
  index: ReadonlyMap<string, CitationIndexEntry>,
): readonly CitationChip[] {
  return citations.map((citation) => {
    const entry = index.get(citation.sectionId);
    return {
      sectionId: citation.sectionId,
      heading: entry?.heading ?? citation.sectionId,
      docVersion: entry?.docVersion ?? citation.docVersion,
      url: entry?.url ?? "",
    };
  });
}

/** Index the meta frame's entries by section id. */
export function indexCitations(
  entries: readonly CitationIndexEntry[],
): Map<string, CitationIndexEntry> {
  return new Map(entries.map((entry) => [entry.sectionId, entry]));
}
