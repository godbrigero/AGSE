import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  dispatchCodexDesktopMessage,
  requestCodexDesktopIpc,
} from "./desktopBridge.ts";

export type RegisterCodexWorkspaceRootInput = {
  rootPath: string;
  parentRootPath?: string;
  label?: string;
  threadId?: string;
  codexHome?: string;
  globalStatePath?: string;
};

export type UnregisterCodexWorkspaceRootInput = {
  rootPath: string;
  threadId?: string;
  codexHome?: string;
  globalStatePath?: string;
};

export type ScrubCodexWorkspaceRootsInput = {
  rootPaths?: readonly string[];
  rootPathPrefix?: string;
  codexHome?: string;
  globalStatePath?: string;
};

export type ScrubCodexThreadWorkspaceReferencesInput = {
  rootPaths?: readonly string[];
  rootPathPrefix?: string;
  replacementRootPath: string;
  codexHome?: string;
  stateDbPath?: string;
};

export type ScrubCodexThreadWorkspaceReferencesResult = {
  removedRoots: string[];
  threadIds: string[];
  archivedThreadIds: string[];
};

const CODEX_GLOBAL_STATE_FILE = ".codex-global-state.json";
const SAVED_WORKSPACE_ROOTS_KEY = "electron-saved-workspace-roots";
const ACTIVE_WORKSPACE_ROOTS_KEY = "active-workspace-roots";
const PROJECT_ORDER_KEY = "project-order";
const THREAD_WORKSPACE_ROOT_HINTS_KEY = "thread-workspace-root-hints";
const THREAD_PROJECT_ASSIGNMENTS_KEY = "thread-project-assignments";
const THREAD_WRITABLE_ROOTS_KEY = "thread-writable-roots";
const PERSISTED_ATOM_STATE_KEY = "electron-persisted-atom-state";
const PROMPT_HISTORY_KEY = "prompt-history";
const THREAD_PERMISSIONS_BY_ID_KEY = "heartbeat-thread-permissions-by-id";
const THREAD_CLIENT_ID_KEY_PREFIX = "thread-client-id-v1:";
const SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX =
  "sidebar-project-expanded-v1-codex:";
const WORKSPACE_ROOT_LABEL_KEY_PREFIX = "electron-workspace-root-labels/";
const WORKSPACE_ROOT_LABELS_KEY = "electron-workspace-root-labels";
const DESKTOP_SYNC_GLOBAL_STATE_KEYS = [
  SAVED_WORKSPACE_ROOTS_KEY,
  ACTIVE_WORKSPACE_ROOTS_KEY,
  PROJECT_ORDER_KEY,
  WORKSPACE_ROOT_LABELS_KEY,
  THREAD_PROJECT_ASSIGNMENTS_KEY,
  THREAD_WRITABLE_ROOTS_KEY,
  THREAD_WORKSPACE_ROOT_HINTS_KEY,
  PERSISTED_ATOM_STATE_KEY,
] as const;
const CODEX_THREAD_STATE_DB = "state_5.sqlite";
const CODEX_THREAD_TEXT_COLUMNS = [
  "title",
  "first_user_message",
  "preview",
] as const;

type CodexThreadTextColumn = (typeof CODEX_THREAD_TEXT_COLUMNS)[number];

type CodexThreadRow = {
  id: string;
  archived: boolean;
  cwd: string;
} & Record<CodexThreadTextColumn, string>;

type CodexThreadRowUpdate = CodexThreadRow;

export async function registerCodexWorkspaceRoot({
  rootPath,
  parentRootPath,
  label,
  threadId,
  codexHome,
  globalStatePath,
}: RegisterCodexWorkspaceRootInput): Promise<void> {
  const statePath =
    globalStatePath ??
    join(resolveCodexHome(codexHome), CODEX_GLOBAL_STATE_FILE);
  const normalizedRootPath = resolve(rootPath);
  const normalizedParentRootPath = parentRootPath
    ? resolve(parentRootPath)
    : undefined;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const state = await readCodexGlobalState(statePath);

    state[SAVED_WORKSPACE_ROOTS_KEY] = upsertPathAfter(
      readStringArray(state[SAVED_WORKSPACE_ROOTS_KEY]),
      normalizedRootPath,
      normalizedParentRootPath,
    );
    state[PROJECT_ORDER_KEY] = upsertPathAfter(
      readStringArray(state[PROJECT_ORDER_KEY]),
      normalizedRootPath,
      normalizedParentRootPath,
    );
    setWorkspaceRootExpanded(state, normalizedRootPath, true);

    if (label?.trim()) {
      setWorkspaceRootLabel(state, normalizedRootPath, label.trim());
    }

    if (threadId) {
      const hints = isRecord(state[THREAD_WORKSPACE_ROOT_HINTS_KEY])
        ? { ...state[THREAD_WORKSPACE_ROOT_HINTS_KEY] }
        : {};

      hints[threadId] = normalizedRootPath;
      state[THREAD_WORKSPACE_ROOT_HINTS_KEY] = hints;
    }

    await writeCodexGlobalState(statePath, state);
    await syncCodexDesktopSidebarGlobalState(state, globalStatePath == null);

    const savedState = await readCodexGlobalState(statePath);
    if (
      isRootRegistered(savedState, normalizedRootPath, label, threadId, normalizedParentRootPath)
    ) {
      return;
    }

    if (attempt < 3) {
      await sleep(50);
    }
  }

  throw new Error(`Codex workspace root registration did not persist: ${normalizedRootPath}`);
}

export async function unregisterCodexWorkspaceRoot({
  rootPath,
  threadId,
  codexHome,
  globalStatePath,
}: UnregisterCodexWorkspaceRootInput): Promise<void> {
  const statePath =
    globalStatePath ??
    join(resolveCodexHome(codexHome), CODEX_GLOBAL_STATE_FILE);
  const normalizedRootPath = resolve(rootPath);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const state = await readCodexGlobalState(statePath);

    state[SAVED_WORKSPACE_ROOTS_KEY] = readStringArray(
      state[SAVED_WORKSPACE_ROOTS_KEY],
    ).filter((entry) => entry !== normalizedRootPath);
    state[ACTIVE_WORKSPACE_ROOTS_KEY] = readStringArray(
      state[ACTIVE_WORKSPACE_ROOTS_KEY],
    ).filter((entry) => entry !== normalizedRootPath);
    state[PROJECT_ORDER_KEY] = readStringArray(state[PROJECT_ORDER_KEY]).filter(
      (entry) => entry !== normalizedRootPath,
    );
    deleteWorkspaceRootSidebarState(state, normalizedRootPath);

    if (threadId && isRecord(state[THREAD_WORKSPACE_ROOT_HINTS_KEY])) {
      const hints = { ...state[THREAD_WORKSPACE_ROOT_HINTS_KEY] };
      delete hints[threadId];
      state[THREAD_WORKSPACE_ROOT_HINTS_KEY] = hints;
    }
    if (threadId) {
      deleteThreadPersistedAtomState(state, new Set([threadId]));
      deleteThreadWorkspaceState(state, new Set([threadId]));
    }

    await writeCodexGlobalState(statePath, state);
    await syncCodexDesktopSidebarGlobalState(state, globalStatePath == null);

    const savedState = await readCodexGlobalState(statePath);
    if (isRootUnregistered(savedState, normalizedRootPath, threadId)) {
      return;
    }

    if (attempt < 3) {
      await sleep(50);
    }
  }

  throw new Error(`Codex workspace root unregistration did not persist: ${normalizedRootPath}`);
}

export async function scrubCodexWorkspaceRoots({
  rootPaths,
  rootPathPrefix,
  codexHome,
  globalStatePath,
}: ScrubCodexWorkspaceRootsInput): Promise<string[]> {
  const statePath =
    globalStatePath ??
    join(resolveCodexHome(codexHome), CODEX_GLOBAL_STATE_FILE);
  const explicitRoots = new Set((rootPaths ?? []).map((entry) => resolve(entry)));
  const normalizedPrefix = rootPathPrefix ? `${resolve(rootPathPrefix)}/` : undefined;
  const removedRoots: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const state = await readCodexGlobalState(statePath);
    const candidateRoots = [
      ...readStringArray(state[SAVED_WORKSPACE_ROOTS_KEY]),
      ...readStringArray(state[ACTIVE_WORKSPACE_ROOTS_KEY]),
      ...readStringArray(state[PROJECT_ORDER_KEY]),
      ...Object.keys(state)
        .filter((key) => key.startsWith(SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX))
        .map((key) => key.slice(SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX.length)),
      ...Object.keys(state)
        .filter((key) => key.startsWith(WORKSPACE_ROOT_LABEL_KEY_PREFIX))
        .map((key) => key.slice(WORKSPACE_ROOT_LABEL_KEY_PREFIX.length)),
      ...readWorkspaceLabelRoots(state[WORKSPACE_ROOT_LABELS_KEY]),
      ...readThreadProjectAssignmentRoots(state[THREAD_PROJECT_ASSIGNMENTS_KEY]),
      ...readThreadWritableRoots(state[THREAD_WRITABLE_ROOTS_KEY]),
      ...readSidebarRootsFromPersistedAtomState(state),
    ];
    const rootsToRemove = new Set<string>();

    for (const candidateRoot of candidateRoots) {
      const normalizedRoot = resolve(candidateRoot);
      const shouldConsider =
        explicitRoots.has(normalizedRoot) ||
        Boolean(normalizedPrefix && `${normalizedRoot}/`.startsWith(normalizedPrefix));

      if (!shouldConsider) {
        continue;
      }

      if (explicitRoots.has(normalizedRoot) || !(await pathExists(normalizedRoot))) {
        rootsToRemove.add(normalizedRoot);
      }
    }

    if (rootsToRemove.size === 0) {
      return removedRoots;
    }

    removeRootsFromState(state, rootsToRemove);
    await writeCodexGlobalState(statePath, state);
    await syncCodexDesktopSidebarGlobalState(state, globalStatePath == null);

    const savedState = await readCodexGlobalState(statePath);
    if (rootsAreRemoved(savedState, rootsToRemove)) {
      removedRoots.push(...rootsToRemove);
      return [...new Set(removedRoots)];
    }

    if (attempt < 3) {
      await sleep(50);
    }
  }

  throw new Error("Codex workspace root scrub did not persist.");
}

export async function scrubCodexThreadWorkspaceReferences({
  rootPaths,
  rootPathPrefix,
  replacementRootPath,
  codexHome,
  stateDbPath,
}: ScrubCodexThreadWorkspaceReferencesInput): Promise<ScrubCodexThreadWorkspaceReferencesResult> {
  const dbPath =
    stateDbPath ?? join(resolveCodexHome(codexHome), CODEX_THREAD_STATE_DB);

  if (!(await pathExists(dbPath))) {
    return { removedRoots: [], threadIds: [], archivedThreadIds: [] };
  }

  const normalizedReplacementRootPath = resolve(replacementRootPath);
  const explicitRoots = new Set((rootPaths ?? []).map((entry) => resolve(entry)));
  const normalizedPrefix = rootPathPrefix
    ? `${resolve(rootPathPrefix).replace(/\/+$/, "")}/`
    : undefined;
  const searchNeedles = explicitRoots.size > 0
    ? [...explicitRoots]
    : normalizedPrefix
      ? [normalizedPrefix]
      : [];

  if (searchNeedles.length === 0) {
    return { removedRoots: [], threadIds: [], archivedThreadIds: [] };
  }

  const rows = readThreadRowsWithWorkspaceReferences(dbPath, searchNeedles);
  const updates: CodexThreadRowUpdate[] = [];
  const removedRoots = new Set<string>();
  const threadIds = new Set<string>();
  const archivedThreadIds = new Set<string>();

  for (const row of rows) {
    const rowRoots = collectThreadWorkspaceRoots(row, normalizedPrefix, explicitRoots);
    const staleRoots = new Set<string>();

    for (const rootPath of rowRoots) {
      if (!isAgseManagedWorktreeRoot(rootPath, normalizedPrefix, explicitRoots)) {
        continue;
      }

      if (explicitRoots.has(rootPath) || !(await pathExists(rootPath))) {
        staleRoots.add(rootPath);
      }
    }

    if (staleRoots.size === 0) {
      continue;
    }

    const nextRow = replaceThreadWorkspaceRoots(
      row,
      staleRoots,
      normalizedReplacementRootPath,
    );

    if (!threadRowsAreEqual(row, nextRow)) {
      updates.push(nextRow);
      threadIds.add(row.id);
      if (row.archived) {
        archivedThreadIds.add(row.id);
      }
      for (const rootPath of staleRoots) {
        removedRoots.add(rootPath);
      }
    }
  }

  if (updates.length === 0) {
    return { removedRoots: [], threadIds: [], archivedThreadIds: [] };
  }

  updateThreadRows(dbPath, updates);

  return {
    removedRoots: [...removedRoots],
    threadIds: [...threadIds],
    archivedThreadIds: [...archivedThreadIds],
  };
}

function readThreadRowsWithWorkspaceReferences(
  dbPath: string,
  searchNeedles: readonly string[],
): CodexThreadRow[] {
  const searchableColumns = ["cwd", ...CODEX_THREAD_TEXT_COLUMNS];
  const predicate = searchNeedles
    .flatMap((needle) =>
      searchableColumns.map(
        (column) => `instr(${column}, ${sqlStringLiteral(needle)}) > 0`,
      ),
    )
    .join(" OR ");
  const sql = `SELECT id, archived, cwd, ${CODEX_THREAD_TEXT_COLUMNS.join(", ")} FROM threads WHERE ${predicate};`;
  const rawRows = runSqlite(dbPath, ["-json"], sql);

  if (!rawRows.trim()) {
    return [];
  }

  const parsed: unknown = JSON.parse(rawRows);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter(isRecord)
    .map((row) => ({
      id: readStringField(row.id),
      archived: row.archived === 1 || row.archived === true,
      cwd: readStringField(row.cwd),
      title: readStringField(row.title),
      first_user_message: readStringField(row.first_user_message),
      preview: readStringField(row.preview),
    }))
    .filter((row) => row.id.length > 0);
}

function collectThreadWorkspaceRoots(
  row: CodexThreadRow,
  normalizedPrefix: string | undefined,
  explicitRoots: ReadonlySet<string>,
): Set<string> {
  const roots = new Set<string>();

  for (const value of [
    row.cwd,
    ...CODEX_THREAD_TEXT_COLUMNS.map((column) => row[column]),
  ]) {
    collectWorkspaceRootsFromValue(value, normalizedPrefix, explicitRoots, roots);
  }

  return roots;
}

function collectWorkspaceRootsFromValue(
  value: string,
  normalizedPrefix: string | undefined,
  explicitRoots: ReadonlySet<string>,
  roots: Set<string>,
): void {
  for (const rootPath of explicitRoots) {
    if (value.includes(rootPath)) {
      roots.add(rootPath);
    }
  }

  if (!normalizedPrefix || !value.includes(normalizedPrefix)) {
    return;
  }

  const worktreePathPattern = new RegExp(
    `${escapeRegExp(normalizedPrefix)}[^\\s"'<>),\\]]+`,
    "g",
  );

  for (const match of value.matchAll(worktreePathPattern)) {
    const rootPath = extractCodexWorktreeRoot(match[0], normalizedPrefix);

    if (rootPath) {
      roots.add(rootPath);
    }
  }
}

function extractCodexWorktreeRoot(
  candidatePath: string,
  normalizedPrefix: string,
): string | undefined {
  const sanitizedPath = candidatePath.replace(/[.,;:!?]+$/, "");
  const relativePath = sanitizedPath.slice(normalizedPrefix.length);
  const [containerName, worktreeName] = relativePath.split("/");

  if (!containerName || !worktreeName) {
    return undefined;
  }

  return resolve(`${normalizedPrefix}${containerName}/${worktreeName}`);
}

function isAgseManagedWorktreeRoot(
  rootPath: string,
  normalizedPrefix: string | undefined,
  explicitRoots: ReadonlySet<string>,
): boolean {
  if (explicitRoots.has(rootPath)) {
    return true;
  }

  if (!normalizedPrefix || !rootPath.startsWith(normalizedPrefix)) {
    return false;
  }

  const relativePath = rootPath.slice(normalizedPrefix.length);
  const [containerName, worktreeName, extraPath] = relativePath.split("/");

  return Boolean(
    containerName &&
      worktreeName?.startsWith("issue-") &&
      extraPath === undefined,
  );
}

function replaceThreadWorkspaceRoots(
  row: CodexThreadRow,
  staleRoots: ReadonlySet<string>,
  replacementRootPath: string,
): CodexThreadRowUpdate {
  const sortedRoots = [...staleRoots].sort((left, right) => right.length - left.length);
  const nextRow: CodexThreadRowUpdate = { ...row };

  if (staleRoots.has(row.cwd)) {
    nextRow.cwd = replacementRootPath;
  }

  for (const column of CODEX_THREAD_TEXT_COLUMNS) {
    let nextValue = row[column];

    for (const rootPath of sortedRoots) {
      nextValue = nextValue.split(rootPath).join(replacementRootPath);
    }

    nextRow[column] = nextValue;
  }

  return nextRow;
}

function threadRowsAreEqual(left: CodexThreadRow, right: CodexThreadRow): boolean {
  return (
    left.cwd === right.cwd &&
    left.title === right.title &&
    left.first_user_message === right.first_user_message &&
    left.preview === right.preview
  );
}

function updateThreadRows(dbPath: string, updates: readonly CodexThreadRowUpdate[]): void {
  const updateStatements = updates
    .map(
      (row) => [
        "UPDATE threads",
        "SET",
        `  cwd = ${sqlStringLiteral(row.cwd)},`,
        `  title = ${sqlStringLiteral(row.title)},`,
        `  first_user_message = ${sqlStringLiteral(row.first_user_message)},`,
        `  preview = ${sqlStringLiteral(row.preview)}`,
        `WHERE id = ${sqlStringLiteral(row.id)};`,
      ].join("\n"),
    )
    .join("\n");

  runSqlite(
    dbPath,
    [],
    [
      "PRAGMA busy_timeout=5000;",
      "BEGIN IMMEDIATE;",
      updateStatements,
      "COMMIT;",
    ].join("\n"),
  );
}

function runSqlite(
  dbPath: string,
  args: readonly string[],
  input: string,
): string {
  const result = spawnSync("sqlite3", [...args, dbPath], {
    encoding: "utf8",
    input,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `sqlite3 failed for ${dbPath}${stderr ? `: ${stderr}` : "."}`,
    );
  }

  return result.stdout;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readCodexGlobalState(
  statePath: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeCodexGlobalState(
  statePath: string,
  state: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });

  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state)}\n`, "utf8");
  await rename(tempPath, statePath);
}

function upsertPathAfter(
  currentPaths: readonly string[],
  pathToAdd: string,
  afterPath?: string,
): string[] {
  const paths = currentPaths.filter((path) => path !== pathToAdd);

  if (!afterPath) {
    return [...paths, pathToAdd];
  }

  const afterIndex = paths.indexOf(afterPath);

  if (afterIndex === -1) {
    return [...paths, pathToAdd];
  }

  return [
    ...paths.slice(0, afterIndex + 1),
    pathToAdd,
    ...paths.slice(afterIndex + 1),
  ];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRootRegistered(
  state: Record<string, unknown>,
  rootPath: string,
  label?: string,
  threadId?: string,
  parentRootPath?: string,
): boolean {
  if (!readStringArray(state[SAVED_WORKSPACE_ROOTS_KEY]).includes(rootPath)) {
    return false;
  }

  if (!readStringArray(state[PROJECT_ORDER_KEY]).includes(rootPath)) {
    return false;
  }

  if (label?.trim()) {
    const savedLabel = state[`${WORKSPACE_ROOT_LABEL_KEY_PREFIX}${rootPath}`];
    if (savedLabel !== label.trim()) {
      return false;
    }
  }

  if (threadId) {
    const hints = state[THREAD_WORKSPACE_ROOT_HINTS_KEY];
    if (!isRecord(hints)) {
      return false;
    }

    if (hints[threadId] !== rootPath) {
      return false;
    }
  }

  return true;
}

function isRootUnregistered(
  state: Record<string, unknown>,
  rootPath: string,
  threadId?: string,
): boolean {
  if (!rootsAreRemoved(state, new Set([rootPath]))) {
    return false;
  }

  const hints = state[THREAD_WORKSPACE_ROOT_HINTS_KEY];
  if (threadId && isRecord(hints) && hints[threadId] !== undefined) {
    return false;
  }

  return !threadId || !hasThreadPersistedAtomState(state, new Set([threadId]));
}

function removeRootsFromState(
  state: Record<string, unknown>,
  rootsToRemove: ReadonlySet<string>,
): void {
  state[SAVED_WORKSPACE_ROOTS_KEY] = readStringArray(
    state[SAVED_WORKSPACE_ROOTS_KEY],
  ).filter((entry) => !rootsToRemove.has(resolve(entry)));
  state[ACTIVE_WORKSPACE_ROOTS_KEY] = readStringArray(
    state[ACTIVE_WORKSPACE_ROOTS_KEY],
  ).filter((entry) => !rootsToRemove.has(resolve(entry)));
  state[PROJECT_ORDER_KEY] = readStringArray(state[PROJECT_ORDER_KEY]).filter(
    (entry) => !rootsToRemove.has(resolve(entry)),
  );

  for (const rootPath of rootsToRemove) {
    deleteWorkspaceRootSidebarState(state, rootPath);
  }

  if (isRecord(state[THREAD_WORKSPACE_ROOT_HINTS_KEY])) {
    const hints = { ...state[THREAD_WORKSPACE_ROOT_HINTS_KEY] };
    const removedThreadIds = new Set<string>();

    for (const [threadId, hintedRoot] of Object.entries(hints)) {
      if (typeof hintedRoot === "string" && rootsToRemove.has(resolve(hintedRoot))) {
        delete hints[threadId];
        removedThreadIds.add(threadId);
      }
    }

    state[THREAD_WORKSPACE_ROOT_HINTS_KEY] = hints;
    deleteThreadPersistedAtomState(state, removedThreadIds);
  }
}

function deleteThreadPersistedAtomState(
  state: Record<string, unknown>,
  threadIds: ReadonlySet<string>,
): void {
  if (threadIds.size === 0) {
    return;
  }

  const atomState = state[PERSISTED_ATOM_STATE_KEY];
  if (!isRecord(atomState)) {
    return;
  }

  deleteThreadIdKeysFromRecord(atomState[PROMPT_HISTORY_KEY], threadIds);
  deleteThreadIdKeysFromRecord(atomState[THREAD_PERMISSIONS_BY_ID_KEY], threadIds);

  for (const key of Object.keys(atomState)) {
    if (
      key.startsWith(THREAD_CLIENT_ID_KEY_PREFIX) &&
      keyReferencesThreadId(key, threadIds)
    ) {
      delete atomState[key];
    }
  }
}

function hasThreadPersistedAtomState(
  state: Record<string, unknown>,
  threadIds: ReadonlySet<string>,
): boolean {
  if (threadIds.size === 0) {
    return false;
  }

  const atomState = state[PERSISTED_ATOM_STATE_KEY];
  if (!isRecord(atomState)) {
    return false;
  }

  if (recordHasThreadIdKey(atomState[PROMPT_HISTORY_KEY], threadIds)) {
    return true;
  }

  if (recordHasThreadIdKey(atomState[THREAD_PERMISSIONS_BY_ID_KEY], threadIds)) {
    return true;
  }

  return Object.keys(atomState).some(
    (key) =>
      key.startsWith(THREAD_CLIENT_ID_KEY_PREFIX) &&
      keyReferencesThreadId(key, threadIds),
  );
}

function deleteThreadIdKeysFromRecord(
  value: unknown,
  threadIds: ReadonlySet<string>,
): void {
  if (!isRecord(value)) {
    return;
  }

  for (const threadId of threadIds) {
    delete value[threadId];
  }
}

function recordHasThreadIdKey(
  value: unknown,
  threadIds: ReadonlySet<string>,
): boolean {
  if (!isRecord(value)) {
    return false;
  }

  for (const threadId of threadIds) {
    if (value[threadId] !== undefined) {
      return true;
    }
  }

  return false;
}

function keyReferencesThreadId(
  key: string,
  threadIds: ReadonlySet<string>,
): boolean {
  const decodedKey = decodeURIComponentSafe(key);

  for (const threadId of threadIds) {
    if (
      key.includes(threadId) ||
      key.includes(encodeURIComponent(threadId)) ||
      decodedKey.includes(threadId)
    ) {
      return true;
    }
  }

  return false;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rootsAreRemoved(
  state: Record<string, unknown>,
  rootsToRemove: ReadonlySet<string>,
): boolean {
  const remainingRoots = [
    ...readStringArray(state[SAVED_WORKSPACE_ROOTS_KEY]),
    ...readStringArray(state[ACTIVE_WORKSPACE_ROOTS_KEY]),
    ...readStringArray(state[PROJECT_ORDER_KEY]),
    ...readWorkspaceLabelRoots(state[WORKSPACE_ROOT_LABELS_KEY]),
    ...readThreadProjectAssignmentRoots(state[THREAD_PROJECT_ASSIGNMENTS_KEY]),
    ...readThreadWritableRoots(state[THREAD_WRITABLE_ROOTS_KEY]),
  ];

  if (remainingRoots.some((entry) => rootsToRemove.has(resolve(entry)))) {
    return false;
  }

  for (const rootPath of rootsToRemove) {
    if (state[`${SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX}${rootPath}`] !== undefined) {
      return false;
    }

    if (state[`${WORKSPACE_ROOT_LABEL_KEY_PREFIX}${rootPath}`] !== undefined) {
      return false;
    }

    const atomState = state[PERSISTED_ATOM_STATE_KEY];
    if (isRecord(atomState)) {
      if (
        atomState[`${SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX}${rootPath}`] !==
        undefined
      ) {
        return false;
      }

      if (
        atomState[`${WORKSPACE_ROOT_LABEL_KEY_PREFIX}${rootPath}`] !== undefined
      ) {
        return false;
      }
    }
  }

  const hints = state[THREAD_WORKSPACE_ROOT_HINTS_KEY];
  if (isRecord(hints)) {
    if (Object.values(hints).some(
      (hintedRoot) => typeof hintedRoot === "string" && rootsToRemove.has(resolve(hintedRoot)),
    )) {
      return false;
    }
  }

  return true;
}

function setWorkspaceRootExpanded(
  state: Record<string, unknown>,
  rootPath: string,
  expanded: boolean,
): void {
  const key = `${SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX}${rootPath}`;
  state[key] = expanded;
  const atomState = getMutablePersistedAtomState(state);
  atomState[key] = expanded;
}

function setWorkspaceRootLabel(
  state: Record<string, unknown>,
  rootPath: string,
  label: string,
): void {
  const key = `${WORKSPACE_ROOT_LABEL_KEY_PREFIX}${rootPath}`;
  state[key] = label;
  const labels = isRecord(state[WORKSPACE_ROOT_LABELS_KEY])
    ? { ...state[WORKSPACE_ROOT_LABELS_KEY] }
    : {};
  labels[rootPath] = label;
  state[WORKSPACE_ROOT_LABELS_KEY] = labels;

  const atomState = getMutablePersistedAtomState(state);
  atomState[key] = label;
}

function deleteWorkspaceRootSidebarState(
  state: Record<string, unknown>,
  rootPath: string,
): void {
  const expandedKey = `${SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX}${rootPath}`;
  const labelKey = `${WORKSPACE_ROOT_LABEL_KEY_PREFIX}${rootPath}`;

  delete state[expandedKey];
  delete state[labelKey];
  deleteWorkspaceLabelRecordEntry(state, rootPath);

  const atomState = state[PERSISTED_ATOM_STATE_KEY];
  if (!isRecord(atomState)) {
    deleteRootWorkspaceState(state, new Set([rootPath]));
    return;
  }

  delete atomState[expandedKey];
  delete atomState[labelKey];
  deleteWorkspaceLabelRecordEntry(atomState, rootPath);
  deleteRootWorkspaceState(state, new Set([rootPath]));
}

function deleteWorkspaceLabelRecordEntry(
  state: Record<string, unknown>,
  rootPath: string,
): void {
  const labels = state[WORKSPACE_ROOT_LABELS_KEY];
  if (!isRecord(labels)) {
    return;
  }

  const nextLabels = { ...labels };
  for (const key of Object.keys(nextLabels)) {
    if (resolve(key) === rootPath) {
      delete nextLabels[key];
    }
  }
  state[WORKSPACE_ROOT_LABELS_KEY] = nextLabels;
}

function deleteRootWorkspaceState(
  state: Record<string, unknown>,
  rootsToRemove: ReadonlySet<string>,
): void {
  const threadIdsToRemove = new Set<string>();
  const assignments = state[THREAD_PROJECT_ASSIGNMENTS_KEY];

  if (isRecord(assignments)) {
    const nextAssignments = { ...assignments };
    for (const [threadId, assignment] of Object.entries(nextAssignments)) {
      if (threadAssignmentReferencesRoot(assignment, rootsToRemove)) {
        delete nextAssignments[threadId];
        threadIdsToRemove.add(threadId);
      }
    }
    state[THREAD_PROJECT_ASSIGNMENTS_KEY] = nextAssignments;
  }

  const writableRoots = state[THREAD_WRITABLE_ROOTS_KEY];
  if (isRecord(writableRoots)) {
    const nextWritableRoots = { ...writableRoots };
    for (const [threadId, roots] of Object.entries(nextWritableRoots)) {
      const filteredRoots = readStringArray(roots).filter(
        (root) => !rootsToRemove.has(resolve(root)),
      );
      if (filteredRoots.length === 0 || threadIdsToRemove.has(threadId)) {
        delete nextWritableRoots[threadId];
        threadIdsToRemove.add(threadId);
      } else if (filteredRoots.length !== readStringArray(roots).length) {
        nextWritableRoots[threadId] = filteredRoots;
      }
    }
    state[THREAD_WRITABLE_ROOTS_KEY] = nextWritableRoots;
  }

  deleteThreadWorkspaceState(state, threadIdsToRemove);
}

function deleteThreadWorkspaceState(
  state: Record<string, unknown>,
  threadIds: ReadonlySet<string>,
): void {
  if (threadIds.size === 0) {
    return;
  }

  for (const key of [THREAD_PROJECT_ASSIGNMENTS_KEY, THREAD_WRITABLE_ROOTS_KEY]) {
    const record = state[key];
    if (!isRecord(record)) {
      continue;
    }

    const nextRecord = { ...record };
    for (const threadId of threadIds) {
      delete nextRecord[threadId];
    }
    state[key] = nextRecord;
  }
}

function threadAssignmentReferencesRoot(
  assignment: unknown,
  rootsToRemove: ReadonlySet<string>,
): boolean {
  if (!isRecord(assignment)) {
    return false;
  }

  for (const key of ["projectId", "path"]) {
    const value = assignment[key];
    if (typeof value === "string" && rootsToRemove.has(resolve(value))) {
      return true;
    }
  }

  return false;
}

function readWorkspaceLabelRoots(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.keys(value);
}

function readThreadProjectAssignmentRoots(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const roots: string[] = [];
  for (const assignment of Object.values(value)) {
    if (!isRecord(assignment)) {
      continue;
    }
    for (const key of ["projectId", "path"]) {
      const root = assignment[key];
      if (typeof root === "string") {
        roots.push(root);
      }
    }
  }
  return roots;
}

function readThreadWritableRoots(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.values(value).flatMap((roots) => readStringArray(roots));
}

async function syncCodexDesktopSidebarGlobalState(
  state: Record<string, unknown>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    return;
  }

  try {
    for (const key of DESKTOP_SYNC_GLOBAL_STATE_KEYS) {
      await requestCodexDesktopIpc("set-global-state", {
        key,
        value: state[key],
        origin: "agse-workspace-root-sync",
      });
    }
    await dispatchCodexDesktopMessage("query-cache-invalidate", {
      queryKey: ["get-global-state"],
    });
  } catch {
    // Codex Desktop may not be running during AGSE startup or tests. The file
    // write remains the fallback; live sidebar refresh is best-effort here.
  }
}

function readSidebarRootsFromPersistedAtomState(
  state: Record<string, unknown>,
): string[] {
  const atomState = state[PERSISTED_ATOM_STATE_KEY];
  if (!isRecord(atomState)) {
    return [];
  }

  return [
    ...Object.keys(atomState)
      .filter((key) => key.startsWith(SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX))
      .map((key) => key.slice(SIDEBAR_PROJECT_EXPANDED_KEY_PREFIX.length)),
    ...Object.keys(atomState)
      .filter((key) => key.startsWith(WORKSPACE_ROOT_LABEL_KEY_PREFIX))
      .map((key) => key.slice(WORKSPACE_ROOT_LABEL_KEY_PREFIX.length)),
  ];
}

function getMutablePersistedAtomState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(state[PERSISTED_ATOM_STATE_KEY])) {
    return state[PERSISTED_ATOM_STATE_KEY];
  }

  const atomState: Record<string, unknown> = {};
  state[PERSISTED_ATOM_STATE_KEY] = atomState;

  return atomState;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveCodexHome(codexHome?: string): string {
  return (
    codexHome?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(homedir(), ".codex")
  );
}
