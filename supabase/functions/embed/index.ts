// Query-side embeddings for retrieval (V1.1 / docs/adr/0006, issue #134).
//
// gte-small runs natively inside the Edge Runtime — no external API, no extra
// vendor holding a user's question — and this is the query half of the model the
// ingest runs on the corpus side. The two must stay in step (model id, mean
// pooling, normalisation); ADR 0006 records that guard as a pinned config plus a
// one-off cross-check, because a unit test cannot catch Supabase changing the
// model underneath us.
//
// Deploy:  supabase functions deploy embed
// Local:   supabase functions serve embed
// Call it: POST /functions/v1/embed  { "texts": ["..."] }  with the anon or
//          service key in `Authorization: Bearer`.
//
// Contract: { model, dimensions, embeddings: number[][] } — the shape
// `src/evidence/embedding.ts` expects from its port, so a caller can swap the
// in-process embedder for this endpoint without touching retrieval.

/** The runtime's own id for the model — the short name, not the HF repo id. */
const SESSION_MODEL = "gte-small";
/** The Hugging Face identity, which is what the corpus side pins (ADR 0006). */
const MODEL = "Supabase/gte-small";
const DIMENSIONS = 384;

/** Upper bound per request: the corpus ingest batches 16, the query side sends 1. */
const MAX_TEXTS = 32;

/**
 * Upper bound per text, in characters.
 *
 * The anon key is public by design, so anyone can call this function; a count cap
 * alone would leave an unbounded string to tokenize and run through the model.
 * gte-small truncates at 512 tokens, so anything beyond a few thousand characters
 * is work that can only be thrown away.
 */
const MAX_TEXT_CHARS = 4_000;

/**
 * The model session, created on first use rather than at module load.
 *
 * A top-level `new Supabase.ai.Session(...)` fails the whole function when the
 * runtime does not expose `Supabase.ai`, and the failure surfaces as a bare
 * "Internal Server Error" with no body — which is what an operator would then
 * have to debug from a log they cannot see. Built lazily, the same condition
 * comes back as a JSON error naming the cause.
 */
let session: { run(text: string, options: object): Promise<unknown> } | undefined;

function modelSession(): { run(text: string, options: object): Promise<unknown> } {
  if (!session) {
    const ai = (globalThis as { Supabase?: { ai?: { Session?: new (model: string) => { run(text: string, options: object): Promise<unknown> } } } }).Supabase?.ai;
    if (!ai?.Session) {
      throw new Error(
        "this runtime does not expose Supabase.ai — gte-small needs the Supabase edge runtime " +
          "(hosted, or a local CLI whose edge-runtime bundles it)",
      );
    }
    session = new ai.Session(SESSION_MODEL);
  }
  return session;
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handle(request);
  } catch (error) {
    // The caller is this project's own server, not a browser: the message is the
    // point, and it never reaches a user (turn-level errors are sanitised where
    // they enter the event stream, per RFC 0002 §2.5).
    console.error("embed failed:", error);
    return Response.json({ error: String((error as Error)?.message ?? error) }, { status: 500 });
  }
});

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  let texts: unknown;
  try {
    ({ texts } = await request.json());
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== "string")) {
    return Response.json({ error: "texts must be a non-empty array of strings" }, { status: 400 });
  }
  if (texts.length > MAX_TEXTS) {
    return Response.json({ error: `at most ${MAX_TEXTS} texts per request` }, { status: 413 });
  }
  const tooLong = (texts as string[]).find((text) => text.length > MAX_TEXT_CHARS);
  if (tooLong !== undefined) {
    return Response.json(
      { error: `each text must be at most ${MAX_TEXT_CHARS} characters (got ${tooLong.length})` },
      { status: 413 },
    );
  }

  // Sequential rather than Promise.all: the session is one model instance, and a
  // request that batches 32 short queries is not the path worth optimising.
  const embeddings: number[][] = [];
  for (const text of texts as string[]) {
    const embedding = (await modelSession().run(text, {
      mean_pool: true,
      normalize: true,
    })) as number[];
    if (embedding.length !== DIMENSIONS) {
      return Response.json(
        { error: `model returned ${embedding.length} dimensions, expected ${DIMENSIONS}` },
        { status: 500 },
      );
    }
    embeddings.push(embedding);
  }

  return Response.json({ model: MODEL, dimensions: DIMENSIONS, embeddings });
}
