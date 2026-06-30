# Codex Integration

This folder wraps `codex app-server` behind a folder-path-first API.

Codex app-server is the programmatic interface for chat-like Codex clients. It supports creating, resuming, and forking threads, then sending user messages as turns while streaming notifications from the agent.

```ts
import {
  createCodexChat,
  CodexWorkflows,
  sendCodexMessage,
} from "./codexIntegration/index.ts";

const projectRoot = "/absolute/path/to/project";

const chat = await createCodexChat({
  folderPath: projectRoot,
  options: {
    model: "gpt-5.4",
    sandbox: "workspace-write",
  },
});

const reply = await chat.sendMessage(
  "Summarize this project and suggest the next implementation step.",
);

console.log(reply.finalResponse);
chat.close();

const codex = new CodexWorkflows(projectRoot, {
  model: "gpt-5.4",
  sandbox: "workspace-write",
});

const thread = await codex.startChat();

const lowerLevelReply = await codex.sendMessage(
  thread.id,
  "Summarize this project and suggest the next implementation step.",
);

console.log(lowerLevelReply.finalResponse);

await codex.steerMessage(thread.id, "Focus only on files under src.");

const followUp = await sendCodexMessage(
  projectRoot,
  thread.id,
  "Now make the smallest safe change.",
);

console.log(followUp.finalResponse);
codex.close();
```

The low-level helpers can start `codex app-server` over stdio for direct calls.
AGSE PR/worktree handoffs require the durable background Codex daemon instead:
they set `useDaemonProxy`, `useRemoteControlDaemon`, and `requireDaemonProxy`
so AGSE never creates a hidden private-stdio chat and never opens or scripts the
visible Codex Desktop UI as a fallback. If the daemon is unavailable, the handoff
fails clearly.

If `codex` is not on `PATH`, or if you need a pinned runtime, pass `codexBinary`
in the workflow options or in `agse.config.ts`.

```ts
const config = {
  codex: {
    codexBinary: "/absolute/path/to/codex",
    model: "gpt-5.4",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
};
```

For app-server methods not wrapped yet, use the generic escape hatch:

```ts
await codex.request("thread/archive", { threadId: chat.id });
```
