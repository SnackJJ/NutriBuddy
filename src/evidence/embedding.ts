// Corpus-side embeddings (V1.1 / docs/adr/0006, issue #133).
//
// The model is gte-small, the same one Supabase Edge Functions run natively, so
// the query side needs no new vendor and no new key. Two runtimes run one model
// — Node here at ingest, Deno at query time — which is the price of keeping the
// ingest a single local command; ADR 0006 states that price, and the guard
// against the two drifting is a pinned config plus a one-off cross-check, not a
// unit test that could catch Supabase swapping the model underneath us.
//
// The pipeline is loaded lazily: importing this module must not download 30 MB
// of weights, or every test that touches the ingest would need the network.

/** Model id and shape, pinned in one place because two runtimes read them. */
export const GTE_SMALL = {
  model: "Supabase/gte-small",
  dimensions: 384,
  /** Both sides must pool and normalise the same way or the spaces differ. */
  pooling: "mean" as const,
  normalize: true,
} as const;

export interface ProgressReporter {
  (done: number, total: number): void;
}

export interface EmbeddingPort {
  /**
   * Vectors for `texts`, in order.
   *
   * The reporter is optional and purely for a human watching a few-minute ingest;
   * a port that ignores it is complete (the test stubs do).
   */
  embed(
    texts: readonly string[],
    onProgress?: ProgressReporter,
  ): Promise<readonly (readonly number[])[]>;
}

/**
 * gte-small through transformers.js, batched.
 *
 * Batched because the corpus is ~700 chunks and a per-text call spends its time
 * in interpreter overhead; 16 keeps memory flat while still reporting progress a
 * human can watch.
 */
export function createGteSmallEmbedder(options: { readonly batchSize?: number } = {}) {
  const batchSize = options.batchSize ?? 16;
  let extractor: unknown;

  async function load(): Promise<(texts: readonly string[], opts: object) => Promise<{ tolist(): number[][] }>> {
    if (!extractor) {
      const transformers = await import("@huggingface/transformers");
      extractor = await transformers.pipeline("feature-extraction", GTE_SMALL.model);
    }
    return extractor as (texts: readonly string[], opts: object) => Promise<{ tolist(): number[][] }>;
  }

  return {
    model: GTE_SMALL.model,
    dimensions: GTE_SMALL.dimensions,

    async embed(texts: readonly string[], onProgress?: ProgressReporter): Promise<readonly (readonly number[])[]> {
      const run = await load();
      const vectors: number[][] = [];
      for (let index = 0; index < texts.length; index += batchSize) {
        const batch = texts.slice(index, index + batchSize);
        const output = await run(batch, {
          pooling: GTE_SMALL.pooling,
          normalize: GTE_SMALL.normalize,
        });
        const rows = output.tolist();
        for (const row of rows) {
          if (row.length !== GTE_SMALL.dimensions) {
            throw new Error(
              `embedding came back with ${row.length} dimensions, expected ${GTE_SMALL.dimensions} ` +
                `(${GTE_SMALL.model}); the vector column is vector(${GTE_SMALL.dimensions})`,
            );
          }
          vectors.push(row);
        }
        onProgress?.(Math.min(index + batchSize, texts.length), texts.length);
      }
      if (vectors.length !== texts.length) {
        throw new Error(`embedded ${vectors.length} of ${texts.length} texts`);
      }
      return vectors;
    },
  };
}

/**
 * The query-side embedder: the deployed Edge Function, not an in-process model
 * (ADR 0006).
 *
 * Vercel's node runtime cannot carry the ONNX weights the ingest uses locally, so
 * the query half of the pair calls the function that runs the same model inside
 * Supabase. The two are the same `gte-small` with the same pooling and
 * normalisation, which is what makes a query vector comparable with the corpus
 * vectors; ADR 0006 records that this guard is a pinned config plus a one-off
 * cross-check rather than something a unit test can hold.
 *
 * Failures are thrown, not swallowed: the retriever turns them into
 * `unavailable`, and a turn with no retrieval must be a labelled degradation
 * rather than a silently empty evidence block (RFC 0013 §5).
 */
/**
 * How long the query embedding may take before the turn gives up on it.
 *
 * This call sits in front of every utterance turn, so a function that accepts the
 * connection and never answers would otherwise stall the turn until the platform's
 * own ceiling kills the whole request — a failed turn, not the labelled
 * degradation the retrieval path promises. Eight seconds is far above a healthy
 * round trip (gte-small on a short query) and far below a user's patience.
 */
export const EMBED_TIMEOUT_MS = 8_000;

export function createEdgeFunctionEmbedder(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injectable for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): EmbeddingPort & { readonly model: string; readonly dimensions: number } {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/functions/v1/embed`;

  return {
    model: GTE_SMALL.model,
    dimensions: GTE_SMALL.dimensions,

    async embed(texts) {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ texts }),
        // Without a deadline the failure mode is a hang, and a hang is the one
        // failure the caller's catch never sees.
        signal: AbortSignal.timeout(options.timeoutMs ?? EMBED_TIMEOUT_MS),
      });

      if (!response.ok) {
        // The body carries the function's own reason (an unsupported runtime, a
        // bad dimension), which is the difference between "retrieval is down" and
        // "retrieval is misconfigured".
        const detail = await response.text().catch(() => "");
        throw new Error(`embed function returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }

      const payload = (await response.json()) as { embeddings?: unknown };
      const embeddings = payload.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error(`embed function returned ${Array.isArray(embeddings) ? embeddings.length : "no"} vectors for ${texts.length} texts`);
      }
      return embeddings as number[][];
    },
  };
}
