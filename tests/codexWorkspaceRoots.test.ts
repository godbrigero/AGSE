import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  registerCodexWorkspaceRoot,
  scrubCodexThreadWorkspaceReferences,
  scrubCodexWorkspaceRoots,
  unregisterCodexWorkspaceRoot,
} from "../src/codexIntegration/workspaceRoots.ts";

async function withTempState(
  fn: (statePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agse-codex-state-"));

  try {
    await fn(join(dir, ".codex-global-state.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("registerCodexWorkspaceRoot adds a worktree beside its parent project", async () => {
  await withTempState(async (statePath) => {
    const parentRoot = resolve("/repo/AGSE");
    const worktreeRoot = resolve(
      "/home/user/.codex/worktrees/c816/issue-13",
    );
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": ["/other", parentRoot, "/later"],
        "project-order": ["/other", parentRoot, "/later"],
      }),
      "utf8",
    );

    await registerCodexWorkspaceRoot({
      rootPath: worktreeRoot,
      parentRootPath: parentRoot,
      label: "Issue #13: Add more testing",
      threadId: "thread-13",
      globalStatePath: statePath,
    });

    const state = JSON.parse(await readFile(statePath, "utf8"));

    assert.deepEqual(state["electron-saved-workspace-roots"], [
      "/other",
      parentRoot,
      worktreeRoot,
      "/later",
    ]);
    assert.deepEqual(state["project-order"], [
      "/other",
      parentRoot,
      worktreeRoot,
      "/later",
    ]);
    assert.equal(
      state[`sidebar-project-expanded-v1-codex:${worktreeRoot}`],
      true,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `sidebar-project-expanded-v1-codex:${worktreeRoot}`
      ],
      true,
    );
    assert.equal(
      state[`electron-workspace-root-labels/${worktreeRoot}`],
      "Issue #13: Add more testing",
    );
    assert.equal(
      state["electron-workspace-root-labels"][worktreeRoot],
      "Issue #13: Add more testing",
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `electron-workspace-root-labels/${worktreeRoot}`
      ],
      "Issue #13: Add more testing",
    );
    assert.deepEqual(state["thread-workspace-root-hints"], {
      "thread-13": worktreeRoot,
    });
  });
});

test("registerCodexWorkspaceRoot is idempotent for an existing root", async () => {
  await withTempState(async (statePath) => {
    const parentRoot = resolve("/repo/AGSE");
    const worktreeRoot = resolve(
      "/home/user/.codex/worktrees/c816/issue-13",
    );
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": [parentRoot, worktreeRoot],
        "project-order": [parentRoot, worktreeRoot],
      }),
      "utf8",
    );

    await registerCodexWorkspaceRoot({
      rootPath: worktreeRoot,
      parentRootPath: parentRoot,
      threadId: "thread-13",
      globalStatePath: statePath,
    });

    const state = JSON.parse(await readFile(statePath, "utf8"));

    assert.deepEqual(state["electron-saved-workspace-roots"], [
      parentRoot,
      worktreeRoot,
    ]);
    assert.deepEqual(state["project-order"], [parentRoot, worktreeRoot]);
  });
});

test("unregisterCodexWorkspaceRoot removes root ordering, label, and thread hint", async () => {
  await withTempState(async (statePath) => {
    const parentRoot = resolve("/repo/AGSE");
    const worktreeRoot = resolve(
      "/home/user/.codex/worktrees/c816/issue-13",
    );
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": [parentRoot, worktreeRoot],
        "active-workspace-roots": [worktreeRoot],
        "project-order": [parentRoot, worktreeRoot],
        [`sidebar-project-expanded-v1-codex:${worktreeRoot}`]: true,
        [`electron-workspace-root-labels/${worktreeRoot}`]:
          "Issue #13: Add more testing",
        "electron-workspace-root-labels": {
          [worktreeRoot]: "Issue #13: Add more testing",
        },
        "thread-project-assignments": {
          "thread-13": {
            projectKind: "local",
            projectId: worktreeRoot,
            path: worktreeRoot,
            pendingCoreUpdate: false,
          },
          "thread-other": {
            projectKind: "local",
            projectId: parentRoot,
            path: parentRoot,
            pendingCoreUpdate: false,
          },
        },
        "thread-writable-roots": {
          "thread-13": [worktreeRoot],
          "thread-other": [parentRoot],
        },
        "electron-persisted-atom-state": {
          [`sidebar-project-expanded-v1-codex:${worktreeRoot}`]: true,
          [`electron-workspace-root-labels/${worktreeRoot}`]:
            "Issue #13: Add more testing",
          "prompt-history": {
            "thread-13": ["finish the issue"],
            "thread-other": ["leave this alone"],
          },
          "heartbeat-thread-permissions-by-id": {
            "thread-13": { approvalPolicy: "never" },
            "thread-other": { approvalPolicy: "on-request" },
          },
          "thread-client-id-v1:local%3Athread-13": "client-thread-13",
          "thread-client-id-v1:local%3Athread-other": "client-thread-other",
        },
        "thread-workspace-root-hints": {
          "thread-13": parentRoot,
          "thread-other": parentRoot,
        },
      }),
      "utf8",
    );

    await unregisterCodexWorkspaceRoot({
      rootPath: worktreeRoot,
      threadId: "thread-13",
      globalStatePath: statePath,
    });

    const state = JSON.parse(await readFile(statePath, "utf8"));

    assert.deepEqual(state["electron-saved-workspace-roots"], [parentRoot]);
    assert.deepEqual(state["active-workspace-roots"], []);
    assert.deepEqual(state["project-order"], [parentRoot]);
    assert.equal(
      state[`sidebar-project-expanded-v1-codex:${worktreeRoot}`],
      undefined,
    );
    assert.equal(
      state[`electron-workspace-root-labels/${worktreeRoot}`],
      undefined,
    );
    assert.deepEqual(state["electron-workspace-root-labels"], {});
    assert.deepEqual(state["thread-project-assignments"], {
      "thread-other": {
        projectKind: "local",
        projectId: parentRoot,
        path: parentRoot,
        pendingCoreUpdate: false,
      },
    });
    assert.deepEqual(state["thread-writable-roots"], {
      "thread-other": [parentRoot],
    });
    assert.equal(
      state["electron-persisted-atom-state"][
        `sidebar-project-expanded-v1-codex:${worktreeRoot}`
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `electron-workspace-root-labels/${worktreeRoot}`
      ],
      undefined,
    );
    assert.deepEqual(
      state["electron-persisted-atom-state"]["prompt-history"],
      {
        "thread-other": ["leave this alone"],
      },
    );
    assert.deepEqual(
      state["electron-persisted-atom-state"][
        "heartbeat-thread-permissions-by-id"
      ],
      {
        "thread-other": { approvalPolicy: "on-request" },
      },
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        "thread-client-id-v1:local%3Athread-13"
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        "thread-client-id-v1:local%3Athread-other"
      ],
      "client-thread-other",
    );
    assert.deepEqual(state["thread-workspace-root-hints"], {
      "thread-other": parentRoot,
    });
  });
});

test("unregisterCodexWorkspaceRoot removes root-only sidebar state", async () => {
  await withTempState(async (statePath) => {
    const parentRoot = resolve("/repo/AGSE");
    const worktreeRoot = resolve(
      "/home/user/.codex/worktrees/c816/issue-13",
    );
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": [parentRoot, worktreeRoot],
        "project-order": [parentRoot, worktreeRoot],
        [`sidebar-project-expanded-v1-codex:${worktreeRoot}`]: true,
        [`electron-workspace-root-labels/${worktreeRoot}`]:
          "Issue #13: Add more testing",
        "electron-workspace-root-labels": {
          [worktreeRoot]: "Issue #13: Add more testing",
        },
        "thread-project-assignments": {
          "thread-13": {
            projectKind: "local",
            projectId: worktreeRoot,
            path: worktreeRoot,
            pendingCoreUpdate: false,
          },
        },
        "thread-writable-roots": {
          "thread-13": [worktreeRoot],
        },
        "electron-persisted-atom-state": {
          [`sidebar-project-expanded-v1-codex:${worktreeRoot}`]: true,
          [`electron-workspace-root-labels/${worktreeRoot}`]:
            "Issue #13: Add more testing",
        },
      }),
      "utf8",
    );

    await unregisterCodexWorkspaceRoot({
      rootPath: worktreeRoot,
      globalStatePath: statePath,
    });

    const state = JSON.parse(await readFile(statePath, "utf8"));

    assert.deepEqual(state["electron-saved-workspace-roots"], [parentRoot]);
    assert.deepEqual(state["project-order"], [parentRoot]);
    assert.equal(
      state[`sidebar-project-expanded-v1-codex:${worktreeRoot}`],
      undefined,
    );
    assert.equal(
      state[`electron-workspace-root-labels/${worktreeRoot}`],
      undefined,
    );
    assert.deepEqual(state["electron-workspace-root-labels"], {});
    assert.deepEqual(state["thread-project-assignments"], {});
    assert.deepEqual(state["thread-writable-roots"], {});
    assert.equal(
      state["electron-persisted-atom-state"][
        `sidebar-project-expanded-v1-codex:${worktreeRoot}`
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `electron-workspace-root-labels/${worktreeRoot}`
      ],
      undefined,
    );
  });
});

test("scrubCodexWorkspaceRoots removes missing AGSE-managed roots from all sidebar state", async () => {
  await withTempState(async (statePath) => {
    const parentRoot = resolve("/repo/AGSE");
    const existingWorktreeRoot = await mkdtemp(join(tmpdir(), "agse-live-worktree-"));
    const missingWorktreeRoot = resolve(
      "/home/user/.codex/worktrees/dead/issue-99",
    );
    const atomOnlyMissingWorktreeRoot = resolve(
      "/home/user/.codex/worktrees/dead/issue-100",
    );
    const worktreesRoot = resolve("/home/user/.codex/worktrees");
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": [
          parentRoot,
          missingWorktreeRoot,
          existingWorktreeRoot,
        ],
        "active-workspace-roots": [missingWorktreeRoot],
        "project-order": [parentRoot, missingWorktreeRoot],
        [`sidebar-project-expanded-v1-codex:${missingWorktreeRoot}`]: true,
        [`electron-workspace-root-labels/${missingWorktreeRoot}`]:
          "Issue #99: stale",
        "electron-persisted-atom-state": {
          [`sidebar-project-expanded-v1-codex:${missingWorktreeRoot}`]: true,
          [`sidebar-project-expanded-v1-codex:${atomOnlyMissingWorktreeRoot}`]:
            true,
          [`sidebar-project-expanded-v1-codex:${existingWorktreeRoot}`]: true,
          [`electron-workspace-root-labels/${missingWorktreeRoot}`]:
            "Issue #99: stale",
          [`electron-workspace-root-labels/${atomOnlyMissingWorktreeRoot}`]:
            "Issue #100: atom-only stale",
          "prompt-history": {
            "thread-stale": ["stale prompt"],
            "thread-live": ["live prompt"],
          },
          "heartbeat-thread-permissions-by-id": {
            "thread-stale": { approvalPolicy: "never" },
            "thread-live": { approvalPolicy: "on-request" },
          },
          "thread-client-id-v1:local%3Athread-stale": "client-thread-stale",
          "thread-client-id-v1:local%3Athread-live": "client-thread-live",
        },
        "thread-workspace-root-hints": {
          "thread-stale": missingWorktreeRoot,
          "thread-live": existingWorktreeRoot,
        },
      }),
      "utf8",
    );

    const removed = await scrubCodexWorkspaceRoots({
      rootPathPrefix: worktreesRoot,
      globalStatePath: statePath,
    });

    const state = JSON.parse(await readFile(statePath, "utf8"));

    assert.deepEqual(removed, [
      missingWorktreeRoot,
      atomOnlyMissingWorktreeRoot,
    ]);
    assert.deepEqual(state["electron-saved-workspace-roots"], [
      parentRoot,
      existingWorktreeRoot,
    ]);
    assert.deepEqual(state["active-workspace-roots"], []);
    assert.deepEqual(state["project-order"], [parentRoot]);
    assert.equal(
      state[`sidebar-project-expanded-v1-codex:${missingWorktreeRoot}`],
      undefined,
    );
    assert.equal(
      state[`electron-workspace-root-labels/${missingWorktreeRoot}`],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `sidebar-project-expanded-v1-codex:${missingWorktreeRoot}`
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `electron-workspace-root-labels/${missingWorktreeRoot}`
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `sidebar-project-expanded-v1-codex:${atomOnlyMissingWorktreeRoot}`
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `electron-workspace-root-labels/${atomOnlyMissingWorktreeRoot}`
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        `sidebar-project-expanded-v1-codex:${existingWorktreeRoot}`
      ],
      true,
    );
    assert.deepEqual(
      state["electron-persisted-atom-state"]["prompt-history"],
      {
        "thread-live": ["live prompt"],
      },
    );
    assert.deepEqual(
      state["electron-persisted-atom-state"][
        "heartbeat-thread-permissions-by-id"
      ],
      {
        "thread-live": { approvalPolicy: "on-request" },
      },
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        "thread-client-id-v1:local%3Athread-stale"
      ],
      undefined,
    );
    assert.equal(
      state["electron-persisted-atom-state"][
        "thread-client-id-v1:local%3Athread-live"
      ],
      "client-thread-live",
    );
    assert.deepEqual(state["thread-workspace-root-hints"], {
      "thread-live": existingWorktreeRoot,
    });

    await rm(existingWorktreeRoot, { recursive: true, force: true });
  });
});

test("scrubCodexThreadWorkspaceReferences rewrites stale AGSE worktree thread metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agse-codex-thread-db-"));

  try {
    const dbPath = join(dir, "state_5.sqlite");
    const parentRoot = resolve(join(dir, "AGSE"));
    const worktreesRoot = resolve(join(dir, "worktrees"));
    const liveWorktreeRoot = resolve(
      join(worktreesRoot, "live", "issue-101-live"),
    );
    const missingWorktreeRoot = resolve(
      join(worktreesRoot, "dead", "issue-99-stale"),
    );
    const textOnlyMissingWorktreeRoot = resolve(
      join(worktreesRoot, "dead", "issue-100-stale"),
    );
    const unrelatedMissingWorktreeRoot = resolve(
      join(worktreesRoot, "dead", "SkibidiCAD"),
    );

    await mkdir(parentRoot, { recursive: true });
    await mkdir(liveWorktreeRoot, { recursive: true });
    runSqliteTest(
      dbPath,
      [
        "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, first_user_message TEXT NOT NULL, preview TEXT NOT NULL);",
        `INSERT INTO threads VALUES ('stale-cwd', 1, ${sqlStringLiteralTest(missingWorktreeRoot)}, ${sqlStringLiteralTest(`Issue #99\nWorktree: ${missingWorktreeRoot}`)}, ${sqlStringLiteralTest(`Use ${missingWorktreeRoot}`)}, ${sqlStringLiteralTest(`Preview ${missingWorktreeRoot}`)});`,
        `INSERT INTO threads VALUES ('stale-text', 0, ${sqlStringLiteralTest(parentRoot)}, ${sqlStringLiteralTest("Issue #100")}, ${sqlStringLiteralTest(`Worktree: ${textOnlyMissingWorktreeRoot}`)}, ${sqlStringLiteralTest(`Preview ${textOnlyMissingWorktreeRoot}`)});`,
        `INSERT INTO threads VALUES ('live', 0, ${sqlStringLiteralTest(liveWorktreeRoot)}, ${sqlStringLiteralTest(`Issue #101\nWorktree: ${liveWorktreeRoot}`)}, ${sqlStringLiteralTest(`Use ${liveWorktreeRoot}`)}, ${sqlStringLiteralTest(`Preview ${liveWorktreeRoot}`)});`,
        `INSERT INTO threads VALUES ('unrelated', 0, ${sqlStringLiteralTest(unrelatedMissingWorktreeRoot)}, ${sqlStringLiteralTest(`Automation ${unrelatedMissingWorktreeRoot}`)}, ${sqlStringLiteralTest(`Use ${unrelatedMissingWorktreeRoot}`)}, ${sqlStringLiteralTest(`Preview ${unrelatedMissingWorktreeRoot}`)});`,
      ].join("\n"),
    );

    const result = await scrubCodexThreadWorkspaceReferences({
      rootPathPrefix: worktreesRoot,
      replacementRootPath: parentRoot,
      stateDbPath: dbPath,
    });

    assert.deepEqual(new Set(result.removedRoots), new Set([
      missingWorktreeRoot,
      textOnlyMissingWorktreeRoot,
    ]));
    assert.deepEqual(new Set(result.threadIds), new Set([
      "stale-cwd",
      "stale-text",
    ]));
    assert.deepEqual(result.archivedThreadIds, ["stale-cwd"]);

    const rows = readSqliteRowsTest(dbPath);
    const staleCwd = rows.find((row) => row.id === "stale-cwd");
    const staleText = rows.find((row) => row.id === "stale-text");
    const live = rows.find((row) => row.id === "live");
    const unrelated = rows.find((row) => row.id === "unrelated");

    assert.equal(staleCwd?.cwd, parentRoot);
    assert.equal(staleCwd?.title.includes(missingWorktreeRoot), false);
    assert.equal(staleCwd?.first_user_message.includes(missingWorktreeRoot), false);
    assert.equal(staleCwd?.preview.includes(missingWorktreeRoot), false);
    assert.equal(staleText?.cwd, parentRoot);
    assert.equal(staleText?.first_user_message.includes(textOnlyMissingWorktreeRoot), false);
    assert.equal(staleText?.preview.includes(textOnlyMissingWorktreeRoot), false);
    assert.equal(live?.cwd, liveWorktreeRoot);
    assert.equal(live?.title.includes(liveWorktreeRoot), true);
    assert.equal(unrelated?.cwd, unrelatedMissingWorktreeRoot);
    assert.equal(unrelated?.title.includes(unrelatedMissingWorktreeRoot), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type ThreadRowTest = {
  id: string;
  cwd: string;
  title: string;
  first_user_message: string;
  preview: string;
};

function runSqliteTest(dbPath: string, sql: string): void {
  const result = spawnSync("sqlite3", [dbPath], {
    encoding: "utf8",
    input: sql,
  });

  if (result.error) {
    throw result.error;
  }

  assert.equal(result.status, 0, result.stderr);
}

function readSqliteRowsTest(dbPath: string): ThreadRowTest[] {
  const result = spawnSync(
    "sqlite3",
    ["-json", dbPath],
    {
      encoding: "utf8",
      input:
        "SELECT id, cwd, title, first_user_message, preview FROM threads ORDER BY id;",
    },
  );

  if (result.error) {
    throw result.error;
  }

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as ThreadRowTest[];
}

function sqlStringLiteralTest(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
