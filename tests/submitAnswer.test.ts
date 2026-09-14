import { describe, it, expect } from "vitest";
import {
  SUBMIT_ANSWER_SCHEMA,
  SUBMIT_ANSWER_TOOL,
  parseSubmitAnswerArgs,
} from "../src/harness/submitAnswer";
import { CITATION_QUOTE_MAX_CHARS } from "../src/harness/types";

function expectRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeDefined();
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }

  return value as Record<string, unknown>;
}

function schemaProperty(name: string): Record<string, unknown> {
  const properties = expectRecord(
    SUBMIT_ANSWER_SCHEMA.function.parameters.properties,
  );
  return expectRecord(properties[name]);
}

function schemaArrayItems(name: string): Record<string, unknown> {
  const property = schemaProperty(name);
  expect(property.type).toBe("array");
  return expectRecord(property.items);
}

describe("SUBMIT_ANSWER_SCHEMA", () => {
  it("is an OpenAI function-calling tool definition", () => {
    expect(SUBMIT_ANSWER_SCHEMA.type).toBe("function");
    expect(SUBMIT_ANSWER_SCHEMA.function.name).toBe("submit_answer");
    expect(typeof SUBMIT_ANSWER_SCHEMA.function.description).toBe("string");
    expect(SUBMIT_ANSWER_SCHEMA.function.description.length).toBeGreaterThan(
      20,
    );
  });

  it("declares required parameters: prose, foodRefs, ruleRefs", () => {
    const params = SUBMIT_ANSWER_SCHEMA.function.parameters;
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["prose", "foodRefs", "ruleRefs"]);
    expect(params.properties).toHaveProperty("prose");
    expect(params.properties).toHaveProperty("foodRefs");
    expect(params.properties).toHaveProperty("ruleRefs");
  });

  it("describes foodRefs items with foodId, foodName, matchType", () => {
    const items = schemaArrayItems("foodRefs");
    expect(items.type).toBe("object");
    expect(items.required).toEqual(["foodId", "foodName", "matchType"]);
    expect(items.properties).toHaveProperty("foodId");
    expect(items.properties).toHaveProperty("foodName");
    expect(items.properties).toHaveProperty("matchType");
    // Allergen tags come from the catalog, never from model args (issue #54)
    expect(items.properties).not.toHaveProperty("allergens");
  });

  it("does not advertise a prose-only safety-check bypass (issue #54)", () => {
    expect(SUBMIT_ANSWER_SCHEMA.function.description).not.toContain(
      "skip safety checks",
    );
  });

  it("describes ruleRefs items with ruleId and summary", () => {
    const items = schemaArrayItems("ruleRefs");
    expect(items.type).toBe("object");
    expect(items.required).toEqual(["ruleId", "summary"]);
    expect(items.properties).toHaveProperty("ruleId");
    expect(items.properties).toHaveProperty("summary");
  });

  it("exports SUBMIT_ANSWER_TOOL constant matching the schema name", () => {
    expect(SUBMIT_ANSWER_TOOL).toBe("submit_answer");
    expect(SUBMIT_ANSWER_SCHEMA.function.name).toBe(SUBMIT_ANSWER_TOOL);
  });
});

describe("parseSubmitAnswerArgs", () => {
  it("extracts valid TypedOutput from complete args", () => {
    const args = {
      prose: "I recommend chicken breast for protein.",
      foodRefs: [
        {
          foodId: "f-001",
          foodName: "chicken breast",
          matchType: "exact",
          allergens: [],
        },
      ],
      ruleRefs: [
        {
          ruleId: "r-001",
          summary: "Limit saturated fat to <10% of daily calories",
        },
      ],
    };

    const result = parseSubmitAnswerArgs(args);
    expect(result).not.toBeNull();
    expect(result!.prose).toBe("I recommend chicken breast for protein.");
    expect(result!.foodRefs).toHaveLength(1);
    expect(result!.foodRefs[0]).toEqual({
      foodId: "f-001",
      foodName: "chicken breast",
      matchType: "exact",
      allergens: [],
    });
    expect(result!.ruleRefs).toHaveLength(1);
    expect(result!.ruleRefs[0]).toEqual({
      ruleId: "r-001",
      summary: "Limit saturated fat to <10% of daily calories",
    });
  });

  it("returns null when prose is not a string (all fields empty/invalid)", () => {
    const args = {
      prose: 123,
      foodRefs: [],
      ruleRefs: [],
    };

    const result = parseSubmitAnswerArgs(
      args as unknown as Record<string, unknown>,
    );
    // All fields are empty/invalid, so null signals "use content fallback"
    expect(result).toBeNull();
  });

  it("filters out invalid foodRefs (missing foodId)", () => {
    const args = {
      prose: "test",
      foodRefs: [
        { foodId: "f-001", foodName: "valid", matchType: "exact" },
        { foodName: "no-id", matchType: "exact" }, // missing foodId
        { foodId: "", foodName: "empty-id", matchType: "exact" }, // empty foodId
      ],
      ruleRefs: [],
    };

    const result = parseSubmitAnswerArgs(args);
    expect(result).not.toBeNull();
    expect(result!.foodRefs).toHaveLength(1);
    expect(result!.foodRefs[0].foodId).toBe("f-001");
  });

  it("filters out invalid foodRefs (bad matchType)", () => {
    const args = {
      prose: "test",
      foodRefs: [
        { foodId: "f-001", foodName: "valid", matchType: "exact" },
        { foodId: "f-002", foodName: "bad-type", matchType: "unknown" },
      ],
      ruleRefs: [],
    };

    const result = parseSubmitAnswerArgs(args);
    expect(result).not.toBeNull();
    expect(result!.foodRefs).toHaveLength(1);
  });

  it("drops malformed optional allergens without dropping the foodRef", () => {
    const result = parseSubmitAnswerArgs({
      prose: "test",
      foodRefs: [
        {
          foodId: "f-001",
          foodName: "peanut butter",
          matchType: "exact",
          allergens: ["peanut", 123],
        },
      ],
      ruleRefs: [],
    });

    expect(result).not.toBeNull();
    expect(result!.foodRefs).toEqual([
      {
        foodId: "f-001",
        foodName: "peanut butter",
        matchType: "exact",
      },
    ]);
  });

  it("filters out invalid ruleRefs (missing ruleId)", () => {
    const args = {
      prose: "test",
      foodRefs: [],
      ruleRefs: [
        { ruleId: "r-001", summary: "valid" },
        { summary: "no ruleId" },
        { ruleId: "", summary: "empty ruleId" },
        { ruleId: 123, summary: "numeric ruleId" },
      ],
    };

    const result = parseSubmitAnswerArgs(args);
    expect(result).not.toBeNull();
    expect(result!.ruleRefs).toHaveLength(1);
    expect(result!.ruleRefs[0].ruleId).toBe("r-001");
  });

  it("returns null when all fields are empty/absent", () => {
    const result = parseSubmitAnswerArgs({});
    expect(result).toBeNull();
  });

  it("returns null when prose is empty and refs are empty", () => {
    const result = parseSubmitAnswerArgs({
      prose: "",
      foodRefs: [],
      ruleRefs: [],
    });
    expect(result).toBeNull();
  });

  it("handles non-array foodRefs gracefully", () => {
    const result = parseSubmitAnswerArgs({
      prose: "test",
      foodRefs: "not-an-array",
      ruleRefs: [],
    } as unknown as Record<string, unknown>);
    expect(result).not.toBeNull();
    expect(result!.foodRefs).toEqual([]);
  });

  it("handles non-array ruleRefs gracefully", () => {
    const result = parseSubmitAnswerArgs({
      prose: "test",
      foodRefs: [],
      ruleRefs: 42,
    } as unknown as Record<string, unknown>);
    expect(result).not.toBeNull();
    expect(result!.ruleRefs).toEqual([]);
  });

  it("accepts foodRef with fuzzy matchType", () => {
    const args = {
      prose: "test",
      foodRefs: [{ foodId: "f-001", foodName: "chicken", matchType: "fuzzy" }],
      ruleRefs: [],
    };

    const result = parseSubmitAnswerArgs(args);
    expect(result).not.toBeNull();
    expect(result!.foodRefs).toHaveLength(1);
    expect(result!.foodRefs[0].matchType).toBe("fuzzy");
  });

  it("accepts foodRef with alias matchType", () => {
    const args = {
      prose: "test",
      foodRefs: [{ foodId: "f-001", foodName: "chicken", matchType: "alias" }],
      ruleRefs: [],
    };

    const result = parseSubmitAnswerArgs(args);
    expect(result).not.toBeNull();
    expect(result!.foodRefs).toHaveLength(1);
    expect(result!.foodRefs[0].matchType).toBe("alias");
  });
});

// ── citations (S4 / RFC 0011 §3.3) ─────────────────────────────────────────
//
// The parsing contract: a citation that cannot be checked is dropped rather than
// repaired, and an answer that cites nothing does not carry an empty array — the
// gate has to be able to tell "made no evidence claim" from "cited something
// unverifiable".

describe("submit_answer citations", () => {
  it("keeps a well-formed citation, including its version", () => {
    const output = parseSubmitAnswerArgs({
      prose: "Vitamin K intake should stay steady on warfarin.",
      foodRefs: [],
      ruleRefs: [],
      citations: [
        {
          sectionId: "ods-vitamin-k#vitamin-k-interactions-with-medications-warfarin-coumadin-an",
          sourceId: "ods-vitamin-k@2024",
          docVersion: "ods-vitamin-k@2024",
          quote: "Vitamin K is not known to interact with warfarin in a dangerous way.",
        },
      ],
    });

    expect(output?.citations).toHaveLength(1);
    expect(output?.citations?.[0].sourceId).toBe("ods-vitamin-k@2024");
  });

  it("drops a malformed citation instead of inventing the missing field", () => {
    const output = parseSubmitAnswerArgs({
      prose: "Cited badly.",
      foodRefs: [],
      ruleRefs: [],
      citations: [
        { sectionId: "x#y", sourceId: "x@1" },
        { sourceId: "x@1", docVersion: "x@1" },
        "not an object",
        { sectionId: "x#y", sourceId: "", docVersion: "x@1" },
      ],
    });

    expect(output?.citations).toBeUndefined();
    expect(output?.prose).toBe("Cited badly.");
  });

  it("caps a quote at the documented limit", () => {
    const output = parseSubmitAnswerArgs({
      prose: "Long quote.",
      foodRefs: [],
      ruleRefs: [],
      citations: [
        {
          sectionId: "x#y",
          sourceId: "x@1",
          docVersion: "x@1",
          quote: "z".repeat(CITATION_QUOTE_MAX_CHARS + 50),
        },
      ],
    });

    expect(output?.citations?.[0].quote).toHaveLength(CITATION_QUOTE_MAX_CHARS);
  });

  it("omits the field entirely when nothing survives parsing", () => {
    const output = parseSubmitAnswerArgs({
      prose: "No citations here.",
      foodRefs: [],
      ruleRefs: [],
    });
    expect(output).not.toBeNull();
    expect(output?.citations).toBeUndefined();
    expect(Object.keys(output ?? {})).not.toContain("citations");
  });
});
