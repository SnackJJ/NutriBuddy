// Section chunking for retrieval (V1.1 / RFC 0013 §3, issue #133).
//
// A chunk is a **retrieval** unit and never a citable one: a hit is resolved
// back to its parent section, and citations keep pointing at the section
// (docs/adr/0005). That is why nothing here mints an identity the registry has
// to know about — a chunk id lives in the index and nowhere else.
//
// The rule, and the corpus fact behind each part of it (372 sections, 793,061
// chars measured on the committed corpus):
//
//   * paragraph (\n\n) is the smallest respected unit — never stitched across;
//   * a paragraph over the cap degrades to sentence boundaries, then to a hard
//     cut — 26 sections contain a paragraph over 1,200 chars;
//   * target 1,200 / cap 1,600 chars, with 15% overlap **inside the cap**.
//     Overlap that is added on top of the cap is not a cap: an early version of
//     this rule left 11 chunks over 1,600 on the real corpus;
//   * every chunk's index text is prefixed with its section path, because a
//     section can open with "This is a fact sheet intended for health
//     professionals…" — nothing a query would ever match.

import { createHash } from "node:crypto";

/** Pack paragraphs up to this many characters before starting a new chunk. */
export const CHUNK_TARGET_CHARS = 1200;

/** Hard ceiling. Size-driven cuts overlap, but never past this. */
export const CHUNK_MAX_CHARS = 1600;

/** Characters of the previous chunk repeated when a cut falls inside a paragraph. */
export const CHUNK_OVERLAP_CHARS = 150;

/**
 * Ceiling for a piece cut out of an over-long paragraph.
 *
 * The overlap is budgeted here rather than added on top of the cap: packing
 * sentences all the way to 1,600 leaves no room for the 150 characters the rule
 * promises to carry over, so the overlap silently never happens. Reserving it
 * (plus the two characters of the separator) is what makes the overlap real;
 * {@link CHUNK_MAX_CHARS} stays the ceiling for the finished chunk.
 */
const PIECE_MAX_CHARS = CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS - 2;

export interface ChunkableSection {
  readonly id: string;
  readonly sectionPath: string;
  readonly heading: string | null;
  readonly text: string;
}

export interface SectionChunk {
  /** `<section_id>#c<n>`, 1-based, unique within the section. */
  readonly id: string;
  readonly ordinal: number;
  /** The chunk body — what a hit injects into the context. */
  readonly text: string;
  /** The body prefixed with its section path — what the lexical side indexes. */
  readonly indexText: string;
  readonly charCount: number;
  readonly contentHash: string;
}

/**
 * Whether a section is a bibliography rather than evidence.
 *
 * A reference list is a pointer to evidence, not evidence: it carries no
 * citable claim. On the committed corpus these are 12 sections, 267,581 chars,
 * 33.7% of the corpus — 251 of the 954 chunks a naive run produces — and they
 * are the *largest* sections, so leaving them in the index both eats the
 * retrieval budget and invites "precisely cited a paper title" as a new failure
 * mode. The heading is the semantic fact ("References"); the id suffix is
 * derived from it, and the two agree on all 12 today.
 */
export function isBibliography(section: {
  readonly id: string;
  readonly heading: string | null;
  readonly sectionPath: string;
}): boolean {
  const heading = section.heading?.trim() ?? "";
  if (/^references?$/i.test(heading)) return true;
  const lastPathSegment = section.sectionPath.split("/").pop()?.trim() ?? "";
  if (/^references?$/i.test(lastPathSegment)) return true;
  return /-references$/i.test(section.id);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface Piece {
  readonly text: string;
  /** True when the piece exists because a paragraph was cut to fit the cap. */
  readonly sizeSplit: boolean;
}

function splitSentences(paragraph: string): readonly string[] {
  // Keeps the terminator with its sentence. Lookbehind rather than a capture so
  // no text is lost at the seams.
  const parts = paragraph.split(/(?<=[.!?])\s+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [paragraph];
}

function hardCut(text: string, max: number): readonly string[] {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += max) {
    pieces.push(text.slice(index, index + max));
  }
  return pieces;
}

/** Split one paragraph into pieces no longer than its ceiling. */
function splitParagraph(paragraph: string, max: number): readonly Piece[] {
  if (paragraph.length <= max) return [{ text: paragraph, sizeSplit: false }];

  // Sentences pack to the *target*, not to the ceiling: the ceiling exists so a
  // single over-long sentence can still be carried whole (it is then cut), not
  // so ordinary prose may drift towards 1,600.
  const softCeiling = Math.min(CHUNK_TARGET_CHARS, PIECE_MAX_CHARS);
  const pieces: Piece[] = [];
  let current = "";
  for (const sentence of splitSentences(paragraph)) {
    for (const part of sentence.length > PIECE_MAX_CHARS ? hardCut(sentence, PIECE_MAX_CHARS) : [sentence]) {
      if (current.length === 0) {
        current = part;
      } else if (current.length + 1 + part.length <= softCeiling) {
        current = `${current} ${part}`;
      } else {
        pieces.push({ text: current, sizeSplit: true });
        current = part;
      }
    }
  }
  if (current.length > 0) pieces.push({ text: current, sizeSplit: pieces.length > 0 });

  // A paragraph that split into exactly one piece was never size-driven.
  return pieces.length === 1 ? [{ text: pieces[0].text, sizeSplit: false }] : pieces;
}

/**
 * The text a chunk is indexed under: its section path, then its body.
 *
 * Defined once because three readers depend on it agreeing — the vector side
 * embeds exactly this, the lexical side indexes the same two parts with the
 * heading weighted, and a reader comparing a hit against the section expects the
 * path to be there.
 */
export function indexText(headingText: string, body: string): string {
  const heading = headingText.trim();
  return heading.length > 0 ? `${heading}\n\n${body}` : body;
}

export interface ChunkOptions {
  /**
   * Chunk a bibliography too, which nothing in the retrieval path ever wants.
   *
   * It exists so the ingest can report how much of the index the exclusion
   * saved — a number a reader can check against the corpus — without a second
   * implementation of the rule.
   */
  readonly includeBibliography?: boolean;
}

/**
 * Chunk one section.
 *
 * Returns an empty list for a bibliography: exclusion happens at ingest, so the
 * index never contains one, and "which sections are excluded" stays a fact about
 * the corpus rather than a filter every query has to remember (RFC 0013 §3).
 */
export function chunkSection(
  section: ChunkableSection,
  options: ChunkOptions = {},
): readonly SectionChunk[] {
  if (!options.includeBibliography && isBibliography(section)) return [];

  const paragraphs = section.text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) return [];

  const pieces: Piece[] = paragraphs.flatMap((paragraph) => splitParagraph(paragraph, CHUNK_MAX_CHARS));

  const bodies: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece.text;
      continue;
    }
    if (current.length + 2 + piece.text.length <= CHUNK_TARGET_CHARS) {
      current = `${current}\n\n${piece.text}`;
      continue;
    }

    // Starting a new chunk: repeat the tail only where the cut landed inside a
    // paragraph, and only if the overlap still fits under the cap.
    let start = piece.text;
    if (piece.sizeSplit) {
      const overlap = current.slice(-CHUNK_OVERLAP_CHARS).trimStart();
      if (overlap.length > 0 && overlap.length + 2 + start.length <= CHUNK_MAX_CHARS) {
        start = `${overlap}\n\n${start}`;
      }
    }
    bodies.push(current);
    current = start;
  }
  if (current.length > 0) bodies.push(current);

  const prefix = section.sectionPath.trim();
  return bodies.map((body, index) => {
    const ordinal = index + 1;
    return {
      id: `${section.id}#c${ordinal}`,
      ordinal,
      text: body,
      indexText: indexText(prefix, body),
      charCount: body.length,
      contentHash: hashText(body),
    };
  });
}
