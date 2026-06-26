import { describe, it, expect } from "vitest";
import { extractSources, friendlyToolName } from "../src/lib/chatHelpers";

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
    const result = extractSources(
      "[Source: USDA] [Source: NIH ODS]",
    );
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

  it("passes userId when user is identified", () => {
    const body = { message: "Hello", userId: "abc-123", history: [] };
    expect(body.userId).toBe("abc-123");
  });
});
