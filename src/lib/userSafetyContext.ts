// User safety context for turn assembly (allergies / medications + interaction store).
// Fail closed on load errors — never pretend the user has an empty safety profile.

import type { UserContext } from "@/harness/gate";
import type { InteractionStore } from "@/lib/drugInteractions";

export interface UserSafetyContextResult {
  readonly userContext: UserContext;
  readonly interactionStore: InteractionStore;
}

export interface UserSafetyContextDeps {
  readonly userId: string;
  readonly createMemoryStore: () => {
    getProfile: (userId: string) => Promise<{
      allergies: readonly string[];
      medications: readonly string[];
    } | null>;
  };
  readonly createInteractionStore: () => InteractionStore;
}

/**
 * Load allergies/medications for gate ports.
 * - No profile / empty safety fields → undefined (legitimate no-op).
 * - Store/network errors → throw (fail closed; callers must not swallow).
 * - When medications are present, preloads interaction rules so table failures
 *   surface before the NDJSON stream opens.
 */
export async function loadUserSafetyContext(
  deps: UserSafetyContextDeps,
): Promise<UserSafetyContextResult | undefined> {
  const store = deps.createMemoryStore();
  const profile = await store.getProfile(deps.userId);
  if (
    !profile ||
    (profile.allergies.length === 0 && profile.medications.length === 0)
  ) {
    return undefined;
  }
  const interactionStore = deps.createInteractionStore();
  if (profile.medications.length > 0) {
    // Fail closed before streaming: cache rules for this request.
    const rules = await interactionStore.all();
    return {
      userContext: {
        allergies: profile.allergies,
        medications: profile.medications,
      },
      interactionStore: {
        all: async () => rules,
      },
    };
  }
  return {
    userContext: {
      allergies: profile.allergies,
      medications: profile.medications,
    },
    interactionStore,
  };
}
