import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { __testing as automation } from "../src/agscIssueAutomation.ts";
import type { AGSCProject } from "../src/agscWorkspace.ts";
import type { AGSCTrackedWorkflow } from "../src/agscState.ts";
import type { GitHubIssue, GitHubPullRequest } from "../src/githubApi.ts";

function withCodexWorktreesRoot<T>(rootPath: string, fn: () => T): T {
  const previous = process.env.AGSE_CODEX_WORKTREES_ROOT;
  process.env.AGSE_CODEX_WORKTREES_ROOT = rootPath;

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGSE_CODEX_WORKTREES_ROOT;
    } else {
      process.env.AGSE_CODEX_WORKTREES_ROOT = previous;
    }
  }
}

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 1001,
    number: 42,
    title: "Add tests for Codex handoff!",
    body: "The automation should keep polling and hand off to Codex.",
    html_url: "https://github.com/example/repo/issues/42",
    state: "open",
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    user: { login: "godbrigero" },
    assignees: [],
    labels: [],
    ...overrides,
  };
}

function pullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    id: 2001,
    number: 7,
    title: "Issue #42: Add tests for Codex handoff!",
    body: "## Issue\n\nCloses #42\n\nThe PR should carry the issue context.",
    html_url: "https://github.com/example/repo/pull/7",
    state: "open",
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    head: { ref: "agse/issue-42-add-tests-for-codex-handoff" },
    base: { ref: "main" },
    ...overrides,
  };
}

function project(config: AGSCProject["config"]): AGSCProject {
  return {
    name: "AGSE",
    rootPath: "/tmp/AGSE",
    config,
  } as AGSCProject;
}

function workflow(overrides: Partial<AGSCTrackedWorkflow> = {}): AGSCTrackedWorkflow {
  return {
    issueId: 1001,
    issueNumber: 42,
    issueTitle: "Add tests for Codex handoff!",
    issueUrl: "https://github.com/example/repo/issues/42",
    agent: "codex",
    worktreePath: automation.buildIssueWorktreePath("/tmp/AGSE", issue()),
    branchName: "agse/issue-42-add-tests-for-codex-handoff",
    pullNumber: 7,
    pullUrl: "https://github.com/example/repo/pull/7",
    pullState: "open",
    ...overrides,
  };
}

test("selectAgent routes labels using configured AGSC tags", () => {
  const agscProject = project({
    require_tag: true,
    overwrite_tags: {
      codex: "agse-codex",
      claude: "agse-claude",
      default: "agse",
    },
  });

  assert.equal(
    automation.selectAgent(
      agscProject,
      issue({ labels: [{ name: "agse-codex" }] }),
    ),
    "codex",
  );
  assert.equal(
    automation.selectAgent(
      agscProject,
      issue({ labels: [{ name: "agse-claude" }] }),
    ),
    "claude",
  );
  assert.equal(
    automation.selectAgent(agscProject, issue({ labels: [{ name: "agse" }] })),
    "codex",
  );
  assert.equal(automation.selectAgent(agscProject, issue()), null);
});

test("selectAgent supports assignee routing and untagged default mode", () => {
  assert.equal(
    automation.selectAgent(
      project({
        require_tag: true,
        assignee_tags: { denis: "claude", godbrigero: "default" },
      }),
      issue({ assignees: [{ login: "denis" }] }),
    ),
    "claude",
  );
  assert.equal(
    automation.selectAgent(
      project({ require_tag: false }),
      issue({ labels: [] }),
    ),
    "codex",
  );
});

test("isLocalIssue accepts either author or assignee as the local GitHub user", () => {
  assert.equal(automation.isLocalIssue(issue(), "godbrigero"), true);
  assert.equal(
    automation.isLocalIssue(
      issue({ user: { login: "someone-else" }, assignees: [{ login: "godbrigero" }] }),
      "godbrigero",
    ),
    true,
  );
  assert.equal(
    automation.isLocalIssue(
      issue({ user: { login: "someone-else" }, assignees: [{ login: "other" }] }),
      "godbrigero",
    ),
    false,
  );
  assert.equal(automation.isLocalIssue(issue(), null), false);
});

test("issue branch, worktree, and pull request title are stable and identifiable", () => {
  const sample = issue();

  assert.equal(
    automation.buildIssueBranchName(sample),
    "agse/issue-42-add-tests-for-codex-handoff",
  );
  withCodexWorktreesRoot("/tmp/codex-worktrees", () => {
    assert.match(
      automation.buildIssueWorktreePath("/repo", sample),
      /^\/tmp\/codex-worktrees\/[a-f0-9]{4}\/issue-42-add-tests-for-codex-handoff$/,
    );
  });
  assert.equal(
    automation.buildLegacyIssueWorktreePath("/repo", sample),
    join("/repo", ".agse", "worktrees", "issue-42-add-tests-for-codex-handoff"),
  );
  assert.equal(
    automation.buildPullRequestTitle(sample),
    "Issue #42: Add tests for Codex handoff!",
  );
});

test("Codex handoff instructions are implementation-oriented and include tracked context", () => {
  const instructions = automation.buildCodexHandoffInstructions(
    issue(),
    pullRequest(),
    workflow(),
  );

  assert.match(instructions, /Do not stop after summarizing or planning/);
  assert.match(instructions, /Issue description:\nThe automation should keep polling/);
  assert.match(instructions, /Pull request URL: https:\/\/github\.com\/example\/repo\/pull\/7/);
  assert.match(instructions, /Pull request description:\n## Issue\n\nCloses #42/);
  assert.match(instructions, /PR branch: agse\/issue-42-add-tests-for-codex-handoff/);
  assert.match(instructions, /Worktree: .*\/worktrees\/[a-f0-9]{4}\/issue-42/);
});

test("initial Codex handoff message starts with the exact PR title and includes full context", () => {
  const title = automation.buildPullRequestTitle(issue());
  const message = automation.buildCodexInitialHandoffMessage(
    title,
    issue(),
    pullRequest(),
    workflow(),
  );

  assert.equal(message.split("\n")[0], "Issue #42: Add tests for Codex handoff!");
  assert.match(message, /You are assigned this AGSC GitHub issue and pull request/);
  assert.match(message, /Issue description:\nThe automation should keep polling/);
  assert.match(message, /Pull request description:\n## Issue\n\nCloses #42/);
  assert.match(message, /Begin immediately\. Do not wait for another message\./);
});

test("planning prompt is read-only and requires a proposed plan block", () => {
  const message = automation.buildPlanningPrompt(
    issue(),
    pullRequest(),
    workflow(),
  );

  assert.match(message, /planning only/i);
  assert.match(message, /Do not edit files/);
  assert.match(message, /<proposed_plan>/);
  assert.match(message, /Worktree: .*\/worktrees\/[a-f0-9]{4}\/issue-42/);
});

test("planned PR body preserves issue source text and appends Codex plan", () => {
  const body = automation.buildPlannedPullRequestBody(
    issue(),
    "# Plan\n\n- Inspect\n- Implement",
  );

  assert.match(body, /## Issue\n\nCloses #42/);
  assert.match(body, /The automation should keep polling/);
  assert.match(body, /## Codex Plan\n\n# Plan/);
});

test("PR metadata can be embedded, parsed, stripped, and rebuilt from workflow state", () => {
  const sampleWorkflow = workflow({
    codexThreadId: "thread-1",
    codexImplementationTurnId: "turn-1",
    codexActiveTurnId: "turn-1",
    agentHandoffPhase: "implementing",
  });
  const metadata = automation.buildPullRequestMetadata(
    issue(),
    sampleWorkflow,
  );
  const body = automation.withPullRequestMetadata("## Body\n\nVisible", metadata);

  assert.match(body, /agsc:metadata/);
  assert.deepEqual(automation.parsePullRequestMetadata(body), metadata);
  assert.equal(automation.stripPullRequestMetadata(body), "## Body\n\nVisible");
  assert.deepEqual(
    automation.buildPullRequestMetadataFromWorkflow(sampleWorkflow),
    metadata,
  );
});

test("extractProposedPlan returns the proposed plan block when present", () => {
  assert.equal(
    automation.extractProposedPlan(
      "intro\n<proposed_plan>\n# Fix\n\n- Do it\n</proposed_plan>\noutro",
    ),
    "# Fix\n\n- Do it",
  );
  assert.equal(automation.extractProposedPlan("plain response"), "plain response");
});

test("Codex handoff git state requires clean pushed branch with real work commit", () => {
  assert.deepEqual(
    automation.buildCodexHandoffGitState({
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      hasWorkCommit: true,
      changedFileCount: 0,
      aheadCount: 0,
    }),
    {
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      hasWorkCommit: true,
      needsContinuation: false,
      summary: "branch has work commit, is clean, and is pushed",
    },
  );

  const dirty = automation.buildCodexHandoffGitState({
    hasUncommittedChanges: true,
    hasUnpushedCommits: false,
    hasWorkCommit: true,
    changedFileCount: 3,
    aheadCount: 0,
  });

  assert.equal(dirty.needsContinuation, true);
  assert.match(dirty.summary, /3 uncommitted file/);

  const starterOnly = automation.buildCodexHandoffGitState({
    hasUncommittedChanges: false,
    hasUnpushedCommits: false,
    hasWorkCommit: false,
    changedFileCount: 0,
    aheadCount: 0,
  });

  assert.equal(starterOnly.needsContinuation, true);
  assert.match(starterOnly.summary, /no non-starter work commit/);
});

test("Codex handoff workflows use executable local settings", () => {
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.sandbox, "danger-full-access");
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.approvalPolicy, "never");
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.experimentalApi, true);
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.useDaemonProxy, true);
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.useRemoteControlDaemon, false);
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.requireDaemonProxy, true);
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.useDesktopApp, true);
  assert.equal(automation.CODEX_HANDOFF_OPTIONS.requireDesktopApp, true);
});

test("Codex continuation message instructs the same thread to finish commit and push", () => {
  const message = automation.buildCodexContinuationMessage(
    issue(),
    workflow(),
    automation.buildCodexHandoffGitState({
      hasUncommittedChanges: true,
      hasUnpushedCommits: true,
      hasWorkCommit: true,
      changedFileCount: 2,
      aheadCount: 1,
    }),
  );

  assert.match(message, /Continue Issue #42: Add tests for Codex handoff!/);
  assert.match(message, /2 uncommitted file\(s\); 1 unpushed commit\(s\)/);
  assert.match(message, /run focused verification/);
  assert.match(message, /AGSC will commit and push them/);
  assert.match(message, /Only stop when the worktree is clean/);
});

test("Codex PR update message makes ordinary comments response-required and changes optional", () => {
  const message = automation.buildCodexPullRequestUpdateMessage(
    {
      summary: [
        "Comment by godbrigero at 2026-06-25T04:19:00Z:",
        "can you clarify why this path is safe?",
        "https://github.com/example/repo/pull/7#issuecomment-1",
      ].join("\n"),
      eventIds: ["comment:1"],
      issueCommentIds: [1],
      reviewCommentIds: [],
      hasResponseRequiredComments: true,
      hasRequiredReviewChanges: false,
    },
  );

  assert.match(message, /A tracked GitHub PR changed/);
  assert.match(message, /a response to each new comment is required/);
  assert.match(message, /Code changes for ordinary PR comments are optional/);
  assert.match(message, /can you clarify why this path is safe/);
  assert.doesNotMatch(message, /making the requested code changes is required/);
});

test("Codex PR update message requires changes for review feedback", () => {
  const message = automation.buildCodexPullRequestUpdateMessage(
    {
      summary: [
        "Review comment by godbrigero at 2026-06-25T04:19:00Z on src/app.ts:12:",
        "please add a regression test here",
        "https://github.com/example/repo/pull/7#discussion_r1",
      ].join("\n"),
      eventIds: ["review-comment:1"],
      issueCommentIds: [],
      reviewCommentIds: [1],
      hasResponseRequiredComments: false,
      hasRequiredReviewChanges: true,
    },
  );

  assert.match(message, /making the requested code changes is required/);
  assert.match(message, /run focused verification/);
  assert.match(message, /AGSC will commit and push them/);
  assert.match(message, /please add a regression test here/);
});

test("PR event helpers format events, merge ids, and ignore AGSC marker comments", () => {
  assert.equal(
    automation.isAGSCComment("<!-- agsc:implementation-complete -->\ndone"),
    true,
  );
  assert.equal(automation.isAGSCComment("human feedback"), false);
  assert.deepEqual(
    automation.mergeSyncedEventIds(
      ["comment:1"],
      ["comment:1", "review:2", "review-comment:3"],
    ),
    ["comment:1", "review:2", "review-comment:3"],
  );
  assert.match(
    automation.formatPullRequestComment({
      id: 1,
      body: "please add a test",
      html_url: "https://github.com/example/repo/pull/7#issuecomment-1",
      created_at: "2026-06-25T04:19:00Z",
      updated_at: "2026-06-25T04:20:00Z",
      user: { login: "godbrigero" },
    }),
    /Comment by godbrigero at 2026-06-25T04:20:00Z:\nplease add a test/,
  );
  assert.match(
    automation.formatPullRequestReviewComment({
      id: 3,
      body: "please handle the edge case",
      html_url: "https://github.com/example/repo/pull/7#discussion_r3",
      created_at: "2026-06-25T04:19:00Z",
      updated_at: "2026-06-25T04:20:00Z",
      path: "src/app.ts",
      line: 12,
      user: { login: "godbrigero" },
    }),
    /Review comment by godbrigero at 2026-06-25T04:20:00Z on src\/app\.ts:12:\nplease handle the edge case/,
  );
});

test("extractTurnStatus finds nested Codex turn status", () => {
  assert.equal(
    automation.extractTurnStatus(
      {
        thread: {
          turns: [
            { id: "turn-1", status: "completed" },
            { id: "turn-2", status: "inProgress" },
          ],
        },
      },
      "turn-2",
    ),
    "inProgress",
  );
  assert.equal(automation.extractTurnStatus({ thread: { turns: [] } }, "missing"), null);
});

test("implementation complete comment is marked so PR sync can ignore it", () => {
  const body = automation.buildImplementationCompleteComment(
    workflow({
      codexThreadId: "thread-1",
      codexImplementationTurnId: "turn-1",
    }),
  );

  assert.match(body, /agsc:implementation-complete/);
  assert.match(body, /Codex thread: thread-1/);
  assert.equal(automation.isAGSCComment(body), true);
});

test("Codex PR update git state requires feedback to produce a new pushed commit", () => {
  assert.deepEqual(
    automation.buildCodexPullRequestUpdateGitState({
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      hasWorkCommit: true,
      headChanged: true,
      changedFileCount: 0,
      aheadCount: 0,
    }),
    {
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      hasWorkCommit: true,
      headChanged: true,
      needsContinuation: false,
      summary: "feedback produced a new clean pushed commit",
    },
  );

  const noNewCommit = automation.buildCodexPullRequestUpdateGitState({
    hasUncommittedChanges: false,
    hasUnpushedCommits: false,
    hasWorkCommit: true,
    headChanged: false,
    changedFileCount: 0,
    aheadCount: 0,
  });

  assert.equal(noNewCommit.needsContinuation, true);
  assert.match(noNewCommit.summary, /did not advance after feedback/);
});

test("Codex PR update continuation asks for a new pushed feedback commit", () => {
  const message = automation.buildCodexPullRequestUpdateContinuationMessage(
    workflow(),
    automation.buildCodexPullRequestUpdateGitState({
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      hasWorkCommit: true,
      headChanged: false,
      changedFileCount: 0,
      aheadCount: 0,
    }),
  );

  assert.match(message, /Continue PR feedback for issue #42/);
  assert.match(message, /feedback was fully addressed/);
  assert.match(message, /AGSC will commit and push them/);
  assert.match(message, /new pushed commit/);
});

test("AGSC auto-commit messages identify handoff and PR feedback commits", () => {
  assert.equal(
    automation.buildCodexAutoCommitMessage(workflow(), "handoff"),
    "chore(agsc): address issue #42",
  );
  assert.equal(
    automation.buildCodexAutoCommitMessage(workflow(), "pull-request-update"),
    "chore(agsc): address PR feedback for issue #42",
  );
});

test("Codex recoverable steer errors are treated as fallback conditions", () => {
  assert.equal(
    automation.isRecoverableCodexSteerError(new Error("Codex app-server error -32600: no active turn to steer")),
    true,
  );
  assert.equal(
    automation.isRecoverableCodexSteerError(new Error("Invalid request: missing field `expectedTurnId`")),
    true,
  );
  assert.equal(
    automation.isRecoverableCodexSteerError(new Error("permission denied")),
    false,
  );
});

test("Codex missing thread errors are recognized narrowly", () => {
  assert.equal(
    automation.isMissingCodexThreadError(
      new Error("thread not found: 019f1816-2e85-7ee3-b3cd-c79a730396b7"),
    ),
    true,
  );
  assert.equal(
    automation.isMissingCodexThreadError(new Error("permission denied")),
    false,
  );
});

test("Codex thread availability distinguishes active archived and missing threads", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => ({
      async listChats(params: Record<string, unknown>) {
        calls.push(params);

        if (params.archived) {
          return { data: [{ id: "archived-thread" }] };
        }

        return { data: [{ id: "active-thread" }] };
      },
      close() {},
    }) as never,
  );

  try {
    assert.equal(
      await automation.findCodexThreadAvailability("/repo", "active-thread"),
      "active",
    );
    assert.equal(
      await automation.findCodexThreadAvailability("/repo", "archived-thread"),
      "archived",
    );
    assert.equal(
      await automation.findCodexThreadAvailability("/repo", "missing-thread"),
      "missing",
    );
    assert.deepEqual(
      calls.map((call) => call.archived),
      [false, false, true, false, true],
    );
  } finally {
    restoreFactory();
  }
});

test("Codex thread availability is unknown when validation fails", async () => {
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => ({
      async listChats() {
        throw new Error("daemon unavailable");
      },
      close() {},
    }) as never,
  );

  try {
    assert.equal(
      await automation.findCodexThreadAvailability("/repo", "thread-1"),
      "unknown",
    );
  } finally {
    restoreFactory();
  }
});

test("Codex turn ids can be read from completion notifications", () => {
  assert.equal(
    automation.extractNotificationTurnId({
      method: "turn/completed",
      params: { turnId: "turn-1" },
    }),
    "turn-1",
  );
  assert.equal(
    automation.extractNotificationTurnId({
      method: "turn/completed",
      params: { turn: { id: "turn-2" } },
    }),
    "turn-2",
  );
});

test("workflowNeedsAgentStart catches missing agent sessions", () => {
  assert.equal(automation.workflowNeedsAgentStart(workflow()), true);
  assert.equal(
    automation.workflowNeedsAgentStart(
      workflow({
        codexThreadId: "thread-1",
        agentHandoffVersion: automation.CODEX_HANDOFF_PROMPT_VERSION,
      }),
    ),
    false,
  );
  assert.equal(
    automation.workflowNeedsAgentStart(
      workflow({
        codexThreadId: "thread-1",
        agentHandoffVersion: automation.CODEX_HANDOFF_PROMPT_VERSION - 1,
      }),
    ),
    true,
  );
  assert.equal(
    automation.workflowNeedsAgentStart(
      workflow({ agent: "claude", claudeSessionId: "session-1" }),
    ),
    false,
  );
});

test("extractCodexThreadIds handles app-server list response shapes", () => {
  assert.deepEqual(
    automation.extractCodexThreadIds({
      data: [
        { id: "thread-a" },
        { sessionId: "thread-b" },
        { id: "thread-c", sessionId: "thread-c-alt" },
      ],
    }),
    new Set(["thread-a", "thread-b", "thread-c", "thread-c-alt"]),
  );
});
