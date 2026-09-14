// The interaction rules exist twice, and the two copies must agree (issue #125).
//
// The authoritative list is now the seed in `0015_drug_nutrient_interactions.sql`
// — that is what a deployed database reads, through the session client, for the
// gate's hard constraints. The eval cannot use it (the scripted arm is offline by
// design), so `src/eval/evalInteractions.ts` carries a fixture.
//
// Two copies of a safety rule set is a drift risk with a specific shape: the eval
// would keep passing while production refused different food, or the reverse. A
// test that parses the migration and compares is cheap, and it fails at the
// moment someone edits one side.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EVAL_INTERACTION_FIXTURE } from "../src/eval/evalInteractions";

interface SeededRule {
  readonly drug: string;
  readonly nutrient: string;
  readonly severity: string;
}

/** Parse the `values (...)` rows out of the migration's insert statement. */
export function seededRules(sql: string): readonly SeededRule[] {
  const statement = /insert into public\.drug_nutrient_interactions[\s\S]*?;/.exec(sql);
  if (!statement) throw new Error("no insert statement in the migration");

  const rows: SeededRule[] = [];
  const rowPattern =
    /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*array\[[^\]]*\]\s*,\s*'([^']+)'\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(statement[0])) !== null) {
    rows.push({ drug: match[1], nutrient: match[2], severity: match[3] });
  }
  return rows;
}

describe("interaction rule seed", () => {
  const sql = readFileSync("supabase/migrations/0015_drug_nutrient_interactions.sql", "utf8");
  const seeded = seededRules(sql);

  it("parses a non-trivial number of rules", () => {
    // Guards the parser itself: a regex that silently matched nothing would make
    // the comparison below vacuously true.
    expect(seeded.length).toBeGreaterThanOrEqual(8);
  });

  it("seeds the rules the eval fixture assumes", () => {
    for (const rule of EVAL_INTERACTION_FIXTURE) {
      const match = seeded.find(
        (candidate) =>
          candidate.drug === rule.drugName && candidate.nutrient === rule.nutrient,
      );
      expect(
        match,
        `${rule.drugName} + ${rule.nutrient} is in the eval fixture but not in the seed`,
      ).toBeDefined();
      expect(match?.severity).toBe(rule.severity);
    }
  });

  it("stores drug names in the normalised form the store matches on", () => {
    // Drug names only: `getInteractions` lowercases the profile's medications and
    // compares against this column, while the nutrient is display text — and
    // "vitamin K" is spelled with a capital K.
    for (const rule of seeded) {
      expect(rule.drug).toBe(rule.drug.trim().toLowerCase());
    }
    expect(seeded.some((rule) => rule.nutrient === "vitamin K")).toBe(true);
  });

  it("constrains severity to the values the TS union allows", () => {
    // `high` is the level that blocks; a typo would demote a hard rule to advice.
    expect(sql).toContain("check (severity in ('high', 'moderate', 'low'))");
    for (const rule of seeded) {
      expect(["high", "moderate", "low"]).toContain(rule.severity);
    }
  });

  it("requires a source for every rule, because a rule nobody can attribute cannot be audited", () => {
    expect(sql).toMatch(/source\s+text not null/);
  });

  it("is idempotent, so re-applying a corrected seed converges", () => {
    expect(sql).toContain("on conflict (drug_name, nutrient) do update");
  });

  it("keeps client access read-only", () => {
    expect(sql).toMatch(/revoke all on public\.drug_nutrient_interactions from anon, authenticated/);
    expect(sql).toMatch(/grant select on public\.drug_nutrient_interactions to authenticated/);
  });
});

// ── the README a new reader actually follows (S5 / #114) ──────────────────

describe("README", () => {
  const readme = readFileSync("README.md", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
    scripts: Record<string, string>;
  };

  it("has a version, so reports and traces can name the release", () => {
    // `appVersion` in a report and `turns.app_version` in a trace both read this;
    // "0.0.0-unversioned" was the honest answer until now.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("only quotes commands that exist", () => {
    const referenced = [...readme.matchAll(/`npm run ([a-z:]+)`/g)].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(3);
    for (const name of referenced) {
      expect(Object.keys(pkg.scripts), `README quotes a script that does not exist: ${name}`).toContain(name);
    }
  });

  it("states the three invariants the harness exists for", () => {
    expect(readme).toContain("三条不变量");
    expect(readme).toMatch(/数字只能来自目录事实/);
    expect(readme).toMatch(/实体只能由 resolver 铸造/);
    expect(readme).toMatch(/写入只能来自用户确认过的提案/);
  });

  it("says where the numbers come from, including that both arms get the same profile", () => {
    // The ablation's validity is the part a reader would otherwise have to trust.
    expect(readme).toContain("数字从哪来");
    expect(readme).toContain("两臂拿到相同的用户档案");
    expect(readme).toContain("不可比");
  });

  it("points at the architecture documents rather than restating them", () => {
    expect(readme).toContain("docs/ADD.md");
    expect(readme).toContain("docs/adr/");
  });

  it("carries the medical boundary", () => {
    expect(readme).toContain("不构成医疗建议");
  });
});
