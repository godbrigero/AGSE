import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  GitHubApiClient,
  GitHubRepositoryHook,
  GitHubRepositoryRef,
} from "../src/githubApi.ts";
import {
  DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS,
  GitHubWebhookRelaySubscriber,
} from "../src/githubWebhookRelay.ts";

test("GitHubWebhookRelaySubscriber creates a cli hook, connects with authorization, acknowledges messages, and emits events", async () => {
  const server = await createLocalWebSocketServer();
  const github = new FakeGitHub(server.url);
  const receivedEvents: unknown[] = [];
  const subscriber = new GitHubWebhookRelaySubscriber({
    github: github as unknown as GitHubApiClient,
    repository: { owner: "org", repo: "repo" },
    token: "token-1",
    onEvent: (event) => {
      receivedEvents.push(event);
    },
    onError: (error) => {
      throw error;
    },
  });

  try {
    const connectionPromise = once(server.wss, "connection") as Promise<
      [WebSocket, IncomingMessage]
    >;

    await subscriber.start();
    const [socket, request] = await connectionPromise;

    assert.equal(request.headers.authorization, "token-1");
    assert.deepEqual(github.createdHooks[0], {
      repository: { owner: "org", repo: "repo" },
      input: {
        name: "cli",
        active: false,
        events: [...DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS],
        config: {},
      },
    });
    assert.deepEqual(github.updatedHooks[0], {
      repository: { owner: "org", repo: "repo" },
      hookId: 1,
      input: { active: true },
    });

    socket.send(
      JSON.stringify({
        Header: {
          "X-GitHub-Event": ["issues"],
          "X-GitHub-Delivery": ["delivery-1"],
        },
        Body: Buffer.from(JSON.stringify({ action: "opened" })).toString(
          "base64",
        ),
      }),
    );

    const [acknowledgement] = (await once(socket, "message")) as [Buffer];
    assert.deepEqual(JSON.parse(acknowledgement.toString()), {
      StatusCode: 202,
      Header: {},
      Body: "",
    });

    await waitFor(() => receivedEvents.length === 1);
    assert.deepEqual(receivedEvents, [
      {
        eventName: "issues",
        deliveryId: "delivery-1",
        body: { action: "opened" },
      },
    ]);
  } finally {
    subscriber.stop();
    await server.close();
  }
});

test("GitHubWebhookRelaySubscriber ignores ping events", async () => {
  const server = await createLocalWebSocketServer();
  const github = new FakeGitHub(server.url);
  const receivedEvents: unknown[] = [];
  const subscriber = new GitHubWebhookRelaySubscriber({
    github: github as unknown as GitHubApiClient,
    repository: { owner: "org", repo: "repo" },
    token: "token-1",
    onEvent: (event) => {
      receivedEvents.push(event);
    },
  });

  try {
    const connectionPromise = once(server.wss, "connection") as Promise<
      [WebSocket, IncomingMessage]
    >;

    await subscriber.start();
    const [socket] = await connectionPromise;

    socket.send(
      JSON.stringify({
        Header: {
          "X-GitHub-Event": ["ping"],
          "X-GitHub-Delivery": ["delivery-1"],
        },
        Body: Buffer.from(JSON.stringify({ zen: "keep it logically awesome" })).toString(
          "base64",
        ),
      }),
    );

    const [acknowledgement] = (await once(socket, "message")) as [Buffer];
    assert.equal(JSON.parse(acknowledgement.toString()).StatusCode, 202);
    await delay(20);
    assert.deepEqual(receivedEvents, []);
  } finally {
    subscriber.stop();
    await server.close();
  }
});

test("GitHubWebhookRelaySubscriber stop closes the socket and prevents reconnect", async () => {
  const server = await createLocalWebSocketServer();
  const github = new FakeGitHub(server.url);
  const subscriber = new GitHubWebhookRelaySubscriber({
    github: github as unknown as GitHubApiClient,
    repository: { owner: "org", repo: "repo" },
    token: "token-1",
    reconnectBaseDelayMs: 5,
    onEvent: () => undefined,
  });

  try {
    const connectionPromise = once(server.wss, "connection") as Promise<
      [WebSocket, IncomingMessage]
    >;

    await subscriber.start();
    const [socket] = await connectionPromise;
    const closePromise = once(socket, "close");

    subscriber.stop();
    await closePromise;
    await delay(25);

    assert.equal(github.createdHooks.length, 1);
    assert.deepEqual(github.deletedHooks, [
      { repository: { owner: "org", repo: "repo" }, hookId: 1 },
    ]);
  } finally {
    subscriber.stop();
    await server.close();
  }
});

test("GitHubWebhookRelaySubscriber deletes hooks that do not return ws_url", async () => {
  const github = new FakeGitHub(undefined);
  const subscriber = new GitHubWebhookRelaySubscriber({
    github: github as unknown as GitHubApiClient,
    repository: { owner: "org", repo: "repo" },
    token: "token-1",
    onEvent: () => undefined,
  });

  await assert.rejects(
    () => subscriber.start(),
    /did not return ws_url/,
  );
  assert.deepEqual(github.deletedHooks, [
    { repository: { owner: "org", repo: "repo" }, hookId: 1 },
  ]);
});

class FakeGitHub {
  private readonly wsUrl: string | undefined;
  createdHooks: Array<{
    repository: GitHubRepositoryRef;
    input: unknown;
  }> = [];
  updatedHooks: Array<{
    repository: GitHubRepositoryRef;
    hookId: number;
    input: unknown;
  }> = [];
  deletedHooks: Array<{
    repository: GitHubRepositoryRef;
    hookId: number;
  }> = [];

  constructor(wsUrl: string | undefined) {
    this.wsUrl = wsUrl;
  }

  async createRepositoryHook(
    repository: GitHubRepositoryRef,
    input: unknown,
  ): Promise<GitHubRepositoryHook> {
    this.createdHooks.push({ repository, input });

    return {
      id: this.createdHooks.length,
      name: "cli",
      active: false,
      events: [...DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS],
      config: {},
      ...(this.wsUrl ? { ws_url: this.wsUrl } : {}),
    };
  }

  async updateRepositoryHook(
    repository: GitHubRepositoryRef,
    hookId: number,
    input: unknown,
  ): Promise<GitHubRepositoryHook> {
    this.updatedHooks.push({ repository, hookId, input });

    return {
      id: hookId,
      name: "cli",
      active: true,
      events: [...DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS],
      config: {},
      ...(this.wsUrl ? { ws_url: this.wsUrl } : {}),
    };
  }

  async deleteRepositoryHook(
    repository: GitHubRepositoryRef,
    hookId: number,
  ): Promise<void> {
    this.deletedHooks.push({ repository, hookId });
  }
}

type LocalWebSocketServer = {
  wss: WebSocketServer;
  url: string;
  close(): Promise<void>;
};

async function createLocalWebSocketServer(): Promise<LocalWebSocketServer> {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    wss,
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of wss.clients) {
        client.close();
      }

      await Promise.all([closeWebSocketServer(wss), closeHttpServer(server)]);
    },
  };
}

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    wss.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await delay(10);
  }

  assert.equal(predicate(), true);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
