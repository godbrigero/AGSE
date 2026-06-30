import { resolve } from "node:path";
import {
  CodexAppServerClient,
  type CodexAppServerOptions,
  type CodexJson,
  type CodexJsonObject,
  type CodexNotification,
} from "./appServerClient.ts";
import { startCodexDesktopConversation } from "./desktopBridge.ts";
import {
  requestCodexDesktopAppHost,
  requestCodexDesktopHost,
} from "./desktopBridge.ts";
import { resolveFolderRoot } from "./folderRoot.ts";

export type CodexWorkflowOptions = CodexAppServerOptions & {
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | string;
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never" | string;
  useDesktopApp?: boolean;
  requireDesktopApp?: boolean;
};

export type CodexTextInputItem = {
  type: "text";
  text: string;
};

export type CodexInputItem = CodexTextInputItem | CodexJsonObject;
export type CodexMessageInput = string | readonly CodexInputItem[];

export type StartCodexChatInput = {
  model?: string;
  cwd?: string;
  sandbox?: string;
  approvalPolicy?: string;
  desktopApp?: boolean;
  requireDesktopApp?: boolean;
  title?: string;
  input?: CodexMessageInput;
  workspaceRoots?: readonly string[];
  runtimeWorkspaceRoots?: readonly string[];
  threadSource?: string;
  threadStartKind?: string;
  [key: string]: CodexJson | CodexMessageInput | undefined;
};

export type CodexThread = {
  id: string;
  raw: unknown;
};

export type SendCodexMessageInput = {
  threadId: string;
  input: CodexMessageInput;
  model?: string;
  cwd?: string;
  sandbox?: string;
  approvalPolicy?: string;
  timeoutMs?: number;
  [key: string]: CodexJson | undefined;
};

export type SendCodexMessageResult = {
  threadId: string;
  turn: unknown;
  completed: CodexNotification;
  finalResponse: string;
  notifications: readonly CodexNotification[];
};

export type StartCodexDetachedTurnResult = {
  threadId: string;
  turnId?: string;
  turn: unknown;
};

export type CodexThreadReadResult = {
  thread: CodexThread;
  raw: unknown;
};

export type SendCodexMessageOptions = Omit<
  SendCodexMessageInput,
  "threadId" | "input"
>;

export type CreateCodexChatInput = {
  folderPath: string;
  chat?: StartCodexChatInput;
  options?: CodexWorkflowOptions;
};

export type ResumeCodexChatInput = {
  folderPath: string;
  threadId: string;
  options?: CodexWorkflowOptions;
};

export type CodexChat = {
  readonly rootPath: string;
  readonly threadId: string;
  sendMessage(
    input: CodexMessageInput,
    options?: SendCodexMessageOptions,
  ): Promise<SendCodexMessageResult>;
  fork(input?: CodexJsonObject): Promise<CodexThread>;
  archive(): Promise<unknown>;
  close(): void;
};

export class CodexWorkflows {
  readonly projectRootPath: string;
  readonly client: CodexAppServerClient;

  private readonly options: CodexWorkflowOptions;
  private desktopHost = false;

  constructor(projectRootPath: string, options: CodexWorkflowOptions = {}) {
    this.projectRootPath = resolve(projectRootPath);
    this.options = options;
    this.client = new CodexAppServerClient({
      ...options,
      cwd: options.cwd ?? this.projectRootPath,
    });
  }

  async connect(): Promise<unknown> {
    return this.client.connect();
  }

  async request<T = unknown>(
    method: string,
    params?: CodexJsonObject,
  ): Promise<T> {
    return this.client.request<T>(method, params);
  }

  async startChat(input: StartCodexChatInput = {}): Promise<CodexThread> {
    if (input.desktopApp || this.options.useDesktopApp) {
      try {
        const result = await startCodexDesktopConversation({
          cwd: input.cwd ?? this.projectRootPath,
          title: input.title,
          input: input.input,
          workspaceRoots: input.workspaceRoots ?? input.runtimeWorkspaceRoots,
          sandbox: input.sandbox ?? this.options.sandbox,
          approvalPolicy: input.approvalPolicy ?? this.options.approvalPolicy,
          threadSource: input.threadSource,
          threadStartKind: input.threadStartKind,
          requestTimeoutMs: this.options.requestTimeoutMs,
        });
        this.desktopHost = true;

        return {
          id: result.threadId,
          raw: result.raw,
        };
      } catch (error) {
        if (input.requireDesktopApp || this.options.requireDesktopApp) {
          throw error;
        }
      }
    }

    const {
      desktopApp: _desktopApp,
      requireDesktopApp: _requireDesktopApp,
      title: _title,
      input: _input,
      workspaceRoots: _workspaceRoots,
      threadStartKind: _threadStartKind,
      ...serverInput
    } = input;
    const result = await this.request("thread/start", {
      ...this.threadDefaults(),
      ...serverInput,
    });

    return normalizeThread(result);
  }

  async resumeChat(threadId: string): Promise<CodexThread> {
    const result = await this.request("thread/resume", { threadId });

    return normalizeThread(result);
  }

  async forkChat(
    threadId: string,
    input: CodexJsonObject = {},
  ): Promise<CodexThread> {
    const result = await this.request("thread/fork", { threadId, ...input });

    return normalizeThread(result);
  }

  async listChats(params: CodexJsonObject = {}): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopRequest("thread/list", params);
    }

    return this.request("thread/list", params);
  }

  async archiveChat(threadId: string): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopRequest("thread/archive", { threadId });
    }

    return this.request("thread/archive", { threadId });
  }

  async deleteChat(threadId: string): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopRequest("thread/delete", { threadId });
    }

    return this.request("thread/delete", { threadId });
  }

  async unarchiveChat(threadId: string): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopRequest("thread/unarchive", { threadId });
    }

    return this.request("thread/unarchive", { threadId });
  }

  async renameChat(threadId: string, title: string): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopAppHostRequest("set-thread-title", {
        hostId: "local",
        conversationId: threadId,
        title,
      });
    }

    try {
      return await this.request("thread/name/set", { threadId, name: title });
    } catch (error) {
      return this.request("thread/rename", { threadId, title });
    }
  }

  async readChat(
    threadId: string,
    input: CodexJsonObject = {},
  ): Promise<CodexThreadReadResult> {
    if (this.desktopHost || this.options.useDesktopApp) {
      const result = await this.desktopRequest("thread/read", {
        threadId,
        ...input,
      });

      return {
        thread: normalizeThread(result),
        raw: result,
      };
    }

    const result = await this.request("thread/read", { threadId, ...input });

    return {
      thread: normalizeThread(result),
      raw: result,
    };
  }

  async sendMessage(
    threadId: string,
    input: CodexMessageInput,
    options: SendCodexMessageOptions = {},
  ): Promise<SendCodexMessageResult> {
    return this.startTurn({ threadId, input, ...options });
  }

  async startTurn(
    input: SendCodexMessageInput,
  ): Promise<SendCodexMessageResult> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.startDesktopTurn(input);
    }

    const notifications: CodexNotification[] = [];
    let finalResponse = "";
    let turnId: string | undefined;
    let completionTimer: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};

    const completion = new Promise<CodexNotification>((resolveCompletion) => {
      completionTimer = setTimeout(() => {
        unsubscribe();
        resolveCompletion({
          method: "turn/timeout",
          params: { threadId: input.threadId },
        });
      }, input.timeoutMs ?? this.options.requestTimeoutMs ?? 30 * 60_000);

      unsubscribe = this.client.onNotification((notification) => {
        notifications.push(notification);

        const notificationTurnId = extractTurnId(notification);
        if (!turnId && notificationTurnId) {
          turnId = notificationTurnId;
        }

        const delta = extractAgentMessageDelta(notification);
        if (delta) {
          finalResponse += delta;
        }

        if (
          notification.method === "turn/completed" &&
          (!turnId || !notificationTurnId || notificationTurnId === turnId)
        ) {
          unsubscribe();
          if (completionTimer) {
            clearTimeout(completionTimer);
          }
          resolveCompletion(notification);
        }
      });
    });

    const turn = await this.request("turn/start", {
      ...this.turnDefaults(),
      ...buildTurnParams(input),
      input: normalizeInput(input.input),
    });

    turnId = turnId ?? extractTurnIdFromValue(turn);

    const completedNotification = await completion;

    return {
      threadId: input.threadId,
      turn,
      completed: completedNotification,
      finalResponse,
      notifications,
    };
  }

  async startTurnDetached(
    input: SendCodexMessageInput,
  ): Promise<StartCodexDetachedTurnResult> {
    if (this.desktopHost || this.options.useDesktopApp) {
      const turn = await this.desktopRequest("turn/start", {
        ...this.turnDefaults(),
        ...buildTurnParams(input),
        input: normalizeDesktopInput(input.input),
      });

      return {
        threadId: input.threadId,
        turnId: extractTurnIdFromValue(turn),
        turn,
      };
    }

    const turn = await this.request("turn/start", {
      ...this.turnDefaults(),
      ...buildTurnParams(input),
      input: normalizeInput(input.input),
    });

    return {
      threadId: input.threadId,
      turnId: extractTurnIdFromValue(turn),
      turn,
    };
  }

  async steerMessage(
    threadId: string,
    input: CodexMessageInput,
    params: CodexJsonObject = {},
  ): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopRequest("turn/steer", {
        threadId,
        ...params,
        input: normalizeDesktopInput(input),
      });
    }

    return this.request("turn/steer", {
      threadId,
      ...params,
      input: normalizeInput(input),
    });
  }

  async interruptTurn(threadId: string): Promise<unknown> {
    if (this.desktopHost || this.options.useDesktopApp) {
      return this.desktopRequest("turn/interrupt", { threadId });
    }

    return this.request("turn/interrupt", { threadId });
  }

  close(): void {
    this.client.close();
  }

  private threadDefaults(): CodexJsonObject {
    return omitUndefined({
      model: this.options.model,
      cwd: this.projectRootPath,
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
    });
  }

  private turnDefaults(): CodexJsonObject {
    return normalizeTurnOptions({
      cwd: this.projectRootPath,
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
    });
  }

  private async startDesktopTurn(
    input: SendCodexMessageInput,
  ): Promise<SendCodexMessageResult> {
    const turn = await this.desktopRequest("turn/start", {
      ...this.turnDefaults(),
      ...buildTurnParams(input),
      input: normalizeDesktopInput(input.input),
    });
    const turnId = extractTurnIdFromValue(turn);
    const timeoutMs = input.timeoutMs ?? this.options.requestTimeoutMs ?? 30 * 60_000;
    const completedTurn = await this.waitForDesktopTurn(input.threadId, turnId, timeoutMs);
    const completed: CodexNotification = {
      method: "turn/completed",
      params: {
        threadId: input.threadId,
        turn: completedTurn as CodexJsonObject,
      } as CodexJsonObject,
    };

    return {
      threadId: input.threadId,
      turn,
      completed,
      finalResponse: extractFinalAgentResponse(completedTurn),
      notifications: [completed],
    };
  }

  private async waitForDesktopTurn(
    threadId: string,
    turnId: string | undefined,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;

    do {
      const read = await this.desktopRequest("thread/read", {
        threadId,
        includeTurns: true,
      });
      const turn = findTurn(read, turnId);

      if (turn && isTerminalTurnStatus(turn.status)) {
        return turn;
      }

      await sleep(1_000);
    } while (Date.now() < deadline);

    throw new Error(`Timed out waiting for Codex Desktop turn ${turnId ?? "unknown"} to complete.`);
  }

  private desktopRequest<T = unknown>(
    method: string,
    params: CodexJsonObject,
  ): Promise<T> {
    return requestCodexDesktopHost<T>(method, params as Record<string, unknown>, {
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
  }

  private desktopAppHostRequest<T = unknown>(
    method: string,
    params: CodexJsonObject,
  ): Promise<T> {
    return requestCodexDesktopAppHost<T>(method, params as Record<string, unknown>, {
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
  }
}

export async function startCodexChat(
  projectRootPath: string,
  input?: StartCodexChatInput,
  options?: CodexWorkflowOptions,
): Promise<CodexThread> {
  const rootPath = await resolveFolderRoot(projectRootPath);

  return new CodexWorkflows(rootPath, options).startChat(input);
}

export async function createCodexChat({
  folderPath,
  chat,
  options,
}: CreateCodexChatInput): Promise<CodexChat> {
  const rootPath = await resolveFolderRoot(folderPath);
  const workflows = new CodexWorkflows(rootPath, options);
  const thread = await workflows.startChat(chat);

  return buildCodexChat(rootPath, workflows, thread.id);
}

export async function resumeCodexChat({
  folderPath,
  threadId,
  options,
}: ResumeCodexChatInput): Promise<CodexChat> {
  const rootPath = await resolveFolderRoot(folderPath);
  const workflows = new CodexWorkflows(rootPath, options);
  const thread = await workflows.resumeChat(threadId);

  return buildCodexChat(rootPath, workflows, thread.id);
}

export async function sendCodexMessage(
  projectRootPath: string,
  threadId: string,
  input: CodexMessageInput,
  turnOptions: SendCodexMessageOptions = {},
  workflowOptions?: CodexWorkflowOptions,
): Promise<SendCodexMessageResult> {
  const rootPath = await resolveFolderRoot(projectRootPath);
  const workflows = new CodexWorkflows(rootPath, workflowOptions);

  try {
    await workflows.resumeChat(threadId);

    return await workflows.sendMessage(threadId, input, turnOptions);
  } finally {
    workflows.close();
  }
}

function buildCodexChat(
  rootPath: string,
  workflows: CodexWorkflows,
  threadId: string,
): CodexChat {
  return {
    rootPath,
    threadId,
    sendMessage(input, options) {
      return workflows.sendMessage(threadId, input, options);
    },
    fork(input) {
      return workflows.forkChat(threadId, input);
    },
    archive() {
      return workflows.archiveChat(threadId);
    },
    close() {
      workflows.close();
    },
  };
}

function normalizeInput(input: CodexMessageInput): CodexInputItem[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input }];
  }

  return [...input];
}

function normalizeDesktopInput(input: CodexMessageInput): CodexJsonObject[] {
  return normalizeInput(input).map((item) => {
    if (item.type === "text") {
      return {
        ...item,
        text_elements: [],
      };
    }

    return item;
  });
}

function normalizeThread(value: unknown): CodexThread {
  const thread = isRecord(value) && isRecord(value.thread) ? value.thread : value;

  if (isRecord(thread) && typeof thread.id === "string") {
    return {
      id: thread.id,
      raw: value,
    };
  }

  throw new Error("Codex app-server did not return a thread id.");
}

function findTurn(
  threadReadResult: unknown,
  turnId: string | undefined,
): Record<string, unknown> | undefined {
  const thread = isRecord(threadReadResult) && isRecord(threadReadResult.thread)
    ? threadReadResult.thread
    : undefined;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];

  if (turnId) {
    return turns.find(
      (turn): turn is Record<string, unknown> =>
        isRecord(turn) && turn.id === turnId,
    );
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] as unknown;
    if (isRecord(turn)) {
      return turn;
    }
  }

  return undefined;
}

function isTerminalTurnStatus(status: unknown): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function extractFinalAgentResponse(turn: Record<string, unknown>): string {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const agentMessages = items.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) &&
      item.type === "agentMessage" &&
      typeof item.text === "string",
  );
  const final =
    findLastRecord(agentMessages, (item) => item.phase === "final_answer") ??
    agentMessages.at(-1);

  return typeof final?.text === "string" ? final.text : "";
}

function findLastRecord(
  values: readonly Record<string, unknown>[],
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value && predicate(value)) {
      return value;
    }
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withoutTimeout(
  input: SendCodexMessageInput,
): Omit<SendCodexMessageInput, "timeoutMs"> {
  const { timeoutMs: _timeoutMs, ...rest } = input;

  return rest;
}

function buildTurnParams(input: SendCodexMessageInput): CodexJsonObject {
  return normalizeTurnOptions(withoutTimeout(input));
}

function normalizeTurnOptions(
  values: Record<string, CodexJson | undefined>,
): CodexJsonObject {
  const { sandbox, ...rest } = values;

  return omitUndefined({
    ...rest,
    ...(typeof sandbox === "string"
      ? { sandboxPolicy: sandboxPolicyFromMode(sandbox) }
      : {}),
  });
}

function sandboxPolicyFromMode(mode: string): CodexJsonObject | undefined {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: true };
  }

  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  return undefined;
}

function omitUndefined(values: Record<string, CodexJson | undefined>): CodexJsonObject {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as CodexJsonObject;
}

function extractAgentMessageDelta(notification: CodexNotification): string {
  if (notification.method !== "item/agentMessage/delta") {
    return "";
  }

  const params = notification.params;

  if (!isRecord(params)) {
    return "";
  }

  if (typeof params.delta === "string") {
    return params.delta;
  }

  if (isRecord(params.delta) && typeof params.delta.text === "string") {
    return params.delta.text;
  }

  if (typeof params.text === "string") {
    return params.text;
  }

  return "";
}

function extractTurnId(notification: CodexNotification): string | undefined {
  const params = notification.params;

  if (!isRecord(params)) {
    return undefined;
  }

  if (typeof params.turnId === "string") {
    return params.turnId;
  }

  if (isRecord(params.turn) && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return undefined;
}

function extractTurnIdFromValue(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.turnId === "string") {
    return value.turnId;
  }

  if (isRecord(value.turn) && typeof value.turn.id === "string") {
    return value.turn.id;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __testing = {
  extractAgentMessageDelta,
  extractTurnId,
  extractTurnIdFromValue,
  buildTurnParams,
  normalizeInput,
  normalizeTurnOptions,
  normalizeThread,
  sandboxPolicyFromMode,
  withoutTimeout,
};
