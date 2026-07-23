// TodayBar remaining math (RFC 0004 §5) — deterministic, no model arithmetic.

export interface MacroTotals {
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
}

export interface MacroTargets {
  readonly kcalTarget: number | null;
  readonly proteinTargetG: number | null;
  readonly fatTargetG: number | null;
  readonly carbsTargetG: number | null;
}

export interface MacroRemaining {
  readonly kcal: number | null;
  readonly proteinG: number | null;
  readonly fatG: number | null;
  readonly carbsG: number | null;
}

export function computeRemaining(
  consumed: MacroTotals,
  targets: MacroTargets,
): MacroRemaining {
  return {
    kcal:
      targets.kcalTarget === null || targets.kcalTarget === undefined
        ? null
        : targets.kcalTarget - consumed.kcal,
    proteinG:
      targets.proteinTargetG === null || targets.proteinTargetG === undefined
        ? null
        : targets.proteinTargetG - consumed.proteinG,
    fatG:
      targets.fatTargetG === null || targets.fatTargetG === undefined
        ? null
        : targets.fatTargetG - consumed.fatG,
    carbsG:
      targets.carbsTargetG === null || targets.carbsTargetG === undefined
        ? null
        : targets.carbsTargetG - consumed.carbsG,
  };
}

export function emptyTotals(): MacroTotals {
  return { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 };
}

export function todayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
