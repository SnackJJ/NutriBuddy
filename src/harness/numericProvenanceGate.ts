// Numeric Provenance Gate — verifies that every unit-attached numeric fact
// in the typed output prose traces to a query observation value (ADD §Gates / Output gate).
//
// This is one of the four output gate checks. It does not do model arithmetic —
// the no-arithmetic contract already pushed derivation into observations, so
// the gate only matches prose numbers against observed values with unit
// normalization and rounding tolerance.

import type { TypedOutput } from "./types";
import type { Observation } from "../catalog/queryCatalog";

// ─── types ─────────────────────────────────────────────────────────────────

export interface NumericProvenanceInput {
  /** Typed final output to check. */
  readonly output: TypedOutput;
  /** Observations from the turn (from query catalog template executions). */
  readonly observations: readonly Observation[];
  /**
   * Relative tolerance for numeric comparison. Defaults to 0.05 (5%).
   * Set to 0 for exact-match mode in strict eval contexts.
   */
  readonly tolerance?: number;
}

export interface NumericProvenanceResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

// ─── unit normalization ────────────────────────────────────────────────────

/**
 * Convert a value and unit to a base unit for comparison.
 * Returns the converted value in base units, or null if the unit is unrecognized.
 *
 * We use g as the mass base and kcal as the energy base
 * because those are the units the query catalog declares.
 */
/**
 * Spelled-out mass units, folded onto the abbreviations the catalog declares.
 *
 * The extractor recognizes both spellings; the observation side only ever writes
 * `g`/`mg`/`kg`, so without this table a grounded figure phrased in words cannot
 * be matched or converted, and the gate refuses a correct answer.
 */
const SPELLED_OUT_MASS_UNITS: Record<string, string> = {
  grams: "g",
  gram: "g",
  milligrams: "mg",
  milligram: "mg",
  kilograms: "kg",
  kilogram: "kg",
  micrograms: "mcg",
  microgram: "mcg",
};

const MASS_CONVERSIONS: Record<string, { readonly factor: number }> = {
  g: { factor: 1 },
  mg: { factor: 0.001 },
  kg: { factor: 1000 },
  // Micrograms, which the corpus writes three ways. Without these, "500 mcg"
  // stated by the model could not be compared with a milligram observation, and
  // the two would look like a mismatch rather than a unit conversion.
  mcg: { factor: 0.000001 },
  "µg": { factor: 0.000001 },
  ug: { factor: 0.000001 },
};

const ENERGY_CONVERSIONS: Record<string, { readonly factor: number }> = {
  kcal: { factor: 1 },
  cal: { factor: 0.001 },
};

function toBaseUnits(
  value: number,
  unit: string,
): { baseValue: number; baseUnit: string } | null {
  const lower = unit.toLowerCase();

  if (MASS_CONVERSIONS[lower]) {
    return {
      baseValue: value * MASS_CONVERSIONS[lower].factor,
      baseUnit: "g",
    };
  }

  if (ENERGY_CONVERSIONS[lower]) {
    return {
      baseValue: value * ENERGY_CONVERSIONS[lower].factor,
      baseUnit: "kcal",
    };
  }

  // Unrecognized unit — cannot normalize, treat as-is
  return null;
}

function normalizeUnit(unit: string): string | null {
  const lower = unit.toLowerCase();
  if (MASS_CONVERSIONS[lower]) return "g";
  if (ENERGY_CONVERSIONS[lower]) return "kcal";
  return null;
}

// ─── number extraction ─────────────────────────────────────────────────────

interface ExtractedNumber {
  value: number;
  unit: string | null;
  raw: string;
}

/**
 * Known nutrition units the regex matches. The regex is /number\s*unit\b/gi,
 * so we pre-compile the unit set to check matches.
 */
const NUTRITION_UNITS = [
  "g",
  "mg",
  "kg",
  "kcal",
  "cal",
  "calories",
  "calorie",
  "oz",
  "lb",
  "ml",
  "L",
  "cup",
  "cups",
  "tbsp",
  "tsp",
  // Micrograms and international units. Measured on the committed corpus, `mcg`
  // (285 occurrences) and `iu` (92) are the second and fourth most common
  // number-attached units in the evidence text — so leaving them out meant the
  // numeric provenance gate could not see the figures the corpus states most
  // often about the very nutrients it covers. `nmol` and `ng` are lab measures
  // that appear in the same sentences; they are recognized for the same reason,
  // which is that a model quoting them should be asked where they came from.
  "mcg",
  "µg",
  "ug",
  "micrograms",
  "microgram",
  "milligrams",
  "milligram",
  "grams",
  "gram",
  "iu",
  "ng",
  "nmol",
];

// Build unit alternation for the regex.
const UNIT_ALT = NUTRITION_UNITS.join("|");
const NUMBER_WITH_UNIT_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALT})\\b`,
  "gi",
);

/**
 * Extract numbers with attached nutrition units from prose text.
 * Returns an array of { value, unit, raw } for each match.
 */
export function extractNumbersFromProse(prose: string): ExtractedNumber[] {
  const results: ExtractedNumber[] = [];
  const regex = new RegExp(NUMBER_WITH_UNIT_RE.source, "gi");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(prose)) !== null) {
    const raw = match[0];
    const value = parseFloat(match[1]);
    let unit = match[2].toLowerCase();

    // Normalize common variants.
    // In nutrition contexts, "calories" / "calorie" means kilocalories (kcal).
    if (unit === "calories" || unit === "calorie") {
      unit = "kcal";
    }
    if (unit === "cups") {
      unit = "cup";
    }
    // Spelled-out mass units fold into their abbreviations, because that is the
    // vocabulary the catalog declares: recognizing "milligrams" in prose without
    // translating it would make an answer that says "500 milligrams" ungroundable
    // against an observation column of `mg` — the failure direction this gate's
    // tolerance logic exists to avoid, and one that costs a correct answer.
    const spelledOut = SPELLED_OUT_MASS_UNITS[unit];
    if (spelledOut) {
      unit = spelledOut;
    }

    results.push({ value, unit: unit || null, raw });
  }

  return results;
}

// ─── observation value extraction ──────────────────────────────────────────

interface ObservationValue {
  value: number;
  unit: string;
  column: string;
  templateId: string;
  rowIndex: number;
}

/**
 * Collect all numeric values from observations, annotated with unit and column metadata.
 */
function collectObservationValues(
  observations: readonly Observation[],
): ObservationValue[] {
  const values: ObservationValue[] = [];

  for (const obs of observations) {
    const numericCols = obs.columns.filter((c) => c.type === "number");
    for (let ri = 0; ri < obs.rows.length; ri++) {
      const row = obs.rows[ri];
      for (const col of numericCols) {
        const val = row[col.name];
        if (typeof val === "number" && Number.isFinite(val)) {
          values.push({
            value: val,
            unit: col.unit ?? "",
            column: col.name,
            templateId: obs.templateId,
            rowIndex: ri,
          });
        }
      }
    }
  }

  return values;
}

// ─── matching logic ────────────────────────────────────────────────────────

function valuesClose(
  proseValue: number,
  observedValue: number,
  tolerance: number,
): boolean {
  if (observedValue === 0) {
    return Math.abs(proseValue - observedValue) <= 0.01;
  }
  const relativeDiff =
    Math.abs(proseValue - observedValue) / Math.abs(observedValue);
  return relativeDiff <= tolerance;
}

function findMatchingObservation(
  extracted: ExtractedNumber,
  obsValues: ObservationValue[],
  tolerance: number,
): ObservationValue | null {
  const proseUnit = extracted.unit;
  const proseValue = extracted.value;

  for (const obs of obsValues) {
    // Try exact unit match first
    if (proseUnit && proseUnit === obs.unit.toLowerCase()) {
      if (valuesClose(proseValue, obs.value, tolerance)) {
        return obs;
      }
    }

    // Try unit normalization for mass (g ↔ mg ↔ kg)
    if (proseUnit && obs.unit) {
      const proseBase = toBaseUnits(proseValue, proseUnit);
      const obsBase = toBaseUnits(obs.value, obs.unit);
      if (proseBase && obsBase && proseBase.baseUnit === obsBase.baseUnit) {
        if (valuesClose(proseBase.baseValue, obsBase.baseValue, tolerance)) {
          return obs;
        }
      }
    }

    // Fallback: numeric-only match when units can't be determined
    // (only when prose has no recognized unit but the value matches)
    if (!proseUnit && valuesClose(proseValue, obs.value, tolerance)) {
      return obs;
    }
  }

  return null;
}

// ─── main check ────────────────────────────────────────────────────────────

const DEFAULT_TOLERANCE = 0.05; // 5% relative tolerance

/**
 * Check that every unit-attached numeric fact in the typed output prose
 * traces to a query observation (schema-declared numeric column value).
 *
 * Implements ADD §Output gate check (b): Numeric Provenance.
 *
 * The no-arithmetic contract ensures all derived values arrive as
 * observation columns — this check only matches, it does not compute.
 */
export function checkNumericProvenance(
  input: NumericProvenanceInput,
): NumericProvenanceResult {
  const { output, observations, tolerance = DEFAULT_TOLERANCE } = input;
  const prose = output.prose;

  const extracted = extractNumbersFromProse(prose);
  if (extracted.length === 0) {
    return { passed: true, reasons: [] };
  }

  const obsValues = collectObservationValues(observations);

  const ungrounded: string[] = [];

  for (const num of extracted) {
    const match = findMatchingObservation(num, obsValues, tolerance);
    if (!match) {
      const unitLabel = num.unit ? ` ${num.unit}` : "";
      ungrounded.push(
        `Ungrounded numeric fact: "${num.raw}" (value ${num.value}${unitLabel}) ` +
          `does not trace to any observation column.`,
      );
    }
  }

  return {
    passed: ungrounded.length === 0,
    reasons: ungrounded,
  };
}
