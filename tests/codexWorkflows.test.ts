import { test } from "node:test";
import assert from "node:assert/strict";
import { __testing as codex } from "../src/codexIntegration/workflows.ts";

test("normalizeInput converts string messages into Codex text items", () => {
  assert.deepEqual(codex.normalizeInput("Issue #3: Add testing"), [
    { type: "text", text: "Issue #3: Add testing" },
  ]);
});

test("normalizeInput preserves structured message arrays", () => {
  const input = [
    { type: "text", text: "hello" },
    { type: "image_url", image_url: "https://example.com/image.png" },
  ] as const;

  assert.deepEqual(codex.normalizeInput(input), input);
});

test("extractTurnIdFromValue supports direct and nested turn ids", () => {
  assert.equal(codex.extractTurnIdFromValue({ turnId: "turn-direct" }), "turn-direct");
  assert.equal(
    codex.extractTurnIdFromValue({ turn: { id: "turn-nested" } }),
    "turn-nested",
  );
  assert.equal(codex.extractTurnIdFromValue({}), undefined);
});

test("extractTurnId supports notification params shapes", () => {
  assert.equal(
    codex.extractTurnId({
      method: "turn/completed",
      params: { turnId: "turn-1" },
    }),
    "turn-1",
  );
  assert.equal(
    codex.extractTurnId({
      method: "turn/completed",
      params: { turn: { id: "turn-2" } },
    }),
    "turn-2",
  );
});

test("extractAgentMessageDelta accumulates common Codex delta formats", () => {
  assert.equal(
    codex.extractAgentMessageDelta({
      method: "item/agentMessage/delta",
      params: { delta: "hello" },
    }),
    "hello",
  );
  assert.equal(
    codex.extractAgentMessageDelta({
      method: "item/agentMessage/delta",
      params: { delta: { text: "world" } },
    }),
    "world",
  );
  assert.equal(
    codex.extractAgentMessageDelta({
      method: "other",
      params: { delta: "ignored" },
    }),
    "",
  );
});

test("withoutTimeout strips timeout from turn parameters", () => {
  assert.deepEqual(
    codex.withoutTimeout({
      threadId: "thread-1",
      input: "hello",
      cwd: "/repo",
      timeoutMs: 1000,
    }),
    {
      threadId: "thread-1",
      input: "hello",
      cwd: "/repo",
    },
  );
});
