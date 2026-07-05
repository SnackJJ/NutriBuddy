import { describe, it, expect } from "vitest";
import {
  assembleContext,
  assemblePinnedRegion,
  buildTemplatePromptSection,
  DEFAULT_SYSTEM_PROMPT,
  type PinnedRegion,
  type ToolDef,
} from "../src/harness/contextAssembler";
import {
  createQueryCatalog,
  FOOD_LOOKUP_TEMPLATE,
  type QueryCatalog,
  type QueryTemplate,
} from "../src/catalog/queryCatalog";

// ─── assemblePinnedRegion ──────────────────────────────────────────────

describe("assemblePinnedRegion", () => {
  it("builds a stable system prompt from base components", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toBe("You are a nutrition advisor.");
  });

  it("includes userProfile section when provided", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      userProfile:
        "[SAFETY CONSTRAINT]\nAllergies: peanut, milk\nDo not recommend foods containing these.",
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toContain("You are a nutrition advisor.");
    expect(result).toContain("[SAFETY CONSTRAINT]");
    expect(result).toContain("peanut, milk");
    // User profile section should immediately follow the system prompt
    expect(result.indexOf("nutrition advisor")).toBeLessThan(
      result.indexOf("[SAFETY CONSTRAINT]"),
    );
  });

  it("includes sqlTemplates section when provided", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      sqlTemplates:
        "[TOOL: code_act]\nAvailable templates:\n  - profile_query: ...",
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toContain("You are a nutrition advisor.");
    expect(result).toContain("[TOOL: code_act]");
    expect(result).toContain("profile_query");
  });

  it("includes tool definitions section when provided", () => {
    const toolDefs: ToolDef[] = [
      { name: "search_food", description: "Search USDA food database." },
      { name: "calc", description: "Evaluate arithmetic expressions." },
    ];
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      toolDefs,
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toContain("You are a nutrition advisor.");
    expect(result).toContain("[AVAILABLE TOOLS]");
    expect(result).toContain("search_food");
    expect(result).toContain("Search USDA food database.");
    expect(result).toContain("calc");
    expect(result).toContain("Evaluate arithmetic expressions.");
  });

  it("includes tool parameters when provided", () => {
    const toolDefs: ToolDef[] = [
      {
        name: "search_food",
        description: "Search USDA food database.",
        parameters: "food: string (required) - food name to search for",
      },
    ];
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      toolDefs,
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toContain("Parameters:");
    expect(result).toContain("food: string");
  });

  it("omits tool definitions section when toolDefs is undefined", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).not.toContain("[AVAILABLE TOOLS]");
  });

  it("omits tool definitions section when toolDefs is an empty array", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      toolDefs: [],
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).not.toContain("[AVAILABLE TOOLS]");
  });

  it("omits userProfile section when it is an empty string (gate returned no constraints)", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      userProfile: "",
    };
    const result = assemblePinnedRegion(pinned);
    // Empty string is falsy, section should be absent
    expect(result).toBe("You are a nutrition advisor.");
  });

  it("omits sqlTemplates section when it is an empty string", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      sqlTemplates: "",
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toBe("You are a nutrition advisor.");
  });

  it("byte-stability: same inputs produce identical output (deterministic)", () => {
    const toolDefs: ToolDef[] = [
      {
        name: "search_food",
        description: "Search USDA food database.",
        parameters: "food: string (required)",
      },
    ];
    const pinned: PinnedRegion = {
      systemPrompt: "You are a nutrition advisor.",
      userProfile: "[SAFETY CONSTRAINT]\nAllergies: peanut.",
      sqlTemplates: "[TOOL: code_act]\n  - profile_query: ...",
      toolDefs,
    };

    const a = assemblePinnedRegion(pinned);
    const b = assemblePinnedRegion(pinned);

    // Byte-identical output is essential for prompt cache hit maximization
    expect(a).toBe(b);
  });

  it("sections are joined with double newlines for readability", () => {
    const pinned: PinnedRegion = {
      systemPrompt: "SYSTEM",
      userProfile: "PROFILE",
      sqlTemplates: "TEMPLATES",
    };
    const result = assemblePinnedRegion(pinned);
    expect(result).toBe("SYSTEM\n\nPROFILE\n\nTEMPLATES");
  });
});

// ─── assembleContext ───────────────────────────────────────────────────

describe("assembleContext", () => {
  it("produces messages array with system + history + user input in order", () => {
    const messages = assembleContext({
      pinned: { systemPrompt: "You are a nutrition advisor." },
      history: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
      ],
      userInput: "how much protein in an egg?",
    });

    expect(messages).toEqual([
      { role: "system", content: "You are a nutrition advisor." },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "how much protein in an egg?" },
    ]);
  });

  it("works with no prior history", () => {
    const messages = assembleContext({
      pinned: { systemPrompt: "sys" },
      history: [],
      userInput: "hi",
    });

    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("builds system message from pinned region components", () => {
    const messages = assembleContext({
      pinned: {
        systemPrompt: "SYS",
        userProfile: "[PROFILE]",
        sqlTemplates: "[TEMPLATES]",
        toolDefs: [{ name: "t1", description: "desc" }],
      },
      history: [],
      userInput: "hi",
    });

    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("SYS");
    expect(messages[0].content).toContain("[PROFILE]");
    expect(messages[0].content).toContain("[TEMPLATES]");
    expect(messages[0].content).toContain("[AVAILABLE TOOLS]");
    expect(messages[0].content).toContain("t1");
  });

  it("system message is the first element (prompt cache prefix)", () => {
    const messages = assembleContext({
      pinned: { systemPrompt: "SYS" },
      history: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
      userInput: "q3",
    });

    // System message must be first for caching to work
    expect(messages[0].role).toBe("system");
    // User input must be last (current turn)
    expect(messages[messages.length - 1].role).toBe("user");
    expect(messages[messages.length - 1].content).toBe("q3");
  });

  it("future: DEFAULT_SYSTEM_PROMPT is still exported (backward compat)", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toBe(
      "你是 NutriBuddy，一个谨慎、循证的个人营养顾问。",
    );
  });
});

// ─── buildTemplatePromptSection (Query Catalog integration) ───────────────

describe("buildTemplatePromptSection", () => {
  function seedQueryCatalog(): QueryCatalog {
    return createQueryCatalog([FOOD_LOOKUP_TEMPLATE]);
  }

  it("returns undefined when no catalog is provided (backward compat)", () => {
    expect(buildTemplatePromptSection()).toBeUndefined();
  });

  it("returns undefined for empty catalog", () => {
    const empty = createQueryCatalog([]);
    expect(buildTemplatePromptSection(empty)).toBeUndefined();
  });

  it("builds a prompt section with template signatures", () => {
    const catalog = seedQueryCatalog();
    const section = buildTemplatePromptSection(catalog);

    expect(section).toBeDefined();
    expect(section!).toContain("[QUERY TEMPLATE CATALOG]");
    expect(section!).toContain("food_lookup");
    expect(section!).toContain(FOOD_LOOKUP_TEMPLATE.description);
  });

  it("includes parameter descriptions with types and required/optional markers", () => {
    const catalog = seedQueryCatalog();
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("food_id");
    expect(section).toContain("string");
    expect(section).toContain("(required)");
    expect(section).toContain("portion_g");
    expect(section).toContain("number");
    expect(section).toContain("(optional)");
  });

  it("includes result schema columns with units", () => {
    const catalog = seedQueryCatalog();
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("kcal");
    expect(section).toContain("(kcal)");
    expect(section).toContain("protein_g");
    expect(section).toContain("(g)");
    expect(section).toContain("fat_g");
    expect(section).toContain("(g)");
    expect(section).toContain("carbs_g");
    expect(section).toContain("(g)");
    expect(section).toContain("portion_g");
    expect(section).toContain("(g)");
  });

  it("includes enum values in parameter descriptions", () => {
    const template: QueryTemplate = {
      id: "top_k_by_nutrient",
      description: "Top-k foods by nutrient from the local catalog.",
      parameters: [
        {
          name: "nutrient",
          type: "enum",
          required: true,
          description: "Nutrient to rank by.",
          enumValues: ["kcal", "protein_g", "fat_g", "carbs_g"],
        },
        {
          name: "k",
          type: "number",
          required: false,
          description: "Number of results (default 5, max 20).",
        },
      ],
      resultSchema: [],
    };
    const catalog = createQueryCatalog([template]);
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("[kcal | protein_g | fat_g | carbs_g]");
  });

  it("byte-stable: same catalog produces identical output", () => {
    const catalog = seedQueryCatalog();
    const a = buildTemplatePromptSection(catalog);
    const b = buildTemplatePromptSection(catalog);

    expect(a).toBe(b);
  });

  it("includes all templates in the catalog", () => {
    const template2: QueryTemplate = {
      id: "test_template",
      description: "Another test template.",
      parameters: [],
      resultSchema: [],
    };
    const catalog = createQueryCatalog([FOOD_LOOKUP_TEMPLATE, template2]);
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("food_lookup");
    expect(section).toContain("test_template");
  });

  it("section is usable as sqlTemplates in PinnedRegion for prompt assembly", () => {
    const catalog = seedQueryCatalog();
    const section = buildTemplatePromptSection(catalog)!;

    const pinned: PinnedRegion = {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      sqlTemplates: section,
    };
    const result = assemblePinnedRegion(pinned);

    expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(result).toContain("[QUERY TEMPLATE CATALOG]");
    expect(result).toContain("food_lookup");
  });
});
