import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findRootFoldersWithFileProgress,
  ROOT_MARKER_FILE_NAME,
  type FindRootFoldersProgress,
} from "../src/utils/findRootFoldersWithFile.ts";

async function withTempScanRoot(
  fn: (rootPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agse-scan-test-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("progress scanner checks root and one top-level directory deep", async () => {
  await withTempScanRoot(async (rootPath) => {
    const projectPath = join(rootPath, "project-a");
    const nestedProjectPath = join(rootPath, "project-b", "nested-project");
    await mkdir(projectPath, { recursive: true });
    await mkdir(nestedProjectPath, { recursive: true });
    await writeFile(join(projectPath, ROOT_MARKER_FILE_NAME), "export default {};\n");
    await writeFile(join(nestedProjectPath, ROOT_MARKER_FILE_NAME), "export default {};\n");

    const progress: FindRootFoldersProgress[] = [];
    const matches = await findRootFoldersWithFileProgress(rootPath, {
      onProgress(update) {
        progress.push(update);
      },
    });

    assert.deepEqual(matches, [projectPath]);
    assert.equal(progress.at(-1)?.matchedCount, 1);
    assert.ok(progress.length >= 2);
  });
});

test("progress scanner ignores noisy top-level folders", async () => {
  await withTempScanRoot(async (rootPath) => {
    const ignoredProjectPath = join(rootPath, "node_modules", "fake-project");
    await mkdir(ignoredProjectPath, { recursive: true });
    await writeFile(
      join(ignoredProjectPath, ROOT_MARKER_FILE_NAME),
      "export default {};\n",
    );

    const matches = await findRootFoldersWithFileProgress(rootPath);

    assert.deepEqual(matches, []);
  });
});
