// Retryable turn failures (RFC 0004 §6.2): max_steps / crash / aborted
// must preserve the user's original input.

export const RETRYABLE_STOP_REASONS = [
  "max_steps",
  "crash",
  "aborted",
] as const;

export type RetryableStopReason = (typeof RETRYABLE_STOP_REASONS)[number];

export interface RetryableTurnState {
  readonly utterance: string;
  readonly reason: RetryableStopReason | "network" | "http_error";
  readonly detail?: string;
}

export function isRetryableStopReason(
  reason: string | undefined,
): reason is RetryableStopReason {
  return (
    reason === "max_steps" || reason === "crash" || reason === "aborted"
  );
}

export function retryableTitle(reason: RetryableTurnState["reason"]): string {
  switch (reason) {
    case "max_steps":
      return "Loop exhausted";
    case "crash":
      return "Something went wrong";
    case "aborted":
      return "Interrupted";
    case "network":
      return "Network error";
    case "http_error":
      return "Request failed";
  }
}

export function retryableMessage(state: RetryableTurnState): string {
  if (state.detail) return state.detail;
  switch (state.reason) {
    case "max_steps":
      return "The agent hit its step limit. Retry with the same input.";
    case "crash":
      return "A tool or model error stopped the turn. Your input was kept.";
    case "aborted":
      return "The turn was interrupted. Your input was kept.";
    case "network":
      return "Could not reach the server. Your input was kept.";
    case "http_error":
      return "The server returned an error. Your input was kept.";
  }
}
