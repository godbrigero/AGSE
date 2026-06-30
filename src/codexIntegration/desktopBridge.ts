import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import * as asar from "@electron/asar";
import WebSocket from "ws";
import type { CodexInputItem, CodexMessageInput } from "./workflows.ts";

export type StartCodexDesktopConversationInput = {
  cwd: string;
  title?: string;
  input?: CodexMessageInput;
  workspaceRoots?: readonly string[];
  sandbox?: string;
  approvalPolicy?: string;
  threadSource?: string;
  threadStartKind?: string;
  codexAppPath?: string;
  inspectorPort?: number;
  requestTimeoutMs?: number;
};

export type CodexDesktopHostRequestOptions = {
  codexAppPath?: string;
  inspectorPort?: number;
  requestTimeoutMs?: number;
};

type InspectorTarget = {
  title?: string;
  webSocketDebuggerUrl?: string;
};

type InspectorResponse = {
  id?: number;
  result?: {
    result?: {
      value?: unknown;
    };
    exceptionDetails?: {
      text?: string;
      exception?: {
        description?: string;
      };
    };
  };
  error?: {
    message?: string;
  };
};

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_APP_PATH = "/Applications/Codex.app";
const DEFAULT_INSPECTOR_PORT = 9229;

export async function startCodexDesktopConversation({
  cwd,
  title,
  input,
  workspaceRoots = [cwd],
  sandbox = "danger-full-access",
  approvalPolicy = "never",
  threadSource = "user",
  threadStartKind = "agse-pr-worktree",
  codexAppPath = DEFAULT_CODEX_APP_PATH,
  inspectorPort = DEFAULT_INSPECTOR_PORT,
  requestTimeoutMs = 30_000,
}: StartCodexDesktopConversationInput): Promise<{ threadId: string; raw: unknown }> {
  const appAsarPath = join(codexAppPath, "Contents", "Resources", "app.asar");

  if (!existsSync(appAsarPath)) {
    throw new Error(`Codex Desktop app.asar was not found at ${appAsarPath}.`);
  }

  const target = await ensureCodexInspectorTarget(inspectorPort, requestTimeoutMs);
  const baseChunkPath = resolveDesktopHostRequestChunk(appAsarPath);
  const normalizedInput = normalizeDesktopInput(input);
  const payload = {
    hostId: "local",
    input: normalizedInput,
    commentAttachments: [],
    workspaceRoots: [...workspaceRoots],
    collaborationMode: null,
    multiAgentMode: "explicitRequestOnly",
    serviceTier: "default",
    permissions: {
      sandboxPolicy: desktopSandboxPolicyFromMode(sandbox, workspaceRoots),
      approvalPolicy,
      approvalsReviewer: "user",
    },
    approvalsReviewer: "user",
    cwd,
    attachments: [],
    workspaceKind: "project",
    projectAssignment: {
      projectKind: "local",
      projectId: cwd,
      path: cwd,
      pendingCoreUpdate: false,
    },
    threadSource,
    threadStartKind,
    config: null,
    memoryPreferences: null,
    baseInstructions: null,
    additionalDeveloperInstructions: null,
    ...(normalizedInput.length === 0
      ? { preparePrimaryRuntimeForFirstTurn: false }
      : {}),
  };

  const rendererScript = `
    (async () => {
      const base = await import(${JSON.stringify(baseChunkPath)});
      await base.rv();
      const payload = ${JSON.stringify(payload)};
      const threadId = await base.yg("start-conversation", payload);
      const title = ${JSON.stringify(title ?? null)};
      if (title != null && title.length > 0) {
        await base.yg("set-thread-title", {
          hostId: "local",
          conversationId: threadId,
          title,
        });
      }
      await base.yg("query-cache-invalidate", { queryKey: ["threads"] }).catch(() => null);
      return { threadId };
    })()
  `;

  const result = await evaluateInCodexRenderer(
    target.webSocketDebuggerUrl,
    rendererScript,
    requestTimeoutMs,
  );

  if (!isRecord(result) || typeof result.threadId !== "string") {
    throw new Error("Codex Desktop did not return a thread id.");
  }

  return { threadId: result.threadId, raw: result };
}

export async function requestCodexDesktopHost<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  {
    codexAppPath = DEFAULT_CODEX_APP_PATH,
    inspectorPort = DEFAULT_INSPECTOR_PORT,
    requestTimeoutMs = 30_000,
  }: CodexDesktopHostRequestOptions = {},
): Promise<T> {
  const appAsarPath = join(codexAppPath, "Contents", "Resources", "app.asar");

  if (!existsSync(appAsarPath)) {
    throw new Error(`Codex Desktop app.asar was not found at ${appAsarPath}.`);
  }

  const target = await ensureCodexInspectorTarget(inspectorPort, requestTimeoutMs);
  const baseChunkPath = resolveDesktopHostRequestChunk(appAsarPath);
  const rendererScript = `
    (async () => {
      const base = await import(${JSON.stringify(baseChunkPath)});
      await base.rv();
      return await base.yg("send-cli-request-for-host", {
        hostId: "local",
        method: ${JSON.stringify(method)},
        params: ${JSON.stringify(params)},
        timeoutMs: ${JSON.stringify(requestTimeoutMs)},
      });
    })()
  `;

  return await evaluateInCodexRenderer(
    target.webSocketDebuggerUrl,
    rendererScript,
    requestTimeoutMs,
  ) as T;
}

export async function requestCodexDesktopAppHost<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  {
    codexAppPath = DEFAULT_CODEX_APP_PATH,
    inspectorPort = DEFAULT_INSPECTOR_PORT,
    requestTimeoutMs = 30_000,
  }: CodexDesktopHostRequestOptions = {},
): Promise<T> {
  const appAsarPath = join(codexAppPath, "Contents", "Resources", "app.asar");

  if (!existsSync(appAsarPath)) {
    throw new Error(`Codex Desktop app.asar was not found at ${appAsarPath}.`);
  }

  const target = await ensureCodexInspectorTarget(inspectorPort, requestTimeoutMs);
  const baseChunkPath = resolveDesktopHostRequestChunk(appAsarPath);
  const rendererScript = `
    (async () => {
      const base = await import(${JSON.stringify(baseChunkPath)});
      await base.rv();
      return await base.yg(${JSON.stringify(method)}, ${JSON.stringify(params)});
    })()
  `;

  return await evaluateInCodexRenderer(
    target.webSocketDebuggerUrl,
    rendererScript,
    requestTimeoutMs,
  ) as T;
}

export async function requestCodexDesktopIpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  {
    codexAppPath = DEFAULT_CODEX_APP_PATH,
    inspectorPort = DEFAULT_INSPECTOR_PORT,
    requestTimeoutMs = 30_000,
  }: CodexDesktopHostRequestOptions = {},
): Promise<T> {
  const appAsarPath = join(codexAppPath, "Contents", "Resources", "app.asar");

  if (!existsSync(appAsarPath)) {
    throw new Error(`Codex Desktop app.asar was not found at ${appAsarPath}.`);
  }

  const target = await ensureCodexInspectorTarget(inspectorPort, requestTimeoutMs);
  const ipcChunkPath = resolveDesktopIpcRequestChunk(appAsarPath);
  const rendererScript = `
    (async () => {
      const common = await import(${JSON.stringify(ipcChunkPath)});
      return await common.i(${JSON.stringify(method)}, {
        params: ${JSON.stringify(params)},
      });
    })()
  `;

  return await evaluateInCodexRenderer(
    target.webSocketDebuggerUrl,
    rendererScript,
    requestTimeoutMs,
  ) as T;
}

export async function dispatchCodexDesktopMessage(
  type: string,
  params: Record<string, unknown>,
  {
    codexAppPath = DEFAULT_CODEX_APP_PATH,
    inspectorPort = DEFAULT_INSPECTOR_PORT,
    requestTimeoutMs = 30_000,
  }: CodexDesktopHostRequestOptions = {},
): Promise<void> {
  const appAsarPath = join(codexAppPath, "Contents", "Resources", "app.asar");

  if (!existsSync(appAsarPath)) {
    throw new Error(`Codex Desktop app.asar was not found at ${appAsarPath}.`);
  }

  const target = await ensureCodexInspectorTarget(inspectorPort, requestTimeoutMs);
  const ipcChunkPath = resolveDesktopIpcRequestChunk(appAsarPath);
  const rendererScript = `
    (async () => {
      const common = await import(${JSON.stringify(ipcChunkPath)});
      common.v.dispatchMessage(${JSON.stringify(type)}, ${JSON.stringify(params)});
    })()
  `;

  await evaluateInCodexRenderer(
    target.webSocketDebuggerUrl,
    rendererScript,
    requestTimeoutMs,
  );
}

async function ensureCodexInspectorTarget(
  inspectorPort: number,
  timeoutMs: number,
): Promise<Required<Pick<InspectorTarget, "webSocketDebuggerUrl">>> {
  const existing = await readCodexInspectorTarget(inspectorPort);

  if (existing?.webSocketDebuggerUrl) {
    return { webSocketDebuggerUrl: existing.webSocketDebuggerUrl };
  }

  const pid = await findCodexDesktopMainPid();

  if (pid == null) {
    throw new Error("Codex Desktop is not running; refusing to open it for background AGSE chat creation.");
  }

  process.kill(pid, "SIGUSR1");

  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  do {
    await sleep(250);
    const target = await readCodexInspectorTarget(inspectorPort);
    if (target?.webSocketDebuggerUrl) {
      return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
    }
  } while (Date.now() < deadline);

  throw new Error("Codex Desktop inspector did not become available after SIGUSR1.");
}

async function readCodexInspectorTarget(
  inspectorPort: number,
): Promise<InspectorTarget | null> {
  try {
    const targets = await readJson<InspectorTarget[]>(
      `http://127.0.0.1:${inspectorPort}/json/list`,
      500,
    );

    return (
      targets.find((target) =>
        target.webSocketDebuggerUrl &&
        (target.title === "electron/js2c/browser_init" ||
          target.title?.toLowerCase().includes("electron"))
      ) ?? null
    );
  } catch {
    return null;
  }
}

async function findCodexDesktopMainPid(): Promise<number | null> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const candidates = stdout
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((entry): entry is { pid: number; command: string } => entry != null)
    .filter(({ command }) =>
      command.includes("/Codex.app/Contents/MacOS/Codex") &&
      !command.includes(" Helper") &&
      !command.includes("app-server"),
    );

  return candidates[0]?.pid ?? null;
}

function resolveDesktopHostRequestChunk(appAsarPath: string): string {
  const files = asar.listPackage(appAsarPath, { isPack: false });

  for (const file of files) {
    if (!file.endsWith(".js") || !file.includes("/webview/assets/")) {
      continue;
    }

    const archivePath = file.replace(/^\//, "");
    const content = asar.extractFile(appAsarPath, archivePath).toString("utf8");

    if (content.includes("function Tg(e,t){return Cg.sendRequest(e,t)}")) {
      return `./${archivePath.replace(/^webview\//, "")}`;
    }
  }

  throw new Error("Could not find Codex Desktop host request chunk.");
}

function resolveDesktopIpcRequestChunk(appAsarPath: string): string {
  const files = asar.listPackage(appAsarPath, { isPack: false });

  for (const file of files) {
    if (!file.endsWith(".js") || !file.includes("/webview/assets/")) {
      continue;
    }

    const archivePath = file.replace(/^\//, "");
    const content = asar.extractFile(appAsarPath, archivePath).toString("utf8");

    if (
      content.includes("function Tg(e,t){return Cg.sendRequest(e,t)}") &&
      content.includes("connect-app-host")
    ) {
      return `./${archivePath.replace(/^webview\//, "")}`;
    }
  }

  throw new Error("Could not find Codex Desktop IPC request chunk.");
}

async function evaluateInCodexRenderer(
  webSocketDebuggerUrl: string,
  rendererScript: string,
  timeoutMs: number,
): Promise<unknown> {
  const expression = `
    (async () => {
      const electron = process.mainModule.require("electron");
      const webContents = electron.webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith("app://"));
      if (!webContents) {
        throw new Error("Codex Desktop renderer webContents was not found.");
      }
      return await webContents.executeJavaScript(${JSON.stringify(rendererScript)}, true);
    })()
  `;
  const response = await sendInspectorRequest(
    webSocketDebuggerUrl,
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  );

  const exception = response.result?.exceptionDetails;
  if (exception) {
    throw new Error(
      exception.exception?.description ?? exception.text ?? "Codex Desktop renderer evaluation failed.",
    );
  }

  if (response.error) {
    throw new Error(response.error.message ?? "Codex Desktop inspector request failed.");
  }

  return response.result?.result?.value;
}

async function sendInspectorRequest(
  webSocketDebuggerUrl: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<InspectorResponse> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  try {
    return await new Promise<InspectorResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Codex Desktop inspector request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      socket.once("message", (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()) as InspectorResponse);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

function normalizeDesktopInput(input: CodexMessageInput | undefined): CodexInputItem[] {
  if (input == null) {
    return [];
  }

  const items = typeof input === "string" ? [{ type: "text" as const, text: input }] : [...input];

  return items.map((item) => {
    if (item.type === "text") {
      return { ...item, text_elements: [] } as CodexInputItem;
    }

    return item;
  });
}

function desktopSandboxPolicyFromMode(
  mode: string,
  workspaceRoots: readonly string[],
): Record<string, unknown> {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: true };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [...workspaceRoots],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function readJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out reading ${url}.`));
    });
    request.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
