import { describe, it, expect } from "vitest";
import { tokenize } from "../src/sanity";

// 脚手架冒烟测试：验证 vitest/tsc 管线本身能跑通。
// 实现 PRD 八模块时删除，换成真正的模块测试。
describe("tokenize", () => {
  it("splits on whitespace and drops empty tokens", () => {
    expect(tokenize("  eat   more  veg ")).toEqual(["eat", "more", "veg"]);
  });

  it("returns an empty array for a blank string", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});
