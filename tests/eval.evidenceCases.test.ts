// 依据题集（`src/eval/evidenceCases.ts`）的数据契约。
//
// 这些断言守的是"标注与语料一致"，不是某个函数：`pinned:in/out` 由这里从
// `sources/pinned.json` 重新计算后比对 —— 标注是缓存，钉住集才是依据。钉住集一旦
// 调整，这里会直接指出哪几条的 in/out 过期了，而不是让消融报告悄悄测错东西。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EVIDENCE_CASES } from "../src/eval/evidenceCases";
import { loadEvalCases } from "../src/eval/dataset";
import { loadCorpus } from "../src/evidence/corpus";

const corpus = loadCorpus();
const sectionIds = new Set(
  corpus.documents.flatMap((document) => document.sections.map((section) => section.id)),
);
// 直接读 pinned.json，而不是用 loadCorpus 算好的 `pinned` 字段：两条路径各算一遍，
// 其中一条漂了才看得出来。
const pinnedIds = new Set(
  (
    JSON.parse(readFileSync("sources/pinned.json", "utf8")) as {
      sections: readonly { sectionId: string }[];
    }
  ).sections.map((section) => section.sectionId),
);

function tagValues(tags: readonly string[] | undefined, prefix: string): string[] {
  return (tags ?? []).filter((tag) => tag.startsWith(`${prefix}:`)).map((tag) => tag.slice(prefix.length + 1));
}

describe("EVIDENCE_CASES", () => {
  it("has between 30 and 40 cases, each an evidence case that should cite", () => {
    expect(EVIDENCE_CASES.length).toBeGreaterThanOrEqual(30);
    expect(EVIDENCE_CASES.length).toBeLessThanOrEqual(40);
    for (const c of EVIDENCE_CASES) {
      expect(c.id).toMatch(/^ev\d{2}$/);
      expect(c.category).toBe("evidence");
      expect(c.expected.shouldCite).toBe(true);
      expect(c.expected.shouldBeBlocked).toBe(false);
      expect(c.userContext).toBeUndefined();
    }
  });

  it("names gold sections that exist in the corpus snapshot, and none of them a bibliography", () => {
    for (const c of EVIDENCE_CASES) {
      const gold = tagValues(c.tags, "gold");
      expect(gold.length, c.id).toBeGreaterThan(0);
      for (const id of gold) {
        expect(sectionIds.has(id), `${c.id}: ${id}`).toBe(true);
        expect(id.endsWith("-references"), `${c.id}: ${id}`).toBe(false);
      }
    }
  });

  it("tags exactly one source, and it is the document every gold section belongs to", () => {
    for (const c of EVIDENCE_CASES) {
      const sources = tagValues(c.tags, "source");
      expect(sources, c.id).toHaveLength(1);
      for (const id of tagValues(c.tags, "gold")) {
        expect(id.startsWith(`${sources[0]}#`), `${c.id}: ${id}`).toBe(true);
      }
    }
  });

  it("labels pinned:in / pinned:out the way pinned.json says, computed here", () => {
    const mismatches: string[] = [];
    for (const c of EVIDENCE_CASES) {
      const labels = tagValues(c.tags, "pinned");
      expect(labels, c.id).toHaveLength(1);
      // in = 任一 gold 段在钉住集里：只要有一段在，pinned 臂就能引到。
      const computed = tagValues(c.tags, "gold").some((id) => pinnedIds.has(id)) ? "in" : "out";
      if (labels[0] !== computed) mismatches.push(`${c.id}: tagged ${labels[0]}, pinned.json says ${computed}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("puts 40%–60% of cases outside the pinned set", () => {
    const out = EVIDENCE_CASES.filter((c) =>
      tagValues(c.tags, "gold").every((id) => !pinnedIds.has(id)),
    ).length;
    const share = out / EVIDENCE_CASES.length;
    expect(share).toBeGreaterThanOrEqual(0.4);
    expect(share).toBeLessThanOrEqual(0.6);
  });

  it("covers at least 8 sources", () => {
    const sources = new Set(EVIDENCE_CASES.flatMap((c) => tagValues(c.tags, "source")));
    expect(sources.size).toBeGreaterThanOrEqual(8);
  });

  it("does not ask for a number (numbers belong to the catalog)", () => {
    const numeric = /\bhow (much|many)\b|\bexact|\bprecise|\bmg\b|\bmcg\b|\bgrams?\b|\bIU\b|\bpercent/i;
    for (const c of EVIDENCE_CASES) {
      expect(numeric.test(c.query), `${c.id}: ${c.query}`).toBe(false);
    }
  });

  it("has ids and queries unique across every suite", () => {
    const all = loadEvalCases("all");
    const ids = all.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const queries = all.map((c) => c.query.toLowerCase());
    expect(new Set(queries).size).toBe(queries.length);
  });
});
