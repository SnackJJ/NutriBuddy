import { describe, it, expect } from "vitest";
import {
  DeepSeekAdapter,
  resolveProviderProfile,
  TIER_TO_MODEL_ID,
} from "../src/harness/modelAdapter";
import type { ToolSchema } from "../src/harness/types";

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function toolCallResponse(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("DeepSeekAdapter", () => {
  it("posts to the chat completions endpoint with the bearer key and tier model id", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const adapter = new DeepSeekAdapter({
      apiKey: "secret-key",
      baseUrl: "https://api.deepseek.com/v1",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return okResponse("an egg has ~6g protein");
      },
    });

    const res = await adapter.generate({
      model: "flash",
      thinking: true,
      messages: [{ role: "user", content: "protein in an egg?" }],
    });

    expect(res.content).toBe("an egg has ~6g protein");
    expect(res.stop).toBe(true);
    expect(captured?.url).toBe("https://api.deepseek.com/v1/chat/completions");

    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-key");

    const body = JSON.parse(String(captured?.init.body));
    expect(body.model).toBe(TIER_TO_MODEL_ID.flash);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.messages).toEqual([
      { role: "user", content: "protein in an egg?" },
    ]);
  });

  it("reads the key from DEEPSEEK_API_KEY when none is passed", async () => {
    let authSeen: string | null = null;
    const adapter = new DeepSeekAdapter({
      env: { DEEPSEEK_API_KEY: "env-key" },
      fetchImpl: async (_url, init) => {
        authSeen = new Headers(init?.headers).get("authorization");
        return okResponse("ok");
      },
    });

    await adapter.generate({ model: "flash", thinking: false, messages: [] });
    expect(authSeen).toBe("Bearer env-key");
  });

  it("throws a clear error when no API key is available", () => {
    expect(() => new DeepSeekAdapter({ env: {} })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("surfaces a readable error on a non-2xx response", async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });

    await expect(
      adapter.generate({ model: "flash", thinking: false, messages: [] }),
    ).rejects.toThrow(/401/);
  });

  it("throws on a 200 response whose body lacks choices[0].message.content", async () => {
    // A 2xx with a malformed payload must fail loudly, not silently return
    // { content: undefined } and pretend the model answered.
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(
      adapter.generate({ model: "flash", thinking: false, messages: [] }),
    ).rejects.toThrow(/content/);
  });

  // ─── thinking knob as object shape ─────────────────────────────────

  it("sends thinking as {type: 'enabled'} when thinking is true", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        captured = JSON.parse(String(init?.body));
        return okResponse("ok");
      },
    });

    await adapter.generate({ model: "flash", thinking: true, messages: [] });
    expect(captured?.thinking).toEqual({ type: "enabled" });
  });

  it("sends thinking as {type: 'disabled'} when thinking is false", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        captured = JSON.parse(String(init?.body));
        return okResponse("ok");
      },
    });

    await adapter.generate({ model: "flash", thinking: false, messages: [] });
    expect(captured?.thinking).toEqual({ type: "disabled" });
  });

  // ─── tools schemas ─────────────────────────────────────────────────

  const LOG_MEAL_TOOL: ToolSchema = {
    type: "function",
    function: {
      name: "log_meal",
      description: "Log a meal",
      parameters: {
        type: "object",
        properties: {
          food_name: { type: "string" },
          portion_g: { type: "number" },
        },
        required: ["food_name", "portion_g"],
      },
    },
  };

  it("sends tools schemas in the request body when provided", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        captured = JSON.parse(String(init?.body));
        return okResponse("ok");
      },
    });

    await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [],
      tools: [LOG_MEAL_TOOL],
    });

    expect(captured?.tools).toEqual([LOG_MEAL_TOOL]);
  });

  it("omits tools field from body when no tools provided", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        captured = JSON.parse(String(init?.body));
        return okResponse("ok");
      },
    });

    await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [],
    });

    expect(captured?.tools).toBeUndefined();
  });

  // ─── native tool_calls parsing ─────────────────────────────────────

  it("parses tool_calls from a finish_reason:tool_calls response", async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () =>
        toolCallResponse([
          {
            id: "call_abc123",
            name: "log_meal",
            arguments: JSON.stringify({
              food_name: "chicken breast",
              portion_g: 200,
            }),
          },
        ]),
    });

    const res = await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [{ role: "user", content: "I ate 200g chicken breast" }],
    });

    expect(res.stop).toBe(false);
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]).toMatchObject({
      id: "call_abc123",
      name: "log_meal",
      args: { food_name: "chicken breast", portion_g: 200 },
    });
  });

  it("handles multiple tool_calls in a single response", async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () =>
        toolCallResponse([
          {
            id: "call_1",
            name: "search_food",
            arguments: JSON.stringify({ food: "egg" }),
          },
          {
            id: "call_2",
            name: "log_meal",
            arguments: JSON.stringify({ food_name: "egg", portion_g: 50 }),
          },
        ]),
    });

    const res = await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [{ role: "user", content: "I ate an egg" }],
    });

    expect(res.stop).toBe(false);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls![0]).toMatchObject({
      id: "call_1",
      name: "search_food",
      args: { food: "egg" },
    });
    expect(res.toolCalls![1]).toMatchObject({
      id: "call_2",
      name: "log_meal",
      args: { food_name: "egg", portion_g: 50 },
    });
  });

  it("surfaces malformed tool call arguments as an error observation (not a crash)", async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () =>
        toolCallResponse([
          {
            id: "call_bad",
            name: "log_meal",
            arguments: "not valid json {{{",
          },
        ]),
    });

    const res = await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [{ role: "user", content: "test" }],
    });

    // Must not crash — returns a tool call with an error string in args
    expect(res.stop).toBe(false);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]).toMatchObject({
      id: "call_bad",
      name: "log_meal",
    });
    expect(res.toolCalls![0].args).toHaveProperty("_parse_error");
  });

  it("handles mixed content and tool_calls in the same message", async () => {
    // Some models emit both content text and tool_calls
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "Let me look that up.",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "search_food",
                        arguments: JSON.stringify({ food: "egg" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const res = await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [{ role: "user", content: "egg nutrition?" }],
    });

    expect(res.content).toBe("Let me look that up.");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].name).toBe("search_food");
  });

  it("preserves backward compat with text-only responses (no tool_calls)", async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async () => okResponse("plain text answer"),
    });

    const res = await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.content).toBe("plain text answer");
    expect(res.stop).toBe(true);
    expect(res.finishReason).toBe("stop");
    expect(res.toolCalls).toBeUndefined();
  });

  it("sends tool_calls and tool_call_id fields on messages in the request body", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        captured = JSON.parse(String(init?.body));
        return okResponse("ok");
      },
    });

    await adapter.generate({
      model: "flash",
      thinking: false,
      messages: [
        { role: "user", content: "I ate 200g chicken" },
        {
          role: "assistant",
          content: "Let me log that.",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "log_meal",
                arguments: JSON.stringify({
                  food_name: "chicken",
                  portion_g: 200,
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          content: JSON.stringify({ proposal_id: "p1" }),
          tool_call_id: "call_abc",
        },
      ],
    });

    const messages = captured?.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);

    // Assistant message with tool_calls
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Let me log that.");
    const tcs = messages[1].tool_calls as Array<Record<string, unknown>>;
    expect(tcs[0].id).toBe("call_abc");
    expect(tcs[0].function).toMatchObject({
      name: "log_meal",
      arguments: JSON.stringify({ food_name: "chicken", portion_g: 200 }),
    });

    // Tool result message
    expect(messages[2].role).toBe("tool");
    expect(messages[2].tool_call_id).toBe("call_abc");
  });
});

// ── provider profiles and usage shapes (live-baseline follow-up) ───────────
//
// The adapter is the seam that "only this file moves" when the provider changes
// (CONTEXT.md). Putting the second provider in proved two things worth pinning:
// the base URL is not the only thing a gateway changes (the model ids are
// namespaced too), and the prompt-cache split arrives under a different field
// name — which is not cosmetic, because an unread hit count charges every prompt
// token at the miss rate.

describe("resolveProviderProfile", () => {
  it("defaults to the direct DeepSeek endpoint", () => {
    const profile = resolveProviderProfile({ env: {} });
    expect(profile.id).toBe("deepseek");
    expect(profile.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(profile.models).toEqual({ flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" });
  });

  it("selects a gateway profile by name, including its namespaced model ids", () => {
    const profile = resolveProviderProfile({
      env: { NUTRIBUDDY_MODEL_PROVIDER: "commandcode" },
    });
    expect(profile.id).toBe("commandcode");
    expect(profile.apiKeyEnv).toBe("COMMANDCODE_API_KEY");
    expect(profile.models.flash).toBe("deepseek/deepseek-v4.1-flash");
    // The gateway carries v4.1 as flash only, so pro stays on v4 — asserted so a
    // future unilateral bump of both tiers fails here rather than at a 400.
    expect(profile.models.pro).toBe("deepseek/deepseek-v4-pro");
  });

  it("lets the environment override one field at a time", () => {
    const profile = resolveProviderProfile({
      env: {
        NUTRIBUDDY_MODEL_PROVIDER: "commandcode",
        NUTRIBUDDY_MODEL_FLASH: "cheap-model",
      },
    });
    expect(profile.models.flash).toBe("cheap-model");
    expect(profile.models.pro).toBe("deepseek/deepseek-v4-pro");
  });

  it("refuses an unknown provider instead of silently using DeepSeek", () => {
    expect(() =>
      resolveProviderProfile({ env: { NUTRIBUDDY_MODEL_PROVIDER: "nope" } }),
    ).toThrow(/未知的 NUTRIBUDDY_MODEL_PROVIDER/);
  });

  it("requires a base URL for the custom escape hatch", () => {
    expect(() =>
      resolveProviderProfile({ env: { NUTRIBUDDY_MODEL_PROVIDER: "custom" } }),
    ).toThrow(/NUTRIBUDDY_MODEL_BASE_URL/);

    const profile = resolveProviderProfile({
      env: {
        NUTRIBUDDY_MODEL_PROVIDER: "custom",
        NUTRIBUDDY_MODEL_BASE_URL: "http://localhost:9999/v1",
      },
    });
    expect(profile.id).toBe("custom");
    expect(profile.pricingSource).toContain("unknown");
  });
});

describe("usage parsing across providers", () => {
  const usageResponse = (usage: Record<string, unknown>) =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  async function usageFrom(usage: Record<string, unknown>) {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      env: {},
      fetchImpl: async () => usageResponse(usage),
    });
    return (await adapter.generate({ model: "flash", thinking: false, messages: [] })).usage;
  }

  it("reads DeepSeek's two top-level cache fields", async () => {
    const usage = await usageFrom({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
    });
    expect(usage).toMatchObject({ promptTokens: 100, cacheHitTokens: 80, cacheMissTokens: 20 });
  });

  it("reads an OpenAI-compatible gateway's nested cached_tokens and derives the miss count", async () => {
    const usage = await usageFrom({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(usage).toMatchObject({ promptTokens: 100, cacheHitTokens: 80, cacheMissTokens: 20 });
  });

  it("leaves the split undefined when the provider reports no cache information", async () => {
    const usage = await usageFrom({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    expect(usage?.cacheHitTokens).toBeUndefined();
    expect(usage?.cacheMissTokens).toBeUndefined();
  });
});
