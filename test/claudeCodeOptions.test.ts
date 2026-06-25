import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCodeOptions } from "../src/claudeCodeIntegration/options.ts";

describe("buildClaudeCodeOptions", () => {
  it("sets the working directory and session identifiers", () => {
    assert.deepEqual(
      buildClaudeCodeOptions({
        rootPath: "/repo",
        sessionId: "new-session",
        resumeSessionId: "existing-session",
      }),
      {
        cwd: "/repo",
        sessionId: "new-session",
        resume: "existing-session",
      },
    );
  });

  it("preserves caller options while enforcing managed fields", () => {
    assert.deepEqual(
      buildClaudeCodeOptions({
        rootPath: "/repo",
        sessionId: "session",
        options: {
          title: "Issue #3",
          maxTurns: 3,
        },
      }),
      {
        title: "Issue #3",
        maxTurns: 3,
        cwd: "/repo",
        sessionId: "session",
        resume: undefined,
      },
    );
  });
});
