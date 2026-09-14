// The route-level assertions #99 and #103 asked for, executed rather than argued
// (S3 review follow-up).
//
// Why this file needed new test infrastructure: the route lives under `app/` and
// imports through the `@/*` alias, which vitest could not resolve without a
// config — so "the adapter is never called" had to be shown by reading the
// source order. `vitest.config.ts` now provides the alias, and these tests mock
// the three seams the route crosses (auth, Supabase, the model adapter) and call
// `POST` directly.
//
// What is asserted here is exactly the RFC 0010 §5 contract: a refused request
// makes no model call and leaves no turn row, and an allowed request behaves as
// it did before the gate existed.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Model calls this suite's mocked adapter actually saw. */
const generateCalls: unknown[] = [];
/** Statements the mocked Supabase clients were asked to run. */
const supabaseWrites: string[] = [];

const usage = { turns: 0, costUsd: 0 };

vi.mock("@/harness/modelAdapter", () => ({
  DeepSeekAdapter: class {
    readonly profile = { id: "mock", baseUrl: "mock", models: { flash: "f", pro: "p" } };
    async generate(request: unknown) {
      generateCalls.push(request);
      return {
        content: "mock reply",
        stop: true,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }
  },
  computeCostUsd: () => 0.0001,
  TIER_PRICING_USD: {
    flash: { cacheHitPerMTok: 0, cacheMissPerMTok: 0, outputPerMTok: 0 },
    pro: { cacheHitPerMTok: 0, cacheMissPerMTok: 0, outputPerMTok: 0 },
  },
}));

vi.mock("@/lib/auth", () => ({
  getSessionFromHeader: async () => ({
    userId: "user-1",
    accessToken: "token-1",
  }),
  assertSessionSubject: () => {},
}));

/** A Supabase client stub that records writes and answers reads with nothing. */
function stubClient() {
  const builder: Record<string, unknown> = {};
  const chain = () =>
    new Proxy(builder, {
      get(_target, prop) {
        if (prop === "then") {
          // Every read resolves to an empty result; every write is recorded.
          return (resolve: (value: unknown) => void) =>
            resolve({ data: null, error: null, count: 0 });
        }
        if (typeof prop === "string") {
          return (...args: unknown[]) => {
            if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
              supabaseWrites.push(`${prop}:${JSON.stringify(args)}`);
            }
            return chain();
          };
        }
        return undefined;
      },
    });
  return chain();
}

vi.mock("@/lib/supabase", () => ({
  createUserSupabase: () => stubClient(),
  createServerSupabase: () => stubClient(),
}));

vi.mock("@/lib/dailyUsage", () => ({
  createSupabaseDailyUsageReader: () => ({
    readDailyUsage: async () => ({ ...usage }),
  }),
}));

const { POST } = await import("../app/api/chat/route");

function request(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The request shape `parseChatBody` accepts: `message` for utterance turns. */
const UTTERANCE = { message: "how much protein is in an egg?" };

beforeEach(() => {
  generateCalls.length = 0;
  supabaseWrites.length = 0;
  usage.turns = 0;
  usage.costUsd = 0;
  // Re-spying on an already-spied method returns the same mock, so calls
  // accumulate across tests unless they are cleared.
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/chat quota preflight (#99)", () => {
  it("refuses over the daily turn limit with the typed 429 body and never calls the model", async () => {
    usage.turns = 40; // QUOTA_DEFAULT_LIMITS.dailyTurns

    const response = await POST(request(UTTERANCE) as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "quota_exceeded",
      scope: "daily_turns",
      limit: 40,
      current: 40,
    });
    expect(typeof body.resetAt).toBe("string");
    // The assertion #99's DoD asked for, now executed rather than inferred.
    expect(generateCalls).toHaveLength(0);
    // And no turn row was written: the refusal happens before the seam exists.
    expect(supabaseWrites.filter((entry) => entry.startsWith("insert"))).toHaveLength(0);
  });

  it("refuses over the daily cost limit under the daily_cost scope", async () => {
    usage.costUsd = 1;

    const response = await POST(request(UTTERANCE) as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(body.scope).toBe("daily_cost");
    expect(generateCalls).toHaveLength(0);
  });

  it("logs one structured line per refusal (#103)", async () => {
    usage.turns = 40;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await POST(request(UTTERANCE) as never);

    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[quota] "));
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0].replace("[quota] ", "")) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "at",
      "current",
      "limit",
      "path",
      "scope",
      "user_id",
    ]);
    expect(payload).toMatchObject({ path: "/api/chat", scope: "daily_turns", user_id: "user-1" });
  });

  it("admits a request that is under every limit, and then the model is called", async () => {
    const response = await POST(request(UTTERANCE) as never);

    // The turn streams: the generator runs while the body is consumed, so the
    // stream has to be drained before asking whether the model was reached.
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream.length).toBeGreaterThan(0);
    expect(generateCalls.length).toBeGreaterThan(0);
  });
});
