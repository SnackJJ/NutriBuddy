/**
 * One live turn with retrieval wired, D8 style (V1.1 / RFC 0013 §5, issue #135).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-retrieval.mts "Why is vitamin D important?"
 *
 * What it proves that the unit tests cannot: a real model, handed retrieved
 * sections alongside the pinned set, produces a citation that survives the
 * citation gate's registry check — the D8 acceptance of RFC 0011 §3, now for a
 * section the pinned set never had.
 *
 * The corpus read is the whole point, so the target must be the local stack: a
 * smoke that quietly read a hosted project would measure a corpus nobody
 * ingested here, and a smoke that *wrote* to one would be worse. Refuses anything
 * that is not 127.0.0.1 / localhost.
 *
 * The model key is the one variable this needs from `.env.local`; the two
 * Supabase values are taken from the environment when set, so pointing the run at
 * the local stack does not require editing the file.
 *
 * Exit codes: 0 a citation survived, 1 no citation or it was stripped,
 * 2 missing configuration or a non-local target.
 */

import { createClient } from "@supabase/supabase-js";
import { consumeTurn, turn, type AnyTurnEvent } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import { DeepSeekAdapter } from "../src/harness/modelAdapter";
import { SUBMIT_ANSWER_SCHEMA } from "../src/harness/submitAnswer";
import {
  createSupabaseEvidenceTextSource,
  loadPinnedEvidence,
} from "../src/evidence/registry";
import { createSupabaseRetriever } from "../src/evidence/retrieval";
import { createEdgeFunctionEmbedder } from "../src/evidence/embedding";
import {
  loadRetrievalEvidence,
  withRetrievedSections,
} from "../src/evidence/retrievalContext";
import { isLocalTarget, loadEnvLocal, requireEnv } from "./lib/env";

const DEFAULT_QUESTION = "Why is vitamin D important for health?";

async function main(): Promise<number> {
  const question = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? DEFAULT_QUESTION;
  const env = loadEnvLocal();

  let url: string;
  let serviceKey: string;
  let anonKey: string;
  try {
    url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    serviceKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
    anonKey = requireEnv(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  } catch (err) {
    console.error(`smoke-retrieval: ${(err as Error).message}`);
    return 2;
  }

  if (!isLocalTarget(url)) {
    console.error(`smoke-retrieval: refusing to run against ${url}`);
    console.error("  this smoke reads the corpus a local ingest just built; point the env vars at the local stack:");
    console.error('    export NEXT_PUBLIC_SUPABASE_URL="$(npx supabase status -o env | sed -n \'s/^API_URL="\\(.*\\)"$/\\1/p\')"');
    console.error('    export SUPABASE_SERVICE_ROLE_KEY="$(npx supabase status -o env | sed -n \'s/^SERVICE_ROLE_KEY="\\(.*\\)"$/\\1/p\')"');
    return 2;
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const loaded = await loadPinnedEvidence(client);
  const retrieved = await loadRetrievalEvidence({
    retriever: createSupabaseRetriever(client, {
      embed: createEdgeFunctionEmbedder({ baseUrl: url, apiKey: anonKey }),
      onFailure: (side, error) =>
        console.error(`  ! retrieval ${side} side failed: ${String(error).slice(0, 160)}`),
    }),
    texts: createSupabaseEvidenceTextSource(client),
    query: question,
    sourceVersion: loaded.evidence.evidenceSet.sourceVersion,
  });

  console.log(`question: ${question}`);
  console.log(
    `retrieval: ${retrieved.sectionIds.length} section(s) injected` +
      `${retrieved.provenance.degraded ? ` (degraded: ${retrieved.provenance.degraded})` : ""}`,
  );
  for (const hit of retrieved.provenance.hits) {
    console.log(`  ${hit.sectionId}  via=${hit.via.join("+")}  score=${hit.score.toFixed(4)}`);
  }

  // The same adapter the chat route builds: provider and keys come from the
  // environment, and `env` already folded `.env.local` under it.
  const adapter = new DeepSeekAdapter({ env });
  const events: AnyTurnEvent[] = [];
  const result = await consumeTurn(
    turn(
      { tag: "utterance", content: question },
      {
        adapter,
        tracer: new Tracer(),
        evidenceText: loaded.evidence.text,
        evidenceSet: withRetrievedSections(loaded.evidence.evidenceSet, retrieved.sectionIds),
        citationRegistry: loaded.registry,
        // `submit_answer` is recognised by the loop itself and terminates the turn
        // with the typed output parsed from its arguments (submitAnswer.ts), so the
        // schema is what the model needs; without it the answer arrives as a
        // tool-call blob in the reply and no citation can exist. There is no
        // handler for it, which is why the map below is empty.
        tools: new Map(),
        toolSchemas: [SUBMIT_ANSWER_SCHEMA],
        retrievedEvidence: retrieved.text,
        retrievalProvenance: retrieved.provenance,
      } as never,
    ),
    (event) => events.push(event),
  );

  const start = events.find((event) => event.type === "turn_start");
  const verdict = events.find(
    (event) => event.type === "gate_verdict" && event.checkName === "citation_provenance",
  );
  if (verdict?.type === "gate_verdict") {
    console.log(`citation verdict: ${verdict.verdict} (terminal=${verdict.terminal}) — ${verdict.evidence}`);
  }
  console.log(
    `turn_start.retrieval: ${start?.type === "turn_start" && start.retrieval ? "recorded" : "absent"}`,
  );

  const citations = result.output?.citations ?? [];
  console.log(`stopReason=${result.stopReason} · citations kept=${citations.length}`);
  for (const citation of citations) {
    console.log(`  cited ${citation.sectionId} (${citation.sourceId}@${citation.docVersion})`);
  }
  console.log("--- reply ---");
  console.log(result.reply.slice(0, 900));

  if (citations.length === 0) {
    console.error("\nsmoke-retrieval: no citation survived — retrieval did not reach the answer");
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`smoke-retrieval: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
