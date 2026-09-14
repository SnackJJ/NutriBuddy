// Registry reads for the citation gate (S4 / RFC 0011 §3.5).
//
// The gate needs one thing from the database: for a handful of section ids, what
// the registry currently says about them. It is a port rather than a direct call
// so the gate stays a pure function and so a turn can run without a database at
// all (tests, the CLI), where the answer is "unavailable" and therefore "no
// citation survives".

import type { SupabaseClient } from "@supabase/supabase-js";
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
        .select("id, source_id, sources!inner(doc_version, status)")
        .in("id", [...sectionIds]);
      if (error) throw new Error(`citation registry read failed: ${error.message}`);

      return (data ?? []).flatMap((row: Record<string, unknown>) => {
        const source = row.sources as
          | { readonly doc_version?: unknown; readonly status?: unknown }
          | undefined;
        if (!source) return [];
        const status = String(source.status);
        if (status !== "active" && status !== "superseded" && status !== "archived") {
          return [];
        }
        return [
          {
            sectionId: String(row.id),
            sourceId: String(row.source_id),
            docVersion: String(source.doc_version),
            status,
          } satisfies CitationRegistryEntry,
        ];
      });
    },
  };
}
