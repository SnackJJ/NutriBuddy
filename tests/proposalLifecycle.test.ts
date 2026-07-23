import { describe, expect, it } from "vitest";
import {
  PROPOSAL_TTL_MS,
  isProposalStale,
  proposalAgeMs,
} from "../src/lib/proposalLifecycle";

describe("proposalLifecycle", () => {
  it("treats proposals under 30 minutes as fresh", () => {
    const created = new Date("2026-07-23T12:00:00.000Z").toISOString();
    const now = Date.parse("2026-07-23T12:10:00.000Z");
    expect(isProposalStale(created, now)).toBe(false);
    expect(proposalAgeMs(created, now)).toBe(10 * 60 * 1000);
  });

  it("marks proposals at or after 30 minutes as stale", () => {
    const created = new Date("2026-07-23T12:00:00.000Z").toISOString();
    const now = Date.parse("2026-07-23T12:00:00.000Z") + PROPOSAL_TTL_MS;
    expect(isProposalStale(created, now)).toBe(true);
  });
});
