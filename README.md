# AGSE - Agent GitHub Sync Engine

AGSE watches GitHub issues for the repositories you choose and turns accepted
issues into agent-backed pull requests. It creates the branch and worktree,
opens or reuses a PR, writes the agent's plan into the PR body, and hands the
work to Codex or Claude so you can review progress from GitHub.

Use AGSE when you want GitHub issues to become tracked implementation work
without manually creating local branches, worktrees, PRs, and agent sessions.

## What AGSE does

When AGSE is running, it:

- Scans folders for projects that contain an `agse.config.ts` file.
- Polls GitHub issues every 20 seconds.
- Uses GitHub webhook relay websocket updates for faster syncs when token
  permissions allow it.
- Routes issues to Codex or Claude by label or configured assignee.
- Creates or reuses an `agse/...` branch and local worktree for the issue.
- Opens or reuses a pull request for that branch.
- Closes the source issue after the PR is created.
- Writes the proposed agent plan into the PR body and starts implementation.
- Sends PR comments and reviews back into the same tracked agent workflow.

The 20-second poll stays active even when websocket updates are unavailable, so
missed or delayed webhook events are picked up on the next poll.

## Requirements

- Node.js and npm. This project runs TypeScript directly with Node's type
  stripping support.
- A local Git repository with a GitHub `origin` remote.
- A `GITHUB_TOKEN` for creating branches, opening PRs, checking the local GitHub
  user, and subscribing to webhook updates.
- Codex Desktop with the background daemon available for Codex-routed work.
- Claude Code configured locally for Claude-routed work.

Token permissions:

- Fine-grained tokens need Issues read, Pull requests read/write, Contents
  read/write, and Webhooks read/write.
- Classic tokens need `admin:repo_hook`.

## Quick start

Install AGSE dependencies:

```sh
npm install
```

Add an AGSE config file to each repository you want AGSE to manage. If the
initializer package is available on npm, run it from the target repository:

```sh
npx initialize-agse@latest .
```

Or point it at another repository:

```sh
npx initialize-agse@latest path/to/repo
```

For local development before publishing the initializer, link the workspace
package first:

```sh
npm run link:initialize-agse
initialize-agse path/to/repo
```

Start AGSE:

```sh
npm start
```

On startup, AGSE loads `.env`, asks for `GITHUB_TOKEN` if one is not already
set, and asks which folder paths to scan. It remembers the last scan paths for
the next run.

After AGSE is running, create or label a GitHub issue in a configured
repository. AGSE will pick it up on the next poll or webhook update.

## Configuration

AGSE projects are folders that contain an `agse.config.ts` file. The initializer
creates a self-contained typed config like this:

```ts
export interface AGSCConfigOptions {
  require_tag?: boolean;
  overwrite_tags?: Record<"codex" | "claude" | "default", string>;
  assignee_tags?: Record<string, "codex" | "claude" | "default">;
  restrict_user_to_local_only?: boolean;
}

const config: AGSCConfigOptions = {
  require_tag: true,
  overwrite_tags: {
    codex: "agse-codex",
    claude: "agse-claude",
    default: "agse",
  },
  assignee_tags: {
    your_github_username: "codex",
  },
  restrict_user_to_local_only: true,
};

export default config;
```

Options:

- `require_tag`: when `true`, AGSE ignores issues unless they have a matching
  label or configured assignee route.
- `overwrite_tags`: changes the labels used to route issues to Codex, Claude,
  or the default agent.
- `assignee_tags`: routes issues by GitHub assignee username. Replace
  `your_github_username` with the account you want to route.
- `restrict_user_to_local_only`: when `true`, AGSE only acts on issues opened by
  or assigned to the authenticated `GITHUB_TOKEN` user.

## Issue routing

| Route | Agent |
| --- | --- |
| `agse-codex` label | Codex |
| `agse-claude` label | Claude |
| `agse` label | Default agent, currently Codex |
| Configured `assignee_tags` entry | Configured agent |

If `require_tag` is `true`, an issue without a matching label or assignee route
is left alone.

## What to expect

AGSE logs the projects it finds and the GitHub repositories it polls. For each
accepted issue, it creates a branch named from the issue number and title, for
example `agse/issue-50-add-user-friendly-readme`.

Codex worktrees are created under the Codex worktrees root by default. Set
`AGSE_CODEX_WORKTREES_ROOT` to choose a different location.

The PR body includes AGSC metadata plus the proposed agent plan. Keep that
metadata in place so AGSE can recover tracked work, route future PR feedback,
and continue the same agent workflow.

## Developer commands

Run AGSE:

```sh
npm start
```

Run with Node watch mode:

```sh
npm run dev
```

Type check:

```sh
npm run typecheck
```

Run tests:

```sh
npm test
```

Use `npm run typecheck` and `npm test` for local verification.

Run Codex diagnostics:

```sh
npm run diagnostics:codex
```

The app entrypoint is `src/main.ts`. This project intentionally runs `.ts`
files directly and does not compile TypeScript to JavaScript before running.

## More details

- [Codex integration](src/codexIntegration/README.md)
- [Claude Code integration](src/claudeCodeIntegration/README.md)
- [Git workflow helpers](src/gitWorkflows/README.md)
- [Initializer package](packages/initialize-agse/README.md)
