import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGSCStateStore, type AGSCTrackedWorkflow } from "../src/agscState.ts";

function workflow(issueId: number, issueNumber: number): AGSCTrackedWorkflow {
  return {
    issueId,
    issueNumber,
    issueTitle: `Issue ${issueNumber}`,
    issueUrl: `https://github.com/example/repo/issues/${issueNumber}`,
    agent: "codex",
    worktreePath: `/repo/.agse/worktrees/issue-${issueNumber}`,
    branchName: `agse/issue-${issueNumber}`,
    pullNumber: issueNumber + 10,
    pullUrl: `https://github.com/example/repo/pull/${issueNumber + 10}`,
    pullState: "open",
  };
}

async function withTempProject(
  fn: (projectRootPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agse-state-test-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("AGSCStateStore starts empty when no state file exists", async () => {
  await withTempProject(async (projectRootPath) => {
    const state = await new AGSCStateStore(projectRootPath).read();

    assert.deepEqual(state, { workflows: [] });
  });
});

test("AGSCStateStore normalizes malformed workflow lists to empty", async () => {
  await withTempProject(async (projectRootPath) => {
    const store = new AGSCStateStore(projectRootPath);

    await mkdir(join(projectRootPath, ".agse"), { recursive: true });
    await writeFile(store.statePath, '{"workflows":{"issueId":1}}\n', "utf8");

    assert.deepEqual(await store.read(), { workflows: [] });
  });
});

test("AGSCStateStore upserts workflows by issue id", async () => {
  await withTempProject(async (projectRootPath) => {
    const store = new AGSCStateStore(projectRootPath);

    await store.upsertWorkflow(workflow(1, 1));
    await store.upsertWorkflow(workflow(2, 2));
    await store.upsertWorkflow({
      ...workflow(1, 1),
      codexThreadId: "thread-1",
    });

    const state = await store.read();
    assert.equal(state.workflows.length, 2);
    assert.equal(
      state.workflows.find((entry) => entry.issueId === 1)?.codexThreadId,
      "thread-1",
    );
  });
});

test("AGSCStateStore removes closed workflow records by issue id", async () => {
  await withTempProject(async (projectRootPath) => {
    const store = new AGSCStateStore(projectRootPath);

    await store.upsertWorkflow(workflow(1, 1));
    await store.upsertWorkflow(workflow(2, 2));
    await store.removeWorkflow(1);

    assert.deepEqual(
      (await store.read()).workflows.map((entry) => entry.issueId),
      [2],
    );
  });
});
