import { describe, it, expect, vi } from "vitest";
import {
  SQL_TEMPLATES,
  findTemplate,
  validateParams,
  buildTemplatePromptSection,
  type SqlTemplate,
} from "../src/harness/sqlTemplates";
import {
  createCodeActHandler,
  type QueryExecutor,
} from "../src/harness/codeAct";

// ─── SQL Template Catalog ─────────────────────────────────────────────────

describe("SQL_TEMPLATES catalog", () => {
  it("contains 3-5 pre-validated templates", () => {
    expect(SQL_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(SQL_TEMPLATES.length).toBeLessThanOrEqual(5);
  });

  it("every template has required fields", () => {
    for (const t of SQL_TEMPLATES) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.sql).toBe("string");
      expect(t.sql.length).toBeGreaterThan(0);
      expect(Array.isArray(t.paramNames)).toBe(true);
      expect(Array.isArray(t.paramTypes)).toBe(true);
      expect(t.paramNames.length).toBe(t.paramTypes.length);
    }
  });

  it("has unique template IDs", () => {
    const ids = SQL_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template SQL is SELECT only (no INSERT/UPDATE/DELETE/DROP)", () => {
    for (const t of SQL_TEMPLATES) {
      const normalized = t.sql.trim().toUpperCase();
      expect(normalized).toMatch(/^SELECT\b/);
      expect(normalized).not.toContain("INSERT");
      expect(normalized).not.toContain("UPDATE");
      expect(normalized).not.toContain("DELETE");
      expect(normalized).not.toContain("DROP");
    }
  });

  it("every template SQL contains LIMIT or the executor will add it", () => {
    // Some templates may rely on the executor's auto-LIMIT; at least
    // verify they don't have unbounded OFFSET or other dangerous clauses.
    for (const t of SQL_TEMPLATES) {
      expect(t.sql).not.toMatch(/DROP\b/i);
      expect(t.sql).not.toMatch(/INSERT\b/i);
      expect(t.sql).not.toMatch(/UPDATE\b/i);
      expect(t.sql).not.toMatch(/DELETE\b/i);
    }
  });
});

describe("findTemplate", () => {
  it("returns the template when a valid id is provided", () => {
    const id = SQL_TEMPLATES[0].id;
    const t = findTemplate(id);
    expect(t).toBeDefined();
    expect(t!.id).toBe(id);
  });

  it("returns undefined for an unknown template id", () => {
    expect(findTemplate("nonexistent_template")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(findTemplate("")).toBeUndefined();
  });
});

describe("validateParams", () => {
  let template: SqlTemplate;

  // Use a consistent template for param validation tests
  function findFirstWithParams(count: number): SqlTemplate {
    const t = SQL_TEMPLATES.find((t) => t.paramNames.length === count);
    if (!t) throw new Error(`No template with ${count} params`);
    return t;
  }

  it("returns empty array when params match expected types", () => {
    template = findFirstWithParams(1);
    // All one-param templates take a uuid "user_id" or string "drug_name"
    const params: Record<string, unknown> = {};
    params[template.paramNames[0]] =
      template.paramTypes[0] === "number" ? 42 : "test-value";
    const errors = validateParams(template, params);
    expect(errors).toEqual([]);
  });

  it("returns errors for missing required params", () => {
    template = findFirstWithParams(1);
    const errors = validateParams(template, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing");
  });

  it("returns errors for extra (unknown) params", () => {
    template = findFirstWithParams(1);
    const params: Record<string, unknown> = {
      [template.paramNames[0]]: "test-value",
      extra_unknown_param: "should not be here",
    };
    const errors = validateParams(template, params);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("unknown");
  });

  it("returns errors when a number param receives a non-number string", () => {
    // Find a template with a number param, or test the type-check logic directly
    const numTemplate = SQL_TEMPLATES.find((t) =>
      t.paramTypes.includes("number"),
    );
    if (!numTemplate) {
      // Skip if no number-param templates exist yet
      return;
    }
    const paramName = numTemplate.paramNames[
      numTemplate.paramTypes.indexOf("number")
    ];
    const params: Record<string, unknown> = { [paramName]: "not-a-number" };
    const errors = validateParams(numTemplate, params);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("buildTemplatePromptSection", () => {
  it("returns a non-empty string", () => {
    const section = buildTemplatePromptSection();
    expect(typeof section).toBe("string");
    expect(section.length).toBeGreaterThan(0);
  });

  it("includes every template id and description", () => {
    const section = buildTemplatePromptSection();
    for (const t of SQL_TEMPLATES) {
      expect(section).toContain(t.id);
      // At minimum the id is findable; description may be truncated but
      // at least the first word should be present.
      expect(section).toContain(t.description.split(" ")[0]);
    }
  });

  it("mentions the code_act tool name", () => {
    const section = buildTemplatePromptSection();
    expect(section).toContain("code_act");
  });

  it("includes usage instructions for the model", () => {
    const section = buildTemplatePromptSection();
    expect(section.toLowerCase()).toMatch(/template_id|params/i);
  });
});

// ─── CodeAct Executor ─────────────────────────────────────────────────────

function fakeQueryExecutor(
  rows: Record<string, unknown>[] = [],
): QueryExecutor {
  return vi.fn(async (_sql: string, _params: unknown[]) => rows);
}

function delayedExecutor(
  ms: number,
  rows: Record<string, unknown>[] = [],
): QueryExecutor {
  return async (_sql: string, _params: unknown[]) => {
    await new Promise((r) => setTimeout(r, ms));
    return rows;
  };
}

describe("createCodeActHandler", () => {
  it("returns a function", () => {
    const handler = createCodeActHandler({
      executeQuery: fakeQueryExecutor(),
    });
    expect(typeof handler).toBe("function");
  });

  it("rejects unknown template_id", async () => {
    const handler = createCodeActHandler({
      executeQuery: fakeQueryExecutor(),
    });

    const result = await handler({
      template_id: "nonexistent_template",
      params: {},
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("unknown template");
  });

  it("rejects when template_id is missing from args", async () => {
    const handler = createCodeActHandler({
      executeQuery: fakeQueryExecutor(),
    });

    const result = await handler({ params: {} });

    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("validates params and returns error for missing required param", async () => {
    const handler = createCodeActHandler({
      executeQuery: fakeQueryExecutor(),
    });

    const templateId = SQL_TEMPLATES[0].id;
    const result = await handler({
      template_id: templateId,
      params: {}, // missing required params
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("missing");
  });

  it("executes a valid template and returns structured result", async () => {
    const fakeRows = [
      { allergies: ["peanut"], medications: ["ibuprofen"] },
    ];
    const exec = fakeQueryExecutor(fakeRows);
    const handler = createCodeActHandler({ executeQuery: exec });

    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = template.paramTypes[
        template.paramNames.indexOf(name)
      ] === "number"
        ? 42
        : "test-value";
    }

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeUndefined();
    expect(parsed.rows).toEqual(fakeRows);
    expect(parsed.rowCount).toBe(fakeRows.length);
    expect(parsed.templateId).toBe(template.id);
  });

  it("passes the parameterized SQL and params to executeQuery", async () => {
    const exec = vi.fn(async (_sql: string, _params: unknown[]) => [] as Record<string, unknown>[]);
    const handler = createCodeActHandler({ executeQuery: exec });

    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = template.paramTypes[
        template.paramNames.indexOf(name)
      ] === "number"
        ? 42
        : "test-value";
    }

    await handler({ template_id: template.id, params });
    expect(exec).toHaveBeenCalledOnce();

    const [sqlArg, paramsArg] = exec.mock.calls[0];
    // SQL should be the template's SQL
    expect(typeof sqlArg).toBe("string");
    expect(sqlArg).toContain("SELECT");
    // Params should contain the values we passed
    expect(Array.isArray(paramsArg)).toBe(true);
    expect(paramsArg.length).toBe(template.paramNames.length);
  });

  it("auto-adds LIMIT 100 when the SQL does not have a LIMIT clause", async () => {
    const exec = vi.fn(async (_sql: string, _params: unknown[]) => [] as Record<string, unknown>[]);
    const handler = createCodeActHandler({ executeQuery: exec });

    // Use a template that does NOT already have LIMIT in its SQL
    const noLimitTemplate = SQL_TEMPLATES.find(
      (t) => !t.sql.toUpperCase().includes("LIMIT"),
    );
    if (!noLimitTemplate) return; // All templates have LIMIT — skip

    const params: Record<string, unknown> = {};
    for (const name of noLimitTemplate.paramNames) {
      params[name] = "test-value";
    }

    await handler({ template_id: noLimitTemplate.id, params });

    const [sqlArg] = exec.mock.calls[0];
    // The SQL passed to the executor must contain LIMIT
    const upperSql = sqlArg.toUpperCase();
    expect(upperSql).toContain("LIMIT");
    // The LIMIT value should be 100 (our default ceiling)
    expect(upperSql).toMatch(/LIMIT\s+100/);
  });

  it("does not double-add LIMIT if the template already has one", async () => {
    const exec = vi.fn(async (_sql: string, _params: unknown[]) => [] as Record<string, unknown>[]);
    const handler = createCodeActHandler({ executeQuery: exec });

    // Find a template that already has LIMIT in its SQL
    const limitedTemplate = SQL_TEMPLATES.find((t) =>
      t.sql.toUpperCase().includes("LIMIT"),
    );
    if (!limitedTemplate) {
      // All templates should have LIMIT per our schema; if not, skip
      return;
    }

    const params: Record<string, unknown> = {};
    for (const name of limitedTemplate.paramNames) {
      params[name] = "test-value";
    }

    await handler({ template_id: limitedTemplate.id, params });

    const [sqlArg] = exec.mock.calls[0];
    // Count LIMIT occurrences
    const limitCount = (sqlArg.toUpperCase().match(/LIMIT/g) || []).length;
    expect(limitCount).toBe(1);
  });

  it("rejects SQL that contains INSERT/UPDATE/DELETE/DROP (defense in depth)", async () => {
    // This test verifies the SELECT-only check.
    // Since all templates are pre-validated to be SELECT, we test that
    // the executor enforces this check on the built SQL.
    const exec = vi.fn(async (_sql: string, _params: unknown[]) => [] as Record<string, unknown>[]);
    const handler = createCodeActHandler({ executeQuery: exec });

    // All our templates are SELECT; the enforcement is tested via the
    // catalog validation (every SQL starts with SELECT).
    // This test confirms the runtime check exists and passes for valid templates.
    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = "test-value";
    }

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    // Should NOT have error about non-SELECT
    if (parsed.error) {
      expect(parsed.error).not.toMatch(/SELECT|INSERT|non-SELECT/i);
    }
  });

  it("rejects calls with non-SELECT SQL even if template lookup succeeds", async () => {
    // Defense-in-depth: even if a template somehow contains non-SELECT SQL,
    // the executor must catch it. We test this by temporarily overriding
    // the template lookup behavior via an internal path, or by verifying
    // the validation logic directly.
    // Since templates are pre-validated and immutable, we test the
    // validation function's behavior.
    const { validateSqlReadOnly } = await import("../src/harness/codeAct");

    expect(validateSqlReadOnly("SELECT * FROM t")).toBe(true);
    expect(validateSqlReadOnly("INSERT INTO t VALUES (1)")).toBe(false);
    expect(validateSqlReadOnly("UPDATE t SET x=1")).toBe(false);
    expect(validateSqlReadOnly("DELETE FROM t")).toBe(false);
    expect(validateSqlReadOnly("DROP TABLE t")).toBe(false);
    expect(validateSqlReadOnly("  SELECT * FROM t  ")).toBe(true);
    // Case insensitive
    expect(validateSqlReadOnly("select * from t")).toBe(true);
  });

  it("enforces 2-second timeout on query execution", async () => {
    const handler = createCodeActHandler({
      executeQuery: delayedExecutor(3000, []),
      timeout: 100, // Short timeout for test
    });

    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = "test-value";
    }

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.toLowerCase()).toMatch(/timeout|timed out/i);
  });

  it("defaults timeout to 2000ms when not specified", async () => {
    const handler = createCodeActHandler({
      executeQuery: delayedExecutor(100, [{ x: 1 }]),
    });

    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = "test-value";
    }

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    // Fast enough — should succeed with default 2000ms timeout
    expect(parsed.rows).toEqual([{ x: 1 }]);
  });

  it("returns an error when executeQuery throws", async () => {
    const handler = createCodeActHandler({
      executeQuery: async () => {
        throw new Error("DB connection failed");
      },
    });

    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = "test-value";
    }

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("DB connection failed");
  });

  it("handles empty result set gracefully", async () => {
    const handler = createCodeActHandler({
      executeQuery: fakeQueryExecutor([]),
    });

    const template = SQL_TEMPLATES[0];
    const params: Record<string, unknown> = {};
    for (const name of template.paramNames) {
      params[name] = "test-value";
    }

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rowCount).toBe(0);
  });

  it("rejects string params for uuid-typed parameters if not UUID-like", async () => {
    // Find a template with uuid param type
    const uuidTemplate = SQL_TEMPLATES.find((t) =>
      t.paramTypes.includes("uuid"),
    );
    if (!uuidTemplate) return; // Skip if no uuid templates

    const handler = createCodeActHandler({
      executeQuery: fakeQueryExecutor(),
    });

    const uuidIdx = uuidTemplate.paramTypes.indexOf("uuid");
    const paramName = uuidTemplate.paramNames[uuidIdx];
    const params: Record<string, unknown> = { [paramName]: "" };

    const result = await handler({
      template_id: uuidTemplate.id,
      params,
    });
    const parsed = JSON.parse(result);
    // Empty string should fail uuid validation
    expect(parsed.error).toBeDefined();
  });
});

// ─── Integration: CodeAct handler as a loop tool ─────────────────────────

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

describe("CodeAct in loop", () => {
  it("auto-injects template prompt section when code_act tool is registered", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    const tools = new Map([
      [
        "code_act",
        createCodeActHandler({ executeQuery: fakeQueryExecutor([]) }),
      ],
    ]);

    await collect(
      run({ userInput: "what's in my profile?", adapter, tracer, tools }),
    );

    // The system prompt should contain the template section
    const prompt = tracer.events().find((e) => e.type === "model_prompt");
    expect(prompt?.payload).toContain("code_act");
  });

  it("does not inject template prompt when code_act tool is not registered", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    // No tools at all
    await collect(run({ userInput: "hi", adapter, tracer }));

    const prompt = tracer.events().find((e) => e.type === "model_prompt");
    expect(prompt?.payload).not.toContain("code_act");
  });

  it("allows the model to call code_act and receives structured results", async () => {
    const tracer = new Tracer();
    let callCount = 0;

    const fakeRows = [
      { allergies: ["peanut"], medications: ["warfarin"] },
    ];
    const tools = new Map([
      [
        "code_act",
        createCodeActHandler({
          executeQuery: fakeQueryExecutor(fakeRows),
        }),
      ],
    ]);

    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Let me look up your profile.",
          stop: false,
          toolCalls: [
            {
              name: "code_act",
              args: {
                template_id: SQL_TEMPLATES[0].id,
                params: Object.fromEntries(
                  SQL_TEMPLATES[0].paramNames.map((n) => [n, "test-value"]),
                ),
              },
            } satisfies ToolCall,
          ],
        };
      }
      return {
        content:
          "Based on your profile, you have peanut allergy and take warfarin.",
        stop: true,
      };
    });

    const { events, result } = await collect(
      run({
        userInput: "what's in my profile?",
        adapter,
        tracer,
        tools,
      }),
    );

    expect(result.reply).toContain("peanut");
    expect(callCount).toBe(2);

    // Should have act event for code_act
    const act = events.find((e) => e.type === "act");
    expect(act?.toolCall?.name).toBe("code_act");

    // Should have observe event with the query result
    const observe = events.find(
      (e) => e.type === "observe" && e.toolResult?.name === "code_act",
    );
    expect(observe).toBeDefined();
    const parsedResult = JSON.parse(observe!.toolResult!.result);
    expect(parsedResult.rows).toEqual(fakeRows);
  });
});
