// Retrieval: the port, the fusion rule, and the two implementations
// (V1.1 / RFC 0013 §4-§5, issue #134).
//
// The port answers one question — "which sections are usable evidence for this
// query" — and its result carries *why* it answered nothing, because the caller
// must not have to guess between "the corpus has nothing" and "retrieval is
// down". Those two are different facts with different consequences: the first is
// an answer that says the evidence is insufficient, the second is a run that
// loses its citations and should be counted as infrastructure (ADR 0004 §4).
//
// Fusion is reciprocal rank fusion over the two ranked lists, and it lives here
// rather than in SQL so that the in-memory retriever CI runs and the Postgres
// retriever production runs cannot disagree about the order they return. SQL
// supplies only the two orderings TypeScript cannot express (`ts_rank` and the
// cosine distance operator), which is what migration 0018 provides.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingPort } from "./embedding";

/** Reciprocal-rank constant. 60 is the value RRF is normally quoted with. */
export const RRF_K = 60;

/** Chunks fetched per side before fusion. Wider than the result on purpose. */
export const RETRIEVAL_CANDIDATES = 20;

/** Sections returned by default: RFC 0013 §5 budgets the context for five. */
export const RETRIEVAL_TOP_SECTIONS = 5;

export type RetrievalSide = "lexical" | "vector";

/** A chunk as one side ranked it. `rank` is 1-based; 0 means "unranked". */
export interface RankedChunk {
  readonly chunkId: string;
  readonly sectionId: string;
  readonly rank: number;
}

export interface RetrievalHit {
  readonly sectionId: string;
  /** The chunk that scored best for this section — the window worth injecting. */
  readonly chunkId: string;
  readonly score: number;
  /** Which sides surfaced this section. Both is the strongest signal available. */
  readonly via: readonly RetrievalSide[];
}

/**
 * Why retrieval returned nothing.
 *
 * - `unavailable`: the vector side or the database could not be reached. The
 *   answer must still not invent a source, and the turn is a candidate for the
 *   infrastructure bucket rather than the capability one.
 * - `no_hits`: retrieval ran and the corpus has nothing for this query.
 */
export type RetrievalDegradation = "unavailable" | "no_hits";

export interface RetrievalResult {
  readonly hits: readonly RetrievalHit[];
  readonly degraded?: RetrievalDegradation;
}

export interface RetrieverPort {
  retrieve(query: string, options?: { readonly limit?: number }): Promise<RetrievalResult>;
}

/**
 * Reciprocal rank fusion, one section at a time.
 *
 * Per-section score is the *best* chunk's RRF score rather than the sum over its
 * chunks: summing would let a section with many chunks outrank a section that
 * answers the question, which is how a 43k-character reference list would have
 * won the ranking had it been indexed at all (§3 excluded it for the same reason
 * from the other direction).
 *
 * Ties break on section id so the order is a function of the inputs, not of the
 * order Postgres happened to return rows in.
 */
export function fuseRankedChunks(
  lexical: readonly RankedChunk[],
  vector: readonly RankedChunk[],
  limit: number = RETRIEVAL_TOP_SECTIONS,
  k: number = RRF_K,
): readonly RetrievalHit[] {
  const best = new Map<string, { chunkId: string; score: number; via: Set<RetrievalSide> }>();

  const absorb = (chunks: readonly RankedChunk[], side: RetrievalSide): void => {
    for (const chunk of chunks) {
      if (chunk.rank < 1) continue;
      const contribution = 1 / (k + chunk.rank);
      const current = best.get(chunk.sectionId);
      if (!current) {
        best.set(chunk.sectionId, {
          chunkId: chunk.chunkId,
          score: contribution,
          via: new Set([side]),
        });
        continue;
      }
      const better = contribution > current.score;
      best.set(chunk.sectionId, {
        chunkId: better ? chunk.chunkId : current.chunkId,
        score: Math.max(current.score, contribution),
        via: current.via.add(side),
      });
    }
  };

  absorb(lexical, "lexical");
  absorb(vector, "vector");

  return [...best.entries()]
    .map(([sectionId, entry]) => ({
      sectionId,
      chunkId: entry.chunkId,
      score: entry.score,
      via: [...entry.via].sort(),
    }))
    .sort((a, b) => (b.score - a.score) || (a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0))
    .slice(0, Math.max(0, limit));
}

// ── in-memory retriever: the CI default ────────────────────────────────────

export interface InMemoryChunk {
  readonly chunkId: string;
  readonly sectionId: string;
  readonly text: string;
}

function tokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/**
 * A retriever over an in-memory corpus, with no database and no network.
 *
 * It exists for the same reason `NUTRIBUDDY_QUERY_RUNNER=memory` does: the
 * ordering rules are worth asserting in CI, and a test that needs a corpus in
 * Postgres is a test that mostly runs nowhere. The scoring is deliberately naive
 * — term overlap, not BM25 — because it is not the thing under test; the fusion
 * and the degradation signals are.
 */
export function createInMemoryRetriever(
  chunks: readonly InMemoryChunk[],
  options: { readonly embed?: EmbeddingPort; readonly vectors?: readonly (readonly number[])[] } = {},
): RetrieverPort {
  const ids = new Set(chunks.map((chunk) => chunk.chunkId));
  if (ids.size !== chunks.length) {
    // Rejected at construction: a duplicate id means the fusion would silently
    // collapse two different chunks, and the resulting ranking would be wrong in
    // a way no downstream assertion could attribute.
    throw new Error("in-memory retriever: duplicate chunk id in the corpus");
  }

  return {
    async retrieve(query, retrieveOptions = {}) {
      const limit = retrieveOptions.limit ?? RETRIEVAL_TOP_SECTIONS;
      const queryTokens = new Set(tokens(query));

      const scored = chunks
        .map((chunk) => {
          const chunkTokens = tokens(chunk.text);
          const overlap = chunkTokens.filter((token) => queryTokens.has(token)).length;
          return { chunk, overlap };
        })
        .filter((entry) => entry.overlap > 0)
        .sort((a, b) =>
          b.overlap - a.overlap || (a.chunk.chunkId < b.chunk.chunkId ? -1 : a.chunk.chunkId > b.chunk.chunkId ? 1 : 0),
        );

      const lexical: RankedChunk[] = scored.map((entry, position) => ({
        chunkId: entry.chunk.chunkId,
        sectionId: entry.chunk.sectionId,
        rank: position + 1,
      }));

      let vector: RankedChunk[] = [];
      if (options.vectors && options.vectors.length === chunks.length) {
        const queryVector = options.embed ? await options.embed.embed([query]).then((rows) => rows[0]) : undefined;
        if (queryVector) {
          vector = chunks
            .map((chunk, position) => ({
              chunk,
              distance: cosineDistance(queryVector, options.vectors?.[position] ?? []),
            }))
            .filter((entry) => Number.isFinite(entry.distance))
            .sort((a, b) =>
              a.distance - b.distance || (a.chunk.chunkId < b.chunk.chunkId ? -1 : a.chunk.chunkId > b.chunk.chunkId ? 1 : 0),
            )
            .map((entry, position) => ({
              chunkId: entry.chunk.chunkId,
              sectionId: entry.chunk.sectionId,
              rank: position + 1,
            }));
        }
      }

      const hits = fuseRankedChunks(lexical, vector, limit);
      return hits.length > 0 ? { hits } : { hits, degraded: "no_hits" };
    },
  };
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return Number.NaN;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Postgres retriever: production ─────────────────────────────────────────

interface RankedRow {
  readonly chunk_id: string;
  readonly section_id: string;
  readonly rank: number;
}

function asRankedChunks(rows: readonly RankedRow[] | null): readonly RankedChunk[] {
  return (rows ?? []).map((row) => ({
    chunkId: String(row.chunk_id),
    sectionId: String(row.section_id),
    rank: Number(row.rank),
  }));
}

/**
 * The production retriever: two ranking functions, one fusion.
 *
 * A failed embedding call or a failed query returns `unavailable` rather than
 * throwing: the turn has an answer to give, and ADR 0004 §4 requires it to give
 * one without a citation instead of falling back to the model's memory or
 * failing the request outright.
 */
export function createSupabaseRetriever(
  client: SupabaseClient,
  options: {
    readonly embed: EmbeddingPort;
    readonly candidates?: number;
    /** Called instead of throwing when a side fails; the caller decides the log. */
    readonly onFailure?: (side: RetrievalSide | "embedding", error: unknown) => void;
  },
): RetrieverPort {
  const candidates = options.candidates ?? RETRIEVAL_CANDIDATES;

  return {
    async retrieve(query, retrieveOptions = {}) {
      const limit = retrieveOptions.limit ?? RETRIEVAL_TOP_SECTIONS;
      let unavailable = false;

      const lexicalResult = await client
        .rpc("match_source_chunks_by_text", { query_text: query, match_count: candidates })
        .then((result) => result, (error: unknown) => ({ data: null, error }));
      if (lexicalResult.error) {
        unavailable = true;
        options.onFailure?.("lexical", lexicalResult.error);
      }

      let vectorRows: readonly RankedChunk[] = [];
      const embedding = await options.embed.embed([query]).then(
        (rows) => rows[0],
        (error: unknown) => {
          unavailable = true;
          options.onFailure?.("embedding", error);
          return undefined;
        },
      );

      if (embedding) {
        const vectorResult = await client
          .rpc("match_source_chunks_by_embedding", {
            // A pgvector literal: PostgREST carries the custom type as text.
            query_embedding: JSON.stringify(embedding),
            match_count: candidates,
          })
          .then((result) => result, (error: unknown) => ({ data: null, error }));
        if (vectorResult.error) {
          unavailable = true;
          options.onFailure?.("vector", vectorResult.error);
        } else {
          vectorRows = asRankedChunks(vectorResult.data as RankedRow[] | null);
        }
      }

      const hits = fuseRankedChunks(
        asRankedChunks(lexicalResult.data as RankedRow[] | null),
        vectorRows,
        limit,
      );
      if (hits.length > 0) return { hits };
      return { hits, degraded: unavailable ? "unavailable" : "no_hits" };
    },
  };
}
