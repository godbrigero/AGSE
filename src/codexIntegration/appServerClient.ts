import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { connect as connectSocket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import WebSocket from "ws";

export type CodexJson =
  | null
  | boolean
  | number
  | string
  | readonly CodexJson[]
  | CodexJsonObject;
export type CodexJsonObject = { [key: string]: CodexJson | undefined };

export type CodexClientInfo = {
  name: string;
  title: string;
  version: string;
};

export type CodexAppServerOptions = {
  /**
   * Defaults to "codex". Override when using a pinned or bundled Codex binary.
   */
  codexBinary?: string;
  /**
   * Working directory for the app-server process.
   */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: Partial<CodexClientInfo>;
  experimentalApi?: boolean;
  optOutNotificationMethods?: readonly string[];
  requestTimeoutMs?: number;
  /**
   * Extra args appended after "app-server".
   */
  appServerArgs?: readonly string[];
  /**
   * Connect through the durable local Codex app-server daemon instead of owning
   * a private stdio server process. This lets AGSE hand threads off to the
   * desktop app and disconnect without killing in-flight turns.
   */
  useDaemonProxy?: boolean;
  /**
   * Start the daemon through `codex remote-control start` before proxying to it.
   * This is the background path Codex uses for device/app-owned work that should
   * not require opening or scripting the visible desktop UI.
   */
  useRemoteControlDaemon?: boolean;
  /**
   * Fail instead of falling back to a private stdio app-server when the durable
   * daemon proxy is requested but unavailable.
   */
  requireDaemonProxy?: boolean;
  /**
   * Unix socket used by the managed app-server daemon control plane.
   */
  daemonSocketPath?: string;
};

export type CodexNotification = {
  method: string;
  params?: CodexJson;
};

type CodexResponseMessage = {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
};

const DEFAULT_CLIENT_INFO: CodexClientInfo = {
  name: "agse",
  title: "AGSE",
  version: "0.1.0",
};

export class CodexAppServerClient {
  private readonly options: CodexAppServerOptions;
  private readonly emitter = new EventEmitter();
  private readonly pendingRequests = new Map<number, PendingRequest>();

  private process?: ChildProcessWithoutNullStreams;
  private stdout?: Interface;
  private socket?: WebSocket;
  private transportReadyPromise: Promise<void> = Promise.resolve();
  private nextRequestId = 0;
  private initializePromise?: Promise<unknown>;
  private closed = false;

  constructor(options: CodexAppServerOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<unknown> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.startProcess();
    this.initializePromise = this.transportReadyPromise.then(() => this.initialize());

    return this.initializePromise;
  }

  async request<T = unknown>(
    method: string,
    params?: CodexJsonObject,
  ): Promise<T> {
    await this.connect();

    return this.sendRequest<T>(method, params);
  }

  async notify(method: string, params?: CodexJsonObject): Promise<void> {
    await this.connect();
    this.send({ method, params });
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.emitter.on("notification", listener);

    return () => this.emitter.off("notification", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.emitter.on("clientError", listener);

    return () => this.emitter.off("clientError", listener);
  }

  onStderr(listener: (output: string) => void): () => void {
    this.emitter.on("stderr", listener);

    return () => this.emitter.off("stderr", listener);
  }

  close(): void {
    this.closed = true;
    this.stdout?.close();

    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    this.socket?.close();
    this.rejectPendingRequests(new Error("Codex app-server client closed."));
  }

  private startProcess(): void {
    if (this.process) {
      return;
    }

    const binary = this.options.codexBinary ?? "codex";
    let useDaemonProxy = Boolean(this.options.useDaemonProxy);

    if (useDaemonProxy) {
      const daemonStartArgs = this.options.useRemoteControlDaemon
        ? ["remote-control", "start", "--json"]
        : ["app-server", "daemon", "start"];
      const started = spawnSync(binary, daemonStartArgs, {
        cwd: this.options.cwd,
        encoding: "utf8",
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (started.error || started.status !== 0) {
        const daemonKind = this.options.useRemoteControlDaemon
          ? "remote-control daemon"
          : "app-server daemon";
        const reason = formatDaemonStartFailure({
          daemonKind,
          error: started.error,
          status: started.status,
          stderr: started.stderr,
          stdout: started.stdout,
        });

        if (this.options.requireDaemonProxy) {
          throw new Error(`${reason} AGSE requires a durable background Codex ${daemonKind} for PR workflow handoff; refusing to create a hidden private-stdio chat or open the Codex Desktop UI.`);
        }

        useDaemonProxy = false;
        this.emitter.emit(
          "stderr",
          `${reason} Falling back to stdio.`,
        );
      }
    }

    if (useDaemonProxy) {
      this.startDaemonSocketTransport();
      return;
    }

    const args = ["app-server", ...(this.options.appServerArgs ?? [])];
    const child = spawn(binary, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    this.stdout = createInterface({ input: child.stdout });

    this.stdout.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.emitter.emit("stderr", chunk.toString());
    });
    child.on("error", (error) => {
      this.rejectPendingRequests(error);
      this.emitError(error);
    });
    child.on("exit", (code, signal) => {
      if (this.closed) {
        return;
      }

      const reason = signal
        ? `Codex app-server exited with signal ${signal}.`
        : `Codex app-server exited with code ${code ?? "unknown"}.`;
      const error = new Error(reason);
      this.rejectPendingRequests(error);
      this.emitError(error);
    });
  }

  private startDaemonSocketTransport(): void {
    const socketPath =
      this.options.daemonSocketPath ??
      `${resolveCodexHome(this.options.env)}/app-server-control/app-server-control.sock`;
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => connectSocket(socketPath),
      perMessageDeflate: false,
    });

    this.socket = socket;
    this.transportReadyPromise = new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.on("message", (data) => {
      this.handleLine(data.toString());
    });
    socket.on("error", (error) => {
      this.rejectPendingRequests(error);
      this.emitError(error);
    });
    socket.on("close", (code, reason) => {
      if (this.closed) {
        return;
      }

      const reasonText = reason.toString();
      const error = new Error(
        `Codex app-server daemon socket closed with code ${code}${reasonText ? `: ${reasonText}` : ""}.`,
      );
      this.rejectPendingRequests(error);
      this.emitError(error);
    });
  }

  private async initialize(): Promise<unknown> {
    const capabilities: CodexJsonObject = {};

    if (this.options.experimentalApi !== undefined) {
      capabilities.experimentalApi = this.options.experimentalApi;
    }

    if (this.options.optOutNotificationMethods) {
      capabilities.optOutNotificationMethods = [
        ...this.options.optOutNotificationMethods,
      ];
    }

    const result = await this.sendRequest("initialize", {
      clientInfo: {
        ...DEFAULT_CLIENT_INFO,
        ...this.options.clientInfo,
      },
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    });

    this.send({ method: "initialized", params: {} });

    return result;
  }

  private sendRequest<T = unknown>(
    method: string,
    params?: CodexJsonObject,
  ): Promise<T> {
    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });

    this.send({ method, id, params });

    return promise;
  }

  private send(message: CodexJsonObject): void {
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Codex app-server daemon socket is not open.");
      }

      this.socket.send(JSON.stringify(message));
      return;
    }

    if (!this.process?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;

    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emitError(toError(error));
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if (typeof message.id === "number") {
      this.handleResponse(message as CodexResponseMessage);
      return;
    }

    if (typeof message.method === "string") {
      this.emitter.emit("notification", {
        method: message.method,
        params: message.params as CodexJson | undefined,
      });
    }
  }

  private handleResponse(message: CodexResponseMessage): void {
    const pendingRequest = this.pendingRequests.get(message.id);

    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(message.id);

    if (message.error) {
      pendingRequest.reject(
        new Error(
          `Codex app-server error ${message.error.code}: ${message.error.message}`,
        ),
      );
      return;
    }

    pendingRequest.resolve(message.result);
  }

  private rejectPendingRequests(error: unknown): void {
    for (const [id, pendingRequest] of this.pendingRequests.entries()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private emitError(error: Error): void {
    this.emitter.emit("clientError", error);
  }
}

function resolveCodexHome(env?: NodeJS.ProcessEnv): string {
  return (
    env?.CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    `${process.env.HOME}/.codex`
  );
}

function formatDaemonStartFailure({
  daemonKind,
  error,
  status,
  stderr,
  stdout,
}: {
  daemonKind: string;
  error?: Error;
  status: number | null;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}): string {
  if (error) {
    return `Codex ${daemonKind} unavailable: ${error.message}.`;
  }

  const output = [stderr, stdout]
    .map((value) => value?.toString().trim())
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  const suffix = output ? ` ${truncateOutput(output)}` : "";
  return `Codex ${daemonKind} start failed with code ${status ?? "unknown"}.${suffix}`;
}

function truncateOutput(output: string): string {
  const limit = 2_000;
  return output.length <= limit
    ? output
    : `${output.slice(0, limit)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
