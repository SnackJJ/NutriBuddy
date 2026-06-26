import { describe, it, expect } from "vitest";
import { handleGetProfile, handleUpdateProfile } from "../src/lib/profileApi";
import type { MemoryStore, UserProfile } from "../src/lib/memoryStore";

function fakeStore(profile?: UserProfile | null): MemoryStore {
  return {
    async getProfile(_userId: string) {
      return profile ?? null;
    },
    async updateProfile(userId: string, patch) {
      return {
        userId,
        allergies: [],
        medications: [],
        goalType: null,
        proteinTargetG: null,
        kcalTarget: null,
        fatTargetG: null,
        carbsTargetG: null,
        heightCm: null,
        weightKg: null,
        createdAt: "2026-06-26T00:00:00.000Z",
        updatedAt: "2026-06-26T00:00:01.000Z",
        ...patch,
      };
    },
  };
}

describe("handleGetProfile", () => {
  it("returns a Response with the profile when found", async () => {
    const profile: UserProfile = {
      userId: "user-1",
      allergies: ["peanut"],
      medications: [],
      goalType: "muscle_gain",
      proteinTargetG: 140,
      kcalTarget: 2500,
      fatTargetG: 70,
      carbsTargetG: 300,
      heightCm: 180,
      weightKg: 75,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
    };
    const store = fakeStore(profile);

    const response = await handleGetProfile("user-1", store);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.profile).toEqual(profile);
  });

  it("returns a 200 with null profile when user has no profile yet", async () => {
    const store = fakeStore(null);
    const response = await handleGetProfile("new-user", store);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.profile).toBeNull();
  });
});

describe("handleUpdateProfile", () => {
  it("returns the updated profile on success", async () => {
    const store = fakeStore();
    const patch = { weightKg: 70, goalType: "maintain" };

    const response = await handleUpdateProfile("user-1", patch, store);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.profile.weightKg).toBe(70);
    expect(body.profile.goalType).toBe("maintain");
    expect(body.profile.userId).toBe("user-1");
  });

  it("returns 400 when validation fails (bad goalType)", async () => {
    const store = fakeStore();

    const response = await handleUpdateProfile(
      "user-1",
      { goalType: "invalid_goal" } as unknown as Record<string, unknown>,
      store,
    );
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when a numeric field is out of range", async () => {
    const store = fakeStore();

    const response = await handleUpdateProfile(
      "user-1",
      { proteinTargetG: 9999 },
      store,
    );
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when allergies contains empty strings", async () => {
    const store = fakeStore();

    const response = await handleUpdateProfile(
      "user-1",
      { allergies: ["peanut", ""] },
      store,
    );
    expect(response.status).toBe(400);
  });

  it("forwards store errors as 500", async () => {
    const brokenStore: MemoryStore = {
      async getProfile() {
        throw new Error("DB down");
      },
      async updateProfile() {
        throw new Error("DB down");
      },
    };

    const response = await handleUpdateProfile(
      "user-1",
      { weightKg: 70 },
      brokenStore,
    );
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("Internal server error");
  });

  it("preserves untouched fields when updating a partial patch", async () => {
    const existing: UserProfile = {
      userId: "user-1",
      allergies: ["peanut"],
      medications: ["warfarin"],
      goalType: "maintain",
      proteinTargetG: 140,
      kcalTarget: 2500,
      fatTargetG: 70,
      carbsTargetG: 300,
      heightCm: 180,
      weightKg: 75,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
    };

    const store: MemoryStore = {
      async getProfile() {
        return existing;
      },
      async updateProfile(_userId, patch) {
        // Simulate MemoryStore merge behavior
        return { ...existing, ...patch, updatedAt: "2026-06-26T00:00:01.000Z" };
      },
    };

    const response = await handleUpdateProfile(
      "user-1",
      { weightKg: 70 },
      store,
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    // Updated field
    expect(body.profile.weightKg).toBe(70);
    // Untouched fields preserved
    expect(body.profile.allergies).toEqual(["peanut"]);
    expect(body.profile.medications).toEqual(["warfarin"]);
    expect(body.profile.proteinTargetG).toBe(140);
  });
});
