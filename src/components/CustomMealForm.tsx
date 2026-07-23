"use client";

import { useState } from "react";

export interface CustomMealFormValues {
  foodName: string;
  portionG: number;
  mealType: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

export function CustomMealForm({
  initialName,
  onSubmit,
  disabled,
}: {
  initialName?: string;
  onSubmit: (values: CustomMealFormValues) => void;
  disabled?: boolean;
}) {
  const [foodName, setFoodName] = useState(initialName ?? "");
  const [portionG, setPortionG] = useState("100");
  const [mealType, setMealType] = useState("snack");
  const [kcal, setKcal] = useState("");
  const [proteinG, setProteinG] = useState("");
  const [fatG, setFatG] = useState("");
  const [carbsG, setCarbsG] = useState("");

  return (
    <form
      className="space-y-2 rounded-xl border border-line bg-surface p-4 shadow-sm"
      data-custom-meal-form="true"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          foodName: foodName.trim(),
          portionG: Number(portionG),
          mealType,
          kcal: Number(kcal),
          proteinG: Number(proteinG),
          fatG: Number(fatG),
          carbsG: Number(carbsG),
        });
      }}
    >
      <p className="text-sm font-semibold text-ink">Hand-enter meal (packaging escape hatch)</p>
      <p className="text-xs text-ink-muted">
        Macros are from your label — not the model. Allergen coverage stays unreviewed.
      </p>
      {(
        [
          ["Name", foodName, setFoodName, "text"],
          ["Portion g", portionG, setPortionG, "number"],
          ["kcal", kcal, setKcal, "number"],
          ["Protein g", proteinG, setProteinG, "number"],
          ["Fat g", fatG, setFatG, "number"],
          ["Carbs g", carbsG, setCarbsG, "number"],
        ] as const
      ).map(([label, value, set, type]) => (
        <label key={label} className="block text-xs font-medium text-ink">
          {label}
          <input
            type={type}
            value={value}
            onChange={(e) => set(e.target.value)}
            disabled={disabled}
            className="mt-1 min-h-[40px] w-full rounded-lg border border-line px-2 py-1.5 text-sm"
            required
          />
        </label>
      ))}
      <label className="block text-xs font-medium text-ink">
        Meal type
        <select
          value={mealType}
          onChange={(e) => setMealType(e.target.value)}
          disabled={disabled}
          className="mt-1 min-h-[40px] w-full rounded-lg border border-line px-2 py-1.5 text-sm"
        >
          {["breakfast", "lunch", "dinner", "snack"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={disabled}
        className="min-h-[44px] w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        Create proposal
      </button>
    </form>
  );
}
