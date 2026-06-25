import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGSCProject, AGSCWorkspace } from "../src/agscWorkspace.ts";
import { ROOT_MARKER_FILE_NAME } from "../src/utils/findRootFoldersWithFile.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe("AGSCProject", () => {
  it("loads and normalizes a project config from its root path", async () => {
    const projectRoot = await createProject("configured", [
      "export default {",
      "  require_tag: true,",
      "  overwrite_tags: { codex: 'codex-label', claude: 'claude-label', default: 'default-label' },",
      "  restrict_user_to_local_only: false,",
      "};",
    ]);

    const project = await AGSCProject.fromRootPath(projectRoot);

    assert.equal(project.rootPath, resolve(projectRoot));
    assert.equal(project.name, basename(projectRoot));
    assert.deepEqual(project.config, {
      require_tag: true,
      overwrite_tags: {
        codex: "codex-label",
        claude: "claude-label",
        default: "default-label",
      },
      restrict_user_to_local_only: false,
    });
    assert.throws(() => {
      (project.config as { require_tag?: boolean }).require_tag = false;
    }, TypeError);
  });

  it("loads named config exports", async () => {
    const configRoot = await createProject("named-config", [
      "export const config = { require_tag: false };",
    ]);
    const agscConfigRoot = await createProject("named-agsc-config", [
      "export const agscConfig = { restrict_user_to_local_only: true };",
    ]);

    assert.deepEqual((await AGSCProject.fromRootPath(configRoot)).config, {
      require_tag: false,
      overwrite_tags: undefined,
      restrict_user_to_local_only: undefined,
    });
    assert.deepEqual((await AGSCProject.fromRootPath(agscConfigRoot)).config, {
      require_tag: undefined,
      overwrite_tags: undefined,
      restrict_user_to_local_only: true,
    });
  });

  it("uses an empty config when no recognized config export exists", async () => {
    const projectRoot = await createProject("empty-config", [
      "export const ignored = { require_tag: true };",
    ]);

    assert.deepEqual((await AGSCProject.fromRootPath(projectRoot)).config, {
      require_tag: undefined,
      overwrite_tags: undefined,
      restrict_user_to_local_only: undefined,
    });
  });

  it("rejects invalid config exports", async () => {
    const nonObjectRoot = await createProject("non-object", [
      "export default null;",
    ]);
    const invalidFieldRoot = await createProject("invalid-field", [
      "export default { require_tag: 'yes' };",
    ]);
    const incompleteOverwriteTagsRoot = await createProject(
      "incomplete-overwrite-tags",
      ["export default { overwrite_tags: { codex: 'codex', claude: 'claude' } };"],
    );

    await assert.rejects(
      () => AGSCProject.fromRootPath(nonObjectRoot),
      /export an object/,
    );
    await assert.rejects(
      () => AGSCProject.fromRootPath(invalidFieldRoot),
      /require_tag.+boolean/,
    );
    await assert.rejects(
      () => AGSCProject.fromRootPath(incompleteOverwriteTagsRoot),
      /overwrite_tags\.default.+string/,
    );
  });
});

describe("AGSCWorkspace", () => {
  it("discovers project roots, sorts them, and deduplicates overlapping searches", async () => {
    const searchRoot = await createTempDir("workspace");
    const alphaRoot = join(searchRoot, "alpha");
    const nestedRoot = join(searchRoot, "nested", "beta");
    await writeConfig(alphaRoot, "export default {};");
    await writeConfig(nestedRoot, "export const config = { require_tag: false };");

    const workspace = await AGSCWorkspace.discover([searchRoot, alphaRoot]);

    assert.equal(workspace.size, 2);
    assert.deepEqual(workspace.rootPaths, [
      resolve(alphaRoot),
      resolve(nestedRoot),
    ]);
    assert.equal(workspace.findByRootPath(alphaRoot)?.name, "alpha");
    assert.equal(workspace.findByRootPath(join(searchRoot, "missing")), undefined);
  });
});

async function createProject(
  name: string,
  configLines: readonly string[],
): Promise<string> {
  const projectRoot = await createTempDir(name);
  await writeFile(join(projectRoot, ROOT_MARKER_FILE_NAME), configLines.join("\n"));

  return projectRoot;
}

async function createTempDir(name: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), `agse-${name}-test-`));
  tempDirs.push(tempDir);

  return tempDir;
}

async function writeConfig(rootPath: string, configSource: string): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await writeFile(join(rootPath, ROOT_MARKER_FILE_NAME), configSource);
}
