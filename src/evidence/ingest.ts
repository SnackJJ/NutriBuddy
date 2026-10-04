// Corpus ingest (S4 / RFC 0011 §3.2, issue #107).
//
// The ingest step's whole job is to be boring: read the committed corpus, decide
// per document whether anything changed, and write rows in a way that can be run
// twice with the same result. Two properties carry that:
//
//   * **idempotence by content hash.** Unchanged content is skipped, not
//     re-written: a no-op run must not touch `ingested_at`, or "when did this
//     document last change" stops being answerable.
//   * **supersede, never delete.** A changed document inserts its new version and
//     flips the old row to `superseded`. Old sections stay, because an old trace
//     may cite them and a citation that cannot be resolved is exactly what the
//     citation gate exists to catch (RFC 0011 §3.5).
//
// The decision is a pure function of (document, current active row) and the
// writing is behind a port, so both are testable without a database.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CorpusDocument, CorpusSection } from "./corpus";
import { chunkSection, indexText, isBibliography } from "./chunking";
import type { EmbeddingPort } from "./embedding";

export interface SourceRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly license: string | null;
  readonly doc_version: string;
  readonly effective_date: string | null;
  readonly status: "active" | "superseded" | "archived";
  readonly authority_level: number;
  readonly content_hash: string;
}

export interface SectionRow {
  readonly id: string;
  readonly source_id: string;
  readonly section_path: string;
  readonly heading: string | null;
  readonly ordinal: number;
  readonly text: string;
  readonly anchor: string | null;
  readonly content_hash: string;
  readonly pinned: boolean;
}

/**
 * A retrieval chunk row (RFC 0013 §4).
 *
 * `embedding` is a pgvector literal — `[0.1,0.2,…]` — rather than a number array
 * because that is what PostgREST carries for a `vector` column; the index and
 * every query read it in the same form.
 */
export interface ChunkRow {
  readonly id: string;
  readonly section_id: string;
  readonly source_id: string;
  readonly ordinal: number;
  /** Section path, kept apart from the body so the lexical side can weight it. */
  readonly heading_text: string;
  readonly text: string;
  readonly char_count: number;
  readonly content_hash: string;
  readonly embedding: string | null;
}

export interface RegistryStore {
  /** The version currently marked active for this document, if any. */
  findActiveSource(slug: string): Promise<{ readonly id: string; readonly contentHash: string } | undefined>;
  insertSource(row: SourceRow): Promise<void>;
  markSuperseded(sourceId: string): Promise<void>;
  existingSectionIds(sourceId: string): Promise<readonly string[]>;
  upsertSections(rows: readonly SectionRow[]): Promise<void>;
  /**
   * Replace every chunk of one document version.
   *
   * Chunks are derived from section text, so they are rewritten rather than
   * accumulated: unlike a superseded section — which an old trace may still cite
   * — a stale chunk is simply wrong. The version scoping in `source_id` is what
   * keeps this from touching any other version's rows.
   */
  replaceChunks(sourceId: string, rows: readonly ChunkRow[]): Promise<void>;
}

export type IngestAction = "insert" | "skip" | "supersede-and-insert";

export interface IngestPlan {
  readonly slug: string;
  readonly sourceId: string;
  readonly action: IngestAction;
  /** The version this one replaces, on `supersede-and-insert`. */
  readonly supersedes?: string;
  readonly sections: number;
  readonly pinned: number;
  readonly reason: string;
}

/**
 * What to do with one document.
 *
 * Same hash means skip even if the version string differs: the hash is what the
 * rows are compared on, and a re-fetch that produced byte-identical text has not
 * changed the evidence.
 */
export function planIngest(
  document: CorpusDocument,
  active: { readonly id: string; readonly contentHash: string } | undefined,
): IngestPlan {
  const pinned = document.sections.filter((section) => section.pinned).length;
  const base = {
    slug: document.slug,
    sourceId: document.id,
    sections: document.sections.length,
    pinned,
  };

  if (!active) {
    return { ...base, action: "insert", reason: "no active version for this document" };
  }
  if (active.id === document.id && active.contentHash === document.contentHash) {
    return { ...base, action: "skip", reason: "content hash unchanged" };
  }
  if (active.contentHash === document.contentHash) {
    return {
      ...base,
      action: "skip",
      reason: `same content as ${active.id}, only the version label differs`,
    };
  }
  return {
    ...base,
    action: "supersede-and-insert",
    supersedes: active.id,
    reason: `content changed (${active.contentHash.slice(0, 12)} → ${document.contentHash.slice(0, 12)})`,
  };
}

function toSourceRow(document: CorpusDocument): SourceRow {
  return {
    id: document.id,
    slug: document.slug,
    title: document.title,
    publisher: document.publisher,
    url: document.url,
    license: document.license,
    doc_version: document.docVersion,
    effective_date: null,
    status: "active",
    authority_level: document.authorityLevel,
    content_hash: document.contentHash,
  };
}

function toSectionRow(document: CorpusDocument, section: CorpusSection): SectionRow {
  return {
    id: section.id,
    source_id: document.id,
    section_path: section.sectionPath,
    heading: section.heading,
    ordinal: section.ordinal,
    text: section.text,
    anchor: section.anchor ?? null,
    content_hash: section.contentHash,
    pinned: section.pinned,
  };
}

export interface BibliographyExclusion {
  readonly sections: number;
  /** Chunks these sections would have produced had they been indexed. */
  readonly chunks: number;
  /** Named, not merely counted: the pinned set's `excludedByBudget` precedent. */
  readonly sectionIds: readonly string[];
}

export interface ChunkPlan {
  /** Rows without their vector; the vector is filled in when an embedder is given. */
  readonly rows: readonly Omit<ChunkRow, "embedding">[];
  readonly chunks: number;
  readonly sections: number;
  readonly bibliography: BibliographyExclusion;
}

/**
 * Every chunk one document version should have (RFC 0013 §3), and what the
 * bibliography exclusion kept out.
 *
 * Pure, so the counts the ingest reports and the rows it writes come from the
 * same computation — a snapshot that disagreed with the index would be worse
 * than no snapshot.
 */
export function planChunks(document: CorpusDocument): ChunkPlan {
  const rows: Omit<ChunkRow, "embedding">[] = [];
  const excludedIds: string[] = [];
  let excludedChunks = 0;
  let sections = 0;

  for (const section of document.sections) {
    if (isBibliography(section)) {
      excludedIds.push(section.id);
      excludedChunks += chunkSection(section, { includeBibliography: true }).length;
      continue;
    }
    sections += 1;
    for (const chunk of chunkSection(section)) {
      rows.push({
        id: chunk.id,
        section_id: section.id,
        source_id: document.id,
        ordinal: chunk.ordinal,
        heading_text: section.sectionPath,
        text: chunk.text,
        char_count: chunk.charCount,
        content_hash: chunk.contentHash,
      });
    }
  }

  return {
    rows,
    chunks: rows.length,
    sections,
    bibliography: { sections: excludedIds.length, chunks: excludedChunks, sectionIds: excludedIds },
  };
}

export interface IngestOutcome {
  readonly plan: IngestPlan;
  /** False on `skip`, and on a dry run. */
  readonly written: boolean;
  /** Chunks this document version has, whether or not they were written. */
  readonly chunks: number;
}

export interface IngestOptions {
  readonly dry?: boolean;
  /**
   * When absent, chunks are written without vectors.
   *
   * `embedding` is nullable so the corpus can be ingested before an embedding
   * pass exists or succeeds; an unembedded chunk is still lexically searchable,
   * and a half-embedded index is a state the schema can represent honestly.
   */
  readonly embed?: EmbeddingPort;
  readonly onEmbedProgress?: (done: number, total: number) => void;
}

async function writeChunks(
  store: RegistryStore,
  document: CorpusDocument,
  plan: ChunkPlan,
  options: IngestOptions,
): Promise<void> {
  const vectors = options.embed
    ? await options.embed.embed(
        plan.rows.map((row) => indexText(row.heading_text, row.text)),
        options.onEmbedProgress,
      )
    : undefined;

  await store.replaceChunks(
    document.id,
    plan.rows.map((row, index) => ({
      ...row,
      embedding: vectors ? JSON.stringify(vectors[index]) : null,
    })),
  );
}

export async function ingestDocument(
  store: RegistryStore,
  document: CorpusDocument,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const active = await store.findActiveSource(document.slug);
  const plan = planIngest(document, active);
  const chunkPlan = planChunks(document);

  if (plan.action === "skip" || options.dry) {
    return { plan, written: false, chunks: chunkPlan.chunks };
  }

  // Order matters: the new row has to land before the old one is superseded, or
  // the partial unique index (one active version per slug) sees a window with
  // none. Superseding first and inserting second would fail that index.
  if (plan.supersedes) {
    await store.insertSource(toSourceRow(document));
    await store.markSuperseded(plan.supersedes);
  } else {
    await store.insertSource(toSourceRow(document));
  }

  await store.upsertSections(document.sections.map((section) => toSectionRow(document, section)));
  await writeChunks(store, document, chunkPlan, options);
  return { plan, written: true, chunks: chunkPlan.chunks };
}

/**
 * Rebuild one document version's chunks without touching the registry.
 *
 * The sections are unchanged, so nothing about the document needs re-deciding;
 * what changed is the rule that turns sections into chunks, or the embedding
 * model behind them. Re-ingesting would be wrong here: it reports `skip` for
 * unchanged content and would leave the index as it was.
 */
export async function rechunkDocument(
  store: RegistryStore,
  document: CorpusDocument,
  options: IngestOptions = {},
): Promise<ChunkPlan> {
  const plan = planChunks(document);
  if (!options.dry) await writeChunks(store, document, plan, options);
  return plan;
}

// ── Supabase implementation ───────────────────────────────────────────────

function readError(error: unknown, operation: string): Error {
  const record =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown })
      : {};
  const message = typeof record.message === "string" ? record.message : String(error);
  return new Error(`${operation}: ${message}`);
}

export function createSupabaseRegistryStore(client: SupabaseClient): RegistryStore {
  return {
    async findActiveSource(slug) {
      const { data, error } = await client
        .from("sources")
        .select("id, content_hash")
        .eq("slug", slug)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw readError(error, "findActiveSource");
      return data
        ? { id: String(data.id), contentHash: String(data.content_hash) }
        : undefined;
    },

    async insertSource(row) {
      const { error } = await client.from("sources").insert(row);
      if (error) throw readError(error, "insertSource");
    },

    async markSuperseded(sourceId) {
      const { error } = await client
        .from("sources")
        .update({ status: "superseded" })
        .eq("id", sourceId);
      if (error) throw readError(error, "markSuperseded");
    },

    async existingSectionIds(sourceId) {
      const { data, error } = await client
        .from("source_sections")
        .select("id")
        .eq("source_id", sourceId);
      if (error) throw readError(error, "existingSectionIds");
      return (data ?? []).map((row: { readonly id: unknown }) => String(row.id));
    },

    async upsertSections(rows) {
      if (rows.length === 0) return;
      // Chunked: a corpus of a few hundred sections in one request is well within
      // PostgREST's body limits today, but the chunk keeps the failure mode of a
      // much larger corpus a partial write with a clear error rather than a
      // request that never lands.
      const CHUNK = 100;
      for (let index = 0; index < rows.length; index += CHUNK) {
        const { error } = await client
          .from("source_sections")
          .upsert(rows.slice(index, index + CHUNK), { onConflict: "id" });
        if (error) throw readError(error, "upsertSections");
      }
    },

    async replaceChunks(sourceId, rows) {
      const { error: deleteError } = await client
        .from("source_chunks")
        .delete()
        .eq("source_id", sourceId);
      if (deleteError) throw readError(deleteError, "replaceChunks(delete)");

      // Smaller batches than sections: a row here carries a 384-float vector, so
      // 703 of them in one request would be megabytes of body.
      const BATCH = 50;
      for (let index = 0; index < rows.length; index += BATCH) {
        const { error } = await client
          .from("source_chunks")
          .insert(rows.slice(index, index + BATCH));
        if (error) throw readError(error, "replaceChunks(insert)");
      }
    },
  };
}

export interface SnapshotEntry {
  readonly slug: string;
  readonly sourceId: string;
  readonly docVersion: string;
  readonly contentHash: string;
  readonly sections: number;
  readonly pinned: number;
  readonly license: string;
}

export interface CorpusSnapshot {
  readonly schema: string;
  readonly ingestedAt: string;
  readonly pinnedBudget: {
    readonly maxSections: number;
    readonly maxChars: number;
    readonly sections: number;
    readonly chars: number;
  };
  /**
   * What the retrieval index holds for this corpus (RFC 0013 §3).
   *
   * Recorded here rather than only in the database because the exclusion is a
   * decision about the corpus: a reader asking "why is this section not
   * searchable" gets an answer from the committed file, and the number of chunks
   * the bibliography would have contributed is the size of the saving that
   * decision bought.
   */
  readonly chunks: {
    readonly total: number;
    readonly sections: number;
    readonly bibliography: {
      readonly sections: number;
      readonly chunks: number;
      readonly sectionIds: readonly string[];
    };
  };
  readonly sources: readonly SnapshotEntry[];
}

/**
 * The versioned snapshot manifest the repository keeps as its reproducible
 * record (§3.2 output ②): which document versions, with which content hashes,
 * make up the corpus a release pins. Committed so a report or a trace can name
 * the corpus it was produced against.
 */
export function buildSnapshot(
  documents: readonly CorpusDocument[],
  pinnedBudget: CorpusSnapshot["pinnedBudget"],
  ingestedAt: string,
): CorpusSnapshot {
  const plans = documents.map((document) => planChunks(document));
  const bibliography = plans.reduce(
    (total, plan) => ({
      sections: total.sections + plan.bibliography.sections,
      chunks: total.chunks + plan.bibliography.chunks,
      sectionIds: [...total.sectionIds, ...plan.bibliography.sectionIds],
    }),
    { sections: 0, chunks: 0, sectionIds: [] as string[] },
  );

  return {
    schema: "1.1.0",
    ingestedAt,
    pinnedBudget,
    chunks: {
      total: plans.reduce((total, plan) => total + plan.chunks, 0),
      sections: plans.reduce((total, plan) => total + plan.sections, 0),
      bibliography: {
        sections: bibliography.sections,
        chunks: bibliography.chunks,
        sectionIds: bibliography.sectionIds.sort(),
      },
    },
    sources: [...documents]
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((document) => ({
        slug: document.slug,
        sourceId: document.id,
        docVersion: document.docVersion,
        contentHash: document.contentHash,
        sections: document.sections.length,
        pinned: document.sections.filter((section) => section.pinned).length,
        license: document.license,
      })),
  };
}
