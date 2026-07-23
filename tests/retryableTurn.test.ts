import { describe, expect, it } from "vitest";
import {
  isRetryableStopReason,
  retryableMessage,
  retryableTitle,
} from "../src/lib/retryableTurn";

describe("isRetryableStopReason", () => {
  it("accepts max_steps, crash, aborted", () => {
    expect(isRetryableStopReason("max_steps")).toBe(true);
    expect(isRetryableStopReason("crash")).toBe(true);
    expect(isRetryableStopReason("aborted")).toBe(true);
  });

  it("rejects end_turn and write_proposal", () => {
    expect(isRetryableStopReason("end_turn")).toBe(false);
    expect(isRetryableStopReason("write_proposal")).toBe(false);
    expect(isRetryableStopReason(undefined)).toBe(false);
  });
});

describe("retryable copy", () => {
  it("keeps messages about preserved input", () => {
    expect(retryableTitle("max_steps")).toMatch(/loop|exhaust/i);
    expect(
      retryableMessage({ utterance: "lunch egg", reason: "crash" }),
    ).toMatch(/kept|retry/i);
  });
});
