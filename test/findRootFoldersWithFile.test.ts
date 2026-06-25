import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findRootFoldersWithFile,
  ROOT_MARKER_FILE_NAME,
} from "../src/utils/findRootFoldersWithFile.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe("findRootFoldersWithFile", () => {
  it("finds marker folders recursively and returns sorted absolute paths", async () => {
    const searchRoot = await createTempDir();
    const projectA = join(searchRoot, "zeta");
    const projectB = join(searchRoot, "alpha", "nested");
    await writeMarker(projectA);
    await writeMarker(projectB);

    assert.deepEqual(await findRootFoldersWithFile(searchRoot), [
      resolve(projectB),
      resolve(projectA),
    ]);
  });

  it("does not recurse into a folder once it is identified as a project root", async () => {
    const searchRoot = await createTempDir();
    const parentProject = join(searchRoot, "parent");
    const nestedProject = join(parentProject, "nested");
    await writeMarker(parentProject);
    await writeMarker(nestedProject);

    assert.deepEqual(await findRootFoldersWithFile(searchRoot), [
      resolve(parentProject),
    ]);
  });

  it("deduplicates overlapping search roots and ignores missing paths", async () => {
    const searchRoot = await createTempDir();
    const projectRoot = join(searchRoot, "project");
    await writeMarker(projectRoot);

    assert.deepEqual(
      await findRootFoldersWithFile([
        searchRoot,
        projectRoot,
        join(searchRoot, "missing"),
      ]),
      [resolve(projectRoot)],
    );
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "agse-find-root-test-"));
  tempDirs.push(tempDir);

  return tempDir;
}

async function writeMarker(rootPath: string): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await writeFile(join(rootPath, ROOT_MARKER_FILE_NAME), "export default {};");
}
