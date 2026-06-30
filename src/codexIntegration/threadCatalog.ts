import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveCodexHome } from "./workspaceRoots.ts";

export type UpsertCodexLocalThreadCatalogEntryInput = {
  threadId: string;
  title: string;
  cwd: string;
  sourceKind?: string;
  sourceDetail?: string | null;
  modelProvider?: string;
  gitBranch?: string | null;
  sourceCreatedAt?: number;
  sourceUpdatedAt?: number;
  codexHome?: string;
  catalogDbPath?: string;
};

export type RemoveCodexLocalThreadCatalogEntriesInput = {
  threadIds: readonly string[];
  codexHome?: string;
  catalogDbPath?: string;
};

export type ScrubCodexLocalThreadCatalogInput = {
  rootPaths?: readonly string[];
  rootPathPrefix?: string;
  codexHome?: string;
  catalogDbPath?: string;
};

export type ScrubCodexLocalThreadCatalogResult = {
  removedRoots: string[];
  threadIds: string[];
};

const CODEX_LOCAL_THREAD_CATALOG_DB = "sqlite/codex-dev.db";
const LOCAL_HOST_ID = "local";

export async function upsertCodexLocalThreadCatalogEntry({
  threadId,
  title,
  cwd,
  sourceKind = "vscode",
  sourceDetail = null,
  modelProvider = "openai",
  gitBranch = null,
  sourceCreatedAt,
  sourceUpdatedAt,
  codexHome,
  catalogDbPath,
}: UpsertCodexLocalThreadCatalogEntryInput): Promise<void> {
  if (!threadId.trim()) {
    throw new Error("Codex local thread catalog entry requires a thread id.");
  }

  const dbPath = resolveCatalogDbPath(codexHome, catalogDbPath);
  const nowSeconds = Date.now() / 1000;
  const createdAt = sourceCreatedAt ?? nowSeconds;
  const updatedAt = sourceUpdatedAt ?? createdAt;
  const normalizedCwd = resolve(cwd);

  runSqlite(
    dbPath,
    [],
    [
      "PRAGMA busy_timeout=5000;",
      "BEGIN IMMEDIATE;",
      ensureCatalogSchemaSql(),
      bumpObservationSequenceSql(updatedAt),
      [
        "INSERT INTO local_thread_catalog (",
        "  host_id, thread_id, display_title, source_created_at, source_updated_at,",
        "  cwd, source_kind, source_detail, model_provider, git_branch,",
        "  observation_sequence, missing_candidate",
        ") VALUES (",
        `  ${sqlStringLiteral(LOCAL_HOST_ID)},`,
        `  ${sqlStringLiteral(threadId)},`,
        `  ${sqlStringLiteral(title)},`,
        `  ${sqlNumberLiteral(createdAt)},`,
        `  ${sqlNumberLiteral(updatedAt)},`,
        `  ${sqlStringLiteral(normalizedCwd)},`,
        `  ${sqlStringLiteral(sourceKind)},`,
        `  ${sqlNullableStringLiteral(sourceDetail)},`,
        `  ${sqlStringLiteral(modelProvider)},`,
        `  ${sqlNullableStringLiteral(gitBranch)},`,
        `  (SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id = ${sqlStringLiteral(LOCAL_HOST_ID)}),`,
        "  0",
        ") ON CONFLICT(host_id, thread_id) DO UPDATE SET",
        "  display_title = excluded.display_title,",
        "  source_created_at = excluded.source_created_at,",
        "  source_updated_at = excluded.source_updated_at,",
        "  cwd = excluded.cwd,",
        "  source_kind = excluded.source_kind,",
        "  source_detail = excluded.source_detail,",
        "  model_provider = excluded.model_provider,",
        "  git_branch = excluded.git_branch,",
        "  observation_sequence = excluded.observation_sequence,",
        "  missing_candidate = 0;",
      ].join("\n"),
      bumpCatalogRevisionSql(),
      "COMMIT;",
    ].join("\n"),
  );
}

export async function removeCodexLocalThreadCatalogEntries({
  threadIds,
  codexHome,
  catalogDbPath,
}: RemoveCodexLocalThreadCatalogEntriesInput): Promise<string[]> {
  const uniqueThreadIds = [...new Set(threadIds.filter(Boolean))];

  if (uniqueThreadIds.length === 0) {
    return [];
  }

  const dbPath = resolveCatalogDbPath(codexHome, catalogDbPath);

  if (!(await pathExists(dbPath))) {
    return [];
  }

  const predicate = uniqueThreadIds
    .map((threadId) => sqlStringLiteral(threadId))
    .join(", ");
  const rawRows = runSqlite(
    dbPath,
    ["-json"],
    `SELECT thread_id FROM local_thread_catalog WHERE host_id = ${sqlStringLiteral(LOCAL_HOST_ID)} AND thread_id IN (${predicate});`,
  );
  const removedThreadIds = parseThreadIdRows(rawRows);

  if (removedThreadIds.length === 0) {
    return [];
  }

  runSqlite(
    dbPath,
    [],
    [
      "PRAGMA busy_timeout=5000;",
      "BEGIN IMMEDIATE;",
      `DELETE FROM local_thread_catalog WHERE host_id = ${sqlStringLiteral(LOCAL_HOST_ID)} AND thread_id IN (${predicate});`,
      bumpCatalogRevisionSql(),
      "COMMIT;",
    ].join("\n"),
  );

  return removedThreadIds;
}

export async function scrubCodexLocalThreadCatalog({
  rootPaths,
  rootPathPrefix,
  codexHome,
  catalogDbPath,
}: ScrubCodexLocalThreadCatalogInput): Promise<ScrubCodexLocalThreadCatalogResult> {
  const dbPath = resolveCatalogDbPath(codexHome, catalogDbPath);

  if (!(await pathExists(dbPath))) {
    return { removedRoots: [], threadIds: [] };
  }

  const explicitRoots = new Set((rootPaths ?? []).map((entry) => resolve(entry)));
  const normalizedPrefix = rootPathPrefix
    ? `${resolve(rootPathPrefix).replace(/\/+$/, "")}/`
    : undefined;

  if (explicitRoots.size === 0 && !normalizedPrefix) {
    return { removedRoots: [], threadIds: [] };
  }

  const predicateParts = [
    ...[...explicitRoots].map((rootPath) => `cwd = ${sqlStringLiteral(rootPath)}`),
    ...(normalizedPrefix
      ? [`cwd LIKE ${sqlStringLiteral(`${escapeSqlLike(normalizedPrefix)}%`)} ESCAPE '\\'`]
      : []),
  ];
  const rawRows = runSqlite(
    dbPath,
    ["-json"],
    `SELECT thread_id, cwd FROM local_thread_catalog WHERE host_id = ${sqlStringLiteral(LOCAL_HOST_ID)} AND (${predicateParts.join(" OR ")});`,
  );
  const rows = parseCatalogRows(rawRows);
  const rowsToRemove = [];

  for (const row of rows) {
    const normalizedCwd = resolve(row.cwd);
    const isExplicitRoot = explicitRoots.has(normalizedCwd);
    const isManagedPrefixRoot =
      Boolean(normalizedPrefix) &&
      isAgseManagedCatalogWorktreeRoot(normalizedCwd, normalizedPrefix);

    if (!isExplicitRoot && !isManagedPrefixRoot) {
      continue;
    }

    if (isExplicitRoot || !(await pathExists(normalizedCwd))) {
      rowsToRemove.push({ ...row, cwd: normalizedCwd });
    }
  }

  if (rowsToRemove.length === 0) {
    return { removedRoots: [], threadIds: [] };
  }

  const threadIds = rowsToRemove.map((row) => row.thread_id);
  await removeCodexLocalThreadCatalogEntries({
    threadIds,
    catalogDbPath: dbPath,
  });

  return {
    removedRoots: [...new Set(rowsToRemove.map((row) => row.cwd))],
    threadIds: [...new Set(threadIds)],
  };
}

function resolveCatalogDbPath(
  codexHome: string | undefined,
  catalogDbPath: string | undefined,
): string {
  return catalogDbPath ?? join(resolveCodexHome(codexHome), CODEX_LOCAL_THREAD_CATALOG_DB);
}

function ensureCatalogSchemaSql(): string {
  return [
    "CREATE TABLE IF NOT EXISTS local_thread_catalog (",
    "  host_id TEXT NOT NULL,",
    "  thread_id TEXT NOT NULL,",
    "  display_title TEXT NOT NULL,",
    "  source_created_at REAL NOT NULL,",
    "  source_updated_at REAL NOT NULL,",
    "  cwd TEXT NOT NULL,",
    "  source_kind TEXT NOT NULL,",
    "  source_detail TEXT,",
    "  model_provider TEXT NOT NULL,",
    "  git_branch TEXT,",
    "  observation_sequence INTEGER NOT NULL,",
    "  missing_candidate INTEGER NOT NULL DEFAULT 0 CHECK (missing_candidate IN (0, 1)),",
    "  PRIMARY KEY (host_id, thread_id)",
    ");",
    "CREATE INDEX IF NOT EXISTS local_thread_catalog_updated_idx",
    "  ON local_thread_catalog (host_id, source_updated_at DESC, source_created_at DESC, thread_id)",
    "  WHERE missing_candidate = 0;",
    "CREATE TABLE IF NOT EXISTS local_thread_catalog_sync_state (",
    "  host_id TEXT PRIMARY KEY,",
    "  watermark_updated_at REAL,",
    "  initial_build_complete INTEGER NOT NULL DEFAULT 0,",
    "  observation_sequence INTEGER NOT NULL DEFAULT 0",
    ");",
    "CREATE TABLE IF NOT EXISTS local_thread_catalog_metadata (",
    "  id INTEGER PRIMARY KEY CHECK (id = 1),",
    "  catalog_revision INTEGER NOT NULL DEFAULT 0",
    ");",
    "CREATE TABLE IF NOT EXISTS local_thread_catalog_hosts (",
    "  host_id TEXT PRIMARY KEY,",
    "  host_kind TEXT NOT NULL CHECK (host_kind IN ('local', 'ssh', 'wsl', 'remote-control'))",
    ");",
    `INSERT OR IGNORE INTO local_thread_catalog_hosts (host_id, host_kind) VALUES (${sqlStringLiteral(LOCAL_HOST_ID)}, 'local');`,
    "INSERT OR IGNORE INTO local_thread_catalog_metadata (id, catalog_revision) VALUES (1, 0);",
    `INSERT OR IGNORE INTO local_thread_catalog_sync_state (host_id, watermark_updated_at, initial_build_complete, observation_sequence) VALUES (${sqlStringLiteral(LOCAL_HOST_ID)}, 0, 1, 0);`,
  ].join("\n");
}

function bumpObservationSequenceSql(updatedAt: number): string {
  return [
    "UPDATE local_thread_catalog_sync_state",
    "SET",
    `  watermark_updated_at = MAX(COALESCE(watermark_updated_at, 0), ${sqlNumberLiteral(updatedAt)}),`,
    "  initial_build_complete = 1,",
    "  observation_sequence = observation_sequence + 1",
    `WHERE host_id = ${sqlStringLiteral(LOCAL_HOST_ID)};`,
  ].join("\n");
}

function bumpCatalogRevisionSql(): string {
  return "UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1;";
}

function parseThreadIdRows(rawRows: string): string[] {
  return parseJsonRows(rawRows)
    .map((row) => (typeof row.thread_id === "string" ? row.thread_id : ""))
    .filter(Boolean);
}

function parseCatalogRows(rawRows: string): Array<{ thread_id: string; cwd: string }> {
  return parseJsonRows(rawRows)
    .map((row) => ({
      thread_id: typeof row.thread_id === "string" ? row.thread_id : "",
      cwd: typeof row.cwd === "string" ? row.cwd : "",
    }))
    .filter((row) => row.thread_id && row.cwd);
}

function parseJsonRows(rawRows: string): Array<Record<string, unknown>> {
  if (!rawRows.trim()) {
    return [];
  }

  const parsed: unknown = JSON.parse(rawRows);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(isRecord);
}

function isAgseManagedCatalogWorktreeRoot(
  rootPath: string,
  normalizedPrefix: string | undefined,
): boolean {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runSqlite(
  dbPath: string,
  args: readonly string[],
  input: string,
): string {
  const result = spawnSync("sqlite3", [...args, dbPath], {
    encoding: "utf8",
    input,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 exited with code ${result.status ?? "unknown"}`);
  }

  return result.stdout;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullableStringLiteral(value: string | null): string {
  return value === null ? "NULL" : sqlStringLiteral(value);
}

function sqlNumberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid SQL number literal: ${value}`);
  }

  return String(value);
}

function escapeSqlLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
