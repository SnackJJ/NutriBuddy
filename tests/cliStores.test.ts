// CLI file-backed store ownership collapse (issue #74 / RFC §1.1).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFileStores } from "../src/lib/cliStores";
import type { ProposalInput } from "../src/harness/logMeal";

function tmpStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-cli-stores-"));
  return path.join(dir, "cli-state.json");
}

function sampleInput(userId: string): ProposalInput {
  return {
    userId,
    foodId: "food-chicken-breast-001",
    foodName: "chicken breast",
    canonicalName: "chicken breast",
    portionG: 200,
    mealType: "lunch",
    kcal: 330,
    proteinG: 62,
    fatG: 7.2,
    carbsG: 0,
    nutritionSource: "usda-sr-legacy-2026-07-v1",
    matchType: "exact",
    allergenTags: [],
  };
}

describe("createFileStores ownership collapse (issue #74)", () => {
  it("commits a same-user proposed row and inserts a meal", async () => {
    const file = tmpStateFile();
    const stores = createFileStores(file, { userId: "user-a" });
    const proposal = await stores.proposalStore.store(sampleInput("user-a"));

    const result = await stores.proposalStore.commitProposalAndInsertMeal(
      proposal.id,
    );

    expect(result).toEqual({
      kind: "committed",
      proposalId: proposal.id,
      mealLogId: 1,
    });
    expect(stores.listMealRecords()).toHaveLength(1);
  });

  it("returns not_committable for wrong-owner proposed rows (no meal)", async () => {
    const file = tmpStateFile();
    // Shared file, but store bound to user-a.
    const writer = createFileStores(file, { userId: "user-b" });
    const foreign = await writer.proposalStore.store(sampleInput("user-b"));

    const boundA = createFileStores(file, { userId: "user-a" });
    const result = await boundA.proposalStore.commitProposalAndInsertMeal(
      foreign.id,
    );

    expect(result).toEqual({ kind: "not_committable" });
    expect(boundA.listMealRecords()).toHaveLength(0);
    // Foreign proposal still proposed.
    const reloaded = await boundA.proposalStore.get(foreign.id);
    expect(reloaded?.status).toBe("proposed");
  });

  it("voids only same-user proposed rows", async () => {
    const file = tmpStateFile();
    const owner = createFileStores(file, { userId: "user-a" });
    const proposal = await owner.proposalStore.store(sampleInput("user-a"));

    const other = createFileStores(file, { userId: "user-b" });
    expect(await other.proposalStore.voidProposal(proposal.id)).toEqual({
      kind: "not_committable",
    });

    expect(await owner.proposalStore.voidProposal(proposal.id)).toEqual({
      kind: "voided",
      proposalId: proposal.id,
    });
  });

  it("returns not_committable for missing and non-proposed ids", async () => {
    const file = tmpStateFile();
    const stores = createFileStores(file, { userId: "user-a" });
    const proposal = await stores.proposalStore.store(sampleInput("user-a"));
    await stores.proposalStore.commitProposalAndInsertMeal(proposal.id);

    expect(
      await stores.proposalStore.commitProposalAndInsertMeal(proposal.id),
    ).toEqual({ kind: "not_committable" });
    expect(
      await stores.proposalStore.commitProposalAndInsertMeal("missing"),
    ).toEqual({ kind: "not_committable" });
  });
});
