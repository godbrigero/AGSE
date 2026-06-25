import { resolve } from "node:path";
import {
  CodexAppServerClient,
  type CodexAppServerOptions,
  type CodexJson,
  type CodexJsonObject,
  type CodexNotification,
} from "./appServerClient.ts";
import { resolveFolderRoot } from "./folderRoot.ts";

export type CodexWorkflowOptions = CodexAppServerOptions & {
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | string;
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never" | string;
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
  [key: string]: CodexJson | undefined;
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
    const result = await this.request("thread/start", {
      ...this.threadDefaults(),
      ...input,
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
    return this.request("thread/list", params);
  }

  async archiveChat(threadId: string): Promise<unknown> {
    return this.request("thread/archive", { threadId });
  }

  async unarchiveChat(threadId: string): Promise<unknown> {
    return this.request("thread/unarchive", { threadId });
  }

  async renameChat(threadId: string, title: string): Promise<unknown> {
    return this.request("thread/rename", { threadId, title });
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
      ...withoutTimeout(input),
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
    const turn = await this.request("turn/start", {
      ...this.turnDefaults(),
      ...withoutTimeout(input),
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
    return this.request("turn/steer", {
      threadId,
      ...params,
      input: normalizeInput(input),
    });
  }

  async interruptTurn(threadId: string): Promise<unknown> {
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
    return omitUndefined({
      cwd: this.projectRootPath,
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
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

function withoutTimeout(
  input: SendCodexMessageInput,
): Omit<SendCodexMessageInput, "timeoutMs"> {
  const { timeoutMs: _timeoutMs, ...rest } = input;

  return rest;
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
  normalizeInput,
  normalizeThread,
  withoutTimeout,
};
