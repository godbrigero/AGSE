import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexWorkflows } from "../src/codexIntegration/workflows.ts";
import type {
  CodexJsonObject,
  CodexNotification,
} from "../src/codexIntegration/appServerClient.ts";

describe("CodexWorkflows", () => {
  it("starts chats with workflow defaults and caller overrides", async () => {
    const client = new FakeCodexClient();
    client.enqueueResponse({ thread: { id: "thread-1" } });
    const workflows = createWorkflows(client, {
      model: "gpt-test",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    const thread = await workflows.startChat({
      sandbox: "workspace-write",
      customFlag: true,
    });

    assert.equal(thread.id, "thread-1");
    assert.deepEqual(client.requests, [
      {
        method: "thread/start",
        params: {
          model: "gpt-test",
          cwd: resolve("/repo"),
          sandbox: "workspace-write",
          approvalPolicy: "never",
          customFlag: true,
        },
      },
    ]);
  });

  it("normalizes turn input and aggregates agent message deltas", async () => {
    const client = new FakeCodexClient();
    client.enqueueResponse({ turn: { id: "turn-1" } }, () => {
      client.emitNotification({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Hello" },
      });
      client.emitNotification({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: { text: ", world" } },
      });
      client.emitNotification({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", text: "!" },
      });
      client.emitNotification({
        method: "turn/completed",
        params: { turnId: "turn-1" },
      });
    });
    const workflows = createWorkflows(client, {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    const result = await workflows.startTurn({
      threadId: "thread-1",
      input: "Run the tests",
      model: "ignored-by-turn-defaults",
      timeoutMs: 1_000,
    });

    assert.equal(result.threadId, "thread-1");
    assert.equal(result.finalResponse, "Hello, world!");
    assert.deepEqual(result.completed, {
      method: "turn/completed",
      params: { turnId: "turn-1" },
    });
    assert.deepEqual(client.requests, [
      {
        method: "turn/start",
        params: {
          cwd: resolve("/repo"),
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          threadId: "thread-1",
          input: [{ type: "text", text: "Run the tests" }],
          model: "ignored-by-turn-defaults",
        },
      },
    ]);
  });

  it("throws when Codex does not return a thread id", async () => {
    const client = new FakeCodexClient();
    client.enqueueResponse({ thread: { title: "missing id" } });
    const workflows = createWorkflows(client);

    await assert.rejects(
      () => workflows.resumeChat("thread-1"),
      /did not return a thread id/,
    );
  });

  it("normalizes steer message input and preserves caller params", async () => {
    const client = new FakeCodexClient();
    client.enqueueResponse({ accepted: true });
    const workflows = createWorkflows(client);

    await workflows.steerMessage("thread-1", "Adjust course", {
      turnId: "turn-1",
    });

    assert.deepEqual(client.requests, [
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          input: [{ type: "text", text: "Adjust course" }],
        },
      },
    ]);
  });
});

type CodexWorkflowTestOptions = ConstructorParameters<typeof CodexWorkflows>[1];

function createWorkflows(
  client: FakeCodexClient,
  options: CodexWorkflowTestOptions = {},
): CodexWorkflows {
  const workflows = new CodexWorkflows("/repo", options);

  Object.assign(workflows, { client });

  return workflows;
}

class FakeCodexClient {
  readonly requests: { method: string; params?: CodexJsonObject }[] = [];

  private readonly responses: {
    value: unknown;
    afterResolve?: () => void;
  }[] = [];
  private readonly notificationListeners = new Set<
    (notification: CodexNotification) => void
  >();

  enqueueResponse(value: unknown, afterResolve?: () => void): void {
    this.responses.push({ value, afterResolve });
  }

  async request<T = unknown>(
    method: string,
    params?: CodexJsonObject,
  ): Promise<T> {
    this.requests.push({ method, params });
    const response = this.responses.shift();

    if (!response) {
      throw new Error(`Unexpected Codex request: ${method}`);
    }

    queueMicrotask(() => response.afterResolve?.());

    return response.value as T;
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);

    return () => this.notificationListeners.delete(listener);
  }

  emitNotification(notification: CodexNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  close(): void {}
}
