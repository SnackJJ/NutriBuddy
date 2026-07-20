// RFC 0002 — ToolOutcome types, pure gate mapper, and render rules.
// Slice A: no loop/turn wiring. See docs/rfc/0002-tool-outcome.md.

import type { Observation } from "../catalog/queryCatalog";

// ─── JSON-serializable value ──────────────────────────────────────────────

/** JSON-serializable value (JSON.stringify-safe; no NaN/Infinity/bigint/function). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ─── ToolOutcome ──────────────────────────────────────────────────────────

/**
 * Discriminated tool outcome — produced by dispatch (and, after Slice C, handlers).
 * Never produced by the model.
 *
 * `name` is stamped by dispatch from ToolCall.name (except submit_answer, which
 * is loop-owned — RFC §2.4).
 */
export type ToolOutcome =
  | {
      readonly kind: "ok";
      readonly name: string;
      readonly data: JsonValue;
      readonly observation?: Observation;
    }
  | {
      readonly kind: "typed_miss";
      readonly name: string;
      readonly message: string;
      readonly data: JsonValue;
      readonly candidates?: readonly JsonValue[];
    }
  | {
      readonly kind: "typed_error";
      readonly name: string;
      readonly message: string;
      readonly data: JsonValue;
    }
  | {
      readonly kind: "dispatch_error";
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "infra_error";
      readonly name: string;
      /** Sanitized public diagnostic — never raw Error.message. */
      readonly cause: string;
    };

/** What a migrated handler returns (name stamped by dispatch). */
export type HandlerOutcome =
  | Omit<Extract<ToolOutcome, { kind: "ok" }>, "name">
  | Omit<Extract<ToolOutcome, { kind: "typed_miss" }>, "name">
  | Omit<Extract<ToolOutcome, { kind: "typed_error" }>, "name">;

// ─── Gate mapping ─────────────────────────────────────────────────────────

export type ToolGateReasonCode =
  | "tool_ok"
  | "typed_miss"
  | "typed_error"
  | "dispatch_error"
  | "infra_error";

export type ToolGateFromOutcome = {
  readonly checkpoint: "tool";
  readonly verdict: "pass" | "error";
  readonly checkName: "tool_gate_check";
  readonly reasonCode: ToolGateReasonCode;
  readonly evidence: string;
};

const TOOL_GATE_CHECK = "tool_gate_check" as const;

/** Fixed user-safe render for infra_error (RFC §2.1.1). */
export const INFRA_ERROR_RENDER =
  "tool failed due to an internal error; please retry";

/** Public sanitized cause for wire events (RFC §2.5). */
export const INFRA_ERROR_PUBLIC_CAUSE = "internal_error";

export function toolGateFromOutcome(outcome: ToolOutcome): ToolGateFromOutcome {
  switch (outcome.kind) {
    case "ok":
      return {
        checkpoint: "tool",
        verdict: "pass",
        checkName: TOOL_GATE_CHECK,
        reasonCode: "tool_ok",
        evidence: `Tool ${outcome.name} executed successfully`,
      };
    case "typed_miss":
      return {
        checkpoint: "tool",
        verdict: "pass",
        checkName: TOOL_GATE_CHECK,
        reasonCode: "typed_miss",
        evidence: `Tool ${outcome.name} returned a typed miss (clarification): ${outcome.message}`,
      };
    case "typed_error":
      return {
        checkpoint: "tool",
        verdict: "error",
        checkName: TOOL_GATE_CHECK,
        reasonCode: "typed_error",
        evidence: `Tool ${outcome.name} returned a typed error: ${outcome.message}`,
      };
    case "dispatch_error":
      return {
        checkpoint: "tool",
        verdict: "error",
        checkName: TOOL_GATE_CHECK,
        reasonCode: "dispatch_error",
        evidence: `Tool ${outcome.name} dispatch error: ${outcome.message}`,
      };
    case "infra_error":
      return {
        checkpoint: "tool",
        verdict: "error",
        checkName: TOOL_GATE_CHECK,
        reasonCode: "infra_error",
        evidence: `Tool ${outcome.name} infrastructure error`,
      };
  }
}

// ─── Render ───────────────────────────────────────────────────────────────

/**
 * Model-facing + deprecated toolResult.result string (RFC §2.1.1).
 * Total for every valid ToolOutcome.
 */
export function renderToolOutcome(outcome: ToolOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return renderOk(outcome.name, outcome.data);
    case "typed_miss":
    case "typed_error":
      return JSON.stringify(outcome.data);
    case "dispatch_error":
      return outcome.message;
    case "infra_error":
      return INFRA_ERROR_RENDER;
  }
}

function renderOk(name: string, data: JsonValue): string {
  if (name === "submit_answer") {
    return renderSubmitAnswer(data);
  }
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data);
}

/**
 * Matches loop.describeSubmitAnswerResult semantics (RFC §2.4).
 * data is null or a JSON projection of TypedOutput with foodRefs/ruleRefs arrays.
 */
function renderSubmitAnswer(data: JsonValue): string {
  if (data === null) {
    return "Answer submitted (prose-only fallback)";
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as { readonly [key: string]: JsonValue };
    const foodRefs = record.foodRefs;
    const ruleRefs = record.ruleRefs;
    const foodCount = Array.isArray(foodRefs) ? foodRefs.length : 0;
    const ruleCount = Array.isArray(ruleRefs) ? ruleRefs.length : 0;
    return `Answer submitted with ${foodCount} food ref(s) and ${ruleCount} rule ref(s)`;
  }
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data);
}

// ─── Serializability ──────────────────────────────────────────────────────

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns true when value is JSON-serializable under RFC rules:
 * plain objects/arrays only; no cycles on the active path; no non-finite
 * numbers; no bigint/function/symbol/undefined values; shared DAG refs OK.
 */
export function isJsonValue(
  value: unknown,
  path: Set<object> = new Set(),
): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  // Reject Map/Set/Date/class instances — only JSON records and arrays.
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return false;
  }
  if (path.has(value)) {
    return false;
  }
  path.add(value);

  if (Array.isArray(value)) {
    const ok = value.every((item) => isJsonValue(item, path));
    path.delete(value);
    return ok;
  }

  for (const child of Object.values(value)) {
    // JSON.stringify omits undefined values; treat them as absent keys.
    if (child === undefined) {
      continue;
    }
    if (!isJsonValue(child, path)) {
      path.delete(value);
      return false;
    }
  }
  path.delete(value);
  return true;
}

/** Validate data (+ optional observation / candidates) before observe emission. */
export function isToolOutcomePayloadSerializable(
  data: unknown,
  observation?: unknown,
  candidates?: unknown,
): boolean {
  if (!isJsonValue(data)) {
    return false;
  }
  if (observation !== undefined && !isJsonValue(observation as unknown)) {
    return false;
  }
  if (candidates !== undefined && !isJsonValue(candidates as unknown)) {
    return false;
  }
  return true;
}

// ─── Legacy string bridge (Slice B; deleted in C) ─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Single dispatch-owned normalizer for string-returning handlers (RFC §2.3.1).
 */
export function normalizeLegacyToolResult(
  name: string,
  raw: string,
): ToolOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "ok", name, data: raw };
  }

  if (!isJsonValue(parsed)) {
    return {
      kind: "infra_error",
      name,
      cause: INFRA_ERROR_PUBLIC_CAUSE,
    };
  }

  if (isRecord(parsed) && parsed.type === "error") {
    const message = readString(parsed, "message") ?? "typed error result";
    return {
      kind: "typed_error",
      name,
      message,
      data: parsed,
    };
  }

  if (isRecord(parsed)) {
    const error = readString(parsed, "error");
    if (error !== undefined) {
      const matchType = readString(parsed, "match_type");
      if (matchType?.startsWith("miss_")) {
        const candidates = Array.isArray(parsed.candidates)
          ? (parsed.candidates as JsonValue[])
          : undefined;
        return {
          kind: "typed_miss",
          name,
          message: error,
          data: parsed,
          candidates,
        };
      }
      return {
        kind: "typed_error",
        name,
        message: error,
        data: parsed,
      };
    }
  }

  // query_catalog success: embed capped observation on the outcome
  if (
    name === "query_catalog" &&
    isRecord(parsed) &&
    parsed.type === "observation" &&
    isRecord(parsed.observation)
  ) {
    const observation = parsed.observation as unknown as Observation;
    return {
      kind: "ok",
      name,
      data: parsed,
      observation,
    };
  }

  return { kind: "ok", name, data: parsed };
}

/** Derive deprecated ToolResult for chat / role:tool (RFC §2.6). */
export function deriveToolResult(outcome: ToolOutcome): {
  readonly name: string;
  readonly result: string;
  readonly dispatchError?: boolean;
} {
  return {
    name: outcome.name,
    result: renderToolOutcome(outcome),
    ...(outcome.kind === "dispatch_error" ? { dispatchError: true as const } : {}),
  };
}

/**
 * JSON-safe plain-object projection of TypedOutput for submit_answer ok.data.
 * Omits nothing required; foodRefs/ruleRefs are plain arrays of plain objects.
 */
export function projectTypedOutput(output: {
  readonly prose: string;
  readonly foodRefs: readonly {
    readonly foodId: string;
    readonly foodName: string;
    readonly matchType: string;
    readonly allergens?: readonly string[];
  }[];
  readonly ruleRefs: readonly {
    readonly ruleId: string;
    readonly summary: string;
  }[];
}): JsonValue {
  return {
    prose: output.prose,
    foodRefs: output.foodRefs.map((ref) => {
      const base: { [key: string]: JsonValue } = {
        foodId: ref.foodId,
        foodName: ref.foodName,
        matchType: ref.matchType,
      };
      if (ref.allergens !== undefined) {
        base.allergens = [...ref.allergens];
      }
      return base;
    }),
    ruleRefs: output.ruleRefs.map((ref) => ({
      ruleId: ref.ruleId,
      summary: ref.summary,
    })),
  };
}

export function stampHandlerOutcome(
  name: string,
  body: HandlerOutcome,
): ToolOutcome {
  return { ...body, name } as ToolOutcome;
}
