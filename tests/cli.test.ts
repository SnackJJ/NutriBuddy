import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { main } from "../src/cli";
import type { ModelAdapter } from "../src/harness/types";
import { createFileStores } from "../src/lib/cliStores";

function stubAdapter(content: string): ModelAdapter {
  return { generate: async () => ({ content, stop: true }) };
}

function tmpStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-cli-"));
  return path.join(dir, "cli-state.json");
}

/** 两步 scripted adapter：先发 log_meal tool call，再交卷。 */
function logMealAdapter(): ModelAdapter {
  let calls = 0;
  return {
    generate: async () => {
      calls++;
      if (calls === 1) {
        return {
          content: "",
          stop: false,
          finishReason: "tool_calls" as const,
          toolCalls: [
            {
              id: "call-log-1",
              name: "log_meal",
              args: {
                food_name: "chicken breast",
                portion_g: 200,
                meal_type: "lunch",
              },
            },
          ],
        };
      }
      return { content: "Proposed logging your lunch.", stop: true };
    },
  };
}

async function seedProposal(stateFile: string): Promise<string> {
  const stores = createFileStores(stateFile);
  const proposal = await stores.proposalStore.store({
    userId: "cli-local-user",
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
  });
  return proposal.id;
}

describe("cli main", () => {
  it("accepts a positional user input, runs a turn, prints the reply to stdout", async () => {
    const out: string[] = [];
    const code = await main(["一个鸡蛋多少蛋白质？"], {
      adapter: stubAdapter("约 6 克蛋白质"),
      stdout: (s) => out.push(s),
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("约 6 克蛋白质");
  });

  it("prints the step-by-step trace to stderr when --trace is passed", async () => {
    const err: string[] = [];
    const code = await main(["--trace", "hi"], {
      adapter: stubAdapter("hello"),
      stdout: () => {},
      stderr: (s) => err.push(s),
    });

    expect(code).toBe(0);
    const text = err.join("");
    expect(text).toContain("trace");
    expect(text).toContain("user_input");
    expect(text).toContain("model_return");
  });

  it("does not print the trace to stderr when --trace is absent (trace is opt-in)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["hi"], {
      adapter: stubAdapter("hello"),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("hello");
    expect(err.join("")).toBe("");
  });

  it("reads the input from stdin when no positional arg is given", async () => {
    const out: string[] = [];
    const code = await main([], {
      adapter: stubAdapter("from-stdin-reply"),
      stdout: (s) => out.push(s),
      readStdin: async () => "  protein?  ",
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("from-stdin-reply");
  });

  it("returns usage exit code 2 and never builds an adapter when no input is given", async () => {
    const err: string[] = [];
    const code = await main([], {
      stderr: (s) => err.push(s),
      readStdin: async () => "",
    });

    expect(code).toBe(2);
    expect(err.join("")).toContain("用法");
  });
});

describe("cli tool path (issue #61)", () => {
  it("a log_meal turn ends in a write-proposal terminal and prints the proposal id", async () => {
    const stateFile = tmpStateFile();
    const out: string[] = [];

    const code = await main(["I ate 200g of chicken breast for lunch"], {
      adapter: logMealAdapter(),
      stdout: (s) => out.push(s),
      stateFilePath: stateFile,
    });

    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("[proposal] proposal-");
    expect(text).toContain("chicken breast — 200g (lunch)");
    expect(text).toContain("--confirm");

    // The proposal is persisted for a later --confirm invocation
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0].status).toBe("proposed");
    expect(state.proposals[0].userId).toBe("cli-local-user");
  });

  it("--confirm <id> --yes commits the proposal and appends to the meal ledger", async () => {
    const stateFile = tmpStateFile();
    const proposalId = await seedProposal(stateFile);
    const out: string[] = [];

    const code = await main(["--confirm", proposalId, "--yes"], {
      stdout: (s) => out.push(s),
      stateFilePath: stateFile,
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain(`Proposal ${proposalId} confirmed.`);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state.proposals[0].status).toBe("committed");
    expect(state.mealLogs).toHaveLength(1);
    expect(state.mealLogs[0].proposalId).toBe(proposalId);
    expect(state.mealLogs[0].foodName).toBe("chicken breast");
  });

  it("--confirm <id> --no voids the proposal without a ledger write", async () => {
    const stateFile = tmpStateFile();
    const proposalId = await seedProposal(stateFile);
    const out: string[] = [];

    const code = await main(["--confirm", proposalId, "--no"], {
      stdout: (s) => out.push(s),
      stateFilePath: stateFile,
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain(`Proposal ${proposalId} rejected.`);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state.proposals[0].status).toBe("voided");
    expect(state.mealLogs).toHaveLength(0);
  });

  it("--confirm without --yes/--no is a usage error", async () => {
    const err: string[] = [];
    const code = await main(["--confirm", "proposal-x"], {
      stderr: (s) => err.push(s),
    });

    expect(code).toBe(2);
    expect(err.join("")).toContain("用法");
  });
});
