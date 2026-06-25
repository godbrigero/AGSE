import { test } from "node:test";
import assert from "node:assert/strict";
import { __testing as polling } from "../src/githubIssuePolling.ts";
import type { GitHubIssue } from "../src/githubApi.ts";

function issue(
  id: number,
  number: number,
  createdAt: string,
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    id,
    number,
    title: `Issue ${number}`,
    body: null,
    html_url: `https://github.com/example/repo/issues/${number}`,
    state: "open",
    created_at: createdAt,
    updated_at: createdAt,
    user: { login: "godbrigero" },
    assignees: [],
    labels: [],
    ...overrides,
  };
}

test("selectPendingIssuesForAutomation skips PR pseudo-issues, seen issues, and tracked issues", () => {
  const pending = polling.selectPendingIssuesForAutomation(
    [
      issue(1, 1, "2026-06-24T00:03:00Z"),
      issue(2, 2, "2026-06-24T00:02:00Z", { pull_request: {} }),
      issue(3, 3, "2026-06-24T00:01:00Z"),
      issue(4, 4, "2026-06-24T00:00:00Z"),
    ],
    new Set([3]),
    new Set([4]),
  );

  assert.deepEqual(
    pending.map((entry) => entry.id),
    [1],
  );
});

test("selectPendingIssuesForAutomation returns pending issues oldest first", () => {
  const pending = polling.selectPendingIssuesForAutomation(
    [
      issue(1, 1, "2026-06-24T00:03:00Z"),
      issue(2, 2, "2026-06-24T00:01:00Z"),
      issue(3, 3, "2026-06-24T00:02:00Z"),
    ],
    new Set(),
    new Set(),
  );

  assert.deepEqual(
    pending.map((entry) => entry.id),
    [2, 3, 1],
  );
});
