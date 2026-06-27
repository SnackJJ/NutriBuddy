# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# GIT BOUNDARY — DO NOT CROSS

You are already checked out on the correct branch `{{BRANCH}}` inside an
isolated worktree. The repository's branch management is owned by the
orchestrator, NOT by you. Therefore:

- DO NOT run `git checkout`, `git switch`, `git branch`, `git reset`,
  `git merge`, `git rebase`, `git stash`, or `git worktree` (add/remove/prune).
- DO NOT set `GIT_DIR`, `GIT_WORK_TREE`, `--git-dir`, or `--work-tree`, and do
  not write anything under `.git/` (including `.git/worktrees/...`).
- The ONLY git commands you may run are read-only inspection (`git status`,
  `git log`, `git diff`, `git show`) plus `git add` and `git commit` for your
  own changes.
- If git reports the worktree is broken or missing (e.g. "fatal: not a git
  repository", "worktree administrative directory is missing"), STOP
  immediately. Do not try to repair, rebuild, or work around it. Report the
  failure on the issue and exit. Attempting to fix git state corrupts the
  shared host repository and breaks other parallel agents.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
