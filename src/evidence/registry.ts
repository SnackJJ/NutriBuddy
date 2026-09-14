// Registry reads for the citation gate (S4 / RFC 0011 §3.5).
//
// The gate needs one thing from the database: for a handful of section ids, what
// the registry currently says about them. It is a port rather than a direct call
// so the gate stays a pure function and so a turn can run without a database at
// all (tests, the CLI), where the answer is "unavailable" and therefore "no
// citation survives".

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assemblePinnedEvidence, type EvidenceSection, type PinnedEvidence } from "./pinnedSet";
import type {
  CitationRegistry,
  CitationRegistryEntry,
} from "../harness/citationGate";

export type { CitationRegistry };

export function createSupabaseCitationRegistry(client: SupabaseClient): CitationRegistry {
  return {
    async entries(sectionIds) {
      if (sectionIds.length === 0) return [];
      const { data, error } = await client
        .from("source_sections")
        .select("id, sources!inner(slug, doc_version, status)")
        .in("id", [...sectionIds]);
      if (error) throw new Error(`citation registry read failed: ${error.message}`);

      return (data ?? []).flatMap((row: Record<string, unknown>) => {
        // PostgREST returns a to-one embed as an object, while its generated
        // types describe an array; both shapes are handled because taking [0] of
        // an object is silently `undefined` — which reads as "unknown section"
        // and would strip every citation without an error.
        const embedded = row.sources as
          | { readonly slug?: unknown; readonly doc_version?: unknown; readonly status?: unknown }
          | readonly { readonly slug?: unknown; readonly doc_version?: unknown; readonly status?: unknown }[]
          | undefined;
        const source = Array.isArray(embedded) ? embedded[0] : embedded;
        if (!source) return [];
        const status = String(source.status);
        if (status !== "active" && status !== "superseded" && status !== "archived") {
          return [];
        }
        return [
          {
            sectionId: String(row.id),
            sourceId: String(source.slug),
            docVersion: String(source.doc_version),
            status,
          } satisfies CitationRegistryEntry,
        ];
      });
    },
  };
}

interface PinnedRow {
  readonly id: string;
  readonly source_id: string;
  readonly section_path: string;
  readonly heading: string | null;
  readonly ordinal: number;
  readonly text: string;
  readonly anchor: string | null;
  /**
   * The to-one embed. PostgREST returns one object here, while supabase-js's
   * generated types describe an array — both shapes are handled, because getting
   * this wrong is silent: `sources[0]` on an object is `undefined`, and the
   * loader then reports an empty pinned set rather than an error.
   */
  readonly sources:
    | { readonly slug?: unknown; readonly doc_version?: unknown; readonly status?: unknown }
    | readonly { readonly slug?: unknown; readonly doc_version?: unknown; readonly status?: unknown }[]
    | undefined;
}

/**
 * The corpus version, derived from what is actually in the registry.
 *
 * Built from the active documents' (id, content_hash) pairs rather than read from
 * a file, because the route runs where the corpus files may not be deployed and
 * because the version has to describe the rows a turn was judged against, not the
 * rows someone intended to ingest. Sorted before hashing, so the same registry
 * always produces the same label.
 */
export function corpusVersionFrom(
  sources: readonly { readonly id: string; readonly contentHash: string }[],
): string {
  const canonical = [...sources]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((source) => `${source.id}:${source.contentHash}`)
    .join("\n");
  return `corpus:${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

export interface LoadedEvidence {
  readonly evidence: PinnedEvidence;
  readonly registry: CitationRegistry;
}

/**
 * Load the pinned set the route puts in context, or nothing.
 *
 * Failure is not fatal here on purpose: the product can answer without citable
 * evidence (that is the pre-S4 behaviour), and a citation is never allowed to be
 * unverifiable, so "no evidence" is a smaller failure than "evidence nobody
 * checked". The catch is at the call site, which logs it.
 */
export async function loadPinnedEvidence(
  client: SupabaseClient,
): Promise<LoadedEvidence> {
  const { data: sourceRows, error: sourceError } = await client
    .from("sources")
    .select("id, content_hash")
    .eq("status", "active");
  if (sourceError) throw new Error(`sources read failed: ${sourceError.message}`);

  const sources = (sourceRows ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    contentHash: String(row.content_hash),
  }));

  const { data: pinnedRows, error: pinnedError } = await client
    .from("source_sections")
    .select(
      "id, source_id, section_path, heading, ordinal, text, anchor, sources!inner(slug, doc_version, status)",
    )
    .eq("pinned", true);
  if (pinnedError) throw new Error(`pinned sections read failed: ${pinnedError.message}`);

  const sections: EvidenceSection[] = (pinnedRows ?? []).flatMap(
    (row: PinnedRow) => {
      const source = Array.isArray(row.sources) ? row.sources[0] : row.sources;
      if (!source || String(source.status) !== "active") return [];
      return [
        {
          id: String(row.id),
          sourceId: String(source.slug),
          docVersion: String(source.doc_version),
          sectionPath: String(row.section_path),
          heading: row.heading === null ? null : String(row.heading),
          ordinal: Number(row.ordinal),
          text: String(row.text),
          anchor: row.anchor === null ? undefined : String(row.anchor),
        },
      ];
    },
  );

  return {
    evidence: assemblePinnedEvidence(sections, corpusVersionFrom(sources)),
    registry: createSupabaseCitationRegistry(client),
  };
}
