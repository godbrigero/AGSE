import {
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  tagSession,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { buildClaudeCodeOptions, type ClaudeCodeSessionOptions } from "./options.ts";
import { resolveFolderRoot } from "./folderRoot.ts";
import {
  summarizeRun,
  type ClaudeCodeMessageContent,
  type ClaudeCodeRunResult,
} from "./messages.ts";

export type CreateClaudeCodeChatInput = {
  folderPath: string;
  title?: string;
  sessionId?: string;
  options?: ClaudeCodeSessionOptions;
};

export type SendClaudeCodeMessageInput = {
  folderPath: string;
  message: ClaudeCodeMessageContent;
  title?: string;
  sessionId?: string;
  resumeSessionId?: string;
  options?: ClaudeCodeSessionOptions;
};

export type ListClaudeCodeChatsInput = {
  folderPath: string;
  limit?: number;
  includeWorktrees?: boolean;
};

export type GetClaudeCodeChatMessagesInput = {
  folderPath: string;
  sessionId: string;
  limit?: number;
  offset?: number;
};

export type ClaudeCodeWorkflowOptions = ClaudeCodeSessionOptions;

export type ClaudeCodeChat = {
  readonly rootPath: string;
  readonly sessionId: string;
  sendMessage(message: ClaudeCodeMessageContent): Promise<ClaudeCodeRunResult>;
  getMessages(limit?: number, offset?: number): Promise<SessionMessage[]>;
  rename(title: string): Promise<void>;
  tag(tag: string | null): Promise<void>;
};

export class ClaudeCodeWorkflows {
  readonly rootPath: string;
  readonly options?: ClaudeCodeWorkflowOptions;

  constructor(rootPath: string, options?: ClaudeCodeWorkflowOptions) {
    this.rootPath = rootPath;
    this.options = options;
  }

  createChat(
    input: Omit<CreateClaudeCodeChatInput, "folderPath" | "options"> & {
      options?: ClaudeCodeWorkflowOptions;
    } = {},
  ): Promise<ClaudeCodeChat> {
    return createClaudeCodeChat({
      ...input,
      folderPath: this.rootPath,
      options: {
        ...this.options,
        ...input.options,
      },
    });
  }

  sendMessage(
    input: Omit<SendClaudeCodeMessageInput, "folderPath" | "options"> & {
      options?: ClaudeCodeWorkflowOptions;
    },
  ): Promise<ClaudeCodeRunResult> {
    return sendClaudeCodeMessage({
      ...input,
      folderPath: this.rootPath,
      options: {
        ...this.options,
        ...input.options,
      },
    });
  }

  continueChat(
    sessionId: string,
    message: ClaudeCodeMessageContent,
    options?: ClaudeCodeWorkflowOptions,
  ): Promise<ClaudeCodeRunResult> {
    return continueClaudeCodeChat(this.rootPath, sessionId, message, {
      ...this.options,
      ...options,
    });
  }

  listChats(
    input: Omit<ListClaudeCodeChatsInput, "folderPath"> = {},
  ): Promise<SDKSessionInfo[]> {
    return listClaudeCodeChats({
      ...input,
      folderPath: this.rootPath,
    });
  }

  getChatMessages(
    input: Omit<GetClaudeCodeChatMessagesInput, "folderPath">,
  ): Promise<SessionMessage[]> {
    return getClaudeCodeChatMessages({
      ...input,
      folderPath: this.rootPath,
    });
  }

  renameChat(sessionId: string, title: string): Promise<void> {
    return renameClaudeCodeChat(this.rootPath, sessionId, title);
  }

  tagChat(sessionId: string, tag: string | null): Promise<void> {
    return tagClaudeCodeChat(this.rootPath, sessionId, tag);
  }
}

export async function createClaudeCodeChat({
  folderPath,
  title,
  sessionId = randomUUID(),
  options,
}: CreateClaudeCodeChatInput): Promise<ClaudeCodeChat> {
  const rootPath = await resolveFolderRoot(folderPath);
  let hasStartedSession = false;

  return {
    rootPath,
    sessionId,
    async sendMessage(message) {
      const result = await sendClaudeCodeMessage({
        folderPath: rootPath,
        message,
        title,
        sessionId: hasStartedSession ? undefined : sessionId,
        resumeSessionId: hasStartedSession ? sessionId : undefined,
        options,
      });

      hasStartedSession = Boolean(result.sessionId);

      return result;
    },
    async getMessages(limit, offset) {
      return getClaudeCodeChatMessages({
        folderPath: rootPath,
        sessionId,
        limit,
        offset,
      });
    },
    async rename(newTitle) {
      await renameClaudeCodeChat(rootPath, sessionId, newTitle);
    },
    async tag(newTag) {
      await tagClaudeCodeChat(rootPath, sessionId, newTag);
    },
  };
}

export async function sendClaudeCodeMessage({
  folderPath,
  message,
  title,
  sessionId,
  resumeSessionId,
  options,
}: SendClaudeCodeMessageInput): Promise<ClaudeCodeRunResult> {
  const rootPath = await resolveFolderRoot(folderPath);
  const messages: SDKMessage[] = [];
  const run = query({
    prompt: message,
    options: buildClaudeCodeOptions({
      rootPath,
      sessionId: resumeSessionId ? undefined : sessionId,
      resumeSessionId,
      options: {
        ...options,
        title: title ?? options?.title,
      },
    }),
  });

  for await (const sdkMessage of run) {
    messages.push(sdkMessage);
  }

  return summarizeRun(messages);
}

export async function continueClaudeCodeChat(
  folderPath: string,
  sessionId: string,
  message: ClaudeCodeMessageContent,
  options?: ClaudeCodeSessionOptions,
): Promise<ClaudeCodeRunResult> {
  return sendClaudeCodeMessage({
    folderPath,
    message,
    resumeSessionId: sessionId,
    options,
  });
}

export async function listClaudeCodeChats({
  folderPath,
  limit,
  includeWorktrees,
}: ListClaudeCodeChatsInput): Promise<SDKSessionInfo[]> {
  const rootPath = await resolveFolderRoot(folderPath);

  return listSessions({
    dir: rootPath,
    limit,
    includeWorktrees,
  });
}

export async function getClaudeCodeChatMessages({
  folderPath,
  sessionId,
  limit,
  offset,
}: GetClaudeCodeChatMessagesInput): Promise<SessionMessage[]> {
  const rootPath = await resolveFolderRoot(folderPath);

  return getSessionMessages(sessionId, {
    dir: rootPath,
    limit,
    offset,
  });
}

export async function renameClaudeCodeChat(
  folderPath: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const rootPath = await resolveFolderRoot(folderPath);

  await renameSession(sessionId, title, { dir: rootPath });
}

export async function tagClaudeCodeChat(
  folderPath: string,
  sessionId: string,
  tag: string | null,
): Promise<void> {
  const rootPath = await resolveFolderRoot(folderPath);

  await tagSession(sessionId, tag, { dir: rootPath });
}
