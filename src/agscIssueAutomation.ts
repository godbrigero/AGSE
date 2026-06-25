import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { AGSCProject } from "./agscWorkspace.ts";
import {
  AGSCStateStore,
  type AGSCAgentName,
  type AGSCTrackedWorkflow,
} from "./agscState.ts";
import {
  CodexWorkflows,
  type CodexWorkflowOptions,
} from "./codexIntegration/index.ts";
import { ClaudeCodeWorkflows } from "./claudeCodeIntegration/index.ts";
import {
  GitHubApiClient,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubRepositoryRef,
} from "./githubApi.ts";
import { info, style, success, warning } from "./terminalStyle.ts";
import type { CodexNotification } from "./codexIntegration/index.ts";

type IssueAutomationInput = {
  project: AGSCProject;
  repository: GitHubRepositoryRef;
  issue: GitHubIssue;
  github: GitHubApiClient;
  localGitHubLogin: string | null;
};

export type IssueAutomationResult =
  | {
      status: "tracked";
      workflow: AGSCTrackedWorkflow;
    }
  | {
      status: "skipped";
      reason: string;
    };

const DEFAULT_AGENT: AGSCAgentName = "codex";
const CODEX_HANDOFF_PROMPT_VERSION = 5;
const CODEX_HANDOFF_TIMEOUT_MS = 6 * 60 * 60_000;
const CODEX_HANDOFF_MAX_TURNS = 4;
const CODEX_HANDOFF_OPTIONS: CodexWorkflowOptions = {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  experimentalApi: true,
};
const activeCodexHandoffs = new Map<number, CodexWorkflows>();
type CodexAutoCommitReason = "handoff" | "pull-request-update";

export async function handleGitHubIssueForProject({
  project,
  repository,
  issue,
  github,
  localGitHubLogin,
}: IssueAutomationInput): Promise<IssueAutomationResult> {
  const selectedAgent = selectAgent(project, issue);

  if (!selectedAgent) {
    return skipIssue(project, issue, "required AGSC label/assignee route is absent");
  }

  console.log(
    success(
      `[agsc] Accepted ${project.name} #${issue.number} for ${selectedAgent}.`,
    ),
  );

  if (
    project.config.restrict_user_to_local_only &&
    !isLocalIssue(issue, localGitHubLogin)
  ) {
    const assignees = (issue.assignees ?? [])
      .map((assignee) => assignee.login)
      .join(", ");
    return skipIssue(
      project,
      issue,
      `issue author or assignee is not the local GitHub user (local=${localGitHubLogin ?? "none"}, author=${issue.user?.login ?? "unknown"}, assignees=${assignees || "none"})`,
    );
  }

  const stateStore = new AGSCStateStore(project.rootPath);
  const state = await stateStore.read();
  const existing = state.workflows.find((entry) => entry.issueId === issue.id);
  const branchName = existing?.branchName ?? buildIssueBranchName(issue);
  const worktreePath =
    existing?.worktreePath ?? buildIssueWorktreePath(project.rootPath, issue);
  const baseBranch = await getRemoteDefaultBranch(project.git.git);

  console.log(
    info(`[agsc] ${project.name} #${issue.number}: ensuring worktree ${worktreePath}`),
  );
  await ensureWorktree({
    git: project.git.git,
    projectRootPath: project.rootPath,
    worktreePath,
    branchName,
    baseBranch,
  });

  console.log(
    info(`[agsc] ${project.name} #${issue.number}: ensuring PR for ${branchName}`),
  );
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
    pullState: pullRequest.state,
    lastPullUpdatedAt: existing?.lastPullUpdatedAt ?? pullRequest.updated_at,
  };

  await stateStore.upsertWorkflow(workflow);
  console.log(
    success(
      `[agsc] ${project.name} #${issue.number}: tracked as PR #${pullRequest.number}.`,
    ),
  );
  await startAgentIfNeeded(
    project,
    repository,
    workflow,
    issue,
    pullRequest,
    github,
  );

  return {
    status: "tracked",
    workflow,
  };
}

function isLocalIssue(
  issue: GitHubIssue,
  localGitHubLogin: string | null,
): boolean {
  if (!localGitHubLogin) {
    return false;
  }

  return (
    issue.user?.login === localGitHubLogin ||
    (issue.assignees ?? []).some(
      (assignee) => assignee.login === localGitHubLogin,
    )
  );
}

function skipIssue(
  project: AGSCProject,
  issue: GitHubIssue,
  reason: string,
): IssueAutomationResult {
  console.log(warning(`[agsc] Skipping ${project.name} #${issue.number}: ${reason}.`));

  return {
    status: "skipped",
    reason,
  };
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

    const issue = await github.getIssue(repository, workflow.issueNumber);

    if (pullRequest.state !== "open") {
      await cleanupClosedWorkflow(project, workflow, stateStore, "PR closed");
      continue;
    }

    if (issue.state !== "open") {
      await cleanupClosedWorkflow(project, workflow, stateStore, "issue closed");
      continue;
    }

    const currentWorkflow = await validateTrackedAgentSession(
      project,
      workflow,
      stateStore,
    );

    if (workflowNeedsAgentStart(currentWorkflow)) {
      console.log(
        warning(
          `[agsc] ${project.name} #${currentWorkflow.issueNumber}: tracked workflow has no active ${currentWorkflow.agent} session; retrying agent startup.`,
        ),
      );
      await startAgentIfNeeded(
        project,
        repository,
        currentWorkflow,
        issue,
        pullRequest,
        github,
      );
    }

    if (pullRequest.updated_at === workflow.lastPullUpdatedAt) {
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
        pullState: pullRequest.state,
        lastPullUpdatedAt: pullRequest.updated_at,
      });
      continue;
    }

    try {
      await notifyAgentAboutPullRequestUpdate(project, workflow, eventSummary);
    } catch (error) {
      console.log(
        warning(
          `[agsc] ${project.name} #${workflow.issueNumber}: failed to notify ${workflow.agent} about PR update; will retry next poll: ${formatError(error)}`,
        ),
      );
      continue;
    }

    await stateStore.upsertWorkflow({
      ...workflow,
      pullState: pullRequest.state,
      lastPullUpdatedAt: pullRequest.updated_at,
      lastSyncedPrEventAt: new Date().toISOString(),
    });
  }
}

async function validateTrackedAgentSession(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
  stateStore: AGSCStateStore,
): Promise<AGSCTrackedWorkflow> {
  if (workflow.agent !== "codex" || !workflow.codexThreadId) {
    return workflow;
  }

  const exists = await codexThreadExists(project.rootPath, workflow.codexThreadId);

  if (exists) {
    return workflow;
  }

  const nextWorkflow: AGSCTrackedWorkflow = {
    ...workflow,
    codexThreadId: undefined,
    agentHandoffStartedAt: undefined,
  };

  console.log(
    warning(
      `[agsc] ${project.name} #${workflow.issueNumber}: Codex thread ${workflow.codexThreadId} is missing from the project; re-handing off.`,
    ),
  );
  await stateStore.upsertWorkflow(nextWorkflow);

  return nextWorkflow;
}

async function codexThreadExists(
  projectRootPath: string,
  threadId: string,
): Promise<boolean> {
  const codex = new CodexWorkflows(projectRootPath, { requestTimeoutMs: 10_000 });

  try {
    const list = await codex.listChats({});

    return extractCodexThreadIds(list).has(threadId);
  } catch (error) {
    console.log(
      warning(
        `[agsc] Could not validate Codex thread ${threadId}: ${formatError(error)}`,
      ),
    );
    return true;
  } finally {
    codex.close();
  }
}

function extractCodexThreadIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const entries = isRecord(value) && Array.isArray(value.data) ? value.data : [];

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }

    if (typeof entry.id === "string") {
      ids.add(entry.id);
    }

    if (typeof entry.sessionId === "string") {
      ids.add(entry.sessionId);
    }
  }

  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowNeedsAgentStart(workflow: AGSCTrackedWorkflow): boolean {
  return (
    (workflow.agent === "codex" &&
      (!workflow.codexThreadId ||
        workflow.agentHandoffVersion !== CODEX_HANDOFF_PROMPT_VERSION)) ||
    (workflow.agent === "claude" && !workflow.claudeSessionId)
  );
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

  const assigneeAgent = selectAgentFromAssignees(project, issue);

  if (assigneeAgent) {
    return assigneeAgent;
  }

  return project.config.require_tag ? null : DEFAULT_AGENT;
}

function selectAgentFromAssignees(
  project: AGSCProject,
  issue: GitHubIssue,
): AGSCAgentName | null {
  const assigneeTags = project.config.assignee_tags;

  if (!assigneeTags) {
    return null;
  }

  for (const assignee of issue.assignees ?? []) {
    const agent = assigneeTags[assignee.login];

    if (agent === "codex" || agent === "claude") {
      return agent;
    }

    if (agent === "default") {
      return DEFAULT_AGENT;
    }
  }

  return null;
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

  const registeredWorktree = await findRegisteredWorktree(
    input.git,
    input.worktreePath,
    input.branchName,
  );

  if (registeredWorktree && (await pathExists(registeredWorktree.path))) {
    console.log(info(`[agsc] Reusing worktree ${input.worktreePath}`));
    return;
  }

  if (registeredWorktree) {
    console.log(
      warning(
        `[agsc] Pruning stale worktree registration for ${input.branchName}.`,
      ),
    );
    await input.git.raw(["worktree", "prune"]);
  }

  if (await pathExists(input.worktreePath)) {
    console.log(info(`[agsc] Reusing worktree ${input.worktreePath}`));
    return;
  }

  await mkdir(dirname(input.worktreePath), { recursive: true });

  const hasRemoteBranch = await remoteBranchExists(input.git, input.branchName);

  if (hasRemoteBranch) {
    console.log(
      info(`[agsc] Creating worktree from remote branch ${input.branchName}`),
    );
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

  console.log(info(`[agsc] Creating worktree and branch ${input.branchName}`));
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

type RegisteredWorktree = {
  path: string;
  branch?: string;
};

async function findRegisteredWorktree(
  git: SimpleGit,
  worktreePath: string,
  branchName: string,
): Promise<RegisteredWorktree | null> {
  const output = await git.raw(["worktree", "list", "--porcelain"]);
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      worktrees.push(current);
      continue;
    }

    if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }

  return (
    worktrees.find(
      (worktree) =>
        worktree.path === worktreePath || worktree.branch === branchName,
    ) ?? null
  );
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
    console.log(
      info(
        `[agsc] Reusing existing PR #${existingPullRequests[0].number} for ${input.branchName}`,
      ),
    );
    return existingPullRequests[0];
  }

  console.log(info(`[agsc] Creating PR for ${input.branchName}`));
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
    if (workflow.agentHandoffVersion !== CODEX_HANDOFF_PROMPT_VERSION) {
      const gitState = await inspectCodexHandoffGitState(workflow);

      if (!gitState.needsContinuation) {
        await new AGSCStateStore(project.rootPath).upsertWorkflow({
          ...workflow,
          agentHandoffVersion: CODEX_HANDOFF_PROMPT_VERSION,
        });
        console.log(
          success(
            `[agsc] Codex handoff for issue #${workflow.issueNumber} is already complete despite old prompt version: ${gitState.summary}.`,
          ),
        );
        return;
      }

      console.log(
        warning(
          `[agsc] Codex handoff for issue #${workflow.issueNumber} uses an old prompt version and still needs attention (${gitState.summary}); starting a fresh thread.`,
        ),
      );
      await startCodexWorkflow(
        project,
        repository,
        {
          ...workflow,
          codexThreadId: undefined,
          agentHandoffStartedAt: undefined,
        },
        issue,
        pullRequest,
        github,
      );
      return;
    }

    console.log(
      info(`[agsc] Codex already started for issue #${workflow.issueNumber}.`),
    );
    return;
  }

  if (workflow.agent === "claude" && workflow.claudeSessionId) {
    console.log(
      info(`[agsc] Claude already started for issue #${workflow.issueNumber}.`),
    );
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
  if (activeCodexHandoffs.has(workflow.issueId)) {
    console.log(info(`[agsc] Codex handoff already running for issue #${issue.number}.`));
    return;
  }

  const projectCodex = createCodexHandoffWorkflows(project.rootPath);
  const title = buildPullRequestTitle(issue);
  const thread = await projectCodex.startChat({
    cwd: project.rootPath,
    title,
    sandbox: CODEX_HANDOFF_OPTIONS.sandbox,
    approvalPolicy: CODEX_HANDOFF_OPTIONS.approvalPolicy,
  });
  await renameCodexThread(projectCodex, thread.id, title);
  activeCodexHandoffs.set(workflow.issueId, projectCodex);

  await new AGSCStateStore(project.rootPath).upsertWorkflow({
    ...workflow,
    codexThreadId: thread.id,
    agentHandoffStartedAt: new Date().toISOString(),
    agentHandoffVersion: CODEX_HANDOFF_PROMPT_VERSION,
  });

  console.log(
    success(
      `[agsc] Handed off PR #${pullRequest.number} / issue #${issue.number} to Codex thread ${thread.id}.`,
    ),
  );

  void runCodexHandoffTurn({
    project,
    workflow,
    issue,
    codex: projectCodex,
    threadId: thread.id,
    message: buildCodexInitialHandoffMessage(
      title,
      issue,
      pullRequest,
      workflow,
    ),
  });
}

async function runCodexHandoffTurn(input: {
  project: AGSCProject;
  workflow: AGSCTrackedWorkflow;
  issue: GitHubIssue;
  codex: CodexWorkflows;
  threadId: string;
  message: string;
}): Promise<void> {
  try {
    await runCodexHandoffUntilGitSettles(input);
  } catch (error) {
    await new AGSCStateStore(input.project.rootPath).upsertWorkflow({
      ...input.workflow,
      codexThreadId: undefined,
      agentHandoffStartedAt: undefined,
      agentHandoffVersion: undefined,
    });
    console.log(
      warning(
        `[agsc] Failed to hand off issue #${input.issue.number} to Codex: ${formatError(error)}`,
      ),
    );
  } finally {
    closeCodexHandoff(input.workflow.issueId);
  }
}

async function runCodexHandoffUntilGitSettles(input: {
  project: AGSCProject;
  workflow: AGSCTrackedWorkflow;
  issue: GitHubIssue;
  codex: CodexWorkflows;
  threadId: string;
  message: string;
}): Promise<void> {
  let message = input.message;

  for (let turnIndex = 1; turnIndex <= CODEX_HANDOFF_MAX_TURNS; turnIndex += 1) {
    const result = await input.codex.sendMessage(input.threadId, message, {
      cwd: input.workflow.worktreePath,
      timeoutMs: CODEX_HANDOFF_TIMEOUT_MS,
    });

    if (result.completed.method === "turn/timeout") {
      console.log(
        warning(
          `[agsc] Codex handoff for issue #${input.issue.number} is still running after ${CODEX_HANDOFF_TIMEOUT_MS / 60_000} minutes; leaving the thread open for manual follow-up.`,
        ),
      );
      return;
    }

    await finalizeCodexWorktreeChanges(
      input.workflow,
      buildCodexAutoCommitMessage(input.workflow, "handoff"),
    );

    const gitState = await inspectCodexHandoffGitState(input.workflow);

    if (!gitState.needsContinuation) {
      console.log(
        success(
          `[agsc] Codex completed handoff for issue #${input.issue.number}: ${gitState.summary}.`,
        ),
      );
      return;
    }

    if (turnIndex === CODEX_HANDOFF_MAX_TURNS) {
      console.log(
        warning(
          `[agsc] Codex handoff for issue #${input.issue.number} stopped after ${turnIndex} turn(s), but still needs attention: ${gitState.summary}.`,
        ),
      );
      return;
    }

    console.log(
      warning(
        `[agsc] Codex stopped before finishing issue #${input.issue.number}; continuing turn ${turnIndex + 1}/${CODEX_HANDOFF_MAX_TURNS}: ${gitState.summary}.`,
      ),
    );
    message = buildCodexContinuationMessage(input.issue, input.workflow, gitState);
  }
}

async function runCodexPullRequestUpdateUntilGitSettles(input: {
  workflow: AGSCTrackedWorkflow;
  issueNumber: number;
  codex: CodexWorkflows;
  threadId: string;
  message: string;
}): Promise<void> {
  const startingHead = await getWorktreeHead(input.workflow.worktreePath);
  let message = input.message;

  for (let turnIndex = 1; turnIndex <= CODEX_HANDOFF_MAX_TURNS; turnIndex += 1) {
    const result = await input.codex.sendMessage(input.threadId, message, {
      cwd: input.workflow.worktreePath,
      timeoutMs: CODEX_HANDOFF_TIMEOUT_MS,
    });

    if (result.completed.method === "turn/timeout") {
      console.log(
        warning(
          `[agsc] Codex PR update for issue #${input.issueNumber} is still running after ${CODEX_HANDOFF_TIMEOUT_MS / 60_000} minutes; leaving the thread open for manual follow-up.`,
        ),
      );
      return;
    }

    await finalizeCodexWorktreeChanges(
      input.workflow,
      buildCodexAutoCommitMessage(input.workflow, "pull-request-update"),
    );

    const gitState = await inspectCodexPullRequestUpdateGitState(
      input.workflow,
      startingHead,
    );

    if (!gitState.needsContinuation) {
      console.log(
        success(
          `[agsc] Codex handled PR update for issue #${input.issueNumber}: ${gitState.summary}.`,
        ),
      );
      return;
    }

    if (turnIndex === CODEX_HANDOFF_MAX_TURNS) {
      console.log(
        warning(
          `[agsc] Codex PR update for issue #${input.issueNumber} stopped after ${turnIndex} turn(s), but still needs attention: ${gitState.summary}.`,
        ),
      );
      return;
    }

    console.log(
      warning(
        `[agsc] Codex stopped before finishing PR update for issue #${input.issueNumber}; continuing turn ${turnIndex + 1}/${CODEX_HANDOFF_MAX_TURNS}: ${gitState.summary}.`,
      ),
    );
    message = buildCodexPullRequestUpdateContinuationMessage(
      input.workflow,
      gitState,
    );
  }
}

function isRecoverableCodexSteerError(error: unknown): boolean {
  const message = formatError(error);

  return (
    message.includes("no active turn to steer") ||
    message.includes("missing field `expectedTurnId`") ||
    message.includes("missing field expectedTurnId")
  );
}

async function finalizeCodexWorktreeChanges(
  workflow: AGSCTrackedWorkflow,
  commitMessage: string,
): Promise<void> {
  const git = simpleGit({ baseDir: workflow.worktreePath });
  const status = await git.status();

  if (status.files.length > 0) {
    console.log(
      info(
        `[agsc] Issue #${workflow.issueNumber}: committing ${status.files.length} Codex worktree change(s).`,
      ),
    );
    await git.add(".");
    await git.raw([
      "-c",
      "user.name=AGSC",
      "-c",
      "user.email=agsc@example.invalid",
      "commit",
      "-m",
      commitMessage,
    ]);
  }

  const afterCommit = await git.status();

  if (afterCommit.ahead > 0) {
    console.log(
      info(
        `[agsc] Issue #${workflow.issueNumber}: pushing ${afterCommit.ahead} commit(s) to ${workflow.branchName}.`,
      ),
    );
    await git.raw(["push", "origin", workflow.branchName]);
  }
}

function buildCodexAutoCommitMessage(
  workflow: AGSCTrackedWorkflow,
  reason: CodexAutoCommitReason,
): string {
  if (reason === "pull-request-update") {
    return `chore(agsc): address PR feedback for issue #${workflow.issueNumber}`;
  }

  return `chore(agsc): address issue #${workflow.issueNumber}`;
}

function extractNotificationTurnId(
  notification: CodexNotification,
): string | undefined {
  const params = notification.params;

  if (!isRecord(params)) {
    return undefined;
  }

  if (typeof params.turnId === "string") {
    return params.turnId;
  }

  if (isRecord(params.turn) && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return undefined;
}

async function renameCodexThread(
  codex: CodexWorkflows,
  threadId: string,
  title: string,
): Promise<void> {
  try {
    await codex.renameChat(threadId, title);
  } catch {
    // Older app-server builds may not support explicit thread renaming.
  }
}

function closeCodexHandoff(issueId: number): void {
  const handoff = activeCodexHandoffs.get(issueId);

  if (!handoff) {
    return;
  }

  activeCodexHandoffs.delete(issueId);
  handoff.close();
}

async function cleanupClosedWorkflow(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
  stateStore: AGSCStateStore,
  reason: string,
): Promise<void> {
  console.log(
    warning(
      `[agsc] ${project.name} #${workflow.issueNumber}: ${reason}; removing worktree ${workflow.worktreePath}.`,
    ),
  );

  closeCodexHandoff(workflow.issueId);

  try {
    await project.git.git.raw([
      "worktree",
      "remove",
      "--force",
      workflow.worktreePath,
    ]);
  } catch {
    await rm(workflow.worktreePath, { recursive: true, force: true });
  }

  await project.git.git.raw(["worktree", "prune"]);
  await stateStore.removeWorkflow(workflow.issueId);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildCodexHandoffInstructions(
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  workflow: AGSCTrackedWorkflow,
): string {
  return [
    "You are assigned this AGSC GitHub issue and pull request.",
    "Work only inside the AGSC worktree path below.",
    "Fix the issue, run focused verification, commit your changes, and push to the PR branch if Git permissions allow it.",
    "If Git metadata permissions block commit or push, leave the verified changes in the worktree; AGSC will commit and push them.",
    "Begin immediately. Do not wait for another message.",
    "Do not only acknowledge the task or state a plan; start inspecting the repository and execute the work.",
    "Do not stop after summarizing or planning; continue through implementation unless blocked by a concrete external dependency.",
    "Keep the PR focused. If you cannot complete it, leave a clear status in your final response.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    `Issue URL: ${issue.html_url}`,
    "",
    "Issue description:",
    issue.body?.trim() || "_No issue description provided._",
    "",
    `Pull request #${pullRequest.number}: ${pullRequest.title}`,
    `Pull request URL: ${pullRequest.html_url}`,
    "",
    "Pull request description:",
    pullRequest.body?.trim() || "_No pull request description provided._",
    "",
    `PR branch: ${workflow.branchName}`,
    `Worktree: ${workflow.worktreePath}`,
  ].join("\n");
}

function createCodexHandoffWorkflows(projectRootPath: string): CodexWorkflows {
  return new CodexWorkflows(projectRootPath, CODEX_HANDOFF_OPTIONS);
}

function buildCodexInitialHandoffMessage(
  title: string,
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  workflow: AGSCTrackedWorkflow,
): string {
  return [
    title,
    "",
    buildCodexHandoffInstructions(issue, pullRequest, workflow),
  ].join("\n");
}

type CodexHandoffGitState = {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  hasWorkCommit: boolean;
  headChanged?: boolean;
  needsContinuation: boolean;
  summary: string;
};

async function inspectCodexHandoffGitState(
  workflow: AGSCTrackedWorkflow,
): Promise<CodexHandoffGitState> {
  const git = simpleGit({ baseDir: workflow.worktreePath });
  const [status, latestCommitSubject] = await Promise.all([
    git.status(),
    getLatestCommitSubject(workflow.worktreePath),
  ]);
  const hasUncommittedChanges = status.files.length > 0;
  const hasUnpushedCommits = status.ahead > 0;
  const hasWorkCommit = Boolean(
    latestCommitSubject && !isAGSCStarterCommit(latestCommitSubject),
  );

  return buildCodexHandoffGitState({
    hasUncommittedChanges,
    hasUnpushedCommits,
    hasWorkCommit,
    changedFileCount: status.files.length,
    aheadCount: status.ahead,
  });
}

function buildCodexHandoffGitState(input: {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  hasWorkCommit: boolean;
  changedFileCount: number;
  aheadCount: number;
}): CodexHandoffGitState {
  const reasons: string[] = [];

  if (input.hasUncommittedChanges) {
    reasons.push(`${input.changedFileCount} uncommitted file(s)`);
  }

  if (input.hasUnpushedCommits) {
    reasons.push(`${input.aheadCount} unpushed commit(s)`);
  }

  if (!input.hasWorkCommit) {
    reasons.push("PR branch has no non-starter work commit");
  }

  return {
    hasUncommittedChanges: input.hasUncommittedChanges,
    hasUnpushedCommits: input.hasUnpushedCommits,
    hasWorkCommit: input.hasWorkCommit,
    needsContinuation: reasons.length > 0,
    summary: reasons.length > 0 ? reasons.join("; ") : "branch has work commit, is clean, and is pushed",
  };
}

async function inspectCodexPullRequestUpdateGitState(
  workflow: AGSCTrackedWorkflow,
  startingHead: string | null,
): Promise<CodexHandoffGitState> {
  const git = simpleGit({ baseDir: workflow.worktreePath });
  const [status, currentHead, latestCommitSubject] = await Promise.all([
    git.status(),
    getWorktreeHead(workflow.worktreePath),
    getLatestCommitSubject(workflow.worktreePath),
  ]);
  const hasUncommittedChanges = status.files.length > 0;
  const hasUnpushedCommits = status.ahead > 0;
  const hasWorkCommit = Boolean(
    latestCommitSubject && !isAGSCStarterCommit(latestCommitSubject),
  );
  const headChanged = Boolean(
    startingHead && currentHead && startingHead !== currentHead,
  );

  return buildCodexPullRequestUpdateGitState({
    hasUncommittedChanges,
    hasUnpushedCommits,
    hasWorkCommit,
    headChanged,
    changedFileCount: status.files.length,
    aheadCount: status.ahead,
  });
}

function buildCodexPullRequestUpdateGitState(input: {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  hasWorkCommit: boolean;
  headChanged: boolean;
  changedFileCount: number;
  aheadCount: number;
}): CodexHandoffGitState {
  const reasons: string[] = [];

  if (input.hasUncommittedChanges) {
    reasons.push(`${input.changedFileCount} uncommitted file(s)`);
  }

  if (input.hasUnpushedCommits) {
    reasons.push(`${input.aheadCount} unpushed commit(s)`);
  }

  if (!input.hasWorkCommit) {
    reasons.push("PR branch has no non-starter work commit");
  }

  if (!input.headChanged) {
    reasons.push("PR branch did not advance after feedback");
  }

  return {
    hasUncommittedChanges: input.hasUncommittedChanges,
    hasUnpushedCommits: input.hasUnpushedCommits,
    hasWorkCommit: input.hasWorkCommit,
    headChanged: input.headChanged,
    needsContinuation: reasons.length > 0,
    summary: reasons.length > 0
      ? reasons.join("; ")
      : "feedback produced a new clean pushed commit",
  };
}

function buildCodexContinuationMessage(
  issue: GitHubIssue,
  workflow: AGSCTrackedWorkflow,
  gitState: CodexHandoffGitState,
): string {
  return [
    `Continue Issue #${issue.number}: ${issue.title}`,
    "",
    "AGSC detected that your previous turn ended before the PR was finished.",
    `Current Git state: ${gitState.summary}.`,
    "",
    "Continue from the existing worktree. Do not summarize only.",
    "Inspect the current files, finish the implementation, run focused verification, and commit/push if Git permissions allow it.",
    "If Git metadata permissions block commit or push, leave the verified changes in the worktree; AGSC will commit and push them.",
    "Only stop when the worktree is clean, the branch has advanced, and the branch is pushed.",
    "",
    `PR branch: ${workflow.branchName}`,
    `Worktree: ${workflow.worktreePath}`,
  ].join("\n");
}

function buildCodexPullRequestUpdateMessage(eventSummary: string): string {
  return [
    "A tracked GitHub PR changed.",
    "Review the new PR feedback below and update the existing PR branch accordingly.",
    "Do not only acknowledge the feedback. Inspect the worktree, make the requested fix, and run focused verification.",
    "Commit and push if Git permissions allow it. If Git metadata permissions block commit or push, leave the verified changes in the worktree; AGSC will commit and push them.",
    "",
    eventSummary,
  ].join("\n");
}

function buildCodexPullRequestUpdateContinuationMessage(
  workflow: AGSCTrackedWorkflow,
  gitState: CodexHandoffGitState,
): string {
  return [
    `Continue PR feedback for issue #${workflow.issueNumber}: ${workflow.issueTitle}`,
    "",
    "AGSC detected that your previous PR-feedback turn ended before the feedback was fully addressed.",
    `Current Git state: ${gitState.summary}.`,
    "",
    "Continue from the existing worktree. Make the requested feedback change, run focused verification, and commit/push if Git permissions allow it.",
    "If Git metadata permissions block commit or push, leave the verified changes in the worktree; AGSC will commit and push them.",
    "Only stop when the feedback has produced a new pushed commit and the worktree is clean.",
    "",
    `PR branch: ${workflow.branchName}`,
    `Worktree: ${workflow.worktreePath}`,
  ].join("\n");
}

async function getLatestCommitSubject(worktreePath: string): Promise<string | null> {
  try {
    return (
      await simpleGit({ baseDir: worktreePath }).raw([
        "log",
        "-1",
        "--format=%s",
      ])
    ).trim();
  } catch {
    return null;
  }
}

async function getWorktreeHead(worktreePath: string): Promise<string | null> {
  try {
    return (await simpleGit({ baseDir: worktreePath }).revparse(["HEAD"])).trim();
  } catch {
    return null;
  }
}

function isAGSCStarterCommit(subject: string): boolean {
  return subject.startsWith("chore(agsc): start ");
}

async function startClaudeWorkflow(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  github: GitHubApiClient,
): Promise<void> {
  const worktreeClaude = new ClaudeCodeWorkflows(project.rootPath);
  const title = buildPullRequestTitle(issue);
  const chat = await worktreeClaude.createChat({
    title,
  });

  await new AGSCStateStore(project.rootPath).upsertWorkflow({
    ...workflow,
    claudeSessionId: chat.sessionId,
    agentHandoffStartedAt: new Date().toISOString(),
  });

  console.log(
    success(
      `[agsc] Handed off PR #${pullRequest.number} / issue #${issue.number} to Claude session ${chat.sessionId}.`,
    ),
  );

  void chat
    .sendMessage(
      [title, "", buildCodexHandoffInstructions(issue, pullRequest, workflow)].join(
        "\n",
      ),
    )
    .catch((error: unknown) => {
      console.log(
        warning(
          `[agsc] Failed to hand off issue #${issue.number} to Claude: ${formatError(error)}`,
        ),
      );
    });
}

async function notifyAgentAboutPullRequestUpdate(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
  eventSummary: string,
): Promise<void> {
  if (workflow.agent !== "codex" || !workflow.codexThreadId) {
    if (workflow.agent === "claude" && workflow.claudeSessionId) {
      const worktreeClaude = new ClaudeCodeWorkflows(project.rootPath);
      const updateMessage = [
        "A tracked GitHub PR changed.",
        "Review and address this feedback:",
        "",
        eventSummary,
      ].join("\n");

      void worktreeClaude.continueChat(workflow.claudeSessionId, updateMessage);
    }

    return;
  }

  const projectCodex = createCodexHandoffWorkflows(project.rootPath);

  try {
    await projectCodex.resumeChat(workflow.codexThreadId);
    await runCodexPullRequestUpdateUntilGitSettles({
      workflow,
      issueNumber: workflow.issueNumber,
      codex: projectCodex,
      threadId: workflow.codexThreadId,
      message: buildCodexPullRequestUpdateMessage(eventSummary),
    });
  } finally {
    projectCodex.close();
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

export const __testing = {
  buildCodexHandoffInstructions,
  buildCodexHandoffGitState,
  buildCodexInitialHandoffMessage,
  buildCodexContinuationMessage,
  buildCodexPullRequestUpdateContinuationMessage,
  buildCodexPullRequestUpdateGitState,
  buildCodexPullRequestUpdateMessage,
  buildCodexAutoCommitMessage,
  CODEX_HANDOFF_PROMPT_VERSION,
  CODEX_HANDOFF_OPTIONS,
  createCodexHandoffWorkflows,
  buildInitialPullRequestBody,
  buildIssueBranchName,
  buildIssueWorktreePath,
  buildPullRequestTitle,
  extractCodexThreadIds,
  extractNotificationTurnId,
  findRegisteredWorktree,
  isLocalIssue,
  isRecoverableCodexSteerError,
  selectAgent,
  slugify,
  workflowNeedsAgentStart,
};
