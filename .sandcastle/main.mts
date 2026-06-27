// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// The branch the orchestrator lives on and merges into. The host working tree
// must always be parked here between phases — see resetHostRepo() below.
const BASE_BRANCH = "main";
const repoRoot = process.cwd();

// Restore the host repo to a clean baseline, undoing side effects left by a
// previous run, a hard interrupt (kill -9), or an agent that bypassed its
// worktree and operated on the host .git directly:
//   - host HEAD drifted onto a sandcastle/* branch — this is what makes the
//     next createSandbox({branch}) fail with "already checked out in worktree
//     at <repoRoot>", because the host worktree isn't a managed worktree.
//   - leftover git locks from a killed process.
//   - dead worktree admin records under .git/worktrees.
// Stash is intentionally NOT touched — it may hold unmerged work and needs a
// human decision.
function resetHostRepo(reason: string): void {
  console.log(`[preflight] Resetting host repo to ${BASE_BRANCH} (${reason})`);
  for (const lock of [".git/index.lock", ".git/HEAD.lock"]) {
    rmSync(`${repoRoot}/${lock}`, { force: true });
  }
  try {
    execSync(`git checkout ${BASE_BRANCH}`, { cwd: repoRoot, stdio: "inherit" });
  } catch {
    // Residual changes on a drifted branch can block a plain checkout; force
    // back to the baseline (untracked files are preserved by checkout -f).
    execSync(`git checkout -f ${BASE_BRANCH}`, {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  execSync("git worktree prune", { cwd: repoRoot, stdio: "inherit" });
}

resetHostRepo("startup");

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Model selection: Claude Code model names are mapped to actual backend models
// via ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL env vars in .sandcastle/.env.
// Currently routing to DeepSeek (deepseek-v4-pro) — see .sandcastle/.env.
//
// Effort levels are set per-agent (not via global env) to avoid DeepSeek
// thinking-mode interference with structured output on simple tasks.

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// Per-agent model + effort configuration.
// Planner: high (deep analysis but no thinking-mode StructuredOutput issues)
// Implementer: max (deep reasoning for coding)
// Reviewer: high (thorough review without thinking-mode overhead)
// Merger: medium (straightforward merge + test)
const AGENT = {
  planner: sandcastle.claudeCode("claude-opus-4-8", { effort: "high" }),
  implementer: sandcastle.claudeCode("claude-opus-4-8", { effort: "max" }),
  reviewer: sandcastle.claudeCode("claude-opus-4-8", { effort: "high" }),
  merger: sandcastle.claudeCode("claude-opus-4-8", { effort: "medium" }),
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Re-baseline before every iteration: even if an agent polluted the host
  // working tree last round (e.g. left HEAD on a sandcastle/* branch), this
  // self-heals so this iteration's createSandbox({branch}) won't collide.
  resetHostRepo(`iteration ${iteration}`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent reads the open issue list, builds a dependency graph,
  // and selects the issues that can be worked in parallel right now (i.e., no
  // blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // On StructuredOutputError (e.g. DeepSeek thinking mode drops the <plan>
  // tag), retry up to 3 times with the same session so the agent re-emits.
  // -------------------------------------------------------------------------
  const MAX_PLAN_RETRIES = 3;

  const plan = await (async () => {
    let lastSessionId: string | undefined;

    for (let attempt = 0; attempt <= MAX_PLAN_RETRIES; attempt++) {
      try {
        const opts: sandcastle.RunOptions = {
          hooks,
          sandbox: docker(),
          name: "planner",
          maxIterations: 1,
          agent: AGENT.planner,
          promptFile: "./.sandcastle/plan-prompt.md",
          output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
        };
        if (lastSessionId) {
          opts.resumeSession = lastSessionId;
          opts.prompt =
            "Your previous output was missing the <plan> JSON block. " +
            "Re-read the issues, analyze dependencies, and output ONLY " +
            "the <plan> tag with the JSON array of unblocked issues.";
        }
        return await sandcastle.run(opts);
      } catch (error) {
        if (
          error instanceof sandcastle.StructuredOutputError &&
          error.tag === "plan" &&
          error.sessionId
        ) {
          lastSessionId = error.sessionId;
          if (attempt < MAX_PLAN_RETRIES) {
            console.log(
              `  Planner missing <plan> tag, retrying (${attempt + 1}/${MAX_PLAN_RETRIES})...`,
            );
            continue;
          }
        }
        throw error;
      }
    }
    throw new Error("Unreachable");
  })();

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker(),
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: AGENT.implementer,
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // Only review if the implementer produced commits
        if (implement.commits.length > 0) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: AGENT.reviewer,
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
            },
          });

          // Merge commits from both runs so the merge phase sees all of them.
          // Each sandbox.run() only returns commits from its own run.
          return {
            ...review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        return implement;
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    agent: AGENT.merger,
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
