import { describe, expect, it } from "vitest";
import { computeRemaining, emptyTotals } from "../src/lib/todayTotals";

describe("computeRemaining", () => {
  it("subtracts consumed from targets", () => {
    expect(
      computeRemaining(
        { kcal: 400, proteinG: 30, fatG: 10, carbsG: 40 },
        {
          kcalTarget: 2000,
          proteinTargetG: 120,
          fatTargetG: 60,
          carbsTargetG: 200,
        },
      ),
    ).toEqual({
      kcal: 1600,
      proteinG: 90,
      fatG: 50,
      carbsG: 160,
    });
  });

  it("returns null remaining when target is null", () => {
    expect(
      computeRemaining(emptyTotals(), {
        kcalTarget: null,
        proteinTargetG: 50,
        fatTargetG: null,
        carbsTargetG: null,
      }),
    ).toEqual({
      kcal: null,
      proteinG: 50,
      fatG: null,
      carbsG: null,
    });
  });
});
