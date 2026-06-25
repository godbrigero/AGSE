# Claude Code Integration

This folder wraps `@anthropic-ai/claude-agent-sdk` behind a folder-path-first API.

Claude Code uses the folder root as `cwd`, so callers can create or resume chats for a specific project without changing `process.cwd()` or learning the raw SDK options.

```ts
import {
  createClaudeCodeChat,
  continueClaudeCodeChat,
  listClaudeCodeChats,
  sendClaudeCodeMessage,
} from "./claudeCodeIntegration/index.ts";

const projectRoot = "/absolute/path/to/project";

const chat = await createClaudeCodeChat({
  folderPath: projectRoot,
  title: "Auth refactor",
  options: {
    maxTurns: 5,
    allowedTools: ["Read", "Grep", "Glob"],
  },
});

const firstReply = await chat.sendMessage("Explain this codebase structure.");
console.log(firstReply.responseText);

const followUp = await continueClaudeCodeChat(
  projectRoot,
  chat.sessionId,
  "Now inspect the auth flow.",
);
console.log(followUp.responseText);

const oneShot = await sendClaudeCodeMessage({
  folderPath: projectRoot,
  message: "Summarize the README.",
  options: { maxTurns: 1 },
});
console.log(oneShot.responseText);

const chats = await listClaudeCodeChats({ folderPath: projectRoot, limit: 10 });
console.log(chats.map((session) => session.summary));
```

The first message creates the real Claude Code transcript. The generated `sessionId` can be saved and passed to `continueClaudeCodeChat()` later.
