import { describe, it, expect } from "vitest";
import {
  createMemoryStore,
  rowToProfile,
  profileToRow,
  type ProfileGateway,
  type ProfileRow,
} from "../src/lib/memoryStore";

// 内存版 append-only gateway：忠实复刻「关闭旧行 + 追加新行」的双时态行为，
// 让 store 的合并 / 历史保留逻辑可在不触网的情况下端到端验证。
function fakeGateway(): ProfileGateway & { rows: ProfileRow[] } {
  const rows: ProfileRow[] = [];
  return {
    rows,
    async current(userId) {
      return (
        rows.find((r) => r.userId === userId && r.validTo === null) ?? null
      );
    },
    async close(userId, validTo) {
      const open = rows.find((r) => r.userId === userId && r.validTo === null);
      if (open) {
        const idx = rows.indexOf(open);
        rows[idx] = { ...open, validTo };
      }
    },
    async append(row) {
      rows.push(row);
      return row;
    },
  };
}

// 递增时钟：让 createdAt / updatedAt 可区分、断言可读。
function fakeClock(start = 0): () => string {
  let n = start;
  return () => `2026-06-26T00:00:0${n++}.000Z`;
}

describe("MemoryStore.getProfile", () => {
  it("returns null when the user has no profile yet", async () => {
    const store = createMemoryStore({ gateway: fakeGateway() });
    expect(await store.getProfile("u1")).toBeNull();
  });

  it("returns the current effective profile via a deterministic query", async () => {
    const gateway = fakeGateway();
    const store = createMemoryStore({ gateway, now: fakeClock() });
    await store.updateProfile("u1", {
      allergies: ["peanut"],
      proteinTargetG: 140,
    });

    const profile = await store.getProfile("u1");
    expect(profile?.userId).toBe("u1");
    expect(profile?.allergies).toEqual(["peanut"]);
    expect(profile?.proteinTargetG).toBe(140);
  });
});

describe("MemoryStore.updateProfile", () => {
  it("creates the first version when no profile exists, defaulting arrays to empty", async () => {
    const gateway = fakeGateway();
    const store = createMemoryStore({ gateway, now: fakeClock() });

    const created = await store.updateProfile("u1", { goalType: "cut" });

    expect(created.goalType).toBe("cut");
    expect(created.allergies).toEqual([]);
    expect(created.medications).toEqual([]);
    expect(created.createdAt).toBe(created.updatedAt);
    // 恰好一行、且为当前有效行
    expect(gateway.rows).toHaveLength(1);
    expect(gateway.rows[0].validTo).toBeNull();
  });

  it("merges a partial patch onto the current profile, leaving untouched fields intact", async () => {
    const gateway = fakeGateway();
    const store = createMemoryStore({ gateway, now: fakeClock() });
    await store.updateProfile("u1", {
      allergies: ["peanut"],
      proteinTargetG: 140,
    });

    const updated = await store.updateProfile("u1", { weightKg: 70 });

    expect(updated.weightKg).toBe(70);
    expect(updated.allergies).toEqual(["peanut"]); // 未在 patch 中 → 保留
    expect(updated.proteinTargetG).toBe(140);
  });

  it("preserves the old value as a closed history row (bitemporal versioning)", async () => {
    const gateway = fakeGateway();
    const store = createMemoryStore({ gateway, now: fakeClock() });
    await store.updateProfile("u1", { weightKg: 72 });
    await store.updateProfile("u1", { weightKg: 70 });

    // 两行：一行旧（已关闭）、一行新（当前有效）
    expect(gateway.rows).toHaveLength(2);
    const open = gateway.rows.filter((r) => r.validTo === null);
    const closed = gateway.rows.filter((r) => r.validTo !== null);
    expect(open).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(open[0].weightKg).toBe(70);
    expect(closed[0].weightKg).toBe(72); // 历史值仍可查
    // 新行的 valid_from 即旧行的 valid_to：版本区间首尾相接
    expect(open[0].validFrom).toBe(closed[0].validTo);
  });

  it("keeps createdAt stable across updates but bumps updatedAt", async () => {
    const gateway = fakeGateway();
    const store = createMemoryStore({ gateway, now: fakeClock() });
    const first = await store.updateProfile("u1", { weightKg: 72 });
    const second = await store.updateProfile("u1", { weightKg: 70 });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });
});

describe("row <-> profile mapping", () => {
  it("round-trips snake_case DB rows and camelCase domain profiles", () => {
    const row: ProfileRow = {
      userId: "u1",
      allergies: ["peanut"],
      medications: ["warfarin"],
      goalType: "cut",
      proteinTargetG: 140,
      kcalTarget: 2000,
      fatTargetG: 60,
      carbsTargetG: 200,
      heightCm: 180,
      weightKg: 70,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:01.000Z",
      validFrom: "2026-06-26T00:00:01.000Z",
      validTo: null,
    };

    const dbRow = profileToRow(row);
    expect(dbRow.user_id).toBe("u1");
    expect(dbRow.protein_target_g).toBe(140);
    expect(dbRow.valid_to).toBeNull();

    expect(rowToProfile(dbRow)).toEqual(row);
  });
});
