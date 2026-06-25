import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

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
    this.initializePromise = this.initialize();

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

    this.rejectPendingRequests(new Error("Codex app-server client closed."));
  }

  private startProcess(): void {
    if (this.process) {
      return;
    }

    const binary = this.options.codexBinary ?? "codex";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
