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

  it("returns userContext + interactionStore when profile has safety fields", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      allergies: ["peanut"],
      medications: ["warfarin"],
    });
    const interactionStore = { all: vi.fn() };
    const result = await loadUserSafetyContext({
      userId: "user-1",
      createMemoryStore: () => ({ getProfile }),
      createInteractionStore: () => interactionStore,
    });

    expect(result).toEqual({
      userContext: {
        allergies: ["peanut"],
        medications: ["warfarin"],
      },
      interactionStore,
    });
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
