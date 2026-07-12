"use client";

import { useState, useEffect, useCallback } from "react";
import { profileFormSchema, GOAL_TYPES } from "@/lib/profileValidation";
import type { GoalType } from "@/lib/profileValidation";
import type { UserProfile } from "@/lib/memoryStore";
import { useSupabaseSession, authHeader } from "@/lib/useSupabaseSession";

/** Minimal email+password sign-in / sign-up form (issue #65). */
function SignInForm({
  signIn,
  signUp,
}: {
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<string | null>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (action: "signIn" | "signUp") => {
      setBusy(true);
      setError(null);
      setNotice(null);
      const result =
        action === "signIn"
          ? await signIn(email, password)
          : await signUp(email, password);
      if (result) {
        setError(result);
      } else if (action === "signUp") {
        setNotice(
          "Account created. Check your inbox if email confirmation is enabled, then sign in.",
        );
      }
      setBusy(false);
    },
    [email, password, signIn, signUp],
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-gray-900">Sign in</h1>
        <p className="mb-6 text-sm text-gray-500">
          Your dietary profile is tied to your account.
        </p>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-700">
            {notice}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoComplete="current-password"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !email || !password}
              onClick={() => submit("signIn")}
              className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Sign in
            </button>
            <button
              type="button"
              disabled={busy || !email || !password}
              onClick={() => submit("signUp")}
              className="flex-1 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Create account
            </button>
          </div>
        </div>
      </div>
    </main>
  );
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
const GOAL_LABELS: Record<GoalType, string> = {
  weight_loss: "Weight Loss",
  muscle_gain: "Muscle Gain",
  maintain: "Maintain Weight",
  general_health: "General Health",
};

export default function ProfilePage() {
  const {
    session,
    loading: sessionLoading,
    configured,
    signIn,
    signUp,
    signOut,
  } = useSupabaseSession();

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

  /** Sync a UserProfile from the server into the local form state fields. */
  function applyProfileToForm(p: UserProfile) {
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

  // Load profile once signed in
  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/profile", {
          headers: authHeader(session),
        });
        if (!res.ok) throw new Error("Failed to load profile");
        const data = await res.json();
        if (cancelled) return;
        const p: UserProfile | null = data.profile;
        setProfile(p);
        if (p) applyProfileToForm(p);
      } catch {
        if (!cancelled) {
          setMessage({ type: "error", text: "Failed to load profile." });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // applyProfileToForm is stable in practice (plain setters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!session) {
      setMessage({ type: "error", text: "Please sign in first." });
      return;
    }

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
        headers: {
          "Content-Type": "application/json",
          ...authHeader(session),
        },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({
          type: "error",
          text: data.details
            ? `Validation failed: ${data.details.map((d: { message: string }) => d.message).join(", ")}`
            : (data.error ?? "Save failed"),
        });
        return;
      }
      const updated: UserProfile = data.profile;
      setProfile(updated);
      applyProfileToForm(updated);
      setMessage({ type: "success", text: "Profile saved." });
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  if (sessionLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  if (!configured) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">
          Supabase is not configured — profile settings are unavailable.
        </p>
      </main>
    );
  }

  if (!session) {
    return <SignInForm signIn={signIn} signUp={signUp} />;
  }

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
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            Profile Settings
          </h1>
          <button
            type="button"
            onClick={() => signOut()}
            className="text-sm text-gray-500 underline hover:text-gray-700"
          >
            Sign out ({session.user.email})
          </button>
        </div>
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
