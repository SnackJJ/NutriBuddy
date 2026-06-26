import { describe, it, expect } from "vitest";
import {
  createNormalizeFoodHandler,
  parsePortion,
  normalizeFoodName,
  FOOD_ALIASES,
  type NormalizedFood,
  type NormalizeFoodResult,
  type PortionInfo,
  NORMALIZE_FOOD_SCHEMA,
} from "../src/harness/normalizeFood";
import { run } from "../src/harness/loop";
import { Tracer } from "../src/harness/tracer";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  AgentEvent,
  TerminalResult,
  ToolCall,
} from "../src/harness/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function stubAdapter(
  impl: (req: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

async function collect(
  gen: AsyncGenerator<AgentEvent, TerminalResult, undefined>,
): Promise<{ events: AgentEvent[]; result: TerminalResult }> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

// ─── Portion Parsing ────────────────────────────────────────────────────────

describe("parsePortion", () => {
  it("extracts explicit gram amount (e.g. '200g of rice')", () => {
    const result = parsePortion("200g of rice");
    expect(result).toBeDefined();
    expect(result!.grams).toBe(200);
  });

  it("extracts '100 g' with space before g", () => {
    const result = parsePortion("100 g of chicken");
    expect(result).toBeDefined();
    expect(result!.grams).toBe(100);
  });

  it("extracts '0.5 kg' and converts to grams", () => {
    const result = parsePortion("0.5 kg of flour");
    expect(result).toBeDefined();
    expect(result!.grams).toBe(500);
  });

  it("extracts ounce amounts (e.g. '8 oz of steak')", () => {
    const result = parsePortion("8 oz of steak");
    expect(result).toBeDefined();
    expect(result!.grams).toBeCloseTo(227, -1); // ~227g, loose tolerance
  });

  it("extracts pound amounts (e.g. '1 lb of ground beef')", () => {
    const result = parsePortion("1 lb of ground beef");
    expect(result).toBeDefined();
    expect(result!.grams).toBeCloseTo(454, -1); // ~454g
  });

  it("detects 'a bowl of' descriptor", () => {
    const result = parsePortion("a bowl of rice");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("bowl");
  });

  it("detects 'a slice of' descriptor", () => {
    const result = parsePortion("a slice of bread");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("slice");
  });

  it("detects 'a cup of' descriptor", () => {
    const result = parsePortion("a cup of milk");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("cup");
  });

  it("detects 'a piece of' descriptor", () => {
    const result = parsePortion("a piece of cake");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("piece");
  });

  it("detects 'a glass of' descriptor", () => {
    const result = parsePortion("a glass of orange juice");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("glass");
  });

  it("detects 'a tablespoon of' descriptor", () => {
    const result = parsePortion("a tablespoon of olive oil");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("tablespoon");
  });

  it("detects 'a teaspoon of' descriptor", () => {
    const result = parsePortion("a teaspoon of sugar");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("teaspoon");
  });

  it("detects count-based portions (e.g. 'two eggs')", () => {
    const result = parsePortion("two eggs");
    expect(result).toBeDefined();
    expect(result!.unit).toBe("count");
    expect(result!.count).toBe(2);
  });

  it("detects 'a dozen' as count 12", () => {
    const result = parsePortion("a dozen eggs");
    expect(result).toBeDefined();
    expect(result!.count).toBe(12);
  });

  it("detects 'a couple of' as count 2", () => {
    const result = parsePortion("a couple of apples");
    expect(result).toBeDefined();
    expect(result!.count).toBe(2);
  });

  it("returns null for input with no portion info", () => {
    const result = parsePortion("rice");
    expect(result).toBeNull();
  });

  it("handles empty string gracefully", () => {
    const result = parsePortion("");
    expect(result).toBeNull();
  });

  it("strips the portion prefix to get base food name", () => {
    const result = parsePortion("200g of steamed rice");
    expect(result).toBeDefined();
    expect(result!.baseFood).toBe("steamed rice");
  });

  it("strips 'a bowl of' prefix to get base food name", () => {
    const result = parsePortion("a bowl of hot chicken soup");
    expect(result).toBeDefined();
    expect(result!.baseFood).toBe("hot chicken soup");
  });
});

// ─── Food Alias Dictionary ──────────────────────────────────────────────────

describe("FOOD_ALIASES", () => {
  it("is non-empty", () => {
    expect(FOOD_ALIASES.length).toBeGreaterThan(0);
  });

  it("every entry has required fields", () => {
    for (const entry of FOOD_ALIASES) {
      expect(typeof entry.standard).toBe("string");
      expect(entry.standard.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(entry.aliases.length).toBeGreaterThan(0);
    }
  });

  it("has unique standard names", () => {
    const standards = FOOD_ALIASES.map((e) => e.standard);
    expect(new Set(standards).size).toBe(standards.length);
  });
});

// ─── Food Name Normalization ────────────────────────────────────────────────

describe("normalizeFoodName", () => {
  it("returns exact alias match with high confidence", () => {
    const result = normalizeFoodName("rice");
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    // Top candidate should have high confidence for exact match
    const top = result.candidates[0];
    expect(top.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("maps 'chicken breast' to a standardized name", () => {
    const result = normalizeFoodName("chicken breast");
    expect(result.candidates.length).toBeGreaterThan(0);
    // Should find chicken in some form
    const names = result.candidates.map((c) => c.food_name.toLowerCase());
    expect(names.some((n) => n.includes("chicken"))).toBe(true);
  });

  it("maps 'egg' to a standardized name", () => {
    const result = normalizeFoodName("egg");
    expect(result.candidates.length).toBeGreaterThan(0);
    const names = result.candidates.map((c) => c.food_name.toLowerCase());
    expect(names.some((n) => n.includes("egg"))).toBe(true);
  });

  it("returns empty candidates for unrecognized food", () => {
    const result = normalizeFoodName("xyzzy_not_a_real_food_12345");
    // Should have low confidence or no good matches
    if (result.candidates.length > 0) {
      expect(result.candidates[0].confidence).toBeLessThan(0.5);
    }
  });

  it("all candidates have food_name, confidence fields", () => {
    const result = normalizeFoodName("apple");
    for (const c of result.candidates) {
      expect(typeof c.food_name).toBe("string");
      expect(c.food_name.length).toBeGreaterThan(0);
      expect(typeof c.confidence).toBe("number");
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("is case-insensitive", () => {
    const lower = normalizeFoodName("rice");
    const upper = normalizeFoodName("RICE");
    const mixed = normalizeFoodName("Rice");
    expect(lower.candidates[0].food_name).toBe(upper.candidates[0].food_name);
    expect(lower.candidates[0].food_name).toBe(mixed.candidates[0].food_name);
  });

  it("handles empty string", () => {
    const result = normalizeFoodName("");
    expect(result.candidates).toEqual([]);
  });
});

// ─── Tool Handler ───────────────────────────────────────────────────────────

describe("createNormalizeFoodHandler", () => {
  it("returns a function", () => {
    const handler = createNormalizeFoodHandler();
    expect(typeof handler).toBe("function");
  });

  it("returns JSON with candidates array for valid input", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "a bowl of rice" });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    expect(parsed.error).toBeUndefined();
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.candidates.length).toBeGreaterThan(0);
  });

  it("parses portion from user_input into portion_g", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "200g of chicken breast" });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    expect(parsed.candidates[0].portion_g).toBe(200);
  });

  it("sets portion_g to 0 when no portion is specified", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "rice" });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    expect(parsed.candidates[0].portion_g).toBe(0);
  });

  it("returns multiple candidates when confidence is low", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({
      user_input: "some kind of fish maybe salmon?",
    });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    // Should return candidates even for fuzzy input
    expect(Array.isArray(parsed.candidates)).toBe(true);
  });

  it("returns candidates sorted by confidence descending", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "apple" });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    if (parsed.candidates.length >= 2) {
      for (let i = 1; i < parsed.candidates.length; i++) {
        expect(parsed.candidates[i - 1].confidence).toBeGreaterThanOrEqual(
          parsed.candidates[i].confidence,
        );
      }
    }
  });

  it("returns error for empty user_input", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("returns error for missing user_input", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({});
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("returns error for non-string user_input", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: 12345 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("handles input with only whitespace", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "   " });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("extracts count-based portion (e.g. 'two eggs') as portion_g estimate", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "two eggs" });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    // "two eggs" should parse; the portion_g depends on egg weight
    if (parsed.candidates.length > 0) {
      expect(parsed.candidates[0].portion_g).toBeGreaterThan(0);
    }
  });

  it("retains original_input in result", async () => {
    const handler = createNormalizeFoodHandler();
    const input = "a bowl of brown rice";
    const result = await handler({ user_input: input });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    expect(parsed.original_input).toBe(input);
  });

  it("identifies food_name in each candidate", async () => {
    const handler = createNormalizeFoodHandler();
    const result = await handler({ user_input: "banana" });
    const parsed = JSON.parse(result) as NormalizeFoodResult;

    for (const c of parsed.candidates) {
      expect(typeof c.food_name).toBe("string");
      expect(c.food_name.length).toBeGreaterThan(0);
      expect(typeof c.confidence).toBe("number");
      expect(typeof c.portion_g).toBe("number");
    }
  });
});

// ─── OpenAI Function-Calling Schema ─────────────────────────────────────────

describe("NORMALIZE_FOOD_SCHEMA", () => {
  it("has type 'function'", () => {
    expect(NORMALIZE_FOOD_SCHEMA.type).toBe("function");
  });

  it("has name 'normalize_food'", () => {
    expect(NORMALIZE_FOOD_SCHEMA.function.name).toBe("normalize_food");
  });

  it("has a description", () => {
    expect(NORMALIZE_FOOD_SCHEMA.function.description.length).toBeGreaterThan(0);
  });

  it("has user_input as a required parameter", () => {
    expect(
      NORMALIZE_FOOD_SCHEMA.function.parameters.required,
    ).toContain("user_input");
  });

  it("user_input parameter is type string", () => {
    const props = NORMALIZE_FOOD_SCHEMA.function.parameters.properties;
    expect(props.user_input.type).toBe("string");
  });
});

// ─── Integration: normalize_food handler in loop ────────────────────────────

describe("normalize_food in loop", () => {
  it("dispatches normalize_food tool calls and receives structured results", async () => {
    const tracer = new Tracer();
    let callCount = 0;

    const tools = new Map([
      ["normalize_food", createNormalizeFoodHandler()],
    ]);

    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Let me normalize that food description.",
          stop: false,
          toolCalls: [
            {
              name: "normalize_food",
              args: { user_input: "a bowl of rice" },
            } satisfies ToolCall,
          ],
        };
      }
      return {
        content: "Your food has been normalized.",
        stop: true,
      };
    });

    const { events } = await collect(
      run({
        userInput: "I ate a bowl of rice",
        adapter,
        tracer,
        tools,
      }),
    );

    const act = events.find((e) => e.type === "act");
    expect(act?.toolCall?.name).toBe("normalize_food");

    const observe = events.find(
      (e) => e.type === "observe" && e.toolResult?.name === "normalize_food",
    );
    expect(observe).toBeDefined();

    const parsedResult = JSON.parse(observe!.toolResult!.result);
    expect(parsedResult.error).toBeUndefined();
    expect(Array.isArray(parsedResult.candidates)).toBe(true);
  });

  it("model can consume normalize_food result and continue reasoning", async () => {
    const tracer = new Tracer();
    let callCount = 0;

    const tools = new Map([
      ["normalize_food", createNormalizeFoodHandler()],
    ]);

    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Let me normalize the food first.",
          stop: false,
          toolCalls: [
            {
              name: "normalize_food",
              args: { user_input: "200g chicken breast" },
            } satisfies ToolCall,
          ],
        };
      }
      return {
        content:
          "Your food 'chicken, breast, roasted' weighs 200g. I can now look up its nutrition.",
        stop: true,
      };
    });

    const { result } = await collect(
      run({
        userInput: "I ate 200g chicken breast",
        adapter,
        tracer,
        tools,
      }),
    );

    expect(result.reply).toContain("chicken");
    expect(callCount).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  it("unknown tool names are handled gracefully", async () => {
    const tracer = new Tracer();

    const adapter = stubAdapter(() => ({
      content: "I'll try to use a tool.",
      stop: false,
      toolCalls: [
        {
          name: "nonexistent_tool",
          args: { user_input: "test" },
        } satisfies ToolCall,
      ],
    }));

    const { events } = await collect(
      run({
        userInput: "test",
        adapter,
        tracer,
      }),
    );

    const observe = events.find(
      (e) => e.type === "observe" && e.toolResult?.name === "nonexistent_tool",
    );
    expect(observe).toBeDefined();
    expect(observe!.toolResult!.result).toContain("not found");
  });
});
