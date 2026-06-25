import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createUserMessage,
  summarizeRun,
} from "../src/claudeCodeIntegration/messages.ts";

describe("Claude Code message helpers", () => {
  it("creates SDK user messages from plain text", () => {
    assert.deepEqual(createUserMessage("Continue the issue"), {
      type: "user",
      message: {
        role: "user",
        content: "Continue the issue",
      },
      parent_tool_use_id: null,
    });
  });

  it("summarizes the latest successful result message", () => {
    const assistantMessage = {
      type: "assistant",
    } as unknown as SDKMessage;
    const firstResult = {
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: false,
      num_turns: 1,
      result: "old response",
      session_id: "session-1",
      total_cost_usd: 0,
    } as unknown as SDKResultSuccess;
    const latestResult = {
      ...firstResult,
      result: "latest response",
      session_id: "session-2",
    } as SDKResultSuccess;
    const messages = [firstResult, assistantMessage, latestResult];

    assert.deepEqual(summarizeRun(messages), {
      sessionId: "session-2",
      responseText: "latest response",
      result: latestResult,
      messages,
    });
  });

  it("keeps error results but omits response text", () => {
    const errorResult = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: true,
      num_turns: 1,
      session_id: "session-1",
      total_cost_usd: 0,
    } as unknown as SDKResultError;

    assert.deepEqual(summarizeRun([errorResult]), {
      sessionId: "session-1",
      responseText: null,
      result: errorResult,
      messages: [errorResult],
    });
  });
});
