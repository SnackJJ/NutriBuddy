import { describe, expect, it } from "vitest";
import {
  createTurnAssembly,
  incompleteAssemblyResult,
  ASSEMBLY_INCOMPLETE,
  CONFIRM_PORTS_INCOMPLETE,
} from "../src/harness/turnAssembly";
import { Tracer } from "../src/harness/tracer";
import type { ModelAdapter } from "../src/harness/types";
import { consumeTurn, turn } from "../src/harness/turn";
import { createInMemoryProposalStore } from "./helpers/inMemoryProposalStore";

const adapter: ModelAdapter = {
  generate: async () => ({ content: "ok", stop: true }),
};

describe("createTurnAssembly (Phase 6)", () => {
  it("fails closed when adapter or tracer missing", () => {
    const r = createTurnAssembly({
      kind: "utterance",
      adapter: undefined as unknown as ModelAdapter,
      tracer: new Tracer(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.checkName).toBe(ASSEMBLY_INCOMPLETE);
    }
  });

  it("fails closed for confirm without proposalStore/sessionUserId", () => {
    const r = createTurnAssembly({
      kind: "proposal_confirm",
      adapter,
      tracer: new Tracer(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.checkName).toBe(CONFIRM_PORTS_INCOMPLETE);
    }
  });

  it("fails closed when tools and toolSchemas are mismatched", () => {
    const r = createTurnAssembly({
      kind: "utterance",
      adapter,
      tracer: new Tracer(),
      tools: new Map(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.checkName).toBe(ASSEMBLY_INCOMPLETE);
    }
  });

  it("fails closed when requireTools is true without tools", () => {
    const r = createTurnAssembly({
      kind: "utterance",
      adapter,
      tracer: new Tracer(),
      requireTools: true,
    });
    expect(r.ok).toBe(false);
  });

  it("succeeds for utterance with adapter+tracer only", () => {
    const r = createTurnAssembly({
      kind: "utterance",
      adapter,
      tracer: new Tracer(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ports.adapter).toBe(adapter);
    }
  });

  it("succeeds for confirm with full ConfirmPorts", () => {
    const store = createInMemoryProposalStore({
      userId: "u1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const r = createTurnAssembly({
      kind: "proposal_confirm",
      adapter,
      tracer: new Tracer(),
      proposalStore: store,
      sessionUserId: "u1",
    });
    expect(r.ok).toBe(true);
  });

  it("incompleteAssemblyResult is crash with non-empty reply", () => {
    const result = incompleteAssemblyResult("ports missing", "p1");
    expect(result.stopReason).toBe("crash");
    expect(result.reply).toContain("ports missing");
    expect(result.reply).toContain("p1");
  });

  it("assembled utterance ports drive turn() to one terminal", async () => {
    const assembly = createTurnAssembly({
      kind: "utterance",
      adapter,
      tracer: new Tracer(),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;

    const events: unknown[] = [];
    const result = await consumeTurn(
      turn({ tag: "utterance", content: "hello" }, assembly.ports),
      (e) => events.push(e),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(
      events.filter(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { type: string }).type === "turn_end",
      ),
    ).toHaveLength(1);
  });
});
