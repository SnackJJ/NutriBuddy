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

export interface RegistryStore {
  /** The version currently marked active for this document, if any. */
  findActiveSource(slug: string): Promise<{ readonly id: string; readonly contentHash: string } | undefined>;
  insertSource(row: SourceRow): Promise<void>;
  markSuperseded(sourceId: string): Promise<void>;
  existingSectionIds(sourceId: string): Promise<readonly string[]>;
  upsertSections(rows: readonly SectionRow[]): Promise<void>;
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

export interface IngestOutcome {
  readonly plan: IngestPlan;
  /** False on `skip`, and on a dry run. */
  readonly written: boolean;
}

export async function ingestDocument(
  store: RegistryStore,
  document: CorpusDocument,
  options: { readonly dry?: boolean } = {},
): Promise<IngestOutcome> {
  const active = await store.findActiveSource(document.slug);
  const plan = planIngest(document, active);

  if (plan.action === "skip" || options.dry) {
    return { plan, written: false };
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
  return { plan, written: true };
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
  return {
    schema: "1.0.0",
    ingestedAt,
    pinnedBudget,
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
