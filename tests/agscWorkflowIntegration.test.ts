import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import {
  handleGitHubIssueForProject,
  recoverTrackedPullRequests,
  syncTrackedPullRequests,
  __testing as automation,
} from "../src/agscIssueAutomation.ts";
import { AGSCStateStore } from "../src/agscState.ts";
import type { AGSCProject } from "../src/agscWorkspace.ts";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubRepositoryRef,
} from "../src/githubApi.ts";
import type { CodexWorkflows } from "../src/codexIntegration/index.ts";

const execFileAsync = promisify(execFile);
const repository: GitHubRepositoryRef = { owner: "example", repo: "agse" };

test("issue automation creates PR chat, updates PR with plan, and starts detached implementation", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const registeredCodexRoots: Array<Record<string, unknown>> = [];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    (rootPath) => {
      codex.rootPaths.push(rootPath);
      return codex as unknown as CodexWorkflows;
    },
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(
    async (input) => {
      registeredCodexRoots.push(input);
    },
  );

  try {
    const result = await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });

    assert.equal(result.status, "tracked");
    await waitFor(async () =>
      Boolean(github.pullRequest?.body?.includes("## Codex Plan")),
    );
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    assert.equal(github.pullRequest?.title, "Issue #42: Test AGSE workflow");
    assert.equal(github.issue.state, "closed");
    assert.match(github.pullRequest?.body ?? "", /Closes #42/);
    assert.match(github.pullRequest?.body ?? "", /# Workflow Plan/);
    assert.equal(codex.startedChats.length, 1);
    assert.equal(codex.startedChats[0]?.cwd, result.workflow.worktreePath);
    assert.equal(codex.startedChats[0]?.desktopApp, true);
    assert.equal(codex.startedChats[0]?.requireDesktopApp, true);
    assert.equal(codex.startedChats[0]?.title, "Issue #42: Test AGSE workflow");
    assert.deepEqual(codex.startedChats[0]?.input, []);
    assert.deepEqual(codex.startedChats[0]?.workspaceRoots, [
      result.workflow.worktreePath,
    ]);
    assert.deepEqual(codex.startedChats[0]?.runtimeWorkspaceRoots, [
      result.workflow.worktreePath,
    ]);
    assert.deepEqual(codex.rootPaths, [
      automation.buildIssueWorktreePath(fixture.project.rootPath, github.issue),
    ]);
    assert.deepEqual(
      registeredCodexRoots,
      [
        {
          rootPath: automation.buildIssueWorktreePath(
            fixture.project.rootPath,
            github.issue,
          ),
          parentRootPath: fixture.project.rootPath,
          label: "Issue #42: Test AGSE workflow",
          threadId: undefined,
        },
        {
          rootPath: automation.buildIssueWorktreePath(
            fixture.project.rootPath,
            github.issue,
          ),
          parentRootPath: fixture.project.rootPath,
          label: "Issue #42: Test AGSE workflow",
          threadId: "thread-1",
        },
        {
          rootPath: automation.buildIssueWorktreePath(
            fixture.project.rootPath,
            github.issue,
          ),
          parentRootPath: fixture.project.rootPath,
          label: "Issue #42: Test AGSE workflow",
          threadId: "thread-1",
        },
      ],
    );
    assert.equal(codex.closeCount, 0);
    assert.deepEqual(codex.renamedThreads, [
      { threadId: "thread-1", title: "Issue #42: Test AGSE workflow" },
    ]);
    assert.deepEqual(github.issueReactions, [
      { issueNumber: 7, content: "eyes" },
    ]);
    assert.match(codex.messages[0] ?? "", /planning only/i);
    assert.match(codex.detachedMessages[0] ?? "", /Now execute the plan/);

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    const workflow = state.workflows[0];

    assert.equal(workflow.codexThreadId, "thread-1");
    assert.equal(workflow.codexPlanningTurnId, "plan-turn-1");
    assert.equal(workflow.codexImplementationTurnId, "impl-turn-1");
    assert.equal(workflow.codexActiveTurnId, "impl-turn-1");
    assert.equal(workflow.agentHandoffPhase, "implementing");
    assert.equal(typeof workflow.issueClosedByAGSCAt, "string");
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("PR planning eyes reaction failure does not block Codex implementation", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    github.failNextIssueReaction = true;
    const result = await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });

    assert.equal(result.status, "tracked");
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    assert.deepEqual(github.issueReactions, []);
    assert.match(codex.messages[0] ?? "", /planning only/i);
    assert.match(codex.detachedMessages[0] ?? "", /Now execute the plan/);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("issue automation registers worktree before background chat and re-registers with thread", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const events: string[] = [];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(
    async (input) => {
      events.push(`register:${input.threadId ?? "none"}`);
    },
  );

  codex.onStartChat = () => events.push("start-chat");

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () =>
      Boolean(github.pullRequest?.body?.includes("## Codex Plan")),
    );

    assert.deepEqual(events.slice(0, 5), [
      "register:none",
      "start-chat",
      "register:thread-1",
      "register:thread-1",
    ]);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("sync keeps an open PR when the issue was closed by AGSC", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue({ state: "closed" }));
  const codex = new FakeCodex();
  const branchName = automation.buildIssueBranchName(github.issue);
  const worktreePath = join(
    automation.resolveCodexWorktreesRoot(),
    "agsc-closed-issue",
    "repo",
  );
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );

  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "origin/main"],
      { cwd: fixture.project.rootPath },
    );
    github.pullRequest = pullRequestForIssue(github.issue, {
      head: { ref: branchName },
    });
    await new AGSCStateStore(fixture.project.rootPath).upsertWorkflow({
      issueId: github.issue.id,
      issueNumber: github.issue.number,
      issueTitle: github.issue.title,
      issueUrl: github.issue.html_url,
      agent: "codex",
      worktreePath,
      branchName,
      pullNumber: 7,
      pullUrl: "https://github.com/example/agse/pull/7",
      pullState: "open",
      codexThreadId: "thread-1",
      agentHandoffVersion: automation.CODEX_HANDOFF_PROMPT_VERSION,
      issueClosedByAGSCAt: "2026-06-26T00:00:02Z",
    });

    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.equal(state.workflows[0]?.issueId, github.issue.id);
    await stat(worktreePath);
  } finally {
    restoreFactory();
    await fixture.cleanup();
  }
});

test("PR comments are routed into the existing active Codex turn once per event", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () =>
      Boolean(github.pullRequest?.body?.includes("## Codex Plan")),
    );
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    const previousPullUpdatedAt = github.pullRequest?.updated_at;
    github.addHumanComment("please add one more workflow assertion");
    if (github.pullRequest && previousPullUpdatedAt) {
      github.pullRequest = {
        ...github.pullRequest,
        updated_at: previousPullUpdatedAt,
      };
    }
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.deepEqual(codex.steeredMessages, [
      {
        threadId: "thread-1",
        expectedTurnId: "impl-turn-1",
        input: "please add one more workflow assertion",
      },
    ]);
    assert.deepEqual(github.commentReactions, [
      { commentId: 501, content: "eyes" },
    ]);

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.deepEqual(state.workflows[0]?.syncedPrEventIds, ["comment:501"]);

    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );
    assert.equal(codex.steeredMessages.length, 1);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("PR comments are retried when eyes reaction fails", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () =>
      Boolean(github.pullRequest?.body?.includes("## Codex Plan")),
    );
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    github.addHumanComment("please add one more workflow assertion");
    github.failNextReaction = true;
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    let state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.deepEqual(state.workflows[0]?.syncedPrEventIds, undefined);

    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.deepEqual(state.workflows[0]?.syncedPrEventIds, ["comment:501"]);
    assert.deepEqual(github.commentReactions, [
      { commentId: 501, content: "eyes" },
    ]);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("archived Codex PR thread is unarchived and reused for PR comments", async () => {
  automation.closeAllCodexHandoffs();
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const registeredCodexRoots: Array<Record<string, unknown>> = [];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(
    async (input) => {
      registeredCodexRoots.push(input);
    },
  );

  try {
    github.pullRequest = pullRequestForIssue(github.issue);
    codex.archivedThreadIds.add("thread-1");
    codex.detachedStartedTurnIds.push("impl-turn-1");
    await new AGSCStateStore(fixture.project.rootPath).upsertWorkflow({
      issueId: github.issue.id,
      issueNumber: github.issue.number,
      issueTitle: github.issue.title,
      issueUrl: github.issue.html_url,
      agent: "codex",
      worktreePath: automation.buildIssueWorktreePath(
        fixture.project.rootPath,
        github.issue,
      ),
      branchName: automation.buildIssueBranchName(github.issue),
      pullNumber: 7,
      pullUrl: "https://github.com/example/agse/pull/7",
      pullState: "open",
      codexThreadId: "thread-1",
      codexImplementationTurnId: "impl-turn-1",
      codexActiveTurnId: "impl-turn-1",
      agentHandoffVersion: automation.CODEX_HANDOFF_PROMPT_VERSION,
      agentHandoffPhase: "implementing",
      lastPullUpdatedAt: github.pullRequest.updated_at,
    });

    github.addHumanComment("please add one more workflow assertion");
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.deepEqual(codex.unarchivedThreads, ["thread-1"]);
    assert.deepEqual(codex.steeredMessages, [
      {
        threadId: "thread-1",
        expectedTurnId: "impl-turn-1",
        input: "please add one more workflow assertion",
      },
    ]);
    assert.deepEqual(github.commentReactions, [
      { commentId: 501, content: "eyes" },
    ]);
    assert.equal(codex.startedChats.length, 0);
    assert.deepEqual(registeredCodexRoots, [
      {
        rootPath: automation.buildIssueWorktreePath(
          fixture.project.rootPath,
          github.issue,
        ),
        parentRootPath: fixture.project.rootPath,
        label: "Issue #42: Test AGSE workflow",
        threadId: "thread-1",
      },
    ]);

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.deepEqual(state.workflows[0]?.syncedPrEventIds, ["comment:501"]);
    assert.equal(state.workflows[0]?.codexThreadId, "thread-1");
  } finally {
    automation.closeAllCodexHandoffs();
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("missing Codex PR thread restarts without acknowledging PR comments", async () => {
  automation.closeAllCodexHandoffs();
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    github.pullRequest = pullRequestForIssue(github.issue);
    codex.knownThreadIds.delete("missing-thread");
    await new AGSCStateStore(fixture.project.rootPath).upsertWorkflow({
      issueId: github.issue.id,
      issueNumber: github.issue.number,
      issueTitle: github.issue.title,
      issueUrl: github.issue.html_url,
      agent: "codex",
      worktreePath: automation.buildIssueWorktreePath(
        fixture.project.rootPath,
        github.issue,
      ),
      branchName: automation.buildIssueBranchName(github.issue),
      pullNumber: 7,
      pullUrl: "https://github.com/example/agse/pull/7",
      pullState: "open",
      codexThreadId: "missing-thread",
      codexImplementationTurnId: "impl-turn-1",
      codexActiveTurnId: "impl-turn-1",
      agentHandoffVersion: automation.CODEX_HANDOFF_PROMPT_VERSION,
      agentHandoffPhase: "implementing",
      lastPullUpdatedAt: github.pullRequest.updated_at,
    });

    github.addHumanComment("please add one more workflow assertion");
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.equal(codex.startedChats.length, 1);
    assert.deepEqual(codex.steeredMessages, []);
    assert.deepEqual(github.commentReactions, []);

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.equal(state.workflows[0]?.syncedPrEventIds, undefined);
  } finally {
    automation.closeAllCodexHandoffs();
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("legacy AGSC worktrees are moved to the Codex worktree root", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const legacyWorktreePath = automation.buildLegacyIssueWorktreePath(
    fixture.project.rootPath,
    github.issue,
  );
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await execFileAsync(
      "git",
      [
        "worktree",
        "add",
        "-B",
        automation.buildIssueBranchName(github.issue),
        legacyWorktreePath,
        "origin/main",
      ],
      { cwd: fixture.project.rootPath },
    );

    const result = await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });

    assert.equal(result.status, "tracked");
    assert.notEqual(result.workflow.worktreePath, legacyWorktreePath);
    assert.match(result.workflow.worktreePath, /\/codex-worktrees\/[a-f0-9]{4}\//);
    await stat(result.workflow.worktreePath);
    await assert.rejects(stat(legacyWorktreePath), /ENOENT/);
    assert.equal(codex.startedChats[0]?.cwd, result.workflow.worktreePath);
    assert.equal(codex.startedChats[0]?.desktopApp, true);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("sync migrates already tracked legacy worktrees and restarts Codex chat", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const legacyWorktreePath = automation.buildLegacyIssueWorktreePath(
    fixture.project.rootPath,
    github.issue,
  );
  const branchName = automation.buildIssueBranchName(github.issue);
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, legacyWorktreePath, "origin/main"],
      { cwd: fixture.project.rootPath },
    );
    github.pullRequest = {
      id: 2001,
      number: 7,
      title: "Issue #42: Test AGSE workflow",
      body: automation.buildInitialPullRequestBody(github.issue),
      html_url: "https://github.com/example/agse/pull/7",
      state: "open",
      created_at: "2026-06-26T00:00:01Z",
      updated_at: "2026-06-26T00:00:01Z",
      head: { ref: branchName },
      base: { ref: "main" },
    };
    await new AGSCStateStore(fixture.project.rootPath).upsertWorkflow({
      issueId: github.issue.id,
      issueNumber: github.issue.number,
      issueTitle: github.issue.title,
      issueUrl: github.issue.html_url,
      agent: "codex",
      worktreePath: legacyWorktreePath,
      branchName,
      pullNumber: 7,
      pullUrl: "https://github.com/example/agse/pull/7",
      pullState: "open",
      codexThreadId: "old-thread",
      agentHandoffVersion: automation.CODEX_HANDOFF_PROMPT_VERSION,
      lastPullUpdatedAt: github.pullRequest.updated_at,
    });

    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexThreadId === "thread-1";
    });

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    const migrated = state.workflows[0];
    assert.ok(migrated);
    assert.notEqual(migrated.worktreePath, legacyWorktreePath);
    assert.match(migrated.worktreePath, /\/codex-worktrees\/[a-f0-9]{4}\//);
    assert.equal(codex.startedChats[0]?.cwd, migrated.worktreePath);
    assert.equal(codex.startedChats[0]?.desktopApp, true);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("sync removes Codex worktree when tracked PR is closed", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const unregisteredCodexRoots: Array<Record<string, unknown>> = [];
  const scrubbedCodexRoots: string[] = [];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreUnregistrar = automation.setCodexWorkspaceRootUnregistrar(
    async (input) => {
      unregisteredCodexRoots.push(input);
    },
  );
  const restoreScrubber = automation.setCodexWorkspaceRootScrubber(async () => {
    scrubbedCodexRoots.push("scrubbed");
    return [];
  });
  const branchName = automation.buildIssueBranchName(github.issue);
  const worktreePath = join(
    automation.resolveCodexWorktreesRoot(),
    "closed-pr",
    "repo",
  );

  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "origin/main"],
      { cwd: fixture.project.rootPath },
    );
    github.pullRequest = pullRequestForIssue(github.issue, {
      state: "closed",
      head: { ref: branchName },
    });
    await new AGSCStateStore(fixture.project.rootPath).upsertWorkflow({
      issueId: github.issue.id,
      issueNumber: github.issue.number,
      issueTitle: github.issue.title,
      issueUrl: github.issue.html_url,
      agent: "codex",
      worktreePath,
      branchName,
      pullNumber: 7,
      pullUrl: "https://github.com/example/agse/pull/7",
      pullState: "open",
      codexThreadId: "thread-1",
    });

    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.deepEqual(state.workflows, []);
    assert.deepEqual(unregisteredCodexRoots, [
      {
        rootPath: worktreePath,
        threadId: "thread-1",
      },
    ]);
    assert.deepEqual(codex.archivedThreads, ["thread-1"]);
    assert.deepEqual(codex.deletedThreads, ["thread-1"]);
    assert.deepEqual(scrubbedCodexRoots, ["scrubbed"]);
    await assert.rejects(stat(worktreePath), /ENOENT/);
    await assert.rejects(stat(dirname(worktreePath)), /ENOENT/);
  } finally {
    restoreScrubber();
    restoreUnregistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("sync removes Codex worktree when tracked issue is closed", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue({ state: "closed" }));
  const codex = new FakeCodex();
  const unregisteredCodexRoots: Array<Record<string, unknown>> = [];
  const scrubbedCodexRoots: string[] = [];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreUnregistrar = automation.setCodexWorkspaceRootUnregistrar(
    async (input) => {
      unregisteredCodexRoots.push(input);
    },
  );
  const restoreScrubber = automation.setCodexWorkspaceRootScrubber(async () => {
    scrubbedCodexRoots.push("scrubbed");
    return [];
  });
  const branchName = automation.buildIssueBranchName(github.issue);
  const worktreePath = join(
    automation.resolveCodexWorktreesRoot(),
    "closed-issue",
    "repo",
  );

  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "origin/main"],
      { cwd: fixture.project.rootPath },
    );
    github.pullRequest = pullRequestForIssue(github.issue, {
      head: { ref: branchName },
    });
    await new AGSCStateStore(fixture.project.rootPath).upsertWorkflow({
      issueId: github.issue.id,
      issueNumber: github.issue.number,
      issueTitle: github.issue.title,
      issueUrl: github.issue.html_url,
      agent: "codex",
      worktreePath,
      branchName,
      pullNumber: 7,
      pullUrl: "https://github.com/example/agse/pull/7",
      pullState: "open",
      codexThreadId: "thread-1",
    });

    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.deepEqual(state.workflows, []);
    assert.deepEqual(unregisteredCodexRoots, [
      {
        rootPath: worktreePath,
        threadId: "thread-1",
      },
    ]);
    assert.deepEqual(codex.archivedThreads, ["thread-1"]);
    assert.deepEqual(codex.deletedThreads, ["thread-1"]);
    assert.deepEqual(scrubbedCodexRoots, ["scrubbed"]);
    await assert.rejects(stat(worktreePath), /ENOENT/);
    await assert.rejects(stat(dirname(worktreePath)), /ENOENT/);
  } finally {
    restoreScrubber();
    restoreUnregistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("recovery fetches a remote PR branch before adding its worktree", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const branchName = automation.buildIssueBranchName(github.issue);
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await execFileAsync("git", ["checkout", "-b", branchName], {
      cwd: fixture.project.rootPath,
    });
    await writeFile(
      join(fixture.project.rootPath, "remote-branch.txt"),
      "remote branch fixture\n",
      "utf8",
    );
    await execFileAsync("git", ["add", "remote-branch.txt"], {
      cwd: fixture.project.rootPath,
    });
    await execFileAsync("git", ["commit", "-m", "remote branch fixture"], {
      cwd: fixture.project.rootPath,
    });
    await execFileAsync("git", ["push", "-u", "origin", branchName], {
      cwd: fixture.project.rootPath,
    });
    await execFileAsync("git", ["checkout", "main"], {
      cwd: fixture.project.rootPath,
    });
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: fixture.project.rootPath,
    });
    await execFileAsync(
      "git",
      ["update-ref", "-d", `refs/remotes/origin/${branchName}`],
      { cwd: fixture.project.rootPath },
    );

    github.pullRequest = {
      id: 2001,
      number: 7,
      title: "Issue #42: Test AGSE workflow",
      body: automation.buildInitialPullRequestBody(github.issue, {
        version: 1,
        issueId: github.issue.id,
        issueNumber: github.issue.number,
        issueTitle: github.issue.title,
        issueUrl: github.issue.html_url,
        agent: "codex",
        branchName,
      }),
      html_url: "https://github.com/example/agse/pull/7",
      state: "open",
      created_at: "2026-06-26T00:00:01Z",
      updated_at: "2026-06-26T00:00:01Z",
      head: { ref: branchName },
      base: { ref: "main" },
    };

    const recovered = await recoverTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.equal(recovered.length, 1);
    assert.match(recovered[0]?.worktreePath ?? "", /\/codex-worktrees\/[a-f0-9]{4}\//);
    await stat(recovered[0]?.worktreePath ?? "");
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("recovery skips PR metadata for tombstoned issues", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const branchName = automation.buildIssueBranchName(github.issue);

  try {
    github.pullRequest = pullRequestForIssue(github.issue, {
      body: automation.buildInitialPullRequestBody(github.issue, {
        version: 1,
        issueId: github.issue.id,
        issueNumber: github.issue.number,
        issueTitle: github.issue.title,
        issueUrl: github.issue.html_url,
        agent: "codex",
        branchName,
      }),
      head: { ref: branchName },
    });
    await new AGSCStateStore(fixture.project.rootPath).closeWorkflow(
      {
        issueId: github.issue.id,
        issueNumber: github.issue.number,
        issueTitle: github.issue.title,
        issueUrl: github.issue.html_url,
        agent: "codex",
        worktreePath: "/tmp/removed",
        branchName,
        pullNumber: 7,
        pullUrl: "https://github.com/example/agse/pull/7",
        pullState: "closed",
      },
      "PR closed",
    );

    const recovered = await recoverTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.deepEqual(recovered, []);
  } finally {
    await fixture.cleanup();
  }
});

test("open AGSE PR metadata can rehydrate missing local state and worktree", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () =>
      Boolean(github.pullRequest?.body?.includes("agsc:metadata")),
    );
    await waitFor(async () => {
      const metadata = automation.parsePullRequestMetadata(
        github.pullRequest?.body ?? null,
      );
      return metadata?.codexImplementationTurnId === "impl-turn-1";
    });

    const originalState = await new AGSCStateStore(
      fixture.project.rootPath,
    ).read();
    const originalWorkflow = originalState.workflows[0];
    assert.ok(originalWorkflow);

    await fixture.project.git.git.raw([
      "worktree",
      "remove",
      "--force",
      originalWorkflow.worktreePath,
    ]);
    await rm(join(fixture.project.rootPath, ".agse", "state.json"), {
      force: true,
    });

    const recovered = await recoverTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.issueNumber, 42);
    assert.equal(recovered[0]?.codexThreadId, "thread-1");
    assert.equal(recovered[0]?.codexImplementationTurnId, "impl-turn-1");
    assert.equal(recovered[0]?.agentHandoffPhase, "implementing");
    await stat(originalWorkflow.worktreePath);

    const recoveredState = await new AGSCStateStore(
      fixture.project.rootPath,
    ).read();
    assert.equal(recoveredState.workflows[0]?.pullNumber, 7);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("completed detached implementation posts a PR comment and clears active turn", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    const stateBeforeCompletion = await new AGSCStateStore(
      fixture.project.rootPath,
    ).read();
    const workflowBeforeCompletion = stateBeforeCompletion.workflows[0];
    assert.ok(workflowBeforeCompletion);
    await writeFile(
      join(workflowBeforeCompletion.worktreePath, "codex-result.txt"),
      "implemented\n",
      "utf8",
    );

    codex.turnStatus = "completed";
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0]?.body ?? "", /agsc:implementation-complete/);

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.equal(state.workflows[0]?.codexActiveTurnId, undefined);
    assert.equal(state.workflows[0]?.agentHandoffPhase, "idle");
    assert.match(github.pullRequest?.body ?? "", /"agentHandoffPhase":"idle"/);
    assert.equal(codex.closeCount, 1);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("completed feedback pass posts a fresh PR comment after prior implementation comment", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  codex.detachedTurnIds = ["impl-turn-1", "feedback-turn-1"];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    const stateBeforeInitialCompletion = await new AGSCStateStore(
      fixture.project.rootPath,
    ).read();
    const initialWorkflow = stateBeforeInitialCompletion.workflows[0];
    assert.ok(initialWorkflow);
    await writeFile(
      join(initialWorkflow.worktreePath, "codex-result.txt"),
      "implemented\n",
      "utf8",
    );

    codex.turnStatus = "completed";
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0]?.body ?? "", /Implementation turn: impl-turn-1/);

    github.addHumanComment("please add one more workflow assertion");
    codex.turnStatus = "inProgress";
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    let state = await new AGSCStateStore(fixture.project.rootPath).read();
    const feedbackWorkflow = state.workflows[0];
    assert.equal(feedbackWorkflow?.codexActiveTurnId, "feedback-turn-1");
    assert.equal(feedbackWorkflow?.codexImplementationTurnId, "feedback-turn-1");
    assert.equal(feedbackWorkflow?.codexImplementationCommentedAt, undefined);
    assert.deepEqual(github.commentReactions, [
      { commentId: 501, content: "eyes" },
    ]);

    assert.ok(feedbackWorkflow);
    await writeFile(
      join(feedbackWorkflow.worktreePath, "feedback-result.txt"),
      "addressed feedback\n",
      "utf8",
    );
    codex.turnStatus = "completed";
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    const agscComments = github.comments.filter((comment) =>
      automation.isAGSCComment(comment.body),
    );
    assert.equal(agscComments.length, 2);
    assert.match(
      agscComments[1]?.body ?? "",
      /Implementation turn: feedback-turn-1/,
    );

    state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.equal(state.workflows[0]?.codexActiveTurnId, undefined);
    assert.equal(state.workflows[0]?.agentHandoffPhase, "idle");
    assert.equal(typeof state.workflows[0]?.codexImplementationCommentedAt, "string");
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

test("interrupted detached implementation starts one recovery turn", async () => {
  const fixture = await createGitFixture();
  const github = new FakeGitHub(issue());
  const codex = new FakeCodex();
  codex.detachedTurnIds = ["impl-turn-1", "recovery-turn-1"];
  const restoreFactory = automation.setCodexHandoffWorkflowFactory(
    () => codex as unknown as CodexWorkflows,
  );
  const restoreRegistrar = automation.setCodexWorkspaceRootRegistrar(async () => {});

  try {
    await handleGitHubIssueForProject({
      project: fixture.project,
      repository,
      issue: github.issue,
      github: github as never,
      localGitHubLogin: "godbrigero",
    });
    await waitFor(async () => {
      const state = await new AGSCStateStore(fixture.project.rootPath).read();
      return state.workflows[0]?.codexImplementationTurnId === "impl-turn-1";
    });

    codex.turnStatus = "interrupted";
    await syncTrackedPullRequests(
      fixture.project,
      repository,
      github as never,
    );

    const state = await new AGSCStateStore(fixture.project.rootPath).read();
    assert.equal(state.workflows[0]?.codexActiveTurnId, "recovery-turn-1");
    assert.equal(state.workflows[0]?.agentHandoffPhase, "implementing");
    assert.match(codex.detachedMessages[1] ?? "", /Continue Issue #42/);
    assert.equal(codex.closeCount, 0);
  } finally {
    restoreRegistrar();
    restoreFactory();
    await fixture.cleanup();
  }
});

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 1001,
    number: 42,
    title: "Test AGSE workflow",
    body: "Create a PR-backed Codex workflow.",
    html_url: "https://github.com/example/agse/issues/42",
    state: "open",
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
    user: { login: "godbrigero" },
    assignees: [],
    labels: [{ name: "agse-codex" }],
    ...overrides,
  };
}

function pullRequestForIssue(
  sourceIssue: GitHubIssue,
  overrides: Partial<GitHubPullRequest> = {},
): GitHubPullRequest {
  return {
    id: 2001,
    number: 7,
    title: `Issue #${sourceIssue.number}: ${sourceIssue.title}`,
    body: automation.buildInitialPullRequestBody(sourceIssue),
    html_url: "https://github.com/example/agse/pull/7",
    state: "open",
    created_at: "2026-06-26T00:00:01Z",
    updated_at: "2026-06-26T00:00:01Z",
    head: { ref: automation.buildIssueBranchName(sourceIssue) },
    base: { ref: "main" },
    ...overrides,
  };
}

async function createGitFixture(): Promise<{
  project: AGSCProject;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agse-workflow-"));
  const remotePath = join(root, "remote.git");
  const repoPath = join(root, "repo");
  const codexWorktreesRoot = join(root, "codex-worktrees");
  const previousCodexWorktreesRoot = process.env.AGSE_CODEX_WORKTREES_ROOT;
  process.env.AGSE_CODEX_WORKTREES_ROOT = codexWorktreesRoot;

  await execFileAsync("git", ["init", "--bare", remotePath]);
  await execFileAsync("git", ["init", repoPath]);
  await execFileAsync("git", ["config", "user.name", "Tester"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["config", "user.email", "tester@example.invalid"], {
    cwd: repoPath,
  });
  await writeFile(join(repoPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: repoPath });
  await execFileAsync("git", ["remote", "add", "origin", remotePath], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["push", "-u", "origin", "main"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });

  return {
    project: {
      name: "repo",
      rootPath: repoPath,
      config: {
        require_tag: true,
        overwrite_tags: {
          codex: "agse-codex",
          claude: "agse-claude",
          default: "agse",
        },
        restrict_user_to_local_only: true,
      },
      git: { git: simpleGit({ baseDir: repoPath }) },
    } as AGSCProject,
    cleanup() {
      if (previousCodexWorktreesRoot === undefined) {
        delete process.env.AGSE_CODEX_WORKTREES_ROOT;
      } else {
        process.env.AGSE_CODEX_WORKTREES_ROOT = previousCodexWorktreesRoot;
      }

      return rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.fail("Timed out waiting for workflow condition.");
}

class FakeGitHub {
  issue: GitHubIssue;
  pullRequest: GitHubPullRequest | undefined;
  comments: GitHubIssueComment[] = [];
  commentReactions: Array<{ commentId: number; content: string }> = [];
  issueReactions: Array<{ issueNumber: number; content: string }> = [];
  failNextReaction = false;
  failNextIssueReaction = false;

  constructor(issue: GitHubIssue) {
    this.issue = issue;
  }

  async listOpenPullRequestsForHead(): Promise<GitHubPullRequest[]> {
    return this.pullRequest ? [this.pullRequest] : [];
  }

  async listOpenPullRequests(): Promise<GitHubPullRequest[]> {
    return this.pullRequest ? [this.pullRequest] : [];
  }

  async createPullRequest(
    _repository: GitHubRepositoryRef,
    input: {
      title: string;
      body: string;
      head: string;
      base: string;
    },
  ): Promise<GitHubPullRequest> {
    this.pullRequest = {
      id: 2001,
      number: 7,
      title: input.title,
      body: input.body,
      html_url: "https://github.com/example/agse/pull/7",
      state: "open",
      created_at: "2026-06-26T00:00:01Z",
      updated_at: "2026-06-26T00:00:01Z",
      head: { ref: input.head },
      base: { ref: input.base },
    };

    return this.pullRequest;
  }

  async updatePullRequestBody(
    _repository: GitHubRepositoryRef,
    _pullNumber: number,
    body: string,
  ): Promise<GitHubPullRequest> {
    assert.ok(this.pullRequest);
    this.pullRequest = {
      ...this.pullRequest,
      body,
      updated_at: "2026-06-26T00:00:02Z",
    };

    return this.pullRequest;
  }

  async getPullRequest(): Promise<GitHubPullRequest> {
    assert.ok(this.pullRequest);
    return this.pullRequest;
  }

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
  }

  async updateIssue(
    _repository: GitHubRepositoryRef,
    _issueNumber: number,
    input: Partial<Pick<GitHubIssue, "state" | "title" | "body">>,
  ): Promise<GitHubIssue> {
    this.issue = {
      ...this.issue,
      ...input,
      updated_at: "2026-06-26T00:00:02Z",
    };

    return this.issue;
  }

  async listIssueComments(): Promise<GitHubIssueComment[]> {
    return this.comments;
  }

  async listPullRequestReviews(): Promise<[]> {
    return [];
  }

  async addIssueComment(
    _repository: GitHubRepositoryRef,
    _issueNumber: number,
    body: string,
  ): Promise<GitHubIssueComment> {
    const comment: GitHubIssueComment = {
      id: 9000 + this.comments.length + 1,
      body,
      html_url: "https://github.com/example/agse/pull/7#issuecomment-9001",
      created_at: "2026-06-26T00:00:04Z",
      updated_at: "2026-06-26T00:00:04Z",
      user: { login: "agse" },
    };
    this.comments.push(comment);
    return comment;
  }

  async addIssueCommentReaction(
    _repository: GitHubRepositoryRef,
    commentId: number,
    content: string,
  ): Promise<void> {
    if (this.failNextReaction) {
      this.failNextReaction = false;
      throw new Error("reaction failed");
    }

    this.commentReactions.push({ commentId, content });
  }

  async addIssueReaction(
    _repository: GitHubRepositoryRef,
    issueNumber: number,
    content: string,
  ): Promise<void> {
    if (this.failNextIssueReaction) {
      this.failNextIssueReaction = false;
      throw new Error("issue reaction failed");
    }

    this.issueReactions.push({ issueNumber, content });
  }

  addHumanComment(body: string): void {
    this.comments.push({
      id: 501,
      body,
      html_url: "https://github.com/example/agse/pull/7#issuecomment-501",
      created_at: "2026-06-26T00:00:03Z",
      updated_at: "2026-06-26T00:00:03Z",
      user: { login: "reviewer" },
    });
    assert.ok(this.pullRequest);
    this.pullRequest = {
      ...this.pullRequest,
      updated_at: "2026-06-26T00:00:03Z",
    };
  }
}

class FakeCodex {
  knownThreadIds = new Set(["thread-1"]);
  archivedThreadIds = new Set<string>();
  unarchivedThreads: string[] = [];
  rootPaths: string[] = [];
  startedChats: Array<Record<string, unknown>> = [];
  renamedThreads: Array<{ threadId: string; title: string }> = [];
  archivedThreads: string[] = [];
  deletedThreads: string[] = [];
  messages: string[] = [];
  detachedMessages: string[] = [];
  detachedTurnIds = ["impl-turn-1"];
  detachedStartedTurnIds: string[] = [];
  turnStatus = "inProgress";
  closeCount = 0;
  onStartChat?: () => void;
  steeredMessages: Array<{
    threadId: string;
    expectedTurnId: string;
    input: string;
  }> = [];

  async startChat(input: Record<string, unknown>) {
    this.onStartChat?.();
    this.startedChats.push(input);
    this.knownThreadIds.add("thread-1");
    this.archivedThreadIds.delete("thread-1");
    return { id: "thread-1", raw: { thread: { id: "thread-1" } } };
  }

  async renameChat(threadId: string, title: string) {
    this.renamedThreads.push({ threadId, title });
  }

  async sendMessage(_threadId: string, input: string) {
    this.messages.push(input);
    return {
      threadId: "thread-1",
      turn: { turn: { id: "plan-turn-1" } },
      completed: {
        method: "turn/completed",
        params: { turn: { id: "plan-turn-1" } },
      },
      finalResponse: [
        "<proposed_plan>",
        "# Workflow Plan",
        "",
        "- Inspect AGSE",
        "- Implement PR chat flow",
        "</proposed_plan>",
      ].join("\n"),
      notifications: [],
    };
  }

  async startTurnDetached(input: { input: string }) {
    this.detachedMessages.push(input.input);
    const turnId =
      this.detachedTurnIds.shift() ??
      `detached-turn-${this.detachedMessages.length}`;
    this.detachedStartedTurnIds.push(turnId);
    return {
      threadId: "thread-1",
      turnId,
      turn: { turn: { id: turnId } },
    };
  }

  async listChats(params: { archived?: boolean } = {}) {
    const ids = [...this.knownThreadIds].filter((threadId) =>
      params.archived
        ? this.archivedThreadIds.has(threadId)
        : !this.archivedThreadIds.has(threadId)
    );

    return { data: ids.map((id) => ({ id })) };
  }

  async readChat() {
    return {
      thread: { id: "thread-1", raw: {} },
      raw: {
        thread: {
          id: "thread-1",
          turns: this.detachedStartedTurnIds.map((id) => ({
            id,
            status: this.turnStatus,
          })),
        },
      },
    };
  }

  async resumeChat(threadId = "thread-1") {
    if (!this.knownThreadIds.has(threadId) || this.archivedThreadIds.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }

    return { id: threadId, raw: {} };
  }

  async steerMessage(
    threadId: string,
    input: string,
    params: { expectedTurnId: string },
  ) {
    if (!this.knownThreadIds.has(threadId) || this.archivedThreadIds.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }

    this.steeredMessages.push({
      threadId,
      expectedTurnId: params.expectedTurnId,
      input: input.includes("please add one more workflow assertion")
        ? "please add one more workflow assertion"
        : input,
    });
  }

  async archiveChat(threadId: string) {
    this.archivedThreads.push(threadId);
    this.archivedThreadIds.add(threadId);
  }

  async deleteChat(threadId: string) {
    this.deletedThreads.push(threadId);
    this.knownThreadIds.delete(threadId);
    this.archivedThreadIds.delete(threadId);
  }

  async unarchiveChat(threadId: string) {
    if (!this.knownThreadIds.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }

    this.unarchivedThreads.push(threadId);
    this.archivedThreadIds.delete(threadId);
  }

  close() {
    this.closeCount += 1;
  }
}
