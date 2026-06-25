import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { AGSCProject } from "./agscWorkspace.ts";
import {
  AGSCStateStore,
  type AGSCAgentName,
  type AGSCTrackedWorkflow,
} from "./agscState.ts";
import { CodexWorkflows } from "./codexIntegration/index.ts";
import { ClaudeCodeWorkflows } from "./claudeCodeIntegration/index.ts";
import {
  GitHubApiClient,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubRepositoryRef,
} from "./githubApi.ts";

type IssueAutomationInput = {
  project: AGSCProject;
  repository: GitHubRepositoryRef;
  issue: GitHubIssue;
  github: GitHubApiClient;
  localGitHubLogin: string | null;
};

const DEFAULT_AGENT: AGSCAgentName = "codex";

export async function handleGitHubIssueForProject({
  project,
  repository,
  issue,
  github,
  localGitHubLogin,
}: IssueAutomationInput): Promise<void> {
  const selectedAgent = selectAgent(project, issue);

  if (!selectedAgent) {
    console.log(
      `[agsc] Skipping ${project.name} #${issue.number}: required AGSC label is absent.`,
    );
    return;
  }

  if (
    project.config.restrict_user_to_local_only &&
    issue.user?.login !== localGitHubLogin
  ) {
    console.log(
      `[agsc] Skipping ${project.name} #${issue.number}: issue author is not the local GitHub user.`,
    );
    return;
  }

  const stateStore = new AGSCStateStore(project.rootPath);
  const state = await stateStore.read();
  const existing = state.workflows.find((entry) => entry.issueId === issue.id);
  const branchName = existing?.branchName ?? buildIssueBranchName(issue);
  const worktreePath =
    existing?.worktreePath ?? buildIssueWorktreePath(project.rootPath, issue);
  const baseBranch = await getRemoteDefaultBranch(project.git.git);

  await ensureWorktree({
    git: project.git.git,
    projectRootPath: project.rootPath,
    worktreePath,
    branchName,
    baseBranch,
  });

  const pullRequest = await ensurePullRequest({
    github,
    repository,
    issue,
    branchName,
    baseBranch,
  });

  const workflow: AGSCTrackedWorkflow = {
    ...existing,
    issueId: issue.id,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    agent: selectedAgent,
    worktreePath,
    branchName,
    pullNumber: pullRequest.number,
    pullUrl: pullRequest.html_url,
    lastPullUpdatedAt: existing?.lastPullUpdatedAt ?? pullRequest.updated_at,
  };

  await stateStore.upsertWorkflow(workflow);
  await startAgentIfNeeded(
    project,
    repository,
    workflow,
    issue,
    pullRequest,
    github,
  );
}

export async function syncTrackedPullRequests(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  github: GitHubApiClient,
): Promise<void> {
  const stateStore = new AGSCStateStore(project.rootPath);
  const state = await stateStore.read();

  for (const workflow of state.workflows) {
    if (!workflow.pullNumber) {
      continue;
    }

    const pullRequest = await github.getPullRequest(
      repository,
      workflow.pullNumber,
    );

    if (
      pullRequest.state !== "open" ||
      pullRequest.updated_at === workflow.lastPullUpdatedAt
    ) {
      continue;
    }

    const eventSummary = await buildPullRequestEventSummary(
      github,
      repository,
      workflow,
    );

    if (!eventSummary) {
      await stateStore.upsertWorkflow({
        ...workflow,
        lastPullUpdatedAt: pullRequest.updated_at,
      });
      continue;
    }

    await notifyAgentAboutPullRequestUpdate(project, workflow, eventSummary);
    await stateStore.upsertWorkflow({
      ...workflow,
      lastPullUpdatedAt: pullRequest.updated_at,
      lastSyncedPrEventAt: new Date().toISOString(),
    });
  }
}

function selectAgent(
  project: AGSCProject,
  issue: GitHubIssue,
): AGSCAgentName | null {
  const labels = new Set(issue.labels.map((label) => label.name));
  const tags = {
    codex: project.config.overwrite_tags?.codex ?? "agse-codex",
    claude: project.config.overwrite_tags?.claude ?? "agse-claude",
    default: project.config.overwrite_tags?.default ?? "agse",
  };

  if (labels.has(tags.codex)) {
    return "codex";
  }

  if (labels.has(tags.claude)) {
    return "claude";
  }

  if (labels.has(tags.default)) {
    return DEFAULT_AGENT;
  }

  return project.config.require_tag ? null : DEFAULT_AGENT;
}

function buildIssueBranchName(issue: GitHubIssue): string {
  return `agse/issue-${issue.number}-${slugify(issue.title)}`;
}

function buildIssueWorktreePath(
  projectRootPath: string,
  issue: GitHubIssue,
): string {
  return join(
    projectRootPath,
    ".agse",
    "worktrees",
    `issue-${issue.number}-${slugify(issue.title)}`,
  );
}

async function ensureWorktree(input: {
  git: SimpleGit;
  projectRootPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}): Promise<void> {
  await ensureAGSCGitExclude(input.projectRootPath);

  if (await pathExists(input.worktreePath)) {
    return;
  }

  await mkdir(dirname(input.worktreePath), { recursive: true });

  const hasRemoteBranch = await remoteBranchExists(input.git, input.branchName);

  if (hasRemoteBranch) {
    await input.git.raw([
      "worktree",
      "add",
      "-B",
      input.branchName,
      input.worktreePath,
      `origin/${input.branchName}`,
    ]);
    return;
  }

  await input.git.raw([
    "worktree",
    "add",
    "-B",
    input.branchName,
    input.worktreePath,
    `origin/${input.baseBranch}`,
  ]);

  const worktreeGit = simpleGit({ baseDir: input.worktreePath });
  await worktreeGit.raw([
    "-c",
    "user.name=AGSC",
    "-c",
    "user.email=agsc@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    `chore(agsc): start ${basename(input.branchName)}`,
  ]);
  await worktreeGit.push(["-u", "origin", input.branchName]);
}

async function ensureAGSCGitExclude(projectRootPath: string): Promise<void> {
  const excludePath = join(projectRootPath, ".git", "info", "exclude");

  try {
    const current = await readFile(excludePath, "utf8");

    if (current.includes(".agse/")) {
      return;
    }

    await writeFile(excludePath, `${current.trimEnd()}\n.agse/\n`, "utf8");
  } catch {
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, ".agse/\n", "utf8");
  }
}

async function ensurePullRequest(input: {
  github: GitHubApiClient;
  repository: GitHubRepositoryRef;
  issue: GitHubIssue;
  branchName: string;
  baseBranch: string;
}): Promise<GitHubPullRequest> {
  const existingPullRequests = await input.github.listOpenPullRequestsForHead(
    input.repository,
    input.branchName,
  );

  if (existingPullRequests[0]) {
    return existingPullRequests[0];
  }

  return input.github.createPullRequest(input.repository, {
    title: buildPullRequestTitle(input.issue),
    body: buildInitialPullRequestBody(input.issue),
    head: input.branchName,
    base: input.baseBranch,
  });
}

async function startAgentIfNeeded(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  github: GitHubApiClient,
): Promise<void> {
  if (workflow.agent === "codex" && workflow.codexThreadId) {
    return;
  }

  if (workflow.agent === "claude" && workflow.claudeSessionId) {
    return;
  }

  if (workflow.agent === "claude") {
    await startClaudeWorkflow(
      project,
      repository,
      workflow,
      issue,
      pullRequest,
      github,
    );
    return;
  }

  await startCodexWorkflow(
    project,
    repository,
    workflow,
    issue,
    pullRequest,
    github,
  );
}

async function startCodexWorkflow(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  github: GitHubApiClient,
): Promise<void> {
  const worktreeCodex = new CodexWorkflows(workflow.worktreePath);

  try {
    const thread = await worktreeCodex.startChat({ cwd: workflow.worktreePath });
    const result = await worktreeCodex.sendMessage(
      thread.id,
      buildPlanningPrompt(issue, pullRequest),
      {
        cwd: workflow.worktreePath,
      },
    );
    const plan = result.finalResponse.trim();

    await github.updatePullRequestBody(
      repository,
      pullRequest.number,
      `${buildInitialPullRequestBody(issue)}\n\n## Agent Plan\n\n${plan || "_Codex did not return a plan._"}\n`,
    );
    await worktreeCodex.sendMessage(
      thread.id,
      buildImplementationPrompt(issue, pullRequest, plan),
      {
        cwd: workflow.worktreePath,
      },
    );

    await new AGSCStateStore(project.rootPath).upsertWorkflow({
      ...workflow,
      codexThreadId: thread.id,
    });
  } finally {
    worktreeCodex.close();
  }
}

async function startClaudeWorkflow(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  github: GitHubApiClient,
): Promise<void> {
  const worktreeClaude = new ClaudeCodeWorkflows(workflow.worktreePath);
  const chat = await worktreeClaude.createChat({
    title: `Issue #${issue.number}: ${issue.title}`,
  });
  const planningResult = await chat.sendMessage(
    buildPlanningPrompt(issue, pullRequest),
  );
  const plan = planningResult.responseText?.trim() ?? "";

  await github.updatePullRequestBody(
    repository,
    pullRequest.number,
    `${buildInitialPullRequestBody(issue)}\n\n## Agent Plan\n\n${plan || "_Claude did not return a plan._"}\n`,
  );
  await chat.sendMessage(buildImplementationPrompt(issue, pullRequest, plan));

  await new AGSCStateStore(project.rootPath).upsertWorkflow({
    ...workflow,
    claudeSessionId: chat.sessionId,
  });
}

async function notifyAgentAboutPullRequestUpdate(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
  eventSummary: string,
): Promise<void> {
  if (workflow.agent !== "codex" || !workflow.codexThreadId) {
    if (workflow.agent === "claude" && workflow.claudeSessionId) {
      const worktreeClaude = new ClaudeCodeWorkflows(workflow.worktreePath);
      const updateMessage = [
        "A tracked GitHub PR changed.",
        "Review and address this feedback:",
        "",
        eventSummary,
      ].join("\n");

      await worktreeClaude.continueChat(workflow.claudeSessionId, updateMessage);
    }

    return;
  }

  const worktreeCodex = new CodexWorkflows(workflow.worktreePath);

  try {
    await worktreeCodex.resumeChat(workflow.codexThreadId);

    try {
      const steerMessage = [
        "A tracked GitHub PR changed.",
        "Incorporate this reviewer/user feedback into the active task without treating it as a new user request:",
        "",
        eventSummary,
      ].join("\n");

      await worktreeCodex.steerMessage(
        workflow.codexThreadId,
        steerMessage,
      );
    } catch {
      const fallbackMessage = [
        "A tracked GitHub PR changed.",
        "Review and address this feedback:",
        "",
        eventSummary,
      ].join("\n");

      await worktreeCodex.sendMessage(
        workflow.codexThreadId,
        fallbackMessage,
      );
    }
  } finally {
    worktreeCodex.close();
  }
}

async function buildPullRequestEventSummary(
  github: GitHubApiClient,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
): Promise<string | null> {
  const [comments, reviews] = await Promise.all([
    github.listIssueComments(repository, workflow.pullNumber ?? 0),
    github.listPullRequestReviews(repository, workflow.pullNumber ?? 0),
  ]);
  const pieces = [
    ...comments.map((comment) =>
      [
        `Comment by ${comment.user?.login ?? "unknown"} at ${comment.updated_at}:`,
        comment.body ?? "",
        comment.html_url,
      ].join("\n"),
    ),
    ...reviews
      .filter((review) => review.body)
      .map((review) =>
        [
          `Review ${review.state} by ${review.user?.login ?? "unknown"} at ${review.submitted_at ?? "unknown"}:`,
          review.body ?? "",
          review.html_url,
        ].join("\n"),
      ),
  ];

  return pieces.length > 0 ? pieces.join("\n\n---\n\n") : null;
}

async function getRemoteDefaultBranch(git: SimpleGit): Promise<string> {
  const output = await git.raw(["remote", "show", "origin"]);
  const match = output.match(/HEAD branch:\s*(?<branch>\S+)/);

  return match?.groups?.branch ?? "main";
}

async function remoteBranchExists(
  git: SimpleGit,
  branchName: string,
): Promise<boolean> {
  const output = await git.raw(["ls-remote", "--heads", "origin", branchName]);

  return output.trim().length > 0;
}

function buildPullRequestTitle(issue: GitHubIssue): string {
  return `Issue #${issue.number}: ${issue.title}`;
}

function buildInitialPullRequestBody(issue: GitHubIssue): string {
  return [
    `## Issue`,
    ``,
    `Closes #${issue.number}`,
    ``,
    issue.body?.trim() || "_No issue description provided._",
  ].join("\n");
}

function buildPlanningPrompt(
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
): string {
  return [
    "You are working inside an AGSC-created Git worktree for a GitHub issue.",
    "First summarize the issue and produce a concrete implementation plan.",
    "Do not change files yet in this turn.",
    "After this planning turn, AGSC will update the PR body with your plan.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    issue.body?.trim() || "_No issue description provided._",
    "",
    `Pull request: ${pullRequest.html_url}`,
  ].join("\n");
}

function buildImplementationPrompt(
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  plan: string,
): string {
  return [
    "Now execute the plan for this issue in the current worktree.",
    "Make the necessary code changes, run focused verification, commit the changes, and push them to the current PR branch.",
    "Keep the PR focused on the issue.",
    "If you cannot complete part of the plan, report the blocker clearly.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    issue.body?.trim() || "_No issue description provided._",
    "",
    `Pull request: ${pullRequest.html_url}`,
    "",
    "Plan:",
    plan || "_No plan text was produced._",
  ].join("\n");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
