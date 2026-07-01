import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubIssuePoller,
  __testing as polling,
} from "../src/githubIssuePolling.ts";
import type { AGSCProject, AGSCWorkspace } from "../src/agscWorkspace.ts";
import type {
  GitHubIssue,
  GitHubRepositoryRef,
  GitHubUser,
} from "../src/githubApi.ts";
import type { GitHubWebhookRelayEvent } from "../src/githubWebhookRelay.ts";

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

test("selectWebhookSyncTarget maps issue and PR webhook payloads", () => {
  assert.deepEqual(
    polling.selectWebhookSyncTarget({
      eventName: "issues",
      deliveryId: "delivery-1",
      body: { issue: { number: 42 } },
    }),
    { kind: "issue", issueNumber: 42 },
  );
  assert.deepEqual(
    polling.selectWebhookSyncTarget({
      eventName: "issue_comment",
      deliveryId: "delivery-2",
      body: { issue: { number: 7, pull_request: {} } },
    }),
    { kind: "pull", pullNumber: 7 },
  );
  assert.deepEqual(
    polling.selectWebhookSyncTarget({
      eventName: "pull_request_review_comment",
      deliveryId: "delivery-3",
      body: { pull_request: { number: 9 } },
    }),
    { kind: "pull", pullNumber: 9 },
  );
  assert.equal(
    polling.selectWebhookSyncTarget({
      eventName: "pull_request",
      deliveryId: "delivery-4",
      body: {},
    }),
    null,
  );
});

test("issues webhook syncs the targeted issue without a full poll", async () => {
  const fixture = await createPollerFixture();

  try {
    fixture.github.issues.set(
      42,
      issue(1001, 42, "2026-06-24T00:00:00Z"),
    );

    await fixture.handleWebhookEvent({
      eventName: "issues",
      deliveryId: "delivery-1",
      body: { issue: { number: 42 } },
    });

    assert.deepEqual(fixture.github.getIssueNumbers, [42]);
    assert.deepEqual(fixture.handledIssueNumbers, [42]);
    assert.equal(fixture.github.listRecentIssuesCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("PR webhook syncs the targeted tracked PR without a full poll", async () => {
  const fixture = await createPollerFixture();

  try {
    await fixture.handleWebhookEvent({
      eventName: "issue_comment",
      deliveryId: "delivery-1",
      body: { issue: { number: 7, pull_request: {} } },
    });

    assert.deepEqual(fixture.syncedPullNumbers, [7]);
    assert.equal(fixture.github.listRecentIssuesCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("webhook sync falls back to a full poll when the target is ambiguous", async () => {
  const fixture = await createPollerFixture();

  try {
    await fixture.handleWebhookEvent({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      body: {},
    });

    assert.equal(fixture.fullSyncRecoveries, 1);
    assert.equal(fixture.fullSyncs, 1);
    assert.equal(fixture.github.listRecentIssuesCalls, 1);
  } finally {
    await fixture.cleanup();
  }
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
  let followUpPollCount = 0;
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
    followUpPollCount += 1;
  });
  await polling.runSerializedProjectPoll(state, async () => {
    followUpPollCount += 1;
  });

  assert.equal(pollCount, 1);
  assert.equal(followUpPollCount, 0);
  assert.equal(state.pollAgainRequested, true);

  assert.ok(releaseFirstPoll);
  releaseFirstPoll();
  await firstPoll;

  assert.equal(pollCount, 1);
  assert.equal(followUpPollCount, 1);
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

type PollerFixture = {
  github: FakePollerGitHub;
  handledIssueNumbers: number[];
  syncedPullNumbers: number[];
  fullSyncRecoveries: number;
  fullSyncs: number;
  handleWebhookEvent(event: GitHubWebhookRelayEvent): Promise<void>;
  cleanup(): Promise<void>;
};

async function createPollerFixture(): Promise<PollerFixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "agse-poller-"));
  const github = new FakePollerGitHub();
  const handledIssueNumbers: number[] = [];
  const syncedPullNumbers: number[] = [];
  let fullSyncRecoveries = 0;
  let fullSyncs = 0;
  const project = {
    rootPath,
    name: "repo",
    config: {},
    git: {
      git: {
        remote: async () => "https://github.com/org/repo.git",
      },
    },
  } as unknown as AGSCProject;
  const workspace = {
    projects: [project],
  } as unknown as AGSCWorkspace;
  const poller = await GitHubIssuePoller.fromWorkspace(workspace, {
    token: "token-1",
    github: github as never,
    handleIssueForProject: async (input) => {
      handledIssueNumbers.push(input.issue.number);
      return { status: "tracked", workflow: {} as never };
    },
    recoverTrackedPullRequests: async () => {
      fullSyncRecoveries += 1;
      return [];
    },
    syncTrackedPullRequests: async () => {
      fullSyncs += 1;
    },
    syncTrackedPullRequestByNumber: async (
      _project,
      _repository,
      _github,
      pullNumber,
    ) => {
      syncedPullNumbers.push(pullNumber);
      return true;
    },
  });
  const runtimePoller = poller as unknown as {
    states: unknown[];
    handleWebhookEvent: (
      state: unknown,
      event: GitHubWebhookRelayEvent,
    ) => Promise<void>;
  };

  return {
    github,
    handledIssueNumbers,
    syncedPullNumbers,
    get fullSyncRecoveries() {
      return fullSyncRecoveries;
    },
    get fullSyncs() {
      return fullSyncs;
    },
    async handleWebhookEvent(event) {
      await runtimePoller.handleWebhookEvent(runtimePoller.states[0], event);
    },
    async cleanup() {
      await rm(rootPath, { recursive: true, force: true });
    },
  };
}

class FakePollerGitHub {
  issues = new Map<number, GitHubIssue>();
  getIssueNumbers: number[] = [];
  listRecentIssuesCalls = 0;

  async getAuthenticatedUser(): Promise<GitHubUser> {
    return { login: "godbrigero" };
  }

  async getIssue(
    _repository: GitHubRepositoryRef,
    issueNumber: number,
  ): Promise<GitHubIssue> {
    this.getIssueNumbers.push(issueNumber);
    const foundIssue = this.issues.get(issueNumber);

    assert.ok(foundIssue);
    return foundIssue;
  }

  async listRecentIssues(): Promise<GitHubIssue[]> {
    this.listRecentIssuesCalls += 1;
    return [];
  }
}
