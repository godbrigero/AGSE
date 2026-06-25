import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGSCStateStore,
  type AGSCTrackedWorkflow,
} from "../src/agscState.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe("AGSCStateStore", () => {
  it("returns an empty workflow list when no state file exists", async () => {
    const projectRoot = await createTempDir();
    const store = new AGSCStateStore(projectRoot);

    await assert.doesNotReject(() => store.read());
    assert.deepEqual(await store.read(), { workflows: [] });
  });

  it("normalizes state with a non-array workflow list", async () => {
    const projectRoot = await createTempDir();
    const store = new AGSCStateStore(projectRoot);
    await mkdir(join(projectRoot, ".agse"), { recursive: true });
    await writeFile(store.statePath, JSON.stringify({ workflows: null }));

    assert.deepEqual(await store.read(), { workflows: [] });
  });

  it("throws when the state file contains invalid JSON", async () => {
    const projectRoot = await createTempDir();
    const store = new AGSCStateStore(projectRoot);
    await mkdir(join(projectRoot, ".agse"), { recursive: true });
    await writeFile(store.statePath, "{not-json");

    await assert.rejects(() => store.read(), SyntaxError);
  });

  it("persists updated state as formatted JSON", async () => {
    const projectRoot = await createTempDir();
    const store = new AGSCStateStore(projectRoot);
    const workflow = createWorkflow({ issueId: 1, branchName: "agse/one" });

    const nextState = await store.update(() => ({ workflows: [workflow] }));

    assert.deepEqual(nextState, { workflows: [workflow] });
    assert.equal(
      await readFile(join(projectRoot, ".agse", "state.json"), "utf8"),
      `${JSON.stringify({ workflows: [workflow] }, null, 2)}\n`,
    );
  });

  it("upserts workflows by issue id", async () => {
    const projectRoot = await createTempDir();
    const store = new AGSCStateStore(projectRoot);

    await store.upsertWorkflow(createWorkflow({ issueId: 1 }));
    await store.upsertWorkflow(createWorkflow({ issueId: 2 }));
    await store.upsertWorkflow(
      createWorkflow({ issueId: 1, issueTitle: "Updated", branchName: "b" }),
    );

    assert.deepEqual(
      (await store.read()).workflows.map((workflow) => ({
        issueId: workflow.issueId,
        issueTitle: workflow.issueTitle,
        branchName: workflow.branchName,
      })),
      [
        { issueId: 2, issueTitle: "Issue 2", branchName: "branch-2" },
        { issueId: 1, issueTitle: "Updated", branchName: "b" },
      ],
    );
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "agse-state-test-"));
  tempDirs.push(tempDir);

  return tempDir;
}

function createWorkflow(
  overrides: Partial<AGSCTrackedWorkflow> = {},
): AGSCTrackedWorkflow {
  const issueId = overrides.issueId ?? 1;

  return {
    issueId,
    issueNumber: issueId,
    issueTitle: `Issue ${issueId}`,
    issueUrl: `https://github.com/example/repo/issues/${issueId}`,
    agent: "codex",
    worktreePath: `/tmp/worktree-${issueId}`,
    branchName: `branch-${issueId}`,
    ...overrides,
  };
}
