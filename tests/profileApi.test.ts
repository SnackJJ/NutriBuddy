import { describe, it, expect } from "vitest";
import { handleGetProfile, handleUpdateProfile } from "../src/lib/profileApi";
import type { MemoryStore, UserProfile } from "../src/lib/memoryStore";

function profileForUser(
  userId: string,
  overrides: Partial<Omit<UserProfile, "userId">> = {},
): UserProfile {
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
    ...overrides,
  };
}

function fakeStore(profile?: UserProfile | null): MemoryStore {
  return {
    async getProfile(_userId: string) {
      return profile ?? null;
    },
    async updateProfile(userId: string, patch) {
      return {
        ...profileForUser(userId),
        ...patch,
      };
    },
  };
}

function statefulProfileStore(
  initialProfiles: readonly UserProfile[] = [],
): MemoryStore {
  const profiles = new Map(
    initialProfiles.map((profile) => [profile.userId, profile]),
  );

  return {
    async getProfile(userId: string) {
      return profiles.get(userId) ?? null;
    },
    async updateProfile(userId: string, patch) {
      const existing = profiles.get(userId) ?? profileForUser(userId);
      const updated: UserProfile = {
        ...existing,
        ...patch,
        updatedAt: "2026-06-26T00:00:02.000Z",
      };
      profiles.set(userId, updated);
      return updated;
    },
  };
}

describe("handleGetProfile", () => {
  it("returns a Response with the profile when found", async () => {
    const profile = profileForUser("user-1", {
      allergies: ["peanut"],
      goalType: "muscle_gain",
      proteinTargetG: 140,
      kcalTarget: 2500,
      fatTargetG: 70,
      carbsTargetG: 300,
      heightCm: 180,
      weightKg: 75,
      updatedAt: "2026-06-26T00:00:00.000Z",
    });
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
    const existing = profileForUser("user-1", {
      allergies: ["peanut"],
      medications: ["warfarin"],
      goalType: "maintain",
      proteinTargetG: 140,
      kcalTarget: 2500,
      fatTargetG: 70,
      carbsTargetG: 300,
      heightCm: 180,
      weightKg: 75,
      updatedAt: "2026-06-26T00:00:00.000Z",
    });

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
    const store = statefulProfileStore();

    const responseA = await handleUpdateProfile(
      "user-A",
      { allergies: ["peanut"] },
      store,
    );
    expect(responseA.status).toBe(200);
    const bodyA = await responseA.json();
    expect(bodyA.profile.allergies).toEqual(["peanut"]);

    const responseB = await handleUpdateProfile(
      "user-B",
      { allergies: ["shellfish"] },
      store,
    );
    expect(responseB.status).toBe(200);
    const bodyB = await responseB.json();
    expect(bodyB.profile.allergies).toEqual(["shellfish"]);

    const getA = await handleGetProfile("user-A", store);
    const profileA = await getA.json();
    expect(profileA.profile.allergies).toEqual(["peanut"]);
    expect(profileA.profile.userId).toBe("user-A");

    const getB = await handleGetProfile("user-B", store);
    const profileB = await getB.json();
    expect(profileB.profile.allergies).toEqual(["shellfish"]);
    expect(profileB.profile.userId).toBe("user-B");
  });

  it("reads only the profile for the supplied userId", async () => {
    const store = statefulProfileStore([
      profileForUser("user-A", {
        allergies: ["peanut"],
        medications: ["warfarin"],
        goalType: "general_health",
        proteinTargetG: 120,
        kcalTarget: 2000,
        fatTargetG: 60,
        carbsTargetG: 250,
        heightCm: 170,
        weightKg: 65,
        updatedAt: "2026-06-26T00:00:00.000Z",
      }),
    ]);

    const responseB = await handleGetProfile("user-B", store);
    const bodyB = await responseB.json();
    expect(bodyB.profile).toBeNull();

    const responseA = await handleGetProfile("user-A", store);
    const bodyA = await responseA.json();
    expect(bodyA.profile).not.toBeNull();
    expect(bodyA.profile.userId).toBe("user-A");
  });

  it("profile constraint writes go through Zod validation", async () => {
    const store = fakeStore();
    const invalidPatches: readonly unknown[] = [
      { goalType: "hack_the_planet" },
      { kcalTarget: -500 },
      { allergies: [""] },
    ];

    for (const patch of invalidPatches) {
      const response = await handleUpdateProfile("user-1", patch, store);
      expect(response.status).toBe(400);
    }

    const good = await handleUpdateProfile(
      "user-1",
      { goalType: "muscle_gain", proteinTargetG: 150 },
      store,
    );
    expect(good.status).toBe(200);
  });

  it("does not let the patch body override the handler userId", async () => {
    const store = fakeStore();

    const response = await handleUpdateProfile(
      "authenticated-user",
      { goalType: "weight_loss", userId: "evil-user" },
      store,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.userId).toBe("authenticated-user");
  });
});

// ── Route-level identity (issue #65) ─────────────────────────────────────

describe("profile route derives identity from the verified session", () => {
  it("never reads a client-asserted userId; requires the Authorization header", async () => {
    const fs = await import("node:fs");
    const routeSource = fs.readFileSync("app/api/profile/route.ts", "utf-8");

    expect(routeSource).toContain("getSessionFromHeader");
    expect(routeSource).not.toContain('searchParams.get("userId")');
    // The only userId mention strips it from the patch body
    expect(routeSource).not.toMatch(/userId.*required/i);
  });
});
