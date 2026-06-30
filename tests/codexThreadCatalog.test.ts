import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  removeCodexLocalThreadCatalogEntries,
  scrubCodexLocalThreadCatalog,
  upsertCodexLocalThreadCatalogEntry,
} from "../src/codexIntegration/threadCatalog.ts";

const execFileAsync = promisify(execFile);

test("upsertCodexLocalThreadCatalogEntry writes a local sidebar catalog row", async () => {
  const fixture = await createCatalogFixture();

  try {
    const cwd = resolve("/tmp/agse/catalog/issue-1");
    await upsertCodexLocalThreadCatalogEntry({
      catalogDbPath: fixture.dbPath,
      threadId: "thread-1",
      title: "Issue #1: Catalog",
      cwd,
      sourceDetail: "agse-pr-worktree",
      gitBranch: "agse/issue-1",
      sourceCreatedAt: 10,
      sourceUpdatedAt: 20,
    });

    const rows = await queryRows(fixture.dbPath, [
      "SELECT thread_id, display_title, cwd, source_kind, source_detail, model_provider, git_branch, missing_candidate",
      "FROM local_thread_catalog;",
    ].join(" "));

    assert.deepEqual(rows, [
      {
        thread_id: "thread-1",
        display_title: "Issue #1: Catalog",
        cwd,
        source_kind: "vscode",
        source_detail: "agse-pr-worktree",
        model_provider: "openai",
        git_branch: "agse/issue-1",
        missing_candidate: 0,
      },
    ]);

    const metadata = await queryRows(
      fixture.dbPath,
      "SELECT catalog_revision FROM local_thread_catalog_metadata;",
    );
    assert.deepEqual(metadata, [{ catalog_revision: 1 }]);
  } finally {
    await fixture.cleanup();
  }
});

test("removeCodexLocalThreadCatalogEntries deletes rows and bumps revision", async () => {
  const fixture = await createCatalogFixture();

  try {
    await upsertCodexLocalThreadCatalogEntry({
      catalogDbPath: fixture.dbPath,
      threadId: "thread-1",
      title: "Issue #1: Catalog",
      cwd: "/tmp/issue-1",
    });

    const removed = await removeCodexLocalThreadCatalogEntries({
      catalogDbPath: fixture.dbPath,
      threadIds: ["thread-1", "thread-missing"],
    });

    assert.deepEqual(removed, ["thread-1"]);
    assert.deepEqual(
      await queryRows(fixture.dbPath, "SELECT * FROM local_thread_catalog;"),
      [],
    );
    assert.deepEqual(
      await queryRows(
        fixture.dbPath,
        "SELECT catalog_revision FROM local_thread_catalog_metadata;",
      ),
      [{ catalog_revision: 2 }],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("scrubCodexLocalThreadCatalog removes missing AGSE issue worktrees only", async () => {
  const fixture = await createCatalogFixture();

  try {
    const worktreesRoot = join(fixture.dir, "worktrees");
    const liveIssueRoot = join(worktreesRoot, "abcd", "issue-1-live");
    const staleIssueRoot = join(worktreesRoot, "dead", "issue-2-stale");
    const staleNonIssueRoot = join(worktreesRoot, "dead", "manual-project");
    await mkdir(liveIssueRoot, { recursive: true });

    await upsertCodexLocalThreadCatalogEntry({
      catalogDbPath: fixture.dbPath,
      threadId: "thread-live",
      title: "Issue #1: live",
      cwd: liveIssueRoot,
    });
    await upsertCodexLocalThreadCatalogEntry({
      catalogDbPath: fixture.dbPath,
      threadId: "thread-stale",
      title: "Issue #2: stale",
      cwd: staleIssueRoot,
    });
    await upsertCodexLocalThreadCatalogEntry({
      catalogDbPath: fixture.dbPath,
      threadId: "thread-manual",
      title: "Manual project",
      cwd: staleNonIssueRoot,
    });

    const result = await scrubCodexLocalThreadCatalog({
      catalogDbPath: fixture.dbPath,
      rootPathPrefix: worktreesRoot,
    });

    assert.deepEqual(result, {
      removedRoots: [staleIssueRoot],
      threadIds: ["thread-stale"],
    });

    const remaining = await queryRows(
      fixture.dbPath,
      "SELECT thread_id FROM local_thread_catalog ORDER BY thread_id;",
    );
    assert.deepEqual(remaining, [
      { thread_id: "thread-live" },
      { thread_id: "thread-manual" },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

async function createCatalogFixture(): Promise<{
  dir: string;
  dbPath: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "agse-catalog-"));
  const dbPath = join(dir, "codex-dev.db");

  return {
    dir,
    dbPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function queryRows(
  dbPath: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql]);

  return stdout.trim() ? JSON.parse(stdout) : [];
}
