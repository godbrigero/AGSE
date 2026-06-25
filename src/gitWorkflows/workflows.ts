import type {
  BranchSummary,
  CommitResult,
  DefaultLogFields,
  ListLogSummary,
  PullResult,
  PushResult,
  StatusResult,
} from "simple-git";
import {
  createGitClient,
  type GitRepository,
  validateGitRepository,
  type GitRepositoryOptions,
} from "./gitRepository.ts";

export type GitWorkflowOptions = GitRepositoryOptions;

export type CommitAndPushInput = {
  message: string;
  files?: string | readonly string[];
  remote?: string;
  branch?: string;
};

export type CommitAndPushResult = {
  statusBeforeCommit: StatusResult;
  commit: CommitResult | null;
  push: PushResult | null;
  skipped: boolean;
};

export class GitWorkflows {
  readonly repositoryRootPath: string;
  readonly git: GitRepository["git"];

  private readonly repository: GitRepository;
  private readonly options: GitWorkflowOptions;

  constructor(repositoryRootPath: string, options: GitWorkflowOptions = {}) {
    this.repository = createGitClient(repositoryRootPath, options);
    this.repositoryRootPath = this.repository.path;
    this.options = options;
    this.git = this.repository.git;
  }

  static async create(
    repositoryRootPath: string,
    options: GitWorkflowOptions = {},
  ): Promise<GitWorkflows> {
    const workflows = new GitWorkflows(repositoryRootPath, options);
    await workflows.loadRepository();

    return workflows;
  }

  async status(): Promise<StatusResult> {
    const { git } = await this.loadRepository();

    return git.status();
  }

  async branches(): Promise<BranchSummary> {
    const { git } = await this.loadRepository();

    return git.branch();
  }

  async recentCommits(
    maxCount = 10,
  ): Promise<ListLogSummary<DefaultLogFields>> {
    const { git } = await this.loadRepository();

    return git.log({ maxCount });
  }

  async pullCurrentBranch(remote = "origin"): Promise<PullResult> {
    const { git } = await this.loadRepository();
    const branch = await git.branchLocal();

    return git.pull(remote, branch.current);
  }

  async commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult> {
    const { git } = await this.loadRepository();
    let files: string | string[] = ".";

    if (typeof input.files === "string") {
      files = input.files;
    } else if (input.files) {
      files = [...input.files];
    }

    await git.add(files);

    const statusBeforeCommit = await git.status();

    if (statusBeforeCommit.files.length === 0) {
      return {
        statusBeforeCommit,
        commit: null,
        push: null,
        skipped: true,
      };
    }

    const commit = await git.commit(input.message);
    const remote = input.remote ?? "origin";
    const branch = input.branch ?? (await git.branchLocal()).current;
    const push = await git.push(remote, branch);

    return {
      statusBeforeCommit,
      commit,
      push,
      skipped: false,
    };
  }

  private async loadRepository(): Promise<GitRepository> {
    await validateGitRepository(this.repository, this.options);

    return this.repository;
  }
}

export async function getRepositoryStatus(
  folderPath: string,
  options?: GitWorkflowOptions,
): Promise<StatusResult> {
  return new GitWorkflows(folderPath, options).status();
}

export async function listRepositoryBranches(
  folderPath: string,
  options?: GitWorkflowOptions,
): Promise<BranchSummary> {
  return new GitWorkflows(folderPath, options).branches();
}

export async function getRecentCommits(
  folderPath: string,
  maxCount = 10,
  options?: GitWorkflowOptions,
): Promise<ListLogSummary<DefaultLogFields>> {
  return new GitWorkflows(folderPath, options).recentCommits(maxCount);
}

export async function pullCurrentBranch(
  folderPath: string,
  remote = "origin",
  options?: GitWorkflowOptions,
): Promise<PullResult> {
  return new GitWorkflows(folderPath, options).pullCurrentBranch(remote);
}

export async function commitAndPush(
  folderPath: string,
  input: CommitAndPushInput,
  options?: GitWorkflowOptions,
): Promise<CommitAndPushResult> {
  return new GitWorkflows(folderPath, options).commitAndPush(input);
}
