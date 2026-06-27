import { describe, it, expect } from "vitest";
import { DeepSeekAdapter, TIER_TO_MODEL_ID } from "../src/harness/modelAdapter";

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
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
    expect(body.thinking).toBe(true);
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
});
