import { test } from "node:test";
import assert from "node:assert/strict";
import { __testing as automation } from "../src/agscIssueAutomation.ts";

function gitWithWorktreeOutput(output: string) {
  return {
    async raw(args: string[]) {
      assert.deepEqual(args, ["worktree", "list", "--porcelain"]);
      return output;
    },
  };
}

test("findRegisteredWorktree matches an existing worktree by exact path", async () => {
  const found = await automation.findRegisteredWorktree(
    gitWithWorktreeOutput([
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.agse/worktrees/issue-3-add-testing",
      "HEAD def456",
      "branch refs/heads/agse/issue-3-add-testing",
      "",
    ].join("\n")) as never,
    "/repo/.agse/worktrees/issue-3-add-testing",
    "agse/issue-3-add-testing",
  );

  assert.deepEqual(found, {
    path: "/repo/.agse/worktrees/issue-3-add-testing",
    branch: "agse/issue-3-add-testing",
  });
});

test("findRegisteredWorktree detects stale branch registrations at another path", async () => {
  const found = await automation.findRegisteredWorktree(
    gitWithWorktreeOutput([
      "worktree /old/path/issue-3-add-testing",
      "HEAD def456",
      "branch refs/heads/agse/issue-3-add-testing",
      "",
    ].join("\n")) as never,
    "/repo/.agse/worktrees/issue-3-add-testing",
    "agse/issue-3-add-testing",
  );

  assert.deepEqual(found, {
    path: "/old/path/issue-3-add-testing",
    branch: "agse/issue-3-add-testing",
  });
});

test("findRegisteredWorktree returns null when neither path nor branch is registered", async () => {
  const found = await automation.findRegisteredWorktree(
    gitWithWorktreeOutput([
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
    ].join("\n")) as never,
    "/repo/.agse/worktrees/issue-3-add-testing",
    "agse/issue-3-add-testing",
  );

  assert.equal(found, null);
});
