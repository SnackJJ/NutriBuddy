import { z } from "zod";

/** Valid goal types for the profile form. */
export const GOAL_TYPES = [
  "weight_loss",
  "muscle_gain",
  "maintain",
  "general_health",
] as const;

export type GoalType = (typeof GOAL_TYPES)[number];

/** Zod schema for profile form submission data. */
export const profileFormSchema = z.object({
  allergies: z
    .array(z.string().min(1).max(100))
    .max(50)
    .default([]),
  medications: z
    .array(z.string().min(1).max(100))
    .max(50)
    .default([]),
  goalType: z.enum(GOAL_TYPES).nullable().default(null),
  proteinTargetG: z.number().min(0).max(500).nullable().default(null),
  kcalTarget: z.number().min(0).max(10000).nullable().default(null),
  fatTargetG: z.number().min(0).max(500).nullable().default(null),
  carbsTargetG: z.number().min(0).max(1000).nullable().default(null),
  heightCm: z.number().min(50).max(300).nullable().default(null),
  weightKg: z.number().min(10).max(500).nullable().default(null),
});

export type ProfileFormData = z.infer<typeof profileFormSchema>;
