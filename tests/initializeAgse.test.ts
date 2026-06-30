import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRootPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = join(
  repoRootPath,
  "packages",
  "initialize-agse",
  "bin",
  "initialize-agse.js",
);

async function withTempFolder(
  fn: (folderPath: string) => Promise<void>,
): Promise<void> {
  const folderPath = await mkdtemp(join(tmpdir(), "initialize-agse-test-"));

  try {
    await fn(folderPath);
  } finally {
    await rm(folderPath, { recursive: true, force: true });
  }
}

test("initializer writes agse.config.ts into the current folder by default", async () => {
  await withTempFolder(async (folderPath) => {
    const result = await runInitializer([], folderPath);
    const config = await readFile(join(folderPath, "agse.config.ts"), "utf8");

    assert.match(result.stdout, /Wrote .*agse\.config\.ts/);
    assert.match(config, /export interface AGSCConfigOptions/);
    assert.match(config, /const config: AGSCConfigOptions = {/);
    assert.match(config, /export default config;/);
  });
});

test("initializer writes agse.config.ts into an explicit folder", async () => {
  await withTempFolder(async (folderPath) => {
    const targetFolderPath = join(folderPath, "repo");

    await runInitializer(["repo"], folderPath);

    const config = await readFile(
      join(targetFolderPath, "agse.config.ts"),
      "utf8",
    );
    assert.match(config, /require_tag: true/);
  });
});

test("initializer replaces an existing agse.config.ts", async () => {
  await withTempFolder(async (folderPath) => {
    await writeFile(join(folderPath, "agse.config.ts"), "old config\n", "utf8");

    await runInitializer([], folderPath);

    const config = await readFile(join(folderPath, "agse.config.ts"), "utf8");
    assert.doesNotMatch(config, /old config/);
    assert.match(config, /overwrite_tags: {/);
  });
});

test("initializer fails when the target exists and is not a directory", async () => {
  await withTempFolder(async (folderPath) => {
    await writeFile(join(folderPath, "target"), "not a folder\n", "utf8");

    const result = await runInitializerFailure(["target"], folderPath);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Target exists and is not a directory/);
  });
});

test("initializer rejects extra positional arguments", async () => {
  await withTempFolder(async (folderPath) => {
    await mkdir(join(folderPath, "repo"));

    const result = await runInitializerFailure(["repo", "extra"], folderPath);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Expected zero or one folder argument/);
    assert.match(result.stdout, /Usage: initialize-agse \[folder\]/);
  });
});

test("initializer prints help", async () => {
  await withTempFolder(async (folderPath) => {
    const result = await runInitializer(["--help"], folderPath);

    assert.match(result.stdout, /Usage: initialize-agse \[folder\]/);
    assert.match(result.stdout, /Defaults to the current working directory/);
  });
});

async function runInitializer(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, [binPath, ...args], {
    cwd,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runInitializerFailure(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code?: string | number }> {
  try {
    await runInitializer(args, cwd);
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: error.code,
      };
    }

    throw error;
  }

  assert.fail("Expected initialize-agse to fail.");
}

function isExecFileError(
  error: unknown,
): error is Error & {
  stdout?: string;
  stderr?: string;
  code?: string | number;
} {
  return error instanceof Error && "stdout" in error && "stderr" in error;
}
