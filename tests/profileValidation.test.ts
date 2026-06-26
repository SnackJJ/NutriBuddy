import { describe, it, expect } from "vitest";
import { profileFormSchema, GOAL_TYPES } from "../src/lib/profileValidation";

describe("profileFormSchema", () => {
  it("accepts a complete valid profile with all fields", () => {
    const result = profileFormSchema.safeParse({
      allergies: ["peanut", "shellfish"],
      medications: ["warfarin"],
      goalType: "muscle_gain",
      proteinTargetG: 140,
      kcalTarget: 2500,
      fatTargetG: 70,
      carbsTargetG: 300,
      heightCm: 180,
      weightKg: 75,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proteinTargetG).toBe(140);
      expect(result.data.allergies).toEqual(["peanut", "shellfish"]);
    }
  });

  it("accepts an empty object — all fields are optional", () => {
    const result = profileFormSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allergies).toEqual([]);
      expect(result.data.medications).toEqual([]);
      expect(result.data.goalType).toBeNull();
      expect(result.data.proteinTargetG).toBeNull();
    }
  });

  it("defaults allergies and medications to empty arrays when omitted", () => {
    const result = profileFormSchema.safeParse({ goalType: "maintain" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allergies).toEqual([]);
      expect(result.data.medications).toEqual([]);
    }
  });

  it("defaults nullable numeric fields to null when omitted", () => {
    const result = profileFormSchema.safeParse({ allergies: ["peanut"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proteinTargetG).toBeNull();
      expect(result.data.kcalTarget).toBeNull();
      expect(result.data.fatTargetG).toBeNull();
      expect(result.data.carbsTargetG).toBeNull();
      expect(result.data.heightCm).toBeNull();
      expect(result.data.weightKg).toBeNull();
      expect(result.data.goalType).toBeNull();
    }
  });

  it("rejects proteinTargetG below 0", () => {
    const result = profileFormSchema.safeParse({ proteinTargetG: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects proteinTargetG above 500", () => {
    const result = profileFormSchema.safeParse({ proteinTargetG: 501 });
    expect(result.success).toBe(false);
  });

  it("accepts proteinTargetG at boundary values 0 and 500", () => {
    expect(profileFormSchema.safeParse({ proteinTargetG: 0 }).success).toBe(true);
    expect(profileFormSchema.safeParse({ proteinTargetG: 500 }).success).toBe(true);
  });

  it("rejects kcalTarget above 10000", () => {
    const result = profileFormSchema.safeParse({ kcalTarget: 10001 });
    expect(result.success).toBe(false);
  });

  it("rejects fatTargetG above 500", () => {
    const result = profileFormSchema.safeParse({ fatTargetG: 501 });
    expect(result.success).toBe(false);
  });

  it("rejects carbsTargetG above 1000", () => {
    const result = profileFormSchema.safeParse({ carbsTargetG: 1001 });
    expect(result.success).toBe(false);
  });

  it("rejects heightCm below 50", () => {
    const result = profileFormSchema.safeParse({ heightCm: 49 });
    expect(result.success).toBe(false);
  });

  it("rejects heightCm above 300", () => {
    const result = profileFormSchema.safeParse({ heightCm: 301 });
    expect(result.success).toBe(false);
  });

  it("rejects weightKg below 10", () => {
    const result = profileFormSchema.safeParse({ weightKg: 9 });
    expect(result.success).toBe(false);
  });

  it("rejects weightKg above 500", () => {
    const result = profileFormSchema.safeParse({ weightKg: 501 });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid goalType value", () => {
    const result = profileFormSchema.safeParse({ goalType: "super_saiyan" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid goalType values", () => {
    for (const gt of GOAL_TYPES) {
      const result = profileFormSchema.safeParse({ goalType: gt });
      expect(result.success).toBe(true);
    }
  });

  it("accepts null goalType explicitly", () => {
    const result = profileFormSchema.safeParse({ goalType: null });
    expect(result.success).toBe(true);
  });

  it("rejects empty-string allergy tags", () => {
    const result = profileFormSchema.safeParse({ allergies: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects overly long allergy tags (>100 chars)", () => {
    const result = profileFormSchema.safeParse({ allergies: ["a".repeat(101)] });
    expect(result.success).toBe(false);
  });

  it("rejects too many allergies (>50)", () => {
    const result = profileFormSchema.safeParse({
      allergies: Array.from({ length: 51 }, (_, i) => `allergy-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string values in allergies array", () => {
    const result = profileFormSchema.safeParse({ allergies: [123] });
    expect(result.success).toBe(false);
  });
});
