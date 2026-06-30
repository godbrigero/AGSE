import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { AGSCStateStore } from "../src/agscState.ts";
import { AGSCProject } from "../src/agscWorkspace.ts";
import {
  handleGitHubIssueForProject,
  syncTrackedPullRequests,
  __testing as automation,
} from "../src/agscIssueAutomation.ts";
import { GitHubApiClient, type GitHubIssue } from "../src/githubApi.ts";

const token = process.env.GITHUB_TOKEN;
const skipReason = process.env.AGSE_SKIP_LIVE_TESTS
  ? "AGSE_SKIP_LIVE_TESTS is set."
  : token
    ? false
    : "GITHUB_TOKEN is required for the live GitHub workflow test.";

test(
  "live GitHub issue creates a PR-backed Codex chat workflow",
  { timeout: 30 * 60_000, skip: skipReason },
  async () => {
    const repository = { owner: "godbrigero", repo: "AGSE" };
    const github = new GitHubApiClient(token);
    const project = await AGSCProject.fromRootPath(process.cwd());
    const stateStore = new AGSCStateStore(project.rootPath);
    const originalState = await stateStore.read();
    const localUser = await github.getAuthenticatedUser();
    const title = `AGSE live workflow smoke ${Date.now()}`;
    let issue: GitHubIssue | undefined;
    let pullNumber: number | undefined;
    let branchName: string | undefined;
    let worktreePath: string | undefined;

    try {
      issue = await github.createIssue(repository, {
        title,
        body: [
          "Live AGSE smoke test.",
          "",
          "The expected behavior is that AGSE creates a PR, writes a Codex plan into the PR body, starts a detached implementation turn, and routes this PR comment back into the same Codex thread.",
        ].join("\n"),
        labels: ["agse-codex"],
      });
      branchName = automation.buildIssueBranchName(issue);
      worktreePath = automation.buildIssueWorktreePath(project.rootPath, issue);

      const result = await handleGitHubIssueForProject({
        project,
        repository,
        issue,
        github,
        localGitHubLogin: localUser?.login ?? repository.owner,
      });

      assert.equal(result.status, "tracked");
      if (result.status !== "tracked") {
        return;
      }

      pullNumber = result.workflow.pullNumber;
      branchName = result.workflow.branchName;
      worktreePath = result.workflow.worktreePath;
      assert.ok(pullNumber);

      await waitFor(async () => {
        const pull = await github.getPullRequest(repository, pullNumber ?? 0);
        return Boolean(pull.body?.includes("## Codex Plan"));
      }, 25 * 60_000);

      const stateAfterPlan = await new AGSCStateStore(project.rootPath).read();
      const workflowAfterPlan = stateAfterPlan.workflows.find(
        (workflow) => workflow.issueId === issue?.id,
      );

      assert.equal(workflowAfterPlan?.agentHandoffPhase, "implementing");
      assert.ok(workflowAfterPlan?.codexThreadId);
      assert.ok(workflowAfterPlan?.codexImplementationTurnId);

      const comment = await github.addIssueComment(
        repository,
        pullNumber,
        "AGSE live smoke test feedback: acknowledge this comment in the PR chat context.",
      );

      await stateStore.update(() => ({
        workflows: workflowAfterPlan ? [workflowAfterPlan] : [],
        closedWorkflows: stateAfterPlan.closedWorkflows,
      }));
      await syncTrackedPullRequests(project, repository, github);

      const stateAfterFeedback = await new AGSCStateStore(project.rootPath).read();
      const workflowAfterFeedback = stateAfterFeedback.workflows.find(
        (workflow) => workflow.issueId === issue?.id,
      );

      assert.ok(
        workflowAfterFeedback?.syncedPrEventIds?.includes(
          `comment:${comment.id}`,
        ),
      );
    } finally {
      if (pullNumber) {
        await github.closePullRequest(repository, pullNumber).catch(() => {});
      }
      if (issue) {
        await github
          .updateIssue(repository, issue.number, { state: "closed" })
          .catch(() => {});
      }
      if (branchName) {
        await github.deleteBranchRef(repository, branchName).catch(() => {});
      }
      if (worktreePath) {
        const cleanupWorktreePath = worktreePath;
        await project.git.git
          .raw(["worktree", "remove", "--force", cleanupWorktreePath])
          .catch(() =>
            rm(cleanupWorktreePath, { recursive: true, force: true }),
          );
        await project.git.git.raw(["worktree", "prune"]).catch(() => {});
      }
      if (branchName) {
        await project.git.git.branch(["-D", branchName]).catch(() => {});
      }
      await stateStore.update(() => originalState).catch(() => {});
    }
  },
);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  assert.fail("Timed out waiting for live GitHub workflow condition.");
}
