import { describe, it, expect } from "vitest";
import { main } from "../src/cli";
import type { ModelAdapter } from "../src/harness/types";

function stubAdapter(content: string): ModelAdapter {
  return { generate: async () => ({ content, stop: true }) };
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
