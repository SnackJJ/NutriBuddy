import { describe, it, expect } from "vitest";
import {
  renderObservationText,
  renderObservationRow,
  MAX_OBSERVATION_ROWS,
  MAX_OBSERVATION_BYTES,
  FOOD_LOOKUP_TEMPLATE,
  type Observation,
  type ColumnDef,
  type ObservationRow,
} from "../src/catalog/queryCatalog";

// ─── helpers ───────────────────────────────────────────────────────────────

function makeObservation(
  overrides: Partial<Observation> & { rows: ObservationRow[] } = {
    rows: [],
  },
): Observation {
  const { rows, ...rest } = overrides;
  return {
    templateId: "food_lookup",
    columns: FOOD_LOOKUP_TEMPLATE.resultSchema,
    rows,
    rowCount: rows.length,
    truncated: false,
    ...rest,
  };
}

function makeRow(values: Record<string, unknown>): ObservationRow {
  return values;
}

const FEW_COLS: ColumnDef[] = [
  { name: "food_id", type: "string", description: "Food ID" },
  { name: "kcal", type: "number", unit: "kcal", description: "Calories" },
  {
    name: "protein_g",
    type: "number",
    unit: "g",
    description: "Protein",
  },
];

// ─── renderObservationRow ──────────────────────────────────────────────────

describe("renderObservationRow", () => {
  it("renders column values in 'name: value unit' format", () => {
    const row = makeRow({ food_id: "food-001", kcal: 165 });
    const text = renderObservationRow(row, FEW_COLS);

    expect(text).toContain("food_id: food-001");
    expect(text).toContain("kcal: 165 kcal");
  });

  it("skips undefined and null values", () => {
    const row = makeRow({
      food_id: null,
      kcal: undefined,
      protein_g: 31,
    });
    const text = renderObservationRow(row, FEW_COLS);

    expect(text).not.toContain("food_id");
    expect(text).not.toContain("kcal");
    expect(text).toContain("protein_g: 31 g");
  });

  it("renders numeric values with units using the column metadata", () => {
    const row = makeRow({
      food_id: "food-salmon-001",
      kcal: 208,
      protein_g: 20,
    });
    const text = renderObservationRow(row, FEW_COLS);

    expect(text).toBe(
      "food_id: food-salmon-001 | kcal: 208 kcal | protein_g: 20 g",
    );
  });
});

// ─── renderObservationText ─────────────────────────────────────────────────

describe("renderObservationText", () => {
  it("produces a canonical text header with template id", () => {
    const obs = makeObservation({
      rows: [makeRow({ food_id: "food-001", kcal: 165, protein_g: 31 })],
    });
    const { text } = renderObservationText(obs);

    expect(text).toContain("[query result: food_lookup]");
    expect(text).toContain("food_id: food-001");
    expect(text).toContain("kcal: 165 kcal");
    expect(text).toContain("protein_g: 31 g");
  });

  it("returns truncated=false when all rows fit", () => {
    const obs = makeObservation({
      rows: [
        makeRow({ food_id: "food-001", kcal: 165, protein_g: 31 }),
        makeRow({ food_id: "food-002", kcal: 208, protein_g: 20 }),
      ],
    });
    const { truncated, renderedRows } = renderObservationText(obs);

    expect(truncated).toBe(false);
    expect(renderedRows).toBe(2);
  });

  it("truncates by row cap when rows exceed maxRows", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({ food_id: `food-${String(i).padStart(3, "0")}`, kcal: 100 }),
    );
    const obs = makeObservation({ rows, rowCount: 30 });
    const { text, truncated, renderedRows } = renderObservationText(obs, 5);

    expect(truncated).toBe(true);
    expect(renderedRows).toBe(5);
    expect(text).toContain("[query result: food_lookup]");
    // Should have the row cap notice
    expect(text).toContain("row(s) omitted");
    expect(text).toContain("full data available in session trace");
  });

  it("truncates by byte ceiling when output exceeds maxBytes", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeRow({
        food_id: `food-very-long-name-${String(i).padStart(5, "0")}`,
        kcal: 100,
        protein_g: 10,
      }),
    );
    const obs = makeObservation({ rows, rowCount: 100 });
    const { text, truncated } = renderObservationText(obs, 500, 200);

    expect(truncated).toBe(true);
    // Should fit fewer than 100 rows within 200 bytes
    expect(text.length).toBeLessThanOrEqual(250); // slight overage for closing notice
    expect(text).toContain("row(s) omitted");
  });

  it("handles single row that exceeds byte ceiling", () => {
    const rows = [
      makeRow({
        food_id:
          "food-very-very-very-very-very-very-very-very-very-long-id-that-makes-this-row-huge",
        kcal: 99999,
        protein_g: 99999,
      }),
    ];
    const obs = makeObservation({ rows, rowCount: 1 });
    const { text, truncated, renderedRows } = renderObservationText(obs, 25, 100);

    expect(truncated).toBe(true);
    expect(renderedRows).toBe(1);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain("truncated at");
  });

  it("flags truncated when observation itself is truncated upstream", () => {
    const obs = makeObservation({
      rows: [makeRow({ food_id: "food-001", kcal: 100 })],
      truncated: true,
    });
    const { truncated } = renderObservationText(obs);

    expect(truncated).toBe(true);
  });

  it("honors default maxRows and maxBytes constants", () => {
    // Make an observation with fewer rows than the default max
    const rows = Array.from(
      { length: MAX_OBSERVATION_ROWS - 5 },
      (_, i) =>
        makeRow({
          food_id: `food-${String(i).padStart(3, "0")}`,
          kcal: 100,
        }) as ObservationRow,
    );
    const obs = makeObservation({ rows, rowCount: MAX_OBSERVATION_ROWS - 5 });
    const { truncated, renderedRows } = renderObservationText(obs);

    expect(truncated).toBe(false);
    expect(renderedRows).toBe(MAX_OBSERVATION_ROWS - 5);
  });

  it("default maxRows constant has a reasonable value", () => {
    expect(MAX_OBSERVATION_ROWS).toBeGreaterThan(0);
    expect(MAX_OBSERVATION_ROWS).toBeLessThan(100);
  });

  it("default maxBytes constant has a reasonable value", () => {
    expect(MAX_OBSERVATION_BYTES).toBeGreaterThan(500);
    expect(MAX_OBSERVATION_BYTES).toBeLessThan(100_000);
  });
});
