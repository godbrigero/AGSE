import type { AGSCProject, AGSCWorkspace } from "./agscWorkspace.ts";
import {
  handleGitHubIssueForProject,
  recoverTrackedPullRequests,
  syncTrackedPullRequests,
} from "./agscIssueAutomation.ts";
import {
  GitHubApiClient,
  parseGitHubRemoteUrl,
  type GitHubIssue,
  type GitHubRepositoryRef,
  type GitHubUser,
} from "./githubApi.ts";
import {
  DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS,
  GitHubWebhookRelaySubscriber,
  type GitHubWebhookRelayEvent,
} from "./githubWebhookRelay.ts";
import { AGSCStateStore } from "./agscState.ts";
import { errorMessage, info, style, success, warning } from "./terminalStyle.ts";

export type GitHubIssuePollerOptions = {
  intervalMs?: number;
  token?: string;
  now?: () => Date;
  webhookEvents?: readonly string[];
  createWebhookSubscriber?: (
    options: GitHubIssueWebhookSubscriberOptions,
  ) => GitHubIssueWebhookSubscriber;
};

export type GitHubIssueWebhookSubscriberOptions = {
  github: GitHubApiClient;
  repository: GitHubRepositoryRef;
  token: string;
  events: readonly string[];
  onEvent: (event: GitHubWebhookRelayEvent) => void;
  onError: (error: Error) => void;
};

export type GitHubIssueWebhookSubscriber = {
  start(): Promise<void>;
  stop(): void;
};

type ProjectIssuePollState = {
  project: AGSCProject;
  repository: GitHubRepositoryRef;
  seenIssueIds: Set<number>;
  isPolling: boolean;
  pollAgainRequested: boolean;
};

export class GitHubIssuePoller {
  private readonly states: ProjectIssuePollState[];
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly github: GitHubApiClient;
  private readonly localUser: GitHubUser | null;
  private readonly token?: string;
  private readonly webhookEvents: readonly string[];
  private readonly createWebhookSubscriber: (
    options: GitHubIssueWebhookSubscriberOptions,
  ) => GitHubIssueWebhookSubscriber;
  private readonly webhookSubscribers: GitHubIssueWebhookSubscriber[] = [];
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    states: ProjectIssuePollState[],
    github: GitHubApiClient,
    localUser: GitHubUser | null,
    token: string | undefined,
    options: GitHubIssuePollerOptions = {},
  ) {
    this.states = states;
    this.intervalMs = options.intervalMs ?? 20_000;
    this.now = options.now ?? (() => new Date());
    this.github = github;
    this.localUser = localUser;
    this.token = token;
    this.webhookEvents = options.webhookEvents ?? DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS;
    this.createWebhookSubscriber =
      options.createWebhookSubscriber ??
      ((subscriberOptions) => new GitHubWebhookRelaySubscriber(subscriberOptions));
  }

  static async fromWorkspace(
    workspace: AGSCWorkspace,
    options: GitHubIssuePollerOptions = {},
  ): Promise<GitHubIssuePoller> {
    const states: ProjectIssuePollState[] = [];
    const token = options.token ?? process.env.GITHUB_TOKEN;
    const github = new GitHubApiClient(token);
    const localUser = await getLocalGitHubUser(github, Boolean(token));

    if (!token) {
      console.warn(
        warning(
          "[github] GITHUB_TOKEN is not set. AGSE can read public issues, but PR creation and local-only author checks require a token.",
        ),
      );
    } else if (localUser) {
      console.log(success(`[github] Authenticated as ${localUser.login}.`));
    }

    for (const project of workspace.projects) {
      const remoteUrl = await getOriginRemoteUrl(project);
      const repository = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;

      if (!repository) {
        console.warn(
          warning(
            `[github] Skipping ${project.name}: origin remote is not a GitHub repository.`,
          ),
        );
        continue;
      }

      if (project.config.restrict_user_to_local_only && !localUser) {
        console.warn(
          warning(
            `[github] ${project.name} has restrict_user_to_local_only enabled, but no authenticated GitHub user is available.`,
          ),
        );
      }

      states.push({
        project,
        repository,
        seenIssueIds: new Set<number>(),
        isPolling: false,
        pollAgainRequested: false,
      });
    }

    return new GitHubIssuePoller(states, github, localUser, token, options);
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.pollOnce();
    this.startWebhookSubscribers();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    for (const subscriber of this.webhookSubscribers.splice(0)) {
      subscriber.stop();
    }
  }

  async pollOnce(): Promise<void> {
    await Promise.all(
      this.states.map((state) =>
        runSerializedProjectPoll(state, () => this.pollProject(state)),
      ),
    );
  }

  get projectCount(): number {
    return this.states.length;
  }

  private startWebhookSubscribers(): void {
    if (!this.token) {
      return;
    }

    for (const state of this.states) {
      const subscriber = this.createWebhookSubscriber({
        github: this.github,
        repository: state.repository,
        token: this.token,
        events: this.webhookEvents,
        onEvent: (event) => {
          console.log(
            info(
              `[github] ${state.project.name}: received ${event.eventName} webhook${event.deliveryId ? ` (${event.deliveryId})` : ""}; scheduling poll.`,
            ),
          );
          void runSerializedProjectPoll(state, () => this.pollProject(state));
        },
        onError: (error) => {
          console.warn(
            warning(
              `[github] ${state.project.name}: websocket updates unavailable: ${formatError(error)}. Continuing with ${this.intervalMs / 1_000}s polling.`,
            ),
          );
        },
      });

      this.webhookSubscribers.push(subscriber);
      void subscriber.start().catch((error) => {
        console.warn(
          warning(
            `[github] ${state.project.name}: could not subscribe to websocket updates: ${formatError(error)}. Continuing with ${this.intervalMs / 1_000}s polling.`,
          ),
        );
      });
    }
    }

  private async pollProject(state: ProjectIssuePollState): Promise<void> {
    try {
      console.log(
        info(
          `[github] Polling ${state.project.name} (${state.repository.owner}/${state.repository.repo})...`,
        ),
      );
      await recoverTrackedPullRequests(
        state.project,
        state.repository,
        this.github,
      );
      await syncTrackedPullRequests(state.project, state.repository, this.github);

      const issues = await this.github.listRecentIssues(state.repository);
      const openIssueCount = countIssuesOnly(issues);
      const pendingIssues = await this.selectPendingIssues(issues, state);

      console.log(
        info(
          `[github] ${state.project.name}: saw ${openIssueCount} open issue(s), ${pendingIssues.length} pending AGSC check(s).`,
        ),
      );

      for (const issue of pendingIssues) {
        logNewIssue(state.project, state.repository, issue);
        try {
          const result = await handleGitHubIssueForProject({
            project: state.project,
            repository: state.repository,
            issue,
            github: this.github,
            localGitHubLogin: this.localUser?.login ?? state.repository.owner,
          });

          if (result.status === "tracked") {
            state.seenIssueIds.add(issue.id);
          }
        } catch (error) {
          console.error(
            errorMessage(
              `[github] Failed to automate ${state.project.name} #${issue.number}: ${formatError(error)}`,
            ),
          );
        }
      }
    } catch (error) {
      console.error(
        errorMessage(
          `[github] Failed to poll ${state.repository.owner}/${state.repository.repo}: ${formatError(error)}`,
        ),
      );
    }
  }

  private async selectPendingIssues(
    issues: GitHubIssue[],
    state: ProjectIssuePollState,
  ): Promise<GitHubIssue[]> {
    const agscState = await new AGSCStateStore(state.project.rootPath).read();
    const trackedIssueIds = new Set(
      agscState.workflows.map((workflow) => workflow.issueId),
    );
    const closedWorkflowIssueIds = new Set(
      agscState.closedWorkflows.map((workflow) => workflow.issueId),
    );

    return selectPendingIssuesForAutomation(
      issues,
      state.seenIssueIds,
      trackedIssueIds,
      closedWorkflowIssueIds,
    );
  }
}

async function runSerializedProjectPoll(
  state: Pick<ProjectIssuePollState, "isPolling" | "pollAgainRequested">,
  poll: () => Promise<void>,
): Promise<void> {
  if (state.isPolling) {
    state.pollAgainRequested = true;
    return;
  }

  state.isPolling = true;

  try {
    do {
      state.pollAgainRequested = false;
      await poll();
    } while (state.pollAgainRequested);
  } finally {
    state.isPolling = false;
  }
}

function selectPendingIssuesForAutomation(
  issues: readonly GitHubIssue[],
  seenIssueIds: ReadonlySet<number>,
  trackedIssueIds: ReadonlySet<number>,
  closedWorkflowIssueIds: ReadonlySet<number> = new Set(),
): GitHubIssue[] {
  return issues
    .filter(isIssueOnly)
    .filter(
      (issue) =>
        !seenIssueIds.has(issue.id) &&
        !trackedIssueIds.has(issue.id) &&
        !closedWorkflowIssueIds.has(issue.id),
    )
    .sort(
      (left, right) =>
        new Date(left.created_at).getTime() -
        new Date(right.created_at).getTime(),
    );
}

function countIssuesOnly(issues: readonly GitHubIssue[]): number {
  return issues.filter(isIssueOnly).length;
}

function isIssueOnly(issue: GitHubIssue): boolean {
  return !issue.pull_request;
}

async function getLocalGitHubUser(
  github: GitHubApiClient,
  hasToken: boolean,
): Promise<GitHubUser | null> {
  if (!hasToken) {
    return null;
  }

  try {
    return await github.getAuthenticatedUser();
  } catch (error) {
    console.warn(
      warning(`[github] Could not authenticate GITHUB_TOKEN: ${formatError(error)}`),
    );
    return null;
  }
}

async function getOriginRemoteUrl(
  project: AGSCProject,
): Promise<string | undefined> {
  try {
    const remoteUrl = await project.git.git.remote(["get-url", "origin"]);

    return typeof remoteUrl === "string" ? remoteUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

function logNewIssue(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  issue: GitHubIssue,
): void {
  const author = issue.user?.login ? ` by ${issue.user.login}` : "";

  console.log(
    `${style.magenta("[github]")} ${project.name} ${repository.owner}/${repository.repo} #${issue.number}${author}: ${style.bold(issue.title)}`,
  );
  console.log(style.dim(`         ${issue.html_url}`));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = {
  countIssuesOnly,
  runSerializedProjectPoll,
  selectPendingIssuesForAutomation,
};
