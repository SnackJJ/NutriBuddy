// File-backed CLI stores (issue #61).
//
// 单进程 CLI 的本地持久化：proposals 与 meal ledger 存同一个 JSON 状态文件，
// 让 propose（一次进程）→ --confirm（下一次进程）跨进程存活。
// 与 Supabase 实现同一窄端口（ProposalStore / MealLogStore），错误消息对齐。

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ProposalStore,
  Proposal,
  ProposalInput,
  MealLogStore,
  MealLogEntry,
  MealLogInsert,
} from "../harness/logMeal";
import type { MealRecord } from "../catalog/queryCatalog";

interface CliState {
  proposals: Proposal[];
  mealLogs: MealLogEntry[];
}

function emptyState(): CliState {
  return { proposals: [], mealLogs: [] };
}

function readState(filePath: string): CliState {
  if (!fs.existsSync(filePath)) {
    return emptyState();
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Malformed CLI state file at ${filePath}`);
  }

  const state = parsed as Partial<CliState>;
  return {
    proposals: state.proposals ?? [],
    mealLogs: state.mealLogs ?? [],
  };
}

function writeState(filePath: string, state: CliState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export interface CliStores {
  readonly proposalStore: ProposalStore;
  readonly mealLogStore: MealLogStore;
  /** Ledger rows as query-runner MealRecords (feeds the in-memory runner). */
  listMealRecords(): MealRecord[];
}

/**
 * File-backed ProposalStore + MealLogStore sharing one JSON state file.
 *
 * Every mutation re-reads the file so successive CLI invocations see each
 * other's writes; the CLI is single-process so there is no concurrency.
 */
export function createFileStores(
  filePath: string,
  now: () => string = () => new Date().toISOString(),
): CliStores {
  const proposalStore: ProposalStore = {
    async store(params: ProposalInput): Promise<Proposal> {
      const state = readState(filePath);
      const proposal: Proposal = {
        ...params,
        id: `proposal-${randomUUID()}`,
        status: "proposed",
        createdAt: now(),
      };
      state.proposals.push(proposal);
      writeState(filePath, state);
      return proposal;
    },

    async get(id: string): Promise<Proposal | undefined> {
      return readState(filePath).proposals.find((p) => p.id === id);
    },

    async commit(id: string): Promise<Proposal> {
      return transition(id, "committed");
    },

    async decline(id: string): Promise<Proposal> {
      return transition(id, "voided");
    },
  };

  async function transition(
    id: string,
    status: "committed" | "voided",
  ): Promise<Proposal> {
    const state = readState(filePath);
    const index = state.proposals.findIndex(
      (p) => p.id === id && p.status === "proposed",
    );

    if (index < 0) {
      throw new Error(`Proposal ${id} not found or not in "proposed" status`);
    }

    const updated: Proposal = { ...state.proposals[index], status };
    state.proposals[index] = updated;
    writeState(filePath, state);
    return updated;
  }

  const mealLogStore: MealLogStore = {
    async insert(params: MealLogInsert): Promise<MealLogEntry> {
      const state = readState(filePath);
      const entry: MealLogEntry = {
        id: state.mealLogs.length + 1,
        userId: params.userId,
        foodName: params.foodName,
        portionG: params.portionG,
        mealType: params.mealType,
        loggedAt: now(),
        kcal: params.kcal,
        proteinG: params.proteinG,
        fatG: params.fatG,
        carbsG: params.carbsG,
        proposalId: params.proposalId,
        foodId: params.foodId,
        matchType: params.matchType,
        allergenTags: [...params.allergenTags],
      };
      state.mealLogs.push(entry);
      writeState(filePath, state);
      return entry;
    },
  };

  return {
    proposalStore,
    mealLogStore,
    listMealRecords(): MealRecord[] {
      return readState(filePath).mealLogs.map((entry) => ({
        userId: entry.userId,
        foodName: entry.foodName,
        portionG: entry.portionG,
        mealType: entry.mealType,
        loggedAt: entry.loggedAt,
        kcal: entry.kcal,
        proteinG: entry.proteinG,
        fatG: entry.fatG,
        carbsG: entry.carbsG,
      }));
    },
  };
}
