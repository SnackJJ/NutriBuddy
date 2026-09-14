// Privacy statement coverage (S5 / #115).
//
// The issue's DoD is documentation coverage, and the four things it names are the
// four things a reader cannot infer and would otherwise assume the friendly way:
// the 90-day trace retention, the provider's retention/training position with a
// link, what account deletion does and does not reach, and the non-medical
// boundary. Asserted on the pages rather than on the docs, because the pages are
// what a user is shown; the operator-facing version is checked for the same four.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const rawPage = readFileSync("app/privacy/page.tsx", "utf8");
const docs = readFileSync("docs/privacy.md", "utf8");

/**
 * The page's text with markup removed.
 *
 * Prose assertions have to run on text, not on source: a sentence broken by a
 * `<strong>` reads correctly to a user and fails a substring check, which is how a
 * documentation test becomes a test of tag placement.
 */
const page = rawPage
  .replace(/<[^>]+>/g, "")
  .replace(/\{\s*"\s*"\s*\}/g, "")
  .replace(/\s+/g, " ");

describe("privacy page (#115)", () => {
  it("states the 90-day trace retention as a number, not a placeholder", () => {
    expect(page).toMatch(/90\s*天/);
    expect(page).toContain("滚动删除");
  });

  it("says what leaves the server, and that deletion does not reach it", () => {
    expect(rawPage).toContain("data-provider-disclosure");
    expect(page).toMatch(/离开本项目的服务器/);
    expect(page).toMatch(/不会回溯清除供应商侧/);
  });

  it("links the provider terms it is describing", () => {
    expect(rawPage).toContain("deepseek-open-platform-terms-of-service.html");
    expect(rawPage).toContain("deepseek-privacy-policy.html");
    // The honest position: the terms make no retention promise for API traffic.
    expect(page).toMatch(/没有对 API 侧的保留期限给出承诺/);
    expect(page).toMatch(/也不做这方面的承诺/);
  });

  it("describes the deletion cascade and its limits", () => {
    expect(page).toContain("删除账号");
    expect(page).toMatch(/全部运行轨迹/);
    expect(page).toMatch(/公共数据/);
  });

  it("carries the non-medical boundary prominently", () => {
    expect(rawPage).toContain("data-non-medical");
    expect(page).toMatch(/不构成医疗建议/);
  });

  it("is reachable from the pages that need it", () => {
    expect(rawPage).toContain("metadata");
    expect(readFileSync("app/page.tsx", "utf8")).toContain('href="/privacy"');
    expect(readFileSync("src/components/DeleteAccountControl.tsx", "utf8")).toContain('href="/privacy"');
  });
});

describe("operator privacy document (#115)", () => {
  it("covers the same four points, with the storage layout", () => {
    expect(docs).toMatch(/90 天/);
    expect(docs).toMatch(/控制者/);
    expect(docs).toMatch(/删除账号/);
    expect(docs).toMatch(/非医疗建议/);
    expect(docs).toMatch(/中国境内/);
  });

  it("records the verification date, so a stale claim is visible as one", () => {
    expect(docs).toMatch(/最后核对：\d{4}-\d{2}-\d{2}/);
  });

  it("says what happens if the deployment switches model provider", () => {
    // A gateway's terms apply too, and "not recorded" is treated as "not checked".
    expect(docs).toMatch(/NUTRIBUDDY_MODEL_PROVIDER/);
    expect(docs).toMatch(/未记录即视为未核对/);
  });
});
