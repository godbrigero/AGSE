import type { AGSCProject, AGSCWorkspace } from "./agscWorkspace.ts";
import {
  handleGitHubIssueForProject,
  syncTrackedPullRequests,
} from "./agscIssueAutomation.ts";
import {
  GitHubApiClient,
  parseGitHubRemoteUrl,
  type GitHubIssue,
  type GitHubRepositoryRef,
  type GitHubUser,
} from "./githubApi.ts";

export type GitHubIssuePollerOptions = {
  intervalMs?: number;
  token?: string;
  now?: () => Date;
};

type ProjectIssuePollState = {
  project: AGSCProject;
  repository: GitHubRepositoryRef;
  lastCreatedAt: Date;
  seenIssueIds: Set<number>;
  isPolling: boolean;
};

export class GitHubIssuePoller {
  private readonly states: ProjectIssuePollState[];
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly github: GitHubApiClient;
  private readonly localUser: GitHubUser | null;
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    states: ProjectIssuePollState[],
    github: GitHubApiClient,
    localUser: GitHubUser | null,
    options: GitHubIssuePollerOptions = {},
  ) {
    this.states = states;
    this.intervalMs = options.intervalMs ?? 20_000;
    this.now = options.now ?? (() => new Date());
    this.github = github;
    this.localUser = localUser;
  }

  static async fromWorkspace(
    workspace: AGSCWorkspace,
    options: GitHubIssuePollerOptions = {},
  ): Promise<GitHubIssuePoller> {
    const states: ProjectIssuePollState[] = [];
    const now = options.now ?? (() => new Date());
    const github = new GitHubApiClient(options.token);
    const localUser = await github.getAuthenticatedUser();

    for (const project of workspace.projects) {
      const remoteUrl = await getOriginRemoteUrl(project);
      const repository = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;

      if (!repository) {
        console.warn(
          `[github] Skipping ${project.name}: origin remote is not a GitHub repository.`,
        );
        continue;
      }

      states.push({
        project,
        repository,
        lastCreatedAt: now(),
        seenIssueIds: new Set<number>(),
        isPolling: false,
      });
    }

    return new GitHubIssuePoller(states, github, localUser, options);
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollOnce(): Promise<void> {
    await Promise.all(this.states.map((state) => this.pollProject(state)));
  }

  get projectCount(): number {
    return this.states.length;
  }

  private async pollProject(state: ProjectIssuePollState): Promise<void> {
    if (state.isPolling) {
      return;
    }

    state.isPolling = true;

    try {
      await syncTrackedPullRequests(state.project, state.repository, this.github);

      const issues = await this.github.listRecentIssues(state.repository);
      const newIssues = issues
        .filter((issue) => !issue.pull_request)
        .filter((issue) => isNewIssue(issue, state))
        .sort(
          (left, right) =>
            new Date(left.created_at).getTime() -
            new Date(right.created_at).getTime(),
        );

      for (const issue of newIssues) {
        state.seenIssueIds.add(issue.id);
        state.lastCreatedAt = new Date(issue.created_at);
        logNewIssue(state.project, state.repository, issue);
        await handleGitHubIssueForProject({
          project: state.project,
          repository: state.repository,
          issue,
          github: this.github,
          localGitHubLogin: this.localUser?.login ?? null,
        });
      }

      if (newIssues.length === 0) {
        state.lastCreatedAt = maxDate(state.lastCreatedAt, this.now());
      }
    } catch (error) {
      console.error(
        `[github] Failed to poll ${state.repository.owner}/${state.repository.repo}: ${formatError(error)}`,
      );
    } finally {
      state.isPolling = false;
    }
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

function isNewIssue(
  issue: GitHubIssue,
  state: ProjectIssuePollState,
): boolean {
  const createdAt = new Date(issue.created_at);

  return createdAt > state.lastCreatedAt && !state.seenIssueIds.has(issue.id);
}

function logNewIssue(
  project: AGSCProject,
  repository: GitHubRepositoryRef,
  issue: GitHubIssue,
): void {
  const author = issue.user?.login ? ` by ${issue.user.login}` : "";

  console.log(
    `[github] ${project.name} ${repository.owner}/${repository.repo} #${issue.number}${author}: ${issue.title}`,
  );
  console.log(`         ${issue.html_url}`);
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
