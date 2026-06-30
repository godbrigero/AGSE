export type GitHubRepositoryRef = {
  owner: string;
  repo: string;
};

export type GitHubLabel = {
  name: string;
};

export type GitHubUser = {
  login: string;
};

export type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user?: GitHubUser;
  assignees?: GitHubUser[];
  labels: GitHubLabel[];
  pull_request?: unknown;
};

export type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  head: {
    ref: string;
  };
  base: {
    ref: string;
  };
};

export type GitHubIssueComment = {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: GitHubUser;
};

export type GitHubPullRequestReview = {
  id: number;
  body: string | null;
  html_url: string;
  submitted_at: string | null;
  state: string;
  user?: GitHubUser;
};

export type GitHubReactionContent = "eyes";

export type CreatePullRequestInput = {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
};

export type CreateIssueInput = {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
};

export class GitHubApiClient {
  private readonly token?: string;

  constructor(token = process.env.GITHUB_TOKEN) {
    this.token = token;
  }

  async getAuthenticatedUser(): Promise<GitHubUser | null> {
    if (!this.token) {
      return null;
    }

    return this.request<GitHubUser>("https://api.github.com/user");
  }

  async listRecentIssues(
    repository: GitHubRepositoryRef,
  ): Promise<GitHubIssue[]> {
    const url = this.repoUrl(repository, "issues");

    url.searchParams.set("state", "open");
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "30");

    return this.request<GitHubIssue[]>(url);
  }

  async getIssue(
    repository: GitHubRepositoryRef,
    issueNumber: number,
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      this.repoUrl(repository, `issues/${issueNumber}`),
    );
  }

  async createIssue(
    repository: GitHubRepositoryRef,
    input: CreateIssueInput,
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(this.repoUrl(repository, "issues"), {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateIssue(
    repository: GitHubRepositoryRef,
    issueNumber: number,
    input: Partial<Pick<GitHubIssue, "state" | "title" | "body">>,
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      this.repoUrl(repository, `issues/${issueNumber}`),
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  }

  async listOpenPullRequestsForHead(
    repository: GitHubRepositoryRef,
    headBranch: string,
  ): Promise<GitHubPullRequest[]> {
    const url = this.repoUrl(repository, "pulls");

    url.searchParams.set("state", "open");
    url.searchParams.set("head", `${repository.owner}:${headBranch}`);

    return this.request<GitHubPullRequest[]>(url);
  }

  async listOpenPullRequests(
    repository: GitHubRepositoryRef,
  ): Promise<GitHubPullRequest[]> {
    const url = this.repoUrl(repository, "pulls");

    url.searchParams.set("state", "open");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "100");

    return this.request<GitHubPullRequest[]>(url);
  }

  async getPullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      this.repoUrl(repository, `pulls/${pullNumber}`),
    );
  }

  async createPullRequest(
    repository: GitHubRepositoryRef,
    input: CreatePullRequestInput,
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(this.repoUrl(repository, "pulls"), {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updatePullRequestBody(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    body: string,
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      this.repoUrl(repository, `pulls/${pullNumber}`),
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
      },
    );
  }

  async addIssueComment(
    repository: GitHubRepositoryRef,
    issueNumber: number,
    body: string,
  ): Promise<GitHubIssueComment> {
    return this.request<GitHubIssueComment>(
      this.repoUrl(repository, `issues/${issueNumber}/comments`),
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    );
  }

  async addIssueCommentReaction(
    repository: GitHubRepositoryRef,
    commentId: number,
    content: GitHubReactionContent,
  ): Promise<void> {
    await this.request<void>(
      this.repoUrl(repository, `issues/comments/${commentId}/reactions`),
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ content }),
      },
    );
  }

  async closePullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      this.repoUrl(repository, `pulls/${pullNumber}`),
      {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      },
    );
  }

  async deleteBranchRef(
    repository: GitHubRepositoryRef,
    branchName: string,
  ): Promise<void> {
    await this.request<void>(
      this.repoUrl(repository, `git/refs/heads/${branchName}`),
      {
        method: "DELETE",
      },
    );
  }

  async listIssueComments(
    repository: GitHubRepositoryRef,
    issueNumber: number,
  ): Promise<GitHubIssueComment[]> {
    return this.request<GitHubIssueComment[]>(
      this.repoUrl(repository, `issues/${issueNumber}/comments`),
    );
  }

  async listPullRequestReviews(
    repository: GitHubRepositoryRef,
    pullNumber: number,
  ): Promise<GitHubPullRequestReview[]> {
    return this.request<GitHubPullRequestReview[]>(
      this.repoUrl(repository, `pulls/${pullNumber}/reviews`),
    );
  }

  private repoUrl(repository: GitHubRepositoryRef, path: string): URL {
    return new URL(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/${path}`,
    );
  }

  private async request<T>(
    input: string | URL,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(input, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API returned ${response.status} ${response.statusText}`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export function parseGitHubRemoteUrl(
  remoteUrl: string,
): GitHubRepositoryRef | null {
  const normalizedUrl = remoteUrl.trim();
  const sshMatch = normalizedUrl.match(
    /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  );

  if (sshMatch?.groups) {
    return {
      owner: sshMatch.groups.owner,
      repo: sshMatch.groups.repo,
    };
  }

  try {
    const url = new URL(normalizedUrl);

    if (url.hostname !== "github.com") {
      return null;
    }

    const [owner, repo] = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/, "")
      .split("/");

    if (!owner || !repo) {
      return null;
    }

    return { owner, repo };
  } catch {
    return null;
  }
}
