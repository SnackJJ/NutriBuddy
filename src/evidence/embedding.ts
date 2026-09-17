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
