// The NDJSON pump behind POST /api/chat (#88 / RFC 0008 §3.5).
//
// It lives outside the route so the disconnect rule is testable. The rule: a
// locked phone or a backgrounded tab must not eat the answer (ADR 0002's core
// scenario), so losing the client only stops the *framing* — the turn keeps
// being consumed, and every event is still persisted. Only the enqueue is
// allowed to fail, never the iteration.

import type { AnyTurnEvent, TurnResult } from "@/harness/turn";

export interface TurnStreamDeps {
  /** Read after the last event: a trace write was given up on (RFC 0008 §3.6). */
  readonly tracePersistFailed?: () => boolean;
  /**
   * Keeps the instance alive until the turn is drained. Wired to Vercel's
   * `waitUntil`; the stream itself cannot outlive the invocation.
   */
  readonly keepAlive?: (work: Promise<void>) => void;
  /** Where a non-terminal failure is reported (§3.6 ①). */
  readonly onError?: (error: unknown) => void;
  /** Maps a fatal error to the message the client sees. */
  readonly errorFrame?: (error: unknown) => string;
}

/**
 * Frame the turn's event stream as NDJSON.
 *
 * Every turn event is written through untouched; the route-level `terminal` and
 * `error` frames are added here because they are not `AnyTurnEvent`s (no seq, no
 * schema, never persisted).
 */
export function createTurnStream(
  events: AsyncGenerator<AnyTurnEvent, TurnResult, undefined>,
  deps: TurnStreamDeps = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let clientGone = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: unknown): void => {
        if (clientGone) return;
        // Serialized outside the guard on purpose: a frame that cannot be
        // encoded is a bug in what the turn produced, not a client that went
        // away. Letting it reach the pump's catch turns it into an error frame
        // instead of silently dropping the rest of the stream.
        const chunk = encoder.encode(`${JSON.stringify(frame)}\n`);
        try {
          controller.enqueue(chunk);
        } catch {
          // The client is gone. Stop framing and keep draining: the answer and
          // its trace have to survive a disconnect (RFC 0008 §3.5).
          //
          // `cancel()` below is the normal signal and is what the tests drive;
          // this catch covers a platform that errors the stream without calling
          // it, which a cancel-only test cannot reach.
          clientGone = true;
        }
      };

      const pump = (async () => {
        try {
          let next = await events.next();
          while (!next.done) {
            send(next.value);
            next = await events.next();
          }

          const terminal: Record<string, unknown> = {
            type: "terminal",
            ...next.value,
          };
          // A trace that lost an event is still a finished turn: the flag is how
          // the client and the report learn that the record is incomplete.
          if (deps.tracePersistFailed?.()) terminal.trace_persist_failed = true;
          send(terminal);
        } catch (err) {
          // turn() guarantees a terminal event, so reaching here means the
          // failure is outside it (assembly, or a bug in the pump).
          deps.onError?.(err);
          send({
            type: "error",
            error: deps.errorFrame?.(err) ?? "Unknown error",
          });
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by the client cancelling the stream.
          }
        }
      })();

      deps.keepAlive?.(pump);
    },

    cancel() {
      clientGone = true;
    },
  });
}
