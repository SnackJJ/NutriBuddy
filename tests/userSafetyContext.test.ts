import { describe, expect, it, vi } from "vitest";
import { loadUserSafetyContext } from "../src/lib/userSafetyContext";

describe("loadUserSafetyContext", () => {
  it("returns undefined when profile has no allergies or medications", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      allergies: [],
      medications: [],
    });
    const createStore = () => ({ getProfile });
    const createInteractionStore = vi.fn();

    const result = await loadUserSafetyContext({
      userId: "user-1",
      createMemoryStore: createStore,
      createInteractionStore,
    });

    expect(result).toBeUndefined();
    expect(createInteractionStore).not.toHaveBeenCalled();
  });

  it("returns userContext + preloaded interactionStore when profile has meds", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      allergies: ["peanut"],
      medications: ["warfarin"],
    });
    const rules = [
      {
        drugName: "warfarin",
        nutrient: "vitamin K",
        foodExamples: ["spinach"],
        severity: "high" as const,
        source: "NIH",
      },
    ];
    const all = vi.fn().mockResolvedValue(rules);
    const result = await loadUserSafetyContext({
      userId: "user-1",
      createMemoryStore: () => ({ getProfile }),
      createInteractionStore: () => ({ all }),
    });

    expect(all).toHaveBeenCalledOnce();
    expect(result?.userContext).toEqual({
      allergies: ["peanut"],
      medications: ["warfarin"],
    });
    // Subsequent all() uses the preloaded cache, not another network call.
    await expect(result?.interactionStore.all()).resolves.toEqual(rules);
    expect(all).toHaveBeenCalledOnce();
  });

  it("fails closed when interaction table preload throws", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      allergies: [],
      medications: ["warfarin"],
    });
    const all = vi.fn().mockRejectedValue(new Error("interactions down"));

    await expect(
      loadUserSafetyContext({
        userId: "user-1",
        createMemoryStore: () => ({ getProfile }),
        createInteractionStore: () => ({ all }),
      }),
    ).rejects.toThrow(/interactions down/);
  });

  it("fails closed: rethrows when profile loading throws (never silent empty)", async () => {
    const getProfile = vi.fn().mockRejectedValue(new Error("db down"));

    await expect(
      loadUserSafetyContext({
        userId: "user-1",
        createMemoryStore: () => ({ getProfile }),
        createInteractionStore: () => ({ all: vi.fn() }),
      }),
    ).rejects.toThrow(/db down/);
  });
});
