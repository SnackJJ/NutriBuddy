// Provider faults at the eval boundary (S2 follow-up / issue #129).
//
// The second live baseline hit a 429 mid-harness-run: `turn()` correctly turned it
// into a crash terminal, and the eval then counted the case as a capability
// failure. That is a false regression waiting to happen — one bad minute at the
// provider reads as "this change made the agent worse", and `--compare` marks it.
//
// Two mechanisms, deliberately separate:
//
//   * **retry** what is transient. A rate limit, a 5xx or a dropped connection is
//     a statement about the last few seconds, not about the code under test.
//   * **label** what survives the retries as `infrastructure`, and drop it from the
//     pass-rate denominators — while naming it in the report. Excluding a case
//     silently would be its own kind of lie: the number would improve by shrinking
//     what it measures.
//
// What is *not* retried matters as much: a missing API key, an unknown model or a
// malformed request fails identically every time, and retrying it just spends the
// budget three times to produce the same red line.

/** A provider fault that a second attempt could plausibly survive. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\(429\)/,
  /\b429\b/,
  /\b50[0-4]\b/,
  /timed? ?out|timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i,
  /temporarily (unavailable|overloaded)/i,
  /rate ?limit/i,
  /overloaded/i,
  /upstream .*(?:unavailable|error|failed)/i,
];

export function isTransientProviderError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  readonly attempts: number;
  /** Milliseconds before the second, third, … attempt (exponential). */
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly message: string;
  }) => void;
}

export interface RetryOutcome<T> {
  readonly value: T;
  readonly attempts: number;
  /** Set when every attempt failed transiently: a provider fault, not a verdict. */
  readonly transientFailure?: string;
}

/**
 * Run `attempt` until it produces something that is not a transient provider error.
 *
 * The decision to retry is the caller's (`isRetryable`), because "what counts as an
 * adapter error" differs between the bare arm (a thrown error) and the harness arm
 * (a crash terminal carrying the message in its reply).
 */
export async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  isRetryable: (value: T) => string | undefined,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseDelay = options.baseDelayMs ?? 500;

  let value = await attempt();
  let attempts = 1;
  let lastFailure = isRetryable(value);

  while (lastFailure !== undefined && attempts < options.attempts) {
    options.onRetry?.({ attempt: attempts, message: lastFailure });
    await sleep(baseDelay * 2 ** (attempts - 1));
    value = await attempt();
    attempts += 1;
    lastFailure = isRetryable(value);
  }

  return {
    value,
    attempts,
    ...(lastFailure !== undefined ? { transientFailure: lastFailure } : {}),
  };
}
