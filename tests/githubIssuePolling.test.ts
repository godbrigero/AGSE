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

test("countIssuesOnly excludes PR pseudo-issues returned by the issues API", () => {
  const count = polling.countIssuesOnly([
    issue(1, 1, "2026-06-24T00:00:00Z", { pull_request: {} }),
  ]);

  assert.equal(count, 0);
});

test("selectPendingIssuesForAutomation skips closed workflow tombstones", () => {
  const pending = polling.selectPendingIssuesForAutomation(
    [
      issue(1, 1, "2026-06-24T00:00:00Z"),
      issue(2, 2, "2026-06-24T00:01:00Z"),
    ],
    new Set(),
    new Set(),
    new Set([1]),
  );

  assert.deepEqual(
    pending.map((entry) => entry.id),
    [2],
  );
});

test("selectPendingIssuesForAutomation limits work to the active issue scope", () => {
  const pending = polling.selectPendingIssuesForAutomation(
    [
      issue(1, 10, "2026-06-24T00:00:00Z", {
        title: "Pre-existing AGSE work",
      }),
      issue(2, 11, "2026-06-24T00:01:00Z", {
        title: "AGSE workflow verification 20260701T080921Z",
      }),
      issue(3, 12, "2026-06-24T00:02:00Z", {
        title: "Another AGSE workflow",
      }),
    ],
    new Set(),
    new Set(),
    new Set(),
    { titleIncludes: ["20260701T080921Z"] },
  );

  assert.deepEqual(
    pending.map((entry) => entry.number),
    [11],
  );
});

test("selectPendingIssuesForAutomation matches active issue numbers", () => {
  const pending = polling.selectPendingIssuesForAutomation(
    [
      issue(1, 10, "2026-06-24T00:00:00Z"),
      issue(2, 11, "2026-06-24T00:01:00Z"),
    ],
    new Set(),
    new Set(),
    new Set(),
    { issueNumbers: [10] },
  );

  assert.deepEqual(
    pending.map((entry) => entry.number),
    [10],
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

test("parseIssueScopeFromEnv reads active issue scope controls", () => {
  const scope = polling.parseIssueScopeFromEnv({
    AGSE_ACTIVE_ISSUE_NUMBERS: "60, 61",
    AGSE_ACTIVE_ISSUE_TITLE_INCLUDES: "AGSE workflow verification,20260701",
  });

  assert.deepEqual(scope, {
    issueNumbers: [60, 61],
    titleIncludes: ["AGSE workflow verification", "20260701"],
  });
  assert.equal(polling.issueScopeIsActive(scope), true);
});

test("parseIssueScopeFromEnv rejects invalid active issue numbers", () => {
  assert.throws(
    () =>
      polling.parseIssueScopeFromEnv({
        AGSE_ACTIVE_ISSUE_NUMBERS: "60,nope",
      }),
    /positive issue numbers/,
  );
});

test("runSerializedProjectPoll runs immediately when idle", async () => {
  const state = { isPolling: false, pollAgainRequested: false };
  let pollCount = 0;

  await polling.runSerializedProjectPoll(state, async () => {
    pollCount += 1;
  });

  assert.equal(pollCount, 1);
  assert.equal(state.isPolling, false);
  assert.equal(state.pollAgainRequested, false);
});

test("runSerializedProjectPoll coalesces overlapping requests into one follow-up poll", async () => {
  const state = { isPolling: false, pollAgainRequested: false };
  let pollCount = 0;
  let releaseFirstPoll: (() => void) | undefined;
  const firstPollBlocker = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });

  const firstPoll = polling.runSerializedProjectPoll(state, async () => {
    pollCount += 1;

    if (pollCount === 1) {
      await firstPollBlocker;
    }
  });

  await waitFor(() => state.isPolling);
  await polling.runSerializedProjectPoll(state, async () => {
    throw new Error("overlapping poll callback should not run");
  });
  await polling.runSerializedProjectPoll(state, async () => {
    throw new Error("second overlapping poll callback should not run");
  });

  assert.equal(pollCount, 1);
  assert.equal(state.pollAgainRequested, true);

  assert.ok(releaseFirstPoll);
  releaseFirstPoll();
  await firstPoll;

  assert.equal(pollCount, 2);
  assert.equal(state.isPolling, false);
  assert.equal(state.pollAgainRequested, false);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  assert.equal(predicate(), true);
}
