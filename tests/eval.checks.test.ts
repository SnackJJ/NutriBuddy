import { describe, it, expect } from "vitest";
import {
  checkMustCallTools,
  checkShouldAskClarification,
  checkShouldBeBlocked,
} from "../src/eval/checks";

describe("checkMustCallTools", () => {
  it("returns empty array when all expected tools were called", () => {
    const missing = checkMustCallTools(
      ["search_food"],
      ["search_food", "log_meal"],
    );
    expect(missing).toEqual([]);
  });

  it("returns missing tools when some were not called", () => {
    const missing = checkMustCallTools(
      ["search_food", "log_meal"],
      ["search_food"],
    );
    expect(missing).toEqual(["log_meal"]);
  });

  it("returns all expected tools when nothing was called", () => {
    const missing = checkMustCallTools(["search_food", "log_meal"], []);
    expect(missing).toEqual(["search_food", "log_meal"]);
  });

  it("returns empty array when no tools are expected", () => {
    const missing = checkMustCallTools([], ["search_food"]);
    expect(missing).toEqual([]);
  });
});

describe("checkShouldAskClarification", () => {
  it("returns true when reply contains a question mark", () => {
    expect(checkShouldAskClarification("What kind of sandwich?")).toBe(true);
  });

  it("returns false when reply does not contain a question mark", () => {
    expect(
      checkShouldAskClarification("A sandwich has about 300 calories."),
    ).toBe(false);
  });

  it("returns false when reply is undefined", () => {
    expect(checkShouldAskClarification(undefined)).toBe(false);
  });

  it("returns false when reply is empty string", () => {
    expect(checkShouldAskClarification("")).toBe(false);
  });
});

describe("checkShouldBeBlocked", () => {
  it("returns true when blocked is true", () => {
    expect(checkShouldBeBlocked(true)).toBe(true);
  });

  it("returns false when blocked is false", () => {
    expect(checkShouldBeBlocked(false)).toBe(false);
  });
});
