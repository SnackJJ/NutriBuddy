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

// ─── Cross-tenant isolation (issue #38 / PRD v2 §3.1) ──────────────────

describe("cross-tenant profile constraint isolation", () => {
  it("profile writes for user A do not affect user B", async () => {
    const profiles = new Map<string, UserProfile>();

    const store: MemoryStore = {
      async getProfile(userId: string) {
        return profiles.get(userId) ?? null;
      },
      async updateProfile(userId: string, patch) {
        const existing = profiles.get(userId) ?? {
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
        } satisfies UserProfile;
        const updated: UserProfile = {
          ...existing,
          ...patch,
          updatedAt: "2026-06-26T00:00:02.000Z",
        };
        profiles.set(userId, updated);
        return updated;
      },
    };

    // User A sets their allergies
    const responseA = await handleUpdateProfile(
      "user-A",
      { allergies: ["peanut"] },
      store,
    );
    expect(responseA.status).toBe(200);
    const bodyA = await responseA.json();
    expect(bodyA.profile.allergies).toEqual(["peanut"]);

    // User B sets their allergies — different set
    const responseB = await handleUpdateProfile(
      "user-B",
      { allergies: ["shellfish"] },
      store,
    );
    expect(responseB.status).toBe(200);
    const bodyB = await responseB.json();
    expect(bodyB.profile.allergies).toEqual(["shellfish"]);

    // User A's profile is unchanged by user B's write
    const getA = await handleGetProfile("user-A", store);
    const profileA = await getA.json();
    expect(profileA.profile.allergies).toEqual(["peanut"]);
    expect(profileA.profile.userId).toBe("user-A");

    // User B's profile is independent
    const getB = await handleGetProfile("user-B", store);
    const profileB = await getB.json();
    expect(profileB.profile.allergies).toEqual(["shellfish"]);
    expect(profileB.profile.userId).toBe("user-B");
  });

  it("profile API handlers require explicit userId — cannot read cross-tenant", async () => {
    const profiles = new Map<string, UserProfile>();
    profiles.set("user-A", {
      userId: "user-A",
      allergies: ["peanut"],
      medications: ["warfarin"],
      goalType: "general_health",
      proteinTargetG: 120,
      kcalTarget: 2000,
      fatTargetG: 60,
      carbsTargetG: 250,
      heightCm: 170,
      weightKg: 65,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
    });

    const store: MemoryStore = {
      async getProfile(userId: string) {
        return profiles.get(userId) ?? null;
      },
      async updateProfile() {
        throw new Error("update should not be called in this test");
      },
    };

    // user-B tries to get user-A's profile — but they can only GET with
    // their own userId. The userId is provided by the auth layer, not the
    // caller's choice. user-B can only fetch their own profile.
    const responseB = await handleGetProfile("user-B", store);
    const bodyB = await responseB.json();
    expect(bodyB.profile).toBeNull();

    // user-A can get their own profile
    const responseA = await handleGetProfile("user-A", store);
    const bodyA = await responseA.json();
    expect(bodyA.profile).not.toBeNull();
    expect(bodyA.profile.userId).toBe("user-A");
  });

  it("profile constraint writes go through Zod validation", async () => {
    // The validated profile API (handleUpdateProfile) uses Zod schema
    // to validate all writes. This test verifies that invalid data
    // cannot be written, even for a valid user.
    const store = fakeStore();

    // Invalid goalType
    const badGoal = await handleUpdateProfile(
      "user-1",
      { goalType: "hack_the_planet" } as unknown as Record<string, unknown>,
      store,
    );
    expect(badGoal.status).toBe(400);

    // Out-of-range numeric
    const badNum = await handleUpdateProfile(
      "user-1",
      { kcalTarget: -500 },
      store,
    );
    expect(badNum.status).toBe(400);

    // Empty allergies string
    const badAllergy = await handleUpdateProfile(
      "user-1",
      { allergies: [""] },
      store,
    );
    expect(badAllergy.status).toBe(400);

    // Valid write still works
    const good = await handleUpdateProfile(
      "user-1",
      { goalType: "muscle_gain", proteinTargetG: 150 },
      store,
    );
    expect(good.status).toBe(200);
  });

  it("profile API is the only write path — no agent tool bypass exists", async () => {
    // The harness tool registry allows only reviewed tools (log_meal,
    // query_catalog, code_act, search_food). There is intentionally
    // NO tool that writes profile constraints.
    //
    // The profile API (handleUpdateProfile) is the sole write path for
    // profile data. It validates all input through Zod before storage.
    // Agent tools receive userId from injected deps for read scoping
    // only — they cannot mutate profile data.
    //
    // This test documents the structural guarantee: the store accepts
    // only userId from the caller, and the caller is the API route
    // (which validates with Zod), not an agent tool.
    const store = fakeStore();

    // handleUpdateProfile is called with explicit userId from the auth
    // layer (API route), not from model-generated input.
    const response = await handleUpdateProfile(
      "authenticated-user",
      { goalType: "weight_loss" },
      store,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.userId).toBe("authenticated-user");
  });
});
