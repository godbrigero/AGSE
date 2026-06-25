# AGSE - Agent Github Sync Engine

Minimal Node + TypeScript project that runs `.ts` files directly with Node's type stripping.

## Commands

```sh
npm install
npm start
```

For watch mode:

```sh
npm run dev
```

For type checking:

```sh
npm run typecheck
```

The app entrypoint is `src/main.ts`. This project intentionally does not compile TypeScript to JavaScript before running.

## Integrations

- `src/gitWorkflows` wraps Git operations for a repository path.
- `src/claudeCodeIntegration` wraps Claude Code sessions for a project folder.
- `src/codexIntegration` wraps `codex app-server` so callers can create, resume, fork, and message Codex chats inside a project folder.

## AGSC project discovery

AGSC projects are folders that contain an `agse.config.ts` marker file. The marker exports a typed config object:

```ts
import type { AGSCConfigOptions } from "./src/agscConfig.ts";

export interface AGSCWorkspaceConfig extends AGSCConfigOptions {}

const config: AGSCWorkspaceConfig = {
  require_tag: true,
  overwrite_tags: {
    codex: "agse-codex",
    claude: "agse-claude",
    default: "agse",
  },
  assignee_tags: {
    godbrigero: "codex",
  },
  restrict_user_to_local_only: true,
};

export default config;
```

Discover projects from one folder or many folders with `AGSCWorkspace`:

```ts
import { AGSCWorkspace } from "./src/agscWorkspace.ts";

const workspace = await AGSCWorkspace.discover(["/path/to/search"]);

for (const project of workspace.projects) {
  console.log(project.rootPath, project.config.require_tag);
  console.log(await project.git.status());
  console.log(await project.claude.listChats({ limit: 5 }));
}
```

## Issue routing

- Label `agse-codex` routes an issue to Codex.
- Label `agse-claude` routes an issue to Claude.
- Label `agse` routes an issue to the default agent, currently Codex.
- `assignee_tags` can route by GitHub assignee username, for example `godbrigero: "codex"`.
- If `require_tag` is `true`, an issue needs a matching label or configured assignee route.
- If `restrict_user_to_local_only` is `true`, AGSE only acts on issues opened by the authenticated `GITHUB_TOKEN` user.
