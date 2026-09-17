/**
 * Evidence corpus ingest (S4 / RFC 0011 §3.2, issue #107).
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/ingest-sources.mts            # upsert the committed corpus
 *   npx tsx --env-file=.env.local scripts/ingest-sources.mts --dry      # decide, write nothing
 *   npx tsx --env-file=.env.local scripts/ingest-sources.mts --only ods-iron
 *   npx tsx --env-file=.env.local scripts/ingest-sources.mts --rechunk  # rebuild the retrieval index only
 *   npx tsx --env-file=.env.local scripts/ingest-sources.mts --no-embed # skip the embedding pass
 *
 * Reads `sources/<id>/manifest.json` + `sections.jsonl` (written by
 * `scripts/fetch-sources.mts`), writes `sources` / `source_sections` /
 * `source_chunks` through the service role, and refreshes `sources/snapshot.json`
 * — the committed record of which document versions and content hashes a release
 * pins, and of what the retrieval index holds for them.
 *
 * `--rechunk` exists because chunks are derived: when the chunking rule or the
 * embedding model changes, the registry is already correct and only the index is
 * stale. A plain re-run cannot fix that — unchanged content is skipped by design
 * — so the rebuild is its own mode, and it deliberately does not refresh the
 * snapshot (it establishes nothing about which versions are in the database).
 *
 * Exit codes: 0 ok, 1 the corpus or the database refused, 2 missing configuration.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadCorpus } from "../src/evidence/corpus";
import {
  buildSnapshot,
  createSupabaseRegistryStore,
  ingestDocument,
  rechunkDocument,
  type CorpusSnapshot,
} from "../src/evidence/ingest";
import { createGteSmallEmbedder } from "../src/evidence/embedding";
import { isLocalTarget, loadEnvLocal, requireEnv } from "./lib/env";

const SNAPSHOT_PATH = "sources/snapshot.json";

interface Args {
  readonly dry: boolean;
  readonly only?: string;
  readonly snapshotOnly: boolean;
  readonly rechunk: boolean;
  readonly noEmbed: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let dry = false;
  let only: string | undefined;
  let snapshotOnly = false;
  let rechunk = false;
  let noEmbed = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry") dry = true;
    else if (argv[i] === "--snapshot-only") snapshotOnly = true;
    else if (argv[i] === "--rechunk") rechunk = true;
    else if (argv[i] === "--no-embed") noEmbed = true;
    else if (argv[i] === "--only") {
      only = argv[++i];
      if (!only) throw new Error("--only needs a source id");
    } else throw new Error(`unknown argument "${argv[i]}"`);
  }
  return { dry, only, snapshotOnly, rechunk, noEmbed };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ingest-sources: ${(err as Error).message}`);
    return 1;
  }

  // The corpus is checked before anything touches a database: a broken hash or a
  // pinned section that does not exist is a repository problem, and finding it
  // after a partial write would leave the registry half-updated.
  let corpus;
  try {
    corpus = loadCorpus();
  } catch (err) {
    console.error(`ingest-sources: ${(err as Error).message}`);
    return 1;
  }

  const documents = args.only
    ? corpus.documents.filter((document) => document.slug === args.only)
    : corpus.documents;
  if (documents.length === 0) {
    console.error(`ingest-sources: no document matched ${args.only ?? "(all)"}`);
    return 1;
  }

  const ingestedAt = new Date().toISOString();
  const budget = {
    maxSections: corpus.pinnedBudget.maxSections,
    maxChars: corpus.pinnedBudget.maxChars,
    sections: corpus.pinnedBudget.sections,
    chars: corpus.pinnedBudget.chars,
  };

  if (args.snapshotOnly) {
    writeSnapshot(buildSnapshot(corpus.documents, budget, ingestedAt));
    console.log(`wrote ${SNAPSHOT_PATH} for ${corpus.documents.length} document(s), no database writes`);
    return 0;
  }

  const env = loadEnvLocal();
  let url: string;
  let key: string;
  try {
    url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    key = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  } catch (err) {
    console.error(`ingest-sources: ${(err as Error).message}`);
    console.error("  set it in .env.local or export it before running");
    return 2;
  }

  console.log(`target: ${url}${isLocalTarget(url) ? " (local stack)" : ""}`);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const store = createSupabaseRegistryStore(client);
  const embedder = args.noEmbed ? undefined : createGteSmallEmbedder();
  const options = {
    dry: args.dry,
    embed: embedder,
    onEmbedProgress: (done: number, total: number): void => {
      if (done >= total) process.stdout.write(`\r${" ".repeat(44)}\r`);
      else process.stdout.write(`\r  embedding ${done}/${total}`);
    },
  };
  if (!embedder) {
    console.log("chunks will be written without vectors (--no-embed): lexical search only");
  }

  let failures = 0;
  let written = 0;
  let chunks = 0;
  for (const document of documents) {
    try {
      if (args.rechunk) {
        const plan = await rechunkDocument(store, document, options);
        chunks += plan.chunks;
        console.log(
          `${document.slug.padEnd(22)} ${args.dry ? "rechunk planned" : "rechunked"}`.padEnd(46) +
            `${String(plan.chunks).padStart(4)} chunks · bibliography excluded ${plan.bibliography.sections} section(s) / ${plan.bibliography.chunks} chunk(s)`,
        );
        continue;
      }

      const outcome = await ingestDocument(store, document, options);
      written += outcome.written ? 1 : 0;
      chunks += outcome.chunks;
      console.log(
        `${document.slug.padEnd(22)} ${outcome.plan.action.padEnd(20)} ${String(outcome.plan.sections).padStart(4)} sections ` +
          `(${outcome.plan.pinned} pinned) · ${outcome.chunks} chunks · ${outcome.plan.reason}`,
      );
    } catch (err) {
      failures += 1;
      console.error(`${document.slug.padEnd(22)} FAILED: ${(err as Error).message}`);
    }
  }

  if (failures === 0 && !args.dry && !args.rechunk) {
    // Only a complete run refreshes the snapshot: a partial ingest would produce
    // a snapshot claiming versions that were never written, and a rechunk run
    // establishes nothing about which versions are in the database.
    writeSnapshot(buildSnapshot(corpus.documents, budget, ingestedAt));
    console.log(`wrote ${SNAPSHOT_PATH}`);
  }

  console.log(
    `\n${documents.length - failures}/${documents.length} document(s) ${args.dry ? "planned (dry run)" : `ingested (${written} written)`}` +
      ` · pinned ${budget.sections} sections / ${budget.chars} chars · ${chunks} chunks`,
  );
  return failures === 0 ? 0 : 1;
}

function writeSnapshot(snapshot: CorpusSnapshot): void {
  writeFileSync(join(SNAPSHOT_PATH), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

/** `--help` without a parser: the usage line above is the documentation. */
if (process.argv.slice(2).includes("--help")) {
  console.log(readFileSync("scripts/ingest-sources.mts", "utf8").split("*/")[0]);
  process.exitCode = 0;
} else {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`ingest-sources: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
