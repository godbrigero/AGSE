import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CheckRepoActions,
  simpleGit,
  type SimpleGit,
  type SimpleGitOptions,
} from "simple-git";

export type GitRepositoryOptions = {
  /**
   * Defaults to "git". Override when a caller needs a specific binary path.
   */
  gitBinary?: string;
  /**
   * Set true when the input path may be any folder inside the repository.
   * By default, the path must be the repository root.
   */
  allowNestedPath?: boolean;
  simpleGitOptions?: Omit<Partial<SimpleGitOptions>, "baseDir" | "binary">;
};

export type GitRepository = {
  path: string;
  git: SimpleGit;
};

export function createGitClient(
  folderPath: string,
  options: GitRepositoryOptions = {},
): GitRepository {
  const path = resolve(folderPath);

  const git = simpleGit({
    baseDir: path,
    binary: options.gitBinary ?? "git",
    maxConcurrentProcesses: 1,
    ...options.simpleGitOptions,
  });

  return { path, git };
}

export async function validateGitRepository(
  repository: GitRepository,
  options: GitRepositoryOptions = {},
): Promise<void> {
  await access(repository.path);

  const checkAction = options.allowNestedPath
    ? CheckRepoActions.IN_TREE
    : CheckRepoActions.IS_REPO_ROOT;
  const isRepository = await repository.git.checkIsRepo(checkAction);

  if (!isRepository) {
    throw new Error(`Expected a Git repository at: ${repository.path}`);
  }
}

export async function createGitRepository(
  folderPath: string,
  options: GitRepositoryOptions = {},
): Promise<GitRepository> {
  const repository = createGitClient(folderPath, options);

  await validateGitRepository(repository, options);

  return repository;
}
