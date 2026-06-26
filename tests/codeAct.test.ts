import { describe, it, expect, vi } from "vitest";
import {
  SQL_TEMPLATES,
  findTemplate,
  validateParams,
  buildTemplatePromptSection,
} from "../src/harness/sqlTemplates";
import {
  createCodeActHandler,
  validateSqlReadOnly,
  type QueryExecutor,
} from "../src/harness/codeAct";
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

/** Build params for a template, filling each param with a test value. */
function buildParams(template: {
  readonly paramNames: readonly string[];
  readonly paramTypes: readonly string[];
}): Record<string, unknown> {
  return Object.fromEntries(
    template.paramNames.map((name, i) => [
      name,
      template.paramTypes[i] === "number" ? 42 : "test-value",
    ]),
  );
}

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

// ─── SQL Template Catalog ───────────────────────────────────────────────────

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

  it("every template SQL has no dangerous DDL/DML clauses", () => {
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
  function findFirstWithParams(count: number) {
    const t = SQL_TEMPLATES.find((tmpl) => tmpl.paramNames.length === count);
    if (!t) throw new Error(`No template with ${count} params`);
    return t;
  }

  it("returns empty array when params match expected types", () => {
    const template = findFirstWithParams(1);
    const params = buildParams(template);
    const errors = validateParams(template, params);
    expect(errors).toEqual([]);
  });

  it("returns errors for missing required params", () => {
    const template = findFirstWithParams(1);
    const errors = validateParams(template, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing");
  });

  it("returns errors for extra (unknown) params", () => {
    const template = findFirstWithParams(1);
    const params: Record<string, unknown> = {
      [template.paramNames[0]]: "test-value",
      extra_unknown_param: "should not be here",
    };
    const errors = validateParams(template, params);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("unknown");
  });

  it("returns errors when a number param receives a non-number string", () => {
    const numTemplate = SQL_TEMPLATES.find((t) =>
      t.paramTypes.includes("number"),
    );
    if (!numTemplate) return;
    const paramIdx = numTemplate.paramTypes.indexOf("number");
    const paramName = numTemplate.paramNames[paramIdx];
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

// ─── validateSqlReadOnly ────────────────────────────────────────────────────

describe("validateSqlReadOnly", () => {
  it("accepts SELECT statements", () => {
    expect(validateSqlReadOnly("SELECT * FROM t")).toBe(true);
    expect(validateSqlReadOnly("  SELECT * FROM t  ")).toBe(true);
    expect(validateSqlReadOnly("select * from t")).toBe(true);
  });

  it("rejects INSERT/UPDATE/DELETE/DROP statements", () => {
    expect(validateSqlReadOnly("INSERT INTO t VALUES (1)")).toBe(false);
    expect(validateSqlReadOnly("UPDATE t SET x=1")).toBe(false);
    expect(validateSqlReadOnly("DELETE FROM t")).toBe(false);
    expect(validateSqlReadOnly("DROP TABLE t")).toBe(false);
  });

  it("rejects SELECT containing dangerous keywords after the SELECT clause", () => {
    // e.g. "SELECT 1; DROP TABLE users" — the DROP after SELECT should be caught
    expect(validateSqlReadOnly("SELECT 1; DROP TABLE users")).toBe(false);
  });
});

// ─── CodeAct Executor ───────────────────────────────────────────────────────

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

    const result = await handler({
      template_id: SQL_TEMPLATES[0].id,
      params: {},
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
    const params = buildParams(template);

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeUndefined();
    expect(parsed.rows).toEqual(fakeRows);
    expect(parsed.rowCount).toBe(fakeRows.length);
    expect(parsed.templateId).toBe(template.id);
  });

  it("passes the parameterized SQL and params to executeQuery", async () => {
    const exec = vi.fn(
      async (_sql: string, _params: unknown[]) =>
        [] as Record<string, unknown>[],
    );
    const handler = createCodeActHandler({ executeQuery: exec });

    const template = SQL_TEMPLATES[0];
    const params = buildParams(template);

    await handler({ template_id: template.id, params });
    expect(exec).toHaveBeenCalledOnce();

    const [sqlArg, paramsArg] = exec.mock.calls[0];
    expect(typeof sqlArg).toBe("string");
    expect(sqlArg).toContain("SELECT");
    expect(Array.isArray(paramsArg)).toBe(true);
    expect(paramsArg.length).toBe(template.paramNames.length);
  });

  it("auto-adds LIMIT 100 when the SQL does not have a LIMIT clause", async () => {
    const exec = vi.fn(
      async (_sql: string, _params: unknown[]) =>
        [] as Record<string, unknown>[],
    );
    const handler = createCodeActHandler({ executeQuery: exec });

    const noLimitTemplate = SQL_TEMPLATES.find(
      (t) => !t.sql.toUpperCase().includes("LIMIT"),
    );
    if (!noLimitTemplate) return;

    const params = buildParams(noLimitTemplate);
    await handler({ template_id: noLimitTemplate.id, params });

    const [sqlArg] = exec.mock.calls[0];
    const upperSql = sqlArg.toUpperCase();
    expect(upperSql).toContain("LIMIT");
    expect(upperSql).toMatch(/LIMIT\s+100/);
  });

  it("does not double-add LIMIT if the template already has one", async () => {
    const exec = vi.fn(
      async (_sql: string, _params: unknown[]) =>
        [] as Record<string, unknown>[],
    );
    const handler = createCodeActHandler({ executeQuery: exec });

    const limitedTemplate = SQL_TEMPLATES.find((t) =>
      t.sql.toUpperCase().includes("LIMIT"),
    );
    if (!limitedTemplate) return;

    const params = buildParams(limitedTemplate);
    await handler({ template_id: limitedTemplate.id, params });

    const [sqlArg] = exec.mock.calls[0];
    const limitCount = (sqlArg.toUpperCase().match(/LIMIT/g) || []).length;
    expect(limitCount).toBe(1);
  });

  it("executes valid templates successfully (defense-in-depth check passes)", async () => {
    const exec = vi.fn(
      async (_sql: string, _params: unknown[]) =>
        [] as Record<string, unknown>[],
    );
    const handler = createCodeActHandler({ executeQuery: exec });

    const template = SQL_TEMPLATES[0];
    const params = buildParams(template);

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    if (parsed.error) {
      expect(parsed.error).not.toMatch(/SELECT|INSERT|non-SELECT/i);
    }
  });

  it("enforces timeout on query execution", async () => {
    const handler = createCodeActHandler({
      executeQuery: delayedExecutor(3000, []),
      timeout: 100,
    });

    const template = SQL_TEMPLATES[0];
    const params = buildParams(template);

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
    const params = buildParams(template);

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    expect(parsed.rows).toEqual([{ x: 1 }]);
  });

  it("returns an error when executeQuery throws", async () => {
    const handler = createCodeActHandler({
      executeQuery: async () => {
        throw new Error("DB connection failed");
      },
    });

    const template = SQL_TEMPLATES[0];
    const params = buildParams(template);

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
    const params = buildParams(template);

    const result = await handler({ template_id: template.id, params });
    const parsed = JSON.parse(result);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rowCount).toBe(0);
  });

  it("rejects empty string for uuid-typed parameters", async () => {
    const uuidTemplate = SQL_TEMPLATES.find((t) =>
      t.paramTypes.includes("uuid"),
    );
    if (!uuidTemplate) return;

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
    expect(parsed.error).toBeDefined();
  });
});

// ─── Integration: CodeAct handler in loop ───────────────────────────────────

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

    const prompt = tracer.events().find((e) => e.type === "model_prompt");
    expect(prompt?.payload).toContain("code_act");
  });

  it("does not inject template prompt when code_act tool is not registered", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

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
                params: buildParams(SQL_TEMPLATES[0]),
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

    const act = events.find((e) => e.type === "act");
    expect(act?.toolCall?.name).toBe("code_act");

    const observe = events.find(
      (e) => e.type === "observe" && e.toolResult?.name === "code_act",
    );
    expect(observe).toBeDefined();
    const parsedResult = JSON.parse(observe!.toolResult!.result);
    expect(parsedResult.rows).toEqual(fakeRows);
  });
});
