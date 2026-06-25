import type {
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeCodeMessageContent = string;

export type ClaudeCodeRunResult = {
  sessionId: string | null;
  responseText: string | null;
  result: SDKResultMessage | null;
  messages: SDKMessage[];
};

export function createUserMessage(
  message: ClaudeCodeMessageContent,
): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: message,
    },
    parent_tool_use_id: null,
  };
}

export function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
}

export function isSuccessResult(
  message: SDKResultMessage,
): message is SDKResultSuccess {
  return message.subtype === "success";
}

export function summarizeRun(messages: SDKMessage[]): ClaudeCodeRunResult {
  const result = [...messages].reverse().find(isResultMessage) ?? null;

  return {
    sessionId: result?.session_id ?? null,
    responseText: result && isSuccessResult(result) ? result.result : null,
    result,
    messages,
  };
}
