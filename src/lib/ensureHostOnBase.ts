import { execFileSync } from "node:child_process";

/**
 * Ensure the host repository is parked on the base branch before sandcastle
 * operations begin. Uses execFileSync to bypass the shell entirely, avoiding
 * word-splitting and command injection when the branch name comes from
 * configuration or environment variables.
 */
export function ensureHostOnBase(repoRoot: string, baseBranch: string): void {
  try {
    execFileSync("git", ["checkout", baseBranch], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    // Residual changes on a drifted branch can block a plain checkout; force
    // back to the baseline (untracked files are preserved by checkout -f).
    execFileSync("git", ["checkout", "-f", baseBranch], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
}
