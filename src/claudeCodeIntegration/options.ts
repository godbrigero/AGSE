import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeCodeSessionOptions = Omit<
  Partial<Options>,
  "continue" | "cwd" | "resume" | "sessionId"
>;

export type BuildClaudeCodeOptionsInput = {
  rootPath: string;
  sessionId?: string;
  resumeSessionId?: string;
  options?: ClaudeCodeSessionOptions;
};

export function buildClaudeCodeOptions({
  rootPath,
  sessionId,
  resumeSessionId,
  options,
}: BuildClaudeCodeOptionsInput): Options {
  return {
    ...options,
    cwd: rootPath,
    sessionId,
    resume: resumeSessionId,
  };
}
