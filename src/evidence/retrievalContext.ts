// Turning retrieval hits into the block the model reads (V1.1 / RFC 0013 §5,
// issue #135).
//
// Three jobs, and they are separate on purpose:
//
//   * render the retrieved sections in the *same* block shape as the pinned set
//     (section id + source id + doc version), because that shape is what the
//     citation gate checks against — a retrieved section the model cannot cite
//     correctly is a hit that produced nothing;
//   * hand back the section ids retrieval made available, so the caller can add
//     them to `evidenceSet` and the gate will accept a citation to them;
//   * record what was injected — ids, scores, which side found them — so a trace
//     can tell a pinned citation from a retrieved one.
//
// The budget is enforced here rather than assumed: a section over the whole-text
// threshold is injected as the hit window instead, and the loop stops adding hits
// once the block reaches its ceiling, so `TurnCostEstimates`'s allowance for this
// block is a bound rather than a hope. Hits dropped that way are absent from the
// returned provenance, because provenance reports what the model was shown.

import type { RetrieverPort, RetrievalDegradation } from "./retrieval";
import type { TurnRetrieval } from "../harness/turn";

/** Sections at or under this length are injected whole; longer ones as a window. */
export const RETRIEVAL_SECTION_MAX_CHARS = 2_000;

/** Ceiling for the whole rendered block. Top-5 sections at their max, and change. */
export const RETRIEVAL_MAX_CHARS = 10_000;

export interface RetrievedSection {
  readonly id: string;
  readonly sourceId: string;
  readonly docVersion: string;
  readonly sectionPath: string;
  readonly anchor?: string | null;
  readonly text: string;
}

export interface RetrievedChunk {
  readonly id: string;
  readonly sectionId: string;
  readonly headingText: string;
  readonly text: string;
}

/**
 * Where the text comes from.
 *
 * A port of its own rather than a method on the retriever: the retriever answers
 * "which sections", and the caller decides how much of them to show. Keeping them
 * apart is what lets the retriever be tested with no database at all.
 */
export interface EvidenceTextSource {
  loadSections(sectionIds: readonly string[]): Promise<readonly RetrievedSection[]>;
  loadChunks(chunkIds: readonly string[]): Promise<readonly RetrievedChunk[]>;
}

export interface RetrievalEvidence {
  /** The block to inject; undefined when retrieval contributed nothing. */
  readonly text?: string;
  /** Sections retrieval made citable this turn, in hit order. */
  readonly sectionIds: readonly string[];
  readonly provenance: TurnRetrieval;
}

function blockFor(section: RetrievedSection, body: string, excerpt: boolean): string {
  const anchor = section.anchor ? `\nAnchor: ${section.anchor}` : "";
  return (
    `### ${section.sectionPath}\n` +
    `Section id: ${section.id}\n` +
    `Source id: ${section.sourceId}\n` +
    `Doc version: ${section.docVersion}${anchor}` +
    (excerpt ? "\n(excerpt — the part of this section that matched the question)" : "") +
    `\n\n${body}`
  );
}

const HEADER =
  "[RETRIEVED EVIDENCE — citable sections]\n" +
  "These sections were selected for this question. Cite them the same way as the " +
  "evidence above: by section id, with the document id and version shown. A citation " +
  "that does not match a section here will be removed.\n\n";

export async function loadRetrievalEvidence(input: {
  readonly retriever: RetrieverPort;
  readonly texts: EvidenceTextSource;
  readonly query: string;
  readonly sourceVersion: string;
  readonly limit?: number;
}): Promise<RetrievalEvidence> {
  const result = await input.retriever.retrieve(input.query, { limit: input.limit });
  const provenance: TurnRetrieval = {
    sourceVersion: input.sourceVersion,
    hits: [],
    ...(result.degraded ? { degraded: result.degraded satisfies RetrievalDegradation } : {}),
  };

  if (result.hits.length === 0) return { sectionIds: [], provenance };

  const [sections, chunks] = await Promise.all([
    input.texts.loadSections(result.hits.map((hit) => hit.sectionId)),
    input.texts.loadChunks(result.hits.map((hit) => hit.chunkId)),
  ]);
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  const blocks: string[] = [];
  const injected: TurnRetrieval["hits"][number][] = [];
  let chars = 0;

  for (const hit of result.hits) {
    const section = sectionById.get(hit.sectionId);
    if (!section) continue; // A hit whose section vanished is not evidence.

    const whole = section.text.length <= RETRIEVAL_SECTION_MAX_CHARS;
    const chunk = chunkById.get(hit.chunkId);
    const body = whole ? section.text : chunk?.text;
    if (!body) continue; // Long section with no readable window: nothing to show.

    const block = blockFor(section, body, !whole);
    if (chars + block.length > RETRIEVAL_MAX_CHARS) break;
    chars += block.length;
    blocks.push(block);
    injected.push({
      sectionId: hit.sectionId,
      chunkId: hit.chunkId,
      score: hit.score,
      via: hit.via,
    });
  }

  if (blocks.length === 0) {
    return {
      sectionIds: [],
      provenance: { ...provenance, degraded: result.degraded ?? "no_hits" },
    };
  }

  return {
    text: HEADER + blocks.join("\n\n"),
    sectionIds: injected.map((hit) => hit.sectionId),
    provenance: { ...provenance, hits: injected },
  };
}

/** Merge retrieved section ids into the evidence set a turn is judged against. */
export function withRetrievedSections(
  evidenceSet: { readonly sourceVersion: string; readonly sectionIds: readonly string[] } | undefined,
  retrieved: readonly string[],
): { readonly sourceVersion: string; readonly sectionIds: readonly string[] } | undefined {
  if (retrieved.length === 0) return evidenceSet;
  const base = evidenceSet ?? { sourceVersion: "", sectionIds: [] };
  const merged = [...new Set([...base.sectionIds, ...retrieved])].sort();
  return { sourceVersion: base.sourceVersion, sectionIds: merged };
}
