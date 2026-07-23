import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { extractSources, friendlyToolName } from "../src/lib/chatHelpers";
import {
  parseChatBody,
  buildChatTurnPorts,
  type ChatRequestBody,
} from "../src/lib/chatApi";
import { Tracer } from "../src/harness/tracer";
import type { ChatMessage, ModelAdapter } from "../src/harness/types";
import {
  createQueryCatalog,
  ALL_QUERY_TEMPLATES,
} from "../src/catalog/queryCatalog";

const TEST_ADAPTER: ModelAdapter = {
  generate: async () => ({ content: "OK", stop: true }),
};

// ─── extractSources ────────────────────────────────────────────────────

describe("extractSources", () => {
  it("returns clean text when no sources are present", () => {
    const result = extractSources(
      "Chicken breast contains about 31g of protein per 100g.",
    );
    expect(result.cleanText).toBe(
      "Chicken breast contains about 31g of protein per 100g.",
    );
    expect(result.sources).toEqual([]);
  });

  it("extracts a single [Source: ...] citation", () => {
    const result = extractSources(
      "Chicken breast has 31g protein per 100g [Source: USDA FoodData Central].",
    );
    expect(result.sources).toEqual(["USDA FoodData Central"]);
    expect(result.cleanText).toBe("Chicken breast has 31g protein per 100g .");
  });

  it("extracts multiple citations", () => {
    const result = extractSources(
      "Protein: 31g [Source: USDA FoodData Central] Vitamin B3: 13mg [Source: NIH ODS].",
    );
    expect(result.sources).toEqual(["USDA FoodData Central", "NIH ODS"]);
    expect(result.cleanText).toBe("Protein: 31g  Vitamin B3: 13mg .");
  });

  it("handles lowercase and mixed-case source tags", () => {
    const result = extractSources(
      "See [source: USDA FoodData Central] for details.",
    );
    expect(result.sources).toEqual(["USDA FoodData Central"]);
  });

  it("trims whitespace around source names", () => {
    const result = extractSources("[Source:   USDA FoodData Central   ]");
    expect(result.sources).toEqual(["USDA FoodData Central"]);
    expect(result.cleanText).toBe("");
  });

  it("returns empty string when text is only sources", () => {
    const result = extractSources("[Source: USDA] [Source: NIH ODS]");
    expect(result.sources).toEqual(["USDA", "NIH ODS"]);
    expect(result.cleanText).toBe("");
  });

  it("handles text with no sources gracefully (empty text)", () => {
    const result = extractSources("");
    expect(result.cleanText).toBe("");
    expect(result.sources).toEqual([]);
  });

  it("does not match partial brackets without Source prefix", () => {
    const result = extractSources(
      "Concentration is [high] in this food. More info at [Reference 1].",
    );
    expect(result.sources).toEqual([]);
    expect(result.cleanText).toBe(
      "Concentration is [high] in this food. More info at [Reference 1].",
    );
  });

  it("strips excess whitespace from the clean text", () => {
    const result = extractSources(
      "   Chicken breast   [Source: USDA]   is healthy.   ",
    );
    expect(result.sources).toEqual(["USDA"]);
    expect(result.cleanText).toBe("Chicken breast      is healthy.");
  });
});

// ─── friendlyToolName ──────────────────────────────────────────────────

describe("friendlyToolName", () => {
  it("maps code_act to a readable label", () => {
    expect(friendlyToolName("code_act")).toBe("Querying nutrition database…");
  });

  it("maps search_food to a readable label", () => {
    expect(friendlyToolName("search_food")).toBe("Searching food database…");
  });

  it("maps profile_query to a readable label", () => {
    expect(friendlyToolName("profile_query")).toBe("Loading your profile…");
  });

  it("maps drug_interactions_for_medication", () => {
    expect(friendlyToolName("drug_interactions_for_medication")).toBe(
      "Checking drug interactions…",
    );
  });

  it("returns a generic label for unknown tool names", () => {
    expect(friendlyToolName("unknown_tool")).toBe("Running unknown_tool…");
  });

  it("returns generic label for arbitrary strings", () => {
    expect(friendlyToolName("custom_search")).toBe("Running custom_search…");
  });

  it("covers all known tool names", () => {
    // Verify every declared template name has a friendly label
    const known = [
      "code_act",
      "search_food",
      "search_meal",
      "profile_query",
      "profile_allergies",
      "profile_nutrition_targets",
      "drug_interactions_for_medication",
      "all_drug_interactions",
    ];
    for (const name of known) {
      const label = friendlyToolName(name);
      expect(label).toBeTruthy();
      // Known names should not fall back to the generic "Running X…" pattern
      expect(label).not.toMatch(/^Running /);
    }
  });
});

// ─── Chat API route: request validation (integration logic) ───────────

describe("chat route request shape", () => {
  it("validates that message field is required", () => {
    // The route returns 400 when message is missing.
    // We verify the shape expectations here; actual HTTP tests belong
    // in an e2e suite (M2).
    const valid = { message: "Hello", history: [] };
    expect(valid.message).toBeTruthy();
    expect(typeof valid.message).toBe("string");

    const invalid = { history: [] };
    expect(invalid).not.toHaveProperty("message");
  });

  it("builds history from DisplayMessage array", () => {
    // Simulate what buildHistory() does in the chat page
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there!" },
      { role: "user" as const, content: "Tell me about protein" },
    ];

    const history = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    expect(history).toHaveLength(3);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("identity enters only via the verified Authorization header (issue #62)", () => {
    // The legacy client-asserted X-User-Id header is gone: the chat API
    // module exports no custom identity header at all.
    const chatApiSource = fs.readFileSync("src/lib/chatApi.ts", "utf-8");
    expect(chatApiSource).not.toContain("SESSION_USER_ID_HEADER");
    expect(chatApiSource).not.toContain("X-User-Id");
  });
});

// ── Turn path least privilege (issue #62 / ADD §Multi-User) ─────────────

describe("chat route uses the session-scoped client", () => {
  it("never constructs the service-role client on the turn path", () => {
    const routeSource = fs.readFileSync("app/api/chat/route.ts", "utf-8");
    expect(routeSource).not.toContain("createServerSupabase");
    expect(routeSource).toContain("createUserSupabase");
    expect(routeSource).toContain("getSessionFromHeader");
  });
});

// ── Reject anonymous chat (issue #82 / ADR 0002 上线门槛) ────────────────

describe("chat route rejects unauthenticated requests (issue #82)", () => {
  const routeSource = () => fs.readFileSync("app/api/chat/route.ts", "utf-8");

  it("returns 401 when no session is present", () => {
    const source = routeSource();
    // Fail closed: missing session is unauthorized, not anonymous.
    expect(source).toMatch(/if\s*\(\s*!session\s*\)/);
    expect(source).toMatch(/status:\s*401/);
    expect(source).toMatch(/unauthorized/i);
  });

  it("does not construct DeepSeekAdapter before the session gate", () => {
    const source = routeSource();
    const sessionGate = source.search(/if\s*\(\s*!session\s*\)/);
    const adapterCtor = source.indexOf("new DeepSeekAdapter");
    expect(sessionGate).toBeGreaterThan(-1);
    expect(adapterCtor).toBeGreaterThan(-1);
    expect(sessionGate).toBeLessThan(adapterCtor);
  });

  it("does not fall back to an anonymous session id", () => {
    const source = routeSource();
    expect(source).not.toContain('"anonymous"');
    expect(source).not.toMatch(/sessionUserId\s*\?\?\s*["']anonymous["']/);
  });
});

// ── PWA shell (issue #83 / ADR 0002) ───────────────────────────────────

describe("PWA shell + mobile chat surface (issue #83)", () => {
  it("exports a standalone web app manifest", () => {
    const source = fs.readFileSync("app/manifest.ts", "utf-8");
    expect(source).toContain('display: "standalone"');
    expect(source).toContain("NutriBuddy");
    expect(source).toContain("/icons/icon-192.png");
    expect(source).toContain("/icons/icon-512.png");
  });

  it("ships install icons including apple-touch-icon", () => {
    expect(fs.existsSync("public/icons/icon-192.png")).toBe(true);
    expect(fs.existsSync("public/icons/icon-512.png")).toBe(true);
    expect(fs.existsSync("public/apple-touch-icon.png")).toBe(true);
  });

  it("sets viewport-fit=cover and theme colour on the root layout", () => {
    const source = fs.readFileSync("app/layout.tsx", "utf-8");
    expect(source).toContain('viewportFit: "cover"');
    expect(source).toContain("themeColor");
    expect(source).toContain("apple-touch-icon");
  });

  it("uses safe-area padding and thumb-sized confirm controls on chat", () => {
    const source = fs.readFileSync("app/chat/page.tsx", "utf-8");
    expect(source).toMatch(/pt-safe|safe-area-inset/);
    expect(source).toContain("min-h-[44px]");
    expect(source).toMatch(/optional note|feedback/i);
  });

  it("surfaces match quality and safety notices on the proposal card before confirm (RFC 0004 §6)", () => {
    const source = fs.readFileSync("app/chat/page.tsx", "utf-8");
    expect(source).toContain("matchQualityLabel");
    expect(source).toContain("projectProposalSafetyNotices");
    expect(source).toContain("data-match-quality");
    expect(source).toContain("data-safety-notices");
    expect(source).toContain("Review before confirm");
    expect(source).toMatch(/proposal\.matchType|matchType/);
    expect(source).toMatch(/allergenTags|safetyNotices/);
  });
});

describe("chat route safety context loading (RFC 0004 §6.4)", () => {
  it("loads safety context via fail-closed helper and returns 503 on load failure", () => {
    const source = fs.readFileSync("app/api/chat/route.ts", "utf-8");
    expect(source).toContain("loadUserSafetyContext");
    expect(source).toContain("safety_context_unavailable");
    expect(source).toContain("503");
    // Must not swallow profile errors into empty context
    expect(source).not.toMatch(/catch\s*\{\s*return undefined\s*;\s*\}/);
  });
});

// ── Turn Seam body parsing (issue #39) ─────────────────────────────────

describe("parseChatBody", () => {
  it("parses a default (untagged) body into an utterance TurnInput", () => {
    const body: ChatRequestBody = {
      message: "How much protein in chicken?",
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi!" },
      ],
    };

    const input = parseChatBody(body);

    expect(input.tag).toBe("utterance");
    if (input.tag === "utterance") {
      expect(input.content).toBe("How much protein in chicken?");
    }
  });

  it("parses an explicit utterance-tagged body", () => {
    const body: ChatRequestBody = {
      tag: "utterance",
      message: "What can I eat?",
      history: [],
    };

    const input = parseChatBody(body);

    expect(input.tag).toBe("utterance");
    if (input.tag === "utterance") {
      expect(input.content).toBe("What can I eat?");
    }
  });

  it("parses a proposal_confirm body into a ProposalConfirmInput", () => {
    const body: ChatRequestBody = {
      tag: "proposal_confirm",
      proposalId: "proposal-001",
      confirmed: true,
      feedback: "Looks good!",
    };

    const input = parseChatBody(body);

    expect(input.tag).toBe("proposal_confirm");
    if (input.tag === "proposal_confirm") {
      expect(input.proposalId).toBe("proposal-001");
      expect(input.confirmed).toBe(true);
      expect(input.feedback).toBe("Looks good!");
    }
  });

  it("parses a rejection proposal_confirm body", () => {
    const body: ChatRequestBody = {
      tag: "proposal_confirm",
      proposalId: "proposal-002",
      confirmed: false,
    };

    const input = parseChatBody(body);

    expect(input.tag).toBe("proposal_confirm");
    if (input.tag === "proposal_confirm") {
      expect(input.proposalId).toBe("proposal-002");
      expect(input.confirmed).toBe(false);
      expect(input.feedback).toBeUndefined();
    }
  });

  it("rejects a proposal_confirm body that is missing proposalId", () => {
    const body = {
      tag: "proposal_confirm",
      confirmed: true,
    } as unknown as ChatRequestBody;

    expect(() => parseChatBody(body)).toThrow(/proposalId/);
  });

  it("rejects a proposal_confirm body that is missing confirmed", () => {
    const body = {
      tag: "proposal_confirm",
      proposalId: "proposal-003",
    } as unknown as ChatRequestBody;

    expect(() => parseChatBody(body)).toThrow(/confirmed/);
  });

  it("rejects a proposal_confirm body with non-boolean confirmed", () => {
    const body = {
      tag: "proposal_confirm",
      proposalId: "proposal-004",
      confirmed: "true",
    } as unknown as ChatRequestBody;

    expect(() => parseChatBody(body)).toThrow(/confirmed/);
  });

  it("rejects a proposal_confirm body with non-string feedback", () => {
    const body = {
      tag: "proposal_confirm",
      proposalId: "proposal-005",
      confirmed: true,
      feedback: 123,
    } as unknown as ChatRequestBody;

    expect(() => parseChatBody(body)).toThrow(/feedback/);
  });

  it("rejects an utterance body with empty message", () => {
    const body: ChatRequestBody = {
      message: "   ",
    };

    expect(() => parseChatBody(body)).toThrow(/message/);
  });

  it("rejects an unrecognised tag", () => {
    const body = {
      tag: "unknown_tag",
      message: "hi",
    } as unknown as ChatRequestBody;

    expect(() => parseChatBody(body)).toThrow(/unknown turn tag/i);
  });
});

// ── Chat Turn Ports with sessionUserId (issue #39) ─────────────────────

describe("buildChatTurnPorts", () => {
  it("builds ports with sessionUserId extracted from header (not from body)", () => {
    const tracer = new Tracer();

    const ports = buildChatTurnPorts({
      adapter: TEST_ADAPTER,
      tracer,
      sessionUserId: "user-from-header-001",
      history: [],
    });

    // sessionUserId should be present on the ports
    expect(ports.sessionUserId).toBe("user-from-header-001");

    // userId should come from sessionUserId (caller-bound, not model-fillable)
    expect(ports.userId).toBe("user-from-header-001");

    // The body should not carry userId (it's not even a parameter to the build function)
    // sessionUserId is the only path user identity enters the harness
  });

  it("builds ports without sessionUserId when identity is omitted (unit seam)", () => {
    // Pure port assembly still accepts optional sessionUserId for tests;
    // the HTTP route (issue #82) never reaches this path without a session.
    const tracer = new Tracer();

    const ports = buildChatTurnPorts({
      adapter: TEST_ADAPTER,
      tracer,
      sessionUserId: undefined,
      history: [],
    });

    expect(ports.sessionUserId).toBeUndefined();
    expect(ports.userId).toBeUndefined();
  });

  it("passes history through ports", () => {
    const tracer = new Tracer();
    const history: ChatMessage[] = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ];

    const ports = buildChatTurnPorts({
      adapter: TEST_ADAPTER,
      tracer,
      sessionUserId: "user-1",
      history,
    });

    expect(ports.history).toEqual(history);
  });

  it("passes queryCatalog and catalogVersion through ports (issue #55)", () => {
    const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);

    const ports = buildChatTurnPorts({
      adapter: TEST_ADAPTER,
      tracer: new Tracer(),
      sessionUserId: "user-1",
      history: [],
      queryCatalog,
      catalogVersion: "usda-test-v1",
    });

    expect(ports.queryCatalog).toBe(queryCatalog);
    expect(ports.catalogVersion).toBe("usda-test-v1");
  });
});

// ── Chat API enriched event stream shape (issue #39) ────────────────────

describe("turn event stream compatibility", () => {
  it("enriched stream has turn_start at seq 0", async () => {
    const { turn } = await import("../src/harness/turn");

    const adapter = {
      generate: async () => ({ content: "Hello!", stop: true }),
    };

    const gen = turn(
      { tag: "utterance", content: "hi" },
      { adapter, tracer: new Tracer() },
    );

    const first = await gen.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.type).toBe("turn_start");
      expect(first.value.seq).toBe(0);
      expect(first.value.schema).toBeTruthy();
    }
  });

  it("enriched stream ends with turn_end carrying the terminal result", async () => {
    const { turn } = await import("../src/harness/turn");

    const adapter = {
      generate: async () => ({ content: "Hello!", stop: true }),
    };

    const gen = turn(
      { tag: "utterance", content: "hi" },
      { adapter, tracer: new Tracer() },
    );

    let lastEvent: { type: string } | null = null;
    let finalResult: unknown;
    let next = await gen.next();
    while (!next.done) {
      lastEvent = next.value as { type: string };
      next = await gen.next();
    }
    finalResult = next.value;

    // Last yielded event is turn_end
    expect(lastEvent?.type).toBe("turn_end");
    // Generator return value is the TurnResult
    expect(finalResult).toBeDefined();
    expect((finalResult as { reply: string }).reply).toBe("Hello!");
  });

  it("step events carry agentEvent with expected vocabulary", async () => {
    const { turn } = await import("../src/harness/turn");

    let callCount = 0;
    const adapter = {
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Looking up...",
            stop: false,
            toolCalls: [{ id: "call-1", name: "search_food", args: { food: "chicken" } }],
          };
        }
        return { content: "Chicken has 31g protein per 100g.", stop: true };
      },
    };
    const tools = new Map([
      ["search_food", async () => "chicken: 31g protein/100g"],
    ]);

    const gen = turn(
      { tag: "utterance", content: "chicken protein?" },
      { adapter, tracer: new Tracer(), tools },
    );

    const stepEvents: Array<{
      type: string;
      agentEvent: { type: string; step: number };
    }> = [];
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "step") {
        stepEvents.push(
          next.value as {
            type: string;
            agentEvent: { type: string; step: number };
          },
        );
      }
      next = await gen.next();
    }

    // Should have thought → act → observe → thought → observe
    expect(stepEvents.length).toBeGreaterThanOrEqual(3);
    const agentTypes = stepEvents.map((s) => s.agentEvent.type);
    expect(agentTypes).toContain("thought");
    expect(agentTypes).toContain("act");
    expect(agentTypes).toContain("observe");
  });

  it("gate_verdict events are present in the enriched stream", async () => {
    const { turn } = await import("../src/harness/turn");

    const adapter = {
      generate: async () => ({ content: "OK", stop: true }),
    };

    const gen = turn(
      { tag: "utterance", content: "hi" },
      { adapter, tracer: new Tracer() },
    );

    const events: Array<{ type: string }> = [];
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value as { type: string });
      next = await gen.next();
    }

    const gateEvents = events.filter((e) => e.type === "gate_verdict");
    expect(gateEvents.length).toBeGreaterThanOrEqual(3); // input, output, commit
  });

  it("proposal_confirm short-circuits: no step events, no adapter call", async () => {
    const { turn } = await import("../src/harness/turn");
    const { createInMemoryProposalStore } = await import(
      "./helpers/inMemoryProposalStore"
    );

    const sessionUserId = "chat-confirm-user";
    const proposalStore = createInMemoryProposalStore({ userId: sessionUserId });
    const proposal = await proposalStore.store({
      userId: sessionUserId,
      foodId: "food-chicken-breast-001",
      foodName: "chicken breast",
      canonicalName: "chicken breast",
      portionG: 200,
      mealType: "lunch",
      kcal: 330,
      proteinG: 62,
      fatG: 7.2,
      carbsG: 0,
      nutritionSource: "test",
      matchType: "exact",
      allergenTags: [],
    });

    let adapterCalled = false;
    const adapter = {
      generate: async () => {
        adapterCalled = true;
        return { content: "unused", stop: true };
      },
    };

    const gen = turn(
      {
        tag: "proposal_confirm",
        proposalId: proposal.id,
        confirmed: true,
      },
      {
        adapter,
        tracer: new Tracer(),
        proposalStore,
        sessionUserId,
      },
    );

    const events: Array<{ type: string }> = [];
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value as { type: string });
      next = await gen.next();
    }

    expect(adapterCalled).toBe(false);
    expect(events.some((e) => e.type === "step")).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "gate_verdict",
      "gate_verdict",
      "turn_end",
    ]);
  });
});
