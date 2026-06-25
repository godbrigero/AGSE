import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDotEnv, saveDotEnvValue } from "../src/envCache.ts";

async function withTempEnvFile(
  fn: (envFilePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agse-env-test-"));

  try {
    await fn(join(dir, ".env"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveDotEnvValue writes a quoted value and loadDotEnv restores it", async () => {
  await withTempEnvFile(async (envFilePath) => {
    const key = "AGSE_TEST_GITHUB_TOKEN";
    const value = "github_pat_test_value_with_#_and_spaces";
    delete process.env[key];

    await saveDotEnvValue(key, value, envFilePath);

    const raw = await readFile(envFilePath, "utf8");
    assert.match(raw, /^AGSE_TEST_GITHUB_TOKEN="github_pat_test_value/m);

    delete process.env[key];
    const loaded = await loadDotEnv(envFilePath);

    assert.equal(loaded[key], value);
    assert.equal(process.env[key], value);
    delete process.env[key];
  });
});

test("saveDotEnvValue replaces an existing key without removing other env lines", async () => {
  await withTempEnvFile(async (envFilePath) => {
    await writeFile(
      envFilePath,
      ['OTHER="keep-me"', 'GITHUB_TOKEN="old"', ""].join("\n"),
      "utf8",
    );

    await saveDotEnvValue("GITHUB_TOKEN", "new-token", envFilePath);

    const raw = await readFile(envFilePath, "utf8");
    assert.match(raw, /OTHER="keep-me"/);
    assert.match(raw, /GITHUB_TOKEN="new-token"/);
    assert.doesNotMatch(raw, /GITHUB_TOKEN="old"/);
  });
});

test("saveDotEnvValue locks the env file down to user read/write permissions", async () => {
  await withTempEnvFile(async (envFilePath) => {
    await saveDotEnvValue("GITHUB_TOKEN", "token", envFilePath);
    const mode = (await stat(envFilePath)).mode & 0o777;

    assert.equal(mode, 0o600);
  });
});
