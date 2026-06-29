import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { ensureHostOnBase } from "../src/lib/ensureHostOnBase";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("ensureHostOnBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses execFileSync to bypass shell entirely (not string interpolation)", () => {
    ensureHostOnBase("/tmp/repo", "main");

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    // First arg must be a plain string "git", not "git checkout ..."
    expect(mockedExecFileSync.mock.calls[0]![0]).toBe("git");
    // Second arg must be an array of arguments
    expect(mockedExecFileSync.mock.calls[0]![1]).toEqual(["checkout", "main"]);
    expect(mockedExecFileSync.mock.calls[0]![2]).toMatchObject({
      cwd: "/tmp/repo",
      stdio: "inherit",
    });
  });

  it("preserves branch names with spaces (no shell word-splitting)", () => {
    ensureHostOnBase("/repo", "feature/my branch");

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const args = mockedExecFileSync.mock.calls[0]![1];
    expect(Array.isArray(args)).toBe(true);
    // Branch with spaces must be a single array element, not split
    expect(args).toContain("feature/my branch");
  });

  it("falls back to force checkout when plain checkout throws", () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("checkout failed");
    });

    ensureHostOnBase("/tmp/repo", "stale-branch");

    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockedExecFileSync.mock.calls[0]![1]).toEqual([
      "checkout",
      "stale-branch",
    ]);
    expect(mockedExecFileSync.mock.calls[1]![1]).toEqual([
      "checkout",
      "-f",
      "stale-branch",
    ]);
  });

  it("does not catch errors from force checkout (surface real failures)", () => {
    mockedExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("plain checkout failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("force checkout also failed");
      });

    expect(() => ensureHostOnBase("/repo", "broken")).toThrow(
      "force checkout also failed",
    );
  });
});
