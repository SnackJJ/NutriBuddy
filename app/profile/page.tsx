"use client";

import { useState, useEffect, useCallback } from "react";
import { profileFormSchema, GOAL_TYPES } from "@/lib/profileValidation";
import type { UserProfile } from "@/lib/memoryStore";

/** Generate a stable client-side userId stored in localStorage (M1 — no auth yet). */
function getUserId(): string {
  const key = "nutribuddy_user_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

/** TagInput: text field that adds tags on Enter / comma and shows them as chips. */
function TagInput({
  label,
  tags,
  onChange,
}: {
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const addTag = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  }, [input, tags, onChange]);

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag));
    },
    [tags, onChange],
  );

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="flex flex-wrap gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-2.5 py-0.5 text-sm text-blue-800"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-blue-600 hover:bg-blue-200 hover:text-blue-900"
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          placeholder={tags.length === 0 ? "Type and press Enter…" : undefined}
          className="min-w-[120px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-gray-400"
        />
      </div>
    </div>
  );
}

/** Goal type display names for the select dropdown. */
const GOAL_LABELS: Record<string, string> = {
  weight_loss: "Weight Loss",
  muscle_gain: "Muscle Gain",
  maintain: "Maintain Weight",
  general_health: "General Health",
};

export default function ProfilePage() {
  const userId = getUserId();

  // Profile data loaded from server
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state
  const [allergies, setAllergies] = useState<string[]>([]);
  const [medications, setMedications] = useState<string[]>([]);
  const [goalType, setGoalType] = useState<string>("");
  const [proteinTargetG, setProteinTargetG] = useState<string>("");
  const [kcalTarget, setKcalTarget] = useState<string>("");
  const [fatTargetG, setFatTargetG] = useState<string>("");
  const [carbsTargetG, setCarbsTargetG] = useState<string>("");
  const [heightCm, setHeightCm] = useState<string>("");
  const [weightKg, setWeightKg] = useState<string>("");

  // Feedback
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Load profile on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/profile?userId=${encodeURIComponent(userId)}`);
        if (!res.ok) throw new Error("Failed to load profile");
        const data = await res.json();
        if (cancelled) return;
        const p: UserProfile | null = data.profile;
        setProfile(p);
        if (p) {
          setAllergies([...p.allergies]);
          setMedications([...p.medications]);
          setGoalType(p.goalType ?? "");
          setProteinTargetG(p.proteinTargetG?.toString() ?? "");
          setKcalTarget(p.kcalTarget?.toString() ?? "");
          setFatTargetG(p.fatTargetG?.toString() ?? "");
          setCarbsTargetG(p.carbsTargetG?.toString() ?? "");
          setHeightCm(p.heightCm?.toString() ?? "");
          setWeightKg(p.weightKg?.toString() ?? "");
        }
      } catch {
        if (!cancelled) {
          setMessage({ type: "error", text: "Failed to load profile." });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [userId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    // Build the patch object — only include non-empty fields
    const patch: Record<string, unknown> = {};

    if (allergies.length > 0) patch.allergies = allergies;
    if (medications.length > 0) patch.medications = medications;
    if (goalType) patch.goalType = goalType;
    if (proteinTargetG !== "") patch.proteinTargetG = Number(proteinTargetG);
    if (kcalTarget !== "") patch.kcalTarget = Number(kcalTarget);
    if (fatTargetG !== "") patch.fatTargetG = Number(fatTargetG);
    if (carbsTargetG !== "") patch.carbsTargetG = Number(carbsTargetG);
    if (heightCm !== "") patch.heightCm = Number(heightCm);
    if (weightKg !== "") patch.weightKg = Number(weightKg);

    // Client-side validation
    const parsed = profileFormSchema.safeParse(patch);
    if (!parsed.success) {
      const messages = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      setMessage({ type: "error", text: messages });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({
          type: "error",
          text: data.details
            ? `Validation failed: ${data.details.map((d: { message: string }) => d.message).join(", ")}`
            : data.error ?? "Save failed",
        });
        return;
      }
      const updated: UserProfile = data.profile;
      setProfile(updated);
      // Re-sync form state with server result
      setAllergies([...updated.allergies]);
      setMedications([...updated.medications]);
      setGoalType(updated.goalType ?? "");
      setProteinTargetG(updated.proteinTargetG?.toString() ?? "");
      setKcalTarget(updated.kcalTarget?.toString() ?? "");
      setFatTargetG(updated.fatTargetG?.toString() ?? "");
      setCarbsTargetG(updated.carbsTargetG?.toString() ?? "");
      setHeightCm(updated.heightCm?.toString() ?? "");
      setWeightKg(updated.weightKg?.toString() ?? "");
      setMessage({ type: "success", text: "Profile saved." });
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading profile…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">
          Profile Settings
        </h1>
        <p className="mb-8 text-sm text-gray-500">
          Your dietary profile helps NutriBuddy give you personalised advice.
        </p>

        {message && (
          <div
            className={`mb-6 rounded-md px-4 py-3 text-sm ${
              message.type === "success"
                ? "bg-green-50 text-green-800"
                : "bg-red-50 text-red-800"
            }`}
            role="alert"
          >
            {message.text}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
        >
          {/* Allergies */}
          <TagInput
            label="Allergies"
            tags={allergies}
            onChange={setAllergies}
          />

          {/* Medications */}
          <TagInput
            label="Medications"
            tags={medications}
            onChange={setMedications}
          />

          {/* Goal Type */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Goal Type
            </label>
            <select
              value={goalType}
              onChange={(e) => setGoalType(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">— Select a goal —</option>
              {GOAL_TYPES.map((gt) => (
                <option key={gt} value={gt}>
                  {GOAL_LABELS[gt]}
                </option>
              ))}
            </select>
          </div>

          {/* Numeric fields — two-column grid */}
          <fieldset className="grid grid-cols-2 gap-4">
            <legend className="mb-2 text-sm font-medium text-gray-700">
              Nutrition Targets
            </legend>

            <NumField
              label="Protein (g/day)"
              value={proteinTargetG}
              onChange={setProteinTargetG}
              min={0}
              max={500}
              step={1}
            />
            <NumField
              label="Calories (kcal/day)"
              value={kcalTarget}
              onChange={setKcalTarget}
              min={0}
              max={10000}
              step={50}
            />
            <NumField
              label="Fat (g/day)"
              value={fatTargetG}
              onChange={setFatTargetG}
              min={0}
              max={500}
              step={1}
            />
            <NumField
              label="Carbs (g/day)"
              value={carbsTargetG}
              onChange={setCarbsTargetG}
              min={0}
              max={1000}
              step={1}
            />
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-4">
            <legend className="mb-2 text-sm font-medium text-gray-700">
              Body Metrics
            </legend>

            <NumField
              label="Height (cm)"
              value={heightCm}
              onChange={setHeightCm}
              min={50}
              max={300}
              step={0.1}
            />
            <NumField
              label="Weight (kg)"
              value={weightKg}
              onChange={setWeightKg}
              min={10}
              max={500}
              step={0.1}
            />
          </fieldset>

          {/* Submit */}
          <div className="flex items-center gap-4 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Profile"}
            </button>
            {profile && (
              <span className="text-xs text-gray-400">
                Last updated: {new Date(profile.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

/** Small reusable labelled number input. */
function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">
        {label}
      </label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        step={step}
        placeholder="—"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}
