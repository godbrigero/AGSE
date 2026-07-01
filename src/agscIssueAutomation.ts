import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import {
  removeCodexLocalThreadCatalogEntries,
  scrubCodexLocalThreadCatalog,
  upsertCodexLocalThreadCatalogEntry,
} from "./codexIntegration/threadCatalog.ts";
import {
  registerCodexWorkspaceRoot,
  resolveCodexHome,
  scrubCodexThreadWorkspaceReferences,
  scrubCodexWorkspaceRoots,
  unregisterCodexWorkspaceRoot,
} from "./codexIntegration/workspaceRoots.ts";
import { ClaudeCodeWorkflows } from "./claudeCodeIntegration/index.ts";
import {
  GitHubApiClient,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubPullRequest,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
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
const CODEX_HANDOFF_PROMPT_VERSION = 6;
const CODEX_HANDOFF_TIMEOUT_MS = 6 * 60 * 60_000;
const CODEX_PLANNING_TIMEOUT_MS = 20 * 60_000;
const CODEX_HANDOFF_MAX_TURNS = 4;
const CODEX_HANDOFF_OPTIONS: CodexWorkflowOptions = {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  experimentalApi: true,
  useDaemonProxy: true,
  useRemoteControlDaemon: false,
  requireDaemonProxy: true,
};
const activeCodexHandoffs = new Map<number, CodexWorkflows>();
const terminalCodexTurnStatuses = new Set(["interrupted", "failed", "cancelled"]);
type CodexThreadAvailability = "active" | "archived" | "missing" | "unknown";
let codexHandoffWorkflowFactory = (projectRootPath: string): CodexWorkflows =>
  new CodexWorkflows(projectRootPath, CODEX_HANDOFF_OPTIONS);
type CodexWorkspaceRootRegistrar = typeof registerCodexWorkspaceRoot;
let codexWorkspaceRootRegistrar: CodexWorkspaceRootRegistrar =
  registerCodexWorkspaceRoot;
type CodexWorkspaceRootUnregistrar = typeof unregisterCodexWorkspaceRoot;
let codexWorkspaceRootUnregistrar: CodexWorkspaceRootUnregistrar =
  unregisterCodexWorkspaceRoot;
type CodexWorkspaceRootScrubber = typeof scrubStaleCodexWorktreeProjects;
let codexWorkspaceRootScrubber: CodexWorkspaceRootScrubber =
  scrubStaleCodexWorktreeProjects;
type CodexAutoCommitReason = "handoff" | "pull-request-update";
const AGSC_IMPLEMENTATION_DONE_MARKER = "<!-- agsc:implementation-complete -->";
const AGSC_METADATA_OPEN = "<!-- agsc:metadata";
const AGSC_METADATA_CLOSE = "-->";

type AGSCPullRequestMetadata = {
  version: 1;
  issueId?: number;
  issueNumber: number;
  issueTitle?: string;
  issueUrl?: string;
  agent: AGSCAgentName;
  branchName: string;
  worktreePath?: string;
  codexThreadId?: string;
  codexPlanningTurnId?: string;
  codexImplementationTurnId?: string;
  codexActiveTurnId?: string;
  agentHandoffPhase?: AGSCTrackedWorkflow["agentHandoffPhase"];
  issueClosedByAGSCAt?: string;
};

type PullRequestEventSummary = {
  summary: string;
  eventIds: string[];
  issueCommentIds: number[];
  reviewCommentIds: number[];
  hasResponseRequiredComments: boolean;
  hasRequiredReviewChanges: boolean;
};

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
  const worktreePath = selectIssueWorktreePath(
    project.rootPath,
    issue,
    existing?.worktreePath,
  );
  const worktreePathChanged = Boolean(
    existing?.worktreePath && !samePath(existing.worktreePath, worktreePath),
  );
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
    agent: selectedAgent,
    branchName,
    worktreePath,
    baseBranch,
  });
  const issueClosedByAGSCAt =
    existing?.issueClosedByAGSCAt ??
    (await closeIssueForPullRequest({
      github,
      repository,
      issue,
      pullRequest,
    }));

  const workflow: AGSCTrackedWorkflow = {
    ...existing,
    ...(worktreePathChanged ? resetCodexSessionFields() : {}),
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
    issueClosedByAGSCAt,
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

    if (issue.state !== "open" && !workflow.issueClosedByAGSCAt) {
      await cleanupClosedWorkflow(project, workflow, stateStore, "issue closed");
      continue;
    }

    const migratedWorkflow = await migrateTrackedWorkflowWorktree(
      project,
      issue,
      workflow,
      stateStore,
    );
    const currentWorkflow = await validateTrackedAgentSession(
      project,
      migratedWorkflow,
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
      continue;
    }

    const workflowAfterCodexSync = await syncCodexImplementationStatus(
      project,
      repository,
      currentWorkflow,
      github,
    );

    const eventSummary = await buildPullRequestEventSummary(
      github,
      repository,
      workflowAfterCodexSync,
    );

    if (!eventSummary) {
      if (pullRequest.updated_at !== workflow.lastPullUpdatedAt) {
        await stateStore.upsertWorkflow({
          ...workflowAfterCodexSync,
          pullState: pullRequest.state,
          lastPullUpdatedAt: pullRequest.updated_at,
        });
      }
      continue;
    }

    try {
      const notificationResult = await notifyAgentAboutPullRequestUpdate(
        project,
        workflowAfterCodexSync,
        eventSummary,
      );
      await acknowledgePullRequestFeedbackEvents(
        github,
        repository,
        eventSummary,
      );
      await stateStore.upsertWorkflow({
        ...workflowAfterCodexSync,
        ...notificationResult,
        pullState: pullRequest.state,
        lastPullUpdatedAt: pullRequest.updated_at,
        lastSyncedPrEventAt: new Date().toISOString(),
        syncedPrEventIds: mergeSyncedEventIds(
          workflowAfterCodexSync.syncedPrEventIds,
          eventSummary.eventIds,
        ),
      });
    } catch (error) {
      console.log(
        warning(
          `[agsc] ${project.name} #${workflowAfterCodexSync.issueNumber}: failed to notify ${workflowAfterCodexSync.agent} about PR update; will retry next poll: ${formatError(error)}`,
        ),
      );
      continue;
    }
  }
}

export async function recoverTrackedPullRequests(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  github: GitHubApiClient,
): Promise<AGSCTrackedWorkflow[]> {
  const pullRequests = await github.listOpenPullRequests(repository);
  const stateStore = new AGSCStateStore(project.rootPath);
  const state = await stateStore.read();
  const closedWorkflowIssueIds = new Set(
    state.closedWorkflows.map((workflow) => workflow.issueId),
  );
  const recovered: AGSCTrackedWorkflow[] = [];

  for (const pullRequest of pullRequests) {
    const metadata = parsePullRequestMetadata(pullRequest.body);

    if (!metadata) {
      continue;
    }

    if (metadata.issueId && closedWorkflowIssueIds.has(metadata.issueId)) {
      continue;
    }

    if (
      state.workflows.some(
        (workflow) =>
          workflow.pullNumber === pullRequest.number ||
          workflow.issueNumber === metadata.issueNumber,
      )
    ) {
      continue;
    }

    const issue = await github.getIssue(repository, metadata.issueNumber);
    const worktreePath = selectIssueWorktreePath(
      project.rootPath,
      {
        number: metadata.issueNumber,
        title: metadata.issueTitle ?? issue.title,
      } as GitHubIssue,
      metadata.worktreePath,
    );
    const branchName = metadata.branchName || pullRequest.head.ref;
    const baseBranch = pullRequest.base.ref || (await getRemoteDefaultBranch(project.git.git));

    await ensureWorktree({
      git: project.git.git,
      projectRootPath: project.rootPath,
      worktreePath,
      branchName,
      baseBranch,
    });

    const workflow: AGSCTrackedWorkflow = {
      issueId: metadata.issueId ?? issue.id,
      issueNumber: metadata.issueNumber,
      issueTitle: metadata.issueTitle ?? issue.title,
      issueUrl: metadata.issueUrl ?? issue.html_url,
      agent: metadata.agent,
      worktreePath,
      branchName,
      pullNumber: pullRequest.number,
      pullUrl: pullRequest.html_url,
      pullState: pullRequest.state,
      codexThreadId: metadata.codexThreadId,
      codexPlanningTurnId: metadata.codexPlanningTurnId,
      codexImplementationTurnId: metadata.codexImplementationTurnId,
      codexActiveTurnId: metadata.codexActiveTurnId,
      agentHandoffPhase: metadata.agentHandoffPhase,
      issueClosedByAGSCAt: metadata.issueClosedByAGSCAt,
      agentHandoffVersion: metadata.codexThreadId
        ? CODEX_HANDOFF_PROMPT_VERSION
        : undefined,
      lastPullUpdatedAt: pullRequest.updated_at,
    };

    await stateStore.upsertWorkflow(workflow);
    recovered.push(workflow);
    console.log(
      success(
        `[agsc] Recovered ${project.name} PR #${pullRequest.number} for issue #${workflow.issueNumber} from PR metadata.`,
      ),
    );
  }

  return recovered;
}

async function validateTrackedAgentSession(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
  stateStore: AGSCStateStore,
): Promise<AGSCTrackedWorkflow> {
  if (workflow.agent !== "codex" || !workflow.codexThreadId) {
    return workflow;
  }

  const availability = await findCodexThreadAvailability(
    workflow.worktreePath,
    workflow.codexThreadId,
    workflow.issueId,
  );

  if (availability === "active" || availability === "unknown") {
    return workflow;
  }

  if (availability === "archived") {
    if (await restoreArchivedCodexThread(project, workflow)) {
      return workflow;
    }

    return workflow;
  }

  const nextWorkflow: AGSCTrackedWorkflow = {
    ...workflow,
    ...resetCodexSessionFields(),
  };

  console.log(
    warning(
      `[agsc] ${project.name} #${workflow.issueNumber}: Codex thread ${workflow.codexThreadId} is missing from the project; re-handing off.`,
    ),
  );
  await stateStore.upsertWorkflow(nextWorkflow);

  return nextWorkflow;
}

async function restoreArchivedCodexThread(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
): Promise<boolean> {
  if (!workflow.codexThreadId) {
    return false;
  }

  const activeCodex = activeCodexHandoffs.get(workflow.issueId);
  const codex = activeCodex ?? createCodexHandoffWorkflows(workflow.worktreePath);

  try {
    await codex.unarchiveChat(workflow.codexThreadId);
    await registerCodexWorktreeProject(
      project,
      workflow,
      workflow.codexThreadId,
      buildPullRequestTitle({
        number: workflow.issueNumber,
        title: workflow.issueTitle,
      } as GitHubIssue),
    );

    const restoredAvailability = await findCodexThreadAvailability(
      workflow.worktreePath,
      workflow.codexThreadId,
      workflow.issueId,
    );

    if (restoredAvailability !== "active" && restoredAvailability !== "unknown") {
      console.log(
        warning(
          `[agsc] ${project.name} #${workflow.issueNumber}: requested unarchive for Codex thread ${workflow.codexThreadId}, but it is still ${restoredAvailability}.`,
        ),
      );
      return false;
    }

    console.log(
      success(
        `[agsc] ${project.name} #${workflow.issueNumber}: unarchived Codex thread ${workflow.codexThreadId}.`,
      ),
    );
    return true;
  } catch (error) {
    console.log(
      warning(
        `[agsc] ${project.name} #${workflow.issueNumber}: Codex thread ${workflow.codexThreadId} is archived but could not be unarchived: ${formatError(error)}`,
      ),
    );
    return false;
  } finally {
    if (!activeCodex) {
      codex.close();
    }
  }
}

async function migrateTrackedWorkflowWorktree(
  project: AGSCProject,
  issue: GitHubIssue,
  workflow: AGSCTrackedWorkflow,
  stateStore: AGSCStateStore,
): Promise<AGSCTrackedWorkflow> {
  const worktreePath = selectIssueWorktreePath(
    project.rootPath,
    issue,
    workflow.worktreePath,
  );

  if (samePath(workflow.worktreePath, worktreePath)) {
    return workflow;
  }

  console.log(
    info(
      `[agsc] ${project.name} #${workflow.issueNumber}: migrating worktree to ${worktreePath}`,
    ),
  );
  await ensureWorktree({
    git: project.git.git,
    projectRootPath: project.rootPath,
    worktreePath,
    branchName: workflow.branchName,
    baseBranch: await getRemoteDefaultBranch(project.git.git),
  });

  const migratedWorkflow: AGSCTrackedWorkflow = {
    ...workflow,
    ...resetCodexSessionFields(),
    worktreePath,
  };
  await stateStore.upsertWorkflow(migratedWorkflow);

  return migratedWorkflow;
}

async function findCodexThreadAvailability(
  projectRootPath: string,
  threadId: string,
  issueId?: number,
): Promise<CodexThreadAvailability> {
  const activeCodex = issueId
    ? activeCodexHandoffs.get(issueId)
    : undefined;
  const codex = activeCodex ?? createCodexHandoffWorkflows(projectRootPath);

  try {
    const activeList = await codex.listChats({
      cwd: projectRootPath,
      sourceKinds: [],
      archived: false,
      limit: 50,
    });

    if (extractCodexThreadIds(activeList).has(threadId)) {
      return "active";
    }

    const archivedList = await codex.listChats({
      cwd: projectRootPath,
      sourceKinds: [],
      archived: true,
      limit: 50,
    });

    if (extractCodexThreadIds(archivedList).has(threadId)) {
      return "archived";
    }

    return "missing";
  } catch (error) {
    console.log(
      warning(
        `[agsc] Could not validate Codex thread ${threadId}: ${formatError(error)}`,
      ),
    );
    return "unknown";
  } finally {
    if (!activeCodex) {
      codex.close();
    }
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
  const rootKey = createHash("sha1")
    .update(`${resolve(projectRootPath)}:${issue.number}:${issue.title}`)
    .digest("hex")
    .slice(0, 4);

  return join(
    resolveCodexWorktreesRoot(),
    rootKey,
    `issue-${issue.number}-${slugify(issue.title)}`,
  );
}

function resolveCodexWorktreesRoot(): string {
  return (
    process.env.AGSE_CODEX_WORKTREES_ROOT?.trim() ||
    join(resolveCodexHome(), "worktrees")
  );
}

function buildLegacyIssueWorktreePath(
  projectRootPath: string,
  issue: GitHubIssue,
): string {
  return join(
    resolve(projectRootPath),
    ".agse",
    "worktrees",
    `issue-${issue.number}-${slugify(issue.title)}`,
  );
}

function selectIssueWorktreePath(
  projectRootPath: string,
  issue: GitHubIssue,
  existingWorktreePath?: string,
): string {
  if (
    existingWorktreePath &&
    !isLegacyIssueWorktreePath(projectRootPath, existingWorktreePath)
  ) {
    return existingWorktreePath;
  }

  return buildIssueWorktreePath(projectRootPath, issue);
}

function isLegacyIssueWorktreePath(
  projectRootPath: string,
  worktreePath: string,
): boolean {
  const legacyRoot = `${join(resolve(projectRootPath), ".agse", "worktrees")}/`;
  return `${resolve(worktreePath)}/`.startsWith(legacyRoot);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function resetCodexSessionFields(): Partial<AGSCTrackedWorkflow> {
  return {
    codexThreadId: undefined,
    codexPlanningTurnId: undefined,
    codexImplementationTurnId: undefined,
    codexActiveTurnId: undefined,
    codexLastPlan: undefined,
    codexImplementationStartedAt: undefined,
    codexImplementationCompletedAt: undefined,
    codexImplementationCommentedAt: undefined,
    agentHandoffStartedAt: undefined,
    agentHandoffVersion: undefined,
    agentHandoffPhase: undefined,
  };
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

  if (
    registeredWorktree &&
    resolve(registeredWorktree.path) === resolve(input.worktreePath) &&
    (await pathExists(registeredWorktree.path))
  ) {
    console.log(info(`[agsc] Reusing worktree ${input.worktreePath}`));
    return;
  }

  if (registeredWorktree && (await pathExists(registeredWorktree.path))) {
    await removeCleanMismatchedWorktree({
      git: input.git,
      registeredWorktree,
      targetWorktreePath: input.worktreePath,
      branchName: input.branchName,
    });
  } else if (registeredWorktree) {
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
    await fetchRemoteBranchWithOptionalGitHubToken(
      input.git,
      input.branchName,
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
  await pushWithOptionalGitHubToken(worktreeGit, [
    "-u",
    "origin",
    input.branchName,
  ]);
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

async function removeCleanMismatchedWorktree(input: {
  git: SimpleGit;
  registeredWorktree: RegisteredWorktree;
  targetWorktreePath: string;
  branchName: string;
}): Promise<void> {
  const status = await simpleGit({
    baseDir: input.registeredWorktree.path,
  }).status();

  if (!status.isClean()) {
    throw new Error(
      [
        `Cannot move AGSC worktree for ${input.branchName} to ${input.targetWorktreePath}.`,
        `Existing worktree has uncommitted changes: ${input.registeredWorktree.path}`,
      ].join(" "),
    );
  }

  console.log(
    info(
      `[agsc] Moving clean worktree for ${input.branchName} from ${input.registeredWorktree.path} to ${input.targetWorktreePath}`,
    ),
  );
  await input.git.raw([
    "worktree",
    "remove",
    "--force",
    input.registeredWorktree.path,
  ]);
}

async function ensurePullRequest(input: {
  github: GitHubApiClient;
  repository: GitHubRepositoryRef;
  issue: GitHubIssue;
  agent: AGSCAgentName;
  branchName: string;
  worktreePath: string;
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
    body: buildInitialPullRequestBody(input.issue, {
      version: 1,
      issueId: input.issue.id,
      issueNumber: input.issue.number,
      issueTitle: input.issue.title,
      issueUrl: input.issue.html_url,
      agent: input.agent,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
    }),
    head: input.branchName,
    base: input.baseBranch,
  });
}

async function closeIssueForPullRequest(input: {
  github: GitHubApiClient;
  repository: GitHubRepositoryRef;
  issue: GitHubIssue;
  pullRequest: GitHubPullRequest;
}): Promise<string | undefined> {
  if (input.issue.state !== "open") {
    return undefined;
  }

  try {
    await input.github.updateIssue(input.repository, input.issue.number, {
      state: "closed",
    });
    const closedAt = new Date().toISOString();
    console.log(
      success(
        `[agsc] Closed issue #${input.issue.number} after creating PR #${input.pullRequest.number}.`,
      ),
    );
    return closedAt;
  } catch (error) {
    console.log(
      warning(
        `[agsc] Could not close issue #${input.issue.number} after creating PR #${input.pullRequest.number}: ${formatError(error)}`,
      ),
    );
    return undefined;
  }
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
      console.log(
        warning(
          `[agsc] Codex handoff for issue #${workflow.issueNumber} uses an old prompt version; starting a fresh PR chat handoff.`,
        ),
      );
      await startCodexWorkflow(
        project,
        repository,
        {
          ...workflow,
          codexThreadId: undefined,
          codexPlanningTurnId: undefined,
          codexImplementationTurnId: undefined,
          codexActiveTurnId: undefined,
          codexLastPlan: undefined,
          agentHandoffStartedAt: undefined,
          agentHandoffPhase: undefined,
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

  const projectCodex = createCodexHandoffWorkflows(workflow.worktreePath);
  const title = buildPullRequestTitle(issue);
  await registerCodexWorktreeProject(project, workflow, undefined, title);
  const thread = await projectCodex.startChat({
    title,
    input: [],
    cwd: workflow.worktreePath,
    workspaceRoots: [workflow.worktreePath],
    runtimeWorkspaceRoots: [workflow.worktreePath],
    sandbox: CODEX_HANDOFF_OPTIONS.sandbox,
    approvalPolicy: CODEX_HANDOFF_OPTIONS.approvalPolicy,
    ephemeral: false,
    sessionStartSource: "startup",
    threadSource: "user",
    threadStartKind: "agse-pr-worktree",
  });
  await renameCodexThread(projectCodex, thread.id, title);
  await registerCodexThreadInLocalCatalog(thread.id, title, workflow);
  await registerCodexWorktreeProject(project, workflow, thread.id, title);
  await verifyCodexThreadIsDiscoverable(projectCodex, workflow, thread.id);
  await registerCodexWorktreeProject(project, workflow, thread.id, title);
  activeCodexHandoffs.set(workflow.issueId, projectCodex);

  await new AGSCStateStore(project.rootPath).upsertWorkflow({
    ...workflow,
    codexThreadId: thread.id,
    agentHandoffStartedAt: new Date().toISOString(),
    agentHandoffVersion: CODEX_HANDOFF_PROMPT_VERSION,
    agentHandoffPhase: "planning",
  });
  console.log(
    success(
      `[agsc] Created PR chat ${thread.id} for PR #${pullRequest.number} / issue #${issue.number}.`,
    ),
  );

  void runCodexPlanningAndImplementation({
    project,
    repository,
    workflow,
    issue,
    pullRequest,
    github,
    codex: projectCodex,
    threadId: thread.id,
  });
}

async function runCodexPlanningAndImplementation(input: {
  project: AGSCProject;
  repository: GitHubRepositoryRef;
  workflow: AGSCTrackedWorkflow;
  issue: GitHubIssue;
  pullRequest: GitHubPullRequest;
  github: GitHubApiClient;
  codex: CodexWorkflows;
  threadId: string;
}): Promise<void> {
  try {
    const planResultPromise = input.codex.sendMessage(
      input.threadId,
      buildPlanningPrompt(input.issue, input.pullRequest, input.workflow),
      {
        cwd: input.workflow.worktreePath,
        runtimeWorkspaceRoots: [input.workflow.worktreePath],
        timeoutMs: CODEX_PLANNING_TIMEOUT_MS,
      },
    );
    void planResultPromise.catch(() => undefined);
    await acknowledgePullRequestPlanningStarted(
      input.github,
      input.repository,
      input.pullRequest,
    );
    const planResult = await planResultPromise;

    const planTurnId = extractNotificationTurnId(planResult.completed);
    const plan = extractProposedPlan(planResult.finalResponse);
    let updatedPullRequest = await input.github.updatePullRequestBody(
      input.repository,
      input.pullRequest.number,
      buildPlannedPullRequestBody(
        input.issue,
        plan,
        buildPullRequestMetadata(input.issue, input.workflow, {
          codexThreadId: input.threadId,
          codexPlanningTurnId: planTurnId,
          agentHandoffPhase: "planning",
        }),
      ),
    );
    const implementation = await input.codex.startTurnDetached({
      threadId: input.threadId,
      input: buildImplementationPrompt(input.issue, updatedPullRequest, plan),
      cwd: input.workflow.worktreePath,
      runtimeWorkspaceRoots: [input.workflow.worktreePath],
      sandbox: CODEX_HANDOFF_OPTIONS.sandbox,
      approvalPolicy: CODEX_HANDOFF_OPTIONS.approvalPolicy,
    });
    updatedPullRequest = await input.github.updatePullRequestBody(
      input.repository,
      input.pullRequest.number,
      buildPlannedPullRequestBody(
        input.issue,
        plan,
        buildPullRequestMetadata(input.issue, input.workflow, {
          codexThreadId: input.threadId,
          codexPlanningTurnId: planTurnId,
          codexImplementationTurnId: implementation.turnId,
          codexActiveTurnId: implementation.turnId,
          agentHandoffPhase: "implementing",
        }),
      ),
    );

    await new AGSCStateStore(input.project.rootPath).upsertWorkflow({
      ...input.workflow,
      codexThreadId: input.threadId,
      codexPlanningTurnId: planTurnId,
      codexImplementationTurnId: implementation.turnId,
      codexActiveTurnId: implementation.turnId,
      codexLastPlan: plan,
      codexImplementationStartedAt: new Date().toISOString(),
      agentHandoffStartedAt: input.workflow.agentHandoffStartedAt ?? new Date().toISOString(),
      agentHandoffVersion: CODEX_HANDOFF_PROMPT_VERSION,
      agentHandoffPhase: "implementing",
      lastPullUpdatedAt: updatedPullRequest.updated_at,
    });
    console.log(
      success(
        `[agsc] Updated PR #${input.pullRequest.number} with Codex plan and started detached implementation turn ${implementation.turnId ?? "unknown"}.`,
      ),
    );
  } catch (error) {
    await new AGSCStateStore(input.project.rootPath).upsertWorkflow({
      ...input.workflow,
      codexThreadId: undefined,
      codexPlanningTurnId: undefined,
      codexImplementationTurnId: undefined,
      codexActiveTurnId: undefined,
      codexLastPlan: undefined,
      agentHandoffStartedAt: undefined,
      agentHandoffVersion: undefined,
      agentHandoffPhase: undefined,
    });
    console.log(
      warning(
        `[agsc] Failed to hand off issue #${input.issue.number} to Codex: ${formatError(error)}`,
      ),
    );
    closeCodexHandoff(input.workflow.issueId);
  }
}

async function acknowledgePullRequestPlanningStarted(
  github: GitHubApiClient,
  repository: GitHubRepositoryRef,
  pullRequest: GitHubPullRequest,
): Promise<void> {
  try {
    await github.addIssueReaction(repository, pullRequest.number, "eyes");
  } catch (error) {
    console.log(
      warning(
        `[agsc] Could not add eyes reaction to PR #${pullRequest.number}: ${formatError(error)}`,
      ),
    );
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
      runtimeWorkspaceRoots: [input.workflow.worktreePath],
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
      runtimeWorkspaceRoots: [input.workflow.worktreePath],
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

function isMissingCodexThreadError(error: unknown): boolean {
  return formatError(error).includes("thread not found");
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
    await pushWithOptionalGitHubToken(git, ["origin", workflow.branchName]);
  }
}

async function pushWithOptionalGitHubToken(
  git: SimpleGit,
  args: readonly string[],
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return git.raw(["push", ...args]);
  }

  const remoteIndex = args.indexOf("origin");
  const remoteUrl =
    remoteIndex >= 0 ? await getAuthenticatedOriginRemoteUrl(git, token) : null;

  if (!remoteUrl) {
    return git.raw(["push", ...args]);
  }

  return git.raw([
    "push",
    ...args.slice(0, remoteIndex),
    remoteUrl,
    ...args.slice(remoteIndex + 1),
  ]);
}

async function getAuthenticatedOriginRemoteUrl(
  git: SimpleGit,
  token: string,
): Promise<string | null> {
  try {
    const remoteUrl = await git.remote(["get-url", "origin"]);

    if (typeof remoteUrl !== "string") {
      return null;
    }

    return authenticatedGitHubRemoteUrl(
      remoteUrl.trim(),
      token,
    );
  } catch {
    return null;
  }
}

function authenticatedGitHubRemoteUrl(
  remoteUrl: string,
  token: string,
): string | null {
  const encodedToken = encodeURIComponent(token);
  const sshMatch = remoteUrl.match(
    /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  );

  if (sshMatch?.groups) {
    return `https://x-access-token:${encodedToken}@github.com/${sshMatch.groups.owner}/${sshMatch.groups.repo}.git`;
  }

  try {
    const url = new URL(remoteUrl);

    if (url.hostname !== "github.com") {
      return null;
    }

    url.username = "x-access-token";
    url.password = encodedToken;

    return url.toString();
  } catch {
    return null;
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

function closeAllCodexHandoffs(): void {
  for (const issueId of activeCodexHandoffs.keys()) {
    closeCodexHandoff(issueId);
  }
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

  await archiveCodexWorkflowThread(workflow);
  await deleteArchivedCodexWorkflowThread(workflow);
  closeCodexHandoff(workflow.issueId);
  await unregisterCodexWorktreeProject(workflow);

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

  await removeEmptyCodexWorktreeContainer(workflow.worktreePath);
  await project.git.git.raw(["worktree", "prune"]);
  await codexWorkspaceRootScrubber(project.rootPath);
  await stateStore.closeWorkflow(workflow, reason);
}

async function archiveCodexWorkflowThread(
  workflow: AGSCTrackedWorkflow,
): Promise<void> {
  if (!workflow.codexThreadId) {
    return;
  }

  const activeHandoff = activeCodexHandoffs.get(workflow.issueId);
  const codex = activeHandoff ?? createCodexHandoffWorkflows(workflow.worktreePath);

  try {
    await codex.archiveChat(workflow.codexThreadId);
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: Codex thread ${workflow.codexThreadId} could not be archived: ${formatError(error)}`,
      ),
    );
  } finally {
    if (!activeHandoff) {
      codex.close();
    }
  }
}

async function unregisterCodexWorktreeProject(
  workflow: AGSCTrackedWorkflow,
): Promise<void> {
  try {
    await codexWorkspaceRootUnregistrar({
      rootPath: workflow.worktreePath,
      threadId: workflow.codexThreadId,
    });
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: worktree was removed, but the Codex Desktop project entry could not be removed: ${formatError(error)}`,
      ),
    );
  }
}

async function deleteArchivedCodexWorkflowThread(
  workflow: AGSCTrackedWorkflow,
): Promise<void> {
  if (!workflow.codexThreadId) {
    return;
  }

  const activeHandoff = activeCodexHandoffs.get(workflow.issueId);
  const codex = activeHandoff ?? createCodexHandoffWorkflows(workflow.worktreePath);
  let deletedThread = false;

  try {
    await codex.deleteChat(workflow.codexThreadId);
    deletedThread = true;
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: archived Codex thread ${workflow.codexThreadId} could not be deleted from the local sidebar index: ${formatError(error)}`,
      ),
    );
  } finally {
    if (deletedThread) {
      await removeCodexThreadFromLocalCatalog(workflow);
    }

    if (!activeHandoff) {
      codex.close();
    }
  }
}

export async function scrubStaleCodexWorktreeProjects(
  projectRootPath: string = process.cwd(),
): Promise<string[]> {
  try {
    const removedRoots = await scrubCodexWorkspaceRoots({
      rootPathPrefix: resolveCodexWorktreesRoot(),
    });
    const catalogEntries = await scrubCodexLocalThreadCatalog({
      rootPathPrefix: resolveCodexWorktreesRoot(),
    });
    const threadReferences = await scrubCodexThreadWorkspaceReferences({
      rootPathPrefix: resolveCodexWorktreesRoot(),
      replacementRootPath: projectRootPath,
    });
    await deleteArchivedCodexThreadsFromSidebarIndex(
      projectRootPath,
      threadReferences.archivedThreadIds,
    );

    return [
      ...new Set([
        ...removedRoots,
        ...catalogEntries.removedRoots,
        ...threadReferences.removedRoots,
      ]),
    ];
  } catch (error) {
    console.log(
      warning(
        `[agsc] Codex Desktop stale worktree project scrub failed: ${formatError(error)}`,
      ),
    );
    return [];
  }
}

async function deleteArchivedCodexThreadsFromSidebarIndex(
  projectRootPath: string,
  threadIds: readonly string[],
): Promise<void> {
  const uniqueThreadIds = [...new Set(threadIds)].filter(Boolean);

  if (uniqueThreadIds.length === 0) {
    return;
  }

  const codex = createCodexHandoffWorkflows(projectRootPath);

  try {
    for (const threadId of uniqueThreadIds) {
      try {
        await codex.deleteChat(threadId);
      } catch (error) {
        console.log(
          warning(
            `[agsc] Codex Desktop stale archived thread ${threadId} could not be deleted from the local sidebar index: ${formatError(error)}`,
          ),
        );
      }
    }
  } finally {
    codex.close();
  }
}

async function removeEmptyCodexWorktreeContainer(
  worktreePath: string,
): Promise<void> {
  const codexWorktreesRoot = resolveCodexWorktreesRoot();
  const normalizedWorktreePath = resolve(worktreePath);
  const pathWithinCodexWorktrees = relative(
    codexWorktreesRoot,
    normalizedWorktreePath,
  );

  if (
    !pathWithinCodexWorktrees ||
    pathWithinCodexWorktrees.startsWith("..") ||
    isAbsolute(pathWithinCodexWorktrees)
  ) {
    return;
  }

  const containerPath = dirname(normalizedWorktreePath);

  if (containerPath === codexWorktreesRoot) {
    return;
  }

  try {
    await rmdir(containerPath);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTEMPTY")
    ) {
      return;
    }

    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return codexHandoffWorkflowFactory(projectRootPath);
}

async function registerCodexWorktreeProject(
  project: AGSCProject,
  workflow: AGSCTrackedWorkflow,
  threadId: string | undefined,
  title: string,
): Promise<void> {
  try {
    await codexWorkspaceRootRegistrar({
      rootPath: workflow.worktreePath,
      parentRootPath: project.rootPath,
      label: title,
      threadId,
    });
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: Codex thread was created, but the worktree could not be registered in the Codex sidebar: ${formatError(error)}`,
      ),
    );
  }
}

async function registerCodexThreadInLocalCatalog(
  threadId: string,
  title: string,
  workflow: AGSCTrackedWorkflow,
): Promise<void> {
  try {
    await upsertCodexLocalThreadCatalogEntry({
      threadId,
      title,
      cwd: workflow.worktreePath,
      sourceKind: "vscode",
      sourceDetail: "agse-pr-worktree",
      gitBranch: workflow.branchName,
    });
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: Codex thread ${threadId} was created, but the local Desktop thread catalog could not be updated: ${formatError(error)}`,
      ),
    );
  }
}

async function removeCodexThreadFromLocalCatalog(
  workflow: AGSCTrackedWorkflow,
): Promise<void> {
  if (!workflow.codexThreadId) {
    return;
  }

  try {
    await removeCodexLocalThreadCatalogEntries({
      threadIds: [workflow.codexThreadId],
    });
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: Codex thread ${workflow.codexThreadId} was deleted, but the local Desktop thread catalog could not be pruned: ${formatError(error)}`,
      ),
    );
  }
}

async function verifyCodexThreadIsDiscoverable(
  codex: CodexWorkflows,
  workflow: AGSCTrackedWorkflow,
  threadId: string,
): Promise<void> {
  try {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const list = await codex.listChats({
        cwd: workflow.worktreePath,
        sourceKinds: [],
        archived: false,
        limit: 50,
      });

      if (extractCodexThreadIds(list).has(threadId)) {
        return;
      }

      try {
        const read = await codex.readChat(threadId, { includeTurns: false });
        if (read.thread.id === threadId) {
          return;
        }
      } catch {
        // The Desktop app-server can lag briefly after background thread creation.
      }

      if (attempt < 30) {
        await sleep(1_000);
      }
    }

    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: Codex thread ${threadId} was created but did not appear in thread/list for ${workflow.worktreePath}.`,
      ),
    );
  } catch (error) {
    console.log(
      warning(
        `[agsc] Issue #${workflow.issueNumber}: could not verify Codex sidebar discoverability for thread ${threadId}: ${formatError(error)}`,
      ),
    );
  }
}

function setCodexHandoffWorkflowFactory(
  factory: (projectRootPath: string) => CodexWorkflows,
): () => void {
  const previousFactory = codexHandoffWorkflowFactory;
  codexHandoffWorkflowFactory = factory;

  return () => {
    closeAllCodexHandoffs();
    codexHandoffWorkflowFactory = previousFactory;
  };
}

function setCodexWorkspaceRootRegistrar(
  registrar: CodexWorkspaceRootRegistrar,
): () => void {
  const previousRegistrar = codexWorkspaceRootRegistrar;
  codexWorkspaceRootRegistrar = registrar;

  return () => {
    codexWorkspaceRootRegistrar = previousRegistrar;
  };
}

function setCodexWorkspaceRootUnregistrar(
  unregistrar: CodexWorkspaceRootUnregistrar,
): () => void {
  const previousUnregistrar = codexWorkspaceRootUnregistrar;
  codexWorkspaceRootUnregistrar = unregistrar;

  return () => {
    codexWorkspaceRootUnregistrar = previousUnregistrar;
  };
}

function setCodexWorkspaceRootScrubber(
  scrubber: CodexWorkspaceRootScrubber,
): () => void {
  const previousScrubber = codexWorkspaceRootScrubber;
  codexWorkspaceRootScrubber = scrubber;

  return () => {
    codexWorkspaceRootScrubber = previousScrubber;
  };
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

function buildCodexPullRequestUpdateMessage(
  eventSummary: PullRequestEventSummary,
): string {
  return [
    "A tracked GitHub PR changed.",
    ...buildPullRequestUpdateInstructionLines(eventSummary),
    "",
    eventSummary.summary,
  ].join("\n");
}

function buildClaudePullRequestUpdateMessage(
  eventSummary: PullRequestEventSummary,
): string {
  return [
    "A tracked GitHub PR changed.",
    ...buildPullRequestUpdateInstructionLines(eventSummary),
    "",
    eventSummary.summary,
  ].join("\n");
}

function buildPullRequestUpdateInstructionLines(
  eventSummary: PullRequestEventSummary,
): string[] {
  const lines: string[] = [];

  if (eventSummary.hasRequiredReviewChanges) {
    lines.push(
      "Review feedback from the GitHub review flow is present; making the requested code changes is required.",
      "Inspect the worktree, implement the requested fixes, run focused verification, and commit/push if Git permissions allow it.",
      "If Git metadata permissions block commit or push, leave the verified changes in the worktree; AGSC will commit and push them.",
    );
  }

  if (eventSummary.hasResponseRequiredComments) {
    lines.push(
      "Ordinary PR comments are also present; a response to each new comment is required.",
      "Code changes for ordinary PR comments are optional and should only be made when the comment requests or clearly requires them.",
      "If no code change is needed for an ordinary PR comment, answer the comment in the GitHub PR conversation instead of inventing a code change.",
    );
  }

  if (lines.length === 0) {
    lines.push(
      "Review the new PR feedback and respond appropriately.",
      "Make code changes only when the feedback requests or clearly requires them.",
    );
  }

  return lines;
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
  eventSummary: PullRequestEventSummary,
): Promise<Partial<AGSCTrackedWorkflow>> {
  if (workflow.agent !== "codex" || !workflow.codexThreadId) {
    if (workflow.agent === "claude" && workflow.claudeSessionId) {
      const worktreeClaude = new ClaudeCodeWorkflows(project.rootPath);
      const updateMessage = buildClaudePullRequestUpdateMessage(eventSummary);

      void worktreeClaude.continueChat(workflow.claudeSessionId, updateMessage);
    }

    return {};
  }

  const activeCodex = activeCodexHandoffs.get(workflow.issueId);
  const projectCodex = activeCodex ?? createCodexHandoffWorkflows(workflow.worktreePath);
  const message = buildCodexPullRequestUpdateMessage(eventSummary);
  let keepCodexOpen = Boolean(activeCodex);

  try {
    await projectCodex.resumeChat(workflow.codexThreadId);

    if (workflow.codexActiveTurnId) {
      try {
        await projectCodex.steerMessage(workflow.codexThreadId, message, {
          expectedTurnId: workflow.codexActiveTurnId,
        });
        return {};
      } catch (error) {
        if (!isRecoverableCodexSteerError(error)) {
          throw error;
        }
      }
    }

    const followUp = await projectCodex.startTurnDetached({
      threadId: workflow.codexThreadId,
      input: message,
      cwd: workflow.worktreePath,
      runtimeWorkspaceRoots: [workflow.worktreePath],
      sandbox: CODEX_HANDOFF_OPTIONS.sandbox,
      approvalPolicy: CODEX_HANDOFF_OPTIONS.approvalPolicy,
    });
    activeCodexHandoffs.set(workflow.issueId, projectCodex);
    keepCodexOpen = true;

    return {
      codexImplementationTurnId: followUp.turnId,
      codexActiveTurnId: followUp.turnId,
      codexImplementationStartedAt: new Date().toISOString(),
      codexImplementationCompletedAt: undefined,
      codexImplementationCommentedAt: undefined,
      agentHandoffPhase: "implementing",
    };
  } catch (error) {
    if (!isMissingCodexThreadError(error)) {
      throw error;
    }

    await new AGSCStateStore(project.rootPath).upsertWorkflow({
      ...workflow,
      ...resetCodexSessionFields(),
    });

    if (activeCodex) {
      closeCodexHandoff(workflow.issueId);
      keepCodexOpen = true;
    }

    throw error;
  } finally {
    if (!keepCodexOpen) {
      projectCodex.close();
    }
  }
}

async function syncCodexImplementationStatus(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
  github: GitHubApiClient,
): Promise<AGSCTrackedWorkflow> {
  if (
    workflow.agent !== "codex" ||
    !workflow.codexThreadId ||
    !workflow.codexActiveTurnId
  ) {
    return workflow;
  }

  const activeCodex = activeCodexHandoffs.get(workflow.issueId);
  const projectCodex = activeCodex ?? createCodexHandoffWorkflows(workflow.worktreePath);
  let keepCodexOpen = Boolean(activeCodex);

  try {
    const thread = await projectCodex.readChat(workflow.codexThreadId, {
      includeTurns: true,
    });
    const turnStatus = extractTurnStatus(thread.raw, workflow.codexActiveTurnId);

    if (turnStatus && terminalCodexTurnStatuses.has(turnStatus)) {
      const gitState = await inspectCodexHandoffGitState(workflow);
      const recovery = await projectCodex.startTurnDetached({
        threadId: workflow.codexThreadId,
        input: buildCodexContinuationMessage(
          {
            number: workflow.issueNumber,
            title: workflow.issueTitle,
          } as GitHubIssue,
          workflow,
          gitState,
        ),
        cwd: workflow.worktreePath,
        runtimeWorkspaceRoots: [workflow.worktreePath],
        sandbox: CODEX_HANDOFF_OPTIONS.sandbox,
        approvalPolicy: CODEX_HANDOFF_OPTIONS.approvalPolicy,
      });
      const nextWorkflow: AGSCTrackedWorkflow = {
        ...workflow,
        codexImplementationTurnId:
          recovery.turnId ?? workflow.codexImplementationTurnId,
        codexActiveTurnId: recovery.turnId,
        agentHandoffPhase: recovery.turnId ? "implementing" : "idle",
      };

      if (recovery.turnId) {
        activeCodexHandoffs.set(workflow.issueId, projectCodex);
        keepCodexOpen = true;
      }

      await new AGSCStateStore(project.rootPath).upsertWorkflow(nextWorkflow);
      console.log(
        warning(
          `[agsc] ${project.name} #${workflow.issueNumber}: Codex turn ${workflow.codexActiveTurnId} ended as ${turnStatus}; started recovery turn ${recovery.turnId ?? "unknown"}.`,
        ),
      );
      return nextWorkflow;
    }

    if (turnStatus !== "completed") {
      return workflow;
    }

    await finalizeCodexWorktreeChanges(
      workflow,
      buildCodexAutoCommitMessage(workflow, "handoff"),
    );
    const gitState = await inspectCodexHandoffGitState(workflow);

    if (gitState.needsContinuation) {
      const recovery = await projectCodex.startTurnDetached({
        threadId: workflow.codexThreadId,
        input: buildCodexContinuationMessage(
          {
            number: workflow.issueNumber,
            title: workflow.issueTitle,
          } as GitHubIssue,
          workflow,
          gitState,
        ),
        cwd: workflow.worktreePath,
        runtimeWorkspaceRoots: [workflow.worktreePath],
        sandbox: CODEX_HANDOFF_OPTIONS.sandbox,
        approvalPolicy: CODEX_HANDOFF_OPTIONS.approvalPolicy,
      });
      const nextWorkflow: AGSCTrackedWorkflow = {
        ...workflow,
        codexImplementationTurnId:
          recovery.turnId ?? workflow.codexImplementationTurnId,
        codexActiveTurnId: recovery.turnId,
        agentHandoffPhase: recovery.turnId ? "implementing" : "idle",
      };

      if (recovery.turnId) {
        activeCodexHandoffs.set(workflow.issueId, projectCodex);
        keepCodexOpen = true;
      }

      await new AGSCStateStore(project.rootPath).upsertWorkflow(nextWorkflow);
      console.log(
        warning(
          `[agsc] ${project.name} #${workflow.issueNumber}: Codex turn completed but PR branch is not finished: ${gitState.summary}. Started recovery turn ${recovery.turnId ?? "unknown"}.`,
        ),
      );
      return nextWorkflow;
    }

    let nextWorkflow: AGSCTrackedWorkflow = {
      ...workflow,
      codexImplementationTurnId:
        workflow.codexActiveTurnId ?? workflow.codexImplementationTurnId,
      codexActiveTurnId: undefined,
      codexImplementationCompletedAt:
        workflow.codexImplementationCompletedAt ?? new Date().toISOString(),
      agentHandoffPhase: "idle",
    };

    if (workflow.pullNumber) {
      const pullRequest = await github.getPullRequest(
        repository,
        workflow.pullNumber,
      );
      await github.updatePullRequestBody(
        repository,
        workflow.pullNumber,
        withPullRequestMetadata(
          stripPullRequestMetadata(pullRequest.body),
          buildPullRequestMetadataFromWorkflow(nextWorkflow),
        ),
      );
    }

    if (!workflow.codexImplementationCommentedAt && workflow.pullNumber) {
      await github.addIssueComment(
        repository,
        workflow.pullNumber,
        buildImplementationCompleteComment(workflow),
      );
      nextWorkflow = {
        ...nextWorkflow,
        codexImplementationCommentedAt: new Date().toISOString(),
      };
    }

    await new AGSCStateStore(project.rootPath).upsertWorkflow(nextWorkflow);
    if (activeCodex) {
      closeCodexHandoff(workflow.issueId);
      keepCodexOpen = true;
    }
    return nextWorkflow;
  } catch (error) {
    console.log(
      warning(
        `[agsc] ${project.name} #${workflow.issueNumber}: failed to inspect Codex turn ${workflow.codexActiveTurnId}: ${formatError(error)}`,
      ),
    );
    return workflow;
  } finally {
    if (!keepCodexOpen) {
      projectCodex.close();
    }
  }
}

async function buildPullRequestEventSummary(
  github: GitHubApiClient,
  repository: GitHubRepositoryRef,
  workflow: AGSCTrackedWorkflow,
): Promise<PullRequestEventSummary | null> {
  const [comments, reviews, reviewComments] = await Promise.all([
    github.listIssueComments(repository, workflow.pullNumber ?? 0),
    github.listPullRequestReviews(repository, workflow.pullNumber ?? 0),
    github.listPullRequestReviewComments(repository, workflow.pullNumber ?? 0),
  ]);
  const synced = new Set(workflow.syncedPrEventIds ?? []);
  const events = [
    ...comments
      .filter((comment) => !isAGSCComment(comment.body))
      .map((comment) => ({
        id: `comment:${comment.id}`,
        issueCommentId: comment.id,
        reviewCommentId: undefined,
        kind: "comment" as const,
        updatedAt: comment.updated_at,
        summary: formatPullRequestComment(comment),
      })),
    ...reviews
      .filter((review) => review.body)
      .map((review) => ({
        id: `review:${review.id}`,
        issueCommentId: undefined,
        reviewCommentId: undefined,
        kind: "review" as const,
        updatedAt: review.submitted_at ?? "",
        summary: formatPullRequestReview(review),
      })),
    ...reviewComments.map((comment) => ({
      id: `review-comment:${comment.id}`,
      issueCommentId: undefined,
      reviewCommentId: comment.id,
      kind: "review" as const,
      updatedAt: comment.updated_at,
      summary: formatPullRequestReviewComment(comment),
    })),
  ]
    .filter((event) => !synced.has(event.id))
    .sort(
      (left, right) =>
        new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime(),
    );

  if (events.length === 0) {
    return null;
  }

  return {
    summary: events.map((event) => event.summary).join("\n\n---\n\n"),
    eventIds: events.map((event) => event.id),
    issueCommentIds: events
      .map((event) => event.issueCommentId)
      .filter((commentId): commentId is number => typeof commentId === "number"),
    reviewCommentIds: events
      .map((event) => event.reviewCommentId)
      .filter((commentId): commentId is number => typeof commentId === "number"),
    hasResponseRequiredComments: events.some((event) => event.kind === "comment"),
    hasRequiredReviewChanges: events.some((event) => event.kind === "review"),
  };
}

async function acknowledgePullRequestFeedbackEvents(
  github: GitHubApiClient,
  repository: GitHubRepositoryRef,
  eventSummary: PullRequestEventSummary,
): Promise<void> {
  for (const commentId of eventSummary.issueCommentIds) {
    await github.addIssueCommentReaction(repository, commentId, "eyes");
  }

  for (const commentId of eventSummary.reviewCommentIds) {
    await github.addPullRequestReviewCommentReaction(repository, commentId, "eyes");
  }
}

function formatPullRequestComment(comment: GitHubIssueComment): string {
  return [
    `Comment by ${comment.user?.login ?? "unknown"} at ${comment.updated_at}:`,
    comment.body ?? "",
    comment.html_url,
  ].join("\n");
}

function formatPullRequestReview(review: GitHubPullRequestReview): string {
  return [
    `Review ${review.state} by ${review.user?.login ?? "unknown"} at ${review.submitted_at ?? "unknown"}:`,
    review.body ?? "",
    review.html_url,
  ].join("\n");
}

function formatPullRequestReviewComment(
  comment: GitHubPullRequestReviewComment,
): string {
  const location = formatPullRequestReviewCommentLocation(comment);

  return [
    `Review comment by ${comment.user?.login ?? "unknown"} at ${comment.updated_at}${location ? ` on ${location}` : ""}:`,
    comment.body ?? "",
    comment.html_url,
  ].join("\n");
}

function formatPullRequestReviewCommentLocation(
  comment: GitHubPullRequestReviewComment,
): string {
  const path = comment.path?.trim();
  const line = comment.line ?? comment.original_line;

  if (!path) {
    return "";
  }

  return typeof line === "number" ? `${path}:${line}` : path;
}

function mergeSyncedEventIds(
  current: readonly string[] | undefined,
  next: readonly string[],
): string[] {
  return [...new Set([...(current ?? []), ...next])];
}

function isAGSCComment(body: string | null): boolean {
  return Boolean(body?.includes(AGSC_IMPLEMENTATION_DONE_MARKER));
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
  const output = await lsRemoteHeadsWithOptionalGitHubToken(git, branchName);

  return output.trim().length > 0;
}

async function lsRemoteHeadsWithOptionalGitHubToken(
  git: SimpleGit,
  branchName: string,
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return git.raw(["ls-remote", "--heads", "origin", branchName]);
  }

  const remoteUrl = await getAuthenticatedOriginRemoteUrl(git, token);

  return git.raw([
    "ls-remote",
    "--heads",
    remoteUrl ?? "origin",
    branchName,
  ]);
}

async function fetchRemoteBranchWithOptionalGitHubToken(
  git: SimpleGit,
  branchName: string,
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  const refspec = `refs/heads/${branchName}:refs/remotes/origin/${branchName}`;

  if (!token) {
    return git.raw(["fetch", "origin", refspec]);
  }

  const remoteUrl = await getAuthenticatedOriginRemoteUrl(git, token);

  return git.raw(["fetch", remoteUrl ?? "origin", refspec]);
}

function buildPullRequestTitle(issue: GitHubIssue): string {
  return `Issue #${issue.number}: ${issue.title}`;
}

function buildInitialPullRequestBody(
  issue: GitHubIssue,
  metadata?: AGSCPullRequestMetadata,
): string {
  const body = [
    `## Issue`,
    ``,
    `Closes #${issue.number}`,
    ``,
    issue.body?.trim() || "_No issue description provided._",
  ].join("\n");

  return metadata ? withPullRequestMetadata(body, metadata) : body;
}

function buildPlanningPrompt(
  issue: GitHubIssue,
  pullRequest: GitHubPullRequest,
  workflow: AGSCTrackedWorkflow,
): string {
  return [
    "You are working inside an AGSC-created Git worktree for a GitHub issue.",
    "This first turn is planning only. Do not edit files, commit, push, or run mutating commands.",
    "Explore the repository with read-only commands and produce a decision-complete implementation plan.",
    "Your final answer must contain exactly one <proposed_plan> block. AGSC will copy that block into the PR body.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    `Issue URL: ${issue.html_url}`,
    "",
    "Issue description:",
    issue.body?.trim() || "_No issue description provided._",
    "",
    `Pull request #${pullRequest.number}: ${pullRequest.html_url}`,
    `PR branch: ${workflow.branchName}`,
    `Worktree: ${workflow.worktreePath}`,
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
    "When finished, leave a concise final response that states what changed and which verification ran.",
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

function buildPlannedPullRequestBody(
  issue: GitHubIssue,
  plan: string,
  metadata?: AGSCPullRequestMetadata,
): string {
  const body = [
    stripPullRequestMetadata(buildInitialPullRequestBody(issue)).trimEnd(),
    "",
    "## Codex Plan",
    "",
    plan.trim() || "_Codex did not produce a plan._",
  ].join("\n");

  return metadata ? withPullRequestMetadata(body, metadata) : body;
}

function buildPullRequestMetadata(
  issue: GitHubIssue,
  workflow: AGSCTrackedWorkflow,
  overrides: Partial<AGSCPullRequestMetadata> = {},
): AGSCPullRequestMetadata {
  return compactPullRequestMetadata({
    version: 1,
    issueId: issue.id,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    agent: workflow.agent,
    branchName: workflow.branchName,
    worktreePath: workflow.worktreePath,
    codexThreadId: workflow.codexThreadId,
    codexPlanningTurnId: workflow.codexPlanningTurnId,
    codexImplementationTurnId: workflow.codexImplementationTurnId,
    codexActiveTurnId: workflow.codexActiveTurnId,
    agentHandoffPhase: workflow.agentHandoffPhase,
    issueClosedByAGSCAt: workflow.issueClosedByAGSCAt,
    ...overrides,
  });
}

function buildPullRequestMetadataFromWorkflow(
  workflow: AGSCTrackedWorkflow,
  overrides: Partial<AGSCPullRequestMetadata> = {},
): AGSCPullRequestMetadata {
  return compactPullRequestMetadata({
    version: 1,
    issueId: workflow.issueId,
    issueNumber: workflow.issueNumber,
    issueTitle: workflow.issueTitle,
    issueUrl: workflow.issueUrl,
    agent: workflow.agent,
    branchName: workflow.branchName,
    worktreePath: workflow.worktreePath,
    codexThreadId: workflow.codexThreadId,
    codexPlanningTurnId: workflow.codexPlanningTurnId,
    codexImplementationTurnId: workflow.codexImplementationTurnId,
    codexActiveTurnId: workflow.codexActiveTurnId,
    agentHandoffPhase: workflow.agentHandoffPhase,
    issueClosedByAGSCAt: workflow.issueClosedByAGSCAt,
    ...overrides,
  });
}

function compactPullRequestMetadata(
  metadata: AGSCPullRequestMetadata,
): AGSCPullRequestMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  ) as AGSCPullRequestMetadata;
}

function withPullRequestMetadata(
  body: string,
  metadata: AGSCPullRequestMetadata,
): string {
  return [
    stripPullRequestMetadata(body).trimEnd(),
    "",
    AGSC_METADATA_OPEN,
    JSON.stringify(metadata),
    AGSC_METADATA_CLOSE,
  ].join("\n");
}

function stripPullRequestMetadata(body: string | null): string {
  if (!body) {
    return "";
  }

  const pattern = new RegExp(
    `\\n?${escapeRegExp(AGSC_METADATA_OPEN)}\\s*[\\s\\S]*?\\s*${escapeRegExp(AGSC_METADATA_CLOSE)}\\s*$`,
  );

  return body.replace(pattern, "").trimEnd();
}

function parsePullRequestMetadata(
  body: string | null,
): AGSCPullRequestMetadata | null {
  if (!body) {
    return null;
  }

  const pattern = new RegExp(
    `${escapeRegExp(AGSC_METADATA_OPEN)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(AGSC_METADATA_CLOSE)}`,
  );
  const match = body.match(pattern);

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1] ?? "") as Partial<AGSCPullRequestMetadata>;

    if (
      parsed.version !== 1 ||
      typeof parsed.issueNumber !== "number" ||
      (parsed.agent !== "codex" && parsed.agent !== "claude") ||
      typeof parsed.branchName !== "string"
    ) {
      return null;
    }

    return parsed as AGSCPullRequestMetadata;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractProposedPlan(response: string): string {
  const match = response.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/);

  return match ? match[1].trim() : response.trim();
}

function buildImplementationCompleteComment(
  workflow: AGSCTrackedWorkflow,
): string {
  const implementationTurnId =
    workflow.codexActiveTurnId ?? workflow.codexImplementationTurnId ?? "unknown";

  return [
    AGSC_IMPLEMENTATION_DONE_MARKER,
    `AGSC completed the Codex implementation pass for issue #${workflow.issueNumber}.`,
    "",
    `Codex thread: ${workflow.codexThreadId ?? "unknown"}`,
    `Implementation turn: ${implementationTurnId}`,
  ].join("\n");
}

function extractTurnStatus(value: unknown, turnId: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.id === "string" && value.id === turnId) {
    return typeof value.status === "string" ? value.status : null;
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const status = extractTurnStatus(entry, turnId);

        if (status) {
          return status;
        }
      }
      continue;
    }

    if (isRecord(nested)) {
      const status = extractTurnStatus(nested, turnId);

      if (status) {
        return status;
      }
    }
  }

  return null;
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
  buildClaudePullRequestUpdateMessage,
  buildCodexAutoCommitMessage,
  buildImplementationCompleteComment,
  buildPullRequestMetadata,
  buildPullRequestMetadataFromWorkflow,
  CODEX_HANDOFF_PROMPT_VERSION,
  CODEX_HANDOFF_OPTIONS,
  createCodexHandoffWorkflows,
  findCodexThreadAvailability,
  setCodexHandoffWorkflowFactory,
  closeAllCodexHandoffs,
  setCodexWorkspaceRootRegistrar,
  setCodexWorkspaceRootUnregistrar,
  setCodexWorkspaceRootScrubber,
  buildPlannedPullRequestBody,
  buildPlanningPrompt,
  buildImplementationPrompt,
  buildInitialPullRequestBody,
  buildIssueBranchName,
  buildIssueWorktreePath,
  buildLegacyIssueWorktreePath,
  resolveCodexWorktreesRoot,
  scrubStaleCodexWorktreeProjects,
  buildPullRequestTitle,
  extractProposedPlan,
  extractTurnStatus,
  isMissingCodexThreadError,
  parsePullRequestMetadata,
  stripPullRequestMetadata,
  withPullRequestMetadata,
  formatPullRequestComment,
  formatPullRequestReview,
  formatPullRequestReviewComment,
  extractCodexThreadIds,
  extractNotificationTurnId,
  findRegisteredWorktree,
  isLocalIssue,
  isAGSCComment,
  mergeSyncedEventIds,
  isRecoverableCodexSteerError,
  selectAgent,
  slugify,
  workflowNeedsAgentStart,
};
