# Git Workflows

This folder wraps `simple-git` so callers can pass a repository folder path and run Git operations without changing the process working directory.

```ts
import {
  createGitRepository,
  getRepositoryStatus,
  commitAndPush,
} from "./gitWorkflows/index.ts";

const repoPath = "/absolute/path/to/repository";

const status = await getRepositoryStatus(repoPath);

const { git } = await createGitRepository(repoPath);
await git.checkout("main");

await commitAndPush(repoPath, {
  message: "Update synced files",
  files: ["README.md", "src/main.ts"],
});
```

Use `createGitRepository(path, { allowNestedPath: true })` when the input may be a subfolder inside a repository instead of the repository root.
