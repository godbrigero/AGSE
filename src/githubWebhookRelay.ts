import WebSocket from "ws";
import type {
  GitHubApiClient,
  GitHubRepositoryHook,
  GitHubRepositoryRef,
} from "./githubApi.ts";

export const DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

export type GitHubWebhookRelayEvent = {
  eventName: string;
  deliveryId: string | null;
  body: unknown;
};

export type GitHubWebhookRelaySubscriberOptions = {
  github: GitHubApiClient;
  repository: GitHubRepositoryRef;
  token: string;
  events?: readonly string[];
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  createWebSocket?: (url: string, token: string) => WebSocket;
  onEvent: (event: GitHubWebhookRelayEvent) => void | Promise<void>;
  onError?: (error: Error) => void;
};

type RelayMessage = {
  Header?: Record<string, string | string[] | undefined>;
  Body?: string;
};

type RelayResponse = {
  StatusCode: number;
  Header: Record<string, string[]>;
  Body: string;
};

export class GitHubWebhookRelaySubscriber {
  private readonly github: GitHubApiClient;
  private readonly repository: GitHubRepositoryRef;
  private readonly token: string;
  private readonly events: readonly string[];
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly createWebSocket: (url: string, token: string) => WebSocket;
  private readonly onEvent: (event: GitHubWebhookRelayEvent) => void | Promise<void>;
  private readonly onError?: (error: Error) => void;

  private socket?: WebSocket;
  private hookId?: number;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs: number;
  private stopped = false;

  constructor(options: GitHubWebhookRelaySubscriberOptions) {
    this.github = options.github;
    this.repository = options.repository;
    this.token = options.token;
    this.events = options.events ?? DEFAULT_GITHUB_WEBHOOK_RELAY_EVENTS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.reconnectDelayMs = this.reconnectBaseDelayMs;
    this.createWebSocket =
      options.createWebSocket ??
      ((url, token) => new WebSocket(url, { headers: { Authorization: token } }));
    this.onEvent = options.onEvent;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const hook = await this.createHook();
    const wsUrl = hook.ws_url;

    if (!wsUrl) {
      await this.deleteHook(hook.id);
      throw new Error("GitHub webhook relay hook did not return ws_url.");
    }

    this.hookId = hook.id;

    try {
      await this.openSocket(wsUrl);

      if (this.stopped) {
        return;
      }

      await this.github.updateRepositoryHook(this.repository, hook.id, {
        active: true,
      });
      this.reconnectDelayMs = this.reconnectBaseDelayMs;
    } catch (error) {
      const socket = this.socket;
      this.socket = undefined;
      this.hookId = undefined;

      if (
        socket &&
        (socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN)
      ) {
        socket.close();
      }

      await this.deleteHook(hook.id);
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;

    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN)
    ) {
      socket.close();
    }

    if (this.hookId !== undefined) {
      const hookId = this.hookId;
      this.hookId = undefined;
      void this.deleteHook(hookId);
    }
  }

  private async createHook(): Promise<GitHubRepositoryHook> {
    return this.github.createRepositoryHook(this.repository, {
      name: "cli",
      active: false,
      events: [...this.events],
      config: {},
    });
  }

  private async openSocket(wsUrl: string): Promise<void> {
    const socket = this.createWebSocket(wsUrl, this.token);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.on("message", (data) => {
      this.handleMessage(data.toString());
    });
    socket.on("error", (error) => {
      this.emitError(toError(error));
    });
    socket.on("close", () => {
      if (this.stopped || this.socket !== socket) {
        return;
      }

      this.socket = undefined;
      this.hookId = undefined;
      this.scheduleReconnect();
    });
  }

  private handleMessage(rawMessage: string): void {
    let message: RelayMessage;

    try {
      message = JSON.parse(rawMessage) as RelayMessage;
      this.sendRelayResponse(202);
      const event = parseRelayEvent(message);

      if (!event || event.eventName === "ping") {
        return;
      }

      void Promise.resolve(this.onEvent(event)).catch((error) => {
        this.emitError(toError(error));
      });
    } catch (error) {
      this.sendRelayResponse(400);
      this.emitError(toError(error));
    }
  }

  private sendRelayResponse(statusCode: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const response: RelayResponse = {
      StatusCode: statusCode,
      Header: {},
      Body: "",
    };
    this.socket.send(JSON.stringify(response));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.reconnectMaxDelayMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch((error) => {
        this.emitError(toError(error));
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private async deleteHook(hookId: number): Promise<void> {
    try {
      await this.github.deleteRepositoryHook(this.repository, hookId);
    } catch (error) {
      this.emitError(toError(error));
    }
  }

  private emitError(error: Error): void {
    this.onError?.(error);
  }
}

function parseRelayEvent(message: RelayMessage): GitHubWebhookRelayEvent | null {
  const eventName = getHeaderValue(message.Header, "X-GitHub-Event");

  if (!eventName) {
    return null;
  }

  return {
    eventName,
    deliveryId: getHeaderValue(message.Header, "X-GitHub-Delivery"),
    body: parseRelayBody(message.Body),
  };
}

function getHeaderValue(
  headers: RelayMessage["Header"],
  headerName: string,
): string | null {
  if (!headers) {
    return null;
  }

  const target = headerName.toLowerCase();

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== target || value === undefined) {
      continue;
    }

    return Array.isArray(value) ? value[0] ?? null : value;
  }

  return null;
}

function parseRelayBody(body: string | undefined): unknown {
  if (!body) {
    return null;
  }

  const rawBody = Buffer.from(body, "base64").toString("utf8");

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export const __testing = {
  getHeaderValue,
  parseRelayBody,
  parseRelayEvent,
};
